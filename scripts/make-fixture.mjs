/**
 * Generates the test config.
 *
 * The tests need a config that is *messy in the specific ways real ones are* —
 * detached copies, redundant overrides, two files claiming one name, an inactive
 * profile, sync snapshots, credentials that are actually set. That used to be a
 * sanitised copy of a real installation, which is fine locally and wrong in a
 * public repo: preset names, printer models and someone's workshop layout are
 * their business, and git history is forever.
 *
 * So it is synthesised instead. Every name here is invented. The *shapes* are
 * taken from a real config; none of the content is.
 *
 * `fixtures/` is gitignored and this runs before the tests, so real data cannot
 * be committed there by accident.
 *
 * Deterministic: same output every run, so a test can assert exact counts.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = new URL('../fixtures/config', import.meta.url).pathname;

const write = (rel, obj) => {
  const full = join(ROOT, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(obj, null, 4));
};

/**
 * A user preset, with the `version` every real one carries.
 *
 * OrcaSlicer writes a `version` into every user preset it saves, and a user preset
 * *without* a parseable one is never loaded: `Semver::parse` fails on the empty
 * string a missing key produces, and `load_presets` skips the file with no error and
 * no log line (Preset.cpp:1653-1655). A fixture whose user presets had no `version`
 * was therefore modelling a config in which almost nothing loads — so it is the
 * default here, and a shape that deliberately lacks one passes `version: null` to
 * say so out loud.
 */
const USER_VERSION = '2.4.0.3';
const writeUser = (rel, { version, ...rest }) => {
  write(rel, version === null ? rest : { ...rest, version: version ?? USER_VERSION });
};

/** A block of plausible print settings, so "full copies" are genuinely large. */
function bulkSettings(seed = 0) {
  const out = {};
  for (let i = 0; i < 120; i++) {
    out[`setting_${String(i).padStart(3, '0')}`] = String((seed + i) % 97);
  }
  return out;
}

rmSync(ROOT, { recursive: true, force: true });

// ─── system bundles ────────────────────────────────────────────────────────
// Two vendors. The base names mirror OrcaSlicer's own (`fdm_*`), which are
// public product data rather than anything personal.

