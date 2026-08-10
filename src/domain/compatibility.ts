/**
 * Which filaments and processes a printer gets, and on what grounds.
 *
 * Selecting a printer in OrcaSlicer silently rewrites both lists and never says
 * why, so the two questions you cannot answer from the slicer are "why can't I
 * pick this filament for this printer" and "why is this one here when I never set
 * it up for this machine". Everything needed to answer both is on disk.
 *
 * The rule is `Preset::is_compatible_with_printer` (v2.4.2 Preset.cpp:809-841),
 * read rather than inferred. In evaluation order:
 *
 *  1. **Library exclusion.** For a filament from the `OrcaFilamentLibrary`
 *     vendor, `m_excluded_from` naming the printer *or its `inherits`* ends it
 *     before anything else is looked at (Preset.cpp:816-824).
 *  2. **The condition, but only when the list is empty.**
 *     `if (! has_compatible_printers && ! condition.empty())` — the result *is*
 *     the condition (Preset.cpp:826-835). So an empty `compatible_printers` with
 *     a condition is neither "compatible with everything" nor an orphan.
 *  3. Otherwise compatible if **any** of: the preset is a built-in default · the
 *     active printer has no name · `compatible_printers` is empty · the printer's
 *     **name** is in the list · the printer is **not a system preset** and its
 *     **`inherits`** is in the list (Preset.cpp:838-841).
 *
 * That last clause is the one that looks wrong and is not. A filament naming a
 * *vendor* printer is available on every user printer derived from it, and the
 * source says why: "If one filament or process preset is compatible with one
 * system printer preset, then we think this filament or process preset should be
 * compatible with all user printer preset which is inherited from this system
 * printer preset" (`is_compatible_with_parent_printer`, Preset.cpp:794-806).
 *
 * The process axis is the same shape and narrower. `is_compatible_with_print`
 * (Preset.cpp:771-791) has no parent clause and is only ever applied to
 * **filaments**: processes are updated with no active print at all
 * (`prints.update_compatible(printer, nullptr, …)`, PresetBundle.cpp:5421, against
 * `filaments.update_compatible(printer, &print, …)` on :5439). A
 * `compatible_prints` on a process is dead weight, and reporting it as a gate
 * would invent a restriction the slicer does not apply.
 *
 * Two things stated here because they invert the intuition:
 *
 *  - **A condition that fails to evaluate means compatible.** Both functions catch
 *    the error and `return true`, with a `//FIXME in case of an error, return
 *    "compatible with everything"` on it (Preset.cpp:832-835, :784-787). A
 *    malformed condition does not hide a preset.
 *  - **Being the printer's default is not a compatibility reason.** It decides
 *    what gets *selected* when the printer is chosen (PresetBundle.cpp:2142-2166),
 *    which is a different question — so it rides along as evidence rather than as
 *    a verdict.
 *
 * Conditions are evaluated only as far as `condition.ts` documents, and are
 * `undetermined` outside that — never a boolean. `compatible_printers_condition`
 * is a PlaceholderParser expression, not a name list, and the reason for a verdict
 * stays `'condition'` either way: `included` carries the answer (`true` matched,
 * `false` excluded, `'undetermined'` outside the subset) so a caller never has to
 * read a boolean and a caveat together.
 *
 * The two axes see different configs, which is easy to get wrong:
 * `compatible_printers_condition` is evaluated against the **printer's** resolved
 * settings plus the injected `printer_preset` / `num_extruders`
 * (Preset.cpp:845-849), while `compatible_prints_condition` is evaluated against
 * the **process's** config with no extras (Preset.cpp:782).
 *
 * ## The other gate: installed, which is not compatibility
 *
 * All of the above is `is_compatible`, and it is only half of what the dropdown
 * applies. The other half is `is_visible` — whether the preset is *installed* —
 * and the combo box requires both: `it_preset->is_visible && (it_preset->is_compatible
 * || <selected>)` (Preset.cpp:3166-3168). They are independent, and conflating
 * them is how this app came to offer 320 filaments where the slicer offered 18:
 * every vendor's PLA is compatible with a printer that names no printers back,
 * and almost none of them are installed.
 *
 * `Preset::set_visible_from_appconfig` (Preset.cpp:853-882) decides it, and the
 * shape of that function is the shape of `visibilityIndex` below:
 *
 *  - **`if (vendor == nullptr) return;`** — a preset with no vendor keeps the
 *    visibility it loaded with, which for a user preset is `true`
 *    (Preset.cpp:2892, :2921). Only vendor presets are gated, and `vendor` is set
 *    for exactly those loaded out of a vendor bundle (PresetBundle.cpp:5057). The
 *    filament library is a vendor bundle like any other, so `Generic PLA` is
 *    gated too — it appears in a real dropdown because it is installed, not
 *    because it is special.
 *  - **Filaments** are gated by *name* against the conf's `filaments` section,
 *    `renamed_from` included (Preset.cpp:866-878).
 *  - **Printers** are gated by `get_variant(vendor->id, printer_model,
 *    printer_variant)`, and not at all when either field is empty
 *    (Preset.cpp:859-864).
 *  - **Processes are not gated.** The function handles `TYPE_PRINTER`,
 *    `TYPE_FILAMENT` and `TYPE_SLA_MATERIAL`, and a process is none of them, so
 *    its `instantiation`-derived visibility (Preset.cpp:1663) stands. A process
 *    list is decided by compatibility alone.
 *
 * `included` below therefore stays exactly `is_compatible` and says nothing about
 * installation; `visibility` is the second flag, reported beside it rather than
 * folded into it. `offering()` combines them the way the combo box does, and is
 * the only thing that should decide what a caller shows as a verdict.
 */

