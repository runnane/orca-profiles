/**
 * Building a searchable index from a config directory.
 *
 * Layout (OrcaSlicer 2.x):
 *
 *   system/<Vendor>.json          vendor index: lists every preset + sub_path
 *   system/<Vendor>/<kind>/...    the system presets themselves
 *   user/<profile>/<kind>/*.json       user presets
 *   user/<profile>/<kind>/base/*.json  detached "custom roots" (see below)
 *   user/<profile>/_local/<uuid>/...   cloud sync snapshots
 *
 * A `.info` sidecar sits beside each user preset. It is deliberately not read:
 * it holds the account UUID, and the only other things in it (`setting_id`,
 * `base_id`) duplicate what the JSON already says.
 *
 * Three load rules from the slicer, all of which change what the config means
 * (v2.4.2 `Preset.cpp` / `PresetBundle.cpp`, line numbers below):
 *
 *  1. Exactly **one** user folder is loaded — `app.preset_folder`, or `default`
 *     when it is empty. Other user folders are inert.       PresetBundle.cpp:528
 *  2. `base/` is loaded **first**, as "custom roots", into the same collection,
 *     so ordinary presets can inherit from them by name.       Preset.cpp:1583
 *  3. On a name clash the **first loaded wins** and every later file is skipped
 *     entirely — not merged, not renamed, just never loaded.   Preset.cpp:1619
 *  4. A user preset whose `version` does not parse is dropped **silently**, and a
 *     dropped preset cannot be anyone's parent.             Preset.cpp:1653-1655
 *
 * The vendor index matters too: `inherits` names a preset, it does not give a
 * path, so resolving a chain requires a name -> file map built from these.
 */

import { readInstalled, type InstalledState } from './installed';
import { parseQuotedList } from './normalize';
import { versionLoads } from './preset-version';
import type { Preset, PresetKind, PresetScope, RawPreset } from './types';

export interface ConfigFile {
  /** Path relative to the config root, `/`-separated. */
  path: string;
  text: string;
}

export interface VendorIndexEntry {
  name: string;
  sub_path: string;
}

/** Which list in `system/<Vendor>.json` declared an entry. */
export type VendorList = 'process_list' | 'filament_list' | 'machine_list' | 'machine_model_list';

/**
 * One `sub_path` entry out of a vendor index, and whether the file it names is
 * actually there.
 *
 * A vendor index is not documentation: it is the list the slicer loads from, so
 * an entry pointing at a file that is not on disk means that preset simply does
 * not exist however much the index claims it does.
 */
export interface VendorRef {
  vendor: string;
  list: VendorList;
  /** The declared name. For `machine_model_list` this is the model **id** the
   * slicer matches `printer_model` against (`model.id = machine_model.first`,
   * PresetBundle.cpp:4718) — not the `name` inside the model file. */
  name: string;
  /** As written in the index. */
  subPath: string;
  /** `system/<Vendor>/<sub_path>`, normalised. */
  path: string;
  /** Was a file at `path` among the files we were given? */
  present: boolean;
}

/**
 * A printer model declared by a vendor, as the slicer ends up holding it.
 *
 * `variants` comes from the model file's `nozzle_diameter` (a `;`-separated
 * list, PresetBundle.cpp:4739-4747). A model with no variants is **never
 * registered** (`if (! model.id.empty() && ! model.variants.empty())`,
 * PresetBundle.cpp:4819), which is why a missing model file invalidates every
 * printer preset that names it rather than merely being untidy.
 */
export interface VendorModel {
  vendor: string;
  id: string;
  path: string;
  present: boolean;
  variants: string[];
  /**
   * The model's `default_materials`, a `;`-separated list sorted and deduped on
   * load, with a leading empty entry dropped (PresetBundle.cpp:4788-4793).
   *
   * These are the filaments the slicer marks installed *on the user's behalf*
   * when a printer would otherwise have none — see `load_installed_filaments`
   * (PresetBundle.cpp:2541-2600) and the seeding rule in `compatibility.ts`.
   */
  defaultMaterials: string[];
}

export interface ConfigIndex {
  /** Everything found, inactive profiles and snapshots included. */
  presets: Preset[];
  /** The presets the slicer actually loads — the default view. */
  active: Preset[];
  /** The user folder the slicer loads; `default` unless `preset_folder` is set. */
  activeProfile: string;
  /** User folders present on disk but not loaded. */
  inactiveProfiles: string[];
  /** All presets by id. */
  byId: Map<string, Preset>;
  /** name -> active presets with that name, for `inherits` lookup. */
  byName: Map<string, Preset[]>;
  vendors: string[];
  /** Every `sub_path` entry across every vendor index, with its file's presence. */
  vendorRefs: VendorRef[];
  /** Printer models declared by the vendor indexes. */
  vendorModels: VendorModel[];
  /**
   * Vendors whose entire bundle fails to load, keyed by vendor directory name.
   *
   * Not a per-preset fault: the bundle is loaded into a temporary `PresetBundle`
   * and merged into the app's only on success, so a failure takes the vendor's
   * presets **and** its `vendorModels` with it. See `failedVendorBundles`.
   */
  failedVendors: Map<string, VendorBundleFailure>;
  /**
   * Active presets the slicer never loads, and why. Keyed by id.
   *
   * A file in this map is on disk and absent from the slicer: not selectable, and
   * not available as a parent. See `notLoadedPresets`.
   */
  notLoaded: Map<string, LoadFailure>;
  /**
   * What `OrcaSlicer.conf` says the user has installed — the `is_visible` gate,
   * which is independent of compatibility and applies only to vendor presets.
   */
  installed: InstalledState;
  /** Files that were present but could not be parsed. */
  parseErrors: { path: string; message: string }[];
}

const KINDS: PresetKind[] = ['filament', 'process', 'machine'];

/** The vendor index lists that name presets. `machine_model_list` names models. */
const PRESET_LISTS = ['process_list', 'filament_list', 'machine_list'] as const;

function kindFromPath(path: string): PresetKind | undefined {
  const parts = path.split('/');
  return KINDS.find((k) => parts.includes(k));
}