const acmeFilaments = [
  // Claimed by Globex too — see the note there.
  ['Shared PLA @System', { name: 'Shared PLA @System', inherits: 'fdm_filament_common', nozzle_temperature: '208' }],
  ['fdm_filament_common', { name: 'fdm_filament_common', instantiation: 'false', ...bulkSettings(1), nozzle_temperature: '200', filament_flow_ratio: '0.98' }],
  ['fdm_filament_abs', { name: 'fdm_filament_abs', instantiation: 'false', inherits: 'fdm_filament_common', nozzle_temperature: '250', hot_plate_temp: '90' }],
  // `filament_vendor` and `filament_type` are what the dropdown sub-groups and
  // orders system presets by (PresetComboBoxes.cpp:1222, :1330-1350). Stated on
  // some and not others on purpose: a preset with no vendor goes under
  // "Unspecified" rather than into a nameless submenu.
  ['Acme ABS @System', { name: 'Acme ABS @System', inherits: 'fdm_filament_abs', setting_id: 'ACMEABS000000001', filament_vendor: 'Acme', filament_type: 'ABS', filament_max_volumetric_speed: '8' }],
  ['Acme PLA @System', { name: 'Acme PLA @System', inherits: 'fdm_filament_common', setting_id: 'ACMEPLA000000001', filament_vendor: 'Acme', filament_type: 'PLA', nozzle_temperature: '215' }],
  // Installed under the name the loader *derives* rather than under its own. A
  // vendor preset with an `@` in its name and no `alias` of its own gets a
  // `renamed_from` of the name with the `@` deleted — "Acme PETG Cube", which is
  // what the conf below lists (PresetBundle.cpp:5086-5093).
  ['Acme PETG @Cube', { name: 'Acme PETG @Cube', inherits: 'fdm_filament_common', nozzle_temperature: '235' }],
  // The same shape *with* an alias, which is the guard on that rule: the C++
  // derives the old name only inside `if (alias_name.empty())`. The conf lists
  // "Acme PLA-CF Cube" and this preset must still count as not installed.
  ['Acme PLA-CF @Cube', { name: 'Acme PLA-CF @Cube', alias: 'Acme PLA-CF', inherits: 'fdm_filament_common', nozzle_temperature: '220' }],
  // ── parents that carry a gate, for user presets to inherit ───────────────
  // Nearly every real vendor filament is pinned to the printers it was tuned
  // for, and a user preset saved from one **stores none of that** — the loader
  // starts from the parent's config and lays the file's own keys over it
  // (Preset.cpp:1679-1684). Without a parent that carries a gate, nothing in
  // this fixture can tell "the file says nothing about printers" apart from
  // "the preset is compatible with everything", which are opposite answers.
  ['Acme ABS @Cube6', { name: 'Acme ABS @Cube6', inherits: 'fdm_filament_abs', compatible_printers: ['Acme Cube 0.6 nozzle'], nozzle_temperature: '252' }],
  // The same, gated by a condition rather than a list — and one that is *false*
  // for the Acme Cube, so a child inheriting it flips from available to excluded.
  ['Acme PLA @Globex', { name: 'Acme PLA @Globex', inherits: 'fdm_filament_common', compatible_printers: [], compatible_printers_condition: 'printer_notes=~/.*GLOBEX.*/', nozzle_temperature: '213' }],
  // And one carrying the *process* gate, which is inherited the same way.
  ['Acme PLA @Fine', { name: 'Acme PLA @Fine', inherits: 'fdm_filament_common', compatible_prints: ['0.20mm Standard @Acme'], nozzle_temperature: '217' }],
];

const acmeProcesses = [
  ['fdm_process_common', { name: 'fdm_process_common', instantiation: 'false', ...bulkSettings(2), layer_height: '0.2', wall_loops: '2' }],
  ['fdm_process_acme_common', { name: 'fdm_process_acme_common', instantiation: 'false', inherits: 'fdm_process_common', default_acceleration: '5000' }],
  ['0.20mm Standard @Acme', { name: '0.20mm Standard @Acme', inherits: 'fdm_process_acme_common', layer_height: '0.2', top_shell_thickness: '0.8' }],
  ['0.28mm Draft @Acme', { name: '0.28mm Draft @Acme', inherits: '0.20mm Standard @Acme', layer_height: '0.28', wall_loops: '3' }],
];

const acmeMachines = [
  ['fdm_machine_common', { name: 'fdm_machine_common', instantiation: 'false', ...bulkSettings(3), printable_height: '250' }],
  // A valid vendor printer preset: its `printer_model` is an entry in Acme's
  // `machine_model_list` below, and its `printer_variant` is one of that model's
  // nozzle diameters. Both are load-time requirements, not documentation
  // (PresetBundle.cpp:4988, :4997). Its `default_*` keys name what the slicer
  // *selects* when it is chosen (PresetBundle.cpp:2142-2166) — a different
  // question from what it is compatible with, and one the fixture has to be able
  // to tell apart from it.
  [
    'Acme Cube 0.4 nozzle',
    {
      name: 'Acme Cube 0.4 nozzle',
      instantiation: 'true',
      inherits: 'fdm_machine_common',
      printer_model: 'Acme Cube',
      printer_variant: '0.4',
      nozzle_diameter: '0.4',
      // Multi-line, as real `printer_notes` are. A `/.*ACME_CUBE.*/` condition
      // only matches across these newlines because boost::regex lets `.` do so.
      printer_notes: 'PRINTER_VENDOR_ACME\nPRINTER_MODEL_CUBE\nACME_CUBE_V1',
      default_print_profile: '0.20mm Standard @Acme',
      default_filament_profile: ['Acme PLA @System'],
    },
  ],
  // The same model, the other variant — and the conf below installs only `0.4`.
  // `is_visible` for a vendor printer is `get_variant(vendor, printer_model,
  // printer_variant)` (Preset.cpp:859-864), so this preset is one OrcaSlicer does
  // not offer at all: same vendor, same model, uninstalled nozzle.
  [
    'Acme Cube 0.6 nozzle',
    {
      name: 'Acme Cube 0.6 nozzle',
      instantiation: 'true',
      inherits: 'fdm_machine_common',
      printer_model: 'Acme Cube',
      printer_variant: '0.6',
      nozzle_diameter: '0.6',
      printer_notes: 'PRINTER_VENDOR_ACME\nPRINTER_MODEL_CUBE\nACME_CUBE_V1',
    },
  ],
];

