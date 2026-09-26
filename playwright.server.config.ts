import { defineConfig } from '@playwright/test';

/**
 * `test:server`'s own config, with no `webServer`. It targets a container
 * that is already running (`pnpm docker:run`, or a remote one via `ORCA_URL` —
 * see `e2e/server.spec.ts`), never the static preview `playwright.config.ts`
 * builds.
 *
 * ORCA-35: `playwright.config.ts`'s `webServer.command` runs `pnpm build`,
 * which runs `pnpm fixture` (`scripts/make-fixture.mjs`), on *every* Playwright
 * run — including this one, before this file existed. Regenerating the fixture
 * while a container has `fixtures/config` bind-mounted (`-v
 * $PWD/fixtures/config:/config:ro`, the only acceptable way to test the image
 * without a real config on a public repo) used to orphan that mount at the old,
 * deleted directory; the fixture generator no longer removes the directory
 * itself, but this suite still has no reason to build or serve anything, so it
 * gets a config that does neither.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'server.spec.ts',
  use: { baseURL: process.env.ORCA_URL ?? 'http://localhost:8099' },
});
