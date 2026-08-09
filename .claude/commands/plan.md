---
description: Plan an ORCA issue — read it, explore the code, propose an implementation plan, record it on the issue.
---

Plan **$ARGUMENTS**. Do not implement.

1. Read the issue in full (`include: ["comments","links","attachments"]`).
2. Explore the code that would change. `src/domain/` is pure and testable;
   `src/ui/`, `src/server/` and `src/source/` are adapters over it.
3. **Settle any claim about OrcaSlicer's behaviour against its source**
   (`Preset.cpp` / `PresetBundle.cpp`, v2.4.2) rather than by inference, and
   cite the lines. This is where plans go wrong here.
4. Propose the change: files, the shapes the fixture generator needs, the tests
   that would prove it, and what could not be verified without a real config.
5. Record the plan as a comment on the issue.

Call out explicitly if the work touches redaction, exposure, or anything that
would put data in a public repo.