for (const [, p] of acmeFilaments) write(`system/Acme/filament/${p.name}.json`, p);
for (const [, p] of acmeProcesses) write(`system/Acme/process/${p.name}.json`, p);
for (const [, p] of acmeMachines) write(`system/Acme/machine/${p.name}.json`, p);

// A printer *model*, not a preset: it declares the variants a machine preset's
// `printer_variant` has to be one of. It sits in `machine/` beside the presets
// and must not be counted as one (PresetBundle.cpp:4712-4820).
write('system/Acme/machine/Acme Cube.json', {
  name: 'Acme Cube',
  model_id: 'acme-cube',
  nozzle_diameter: '0.4;0.6',
  machine_tech: 'FFF',
  family: 'Acme',
  // What the slicer installs on the user's behalf when a printer would otherwise
  // have no filament at all (`load_installed_filaments`,
  // PresetBundle.cpp:2541-2600). Same `;`-separated form as `nozzle_diameter`.
  default_materials: 'Acme PLA @System;Acme ABS @System',
});

write('system/Acme.json', {
  name: 'Acme',
  version: '01.00.00.00',
  force_update: '0',
  description: 'Acme configurations',
  machine_model_list: [{ name: 'Acme Cube', sub_path: 'machine/Acme Cube.json' }],
  filament_list: acmeFilaments.map(([n]) => ({ name: n, sub_path: `filament/${n}.json` })),
  process_list: acmeProcesses.map(([n]) => ({ name: n, sub_path: `process/${n}.json` })),
  machine_list: acmeMachines.map(([n]) => ({ name: n, sub_path: `machine/${n}.json` })),
});

const globexFilaments = [
  // Renamed by a vendor profile update: the conf still lists the old name, and
  // `set_visible_from_appconfig` consults `renamed_from` for exactly this case
  // (Preset.cpp:875-877), so it counts as installed under it.
  [
    'Globex PETG @System',
    {
      name: 'Globex PETG @System',
      inherits: 'fdm_filament_common',
      renamed_from: '"Globex PETG Legacy"',
      nozzle_temperature: '240',
    },
  ],
  // The same name Acme ships below. Both are instantiable, so both end up in the
  // one collection the slicer keeps per preset type — and the merge discards
  // whichever arrives second ("Found duplicated preset", PresetBundle.cpp:2292).
  // Deliberately *not* an `fdm_*` base: a base never enters a collection, so two
  // vendors shipping one is not a clash at all.
  ['Shared PLA @System', { name: 'Shared PLA @System', inherits: 'fdm_filament_common', nozzle_temperature: '205' }],
];
for (const [, p] of globexFilaments) write(`system/Globex/filament/${p.name}.json`, p);

// A vendor printer preset naming a model this vendor never declares: Globex has
// no `machine_model_list` entry for "Globex Box", so the slicer drops the preset
// on load rather than showing it (PresetBundle.cpp:4988). Written on purpose.
write('system/Globex/machine/Globex Box 0.4 nozzle.json', {
  name: 'Globex Box 0.4 nozzle',
  instantiation: 'true',
  inherits: 'fdm_machine_common',
  printer_model: 'Globex Box',
  printer_variant: '0.4',
  nozzle_diameter: '0.4',
});

