---
description: Work an explicit list of ORCA issues back-to-back, autonomously — one PR each, split what's too big, log and skip what you can't decide.
argument-hint: "<ORCA-1 ORCA-2 …> [--parallel N]  (order = the order they get worked; N = concurrent worktrees, default 1)"
---

Work **$ARGUMENTS** in the order given, one at a time, without stopping to ask.

For each issue, run the `/fix` flow: read it in full, verify its premise, comment
that you have started, branch from fresh `main`, implement, test in the failing
direction, `pnpm gates`, PR with `--base main` and the key in the branch, comment
what changed.

Between issues, re-sync `main` — an earlier PR in the list may have landed.

**Skip rather than guess.** If an issue needs a decision only the owner can make
(what to expose, what to publish, whether to change a documented OrcaSlicer
behaviour), comment saying precisely what you need and move to the next one.

**Split rather than half-ship.** If an issue turns out too big, break its *whole*
scope into sub-issues and leave the parent as a small epic. A remainder that
exists only as prose in a comment is the failure this rule prevents.

Anything requiring a deploy is not finished at `MERGED` — `tracksProduction` is
on. Say so rather than implying it shipped.

## `--parallel N`

Default is **`--parallel 1`**: everything inline, in order, exactly as above.
`--parallel N` runs up to N issues at once, each in its own `git worktree` with
its own subagent — see [`shared/agent-isolation.md`](shared/agent-isolation.md).
**You stay the orchestrator**: subagents implement, you verify, merge and tear
down. Everything below is what makes that safe here specifically.

### Pick N from the coupling, not the issue count

Two issues that share plumbing must not run concurrently — the second needs the
first **merged**, not sitting on a sibling branch. Group the list into waves of
independent issues and run each wave at N; three coupled issues are three waves
of one even under `--parallel 3`. Announce the waves before starting.

Coupling here is usually a *file* in `src/domain/`. `index-config.ts`,
`analyze.ts` and `compatibility.ts` are each touched by most issues, and two
agents rewriting `notLoadedPresets` or `stats()` in parallel is a guaranteed
conflict at merge time and a silent semantic clash before that — two rules that
each look right alone and compose wrongly. Read the issues for which functions
they name, and put those in different waves.

**N is not capped at 3 here.** RCP caps it because its Playwright suite binds
fixed ports and adopts another worktree's server. `pnpm gates` in this repo is
`typecheck && lint && test && build` — no browser, no server, no port. Two gate
runs in two worktrees do not interfere, so N is bounded by the machine and by
how much verification you are willing to owe personally, not by a shared
resource. `pnpm smoke` and `pnpm test:server` do start something, so run those
one at a time.

### The deploy never goes to a subagent

`pnpm deploy` rsyncs to a container on another machine, builds **there**, and
then runs health and redaction checks from the deploying machine. There is one
target. Two deploys interleaving would leave it in a state neither agent
described.

So: **deploying is serial and orchestrator-only, always** — no subagent runs it,
under any N, and not even when it is obviously the last step of the issue it was
given. Put that in every brief. `tracksProduction` is on, so an agent will
reasonably read "finish the issue" as including the deploy; say otherwise
explicitly. `MERGED` is where a subagent's work ends.

### This repo is public and the input is somebody's real config

More agents means more chances for a real preset name, printer name, LAN address
or credential to reach a commit, a PR body or an issue comment — and git history
is permanent. Restate this in **every** brief, not just the ones that look like
they touch config:

> This repo is public. Never commit, quote, or put in a PR or issue a real
> preset name, printer name, hostname, IP or token. Test data comes from
> `scripts/make-fixture.mjs`, which generates the *shapes* with invented names —
> add a shape there rather than pointing a test at a real config. Use
> `192.0.2.x` (RFC 5737) and `.invalid` in examples.

`OrcaSlicer.conf` carries `access_code`, `user_access_code`, `dev_sn` and a
`local_machines` map keyed by printer IP, which is why `redactConfJson` is an
**allowlist**. A subagent that widens it, or adds a field to it, is making a
"what do we expose" decision that is not theirs — that comes back to you, and
from you to the owner.