/**
 * A printer model's variants: the model file's `nozzle_diameter`, which is a
 * `;`-separated list (`unescape_strings_cstyle`, PresetBundle.cpp:4739-4747).
 * These are the values a system printer preset's `printer_variant` must be one
 * of, so a model file we cannot read yields none rather than guessing.
 */
function readVariants(text: string): string[] {
  return readList(text, 'nozzle_diameter');
}

/**
 * A `;`-separated list field out of a printer model file. `default_materials` is
 * read the same way `nozzle_diameter` is — both go through
 * `unescape_strings_cstyle` (PresetBundle.cpp:4739-4747, :4788-4793) — so they
 * share one reader rather than two that could drift.
 */
function readList(text: string, key: string): string[] {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const v = parsed[key];
    if (typeof v === 'string') return parseQuotedList(v).filter((x) => x !== '');
    if (Array.isArray(v)) return v.map(String).filter((x) => x !== '');
    return [];
  } catch {
    return [];
  }
}

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Which user folder the slicer loads.
 *
 * `app.preset_folder` in `OrcaSlicer.conf`; empty means `default`
 * (PresetBundle.cpp:528). Without the conf file we assume `default`, which is
 * what the slicer would do anyway.
 */
export function readActiveProfile(files: ConfigFile[]): string {
  const conf = files.find((f) => normalisePath(f.path) === 'OrcaSlicer.conf');
  if (!conf) return DEFAULT_USER_FOLDER;
  try {
    const parsed = JSON.parse(conf.text) as Record<string, unknown>;
    const app = (parsed.app ?? parsed) as Record<string, unknown>;
    const folder = app.preset_folder;
    return typeof folder === 'string' && folder !== '' ? folder : DEFAULT_USER_FOLDER;
  } catch {
    return DEFAULT_USER_FOLDER;
  }
}

/** `DEFAULT_USER_FOLDER_NAME` in the slicer. */
const DEFAULT_USER_FOLDER = 'default';

/**
 * Build the index. `files` is every `.json` under the config root; the caller
 * decides how to enumerate (directory picker, fixtures, ...).
 */
export function buildIndex(files: ConfigFile[]): ConfigIndex {
  const presets: Preset[] = [];
  const parseErrors: { path: string; message: string }[] = [];
  const vendors = new Set<string>();
  const activeProfile = readActiveProfile(files);

  // Vendor index files tell us each system preset's declared name, which can
  // differ from its filename. Map path -> declared name so the preset picks it up.
  const declaredNameByPath = new Map<string, string>();
  const byPath = new Map<string, ConfigFile>();
  for (const f of files) byPath.set(normalisePath(f.path), f);
  const vendorRefs: VendorRef[] = [];
  const vendorModels: VendorModel[] = [];
  /** Paths a `machine_model_list` points at, so they are not read as presets. */
  const modelFiles = new Set<string>();

  for (const f of files) {
    const path = normalisePath(f.path);
    const m = /^system\/([^/]+)\.json$/.exec(path);
    if (!m) continue;
    const vendor = m[1];
    vendors.add(vendor);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(f.text) as Record<string, unknown>;
    } catch (e) {
      parseErrors.push({ path, message: (e as Error).message });
      continue;
    }
    for (const key of PRESET_LISTS) {
      const list = parsed[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list as VendorIndexEntry[]) {
        if (!entry?.sub_path || !entry?.name) continue;
        const target = `system/${vendor}/${normalisePath(entry.sub_path)}`;
        declaredNameByPath.set(target, entry.name);
        vendorRefs.push({
          vendor,
          list: key,
          name: entry.name,
          subPath: entry.sub_path,
          path: target,
          present: byPath.has(target),
        });
      }
    }

    // Printer models. Their files live beside the machine presets but are not
    // presets — the slicer parses them into `vendor_profile.models`
    // (PresetBundle.cpp:4712-4820), and `kindFromPath` would otherwise count
    // every one of them as a machine preset it is not.
    const models = parsed.machine_model_list;
    if (Array.isArray(models)) {
      for (const entry of models as VendorIndexEntry[]) {
        if (!entry?.sub_path || !entry?.name) continue;
        const target = `system/${vendor}/${normalisePath(entry.sub_path)}`;
        const file = byPath.get(target);
        vendorRefs.push({
          vendor,
          list: 'machine_model_list',
          name: entry.name,
          subPath: entry.sub_path,
          path: target,
          present: file !== undefined,
        });
        modelFiles.add(target);
        vendorModels.push({
          vendor,
          id: entry.name,
          path: target,
          present: file !== undefined,
          variants: file ? readVariants(file.text) : [],
          defaultMaterials: file ? readList(file.text, 'default_materials') : [],
        });
      }
    }
  }

  for (const f of files) {
    const path = normalisePath(f.path);
    if (!path.endsWith('.json')) continue;
    // Vendor indexes are not presets, and neither are printer model files.
    if (/^system\/[^/]+\.json$/.test(path)) continue;
    if (modelFiles.has(path)) continue;
    const isSystem = path.startsWith('system/');
    const isUser = path.startsWith('user/');
    if (!isSystem && !isUser) continue;

    let raw: RawPreset;
    try {
      raw = JSON.parse(f.text) as RawPreset;
    } catch (e) {
      parseErrors.push({ path, message: (e as Error).message });
      continue;
    }

    const kind = kindFromPath(path);
    if (!kind) continue;

    const vendor = isSystem ? path.split('/')[1] : undefined;
    const name =
      (typeof raw.name === 'string' && raw.name) ||
      declaredNameByPath.get(path) ||
      path.split('/').pop()!.replace(/\.json$/, '');

    const origin = isSystem ? 'system' : 'user';
    const inheritsRaw = raw.inherits;
    const inherits = typeof inheritsRaw === 'string' && inheritsRaw !== '' ? inheritsRaw : undefined;

    // user/<profile>/... — and anything under `_local/` is a sync snapshot.
    const segments = path.split('/');
    const profile = isUser ? segments[1] : undefined;
    const scope: PresetScope = !isUser
      ? 'active'
      : segments.includes('_local')
        ? 'snapshot'
        : profile === activeProfile
          ? 'active'
          : 'inactive-profile';

    presets.push({
      // The path is the only thing guaranteed unique. Names are not: the local
      // and cloud profiles each hold their own "jon ABS", and three separate
      // files claim the name "ABS fast". Keying by name collapsed those into one
      // row that could not be told apart or opened separately.
      id: path,
      name,
      kind,
      origin,
      path,
      vendor,
      profile,
      scope,
      isCustomRoot: isUser && segments.includes('base'),
      // Decided once, here, rather than re-derived at each place that cares — the
      // `Template` exception is easy to drop in a refactor, and it was already
      // written out twice before this became a field.
      instantiable: raw.instantiation !== 'false' || vendor === TEMPLATE_VENDOR,
      inherits,
      raw,
    });
  }

  const byId = new Map<string, Preset>();
  const byName = new Map<string, Preset[]>();
  for (const p of presets) {
    byId.set(p.id, p);
    // Snapshots never participate in `inherits` resolution.
    if (p.scope === 'snapshot') continue;
    const list = byName.get(p.name);
    if (list) list.push(p);
    else byName.set(p.name, [p]);
  }

  const active = presets.filter((p) => p.scope === 'active');
  const failedVendors = failedVendorBundles(active, byName, vendorModels, vendorRefs);

  return {
    presets,
    active,
    activeProfile,
    inactiveProfiles: [
      ...new Set(
        presets
          .filter((p) => p.scope === 'inactive-profile' && p.profile)
          .map((p) => p.profile as string),
      ),
    ].sort(),
    byId,
    byName,
    vendors: [...vendors].sort(),
    vendorRefs,
    vendorModels,
    failedVendors,
    notLoaded: notLoadedPresets(active, byName, failedVendors),
    installed: readInstalled(files),
    parseErrors,
  };
}

