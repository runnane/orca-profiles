---
description: Work the ORCA issue queue in parallel — subagents per issue, each on its own branch and PR, verified between batches.
---

Discover the queue and work it. Given an explicit, ordered list instead of a
queue to discover, use [`/auto`](auto.md) — which also documents the parallel
rules below in more detail, under `--parallel N`.

1. `issues_list_issues { project: "orca-profiles", status: [...] }` — unassigned
   and claude-assigned issues are in scope. Order by priority, then age.
2. Fan out **two at a time**, each subagent in its **own git worktree** — see
   [`shared/agent-isolation.md`](shared/agent-isolation.md). This checkout is
   shared; never let two agents work the same tree, and remove a worktree once
   its PR is open.
3. Each subagent runs the `/fix` flow end to end and opens its own PR.
4. **Verify their claims between batches.** "tests pass" in a report is not
   evidence — run `pnpm gates` yourself on the branch. A subagent that says a
   suite ran "via the API" or "structurally" did not run it.
5. Re-sync `main` between batches.

## What goes in every brief

- **The issue, read in full.** `issues_get_issue` with
  `include: ["comments","links","attachments"]` — without it, comments and links
  come back as *counts*, and decisions live in comments.
- **Cite the source, do not infer.** Any claim about how OrcaSlicer resolves,
  loads, hides or matches a preset comes with a `Preset.cpp` / `PresetBundle.cpp`
  line reference at v2.4.2. A model of the loader built from reading config files
  produced five false "missing parent" findings once already; a finding that
  fires wrongly is worse than one that does not exist.
- **This repo is public.** Never commit, quote, or put in a PR or issue a real
  preset name, printer name, hostname, IP or token — git history is permanent.
  Test data comes from `scripts/make-fixture.mjs`, which generates the *shapes*
  with invented names; add a shape there rather than pointing a test at a real
  config. `192.0.2.x` (RFC 5737) and `.invalid` in examples. Widening
  `redactConfJson`'s allowlist is a "what do we expose" decision and comes back
  to you, not to the subagent.
- **Never deploy.** `pnpm deploy` touches a live container on another machine,
  there is one target, and two runs would interleave. It is serial and
  orchestrator-only, whatever the issue says — say so even when the issue has
  nothing to do with deployment, because `tracksProduction` is on and an agent
  will reasonably read "finish it" as including the deploy. A subagent's work
  ends at a green `pnpm gates` and a pushed branch.
- **Test in the failing direction, and prove it.** Break what the new test
  protects, watch that *named* test go red, restore with an **inverse patch**
  (never `git checkout <file>`), and paste the real output. A described check is
  not a check.

**Point at small references by name; never send one to a big reference skill.**
[`local/gates.md`](local/gates.md),
[`shared/gate-failures.md`](shared/gate-failures.md) and
[`shared/pr-hygiene.md`](shared/pr-hygiene.md) are short, repo-specific, and the
agent needs all of one. **`claude-api` is the opposite** — a large user-level
skill whose trigger fires on anything merely LLM-shaped (an agent, an MCP tool
definition, a prompt, a summarize/classify feature) even with no provider named,
so a subagent opens it unprompted and spends most of its window on reference
material. **You** run it, in your context, and put the extracted fact in the
brief *quoted*, plus the line *"do NOT invoke the `claude-api` skill; the facts
are in this brief, stop and ask if one is missing"* — without it the subagent's
own trigger fires anyway. The orchestrator spends context on breadth; the
subagent spends it on depth.

## Coupling, and what to check before merging

Do not put two issues in the same batch when they name the same file in
`src/domain/`. `index-config.ts`, `analyze.ts` and `compatibility.ts` are
touched by most issues, and two agents rewriting `notLoadedPresets` or `stats()`
concurrently conflict at merge and, worse, can merge *cleanly* into two rules
that each look right alone and compose wrongly. Check the arithmetic after
merging, not just the diff.

Do not run two gate runs at once against the same checkout. `pnpm gates` starts
nothing shared, so separate worktrees are fine — but `pnpm smoke` and
`pnpm test:server` do, and those stay one at a time.
