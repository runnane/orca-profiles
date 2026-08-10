/**
 * The filament list arranged the way OrcaSlicer's dropdown arranges it.
 *
 * The verdicts matched the slicer before this module and the *list* still could
 * not be read against it: one flat alphabetical column of `Generic PLA @System`
 * against three sections, a `Generic >` submenu and labels reading `Generic PLA`.
 * Checking our answer meant sorting eighteen rows by eye.
 *
 * So the grouping is modelled from the combo box that draws it,
 * `PlaterPresetComboBox::update` (v2.4.2 slic3r/GUI/PresetComboBoxes.cpp), rather
 * than invented to look similar:
 *
 *  - **Three groups, in this order** — `User presets`, `System presets`,
 *    `Unsupported presets` (:1421-1430). Membership is `!is_compatible` →
 *    unsupported, else system-or-default → system, else user (:1231-1240).
 *  - **System presets are sub-grouped by `filament_vendor`.** `groupByGroup` is
 *    false for exactly that group (:1324), so the submenu label falls through to
 *    the preset's vendor (:1375-1377) — read from
 *    `config.option("filament_vendor")` with `"Bambu Lab"` rewritten to `"Bambu"`
 *    (:1222-1224). That is the `Generic >` submenu on screen.
 *  - **Unsupported presets share one submenu**, labelled `Unsupported` (:1430).
 *  - **User presets are not sub-grouped** by default (:1414-1422).
 *  - **The label is the alias**: `Preset::label(false)` (:1098-1100), i.e.
 *    `alias.empty() ? name : alias`.
 *
 * Two places where being faithful means *not* copying:
 *
 *  - **The dirty marker cannot be known.** `Preset::label` prefixes `* ` when
 *    `is_dirty`, which means "edited in the slicer and not saved" and lives in
 *    memory. A config on disk cannot say it, so this never renders one — the
 *    slicer showing `* Jon PLA` where we show `Jon PLA` is correct.
 *  - **`undetermined` and `not installed` are ours.** The slicer has no such
 *    buckets: a condition it cannot evaluate does not exist, and an uninstalled
 *    preset is simply absent from the list. Folding either into `Unsupported`
 *    would claim the slicer hides them, so both stay separate and are marked as
 *    this app's own.
 */

import { offering, type Compatibility } from './compatibility';
import type { ConfigIndex } from './index-config';
import { chainLookup } from './resolve';
import type { Preset } from './types';

/**
 * Sort keys, hardcoded in the combo box rather than read from anywhere
 * (:1313-1316). They are copied verbatim because they *are* the order: without
 * `first_types` the `Generic` submenu comes out alphabetical, and the slicer's
 * reads PLA, PETG, ABS, TPU and then the rest.
 */
const FILAMENT_ORDER = [
  'Bambu PLA Basic', 'Bambu PLA Matte', 'Bambu PETG HF', 'Bambu ABS', 'Bambu PLA Silk',
  'Bambu PLA-CF', 'Bambu PLA Galaxy', 'Bambu PLA Metal', 'Bambu PLA Marble', 'Bambu PETG-CF',
  'Bambu PETG Translucent', 'Bambu ABS-GF',
];
/** `{"", "Bambu", "Generic"}` — the empty entry is for non-system presets. */
const FIRST_VENDORS = ['', 'Bambu', 'Generic'];
const FIRST_TYPES = ['PLA', 'PETG', 'ABS', 'TPU'];

export type SlicerGroup = 'user' | 'system' | 'unsupported' | 'undetermined' | 'not-installed';

export interface PresentedPreset {
  compatibility: Compatibility;
  /** What the dropdown shows: the alias, or the name when there is none. */
  label: string;
  /** The preset's own name. Kept always — it is what identifies the file. */
  name: string;
  /** `filament_vendor`, normalised as the combo box normalises it. */
  vendor: string;
  /** `filament_type`, which only affects ordering. */
  type: string;
}

export interface PresetGroup {
  group: SlicerGroup;
  /** The heading, in the slicer's own words where it has one. */
  title: string;
  /** True for a group the slicer does not have — see the module note. */
  ours: boolean;
  /** One entry with an empty title when the group is not sub-grouped. */
  subgroups: { title: string; items: PresentedPreset[] }[];
}

/**
 * The alias the loader ends up with: the stated one, else the name up to the
 * first `@` with trailing space removed, else the whole name
 * (PresetBundle.cpp:5086-5099).
 *
 * Off the chain, because `alias` is a config option and so inherits. Note this is
 * *not* the same derivation as the `renamed_from` one in `compatibility.ts`,
 * which keeps the space before the `@` because it concatenates before trimming.
 * One character apart, and they are different rules.
 */
export function presetAlias(index: ConfigIndex, p: Preset): string {
  const stated = chainLookup(index, p)('alias')?.value;
  if (typeof stated === 'string' && stated !== '') return stated;
  const at = p.name.indexOf('@');
  if (at < 0) return p.name;
  const derived = p.name.slice(0, at).replace(/\s+$/, '');
  return derived === '' ? p.name : derived;
}

/** `filament_vendor`, with the one rewrite the combo box applies (:1222-1224). */
export function filamentVendor(index: ConfigIndex, p: Preset): string {
  const v = firstString(chainLookup(index, p)('filament_vendor'));
  return v === 'Bambu Lab' ? 'Bambu' : v;
}

