/**
 * The OrcaSlicer preset model.
 *
 * A preset is a JSON file of flat key -> value pairs, where values are strings,
 * arrays of strings, or (rarely, and only in hand-edited files) numbers.
 *
 * The part that makes presets hard to read: a preset normally stores only the
 * keys it *overrides*. Everything else comes from `inherits`, walking up a chain
 * that ends in a vendor base like `fdm_filament_common`. The slicer shows you
 * resolved values with no indication of where any of them came from.
 */

/** A raw value as it appears on disk. */
export type RawValue = string | string[] | number;

/** A preset file's parsed contents: flat keys, plus metadata keys. */
export type RawPreset = Record<string, RawValue>;

export type PresetKind = 'filament' | 'process' | 'machine';

/** Where a preset came from. System presets ship with the app and are read-only. */
export type PresetOrigin = 'system' | 'user';

/**
 * Whether the slicer actually loads this preset.
 *
 * OrcaSlicer loads exactly one user folder — `app.preset_folder` from
 * `OrcaSlicer.conf`, or `default` when that is empty
 * (`PresetBundle::load_presets`, v2.4.2 PresetBundle.cpp:528). Everything under
 * any other user folder is inert: not loaded, not selectable, invisible to the
 * slicer. On the config this was built against that is the entire cloud profile
 * plus its 21 `_local/` sync snapshots.
 *
 * Presenting those beside the live ones is how a config looks twice the size it
 * is, so they are kept, labelled, and excluded from analysis.
 */
export type PresetScope = 'active' | 'inactive-profile' | 'snapshot';

export interface Preset {
  /**
   * The path, which is the only identifier a config guarantees to be unique.
   * Names are not: the local and cloud profiles each keep their own copy of the
   * same preset, and a name can be claimed by several files at once.
   */
  id: string;
  name: string;
  kind: PresetKind;
  origin: PresetOrigin;
  /** Path relative to the config root, for display and re-reading. */
  path: string;
  /** Vendor directory for system presets (`Elegoo`, `Creality`, ...). */
  vendor?: string;
  /** For user presets: `default`, or the cloud account folder. */
  profile?: string;
  /** Only `active` presets are ones the slicer loads. */
  scope: PresetScope;
  /**
   * Lives in `<type>/base/`. OrcaSlicer writes a preset there when it is saved
   * **detached** — the link to its parent is cleared (`save_current_preset`
   * with `detach`, v2.4.2 Preset.cpp:2890). They are "custom roots": loaded
   * before the rest of the folder so other user presets can inherit them by
   * name (Preset.cpp:1583).
   */
  isCustomRoot: boolean;
  /** The `inherits` value verbatim. Empty string and undefined both mean "no parent". */
  inherits?: string;
  /** Everything on disk, metadata included. */
  raw: RawPreset;
}

/** Metadata keys that are bookkeeping rather than print settings. */
export const META_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'from',
  'inherits',
  'version',
  'instantiation',
  'is_custom_defined',
  'filament_id',
  'setting_id',
  'filament_settings_id',
  'print_settings_id',
  'printer_settings_id',
  'filament_extruder_variant',
  'print_extruder_id',
  'print_extruder_variant',
  'printer_extruder_id',
  'printer_extruder_variant',
]);

/** One resolved setting, and the preset in the chain that decided it. */
export interface ResolvedSetting {
  key: string;
  value: RawValue;
  /** id of the preset that supplied the winning value. */
  sourceId: string;
  /** name of that preset, for display. */
  sourceName: string;
  /** 0 = the preset itself, 1 = its parent, and so on. */
  depth: number;
  /**
   * Values for this key further up the chain that were overridden, nearest
   * ancestor first. Empty when the value was only ever set once.
   */
  shadowed: { sourceName: string; value: RawValue }[];
  /**
   * Presets that re-state this key with the value it already had. They look
   * like edits in the file but change nothing.
   */
  redundantAt?: string[];
}

export interface Resolution {
  preset: Preset;
  /** The inheritance chain, starting with the preset itself. */
  chain: Preset[];
  /** Every setting the preset ends up with, keyed by setting name. */
  settings: Map<string, ResolvedSetting>;
  /** A parent named by `inherits` that is not present in the config. */
  missingParent?: string;
  /** True when the chain looped back on itself; resolution stopped there. */
  circular: boolean;
}
