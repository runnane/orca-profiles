import { defineConfig } from '@playwright/test';

/**
 * A smoke test, not a test suite: it loads the bundled sample config, walks the
 * three tabs and fails on any console error. Deliberately kept out of `pnpm
 * gates` — the domain logic is covered by vitest, and this exists to catch the
 * class of break that typechecks fine and renders nothing.
 */
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --port 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
