/**
 * Bundles the terminal report into one dependency-free ESM file, so it can be
 * copied to a printer host and run with nothing but node.
 */
import { build } from 'vite';

await build({
  logLevel: 'warn',
  build: {
    ssr: 'src/cli/report.ts',
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'report.mjs' } },
  },
});
