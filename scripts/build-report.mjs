/**
 * Bundles the terminal report into one dependency-free ESM file, so it can be
 * copied to a printer host and run with nothing but node.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/report.ts'],
  outfile: 'dist-cli/report.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  logLevel: 'warning',
});
