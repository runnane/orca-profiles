/**
 * Bundles the sanitised fixture config into a single JSON the app can load
 * without a directory picker — used for the "Load sample config" path and for
 * browsers without the File System Access API.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('../fixtures/config', import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.json')) {
      files.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  }
};
walk(root);

// Re-minify each preset: the fixtures are pretty-printed for readability in the
// repo, but the bundle only needs to parse.
for (const f of files) {
  try { f.text = JSON.stringify(JSON.parse(f.text)); } catch { /* keep as-is; the app reports it */ }
}

mkdirSync(new URL('../public', import.meta.url).pathname, { recursive: true });
const out = new URL('../public/sample-config.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ rootName: 'sample config', files }));
console.log(`sample-config.json: ${files.length} files, ${(readFileSync(out).length / 1024).toFixed(0)} KiB`);