function firstString(found: { value: unknown } | undefined): string {
  const v = found?.value;
  if (Array.isArray(v)) return String(v[0] ?? '');
  return typeof v === 'string' ? v : '';
}

/** Which of the dropdown's sections this preset lands in. */
export function groupOf(c: Compatibility): SlicerGroup {
  switch (offering(c)) {
    // Not in the list at all, so not in any of the slicer's three groups.
    case 'not-installed':
      return 'not-installed';
    // We do not know which bucket the slicer would use, so we do not pick one.
    case 'undetermined':
      return 'undetermined';
    case 'excluded':
      return 'unsupported';
    default:
      return c.preset.origin === 'system' ? 'system' : 'user';
  }
}

const TITLES: Record<SlicerGroup, { title: string; ours: boolean }> = {
  user: { title: 'User presets', ours: false },
  system: { title: 'System presets', ours: false },
  unsupported: { title: 'Unsupported presets', ours: false },
  undetermined: { title: 'Undetermined — we do not evaluate the condition that decides these', ours: true },
  'not-installed': { title: 'Not installed — not in OrcaSlicer’s list at all', ours: true },
};

/** The order the combo box appends them in, with ours after the slicer's. */
const ORDER: SlicerGroup[] = ['user', 'system', 'unsupported', 'undetermined', 'not-installed'];

/**
 * Arrange one kind's verdicts into the dropdown's groups.
 *
 * `subGroupByVendor` is off for processes on purpose: the by-vendor and by-type
 * grouping is filament-only, because the attributes it reads are empty for every
 * other preset type (:1418-1422).
 */
export function groupLikeSlicer(index: ConfigIndex, list: Compatibility[]): PresetGroup[] {
  const presented = list.map((c) => ({
    compatibility: c,
    label: presetAlias(index, c.preset),
    name: c.preset.name,
    vendor: c.preset.kind === 'filament' ? filamentVendor(index, c.preset) : '',
    type: c.preset.kind === 'filament' ? firstString(chainLookup(index, c.preset)('filament_type')) : '',
  }));

  const out: PresetGroup[] = [];
  for (const group of ORDER) {
    const items = presented.filter((p) => groupOf(p.compatibility) === group);
    if (items.length === 0) continue;
    const byVendor = group === 'system' && items.every((p) => p.compatibility.preset.kind === 'filament');
    out.push({
      group,
      ...TITLES[group],
      subgroups: byVendor ? vendorSubgroups(items) : [{ title: '', items: sortFor(group, items) }],
    });
  }
  return out;
}

function vendorSubgroups(items: PresentedPreset[]): PresetGroup['subgroups'] {
  const by = new Map<string, PresentedPreset[]>();
  for (const p of items) {
    // An empty vendor renders as `Unspecified` (:1375) rather than as a submenu
    // with no name.
    const key = p.vendor === '' ? 'Unspecified' : p.vendor;
    by.set(key, [...(by.get(key) ?? []), p]);
  }
  return [...by.entries()]
    .map(([title, group]) => ({ title, items: sortFor('system', group) }))
    .sort((a, b) => vendorRank(a.title) - vendorRank(b.title) || compareBytes(a.title, b.title));
}

/** `first_vendors` decides which submenus come first; the rest follow by name. */
function vendorRank(vendor: string): number {
  const i = FIRST_VENDORS.indexOf(vendor);
  return i < 0 ? FIRST_VENDORS.length : i;
}

/**
 * Byte order, not locale order.
 *
 * The comparator ends in `l->first < r->first` on `std::string`, which compares
 * bytes — so `Jon PLA` sorts before `jon PLA` (`J` is 0x4A, `j` is 0x6A).
 * `localeCompare` puts them the other way round, and a config that holds both
 * spellings of one name is exactly the config someone is trying to make sense of.
 */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The two sorts the combo box runs.
 *
 * `System` and `Unsupported` filaments get the four-key sort (:1330-1350):
 * position in `filament_orders`, then in `first_vendors`, then in `first_types`,
 * then the name. A key absent from a list compares equal to any other absent one,
 * so those fall through — which is why a `Generic` submenu ends up ordered PLA,
 * PETG, ABS, TPU and then alphabetically by name.
 *
 * `User` presets get the second sort instead (:1352-1369), keyed on the alias:
 * non-empty first, then lowercased, then the name.
 */
function sortFor(group: SlicerGroup, items: PresentedPreset[]): PresentedPreset[] {
  const list = [...items];
  if (group === 'system' || group === 'unsupported') {
    return list.sort(
      (l, r) =>
        rank(FILAMENT_ORDER, l.name) - rank(FILAMENT_ORDER, r.name) ||
        rank(FIRST_VENDORS, l.vendor) - rank(FIRST_VENDORS, r.vendor) ||
        rank(FIRST_TYPES, l.type) - rank(FIRST_TYPES, r.type) ||
        compareBytes(l.name, r.name),
    );
  }
  return list.sort((l, r) => {
    const lk = l.label.toLowerCase();
    const rk = r.label.toLowerCase();
    if ((lk !== '') !== (rk !== '')) return lk !== '' ? -1 : 1;
    return compareBytes(lk, rk) || compareBytes(l.name, r.name);
  });
}

/** Position in one of the hardcoded lists; absent sorts last and ties with absent. */
function rank(list: string[], value: string): number {
  const i = list.indexOf(value);
  return i < 0 ? list.length : i;
}
