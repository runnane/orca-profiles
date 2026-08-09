# Orca Profiles

A read-only explorer for OrcaSlicer preset configs. It answers the questions the
slicer itself will not: **which of these values did I actually change**, **why is
this file 359 keys long**, and **which of these presets does OrcaSlicer even
load**.

Static Vite SPA. No backend, no upload — it reads your config folder in the
browser via the File System Access API, so printer-host credentials never leave
the machine.

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm gates      # typecheck + lint + tests + build
pnpm smoke      # optional: playwright walk of the built app
```

## Why presets are hard to read

A preset stores **only what it overrides**. Everything else comes from a chain
you cannot see:

```
jon ABS (3 real settings)
  ◂ Generic ABS @System
    ◂ fdm_filament_abs
      ◂ fdm_filament_common      →  49 settings in effect
```

The slicer shows you the 49 resolved numbers with no indication of which are
yours. This app shows the chain, marks every value with the preset that supplied
it, and separates the edits that change something from the ones that do not.

Worked example from a real config — `0.28mm Extra Draft @Elegoo CC2 - Copy`
stores **359 keys**, and the app reduces it to:

| | |
|---|---|
| **5** overrides that actually change something | `wall_loops`, `top_shell_thickness`, … |
| **121** overrides identical to the inherited value | pure noise |
| **226** keys no ancestor defines | slicer built-in defaults, written out |

## The four things that make a config lie to you

All four are enforced by OrcaSlicer's own loader; line references are to
[v2.4.2](https://github.com/SoftFever/OrcaSlicer/tree/v2.4.2/src/libslic3r).

### 1. Only one user folder is ever loaded

`app.preset_folder` in `OrcaSlicer.conf` picks it; empty means `default`
([PresetBundle.cpp:528](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L528)).
Everything under any *other* user folder — an entire cloud profile, in the config
this was built against — is inert. Editing those files changes nothing.

The app reads the conf, marks the rest `profile not loaded`, and keeps them out
of the counts and the analysis.

### 2. `base/` holds detached "custom roots"

When a preset is saved **detached**, OrcaSlicer clears its `inherits`, `vendor`
and `alias` and writes it to `<type>/base/`
([Preset.cpp:2890](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L2890),
[path_from_name](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L3869)).

That folder is then loaded **first** — `// Load custom roots first`
([Preset.cpp:1583](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L1583))
— into the *same* collection, so ordinary user presets can inherit from them by
name. It is not a separate namespace; it is a load-order guarantee for presets
that other presets depend on.

### 3. On a name clash, the loser is never loaded

Not merged, not renamed — skipped, with `"Preset already present, not loading"`
([Preset.cpp:1619](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L1619)).
Load order is system bundles → `base/` → the rest of the folder.

The sample config has two files both declaring the name `ABS fast`. One of them
has no effect on anything, and nothing in the UI tells you which.

### 4. The same value is written two different ways

A preset saved by the slicer stores vector options as JSON arrays; one
round-tripped through an export stores the serialised form:

```
compatible_printers   ["Ender5","M1.1"]   vs   '"Ender5";"M1.1"'
wiping_volumes_...    ["70","70"]         vs   '70,70'
post_process          []                  vs   ''
```

Compared naively, two identical presets look a dozen keys apart. The app
normalises for comparison but reports those rows as **formatting-only** rather
than folding them into "same" — and deliberately never coerces a scalar into a
vector unless the other side is one, because hiding a real difference is the
worse failure.

## What it flags

`detached` · `duplicate-name` (files never loaded) · `redundant-overrides` ·
`near-duplicate` · `broken-parent` · `circular-inherits` · `orphaned-printer` ·
`parse-error`

## Credentials

Machine presets carry `printhost_apikey`, `printhost_password`, `print_host` and
a device serial as ordinary keys in the same flat JSON as layer height. They are
masked by **key name** wherever a value would be shown, so a credential this app
has never seen is still covered. Whether one is *set* is reported; the value
never is. See [`src/domain/redact.ts`](src/domain/redact.ts).

## Layout

| Path | What |
|---|---|
| `src/domain/` | Pure logic: index, resolve, diff, analyze, normalize, redact |
| `src/source/` | File System Access reader |
| `src/ui/` | React views |
| `fixtures/config/` | A **sanitised** real config — credentials stripped, account UUID removed |
| `e2e/` | Playwright smoke test |

Tests run against `fixtures/config`, not synthetic data: the behaviour worth
pinning down is exactly the mess a real config accumulates.
