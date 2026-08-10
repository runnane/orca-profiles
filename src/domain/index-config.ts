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
 *
 * The vendor index matters too: `inherits` names a preset, it does not give a
 * path, so resolving a chain requires a name -> file map built from these.
 */

import { readInstalled, type InstalledState } from './installed';
import { parseQuotedList } from './normalize';
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

  return {
    presets,
    active: presets.filter((p) => p.scope === 'active'),
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
    installed: readInstalled(files),
    parseErrors,
  };
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
 *  - `absent`           nothing loadable claims the name.
 */
export type ReferenceReason =
  | 'resolved'
  | 'shadowed'
  | 'wrong-kind'
  | 'unloaded-profile'
  | 'other-vendor'
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
 * A **user** preset is unaffected: it inherits inside its own `PresetCollection`,
 * which holds every vendor's presets after the merge.
 */
function inheritsScope(from: Preset, candidate: Preset): boolean {
  if (from.origin !== 'system') return true;
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

  // One `PresetCollection` holds the system bundles plus exactly one user folder
  // (PresetBundle.cpp:528), so a user preset in another profile is not a
  // candidate however right its name looks.
  const loadable = sameKind.filter((c) => c.origin === 'system' || c.profile === from.profile);
  if (loadable.length === 0) {
    return { reason: 'unloaded-profile', others: sameKind, arbitrary: false };
  }

  // The vendor-bundle boundary, checked after the collection one so that the
  // reason a reference failed is the most specific true thing about it.
  const inScope = via === 'inherits' ? loadable.filter((c) => inheritsScope(from, c)) : loadable;
  if (inScope.length === 0) {
    return { reason: 'other-vendor', others: loadable, arbitrary: false };
  }

  const [target, ...others] = loadOrder(inScope);
  return others.length > 0
    ? { reason: 'shadowed', target, others, arbitrary: tieIsArbitrary(inScope) }
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
 * Is this preset one the slicer puts in a collection at all?
 *
 * A vendor-bundle preset marked `instantiation: "false"` is not: the loader stores
 * it in a per-bundle config map for others to inherit and returns before
 * constructing a `Preset` (PresetBundle.cpp:4929-4941). That map is **local to one
 * vendor's load** and cleared per preset type (:5134), which is why two vendors
 * shipping `fdm_process_common` is not a clash — the source spells it out: "The
 * remaining vendors are independent (no cross-vendor inheritance)".
 *
 * The `Template` vendor is the documented exception in the same guard.
 *
 * User presets never carry the key, so they are always instantiable.
 */
export function isInstantiable(p: Preset): boolean {
  return p.raw.instantiation !== 'false' || p.vendor === 'Template';
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
 */
export function shadowedIds(index: ConfigIndex): Set<string> {
  const out = new Set<string>();
  for (const group of clashGroups(index).values()) {
    if (group.length < 2) continue;
    for (const loser of loadOrder(group).slice(1)) out.add(loser.id);
  }
  return out;
}

/** Presets grouped by the scope their name has to be unique in. */
export function clashGroups(index: ConfigIndex): Map<string, Preset[]> {
  const groups = new Map<string, Preset[]>();
  for (const p of index.active) {
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