write('system/Globex.json', {
  name: 'Globex',
  version: '01.00.00.00',
  description: 'Globex configurations',
  // Declared so Globex has a model list at all, and deliberately pointing at a
  // file that is never written: a model with no file has no variants, so it is
  // never registered and every preset naming it is rejected.
  machine_model_list: [{ name: 'Globex Slab', sub_path: 'machine/Globex Slab.json' }],
  filament_list: [
    ...globexFilaments.map(([n]) => ({ name: n, sub_path: `filament/${n}.json` })),
    // An index entry with no file behind it — a broken install, invisible until
    // something tries to inherit from the name.
    { name: 'Globex TPU @System', sub_path: 'filament/Globex TPU @System.json' },
  ],
  process_list: [],
  machine_list: [{ name: 'Globex Box 0.4 nozzle', sub_path: 'machine/Globex Box 0.4 nozzle.json' }],
});

// ─── the live user profile ─────────────────────────────────────────────────
// `default`, because OrcaSlicer.conf below leaves `preset_folder` empty.

// A sparse preset: a handful of overrides over a deep system chain.
writeUser('user/default/filament/Studio ABS.json', {
  name: 'Studio ABS',
  from: 'User',
  inherits: 'Acme ABS @System',
  version: '2.4.0.3',
  filament_max_volumetric_speed: '12',
  filament_settings_id: 'Studio ABS',
  compatible_printers: ['Workshop Cube', 'Workshop Cube MK2'],
});

// Two overrides that change nothing plus two that do — the "looks bigger than
// it is" case, in miniature.
writeUser('user/default/filament/Studio ABS Hot.json', {
  name: 'Studio ABS Hot',
  from: 'User',
  inherits: 'Acme ABS @System',
  nozzle_temperature: '265',
  hot_plate_temp: '90', // identical to the parent -> redundant
  filament_max_volumetric_speed: '8', // identical to the parent -> redundant
  filament_flow_ratio: '0.95',
});

// A "- Copy" that kept its parent but re-stated almost everything: 120+ keys
// stored, a couple that differ.
writeUser('user/default/process/0.28mm Draft @Acme - Copy.json', {
  name: '0.28mm Draft @Acme - Copy',
  from: 'User',
  inherits: '0.28mm Draft @Acme',
  ...bulkSettings(2),
  layer_height: '0.28',
  wall_loops: '5', // differs from parent's 3
  top_shell_thickness: '1.2', // differs
});

// A detached full copy: no parent, everything stored inline.
writeUser('user/default/process/Fast Draft.json', {
  name: 'Fast Draft',
  from: 'User',
  inherits: '',
  ...bulkSettings(7),
  layer_height: '0.3',
  enable_support: '1',
  support_type: 'tree(auto)',
  default_acceleration: '15000',
  compatible_printers: ['Workshop Cube', 'Workshop Cube MK2', 'Workshop Mini'],
  wiping_volumes_extruders: ['70', '70', '70', '70'],
  print_extruder_variant: ['Direct Drive Standard'],
  post_process: [],
});

// A SECOND file claiming the same name, written in the other serialisation.
// OrcaSlicer loads one of these and never loads the other.
writeUser('user/default/process/Fast Draft 2.json', {
  name: 'Fast Draft', // <- same declared name, different file
  type: 'print',
  ...bulkSettings(7),
  layer_height: '0.3',
  enable_support: '0', // real difference
  support_type: 'normal(auto)', // real difference
  default_acceleration: '20000', // real difference
  compatible_printers: '"Workshop Cube";"Workshop Cube MK2";"Workshop Mini"', // same value, other form
  wiping_volumes_extruders: '70,70,70,70', // same value, other form
  print_extruder_variant: '"Direct Drive Standard"', // same value, other form
  post_process: '', // same value, other form
});

