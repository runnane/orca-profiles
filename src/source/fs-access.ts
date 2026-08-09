/**
 * Reading the config directory in the browser.
 *
 * Uses the File System Access API: the user points at their OrcaSlicer config
 * folder once, and the page reads it directly. Nothing is uploaded — there is
 * no server to upload to — which is what lets the app read machine presets
 * containing printer-host credentials without those ever leaving the machine.
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

/** Directories we never descend into: large, and none of them hold presets. */
const SKIP_DIRS = new Set(['cache', 'log', 'plugins', 'ota', 'resources']);

/** A config folder is far too big to read whole; this bounds a mistaken pick. */
const MAX_FILES = 20_000;

export interface ReadProgress {
  files: number;
  currentPath: string;
}

async function readDirectory(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: ConfigFile[],
  onProgress?: (p: ReadProgress) => void,
): Promise<void> {
  for await (const entry of (dir as unknown as DirectoryHandleLike).values()) {
    if (out.length >= MAX_FILES) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.kind === 'directory') {
      if (SKIP_DIRS.has(entry.name)) continue;
      await readDirectory(entry as FileSystemDirectoryHandle, path, out, onProgress);
      continue;
    }

    if (!entry.name.endsWith('.json')) continue;
    const file = await (entry as FileSystemFileHandle).getFile();
    out.push({ path, text: await file.text() });
    if (out.length % 50 === 0) onProgress?.({ files: out.length, currentPath: path });
  }
}

/**
 * Prompt for a directory and read every preset under it.
 *
 * Accepts either the `OrcaSlicer` folder itself or its parent (the
 * `...AppImage.config` folder), because both are reasonable things to pick and
 * telling them apart is easier than explaining the difference.
 */
export async function pickAndReadConfig(
  onProgress?: (p: ReadProgress) => void,
): Promise<{ rootName: string; files: ConfigFile[] }> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (o?: { mode?: string; id?: string }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;

  const handle = await picker({ mode: 'read', id: 'orcaslicer-config' });

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

  const files: ConfigFile[] = [];
  await readDirectory(root, '', files, onProgress);
  return { rootName, files };
}
