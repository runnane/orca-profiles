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

One chain at a time answers "what is in this preset". The **Graph** tab draws the
whole forest instead, because the rest of the questions are shape questions: which
vendor base is carrying everything, which of your presets are floating free, where
a chain is unexpectedly deep — and which subtrees are dead because a file lost a
name clash or sits under a profile the slicer does not load. Edges point at the
parent OrcaSlicer *would load*, so where two files claim one name the graph shows
the one that wins; a loop is drawn and marked rather than followed. It defaults to
your presets and their ancestors, because a real config is a user folder plus a few
thousand vendor presets and a diagram nobody can read is the same failure as the
359-key file.

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

The sample config has two files both declaring one name. One of them has no
effect on anything, and nothing in the slicer tells you which.

**Two vendors claiming one name is a different mechanism with the same result.**
Each vendor loads into its own bundle — in parallel, and independently, because
there is no cross-vendor inheritance
([PresetBundle.cpp:2245](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L2245)) —
and the bundles are then merged into one collection per preset type. The merge
keeps what is already there and **discards** the incoming preset of the same name,
logging `"Found duplicated preset"`
([PresetBundle.cpp:2292](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L2292)).
`OrcaFilamentLibrary` is merged first and so always wins; between two ordinary
vendors the order comes from reading `system/*.json` off disk, so the app says the
choice is arbitrary rather than naming a winner.

A vendor **base** — `instantiation: "false"`, like `fdm_filament_common` — is
exempt, and this is the part that looks wrong and is not: a base never enters a
collection at all
([PresetBundle.cpp:4929](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L4929)),
so two vendors shipping one is not a clash and is not reported as one.

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

## Which filaments a printer gets, and why

Selecting a printer silently rewrites the filament and process lists, and the
slicer never says on what grounds. There are **two** gates, they are independent,
and the dropdown requires both
([Preset.cpp:3166](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L3166)):

| Gate | Asks | Set by |
|---|---|---|
| `is_visible` | have you **installed** it? | `OrcaSlicer.conf`, never the preset file |
| `is_compatible` | may it be used with **this printer**? | `compatible_printers` and its condition |

### Gate 1: installed

Conflate the two and you get this app's own worst bug: 320 filaments offered
where the slicer offered 18. Every vendor's PLA is *compatible* with a printer
that names no printers back, and almost none of it is installed.

[`Preset::set_visible_from_appconfig`](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L853):

- **Only vendor presets are gated.** `if (vendor == nullptr) return;` — and
  `vendor` is set for exactly those loaded from a vendor bundle
  ([PresetBundle.cpp:5057](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L5057)),
  so **your own presets are always offered**. The filament library is a bundle
  like any other, so `Generic PLA` *is* gated — it is in a real dropdown because
  it is installed, not because it is generic.
- **Filaments** are matched by name against the conf's `filaments`, `renamed_from`
  included — and that list is partly derived: a preset named `X @Y` with no
  `alias` of its own gets a `renamed_from` of the name with the `@` deleted
  ([PresetBundle.cpp:5086](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L5086)).