// A custom root in base/: saved detached, and inherited by name from elsewhere.
writeUser('user/default/process/base/Studio Base.json', {
  name: 'Studio Base',
  from: 'User',
  inherits: '',
  ...bulkSettings(11),
  layer_height: '0.24',
  wall_loops: '4',
});
writeUser('user/default/process/Studio Base Fine.json', {
  name: 'Studio Base Fine',
  from: 'User',
  inherits: 'Studio Base',
  layer_height: '0.16',
});

// A second file claiming the custom root's name, in the folder proper. `base/` is
// loaded first by guarantee (Preset.cpp:1583), so this one is never loaded — and
// `Studio Base Fine` inherits the one in `base/`, not this. An inheritance edge
// drawn to the wrong file shows a chain that does not exist.
writeUser('user/default/process/Studio Base.json', {
  name: 'Studio Base',
  from: 'User',
  inherits: '',
  ...bulkSettings(23),
  layer_height: '0.32',
  wall_loops: '1',
});

// A hand-edited loop: two presets inheriting each other. Nothing the slicer
// writes, everything a text editor can produce — and the reason resolution has a
// cycle guard at all. The graph has to draw the closing edge rather than follow
// it.
writeUser('user/default/process/Loop A.json', {
  name: 'Loop A',
  from: 'User',
  inherits: 'Loop B',
  layer_height: '0.26',
});
writeUser('user/default/process/Loop B.json', {
  name: 'Loop B',
  from: 'User',
  inherits: 'Loop A',
  top_shell_thickness: '0.9',
});

// A preset whose declared parent is not installed.
writeUser('user/default/process/Orphaned Profile.json', {
  name: 'Orphaned Profile',
  from: 'User',
  inherits: 'A Preset That Does Not Exist',
  layer_height: '0.2',
});

// A machine preset carrying credentials that are actually set, so redaction has
// something to redact. Invented values.
writeUser('user/default/machine/Workshop Cube.json', {
  name: 'Workshop Cube',
  from: 'User',
  inherits: 'Acme Cube 0.4 nozzle',
  printer_settings_id: 'Workshop Cube',
  print_host: 'printer.example.invalid',
  printhost_apikey: 'EXAMPLEKEY0000000000',
  printhost_password: 'example-password',
  printhost_user: 'operator',
  printhost_port: '80',
  host_type: 'octoprint',
});
writeUser('user/default/machine/Workshop Cube MK2.json', {
  name: 'Workshop Cube MK2',
  from: 'User',
  inherits: 'Acme Cube 0.4 nozzle',
  print_host: '',
  printhost_apikey: '',
  nozzle_diameter: '0.6',
  // The presets the slicer switches to when this printer is selected. The
  // process is not installed, so it silently selects something else instead; the
  // filament is, so only one of the two is a finding.
  default_print_profile: '0.16mm Fine @Acme',
  default_filament_profile: ['Studio ABS'],
});

// Inherits a name two vendors claim. Whichever vendor's file survives the merge
// decides what this preset resolves to.
writeUser('user/default/filament/Studio Shared.json', {
  name: 'Studio Shared',
  from: 'User',
  inherits: 'Shared PLA @System',
  filament_max_volumetric_speed: '11',
});

// A filament limited to printers that are not installed.
writeUser('user/default/filament/Legacy PETG.json', {
  name: 'Legacy PETG',
  from: 'User',
  inherits: 'Globex PETG @System',
  compatible_printers: ['Retired Printer A', 'Retired Printer B'],
  nozzle_temperature: '245',
});

// The same fault written the other way. A hand-edited or round-tripped preset
// stores the vector serialised, and the array-only check never looked at it — so
// this shape exists to make that check able to fail.
writeUser('user/default/filament/Retired PETG.json', {
  name: 'Retired PETG',
  from: 'User',
  inherits: 'Globex PETG @System',
  compatible_printers: '"Retired Printer A";"Retired Printer B"',
  nozzle_temperature: '250',
});