import { evaluateCondition, printerInjectedVars, type ConditionContext } from './condition';
import { shadowedIds, type ConfigIndex } from './index-config';
import { hasVariant } from './installed';
import { referenceNames } from './references';
import { chainLookup, resolve, type ChainValue } from './resolve';
import type { Preset, RawValue, ResolvedSetting } from './types';

/** The vendor whose filaments carry the derived exclusion list. */
const FILAMENT_LIBRARY = 'OrcaFilamentLibrary';

export type CompatibilityReason =
  /** No `compatible_*` list and no condition: it goes with everything. */
  | 'compatible-with-everything'
  /** This printer's name is in the list. */
  | 'named-explicitly'
  /** The list names the preset this printer inherits from. */
  | 'named-via-parent'
  /** The list is non-empty and names neither. */
  | 'excluded'
  /** A library filament a vendor supersedes for this printer. */
  | 'excluded-by-library'
  /** The list is empty and a condition decides. Never a boolean. */
  | 'condition'
  /** It lost a name clash, so the slicer never loads it at all. */
  | 'never-loaded';

/** The key and value that decided it, so a verdict is always traceable. */
export interface CompatibilityEvidence {
  key: string;
  value: string;
  /**
   * The preset that actually states the key, when it is not the preset being
   * judged. A user filament saved from a vendor one carries the vendor's gate
   * without stating it, so this is the file you would open to change the answer —
   * and without it the verdict looks like it came from nowhere.
   */
  from?: string;
}

/** Why a preset is or is not installed. */
export type VisibilityReason =
  /** Not subject to the gate: a user preset, or a process. */
  | 'not-gated'
  /** Named in the conf's `filaments` section. */
  | 'installed'
  /** Not named, but a name in its `renamed_from` is. */
  | 'installed-under-old-name'
  /** Not named by the user; the slicer installs it as a printer's default. */
  | 'installed-as-default'
  /** A vendor filament the user has not added. */
  | 'not-installed'
  /** This printer's model and variant are in the conf's `models`. */
  | 'variant-installed'
  /** They are not, so the slicer does not offer this printer either. */
  | 'variant-not-installed'
  /** A vendor printer with no `printer_model`/`printer_variant` to gate on. */
  | 'no-variant-declared'
  /** There was no readable `OrcaSlicer.conf`, so the gate cannot be applied. */
  | 'config-unreadable';

/**
 * `is_visible`: the installed gate, independent of compatibility.
 *
 * Kept as its own value rather than folded into `included` because the two have
 * different causes and different fixes — "OrcaSlicer will not let you use this
 * filament with this printer" and "you never added this filament" are different
 * sentences, and only the first is about `compatible_printers`.
 */
export interface Visibility {
  visible: boolean;
  reason: VisibilityReason;
  evidence: CompatibilityEvidence;
}

/** Not gated at all, which is the answer for every user preset and every process. */
const NOT_GATED: Visibility = {
  visible: true,
  reason: 'not-gated',
  evidence: { key: 'vendor', value: '' },
};

