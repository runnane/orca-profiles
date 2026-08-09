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
  /** Files that were present but could not be parsed. */
  parseErrors: { path: string; message: string }[];
}

const KINDS: PresetKind[] = ['filament', 'process', 'machine'];

function kindFromPath(path: string): PresetKind | undefined {
  const parts = path.split('/');
  return KINDS.find((k) => parts.includes(k));
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
    for (const key of ['process_list', 'filament_list', 'machine_list'] as const) {
      const list = parsed[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list as VendorIndexEntry[]) {
        if (!entry?.sub_path || !entry?.name) continue;
        declaredNameByPath.set(`system/${vendor}/${normalisePath(entry.sub_path)}`, entry.name);
      }
    }
  }

  for (const f of files) {
    const path = normalisePath(f.path);
    if (!path.endsWith('.json')) continue;
    // Vendor indexes are not presets.
    if (/^system\/[^/]+\.json$/.test(path)) continue;
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
    parseErrors,
  };
}

/**
 * Every preset that could satisfy an `inherits` of `name`.
 *
 * `inherits` is resolved by name inside one `PresetCollection`
 * (`find_preset2(inherits_value)`, Preset.cpp:1734), and a collection holds the
 * system bundles plus **one** user folder. So a preset can only ever inherit
 * from a system preset or from a user preset in its own profile — never across
 * profiles, because the two are never loaded together.
 */
export function parentCandidates(index: ConfigIndex, name: string, from: Preset): Preset[] {
  const candidates = index.byName.get(name);
  if (!candidates || candidates.length === 0) return [];
  const sameKind = candidates.filter((c) => c.kind === from.kind);
  const pool = sameKind.length > 0 ? sameKind : candidates;
  return pool.filter(
    (c) => c.id !== from.id && (c.origin === 'system' || c.profile === from.profile),
  );
}

/**
 * The candidate the slicer would actually use.
 *
 * Load order decides, and it is: system bundles, then the user folder's
 * `base/` subdirectory ("Load custom roots first", Preset.cpp:1583), then the
 * folder itself. The first one loaded under a given name wins; every later one
 * is skipped outright ("Preset already present, not loading", Preset.cpp:1619).
 */
export function lookupParent(index: ConfigIndex, name: string, from: Preset): Preset | undefined {
  const pool = parentCandidates(index, name, from);
  if (pool.length === 0) return undefined;
  return (
    pool.find((c) => c.origin === 'system') ??
    pool.find((c) => c.isCustomRoot) ??
    pool[0]
  );
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
  return p.origin === 'system' ? 0 : p.isCustomRoot ? 1 : 2;
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
  const groups = new Map<string, Preset[]>();
  for (const p of index.active) {
    const k = `${p.origin}:${p.profile ?? p.vendor ?? ''}:${p.kind}:${p.name}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const loser of loadOrder(group).slice(1)) out.add(loser.id);
  }
  return out;
}

/** True when the top two candidates share a rank, so which one wins is luck. */
export function tieIsArbitrary(presets: Preset[]): boolean {
  const ordered = loadOrder(presets);
  return ordered.length > 1 && loadRank(ordered[0]) === loadRank(ordered[1]);
}
