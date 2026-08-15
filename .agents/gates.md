# The gates in this repo

`.agents/repo.json` names this file as `gatesDoc`, which is how a repo-agnostic
command finds this repo's particulars without carrying them. Its counterpart is
the **`gate-failures` skill** in the userspace bundle: that one names no command
or runner, so it can be shared; this one is nothing but commands and runners, so
it never leaves the repo.

## The command

```bash
pnpm gates      # typecheck + lint + tests + build, in that order
```

which is `tsc -b --force` → `oxlint src` → `pnpm test` → `pnpm build`. It takes
a few seconds; there is no reason to skip it.

`pnpm test` regenerates the fixture first (`pnpm fixture`), so a stale or
missing `fixtures/` cannot make a run pass or fail spuriously.

## Two suites deliberately outside the gates

| Command | What it needs | Why it is not in gates |
| --- | --- | --- |
| `pnpm smoke` | builds and serves the SPA, drives Chromium | Downloads a browser and takes ~10× the rest. Catches "typechecks fine, renders nothing", which the unit tests cannot. |
| `pnpm test:server` | a container already running | Needs `pnpm docker:run` or a deploy first, so it cannot be a precondition of every commit. Override the target with `ORCA_URL`. |

Run the smoke test when you touch anything under `src/ui/`. Run `test:server`
when you touch `src/server/`, `src/source/http.ts`, the Dockerfile or compose.

## CI

`.github/workflows/ci.yml`, `pull_request` only, `ubuntu-latest`. This repo is
**public**, so hosted Actions minutes are free — do not move it to the
self-hosted fleet the private repos have to use. CI runs exactly `pnpm gates`,
so a green local run means a green CI run.

## Traps

- **The fixture is generated, and gitignored.** `fixtures/` comes from
  `scripts/make-fixture.mjs` with invented names. Never point a test at a real
  OrcaSlicer config and never commit one: this repo is public and history is
  permanent. If a test needs a new shape, add it to the generator.
- **A green test run says nothing about redaction over the wire.** The unit
  tests cover `redactPresetJson` / `redactConfJson` directly; what a *deployed*
  container actually serves is checked by `scripts/verify-deploy.mjs`, which
  `pnpm deploy` runs from the deploying machine. A leak once passed every unit
  test because the fixture's credentials were already blank — test redaction
  against data that actually has secrets.
- **`pnpm build` is not just the SPA.** It also runs `pnpm sample` (which
  regenerates the fixture) and `tsc -b` across three tsconfig projects: browser
  (`src/web`-ish), node tools (`src/server`, `src/cli`, tests, e2e) and the
  build configs. A file in `src/` that is in neither project is not typechecked
  at all — check `tsconfig.app.json`'s `exclude` before assuming coverage.
- **oxlint, not eslint or biome.** `pnpm lint` is `oxlint src`. It is fast and
  quiet; a warning is not an error here.
- **Verify a deploy from another machine.** `curl localhost` on the target
  answers whether or not the port is exposed, so it proves nothing. That is why
  `verify-deploy.mjs` runs where you invoked the deploy.