export interface Compatibility {
  preset: Preset;
  /**
   * `is_compatible` alone. `'undetermined'` is a value, not a boolean with a
   * caveat. This says nothing about whether the preset is installed — read
   * `offering()` for what the slicer would actually put in the list.
   */
  included: boolean | 'undetermined';
  reason: CompatibilityReason;
  evidence: CompatibilityEvidence;
  /** `is_visible`: the second, independent gate. */
  visibility: Visibility;
  /**
   * The printer's `default_print_profile` / `default_filament_profile` names it.
   * Not part of the verdict — see the module note.
   */
  isPrinterDefault: boolean;
  /**
   * Filaments only: the second gate, against a process. Present whenever the
   * filament carries one, whether or not a process was supplied to check against.
   */
  processGate?: {
    /** Process names it accepts, if it lists any. */
    names: string[];
    /** The `compatible_prints_condition`, when the list is empty. */
    condition?: string;
    /** The preset that states the gate, when an ancestor does. */
    from?: string;
    /** Set when a process was supplied: does this filament pass for it? */
    passes?: boolean | 'undetermined';
  };
}

export interface PrinterCompatibility {
  machine: Preset;
  /** The process the filament gate was checked against, when one was given. */
  process?: Preset;
  filaments: Compatibility[];
  processes: Compatibility[];
}

/**
 * Is this preset one the slicer would actually offer, or only an inheritance
 * source?
 *
 * A vendor-bundle preset marked `instantiation: "false"` is **never added to the
 * collection at all**: it is stored as a config map for others to inherit and the
 * loader returns before the preset is constructed (PresetBundle.cpp:4929-4941).
 * So `fdm_filament_common` cannot be selected for any printer, and listing it as
 * "available" would be describing something that is not there.
 *
 * The `Template` vendor is the documented exception — the guard is
 * `instantiation == "false" && "Template" != vendor_name` — so its
 * non-instantiable presets *are* loaded and stay in the list.
 */
function isSelectable(p: Preset): boolean {
  return p.raw.instantiation !== 'false' || p.vendor === 'Template';
}

export interface CompatibilityOptions {
  /**
   * Scope a filament verdict to a process as well, which is the only honest way
   * to answer for a filament that carries `compatible_prints` — the slicer ands
   * the two together (`is_compatible &= is_compatible_with_print`,
   * Preset.cpp:3364).
   */
  process?: Preset;
  /** Include presets the slicer never loads, marked as such. Off by default. */
  includeNeverLoaded?: boolean;
}

/**
 * `m_excluded_from`, which is derived rather than stored.
 *
 * For every `OrcaFilamentLibrary` filament with an **empty**
 * `compatible_printers`, the printers named by any *other* vendor's preset
 * sharing its `alias` become exclusions (`update_library_profile_excluded_from`,
 * Preset.cpp:3704-3733). The effect: where a vendor ships its own tuned version
 * of `Generic PLA` for a printer, the library's generic one is not offered for
 * that printer.
 */
function libraryExclusions(index: ConfigIndex): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const byAlias = new Map<string, string[]>();
  // Both loops in the source read `preset.config.option("compatible_printers")`
  // and `preset.alias`, so both are effective values rather than stated ones.
  const aliasOf = (look: ChainLook) => {
    const v = look('alias')?.value;
    return typeof v === 'string' ? v : '';
  };

  // Two passes, because within a directory the order files are read in is
  // filesystem-dependent — a one-pass version would give different exclusions on
  // different machines.
  for (const p of index.active) {
    if (p.kind !== 'filament' || p.vendor !== FILAMENT_LIBRARY) continue;
    const look = chainLookup(index, p);
    const alias = aliasOf(look);
    if (alias === '' || gateNames(look, 'compatible_printers').length > 0) continue;
    out.set(p.id, new Set());
    byAlias.set(alias, [...(byAlias.get(alias) ?? []), p.id]);
  }

  for (const p of index.active) {
    if (p.kind !== 'filament' || p.vendor === FILAMENT_LIBRARY) continue;
    const look = chainLookup(index, p);
    const claims = gateNames(look, 'compatible_printers');
    if (claims.length === 0) continue;
    for (const libraryId of byAlias.get(aliasOf(look)) ?? []) {
      const set = out.get(libraryId);
      for (const name of claims) set?.add(name);
    }
  }

  return out;
}

/** A reader over one preset's inheritance chain — see `chainLookup`. */
type ChainLook = (key: string) => ChainValue | undefined;

