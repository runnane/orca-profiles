import { test, expect } from '@playwright/test';

/**
 * Measures the cost of reading a config-sized tree through the File System
 * Access API, sequentially vs with a bounded read pool.
 *
 * Uses OPFS, which hands back the same FileSystemDirectoryHandle interface a
 * directory picker does. Absolute numbers will differ from a real on-disk
 * folder; the ratio between the two strategies is the point.
 */
test('sequential vs pooled reads over ~2600 files', async ({ page }) => {
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const FILES = 2607;
    const CONTENT = JSON.stringify({ pad: 'x'.repeat(4800), layer_height: '0.2' });

    const root = await navigator.storage.getDirectory();
    // Rebuild the fixture tree from scratch each run.
    try { await (root as any).removeEntry('bench', { recursive: true }); } catch {}
    const bench = await root.getDirectoryHandle('bench', { create: true });

    // 175 directories, like the real config.
    const dirs: FileSystemDirectoryHandle[] = [];
    for (let d = 0; d < 175; d++) {
      dirs.push(await bench.getDirectoryHandle(`d${d}`, { create: true }));
    }
    const handles: FileSystemFileHandle[] = [];
    for (let i = 0; i < FILES; i++) {
      const dir = dirs[i % dirs.length];
      const fh = await dir.getFileHandle(`f${i}.json`, { create: true });
      const w = await fh.createWritable();
      await w.write(CONTENT);
      await w.close();
      handles.push(fh);
    }

    const sequential = async () => {
      const out: string[] = [];
      for (const h of handles) out.push(await (await h.getFile()).text());
      return out.length;
    };

    const pooled = async (concurrency: number) => {
      const out = new Array<string>(handles.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= handles.length) return;
          out[i] = await (await handles[i].getFile()).text();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      return out.length;
    };

    const time = async (fn: () => Promise<number>) => {
      const t = performance.now();
      const n = await fn();
      return { ms: performance.now() - t, n };
    };

    const seq = await time(sequential);
    const p32 = await time(() => pooled(32));

    try { await (root as any).removeEntry('bench', { recursive: true }); } catch {}
    return { files: FILES, sequentialMs: seq.ms, pooled32Ms: p32.ms };
  });

  console.log('BENCH ' + JSON.stringify(result));
  expect(result.files).toBe(2607);
});