- **Printers** are matched on `(vendor id, printer_model, printer_variant)`
  against the conf's `models`
  ([AppConfig.cpp:1272](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/AppConfig.cpp#L1272)),
  and not at all when either field is empty. So a printer preset can be absent
  from the slicer's own printer list, which is why this app groups those
  separately rather than listing them as ordinary choices.
- **Processes are not gated at all.** The function handles printers, filaments and
  SLA materials; a process is none of them.
- **A printer is never left with nothing.** If no installed filament is compatible
  with an installed printer, the slicer marks that printer model's
  `default_materials` installed on your behalf and writes them back
  ([PresetBundle.cpp:2541](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L2541)).

The conf's shapes are not what the `AppConfig` API suggests: `filaments` is a JSON
**array of names** on disk, expanded to a `name -> "true"` map on load
([AppConfig.cpp:747](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/AppConfig.cpp#L747))
and collapsed back on save, and `models` is an array of
`{vendor, model, nozzle_diameter}` with the diameters `;`-separated.

**No readable conf means no gate.** Absent is not empty: without that file we know
nothing about what is installed, and hiding presets on the strength of our own
ignorance would be inventing an answer. The app says so instead, and the lists
stay wide.

### Gate 2: compatible

**Every key below is read off the resolved inheritance chain, not off the file.**
This is the one worth internalising, because it makes the file misleading rather
than merely incomplete. The loader starts from the parent's config and lays the
file's own keys over it —

```cpp
preset.config = inherit_preset->config;
preset.config.update_diff_values_to_child_config(config, …);
```

([Preset.cpp:1679](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L1679))
— and every compatibility read goes through `preset.config`
([Preset.cpp:825](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L825),
[:800](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L800),
[:778](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L778)),
including the conditions, which are config accessors
([Preset.hpp:347](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.hpp#L347)).

"Save as" from a vendor filament writes your overrides and nothing else, so the
new file mentions no printers while the preset stays pinned to the ones the vendor
tuned it for. Read the file and every such preset looks compatible with
everything — which is how this app came to offer 47 filaments where the slicer
offered 18, *after* the installed gate had already removed a thousand. So a
verdict here also names the preset that states the deciding key, when it is not
the one you are looking at.

One consequence that inverts if you get it backwards: **a stated-but-empty value
overrides an inherited one.** `compatible_printers: []` in a child really does
mean compatible with everything, because the child's key is applied and an empty
vector is a value. Present counts as stated; non-empty is a different test.

The rule itself is
[`Preset::is_compatible_with_printer`](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L809),
checked in this order:

| | Mechanism |
|---|---|
| **excluded by the library** | a filament from the `OrcaFilamentLibrary` vendor whose `m_excluded_from` names this printer **or its parent** — checked first, and on its own ([Preset.cpp:816](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L816)) |
| **decided by a condition** | `compatible_printers` **empty** and `compatible_printers_condition` non-empty: the condition is the whole answer ([Preset.cpp:826](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L826)) |
| **compatible with everything** | `compatible_printers` empty and no condition |
| **named explicitly** | this printer's name is in `compatible_printers` |
| **named via its parent** | the list names the preset this printer `inherits` — and only for a printer that is **not** a system preset ([Preset.cpp:798](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L798), reached from [:841](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L841)) |
| **excluded** | the list is non-empty and names neither |

Three of those are counter-intuitive enough to be worth stating plainly.

**A filament naming a vendor printer is offered on your own printer too.** That is
the `named via its parent` row, and the source says why: "If one filament or
process preset is compatible with one system printer preset, then we think this
filament or process preset should be compatible with all user printer preset which
is inherited from this system printer preset." Model this as name-matching alone
and you report a working setup as broken.

**An empty list plus a condition is not "compatible with everything".** The two
are separate cases, so an empty `compatible_printers` is not evidence of anything
on its own — and it is not an orphaned preset either.

**A condition that fails to evaluate means compatible.** Both compatibility
functions catch the error and return true, with a `//FIXME` acknowledging it
([Preset.cpp:832](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L832)).
A malformed condition does not hide a preset.

Processes gate filaments as a **second** relation, not the same one: a filament's
`compatible_prints` is checked against the selected *process*, and the two verdicts
are ANDed
([Preset.cpp:3364](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/Preset.cpp#L3364)).
It has no parent clause, and it applies to **filaments only** — processes are
updated with no active print at all
([PresetBundle.cpp:5421](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L5421)
against
[:5439](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L5439)),
so a `compatible_prints` on a process is dead weight.

**Conditions are evaluated only as far as a documented subset goes, and are
`undetermined` outside it — never a boolean.** `compatible_printers_condition` is a
PlaceholderParser expression over the printer's *resolved* config, not a name list,
and this app does not ship a PlaceholderParser. What it does implement:
`and` / `or` / `not`, `==` `!=` `<>`, `<` `<=` `>` `>=`, `=~` / `!~` with a
`/pattern/`, parentheses, numbers, quoted strings, and identifiers with a literal
index (`nozzle_diameter[0]`). Arithmetic, the ternary and every function
(`one_of`, `interpolate_table`, …) are out, and land on **undetermined** with the
expression shown verbatim — "this depends on a condition we do not evaluate:
`interpolate_table(…)`" is a real answer; a guess would not be.

Three details in there are the difference between an answer and a wrong answer, so
they are worth stating:

- **`=~` is a whole-string match** (`regex_match`,
  [PlaceholderParser.cpp:687](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PlaceholderParser.cpp#L687)) —
  which is precisely why every real condition is written `/.*PATTERN.*/`.
- The regex library is **boost::regex** in its `perl` grammar, not `std::regex`
  ([PlaceholderParser.cpp:59-66](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PlaceholderParser.cpp#L59)),
  so `.` matches a newline — and `printer_notes` is routinely multi-line.
- **`and` binds tighter than `or`**, and equality binds *looser* than comparison
  ([PlaceholderParser.cpp:2223-2255](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PlaceholderParser.cpp#L2223)).

Nothing short-circuits, deliberately. `false and <unsupported>` is not `false`,
because an unsupported sub-expression is either valid-but-unmodelled (the slicer
computes `false`) or invalid (the slicer throws, and a throw means *compatible*) —
opposite answers, with nothing in the config to tell them apart.

Being the printer's `default_filament_profile` / `default_print_profile` is **not**
part of this rule: it decides what gets *selected* when you pick the printer
([PresetBundle.cpp:2142](https://github.com/SoftFever/OrcaSlicer/blob/v2.4.2/src/libslic3r/PresetBundle.cpp#L2142)),
which is a different question, so it is reported alongside a verdict rather than as
one.

## Testing it

Three levels, cheapest first.

**1. Automated — no browser needed.**

```bash
pnpm test     # generates the fixture, then runs the unit suite
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
This was found by diffing a real config against what the API returned; a fixture
with blank credentials had reported it clean.

Three fields are served: `app.preset_folder` (which profile is live), `filaments`
and `models` (the installed gate above — preset and model names the `system/`
files already carry). Each is **rebuilt field by field rather than forwarded**, so
a key sitting next to one of them inside its own object cannot ride along, and
`verify-deploy` asserts that per entry rather than only at the top level. A
section that could not be read is **omitted, never emitted empty** — an empty
`filaments` is the claim "nothing is installed", and manufacturing that claim out
of a parse failure would empty every list in the app.

## Deploying

The config lives on the printer host, so that is where this runs. One command
syncs the source over the LAN, builds there, and verifies the result **from the
machine you ran it on** — a health check made on the target itself proves
nothing about whether it is actually reachable.

```bash
cp deploy.env.example deploy.env    # once: host, config path, bind address
pnpm deploy                         # gates → rsync → build → health → verify
pnpm deploy --skip-gates            # when you just ran them
```

```
1/5  Gates                    2/5  Sync → workshop:/home/jon/apps/orca-profiles
3/5  Build and start          4/5  Wait for health        up after 2s
5/5  Verify from bug
  ✓ health 200 · config dir /config
  ✓ SPA 200 · config 200 · 2608 files
  ✓ no value survives under any credential-bearing key
  ✓ OrcaSlicer.conf reduced to { app, filaments, models }
  ✓ installed filaments served as 12 name(s), nothing else
  ✓ installed models served as 2 entry(ies), three fields each
  ✓ no private IP addresses · no device hostnames in the payload
```

Nothing leaves the LAN: no registry, no remote git, no image transfer. A deploy
is an incremental rsync plus a docker layer-cached build, so it takes seconds.
`--delete` keeps the remote a mirror, so a file deleted here cannot linger there
and get built into the next image.

The verification is structural, not a search for known secrets, so it needs no
access to the real config: it asserts that nothing survives under a
credential-bearing key, that `OrcaSlicer.conf` came back reduced to its
allowlisted fields *and that each was rebuilt rather than forwarded*, and that no
address-shaped string appears anywhere in the payload. It is checked in the failing direction — pointed at a deliberately
leaky server it reports every one of those. A failed deploy leaves the previous
container running.

`deploy.env` is gitignored: it holds your host and LAN address.

## Exposure

The container mounts the config `:ro` and publishes on **loopback by default**.
`ORCA_BIND` widens that:

```bash
ORCA_BIND=127.0.0.1  docker compose up -d   # default: that machine only
ORCA_BIND=192.0.2.10 docker compose up -d   # one specific interface
ORCA_BIND=100.64.0.2 docker compose up -d   # a tailnet address
ORCA_BIND=0.0.0.0    docker compose up -d   # every interface
```

`0.0.0.0` on a docker host means *every* interface — LAN, tailnet, and each
container bridge network. That is the widest setting; name a single interface
instead if you only meant one of them.

`pnpm deploy` verifies over a real address either way: `0.0.0.0` and `127.0.0.1`
are not reachable URLs from another machine, so the script asks the target for
the address on its default route and checks that.

**There is no authentication.** Credentials are stripped server-side, so a
listener cannot lift a printer API key, password, pairing code or LAN address
from it — but anyone who can reach the port can read your printer, filament and
process presets, and the printer model names in them. That is a reasonable
trade on a home LAN and a bad one on anything shared or routable. If it ever
needs to leave a trusted network, put it behind a reverse proxy that
authenticates, rather than exposing this port.

Verify exposure **from a different machine** — a request made on the host itself
proves nothing, since loopback answers either way.

## Linking to a view

The tab, the sidebar's search and filters, and the health kind filter are in the
query string, so a view survives a reload — which in container mode is the normal
way to pick up a changed config — and can be sent to someone with the same
config:

```
?tab=health&health=duplicate-name
?q=draft&origins=user%2Csystem&inactive=1
```

Only what differs from the default is written, so a fresh app has a bare URL and
a link says exactly what it means. An unknown value falls back to the default
rather than rendering nothing. Clicking chips replaces the history entry;
changing tab adds one, so Back undoes the navigation and not each chip on the way.

**Which preset is open is deliberately not in there.** A preset id is its path, so
that key would put a real preset or printer name into a string designed to be
pasted elsewhere — see ORCA-16, where that trade is being decided rather than
defaulted.

## Layout

| Path | What |
|---|---|
| `src/domain/` | Pure logic: index, resolve, diff, analyze, graph, compatibility, normalize, redact |
| `src/source/` | File System Access reader |
| `src/ui/` | React views |
| `scripts/make-fixture.mjs` | Generates `fixtures/` — synthetic, gitignored, never a real config |
| `e2e/` | Playwright smoke test |

Tests run against a **generated** config. The shapes are the ones real installs
accumulate — detached copies, redundant overrides, two files claiming one name,
an inactive profile, sync snapshots, credentials that are actually set — but
every name in it is invented. `fixtures/` is gitignored and rebuilt by
`pnpm test`, so a real config cannot end up committed to a public repo.