/**
 * A name list as the slicer sees it: the effective value, not the stated one.
 *
 * `referenceNames` handles both serialisations; this adds the chain walk, which is
 * the difference between reading a preset and reading a *file*. A user filament
 * saved from `Creality Generic PETG @ender3` states no `compatible_printers` and
 * has one all the same.
 */
function gateNames(look: ChainLook, key: string): string[] {
  const found = look(key);
  return found ? referenceNames({ [key]: found.value }, key) : [];
}

/** Where a value came from, when an ancestor supplied it. */
function sourceOf(look: ChainLook, key: string): string | undefined {
  const found = look(key);
  return found?.inherited ? found.source.name : undefined;
}

/**
 * The context a `compatible_printers_condition` is evaluated in: the printer's
 * *resolved* settings, so an inherited `printer_notes` is in scope, plus the two
 * variables the slicer injects rather than reads (Preset.cpp:845-849).
 */
function printerContext(
  settings: Map<string, ResolvedSetting>,
  machineName: string,
): ConditionContext {
  return {
    lookup: (key: string): RawValue | undefined => settings.get(key)?.value,
    injected: printerInjectedVars(machineName, settings.get('nozzle_diameter')?.value),
  };
}

/** A resolved setting as a trimmed string, which is what `opt_string` yields. */
function settingText(settings: Map<string, ResolvedSetting>, key: string): string {
  const v = settings.get(key)?.value;
  if (v === undefined) return '';
  return Array.isArray(v) ? String(v[0] ?? '').trim() : String(v).trim();
}

/**
 * The names this preset may be installed under besides its own.
 *
 * Two sources, and the second is easy to miss. A vendor bundle may state
 * `renamed_from` outright (PresetBundle.cpp:4947), and when it does not, the
 * loader *derives* one for any preset whose name contains `@` and which declares
 * no `alias` of its own: the name with the `@` character removed
 * (PresetBundle.cpp:5086-5093). Both are consulted by
 * `set_visible_from_appconfig` (Preset.cpp:875-877), so a config that still lists
 * a preset under its pre-rename name keeps showing it.
 */
function renamedFrom(p: Preset): string[] {
  const explicit = referenceNames(p.raw, 'renamed_from');
  if (explicit.length > 0) return explicit;
  // The derived name exists only when the bundle stated no alias: the C++ builds
  // it inside `if (alias_name.empty())`.
  const alias = typeof p.raw.alias === 'string' ? p.raw.alias : '';
  if (alias !== '') return [];
  const at = p.name.indexOf('@');
  if (at < 0) return [];
  // `alias_name + preset_name.substr(end_pos + 1)` — and `alias_name` is not
  // trimmed until after this line, so the space before the `@` survives.
  return [p.name.slice(0, at) + p.name.slice(at + 1)];
}

/**
 * `Preset::set_visible_from_appconfig` for one vendor printer preset.
 *
 * Exported because the printer *picker* needs it: a system printer whose variant
 * is not installed is not in the slicer's printer list either, and offering it
 * as something to explain would be describing a machine the user cannot select.
 */
export function machineVisibility(index: ConfigIndex, machine: Preset): Visibility {
  if (machine.kind !== 'machine' || machine.origin !== 'system' || !machine.vendor) return NOT_GATED;
  return machineVisibilityFrom(index, machine, resolve(index, machine).settings);
}

function machineVisibilityFrom(
  index: ConfigIndex,
  machine: Preset,
  settings: Map<string, ResolvedSetting>,
): Visibility {
  if (!index.installed.present) return CONFIG_UNREADABLE;
  const model = settingText(settings, 'printer_model');
  const variant = settingText(settings, 'printer_variant');
  // `if (model.empty() || variant.empty()) return;` — the function leaves
  // `is_visible` alone, and for a bundle preset that is `instantiation != "false"`
  // (Preset.cpp:1663), i.e. true for anything selectable at all.
  if (model === '' || variant === '') {
    return {
      visible: true,
      reason: 'no-variant-declared',
      evidence: { key: model === '' ? 'printer_model' : 'printer_variant', value: '' },
    };
  }
  const installed = hasVariant(index.installed, machine.vendor ?? '', model, variant);
  return {
    visible: installed,
    reason: installed ? 'variant-installed' : 'variant-not-installed',
    evidence: { key: 'models', value: `${machine.vendor ?? ''} · ${model} · ${variant}` },
  };
}

