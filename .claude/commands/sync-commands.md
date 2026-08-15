---
description: > **SUPERSEDED — do not run this without reading RCP-887 first.** RCP-878 replaced the
> copy-between-repos model with one userspace bundle plus a per-repo `.agents/repo.json`,
> and ORCA-31 deleted this repo's `.claude/commands/shared/*`, its `local/gates.md` and
> the five hoisted command bodies. **The tier this command measures no longer exists
> here**, so its `sha256sum` check cannot resolve. Retiring this file is **RCP-887**.

Reconcile .claude/commands/ against the sibling repos — verify the byte-identical shared core, decide each divergence.
---

This repo is part of the agent-tooling sync set. **The set is enumerated in one
place only** — `AGENTS.md` in `respawn-control` — so read that for the current
membership rather than assuming this list.

Three tiers, by who owns the bytes:

- **`shared/*.md` — byte-identical in every repo in the set.** Verify with
  `sha256sum` against a sibling. A difference is drift and must be reconciled,
  not merged locally. These files name no command, runner or linter; that is
  what makes byte-identity achievable.
- **`local/gates.md` — this repo's own, never synced.** A difference here is not
  drift.
- **Command bodies stay repo-flavoured**, and merely point at both.

To reconcile:

```bash
for f in gate-failures pr-hygiene agent-isolation; do
  sha256sum ".claude/commands/shared/$f.md" \
            "../respawn-control/.claude/commands/shared/$f.md"
done
```

A lesson that belongs in a sibling is ported by **filing an issue in that repo's
project**, not by editing its checkout — it has its own gates, its own reviewer,
and quite possibly its own agent working in it right now. The one exception is
this command, whose whole purpose is synchronisation; it works each sibling in
its own worktree, never in that repo's primary checkout.