/** Why the slicer never loads a file that is nonetheless on disk. */
export type NotLoadedReason =
  | 'name-clash'
  | 'bad-version'
  | 'parent-not-loaded'
  | 'bundle-failed';

export interface LoadFailure {
  reason: NotLoadedReason;
  /**
   * For `parent-not-loaded`: the `inherits` value that could not be satisfied.
   * For `bundle-failed`: the `inherits` value that failed the bundle.
   */
  parentName?: string;
  /** For `bundle-failed`: the vendor whose bundle this preset went down with. */
  vendor?: string;
}

/**
 * A vendor bundle that never reaches the app, and the preset that sank it.
 *
 * One violation is enough for all of it, which is why this is per vendor rather
 * than per preset.
 */
/**
 * Which of `parse_subfile`'s guards sank the bundle.
 *
 * Six of them, and every one reaches the same throw. They are named separately
 * because they need six different sentences and six different fixes — "this
 * vendor is gone" is the same consequence but never the same repair.
 */
export type BundleGuard =
  /** `inherits` resolves to nothing in this bundle. PresetBundle.cpp:4913-4917. */
  | 'inherits'
  /** A `machine_model_list` entry whose file cannot be read. :4720-4816. */
  | 'model-file-missing'
  /** A preset entry in a vendor list whose file cannot be read. :4861-4866. */
  | 'preset-file-missing'
  /** A printer preset whose resolved `printer_model` is empty. :4973-4979. */
  | 'printer-model-empty'
  /** …or is not one this vendor declares. :4988-4997. */
  | 'printer-model-undeclared'
  /** A printer preset whose resolved `printer_variant` is empty. :4981-4987. */
  | 'printer-variant-empty'
  /** …or is not one that model's file lists. :4998-5005. */
  | 'printer-variant-undeclared';

export interface VendorBundleFailure {
  vendor: string;
  /** Which guard returned a reason. */
  guard: BundleGuard;
  /** The preset that tripped it. Absent for `model-file-missing`, which is not a preset. */
  presetId?: string;
  presetName?: string;
  /** For `inherits`: the value that could not be found. */
  inherits?: string;
  /** For `inherits`: the vendor that owns a preset by that name, when one exists. */
  ownerVendor?: string;
  /** For the printer guards: the resolved value that failed, empty string when unset. */
  value?: string;
  /** For `model-file-missing`: the `sub_path` the vendor index pointed at. */
  modelPath?: string;
}

/**
 * Vendors whose whole bundle fails to load, and which guard sank it.
 *
 * `parse_subfile` returns a `reason` in six places, and a returned reason is not
 * a skipped preset. Each of the three per-type loops turns it into a throw:
 *
 * ```cpp
 * if (!reason.empty()) {
 *     ++m_errors;
 *     throw ConfigurationError(…);
 * }
 * ```
 * — v2.4.2 PresetBundle.cpp:5123-5129 (process), :5141-5147 (filament),
 *   :5161-5167 (printer)
 *
 * and the vendor is loaded into a **temporary** `PresetBundle` (:2253) that is
 * merged into the app's only when no error came back (:2271-2283). So the throw
 * discards the lot: every preset, and `vendor_profile.models` with them, since the
 * models are emplaced into that same temporary at :4824 before any preset is read.
 *
 * **The log text is misleading and must not be repeated.** Four of these guards
 * log `"… it will be ignored"`, and the comment above them says "These presets are
 * considered not installed" (:4970-4971). Neither is true; the vendor is gone.
 *
 * ## The guards, in the order the loader reaches them
 *
 * Order matters only because a vendor can trip more than one, and the reported
 * guard should be the one that actually fired first:
 *
 *  1. **`model-file-missing`** — the `machine_model_list` files are read before any
 *     preset (:4714-4821). There is no existence check, and the `catch` rethrows
 *     rather than resuming the loop (:4813-4816), so a `sub_path` pointing at
 *     nothing ends the load. (What an unopened stream makes `ifs >> j` throw is a
 *     property of the JSON library rather than a branch here — but every path out
 *     of it leaves `load_vendor_configs_from_json` incomplete, so the vendor is
 *     absent either way. That is what is modelled, and it is the part that is
 *     certain.)
 *  2. **`preset-file-missing`** — the first thing `parse_subfile` does is
 *     `config_src.load_from_json(subfile, …, reason)` (:4861), and that function
 *     catches `ifstream::failure`, `parse_error` and `std::exception` alike,
 *     setting `reason` for every one (Config.cpp:278-291). A `sub_path` in a
 *     `filament_list` / `process_list` / `machine_list` with nothing behind it
 *     therefore returns a reason before the file is even looked at, and the
 *     vendor goes. Unlike guard 1 this needs no inference at all — the catch
 *     chain is exhaustive and right there.
 *  3. **`inherits`** — process loop, then filament, then printer (:4913-4917).
 *  4. **the four printer guards** — empty or undeclared `printer_model` /
 *     `printer_variant` (:4973-5005). Read off the chain: the guard runs after
 *     `config = *default_config; config.apply(config_src)` (:4926-4927), which is
 *     ORCA-19.
 *
 * A preset marked `instantiation: "false"` returns before guards 3 and 4 ever run
 * (:4929-4941), so a base with no `printer_model` is correct rather than broken.
 *
 * **`inherits` stays deliberately narrower than the C++.** Only the `other-vendor`
 * case counts — the name exists, in a bundle this vendor cannot see. A base naming
 * something genuinely absent fails the bundle in the slicer too, but no finding
 * reports that case, and marking a vendor failed with nothing on screen to explain
 * it is worse than leaving it present. The other five guards have findings of their
 * own, which is why they are not narrowed the same way.
 */
