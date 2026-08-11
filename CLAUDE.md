# CLAUDE.md

Entry point for Claude Code. The project conventions live in **AGENTS.md**,
imported below so they load every session.

@AGENTS.md

On-demand references — open the relevant one when the work matches:

- `.claude/commands/local/gates.md` — the exact gate command, the two suites
  deliberately outside it, CI, and the traps that make a green run mean less
  than it looks.
- `.claude/commands/shared/pr-hygiene.md` — branch/PR/tracker rules.
- `.claude/commands/shared/gate-failures.md` — what to do when a gate goes red.
- `.claude/commands/shared/agent-isolation.md` — one checkout one agent; commit
  only where you were invoked.

Two things worth loading into your head before touching this code:

1. **The README's load rules are each cited to OrcaSlicer's source.** Preset
   resolution, load order and profile handling were derived by reading
   `Preset.cpp` / `PresetBundle.cpp` at v2.4.2, not by inferring from config
   files — inference produced five false findings. Check the source and cite it.
2. **This repo is public.** No real config, preset name, printer name, address
   or hostname, ever. The test fixture is generated with invented names.