### Never send a subagent to a big reference skill

A subagent has one context window and it is already carrying the issue, the
codebase and your brief. A large reference skill eats most of it, and the agent
then does worse work than if it had never opened one.

**`claude-api` is the one to keep away.** It is a user-level skill, present here
as everywhere, and its trigger is deliberately aggressive: it fires on any
mention of Claude/Anthropic/model ids *and* on anything merely **LLM-shaped** —
an agent, an MCP tool definition, a prompt, a summarize/classify/extract
feature — even with no provider named. So a subagent will pull it in on its own
initiative and choke.

The split:

- **You** invoke it, in *your* context, and extract only the fact the issue
  needs.
- **The brief carries the answer, quoted** — not a pointer.
- **Say so explicitly**: add *"do NOT invoke the `claude-api` skill; the facts
  are in this brief, stop and ask if one is missing"*. Without that line the
  subagent's own trigger fires anyway.
- If a subagent reports a fact contradicting the brief, **you** re-check it.

Small, repo-specific references are the opposite case and get pointed at by
name — [`local/gates.md`](local/gates.md),
[`shared/gate-failures.md`](shared/gate-failures.md),
[`shared/pr-hygiene.md`](shared/pr-hygiene.md). They are short and the agent
needs all of one. Size and specificity are the distinction, not "skills are bad
for subagents". The general rule: **the orchestrator spends context on breadth,
the subagent spends it on depth.**

### Verify every claim — the reports are not evidence

In the RCP pass this rule came from, **five of six subagents reported incomplete
work as complete**. Read the gate log yourself and look at the branch, every
time. What was actually seen:

- red gates reported as green (one read `1 failed | 4301 passed` as "4302
  passed");
- **tests that never call the function under test** — asserting on literals the
  test itself wrote, on the source file via a regex, or on a re-implementation
  of the logic inside the test. The tell is one question: *is the function under
  test actually called?*
- a manual checklist of unchecked boxes presented as a testing section;
- a branch replaying commits of already-merged PRs, from a rebase against a
  stale remote ref — invisible in the GitHub diff.

**A described check is not a check.** Before you believe a new test, break what
it protects, watch that *named* test go red, and restore with an **inverse
patch** — never `git checkout <file>`, which also throws away everything else
uncommitted. Paste the real output. See
[`shared/gate-failures.md`](shared/gate-failures.md).

**The ORCA-specific one: cite the source, do not infer.** This repo already
learned this the expensive way — a model of OrcaSlicer's loader built by reading
config files produced **five false "missing parent" findings**, and the fix was
reading `Preset.cpp`. Hold a subagent to the same standard. Any claim about
resolution, load order, visibility or compatibility comes with a
`Preset.cpp` / `PresetBundle.cpp` line reference at v2.4.2, or it is a guess
wearing a citation's clothes. A finding that fires wrongly is worse than one
that does not exist, because someone will go and edit a file over it.

### Worktrees and merging

- After **every** rebase onto a moved `main`: `pnpm install`. A worktree's
  `node_modules` dates from its creation, and a new dependency then fails the
  *build* in a way that reads like a code fault.
- `fixtures/` is gitignored and regenerated by `pnpm test`, so each worktree
  builds its own. Two agents changing `scripts/make-fixture.mjs` in the same
  wave is coupling — see above.
- Merge **one at a time**, rebasing the next branch onto the new `main`
  afterwards. Watch for the semantic conflict git cannot see: two changes to
  `stats()` or `notLoadedPresets` can merge cleanly and still be wrong together.
- A PR that only *partly* completes an issue carries the **child's** key in the
  branch and title and the parent's in the body, or the webhook marks the parent
  shipped. [`shared/pr-hygiene.md`](shared/pr-hygiene.md).
- **You** remove each worktree and delete its branch once its PR merges. Leave
  other sessions' worktrees alone — `gh pr list --head <branch>` before assuming
  one is stale.
