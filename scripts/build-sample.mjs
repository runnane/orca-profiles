/**
 * Bundles the sanitised fixture config into a single JSON the app can load
 * without a directory picker — used for the "Load sample config" path and for
 * browsers without the File System Access API.
 *
 * `OrcaSlicer.conf` is included, because a config without it is not one: it says
 * which user profile is live and which presets are *installed*, and without the
 * second the sample would demonstrate a filament list wider than any slicer
 * shows. It goes through the same `redactConfJson` allowlist the container serves
 * through — imported rather than reimplemented, so the sample cannot drift into
 * being the one path that forwards a conf whole.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { redactConfJson } from '../src/domain/redact.ts';

const CONF = 'OrcaSlicer.conf';
const root = new URL('../fixtures/config', import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.json') || e.name === CONF) {
      files.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  }
};
walk(root);

for (const f of files) {
  if (f.path === CONF) f.text = redactConfJson(f.text);
}

// Re-minify each preset: the fixtures are pretty-printed for readability in the
// repo, but the bundle only needs to parse.
for (const f of files) {
  try { f.text = JSON.stringify(JSON.parse(f.text)); } catch { /* keep as-is; the app reports it */ }
}

mkdirSync(new URL('../public', import.meta.url).pathname, { recursive: true });
const out = new URL('../public/sample-config.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ rootName: 'sample config', files }));
console.log(`sample-config.json: ${files.length} files, ${(readFileSync(out).length / 1024).toFixed(0)} KiB`);