export function failedVendorBundles(
  active: Preset[],
  byName: Map<string, Preset[]>,
  vendorModels: VendorModel[] = [],
  vendorRefs: VendorRef[] = [],
): Map<string, VendorBundleFailure> {
  const out = new Map<string, VendorBundleFailure>();
  const fail = (f: VendorBundleFailure) => {
    if (!out.has(f.vendor)) out.set(f.vendor, f);
  };

  // 1. Model files, which are read before any preset of this vendor.
  for (const m of vendorModels) {
    if (!m.present) {
      fail({ vendor: m.vendor, guard: 'model-file-missing', modelPath: m.path, value: m.id });
    }
  }

  // 2. A preset the vendor index lists and the disk does not have.
  for (const r of vendorRefs) {
    if (r.present || r.list === 'machine_model_list') continue;
    fail({ vendor: r.vendor, guard: 'preset-file-missing', presetName: r.name, modelPath: r.path });
  }

  // The variants each vendor ends up declaring, for guard 4. Built from the models
  // that actually parsed — a model with no variants is never registered at all
  // (:4819), so it is not a name a `printer_model` can match.
  const declared = new Map<string, Map<string, string[]>>();
  for (const m of vendorModels) {
    if (!m.present || m.variants.length === 0) continue;
    const byId = declared.get(m.vendor) ?? new Map<string, string[]>();
    byId.set(m.id, m.variants);
    declared.set(m.vendor, byId);
  }

  // Presets, in the loader's own type order. Within a type the order is the vendor
  // index's list order, which we do not model — so where two presets of one type
  // both fail, either is a truthful answer to "what sank this bundle".
  const ORDER: PresetKind[] = ['process', 'filament', 'machine'];
  for (const kind of ORDER) {
    for (const p of active) {
      if (p.origin !== 'system' || !p.vendor || p.kind !== kind) continue;
      if (out.has(p.vendor)) continue;

      // 3. `inherits`, for every type, before anything type-specific.
      if (p.inherits) {
        // Candidates are judged against an empty not-loaded map on purpose: a
        // vendor's `config_maps` is filled during its own load, before any merge,
        // so another vendor losing a name clash cannot change what this one reaches.
        const claimed = (byName.get(p.inherits) ?? []).filter(
          (c) => c.id !== p.id && c.kind === p.kind && c.origin === 'system',
        );
        if (claimed.length > 0 && !claimed.some((c) => inheritsScope(p, c))) {
          fail({
            vendor: p.vendor,
            guard: 'inherits',
            presetId: p.id,
            presetName: p.name,
            inherits: p.inherits,
            ownerVendor: claimed[0].vendor,
          });
          continue;
        }
      }

      // A base is stored for others to inherit and returns before the rest.
      if (!isInstantiable(p)) continue;

      // Guard 5 in the source — an instantiable filament with no `filament_id`
      // (:5071-5078) — is deliberately **not** modelled here. It is real, and it
      // fails the bundle like the rest, but it never fires on a bundle OrcaSlicer
      // itself ships and modelling it would mean every synthetic config in the
      // tests carrying an id that has nothing to do with what it asserts. Split
      // out rather than half-done: ORCA-29.
      if (kind === 'filament') continue;

      // 4. The printer guards, all four, read off the chain.
      if (kind !== 'machine') continue;
      const byId = declared.get(p.vendor);
      // Judged only for a vendor whose model list we can actually see. A vendor
      // with printers and no models at all fails in the slicer too — `it_model ==
      // end()` for every one of them — but that is a config we have not fully
      // read rather than one we have read and found wanting, and inventing a
      // whole-vendor failure out of a partial view is the wrong direction to be
      // wrong in. `vendorIndexFindings` reports the missing list separately, and
      // guard 1 has already fired if the files are merely unreadable.
      if (!byId || byId.size === 0) continue;
      const model = chainValue(byName, p, 'printer_model');
      if (model === '') {
        fail({ vendor: p.vendor, guard: 'printer-model-empty', presetId: p.id, presetName: p.name, value: '' });
        continue;
      }
      if (!byId.has(model)) {
        fail({ vendor: p.vendor, guard: 'printer-model-undeclared', presetId: p.id, presetName: p.name, value: model });
        continue;
      }
      const variant = chainValue(byName, p, 'printer_variant');
      if (variant === '') {
        fail({ vendor: p.vendor, guard: 'printer-variant-empty', presetId: p.id, presetName: p.name, value: '' });
        continue;
      }
      if (!(byId.get(model) ?? []).includes(variant)) {
        fail({ vendor: p.vendor, guard: 'printer-variant-undeclared', presetId: p.id, presetName: p.name, value: variant });
      }
    }
  }

  return out;
}


/**
 * One key's value as `parse_subfile` would see it, walking `inherits` by hand.
 *
 * `resolve()` cannot be used here: this runs inside `buildIndex`, before there is a
 * `ConfigIndex` to resolve against, and `notLoaded` is computed *from* this. That
 * is not merely a workaround — it is the more faithful reading. The guards run on
 * `config = *default_config; config.apply(config_src)` (:4926-4927), where
 * `default_config` came out of the vendor's own `config_maps` as its own load
 * built them. Nothing a later merge decides can reach back into it.
 */
