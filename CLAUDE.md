# CLAUDE.md

Entry point for Claude Code. The project conventions live in **AGENTS.md**,
imported below so they load every session.

@AGENTS.md

On-demand references — open the relevant one when the work matches:

- `.agents/gates.md` — the exact gate command, the two suites
  deliberately outside it, CI, and the traps that make a green run mean less
  than it looks.
- The `pr-hygiene`, `gate-failures` and `agent-isolation` **skills** come from
  the userspace bundle and load on their own; the copies that used to sit in
  `.claude/commands/shared/` were deleted by ORCA-31. One checkout one agent; commit
  only where you were invoked.

Two things worth loading into your head before touching this code:

1. **The README's load rules are each cited to OrcaSlicer's source.** Preset
   resolution, load order and profile handling were derived by reading
   `Preset.cpp` / `PresetBundle.cpp` at v2.4.2, not by inferring from config
   files — inference produced five false findings. Check the source and cite it.
2. **This repo is public.** No real config, preset name, printer name, address
   or hostname, ever. The test fixture is generated with invented names.
