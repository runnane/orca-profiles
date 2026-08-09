---
description: Research a question or ORCA issue, then record findings back on the issue.
---

Research **$ARGUMENTS** and write the answer down where it will be found.

- Questions about **how OrcaSlicer behaves** are answered by its source, not by
  reading config files: fetch `Preset.cpp` / `PresetBundle.cpp` at the tag
  matching the config's version and quote the lines. Inference from files alone
  has produced confidently wrong answers here.
- Questions about **a real config** can be answered with `pnpm report <dir>`,
  which prints no setting values and is safe to paste.
- Record the outcome on the issue **either way** — a premise confirmed is worth
  as much as one refuted.
- Anything durable belongs in `AGENTS.md`, the README's rules section, or
  `local/gates.md`, in the same change.

Never paste a real preset name, address or credential into an issue: the tracker
is shared and this repo is public.
