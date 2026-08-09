/**
 * Node-only fixture loader, used by tests and the dev "load sample config"
 * button's build-time copy. The browser reads a directory through the File
 * System Access API instead — see `src/source/fs-access.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ConfigFile } from './index-config';

export function loadConfigDir(root: string): ConfigFile[] {
  const out: ConfigFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push({
          path: relative(root, full).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(root);
  return out;
}