function chainValue(byName: Map<string, Preset[]>, from: Preset, key: string): string {
  const seen = new Set<string>();
  let at: Preset | undefined = from;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    const v = at.raw[key];
    if (v !== undefined) {
      const s = Array.isArray(v) ? String(v[0] ?? '') : String(v);
      if (s.trim() !== '') return s.trim();
    }
    if (!at.inherits) break;
    const parent: Preset | undefined = (byName.get(at.inherits) ?? []).find(
      (c) => c.kind === from.kind && c.origin === 'system' && inheritsScope(at as Preset, c),
    );
    at = parent;
  }
  return '';
}

/**
 * Every active preset the slicer skips, and why.
 *
 * `PresetCollection::load_presets` has three ways to `continue` past a file, and
 * all three leave it on disk and out of the collection. Applied in the slicer's own
 * order, because the order is what decides which reason a file gets:
 *
 *  1. **name clash** — `find_preset(canonical_name)` already answers, so the file is
 *     skipped with "Preset already present, not loading" (Preset.cpp:1617-1620).
 *  2. **`version`** — parsed three lines before the parent lookup, and a failure is
 *     a silent `continue` (Preset.cpp:1653-1655). See `preset-version.ts`.
 *  3. **`inherits`** — a non-empty `inherits` that finds nothing logs "can not find
 *     parent", counts an error and skips the file (Preset.cpp:1686-1691).
 *
 * The third **cascades**: a skipped preset is not in the collection, so anything
 * naming it fails the same way. That is why this is iterated to a fixpoint rather
 * than computed in one pass — the config in ORCA-17 lost three children to one
 * parent, and a single pass would have found none of them.
 *
 * Gates 2 and 3 are **user presets only**. A system preset comes in through
 * `parse_subfile` (PresetBundle.cpp:4836+), which has no version gate at all, and
 * whose unresolvable-`inherits` path fails the *entire vendor bundle* rather than
 * one preset (PresetBundle.cpp:4913-4917). That is **gate 0** here, applied first
 * and per vendor rather than per file — see `failedVendorBundles`. It needs no
 * fixpoint of its own (a vendor's presets are marked in one pass) but it feeds
 * gate 3: a user preset inheriting from a vendor that never arrived is skipped
 * exactly as if the parent's own `version` had failed.
 *
 * **One corner is deliberately not modelled.** Because gate 1 runs first, a file
 * that loses a clash stays lost even if the winner is later skipped by gate 3 — in
 * the slicer the loser would then be read and loaded, since the "already present"
 * check happens per file as the directory is walked. Modelling that needs the
 * directory order the clash rules already refuse to predict (`tieIsArbitrary`), so
 * the two are left layered and this note is the record of it.
 */