/** No conf, so no gate — never a verdict of "not installed" on our own ignorance. */
const CONFIG_UNREADABLE: Visibility = {
  visible: true,
  reason: 'config-unreadable',
  evidence: { key: 'OrcaSlicer.conf', value: '' },
};

/**
 * The filaments the slicer installs on the user's behalf.
 *
 * `load_installed_filaments` (PresetBundle.cpp:2541-2600) runs on every start,
 * after printer visibility is settled (`load_installed_printers` first,
 * PresetBundle.cpp:2726-2730). For each **visible, FFF, vendor** printer whose
 * vendor declares models, it asks whether *any* installed filament is compatible
 * with that printer; if none is, it adds that printer model's `default_materials`
 * — system presets only — to the installed set and writes them back to the conf.
 *
 * So on any config that has been opened once this returns nothing: the names are
 * already in `filaments`. It matters for the config that has never been opened,
 * and for a printer whose installed filaments all exclude it — where without it
 * this app would report a printer with no filaments at all, which the slicer
 * never shows anyone.
 *
 * `undetermined` counts as compatible here. The C++ has no such state — a
 * condition it cannot evaluate returns "compatible with everything"
 * (Preset.cpp:832-835) — so treating it as compatible follows the source, and it
 * is also the narrower answer: it suppresses seeding rather than inventing
 * installs.
 */
function seededFilaments(index: ConfigIndex, exclusions: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  if (!index.installed.present) return out;

  const vendorHasModels = new Set(index.vendorModels.map((m) => m.vendor));
  const activeNamed = (name: string, kind: Preset['kind']) =>
    (index.byName.get(name) ?? []).filter((p) => p.kind === kind && p.scope === 'active');

  for (const machine of index.active) {
    if (machine.kind !== 'machine' || machine.origin !== 'system' || !machine.vendor) continue;
    // `printer.vendor && (! printer.vendor->models.empty())`.
    if (!vendorHasModels.has(machine.vendor)) continue;

    const settings = resolve(index, machine).settings;
    // `printer.printer_technology() == ptFFF`. The option defaults to FFF, and
    // OrcaSlicer's SLA path is vestigial, so only an explicit SLA opts out.
    if (settingText(settings, 'printer_technology').toUpperCase() === 'SLA') continue;
    if (!machineVisibilityFrom(index, machine, settings).visible) continue;

    const ctx = printerContext(settings, machine.name);
    const anyInstalledFits = [...index.installed.filaments].some((name) =>
      activeNamed(name, 'filament').some(
        (f) => judgePrinter(f, chainLookup(index, f), machine, exclusions, ctx).included !== false,
      ),
    );
    if (anyInstalledFits) continue;

    const model = settingText(settings, 'printer_model');
    const declared = index.vendorModels.find(
      (m) => m.vendor === machine.vendor && m.id === model,
    );
    // `if (!printer_model) continue;` — nothing to take defaults from.
    if (!declared) continue;
    for (const name of declared.defaultMaterials) {
      // `if (filament && filament->is_system)`.
      for (const f of activeNamed(name, 'filament')) {
        if (f.origin === 'system') out.add(f.name);
      }
    }
  }
  return out;
}

/**
 * `is_visible` for every preset in the config, keyed by id.
 *
 * One pass, so the seeding above is computed once rather than per preset.
 */
export function visibilityIndex(index: ConfigIndex): Map<string, Visibility> {
  const out = new Map<string, Visibility>();
  const seeded = seededFilaments(index, libraryExclusions(index));
  const installed = index.installed;

  for (const p of index.presets) {
    // `if (vendor == nullptr) { return; }` — and a process is not a type the
    // function handles at all.
    if (p.origin !== 'system' || !p.vendor || p.kind === 'process') {
      out.set(p.id, NOT_GATED);
      continue;
    }
    if (!installed.present) {
      out.set(p.id, CONFIG_UNREADABLE);
      continue;
    }
    if (p.kind === 'machine') {
      out.set(p.id, machineVisibilityFrom(index, p, resolve(index, p).settings));
      continue;
    }
    if (installed.filaments.has(p.name)) {
      out.set(p.id, {
        visible: true,
        reason: 'installed',
        evidence: { key: 'filaments', value: p.name },
      });
      continue;
    }
    const oldName = renamedFrom(p).find((n) => installed.filaments.has(n));
    if (oldName !== undefined) {
      out.set(p.id, {
        visible: true,
        reason: 'installed-under-old-name',
        evidence: { key: 'renamed_from', value: oldName },
      });
      continue;
    }
    if (seeded.has(p.name)) {
      out.set(p.id, {
        visible: true,
        reason: 'installed-as-default',
        evidence: { key: 'default_materials', value: p.name },
      });
      continue;
    }
    out.set(p.id, {
      visible: false,
      reason: 'not-installed',
      evidence: { key: 'filaments', value: p.name },
    });
  }
  return out;
}

