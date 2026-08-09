/**
 * Reading the config directory in the browser.
 *
 * Uses the File System Access API: the user points at their OrcaSlicer config
 * folder once, and the page reads it directly. Nothing is uploaded — there is
 * no server to upload to — which is what lets the app read machine presets
 * containing printer-host credentials without those ever leaving the machine.
 *
 * A real config is ~2600 files and 13 MB spread over 175 directories, and every
 * one of them costs an async round-trip through the browser's file system
 * layer. Doing that one at a time is the difference between "a moment" and
 * "long enough to think it has hung", so the walk and the reads both run with
 * bounded concurrency, and progress is reported against a known total rather
 * than as an indeterminate spinner.
 *
 * The API is Chromium-only. Firefox and Safari get a clear message and the
 * bundled sample config rather than a broken picker.
 */

import type { ConfigFile } from '../domain/index-config';

export interface DirectoryHandleLike {
  name: string;
  values(): AsyncIterableIterator<FileSystemHandle>;
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/**
 * Directories with no presets in them. `plugins` alone is ~96 MB, and `cache`
 * and `log` are large and churn, so descending into them is pure cost.
 */
const SKIP_DIRS = new Set(['cache', 'log', 'plugins', 'ota', 'resources']);

/** How many file reads to keep in flight. Past ~32 the API, not us, is the limit. */
const READ_CONCURRENCY = 32;

/** A config folder is far too big to read whole; this bounds a mistaken pick. */
const MAX_FILES = 20_000;

export interface ReadProgress {
  /** Files read so far. */
  files: number;
  /** Total discovered, once the directory walk has finished. */
  total?: number;
  phase: 'scanning' | 'reading';
}

/** Walk the tree collecting file handles, without reading any contents yet. */
async function collectHandles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: { path: string; handle: FileSystemFileHandle }[],
  onProgress?: (p: ReadProgress) => void,
): Promise<void> {
  const subdirs: { handle: FileSystemDirectoryHandle; path: string }[] = [];

  for await (const entry of (dir as unknown as DirectoryHandleLike).values()) {
    if (out.length >= MAX_FILES) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.kind === 'directory') {
      if (!SKIP_DIRS.has(entry.name)) {
        subdirs.push({ handle: entry as FileSystemDirectoryHandle, path });
      }
      continue;
    }
    // `OrcaSlicer.conf` is JSON and says which user profile is live, so it is
    // as load-bearing as any preset.
    if (entry.name.endsWith('.json') || entry.name === 'OrcaSlicer.conf') {
      out.push({ path, handle: entry as FileSystemFileHandle });
      if (out.length % 200 === 0) onProgress?.({ files: out.length, phase: 'scanning' });
    }
  }

  // Sibling directories are independent, so walk them together rather than
  // serially — 175 directories at one round-trip each is itself worth avoiding.
  const BATCH = 8;
  for (let i = 0; i < subdirs.length; i += BATCH) {
    await Promise.all(
      subdirs.slice(i, i + BATCH).map((s) => collectHandles(s.handle, s.path, out, onProgress)),
    );
  }
}

/** Read all handles with a fixed number of reads in flight. */
async function readAll(
  handles: { path: string; handle: FileSystemFileHandle }[],
  onProgress?: (p: ReadProgress) => void,
): Promise<ConfigFile[]> {
  const out: ConfigFile[] = new Array(handles.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= handles.length) return;
      const { path, handle } = handles[i];
      try {
        const file = await handle.getFile();
        out[i] = { path, text: await file.text() };
      } catch {
        // An unreadable file is not a reason to abandon the whole config; it
        // simply does not appear, and the index reports what it could not parse.
        out[i] = { path, text: '' };
      }
      done++;
      if (done % 100 === 0) {
        onProgress?.({ files: done, total: handles.length, phase: 'reading' });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, handles.length) }, worker),
  );
  return out.filter((f) => f && f.text !== '');
}

export interface ReadResult {
  rootName: string;
  files: ConfigFile[];
  /** Wall-clock milliseconds spent scanning and reading, picker time excluded. */
  elapsedMs: number;
}

/**
 * Prompt for a directory and read every preset under it.
 *
 * Accepts either the `OrcaSlicer` folder itself or its parent (the
 * `...AppImage.config` folder), because both are reasonable things to pick and
 * telling them apart is easier than explaining the difference.
 *
 * `onPicked` fires once the user has chosen — everything before that is the
 * browser's dialog, and counting it as "reading" makes the app look slow for
 * however long someone spends browsing folders.
 */
export async function pickAndReadConfig(
  onProgress?: (p: ReadProgress) => void,
  onPicked?: () => void,
): Promise<ReadResult> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;

  const handle = await picker({ mode: 'read', id: 'orcaslicer-config' });
  onPicked?.();
  const started = performance.now();

  // If the user picked the parent, descend into the OrcaSlicer folder.
  let root = handle;
  let rootName = handle.name;
  for await (const entry of (handle as unknown as DirectoryHandleLike).values()) {
    if (entry.kind === 'directory' && entry.name === 'OrcaSlicer') {
      root = entry as FileSystemDirectoryHandle;
      rootName = `${handle.name}/OrcaSlicer`;
      break;
    }
  }

  const handles: { path: string; handle: FileSystemFileHandle }[] = [];
  await collectHandles(root, '', handles, onProgress);
  onProgress?.({ files: 0, total: handles.length, phase: 'reading' });

  const files = await readAll(handles, onProgress);
  return { rootName, files, elapsedMs: performance.now() - started };
}