export function notLoadedPresets(
  active: Preset[],
  byName: Map<string, Preset[]>,
  failedVendors: Map<string, VendorBundleFailure> = failedVendorBundles(active, byName),
): Map<string, LoadFailure> {
  const out = new Map<string, LoadFailure>();

  // Gate 0, and it is not a gate in `load_presets` at all — it is a whole vendor
  // bundle that never arrives (`failedVendorBundles`). First, because a preset in
  // a bundle that was never merged cannot win a name clash against one that was.
  for (const p of active) {
    if (p.origin !== 'system' || !p.vendor) continue;
    const failure = failedVendors.get(p.vendor);
    if (!failure) continue;
    out.set(p.id, {
      reason: 'bundle-failed',
      vendor: p.vendor,
      parentName: failure.inherits,
    });
  }

  // Gate 2 next, because it is the only intrinsic one — it depends on nothing but
  // the file itself — and a preset it drops was never in the collection for gate 1
  // to clash with.
  for (const p of active) {
    if (p.origin === 'user' && !versionLoads(p.raw)) out.set(p.id, { reason: 'bad-version' });
  }

  // Gate 1, over what is left.
  const groups = new Map<string, Preset[]>();
  for (const p of active) {
    if (out.has(p.id)) continue;
    const scope = clashScope(p);
    if (scope === undefined) continue;
    groups.set(scope, [...(groups.get(scope) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const loser of loadOrder(group).slice(1)) out.set(loser.id, { reason: 'name-clash' });
  }

  // Gate 3, to a fixpoint. Each round can only add, and there are finitely many
  // presets, so this terminates; a cycle of presets inheriting each other resolves
  // fine here and is reported as `circular-inherits` elsewhere.
  for (;;) {
    let changed = false;
    for (const p of active) {
      if (p.origin !== 'user' || out.has(p.id) || !p.inherits) continue;
      if (firstLoadable(byName, out, p, p.kind, p.inherits, 'inherits').target) continue;
      out.set(p.id, { reason: 'parent-not-loaded', parentName: p.inherits });
      changed = true;
    }
    if (!changed) break;
  }

  return out;
}

/**
 * The claimants of `name` the slicer could reach from `from`, in load order, and
 * which of them it would actually use.
 *
 * Shared by `classifyReference` and the loadability fixpoint so the two cannot
 * drift: "which preset does this name mean" has to be one answer.
 *
 * `target` is the first claimant in load order that is **loaded**, not simply the
 * first — a file the slicer skipped cannot satisfy a reference, and the next
 * claimant is then the one it finds.
 */
function firstLoadable(
  byName: Map<string, Preset[]>,
  notLoaded: Map<string, LoadFailure>,
  from: Preset,
  targetKind: PresetKind,
  name: string,
  via: 'inherits' | 'other',
): { inCollection: Preset[]; ordered: Preset[]; target?: Preset } {
  const claimed = (byName.get(name) ?? []).filter((c) => c.id !== from.id);
  const sameKind = claimed.filter((c) => c.kind === targetKind);
  // One `PresetCollection` holds the system bundles plus exactly one user folder
  // (PresetBundle.cpp:528), so a user preset in another profile is not a candidate
  // however right its name looks.
  const inCollection = sameKind.filter((c) => c.origin === 'system' || c.profile === from.profile);
  // Three filters, and the order is the order the reasons get more specific in:
  // in the collection at all, then reachable from this vendor's bundle, then
  // actually loaded. A candidate that fails an earlier one should be described by
  // that failure, not by a later one it never got to.
  const inScope = via === 'inherits' ? inCollection.filter((c) => inheritsScope(from, c)) : inCollection;
  const ordered = loadOrder(inScope);
  return { inCollection, ordered, target: ordered.find((c) => !notLoaded.has(c.id)) };
}

/**
 * Why a preset reference resolved, or why it did not.
 *
 * A preset names other presets by name — `inherits`, `compatible_printers`,
 * `compatible_prints`, `default_print_profile`, `default_filament_profile` — and
 * the slicer resolves each silently. "Not found" is the least useful thing we
 * can say about a failure, because the four ways it fails need four different
 * fixes:
 *
 *  - `resolved`         one loaded preset claims the name.
 *  - `shadowed`         it resolves, but other files claim that name too and are
 *                       never loaded ("Preset already present, not loading",
 *                       Preset.cpp:1619). The reference is ambiguous on disk.
 *  - `wrong-kind`       a preset of another type claims the name. Resolution
 *                       happens inside one `PresetCollection` (`find_preset2`,
 *                       Preset.cpp:3229) and a collection holds a single type,
 *                       so this does **not** resolve — it only looks like it
 *                       should.
 *  - `unloaded-profile` it exists, in a user folder the slicer does not load
 *                       (PresetBundle.cpp:528). Editing that file changes
 *                       nothing here.
 *  - `other-vendor`     **`inherits` only.** It exists, in another vendor's
 *                       bundle, which this vendor's load cannot see. See
 *                       `inheritsScope`.
 *  - `same-directory`   **`inherits` only.** It exists, in the same directory as
 *                       the preset naming it — so it is loaded in the *same pass*
 *                       and is not in the collection yet when the lookup runs.
 *                       See `inheritsScope`.
 *  - `not-loaded`       it exists, in the folder the slicer *does* load, is
 *                       reachable, and the slicer still skipped it — a `version`
 *                       that does not parse, or its own `inherits` failing. This is
 *                       the one that reads as "the file is right there", and
 *                       `index.notLoaded` says which gate it hit.
 *  - `absent`           nothing loadable claims the name.
 */
export type ReferenceReason =
  | 'resolved'
  | 'shadowed'
  | 'wrong-kind'
  | 'unloaded-profile'
  | 'other-vendor'
  | 'same-directory'
  | 'not-loaded'
  | 'absent';

export interface ReferenceResolution {
  reason: ReferenceReason;
  /** The preset the slicer would use. Absent unless `resolved` or `shadowed`. */
  target?: Preset;
  /**
   * The other files claiming the name. For `shadowed` these are dead files; for
   * `wrong-kind` and `unloaded-profile` they are what exists instead.
   */
  others: Preset[];
  /** True when `target` beat `others` only on directory order — see `loadOrder`. */
  arbitrary: boolean;
  /**
   * Set when the name only resolved through the slicer's `Generic` rewrite —
   * see `genericAlias`. Holds the name that actually matched.
   */
  viaAlias?: string;
}

/**
 * `find_preset2(name, auto_match = true)` — which is what every `inherits` call
 * site passes (Preset.cpp:1674, :1947, :2284, :2703, :2967) — retries a name
 * containing `Generic` as `Generic <material> @System` against the Orca filament
 * library when the literal name is not found (Preset.cpp:3229-3245).
 *
 * Modelled because not modelling it invents a broken parent: a preset inheriting
 * `Generic PLA` resolves in the slicer and would be reported here as dangling.
 */
export function genericAlias(name: string): string | undefined {
  if (!name.includes('Generic')) return undefined;
  const re = /^(?:.*?\b(?:\w+_)?)(Generic)\b\s+([^@]+?)\s*(?:@.*)?$/;
  if (!re.test(name)) return undefined;
  const alias = name.replace(re, 'Generic $2 @System');
  return alias === name ? undefined : alias;
}

/**
 * Which preset an `inherits` may name, as far as the *bundle* is concerned.
 *
 * This is the one reference key that is not resolved against the merged
 * collections, and the difference is not cosmetic — a system preset whose parent
 * cannot be found does not load, and takes its vendor's whole bundle with it.
 *
 * `parse_subfile` resolves `inherits` against, in order:
 *
 *  1. `config_maps` — **local to the vendor currently loading**, and cleared per
 *     preset type (PresetBundle.cpp:4886-4888, :5117-5155).
 *  2. `base_bundle->m_config_maps` — retained for **`OrcaFilamentLibrary` only**
 *     (PresetBundle.cpp:4889-4897, and the `if (is_orca_lib)` assignment at
 *     :5147-5151).
 *
 * and if neither has the name it returns `"Can not find inherits: " + inherits`
 * (PresetBundle.cpp:4913-4916), which the caller raises as a `ConfigurationError`
 * for that vendor's entire bundle (:5121-5130).
 *
 * The source says why that is safe to model as a hard boundary:
 *
 * > Separate ORCA_FILAMENT_LIBRARY from other vendors. It must be loaded first
 * > because other vendors' filaments may inherit from it via the `base_bundle`
 * > lookup in parse_subfile. **The remaining vendors are independent (no
 * > cross-vendor inheritance)** and can be loaded in parallel.
 * > — PresetBundle.cpp:2216-2219
 *
 * Two consequences that are easy to get wrong in the generous direction:
 *
 *  - The library exemption is **filaments only**. `m_config_maps` is assigned
 *    straight after the filament loop and the maps are cleared per type
 *    (:5133-5151), so the library can supply a filament base and nothing else —
 *    a machine base has to come from the vendor's own bundle.
 *  - The library itself is loaded with **no `base_bundle`** (:2231-2241), so its
 *    presets can only inherit within it.
 *
 * A **user** preset is not bound by the vendor rule — it inherits inside its own
 * `PresetCollection`, which holds every vendor's presets after the merge — but it
 * has a boundary of its own, in a different dimension: **the directory**.
 *
 * `load_presets` collects into a *local* deque and merges only after the whole
 * directory has been walked:
 *
 * ```cpp
 * // Store the loaded presets into a new vector, otherwise the binary search for
 * // already existing presets would be broken.
 * std::deque<Preset> presets_loaded;
 * …
 * if (presets_loaded.size() > 0)
 *     m_presets.insert(m_presets.end(), …);
 * ```
 * — v2.4.2 Preset.cpp:1609, :1764-1765
 *
 * and the lookup is a binary search over `m_presets` (`find_preset2` → `find_preset`
 * → `find_preset_internal`, Preset.cpp:3211-3213, :3229). So **nothing loaded in
 * the current pass is visible to it.** An `inherits` can only reach an *earlier*
 * pass: the system bundles, merged before any user folder is read, or `base/`,
 * which is a separate completed recursive call made first (Preset.cpp:1583-1586).
 *
 * This is the missing half of the `base/` rule we already model. `loadOrder` ranks
 * `base/` ahead of the folder proper; the reason that ranking *works* is that
 * "first" means "in another pass", and the same fact makes a same-pass reference
 * impossible.
 *
 * There are exactly two user passes per kind, because `directory_iterator` is not
 * recursive (Preset.cpp:1608) and the only recursion is the one explicit `base/`
 * call: `<kind>/base/`, then `<kind>/`. And `inherits` is same-kind only, so the
 * ordering is total — which is why this is `isCustomRoot` rather than a directory
 * comparison. Comparing directories would let `<kind>/base/X` inherit `<kind>/Y`,
 * a *later* pass, and a config could then describe a resolvable cycle the slicer
 * cannot have.
 *
 * Which is the sharp end of this rule: **a user-to-user inheritance loop is
 * impossible.** Every edge must go from a later pass to an earlier one, so no
 * chain of them can come back. The `circular` guard in `resolve` stays, because
 * it protects this code rather than describing a config.
 */
function inheritsScope(from: Preset, candidate: Preset): boolean {
  if (from.origin !== 'system') {
    // A system candidate came from a bundle merged long before any user folder was
    // read, so it is always reachable.
    if (candidate.origin !== 'user') return true;
    // Both user, and `firstLoadable` has already confined them to one profile. The
    // only user pass that completes before another is `base/` before its folder.
    return candidate.isCustomRoot && !from.isCustomRoot;
  }
  if (candidate.origin !== 'system') return false;
  if (candidate.vendor === from.vendor) return true;
  return (
    candidate.vendor === FILAMENT_LIBRARY_VENDOR &&
    from.vendor !== FILAMENT_LIBRARY_VENDOR &&
    candidate.kind === 'filament'
  );
}

/**
 * Resolve a reference from `from` to a preset of `targetKind` called `name`, and
 * say why the answer is what it is.
 *
 * Candidates come from `byName`, which excludes `_local/` sync snapshots: the
 * slicer never loads them, so one claiming a name does not make the name exist.
 *
 * `via` is the key being resolved, and it matters for exactly one thing: only
 * `inherits` is resolved per vendor bundle. `compatible_printers` and the
 * `default_*` keys are matched against the merged collections much later, so
 * applying the bundle boundary to them would invent faults — a vendor filament
 * naming another vendor's printer is ordinary. Defaults to the permissive
 * reading, so a new call site cannot silently acquire the stricter rule.
 */
export function classifyReference(
  index: ConfigIndex,
  from: Preset,
  targetKind: PresetKind,
  name: string,
  via: 'inherits' | 'other' = 'other',
): ReferenceResolution {
  const claimed = (index.byName.get(name) ?? []).filter((c) => c.id !== from.id);
  if (claimed.length === 0) {
    const alias = genericAlias(name);
    if (alias) {
      const viaAlias = classifyReference(index, from, targetKind, alias, via);
      if (viaAlias.target) return { ...viaAlias, viaAlias: alias };
    }
    return { reason: 'absent', others: [], arbitrary: false };
  }

  const sameKind = claimed.filter((c) => c.kind === targetKind);
  if (sameKind.length === 0) return { reason: 'wrong-kind', others: claimed, arbitrary: false };

  const { inCollection, ordered, target } = firstLoadable(
    index.byName,
    index.notLoaded,
    from,
    targetKind,
    name,
    via,
  );
  if (inCollection.length === 0) {
    return { reason: 'unloaded-profile', others: sameKind, arbitrary: false };
  }

  // In the collection, but not in a *pass* this preset's `inherits` can reach.
  // Only `inherits` narrows this far — see `inheritsScope` — and the two ways it
  // narrows want different sentences, so they get different reasons. Which one
  // applies is decided by `from`, not by the candidates: a user preset is only
  // ever filtered by the directory rule, a system one only by the bundle rule.
  if (ordered.length === 0) {
    return {
      reason: from.origin === 'user' ? 'same-directory' : 'other-vendor',
      others: inCollection,
      arbitrary: false,
    };
  }

  // Every claimant the slicer could have reached, and it loaded none of them. The
  // name is unsatisfiable even though the file is sitting in the loaded folder.
  if (!target) return { reason: 'not-loaded', others: ordered, arbitrary: false };

  const others = ordered.filter((c) => c.id !== target.id);
  return others.length > 0
    ? { reason: 'shadowed', target, others, arbitrary: tieIsArbitrary(ordered) }
    : { reason: 'resolved', target, others: [], arbitrary: false };
}

/**
 * The preset the slicer would actually use for an `inherits` of `name`.
 *
 * Load order decides, and it is: system bundles, then the user folder's
 * `base/` subdirectory ("Load custom roots first", Preset.cpp:1583), then the
 * folder itself. The first one loaded under a given name wins; every later one
 * is skipped outright ("Preset already present, not loading", Preset.cpp:1619).
 */
export function lookupParent(index: ConfigIndex, name: string, from: Preset): Preset | undefined {
  return classifyReference(index, from, from.kind, name, 'inherits').target;
}

/**
 * Presets that lose a name clash and are therefore never loaded at all.
 *
 * Returned in load order, so the first is the winner and the rest are dead
 * files. Same rules as `lookupParent`.
 *
 * The ranking (system, then `base/`, then the rest) is what the slicer
 * guarantees. Within one rank it iterates a directory, and `directory_iterator`
 * order is filesystem-dependent — so the path sort here is a deterministic
 * stand-in, not a prediction. `tieIsArbitrary` says when that distinction
 * matters, so a finding can avoid claiming a winner it cannot know.
 */
export function loadOrder(presets: Preset[]): Preset[] {
  return [...presets].sort((a, b) => loadRank(a) - loadRank(b) || a.path.localeCompare(b.path, 'en'));
}

function loadRank(p: Preset): number {
  if (p.origin === 'system') {
    // The filament library is merged into the bundle before any other vendor, so
    // it wins outright; every other vendor's order comes from `directory_iterator`
    // over `system/*.json` and is therefore not predictable.
    return p.vendor === FILAMENT_LIBRARY_VENDOR ? 0 : 1;
  }
  return p.isCustomRoot ? 2 : 3;
}

/**
 * The vendor whose bundle is loaded first, synchronously, before any other is
 * merged in (PresetBundle.cpp:2231-2241). It therefore wins every name clash.
 */
export const FILAMENT_LIBRARY_VENDOR = 'OrcaFilamentLibrary';

/**
 * The vendor exempted from the `instantiation: "false"` rule, in the loader's own
 * guard: `if (instantiation == "false" && "Template" != vendor_name)`
 * (PresetBundle.cpp:4929). Its non-instantiable presets *are* constructed and do
 * enter the collection.
 */
export const TEMPLATE_VENDOR = 'Template';

/**
 * Is this preset one the slicer puts in a collection at all?
 *
 * Reads `Preset.instantiable`, which `buildIndex` decides — see the field's own
 * documentation for why, and for the `Template` exception. Kept as a function
 * because "in a collection" is the question callers are asking, and because the
 * config map a non-instantiable preset goes into instead is **local to one
 * vendor's load** and cleared per preset type (PresetBundle.cpp:5133-5151), which
 * is why two vendors shipping `fdm_process_common` is not a clash.
 */
export function isInstantiable(p: Preset): boolean {
  return p.instantiable;
}

/**
 * How many of these are presets a person could actually pick.
 *
 * The counting rule for anywhere the number means "presets you could use": the
 * overview figures, the tab badge. A vendor base inflates that number by a large
 * fraction on a config with several vendors installed, and it is not a preset.
 */
export function selectableCount(presets: Preset[]): number {
  return presets.filter((p) => p.instantiable).length;
}

/**
 * The scope a name has to be unique inside.
 *
 * For a **user** preset that is one profile: the same name in the live and the
 * cloud profile is how sync works, not a fault, and the two are never loaded
 * together anyway (PresetBundle.cpp:528).
 *
 * For a **system** preset it is every vendor at once. Each vendor loads into its
 * own bundle, but the bundles are then merged into one collection per type, and
 * `PresetCollection::merge_presets` keeps whatever is already there and discards
 * the incoming preset of the same name — the caller logs "Found duplicated preset:
 * X in vendor: Y" (Preset.cpp:/merge_presets/, PresetBundle.cpp:2283-2294). So a
 * name claimed by two vendors means one of those files is dead.
 *
 * Returns `undefined` for a preset that never enters a collection, since it cannot
 * clash with anything.
 */
export function clashScope(p: Preset): string | undefined {
  if (!isInstantiable(p)) return undefined;
  return p.origin === 'system'
    ? `system:${p.kind}:${p.name}`
    : `user:${p.profile ?? ''}:${p.kind}:${p.name}`;
}

/**
 * Every preset the slicer never loads because another file claimed its name
 * first.
 *
 * Grouped the way the slicer's collections are — the system bundles plus one user
 * folder — so a name existing in two *profiles* is not a clash, and a name
 * claimed twice inside one is. Everything after the first in load order is a file
 * on disk with no effect on anything, which is why callers exclude these before
 * saying anything else about them: telling someone a dead file is a detached copy
 * sends them to fix a file the slicer has never read.
 *
 * Read off `index.notLoaded` rather than recomputed, so the clash rule has one
 * implementation. `notLoadedIds` is the wider set most callers actually want — a
 * file skipped for its `version` is just as dead as one that lost a clash.
 */
export function shadowedIds(index: ConfigIndex): Set<string> {
  return new Set(
    [...index.notLoaded].filter(([, f]) => f.reason === 'name-clash').map(([id]) => id),
  );
}

/** Every active preset the slicer skips, whatever the reason. */
export function notLoadedIds(index: ConfigIndex): Set<string> {
  return new Set(index.notLoaded.keys());
}

/**
 * The printer models the app actually ends up holding.
 *
 * `vendorModels` is what the vendor indexes *declare*. A model is emplaced into
 * the vendor's temporary bundle (PresetBundle.cpp:4824) and only reaches
 * `this->vendors` through the merge (:2422), which a failed bundle never gets
 * to — so a model whose vendor is in `failedVendors` is declared and absent, the
 * same way that vendor's presets are.
 */
export function loadedVendorModels(index: ConfigIndex): VendorModel[] {
  return index.vendorModels.filter((m) => !index.failedVendors.has(m.vendor));
}

/**
 * Presets grouped by the scope their name has to be unique in.
 *
 * A preset the slicer drops for its `version` is not in the collection, so it
 * cannot clash with anything — excluded here for the same reason `clashScope`
 * excludes a non-instantiable base.
 */
export function clashGroups(index: ConfigIndex): Map<string, Preset[]> {
  const groups = new Map<string, Preset[]>();
  for (const p of index.active) {
    const reason = index.notLoaded.get(p.id)?.reason;
    // Neither of these was ever in a collection to clash with: a `bad-version`
    // file is dropped before it is constructed, and a `bundle-failed` preset
    // belongs to a bundle that `merge_presets` is never called with at all.
    if (reason === 'bad-version' || reason === 'bundle-failed') continue;
    const k = clashScope(p);
    if (k === undefined) continue;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return groups;
}



/** True when the top two candidates share a rank, so which one wins is luck. */
export function tieIsArbitrary(presets: Preset[]): boolean {
  const ordered = loadOrder(presets);
  return ordered.length > 1 && loadRank(ordered[0]) === loadRank(ordered[1]);
}
