---
description: Work an explicit list of ORCA issues back-to-back, autonomously — one PR each, split what's too big, log and skip what you can't decide.
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