/**
 * What the slicer would do with this preset, both gates folded in the order the
 * combo box folds them (Preset.cpp:3166-3168).
 *
 * `never-loaded` comes first: a file the slicer never read is not "not
 * installed", and saying so would point at the wrong fix.
 */
export type Offering = 'available' | 'excluded' | 'not-installed' | 'undetermined';

export function offering(c: Compatibility): Offering {
  if (c.reason === 'never-loaded') return 'excluded';
  if (!c.visibility.visible) return 'not-installed';
  if (c.included === 'undetermined') return 'undetermined';
  return c.included ? 'available' : 'excluded';
}

export function compatibilityFor(
  index: ConfigIndex,
  machine: Preset,
  opts: CompatibilityOptions = {},
): PrinterCompatibility {
  const dead = shadowedIds(index);
  const exclusions = libraryExclusions(index);
  const visibility = visibilityIndex(index);

  const machineSettings = resolve(index, machine).settings;
  const printerCtx = printerContext(machineSettings, machine.name);

  // Also off the chain: `PresetBundle` reads these from the printer's config
  // (PresetBundle.cpp:2142-2166), and a user printer inherits them from the vendor
  // preset it was saved from without restating either.
  const machineLook = chainLookup(index, machine);
  const defaultProcesses = new Set(gateNames(machineLook, 'default_print_profile'));
  const defaultFilaments = new Set(gateNames(machineLook, 'default_filament_profile'));

  const judge = (p: Preset): Compatibility => {
    const isDefault =
      p.kind === 'process' ? defaultProcesses.has(p.name) : defaultFilaments.has(p.name);
    const base = {
      preset: p,
      isPrinterDefault: isDefault,
      visibility: visibility.get(p.id) ?? NOT_GATED,
    };
    // One chain walk per preset, shared by both gates: everything below reads the
    // preset's *effective* keys, which is what the slicer's `preset.config` holds.
    const look = chainLookup(index, p);

    if (dead.has(p.id) || p.scope !== 'active') {
      return {
        ...base,
        included: false,
        reason: 'never-loaded',
        evidence: { key: 'name', value: p.name },
        ...(p.kind === 'filament' ? { processGate: gateOf(look) } : {}),
      };
    }

    const gate = p.kind === 'filament' ? gateOf(look) : undefined;
    const verdict = judgePrinter(p, look, machine, exclusions, printerCtx);
    const out: Compatibility = { ...base, ...verdict, ...(gate ? { processGate: gate } : {}) };

    if (gate && opts.process) {
      const passes = passesProcess(gate, opts.process, index);
      out.processGate = { ...gate, passes };
      // The slicer ands the two gates together, so a filament that fails the
      // process gate is not compatible however well it matches the printer.
      if (out.included === true && passes !== true) out.included = passes;
      if (out.included === 'undetermined' && passes === false) out.included = false;
    }

    return out;
  };

  const wanted = (p: Preset) =>
    isSelectable(p) &&
    (opts.includeNeverLoaded ? p.scope !== 'snapshot' : p.scope === 'active' && !dead.has(p.id));

  const byName = (a: Compatibility, b: Compatibility) =>
    a.preset.name.localeCompare(b.preset.name, 'en');

  return {
    machine,
    process: opts.process,
    filaments: index.presets.filter((p) => p.kind === 'filament' && wanted(p)).map(judge).sort(byName),
    processes: index.presets.filter((p) => p.kind === 'process' && wanted(p)).map(judge).sort(byName),
  };
}

