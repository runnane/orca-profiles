---
description: Work the ORCA issue queue in parallel — subagents per issue, each on its own branch and PR, verified between batches.
---

Discover the queue and work it.

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

Do not run two gate runs at once against the same checkout, and never let a
subagent deploy: `pnpm deploy` touches a live container on another machine and
is the owner's call.
