/**
 * What the user has actually *installed*, out of `OrcaSlicer.conf`.
 *
 * This is the second of the two gates the filament dropdown applies, and the one
 * that makes a config of 2300 presets offer twelve. `is_compatible` — which
 * `compatibility.ts` models — asks whether a preset *may* be used with a printer.
 * `is_visible` asks whether the user ever added it at all, and the combo box
 * requires both: `it_preset->is_visible && (it_preset->is_compatible || <selected>)`
 * (v2.4.2 Preset.cpp:3166-3168).
 *
 * Visibility for a **vendor** preset is set from the application config, never
 * from the preset file (`Preset::set_visible_from_appconfig`, Preset.cpp:853-882).
 * This module reads the two sections that decide it and does nothing else with
 * them — applying the rule needs the preset graph and lives in `compatibility.ts`.
 *
 * ## The shapes, which are not what the C++ names suggest
 *
 * `AppConfig` presents both as ini-style sections of `key -> value` strings, and
 * the JSON on disk is neither:
 *
 *  - **`filaments`** is a JSON **array of preset names**. The loader expands it to
 *    `m_storage["filaments"][element] = "true"` (AppConfig.cpp:747-752) and the
 *    writer collapses the keys back to an array (AppConfig.cpp:966-973). So the
 *    `installed.find(name) != end && ! it->second.empty()` test in
 *    `set_visible_from_appconfig` (Preset.cpp:869-872) can only ever be decided by
 *    *presence*: a name that is there was written with `"true"`. The map form is
 *    still accepted below — it costs one branch, it is what the C++ believes it is
 *    reading, and a value that is present but empty means **not** installed.
 *  - **`models`** is a JSON array of `{vendor, model, nozzle_diameter}`, loaded
 *    into `m_vendors[vendor][model] = {variants…}` with `nozzle_diameter` split by
 *    `unescape_strings_cstyle` — the same `;`-separated form `parseQuotedList`
 *    handles everywhere else in this app (AppConfig.cpp:735-746). `get_variant`
 *    is then a plain three-level membership test (AppConfig.cpp:1272-1278).
 *
 * The `vendor` in a `models` entry is `VendorProfile::id`, which is the vendor
 * bundle's filename with `.json` removed (`VendorProfile vendor_profile(vendor_name)`,
 * PresetBundle.cpp:4617, over the ctor at Preset.hpp:172; the stem is derived at
 * PresetBundle.cpp:2325-2327). That is exactly the `system/<Vendor>/…` directory
 * this app already records as a preset's `vendor`, so the two join directly.
 *
 * ## Absent is not empty
 *
 * `present` is the difference between "the user has installed nothing" and "we
 * were never shown the file". Only the first is a fact about the config; the
 * second is a fact about us, and gating a list to nothing on the strength of it
 * would be inventing an answer. Callers apply the gate only when `present`.
 *
 * So `present` asks whether the conf carried **either section at all**, not
 * merely whether a file parsed. The case that forces it: in container mode the
 * conf arrives through `redactConfJson`, which omits a section it could not read
 * — and a conf reduced to `{app: {preset_folder: ""}}` by an unparseable original
 * would otherwise read as "nothing is installed" and empty every list in the app.
 * One section is enough: a config with `models` and no `filaments` is a real
 * state (nothing installed yet, defaults about to be seeded), and the slicer
 * treats it as exactly that.
 */

import { parseQuotedList } from './normalize';
import type { ConfigFile } from './index-config';

export interface InstalledState {
  /**
   * Was there a parseable `OrcaSlicer.conf` at all? When false the two sets
   * below are empty because nothing was read, **not** because nothing is
   * installed, and the visibility gate does not apply.
   */
  present: boolean;
  /** Names in the `filaments` section: the installed filament presets. */
  filaments: Set<string>;
  /** `vendor id -> printer model -> variants`, the `models` section. */
  variants: Map<string, Map<string, Set<string>>>;
}

export const EMPTY_INSTALLED: InstalledState = {
  present: false,
  filaments: new Set(),
  variants: new Map(),
};

/** `AppConfig::get_variant` (AppConfig.cpp:1272-1278). */
export function hasVariant(
  state: InstalledState,
  vendor: string,
  model: string,
  variant: string,
): boolean {
  return state.variants.get(vendor)?.get(model)?.has(variant) ?? false;
}

/**
 * The `filaments` section, from either serialisation.
 *
 * Array form: every element is an installed name. Map form: a key counts only
 * when its value is a non-empty string, which is the `has()` lambda in
 * `set_visible_from_appconfig` (Preset.cpp:869-872) rather than an invention
 * here.
 */
function readFilaments(value: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') out.add(entry);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
      if (name !== '' && typeof v === 'string' && v !== '') out.add(name);
    }
  }
  return out;
}

/** The `models` section, as `m_vendors` (AppConfig.cpp:735-746). */
function readVariantMap(value: unknown): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const vendor = typeof e.vendor === 'string' ? e.vendor : '';
    const model = typeof e.model === 'string' ? e.model : '';
    if (vendor === '' || model === '') continue;
    // `unescape_strings_cstyle` on a `;`-separated list; an array is accepted
    // for the same reason it is everywhere else — a hand-edited file can hold one.
    const nd = e.nozzle_diameter;
    const variants = Array.isArray(nd)
      ? nd.map(String)
      : typeof nd === 'string'
        ? parseQuotedList(nd)
        : [];
    let byModel = out.get(vendor);
    if (!byModel) out.set(vendor, (byModel = new Map()));
    let set = byModel.get(model);
    if (!set) byModel.set(model, (set = new Set()));
    for (const v of variants) {
      if (v !== '') set.add(v);
    }
  }
  return out;
}

/**
 * Read both sections out of the config directory.
 *
 * The conf is found by name rather than by position, the same way
 * `readActiveProfile` finds it: it sits at the config root beside `system/` and
 * `user/`.
 */
export function readInstalled(files: ConfigFile[]): InstalledState {
  const conf = files.find((f) => f.path.replace(/\\/g, '/').replace(/^\.\//, '') === 'OrcaSlicer.conf');
  if (!conf) return EMPTY_INSTALLED;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(conf.text) as Record<string, unknown>;
  } catch {
    // Unreadable is not empty either: the slicer would have rewritten it, and we
    // cannot say what is installed from a file we could not parse.
    return EMPTY_INSTALLED;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_INSTALLED;
  // Either section, in a shape we can read, is what makes the gate applicable.
  const hasFilaments =
    Array.isArray(parsed.filaments) ||
    (parsed.filaments !== null && typeof parsed.filaments === 'object');
  const hasModels = Array.isArray(parsed.models);
  if (!hasFilaments && !hasModels) return EMPTY_INSTALLED;
  return {
    present: true,
    filaments: readFilaments(parsed.filaments),
    variants: readVariantMap(parsed.models),
  };
}
