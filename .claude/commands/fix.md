---
description: Implement a fix/feature for an ORCA issue end-to-end, verify, open a PR, and update the issue.
---

Work issue **$ARGUMENTS** to completion.

1. **Read all of it.** `issues_get_issue` with
   `include: ["comments","links","attachments"]` — the slim call returns counts,
   not content, and decisions live in comments. Fetch and view every attachment.
   An issue still `blockedBy` an open one is not ready.
2. **Treat its premise as a claim.** "This needs X", "the API can't do Y" is
   what someone believed when filing. Spend the two minutes that settle it, and
   record the outcome on the issue either way. For anything about how OrcaSlicer
   behaves, the answer is in `Preset.cpp` / `PresetBundle.cpp` — read it and
   cite the line rather than inferring from config files.
3. **Comment that you have started**, with the approach.
4. **Branch from fresh `main`** — see
   [`shared/agent-isolation.md`](shared/agent-isolation.md) first: if `HEAD` is
   already a topic branch, stop and report it.
   `<type>/<orca-lower>-<kebab-title>`.
5. **Implement.** Domain logic goes in `src/domain/` and stays pure — no I/O, no
   React. If it needs a config shape the tests do not have, add it to
   `scripts/make-fixture.mjs` with invented names; never point a test at a real
   config.
6. **Test in the failing direction.** Make the new assertion refuse before you
   make it pass. Anything about redaction must be tested with input that
   actually contains a secret.
7. **`pnpm gates`.** Plus `pnpm smoke` for `src/ui/` changes, `pnpm test:server`
   for server/Dockerfile/compose changes. See
   [`local/gates.md`](local/gates.md); if one goes red,
   [`shared/gate-failures.md`](shared/gate-failures.md).
8. **PR** — `gh pr create --base main`, issue key in the branch or title (not
   only the body, or nothing transitions). See
   [`shared/pr-hygiene.md`](shared/pr-hygiene.md).
9. **Comment what changed** — files, surfaces, behaviour — and let the webhook
   move the status.

If it turns out too big, **split it** into sub-issues covering the whole scope
rather than shipping half. If it needs a deploy to be real, remember
`tracksProduction` is on: `MERGED` is not `IN_PRODUCTION` until `pnpm deploy`
has run and verified.
