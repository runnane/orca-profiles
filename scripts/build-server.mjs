/**
 * Bundles the HTTP server to one dependency-free ESM file, so the runtime image
 * needs no node_modules at all.
 *
 * Uses Vite's SSR build rather than calling esbuild directly: Vite is already a
 * dependency, and adding a second bundler meant a second thing to keep vetted.
 */
import { build } from 'vite';

await build({
  logLevel: 'warn',
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'index.mjs' } },
  },
});
