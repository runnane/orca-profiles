# Orca Profiles

A read-only explorer for OrcaSlicer preset configs. It answers the questions the
slicer itself will not: **which of these values did I actually change**, **why is
this file 359 keys long**, and **which of these presets does OrcaSlicer even
load**.

Runs two ways:

- **Container (recommended).** Mount the config read-only; the server reads it
  and the SPA loads with no folder picker, in any browser, from any machine.
- **Static SPA.** Reads the folder in the browser via the File System Access
  API. Chromium-only, and needs a desktop session on the machine holding the
  config — which is why the container exists.

```bash
docker compose up --build              # http://localhost:8099
ORCA_CONFIG=~/.config/OrcaSlicer docker compose up --build

pnpm install
pnpm dev        # http://localhost:5173, static mode
pnpm gates      # typecheck + lint + tests + build
pnpm report DIR # the same analysis in a terminal
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

## Testing it

Three levels, cheapest first.

**1. Automated — no browser needed.**

```bash
pnpm test     # 42 unit tests against fixtures/config
pnpm gates    # typecheck + lint + tests + build
pnpm smoke    # playwright: builds, serves, walks every tab, fails on console errors
```

**2. Against a real config, in a terminal.** The interesting config usually lives
on the printer host, which has no desktop:

```bash
pnpm report /path/to/OrcaSlicer          # locally
# or copy the single bundled file to the machine that has the config:
node scripts/build-report.mjs && scp dist-cli/report.mjs host:/tmp/
ssh host 'node /tmp/report.mjs "~/.config/OrcaSlicer"'
```

It prints no setting values — credentials are reported as a count of presets
that have one set, never as a value — so the output is safe to paste.

**3. In a browser, against a real config.** Run the container on the machine
that holds the config:

```bash
docker compose up --build      # or: pnpm docker:build && pnpm docker:run
pnpm test:server               # playwright check that it auto-loads
ORCA_URL=http://localhost:8100 pnpm test:server   # ...through a tunnel
```

Then open `http://localhost:8099` — from that machine, or through
`ssh -L 8099:localhost:8099 host` from anywhere. Any browser works; there is no
picker and no Chromium requirement.

The static mode still exists (`pnpm dev`) but the File System Access API needs a
**secure context**, so `http://<lan-ip>:5173` will silently offer no picker, and
only Chromium browsers have one at all.

## What it flags

`detached` · `duplicate-name` (files never loaded) · `redundant-overrides` ·
`near-duplicate` · `broken-parent` · `circular-inherits` · `orphaned-printer` ·
`parse-error`

## Credentials

Machine presets carry `printhost_apikey`, `printhost_password`, `print_host` and
a device serial as ordinary keys in the same flat JSON as layer height. They are
masked by **key name** wherever a value would be shown, so a credential this app
has never seen is still covered. Whether one is *set* is reported; the value
never is.

**In container mode this is load-bearing rather than cosmetic**, because the
config genuinely crosses a network boundary. The server strips credentials
before serialising, so they never reach the browser at all — see
[`src/domain/redact.ts`](src/domain/redact.ts).

`OrcaSlicer.conf` gets an **allowlist**, not a key denylist, and the reason is
worth keeping: the real file holds `access_code`, `user_access_code`, `dev_sn`,
and a `local_machines` map **keyed by printer IP address** with device hostnames
inside. A key that is itself the secret cannot be scrubbed by blanking values.
The app needs exactly one field from that file — which user profile is live — so
that is the only field served. This was found by diffing a real config against
what the API returned; a fixture with blank credentials had reported it clean.

## Exposure

The container mounts the config `:ro` and publishes on **loopback by default**.
`ORCA_BIND` widens that:

```bash
ORCA_BIND=127.0.0.1    docker compose up -d   # default: this machine only
ORCA_BIND=172.20.100.3 docker compose up -d   # a specific LAN address
ORCA_BIND=100.64.64.3  docker compose up -d   # a tailnet address
ORCA_BIND=0.0.0.0      docker compose up -d   # every interface, bridges included
```

Prefer naming the interface over `0.0.0.0`: on a docker host the latter also
publishes onto every bridge network, which is a wider surface than intended.

**There is no authentication.** Credentials are stripped server-side, so a
listener cannot lift a printer API key, password, pairing code or LAN address
from it — but anyone who can reach the port can read your printer, filament and
process presets, and the printer model names in them. That is a reasonable
trade on a home LAN and a bad one on anything shared or routable. If it ever
needs to leave a trusted network, put it behind a reverse proxy that
authenticates, rather than exposing this port.

Verify exposure **from a different machine** — a request made on the host itself
proves nothing, since loopback answers either way.

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