function judgePrinter(
  p: Preset,
  look: ChainLook,
  machine: Preset,
  exclusions: Map<string, Set<string>>,
  printerCtx: ConditionContext,
): { included: boolean | 'undetermined'; reason: CompatibilityReason; evidence: CompatibilityEvidence } {
  // 1. The library exclusion, which is checked first and by itself.
  const excluded = exclusions.get(p.id);
  if (excluded && (excluded.has(machine.name) || (machine.inherits && excluded.has(machine.inherits)))) {
    const alias = look('alias')?.value;
    return {
      included: false,
      reason: 'excluded-by-library',
      evidence: {
        key: 'alias',
        value: typeof alias === 'string' ? alias : p.name,
      },
    };
  }

  const names = gateNames(look, 'compatible_printers');
  const condition = conditionOf(look, 'compatible_printers_condition');
  const from = sourceOf(look, names.length === 0 ? 'compatible_printers_condition' : 'compatible_printers');

  // 2. Empty list plus a condition: the condition is the whole answer.
  if (names.length === 0 && condition) {
    return {
      included: evaluateCondition(condition, printerCtx),
      reason: 'condition',
      evidence: { key: 'compatible_printers_condition', value: condition, from },
    };
  }

  // 3. Empty list, no condition.
  if (names.length === 0) {
    return {
      included: true,
      reason: 'compatible-with-everything',
      evidence: { key: 'compatible_printers', value: '', from },
    };
  }

  if (names.includes(machine.name)) {
    return {
      included: true,
      reason: 'named-explicitly',
      evidence: { key: 'compatible_printers', value: machine.name, from },
    };
  }

  // The parent clause, and only for a printer the user owns: the source checks
  // `! active_printer.preset.is_system` before consulting it (Preset.cpp:841).
  if (machine.origin !== 'system' && machine.inherits && names.includes(machine.inherits)) {
    return {
      included: true,
      reason: 'named-via-parent',
      evidence: { key: 'compatible_printers', value: machine.inherits, from },
    };
  }

  return {
    included: false,
    reason: 'excluded',
    evidence: { key: 'compatible_printers', value: names.join(', '), from },
  };
}

/** The filament's process gate, if it carries one — inherited or not. */
function gateOf(look: ChainLook): Compatibility['processGate'] {
  const names = gateNames(look, 'compatible_prints');
  const condition = conditionOf(look, 'compatible_prints_condition');
  if (names.length === 0 && !condition) return undefined;
  return {
    names,
    ...(names.length === 0 && condition ? { condition } : {}),
    from: sourceOf(look, names.length === 0 ? 'compatible_prints_condition' : 'compatible_prints'),
  };
}

function passesProcess(
  gate: NonNullable<Compatibility['processGate']>,
  process: Preset,
  index: ConfigIndex,
): boolean | 'undetermined' {
  // Same shape as the printer gate, and deliberately without a parent clause:
  // `is_compatible_with_print` has none (Preset.cpp:771-791).
  if (gate.names.length > 0) return gate.names.includes(process.name);
  if (!gate.condition) return true;
  // Against the **process's** config, and with none of the printer's injected
  // variables in scope (Preset.cpp:782).
  const settings = resolve(index, process).settings;
  return evaluateCondition(gate.condition, {
    lookup: (key: string): RawValue | undefined => settings.get(key)?.value,
  });
}

/**
 * A condition, or undefined when it is absent or blank.
 *
 * Read off the chain, because `compatible_printers_condition()` is a config
 * accessor (Preset.hpp:347) and a user preset saved from a vendor one inherits the
 * vendor's condition without stating a word of it. A child that states the key
 * *blank* clears it, which is why this tests the value it found rather than
 * continuing up the chain looking for a non-empty one.
 */
function conditionOf(look: ChainLook, key: string): string | undefined {
  const v = look(key)?.value;
  if (typeof v !== 'string') return undefined;
  const text = v.trim();
  return text === '' ? undefined : text;
}

/**
 * Counts for a one-line summary, without re-deriving any of the rule.
 *
 * Every count comes from `offering`, the same function a caller uses to label a
 * row, so a header can never disagree with the list under it. `yes` is therefore
 * what the slicer would offer — not what merely passes `compatible_printers`.
 */
export function compatibilitySummary(list: Compatibility[]): {
  yes: number;
  no: number;
  undetermined: number;
  notInstalled: number;
} {
  const of = list.map(offering);
  return {
    yes: of.filter((o) => o === 'available').length,
    no: of.filter((o) => o === 'excluded').length,
    undetermined: of.filter((o) => o === 'undetermined').length,
    notInstalled: of.filter((o) => o === 'not-installed').length,
  };
}
