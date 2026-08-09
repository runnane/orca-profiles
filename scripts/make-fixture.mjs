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
  ['fdm_filament_common', { name: 'fdm_filament_common', instantiation: 'false', ...bulkSettings(1), nozzle_temperature: '200', filament_flow_ratio: '0.98' }],
  ['fdm_filament_abs', { name: 'fdm_filament_abs', instantiation: 'false', inherits: 'fdm_filament_common', nozzle_temperature: '250', hot_plate_temp: '90' }],
  ['Acme ABS @System', { name: 'Acme ABS @System', inherits: 'fdm_filament_abs', setting_id: 'ACMEABS000000001', filament_max_volumetric_speed: '8' }],
  ['Acme PLA @System', { name: 'Acme PLA @System', inherits: 'fdm_filament_common', setting_id: 'ACMEPLA000000001', nozzle_temperature: '215' }],
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
      printer_notes: 'ACME_CUBE_V1',
      default_print_profile: '0.20mm Standard @Acme',
      default_filament_profile: ['Acme PLA @System'],
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
  ['Globex PETG @System', { name: 'Globex PETG @System', inherits: 'fdm_filament_common', nozzle_temperature: '240' }],
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
write('user/default/filament/Studio ABS.json', {
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
write('user/default/filament/Studio ABS Hot.json', {
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
write('user/default/process/0.28mm Draft @Acme - Copy.json', {
  name: '0.28mm Draft @Acme - Copy',
  from: 'User',
  inherits: '0.28mm Draft @Acme',
  ...bulkSettings(2),
  layer_height: '0.28',
  wall_loops: '5', // differs from parent's 3
  top_shell_thickness: '1.2', // differs
});

// A detached full copy: no parent, everything stored inline.
write('user/default/process/Fast Draft.json', {
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
write('user/default/process/Fast Draft 2.json', {
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
write('user/default/process/base/Studio Base.json', {
  name: 'Studio Base',
  from: 'User',
  inherits: '',
  ...bulkSettings(11),
  layer_height: '0.24',
  wall_loops: '4',
});
write('user/default/process/Studio Base Fine.json', {
  name: 'Studio Base Fine',
  from: 'User',
  inherits: 'Studio Base',
  layer_height: '0.16',
});

// A second file claiming the custom root's name, in the folder proper. `base/` is
// loaded first by guarantee (Preset.cpp:1583), so this one is never loaded — and
// `Studio Base Fine` inherits the one in `base/`, not this. An inheritance edge
// drawn to the wrong file shows a chain that does not exist.
write('user/default/process/Studio Base.json', {
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
write('user/default/process/Loop A.json', {
  name: 'Loop A',
  from: 'User',
  inherits: 'Loop B',
  layer_height: '0.26',
});
write('user/default/process/Loop B.json', {
  name: 'Loop B',
  from: 'User',
  inherits: 'Loop A',
  top_shell_thickness: '0.9',
});

// A preset whose declared parent is not installed.
write('user/default/process/Orphaned Profile.json', {
  name: 'Orphaned Profile',
  from: 'User',
  inherits: 'A Preset That Does Not Exist',
  layer_height: '0.2',
});

// A machine preset carrying credentials that are actually set, so redaction has
// something to redact. Invented values.
write('user/default/machine/Workshop Cube.json', {
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
write('user/default/machine/Workshop Cube MK2.json', {
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

// A filament limited to printers that are not installed.
write('user/default/filament/Legacy PETG.json', {
  name: 'Legacy PETG',
  from: 'User',
  inherits: 'Globex PETG @System',
  compatible_printers: ['Retired Printer A', 'Retired Printer B'],
  nozzle_temperature: '245',
});

// The same fault written the other way. A hand-edited or round-tripped preset
// stores the vector serialised, and the array-only check never looked at it — so
// this shape exists to make that check able to fail.
write('user/default/filament/Retired PETG.json', {
  name: 'Retired PETG',
  from: 'User',
  inherits: 'Globex PETG @System',
  compatible_printers: '"Retired Printer A";"Retired Printer B"',
  nozzle_temperature: '250',
});

// A filament pinned to a process that is not installed. Different key, different
// consequence: it never becomes selectable *with that process*.
write('user/default/filament/Studio ABS Fine Only.json', {
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
write('user/default/filament/Muddled ABS.json', {
  name: 'Muddled ABS',
  from: 'User',
  inherits: '0.20mm Standard @Acme',
  nozzle_temperature: '260',
});

// A preset whose parent exists — but only in the cloud profile, which is not the
// loaded one. Indistinguishable from "you deleted it" until the finding says so.
write('user/default/process/Wants Cloud Base.json', {
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
write('user/default/filament/Studio PLA Inherited.json', {
  name: 'Studio PLA Inherited',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: ['Acme Cube 0.4 nozzle'],
  nozzle_temperature: '210',
});

// Excluded: a non-empty list that names another installed printer and not this
// one. Not an orphan — the printer it names is real.
write('user/default/filament/Studio PLA MK2 Only.json', {
  name: 'Studio PLA MK2 Only',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: ['Workshop Cube MK2'],
  nozzle_temperature: '212',
});

// A condition with an *empty* list, which is the case the slicer treats as "the
// condition is the whole answer" (Preset.cpp:826). Not evaluated yet, so it has to
// come back undetermined with the expression shown rather than as a guess.
write('user/default/filament/Studio PLA Conditional.json', {
  name: 'Studio PLA Conditional',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: [],
  compatible_printers_condition: 'printer_notes=~/.*ACME_CUBE.*/ and nozzle_diameter[0]==0.4',
  nozzle_temperature: '214',
});

// A condition we could never evaluate — a function outside any documented subset.
// It must land on undetermined too, not on a default answer.
write('user/default/filament/Studio PLA Opaque.json', {
  name: 'Studio PLA Opaque',
  from: 'User',
  inherits: 'Acme PLA @System',
  compatible_printers: [],
  compatible_printers_condition: 'interpolate_table(nozzle_diameter[0], (0.4, 1), (0.6, 0)) > 0.5',
  nozzle_temperature: '216',
});

// The process gate, which is a second relation and not the same one: this filament
// is fine for the printer and only offered with one process.
write('user/default/filament/Studio PLA Fine Process.json', {
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
write(`${CLOUD}/filament/Studio ABS.json`, {
  name: 'Studio ABS', // same name as the live one — expected, not a clash
  from: 'User',
  inherits: 'Acme ABS @System',
  filament_max_volumetric_speed: '14',
});
write(`${CLOUD}/process/Cloud Only.json`, {
  name: 'Cloud Only',
  from: 'User',
  inherits: '0.20mm Standard @Acme',
  layer_height: '0.18',
});

for (const snap of ['aaaa0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000002']) {
  for (const name of ['Studio ABS', 'Snapshot Filament']) {
    write(`${CLOUD}/_local/${snap}/filament/${name}.json`, {
      name,
      from: 'User',
      inherits: 'Acme ABS @System',
      nozzle_temperature: '250',
    });
  }
  write(`${CLOUD}/_local/${snap}/process/Cloud Only.json`, {
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
});

console.log(`fixture written to ${ROOT}`);
