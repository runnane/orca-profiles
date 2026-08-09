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
 */

import { evaluateCondition, printerInjectedVars, type ConditionContext } from './condition';
import { shadowedIds, type ConfigIndex } from './index-config';
import { referenceNames } from './references';
import { resolve } from './resolve';
import type { Preset, RawValue } from './types';

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
}

export interface Compatibility {
  preset: Preset;
  /** `'undetermined'` is a value, not a boolean with a caveat. */
  included: boolean | 'undetermined';
  reason: CompatibilityReason;
  evidence: CompatibilityEvidence;
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
  const aliasOf = (p: Preset) => (typeof p.raw.alias === 'string' ? p.raw.alias : '');

  // Two passes, because within a directory the order files are read in is
  // filesystem-dependent — a one-pass version would give different exclusions on
  // different machines.
  for (const p of index.active) {
    if (p.kind !== 'filament' || p.vendor !== FILAMENT_LIBRARY) continue;
    const alias = aliasOf(p);
    if (alias === '' || referenceNames(p.raw, 'compatible_printers').length > 0) continue;
    out.set(p.id, new Set());
    byAlias.set(alias, [...(byAlias.get(alias) ?? []), p.id]);
  }

  for (const p of index.active) {
    if (p.kind !== 'filament' || p.vendor === FILAMENT_LIBRARY) continue;
    const claims = referenceNames(p.raw, 'compatible_printers');
    if (claims.length === 0) continue;
    for (const libraryId of byAlias.get(aliasOf(p)) ?? []) {
      const set = out.get(libraryId);
      for (const name of claims) set?.add(name);
    }
  }

  return out;
}

export function compatibilityFor(
  index: ConfigIndex,
  machine: Preset,
  opts: CompatibilityOptions = {},
): PrinterCompatibility {
  const dead = shadowedIds(index);
  const exclusions = libraryExclusions(index);

  // The printer's *resolved* settings, so an inherited `printer_notes` is visible
  // to a condition, plus the two variables the slicer injects rather than reads.
  const machineSettings = resolve(index, machine).settings;
  const printerCtx: ConditionContext = {
    lookup: (key) => machineSettings.get(key)?.value,
    injected: printerInjectedVars(machine.name, machineSettings.get('nozzle_diameter')?.value),
  };

  const defaultProcesses = new Set(referenceNames(machine.raw, 'default_print_profile'));
  const defaultFilaments = new Set(referenceNames(machine.raw, 'default_filament_profile'));

  const judge = (p: Preset): Compatibility => {
    const isDefault =
      p.kind === 'process' ? defaultProcesses.has(p.name) : defaultFilaments.has(p.name);
    const base = { preset: p, isPrinterDefault: isDefault };

    if (dead.has(p.id) || p.scope !== 'active') {
      return {
        ...base,
        included: false,
        reason: 'never-loaded',
        evidence: { key: 'name', value: p.name },
        ...(p.kind === 'filament' ? { processGate: gateOf(p) } : {}),
      };
    }

    const gate = p.kind === 'filament' ? gateOf(p) : undefined;
    const verdict = judgePrinter(p, machine, exclusions, printerCtx);
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
  machine: Preset,
  exclusions: Map<string, Set<string>>,
  printerCtx: ConditionContext,
): { included: boolean | 'undetermined'; reason: CompatibilityReason; evidence: CompatibilityEvidence } {
  // 1. The library exclusion, which is checked first and by itself.
  const excluded = exclusions.get(p.id);
  if (excluded && (excluded.has(machine.name) || (machine.inherits && excluded.has(machine.inherits)))) {
    return {
      included: false,
      reason: 'excluded-by-library',
      evidence: {
        key: 'alias',
        value: typeof p.raw.alias === 'string' ? p.raw.alias : p.name,
      },
    };
  }

  const names = referenceNames(p.raw, 'compatible_printers');
  const condition = conditionOf(p, 'compatible_printers_condition');

  // 2. Empty list plus a condition: the condition is the whole answer.
  if (names.length === 0 && condition) {
    return {
      included: evaluateCondition(condition, printerCtx),
      reason: 'condition',
      evidence: { key: 'compatible_printers_condition', value: condition },
    };
  }

  // 3. Empty list, no condition.
  if (names.length === 0) {
    return {
      included: true,
      reason: 'compatible-with-everything',
      evidence: { key: 'compatible_printers', value: '' },
    };
  }

  if (names.includes(machine.name)) {
    return {
      included: true,
      reason: 'named-explicitly',
      evidence: { key: 'compatible_printers', value: machine.name },
    };
  }

  // The parent clause, and only for a printer the user owns: the source checks
  // `! active_printer.preset.is_system` before consulting it (Preset.cpp:841).
  if (machine.origin !== 'system' && machine.inherits && names.includes(machine.inherits)) {
    return {
      included: true,
      reason: 'named-via-parent',
      evidence: { key: 'compatible_printers', value: machine.inherits },
    };
  }

  return {
    included: false,
    reason: 'excluded',
    evidence: { key: 'compatible_printers', value: names.join(', ') },
  };
}

/** The filament's process gate, if it carries one. */
function gateOf(p: Preset): Compatibility['processGate'] {
  const names = referenceNames(p.raw, 'compatible_prints');
  const condition = conditionOf(p, 'compatible_prints_condition');
  if (names.length === 0 && !condition) return undefined;
  return { names, ...(names.length === 0 && condition ? { condition } : {}) };
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

/** A condition, or undefined when it is absent or blank. */
function conditionOf(p: Preset, key: string): string | undefined {
  const v = p.raw[key];
  if (typeof v !== 'string') return undefined;
  const text = v.trim();
  return text === '' ? undefined : text;
}

/** Counts for a one-line summary, without re-deriving any of the rule. */
export function compatibilitySummary(list: Compatibility[]): {
  yes: number;
  no: number;
  undetermined: number;
} {
  return {
    yes: list.filter((c) => c.included === true).length,
    no: list.filter((c) => c.included === false).length,
    undetermined: list.filter((c) => c.included === 'undetermined').length,
  };
}
