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
  ['fdm_filament_common', { name: 'fdm_filament_common', ...bulkSettings(1), nozzle_temperature: '200', filament_flow_ratio: '0.98' }],
  ['fdm_filament_abs', { name: 'fdm_filament_abs', inherits: 'fdm_filament_common', nozzle_temperature: '250', hot_plate_temp: '90' }],
  ['Acme ABS @System', { name: 'Acme ABS @System', inherits: 'fdm_filament_abs', setting_id: 'ACMEABS000000001', filament_max_volumetric_speed: '8' }],
  ['Acme PLA @System', { name: 'Acme PLA @System', inherits: 'fdm_filament_common', setting_id: 'ACMEPLA000000001', nozzle_temperature: '215' }],
];

const acmeProcesses = [
  ['fdm_process_common', { name: 'fdm_process_common', ...bulkSettings(2), layer_height: '0.2', wall_loops: '2' }],
  ['fdm_process_acme_common', { name: 'fdm_process_acme_common', inherits: 'fdm_process_common', default_acceleration: '5000' }],
  ['0.20mm Standard @Acme', { name: '0.20mm Standard @Acme', inherits: 'fdm_process_acme_common', layer_height: '0.2', top_shell_thickness: '0.8' }],
  ['0.28mm Draft @Acme', { name: '0.28mm Draft @Acme', inherits: '0.20mm Standard @Acme', layer_height: '0.28', wall_loops: '3' }],
];

const acmeMachines = [
  ['fdm_machine_common', { name: 'fdm_machine_common', ...bulkSettings(3), printable_height: '250' }],
  ['Acme Cube 0.4 nozzle', { name: 'Acme Cube 0.4 nozzle', inherits: 'fdm_machine_common', printer_model: 'Acme Cube', nozzle_diameter: '0.4' }],
];

for (const [, p] of acmeFilaments) write(`system/Acme/filament/${p.name}.json`, p);
for (const [, p] of acmeProcesses) write(`system/Acme/process/${p.name}.json`, p);
for (const [, p] of acmeMachines) write(`system/Acme/machine/${p.name}.json`, p);

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
write('system/Globex.json', {
  name: 'Globex',
  version: '01.00.00.00',
  description: 'Globex configurations',
  machine_model_list: [],
  filament_list: globexFilaments.map(([n]) => ({ name: n, sub_path: `filament/${n}.json` })),
  process_list: [],
  machine_list: [],
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
});

// A filament limited to printers that are not installed.
write('user/default/filament/Legacy PETG.json', {
  name: 'Legacy PETG',
  from: 'User',
  inherits: 'Globex PETG @System',
  compatible_printers: ['Retired Printer A', 'Retired Printer B'],
  nozzle_temperature: '245',
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