// A filament pinned to a process that is not installed. Different key, different
// consequence: it never becomes selectable *with that process*.
writeUser('user/default/filament/Studio ABS Fine Only.json', {
  name: 'Studio ABS Fine Only',
  from: 'User',
  inherits: 'Acme ABS @System',
  compatible_prints: ['0.10mm Ultrafine @Acme'],
  compatible_printers: ['Workshop Cube'],
  nozzle_temperature: '255',
});

// A filament whose `inherits` names a **process** preset. It looks resolvable and
// is not: a name is resolved inside one collection, and a collection holds a
// single preset type (Preset.cpp:3229).
writeUser('user/default/filament/Muddled ABS.json', {
  name: 'Muddled ABS',
  from: 'User',
  inherits: '0.20mm Standard @Acme',
  nozzle_temperature: '260',
});

// ─── a parent that exists as a file and is still not loadable ──────────────
// The ORCA-17 shape, and the one a config snapshot cannot show without the rule:
// `version` is parsed before the parent lookup, and a user preset whose `version`
// does not parse is dropped with no error and no log line (Preset.cpp:1653-1655).
// A dropped preset is not in the collection, so nothing can inherit from it —
// which is why the two presets below it are dropped too, each logging "can not
// find parent" (Preset.cpp:1686-1691).
//
// This sits in `machine/base/` on purpose: `base/` is loaded first and is the one
// place a custom root *should* be reachable from, so a failure here is the case
// that reads as "but the file is right there".
writeUser('user/default/machine/base/Bench Rig Base.json', {
  name: 'Bench Rig Base',
  from: 'User',
  inherits: '',
  version: null, // <- the fault. Never loaded, and not usable as a parent.
  ...bulkSettings(31),
  printable_height: '240',
  nozzle_diameter: '0.4',
});

// The child. Its 120-odd keys are the only values it has, because the parent is
// never applied — so "overrides that change nothing" would be exactly backwards,
// and it must not be reported as a near-duplicate of its sibling either.
writeUser('user/default/machine/Bench Rig A.json', {
  name: 'Bench Rig A',
  from: 'User',
  inherits: 'Bench Rig Base',
  ...bulkSettings(31),
  printable_height: '240',
  nozzle_diameter: '0.4',
});

// The sibling: identical in effect to `Bench Rig A` under a resolution that
// applies the parent, and equally not loaded. The pair is what makes the
// `near-duplicate` suppression able to fail.
writeUser('user/default/machine/Bench Rig B.json', {
  name: 'Bench Rig B',
  from: 'User',
  inherits: 'Bench Rig Base',
  ...bulkSettings(31),
  printable_height: '240',
  nozzle_diameter: '0.4',
});

// The grandchild, so the cascade is covered rather than assumed: its own parent is
// a file that exists, in the loaded folder, under the right name, and is skipped.
writeUser('user/default/machine/Bench Rig A Fine.json', {
  name: 'Bench Rig A Fine',
  from: 'User',
  inherits: 'Bench Rig A',
  printable_height: '235',
});

// The control, and the reason this is a test rather than an assertion: the same
// shape with a `version` the parser accepts. It loads, so `Bench Rig C` resolves
// through it and gets ordinary redundant-override advice.
writeUser('user/default/machine/base/Bench Rig Base OK.json', {
  name: 'Bench Rig Base OK',
  from: 'User',
  inherits: '',
  ...bulkSettings(37),
  printable_height: '260',
});
writeUser('user/default/machine/Bench Rig C.json', {
  name: 'Bench Rig C',
  from: 'User',
  inherits: 'Bench Rig Base OK',
  printable_height: '260', // identical to the parent -> redundant, and reported
  nozzle_diameter: '0.4',
});

// A `version` that is *present* and still rejected: the parser needs at least
// `major.minor`, all numeric, so a bare `"1"` fails the component count
// (semver.c:212-213) exactly as an absent key does. Two different fixes, so the
// finding has to be able to tell them apart.
writeUser('user/default/process/Half Versioned.json', {
  name: 'Half Versioned',
  from: 'User',
  inherits: '0.20mm Standard @Acme',
  version: '1',
  layer_height: '0.21',
});

// A preset whose parent exists — but only in the cloud profile, which is not the
// loaded one. Indistinguishable from "you deleted it" until the finding says so.
writeUser('user/default/process/Wants Cloud Base.json', {
  name: 'Wants Cloud Base',
  from: 'User',
  inherits: 'Cloud Only',
  layer_height: '0.22',
});

// ─── compatibility shapes ──────────────────────────────────────────────────
// One filament per reason `compatibilityFor` can return, so a test can assert the
// reason rather than the boolean.

// Named explicitly — but only for the *vendor* printer. `Workshop Cube` inherits
// that preset, so the slicer offers this filament for it anyway
// (`is_compatible_with_parent_printer`, Preset.cpp:798-806). This is the shape
// that catches a model built on name-matching alone.
writeUser('user/default/filament/Studio PLA Inherited.json', {
  name: 'Studio PLA Inherited',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: ['Acme Cube 0.4 nozzle'],
  nozzle_temperature: '210',
});

// Excluded: a non-empty list that names another installed printer and not this
// one. Not an orphan — the printer it names is real.
writeUser('user/default/filament/Studio PLA MK2 Only.json', {
  name: 'Studio PLA MK2 Only',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: ['Workshop Cube MK2'],
  nozzle_temperature: '212',
});

// A condition with an *empty* list, which is the case the slicer treats as "the
// condition is the whole answer" (Preset.cpp:826). Not evaluated yet, so it has to
// come back undetermined with the expression shown rather than as a guess.
writeUser('user/default/filament/Studio PLA Conditional.json', {
  name: 'Studio PLA Conditional',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: [],
  compatible_printers_condition: 'printer_notes=~/.*ACME_CUBE.*/ and nozzle_diameter[0]==0.4',
  nozzle_temperature: '214',
});

// A condition we could never evaluate — a function outside any documented subset.
// It must land on undetermined too, not on a default answer.
writeUser('user/default/filament/Studio PLA Opaque.json', {
  name: 'Studio PLA Opaque',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: [],
  compatible_printers_condition: 'interpolate_table(nozzle_diameter[0], (0.4, 1), (0.6, 0)) > 0.5',
  nozzle_temperature: '216',
});

// ── gates arriving through `inherits` rather than through the file ─────────
// This is the commonest shape in a real config and the one that made the app
// report 47 filaments where the slicer offered 18: "Save as" from a vendor
// filament writes the overrides and nothing else, so the file mentions no
// printers at all while the preset is pinned to one.
writeUser('user/default/filament/Studio ABS From Cube6.json', {
  name: 'Studio ABS From Cube6',
  from: 'User',
  inherits: 'Acme ABS @Cube6',
  nozzle_temperature: '258',
});

// The same parent, with the list stated **empty**. The loader applies the child's
// own keys over the parent's config, and an empty vector is a value — so this one
// really is compatible with everything, and it is the failing direction for
// "present counts as stated": read it as absent and it falls through to the
// parent's list, which is the opposite answer.
writeUser('user/default/filament/Studio ABS Unpinned.json', {
  name: 'Studio ABS Unpinned',
  from: 'User',
  inherits: 'Acme ABS @Cube6',
  compatible_printers: [],
  nozzle_temperature: '259',
});

// An inherited *condition*. `compatible_printers_condition()` is a config
// accessor (Preset.hpp:347), so this child is judged by an expression it does not
// contain — and one that is false for the Acme Cube.
writeUser('user/default/filament/Studio PLA From Globex.json', {
  name: 'Studio PLA From Globex',
  from: 'User',
  inherits: 'Acme PLA @Globex',
  nozzle_temperature: '211',
});

// An inherited process gate, so the second relation has to be read off the chain
// as well.
writeUser('user/default/filament/Studio PLA From Fine.json', {
  name: 'Studio PLA From Fine',
  from: 'User',
  inherits: 'Acme PLA @Fine',
  nozzle_temperature: '219',
});

// The process gate, which is a second relation and not the same one: this filament
// is fine for the printer and only offered with one process.
writeUser('user/default/filament/Studio PLA Fine Process.json', {
  name: 'Studio PLA Fine Process',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_prints: '"0.20mm Standard @Acme"',
  nozzle_temperature: '218',
});

// ─── an inactive profile + its sync snapshots ──────────────────────────────
// A cloud account folder. OrcaSlicer loads one user folder, so with
// preset_folder empty none of this is live.

const CLOUD = 'user/cloud-0000-1111';
writeUser(`${CLOUD}/filament/Studio ABS.json`, {
  name: 'Studio ABS', // same name as the live one — expected, not a clash
  from: 'User',
  inherits: 'Acme ABS @System',
  filament_max_volumetric_speed: '14',
});
writeUser(`${CLOUD}/process/Cloud Only.json`, {
  name: 'Cloud Only',
  from: 'User',
  inherits: '0.20mm Standard @Acme',
  layer_height: '0.18',
});

for (const snap of ['aaaa0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000002']) {
  for (const name of ['Studio ABS', 'Snapshot Filament']) {
    writeUser(`${CLOUD}/_local/${snap}/filament/${name}.json`, {
      name,
      from: 'User',
      inherits: 'Acme ABS @System',
      nozzle_temperature: '250',
    });
  }
  writeUser(`${CLOUD}/_local/${snap}/process/Cloud Only.json`, {
    name: 'Cloud Only',
    from: 'User',
    inherits: '0.20mm Standard @Acme',
    layer_height: '0.18',
  });
}

// ─── application state ─────────────────────────────────────────────────────
// Nested, and full of things that must never be served. All invented — this is
// what the allowlist in redactConfJson is tested against.
write('OrcaSlicer.conf', {
  app: {
    preset_folder: '',
    sync_user_preset: 'false',
    region: 'Other',
  },
  access_code: { 'Workshop Cube': '00112233' },
  user_access_code: 'abcdef123456',
  dev_sn: { 'Workshop Cube': 'SNEXAMPLE0001' },
  local_machines: {
    '192.0.2.10': { dev_ip: '192.0.2.10', dev_name: 'Workshop Cube', printer_type: 'acme-cube' },
  },
  presets: { filament: 'Studio ABS', print: 'Fast Draft' },
  // The installed filaments — the `is_visible` gate. An array of names, which is
  // the only form the slicer writes (AppConfig.cpp:966-973). Four kinds of entry
  // on purpose: two presets installed under their own names, one under the name a
  // vendor rename left behind, one under a *derived* old name, and one that names
  // a preset which declares an alias and so must NOT match.
  filaments: [
    'Acme PLA @System',
    'Acme ABS @System',
    'Globex PETG Legacy',
    'Acme PETG Cube',
    'Acme PLA-CF Cube',
  ],
  // The installed printer models. `Acme Cube` declares `0.4;0.6` and only `0.4`
  // is installed, so `Acme Cube 0.6 nozzle` is a preset the slicer never offers.
  // The fourth field is not part of the shape the slicer reads
  // (AppConfig.cpp:735-746) and is here to be dropped: `redactConfJson` rebuilds
  // these entries field by field, and a hostile neighbour riding along inside one
  // is precisely what that is for.
  models: [
    { vendor: 'Acme', model: 'Acme Cube', nozzle_diameter: '0.4', dev_ip: '192.0.2.77' },
  ],
});

console.log(`fixture written to ${ROOT}`);
