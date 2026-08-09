/**
 * Config health.
 *
 * Every finding here is something the slicer will not tell you, derived from
 * what the real config in this repo's fixtures actually looks like:
 *
 *  - detached      a user preset with no `inherits` carrying the full 354-key
 *                  blob. It was forked from a vendor preset and no longer
 *                  tracks it, so vendor fixes never arrive and you cannot see
 *                  what you changed. The single biggest source of confusion.
 *  - redundant     overrides re-stating the inherited value. They pad a preset
 *                  and bury the handful of edits that matter.
 *  - near-duplicate  two presets whose effective settings differ in only a few
 *                  keys. `ABS fast` / `ABS fast2` is the worked example.
 *  - broken-parent `inherits` naming a preset that is not installed.
 *  - orphaned-printer  `compatible_printers` naming a machine that is gone, so
 *                  the preset silently never appears in the slicer.
 *  - missing-reference  any of the *other* keys that name a preset —
 *                  `compatible_prints`, `default_print_profile`,
 *                  `default_filament_profile` — plus a vendor index entry whose
 *                  file is not on disk and a system printer preset whose
 *                  `printer_model` / `printer_variant` its own vendor does not
 *                  declare. Each carries a `reason` saying *why* the name did
 *                  not resolve, because "absent", "in a profile that is not
 *                  loaded" and "a preset of the wrong type" need three
 *                  different fixes. See `classifyReference`.
 *  - duplicate-name  two files claiming one name. The slicer loads the first and
 *                  **never loads the rest** — so a file can be edited forever
 *                  with no effect. Three files claim "ABS fast" here.
 *
 * Everything is judged against the presets the slicer actually loads: one user
 * folder, never two, and never the `_local/` sync snapshots.
 */

import { diffEffective } from './diff';
import {
  classifyReference,
  clashGroups,
  loadOrder,
  shadowedIds,
  tieIsArbitrary,
  type ConfigIndex,
  type ReferenceReason,
} from './index-config';
import { presetReferences } from './references';
import { inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';
import type { Preset, PresetKind } from './types';

export type FindingSeverity = 'high' | 'medium' | 'low';

/** One name that did not resolve, and why. */
export interface UnresolvedReference {
  name: string;
  reason: ReferenceReason;
  /** Where the thing with that name actually is, when there is one. */
  targetPath?: string;
}

/** The reference a finding is about, for callers that need more than prose. */
export interface FindingReference {
  key: string;
  targetKind?: PresetKind;
  unresolved: UnresolvedReference[];
}

export interface Finding {
  id: string;
  severity: FindingSeverity;
  kind:
    | 'detached'
    | 'redundant-overrides'
    | 'near-duplicate'
    | 'broken-parent'
    | 'circular-inherits'
    | 'orphaned-printer'
    | 'missing-reference'
    | 'duplicate-name'
    | 'parse-error';
  title: string;
  detail: string;
  presetIds: string[];
  /**
   * Files a finding is about that are not presets — a vendor index, or the file
   * a `sub_path` points at and does not find. A finding names presets or paths;
   * one that names neither cannot be acted on.
   */
  paths?: string[];
  /** Set on reference findings, so a caller can style by reason not by wording. */
  reference?: FindingReference;
  /** Sort key within a severity — bigger is more worth looking at. */
  weight: number;
}

/** A user preset large enough that it is clearly a full copy, not a tweak. */
const DETACHED_KEY_THRESHOLD = 40;
/** Effective differences at or below this make two presets near-duplicates. */
const NEAR_DUPLICATE_MAX_DIFFS = 12;

function settingCount(p: Preset): number {
  return Object.keys(p.raw).filter(isSettingKey).length;
}

export function analyze(index: ConfigIndex): Finding[] {
  const findings: Finding[] = [];
  // Sync snapshots under `_local/` are a cache of the cloud profile. They
  // duplicate every synced preset by design, so analysing them would bury the
  // real findings under dozens of "duplicate name" reports that are not faults.
  const userPresets = index.active.filter((p) => p.origin === 'user');

  for (const e of index.parseErrors) {
    findings.push({
      id: `parse:${e.path}`,
      severity: 'high',
      kind: 'parse-error',
      title: `Unreadable file: ${e.path.split('/').pop()}`,
      detail: `This file is not valid JSON and the slicer will ignore it. ${e.message}`,
      presetIds: [],
      weight: 1000,
    });
  }

  // Files that lose a name clash are never loaded, so every other observation
  // about them is moot — reporting a dead file as "a detached copy" invites
  // someone to go and fix a file the slicer has never read. The graph needs the
  // same set, so the rule lives in `shadowedIds` rather than here.
  const shadowed = shadowedIds(index);

  // When a name is claimed more than once, a title using only the name is
  // ambiguous — say which file it is.
  const nameCount = new Map<string, number>();
  for (const p of index.active) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const label = (p: Preset) =>
    (nameCount.get(p.name) ?? 0) > 1 ? `${p.name} (${p.path.split('/').pop()})` : p.name;

  for (const p of userPresets) {
    if (shadowed.has(p.id)) continue;
    const { missingParent, circular } = inheritanceChain(index, p);
    const count = settingCount(p);

    if (circular) {
      findings.push({
        id: `circular:${p.id}`,
        severity: 'high',
        kind: 'circular-inherits',
        title: `${label(p)} inherits in a loop`,
        detail: 'Following `inherits` came back to a preset already in the chain, so resolution stopped early.',
        presetIds: [p.id],
        weight: 900,
      });
    }

    if (missingParent) {
      const r = classifyReference(index, p, p.kind, missingParent);
      const near = r.others[0];
      findings.push({
        id: `broken:${p.id}`,
        severity: 'high',
        kind: 'broken-parent',
        title: `${label(p)} inherits from a missing preset`,
        detail: `It declares \`inherits: "${missingParent}"\`, but ${reasonClause(missingParent, r.reason, near)}. Every value that parent would have supplied is simply absent.`,
        presetIds: [p.id],
        reference: {
          key: 'inherits',
          targetKind: p.kind,
          unresolved: [{ name: missingParent, reason: r.reason, targetPath: near?.path }],
        },
        weight: 800,
      });
    }

    if (!p.inherits && count >= DETACHED_KEY_THRESHOLD) {
      findings.push({
        id: `detached:${p.id}`,
        severity: 'medium',
        kind: 'detached',
        title: `${label(p)} is a detached full copy (${count} settings)`,
        detail:
          'It has no parent, so it stores every setting itself. Vendor updates will never reach it, and there is no way to see which values you deliberately changed.',
        presetIds: [p.id],
        weight: count,
      });
    }

    if (p.inherits) {
      const { redundant, effective } = ownOverrides(index, p);
      if (redundant.length > 0) {
        findings.push({
          id: `redundant:${p.id}`,
          severity: 'low',
          kind: 'redundant-overrides',
          title: `${label(p)} has ${redundant.length} override${redundant.length === 1 ? '' : 's'} that change nothing`,
          detail: `${redundant.length} of ${redundant.length + effective.length} overrides repeat the inherited value. Removing them would leave ${effective.length} real change${effective.length === 1 ? '' : 's'}.`,
          presetIds: [p.id],
          weight: redundant.length,
        });
      }
    }
  }

  findings.push(...referenceFindings(index, userPresets, shadowed, label));
  findings.push(...vendorIndexFindings(index));

  // A name has to be unique inside the scope the slicer keeps it in — one user
  // profile, or every vendor at once. `clashScope` is that rule; across *profiles*
  // is expected, because the cloud profile mirrors the local one.
  for (const [scope, group] of clashGroups(index)) {
    if (group.length < 2) continue;
    const ordered = loadOrder(group);
    const [winner, ...losers] = ordered;
    const arbitrary = tieIsArbitrary(group);
    const crossVendor =
      scope.startsWith('system:') && new Set(group.map((p) => p.vendor)).size > 1;

    findings.push({
      id: `shadowed:${winner.id}`,
      severity: 'high',
      kind: 'duplicate-name',
      title: crossVendor
        ? `${[...new Set(group.map((p) => p.vendor))].join(' and ')} both ship a preset called "${winner.name}"`
        : `${losers.length} file${losers.length === 1 ? ' is' : 's are'} never loaded: "${winner.name}" is claimed ${group.length} times`,
      detail: crossVendor
        ? // Not the intra-folder rule: each vendor loads into its own bundle, and
          // the bundles are then merged into one collection per type. The merge
          // keeps what is already there and discards the incoming preset of the
          // same name, logging "Found duplicated preset" (PresetBundle.cpp:2292).
          `Two installed vendors declare this name, and OrcaSlicer holds one collection per preset type — so when the bundles are merged, one of ${group
            .map((p) => p.path)
            .join(' and ')} is discarded and never loaded ("Found duplicated preset", PresetBundle.cpp:2292).${
            arbitrary
              ? ' Which one survives depends on the order the vendor files happen to be read in, so it is not safe to predict.'
              : ` The filament library is merged first and always wins, so the one that survives is ${winner.path}.`
          } Uninstall one of the two vendors, or expect one of them to be silently absent.`
        : arbitrary
          ? `${group.length} files declare this name and OrcaSlicer loads exactly one, skipping the rest with "Preset already present, not loading" — so one of ${group
              .map((p) => p.path)
              .join(', ')} has no effect at all. Which one wins is decided by directory order, not by anything in the config, so it is not safe to predict. Rename or delete all but one.`
          : `OrcaSlicer loads ${winner.path} and skips ${losers
              .map((l) => l.path)
              .join(', ')} with "Preset already present, not loading". Editing a skipped file has no effect at all — the settings you see in the slicer come from ${winner.path}.`,
      presetIds: ordered.map((p) => p.id),
      weight: 950,
    });
  }

  findings.push(...findNearDuplicates(index, userPresets.filter((p) => !shadowed.has(p.id))));

  const sevRank: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.weight - a.weight);
  return findings;
}

/**
 * Why a set of names did not resolve, as a clause that can follow "and".
 *
 * The common case is several names failing the same way, and repeating one clause
 * per name reads like a bug. Names are already quoted by the caller, so identical
 * reasons collapse into one clause and a mixed set is attributed name by name.
 */
function reasonsClause(
  index: ConfigIndex,
  unresolved: UnresolvedReference[],
): string {
  const near = (u: UnresolvedReference) => (u.targetPath ? index.byId.get(u.targetPath) : undefined);
  if (unresolved.every((u) => u.reason === 'absent')) {
    return unresolved.length === 1 ? 'which is not installed' : 'none of which is installed';
  }
  const clauses = unresolved.map((u) => reasonClause(u.name, u.reason, near(u)));
  return `but ${[...new Set(clauses)].join('; ')}`;
}

/**
 * Why one name did not resolve, as a clause that can follow "but".
 *
 * Every branch says what to do about it, because the three failures need three
 * different fixes and "not found" tells you which of them none of the time.
 */
function reasonClause(name: string, reason: ReferenceReason, near: Preset | undefined): string {
  switch (reason) {
    case 'unloaded-profile':
      return `a preset named "${name}" does exist, at ${near?.path ?? 'another user folder'} — in \`user/${near?.profile ?? '?'}\`, which OrcaSlicer does not load. Only one user folder is ever loaded (PresetBundle.cpp:528), so that file can never satisfy this reference and editing it changes nothing`;
    case 'wrong-kind':
      return `the only preset named "${name}" is a ${near?.kind ?? 'different'} preset. A name is resolved inside a single \`PresetCollection\`, which holds one preset type (\`find_preset2\`, Preset.cpp:3229), so a ${near?.kind ?? 'different'} preset cannot answer this`;
    case 'absent':
      return `no preset by that name is installed`;
    // A reference that resolves is not a finding; `shadowed` resolves too, and
    // the clash it implies is already reported once as `duplicate-name`.
    case 'resolved':
    case 'shadowed':
      return `it resolves`;
  }
}

/** What breaks, per key, when one of its names does not resolve. */
const CONSEQUENCE: Record<string, string> = {
  compatible_prints:
    'A filament is only offered for a process named in `compatible_prints` (`is_compatible_with_print`, Preset.cpp:771-791), so it will never be selectable with that one.',
  default_print_profile:
    'That is the process preset the slicer switches to when this printer is selected. When the name does not resolve it silently selects the first visible preset instead — no warning, no indication that your default was ignored (`select_preset_by_name`, Preset.cpp:3606-3613, called from PresetBundle.cpp:2143).',
  default_filament_profile:
    'That is the filament the slicer switches to when this printer is selected, and only the first entry is used (PresetBundle.cpp:2163-2166). When it does not resolve the slicer silently falls back to the first visible filament instead.',
};

/**
 * Every reference other than `inherits`, checked in both serialisations.
 *
 * `compatible_printers` keeps its own finding kind — it is the one the UI already
 * labels, and "limited to printers that no longer exist" is a sharper sentence
 * than any generic wording. Everything else is `missing-reference`.
 */
function referenceFindings(
  index: ConfigIndex,
  presets: Preset[],
  shadowed: Set<string>,
  label: (p: Preset) => string,
): Finding[] {
  const out: Finding[] = [];

  // A `compatible_printers` entry naming a preset that is not installed is still
  // satisfied by any **user** printer that inherits that name: the slicer checks
  // the active printer's `inherits` as well as its name
  // (`is_compatible_with_parent_printer`, Preset.cpp:798-806, reached from
  // Preset.cpp:840). Reporting those would be inventing a fault.
  const inheritedByAMachine = new Set(
    index.active
      .filter((p) => p.kind === 'machine' && p.origin === 'user' && p.inherits)
      .map((p) => p.inherits as string),
  );

  for (const p of presets) {
    if (shadowed.has(p.id)) continue;

    const groups = new Map<
      string,
      { targetKind: PresetKind; total: number; unresolved: UnresolvedReference[] }
    >();
    for (const ref of presetReferences(p)) {
      if (ref.key === 'inherits') continue; // reported as `broken-parent`
      const g = groups.get(ref.key) ?? { targetKind: ref.targetKind, total: 0, unresolved: [] };
      g.total++;
      groups.set(ref.key, g);
      if (ref.key === 'compatible_printers' && inheritedByAMachine.has(ref.name)) continue;
      const r = classifyReference(index, p, ref.targetKind, ref.name);
      if (r.reason === 'resolved' || r.reason === 'shadowed') continue;
      g.unresolved.push({ name: ref.name, reason: r.reason, targetPath: r.others[0]?.path });
    }

    for (const [key, g] of groups) {
      if (g.unresolved.length === 0) continue;
      const quoted = g.unresolved.map((u) => `"${u.name}"`).join(', ');
      const why = reasonsClause(index, g.unresolved);
      const all = g.unresolved.length === g.total;
      const reference: FindingReference = { key, targetKind: g.targetKind, unresolved: g.unresolved };

      if (key === 'compatible_printers') {
        out.push(
          all
            ? {
                id: `orphan:${p.id}`,
                severity: 'medium',
                kind: 'orphaned-printer',
                title: `${label(p)} is limited to printers that no longer exist`,
                detail: `\`compatible_printers\` names ${quoted}, ${why}. A non-empty \`compatible_printers\` excludes every printer it does not name (Preset.cpp:809-841), so this preset will not appear for any printer at all.`,
                presetIds: [p.id],
                reference,
                weight: 500,
              }
            : {
                id: `orphan-partial:${p.id}`,
                severity: 'low',
                kind: 'orphaned-printer',
                title: `${label(p)} references ${g.unresolved.length} missing printer${g.unresolved.length === 1 ? '' : 's'}`,
                detail: `Of the ${g.total} printers in \`compatible_printers\`, ${quoted} ${g.unresolved.length === 1 ? 'does' : 'do'} not resolve — ${why}. The preset still appears for the others.`,
                presetIds: [p.id],
                reference,
                weight: 100,
              },
        );
        continue;
      }

      out.push({
        id: `ref:${key}:${p.id}`,
        severity: all ? 'medium' : 'low',
        kind: 'missing-reference',
        title: `${label(p)} points \`${key}\` at ${g.unresolved.length === 1 ? 'a preset that does not resolve' : `${g.unresolved.length} presets that do not resolve`}`,
        detail: `\`${key}\` names ${quoted}, ${why}. ${CONSEQUENCE[key] ?? ''}`.trim(),
        presetIds: [p.id],
        reference,
        weight: all ? 400 : 90,
      });
    }
  }

  return out;
}

/**
 * The vendor index as a promise the install has to keep.
 *
 * `system/<Vendor>.json` is the list the slicer loads from, so an entry whose
 * `sub_path` is not on disk is not a stale note — that preset does not exist. Two
 * findings come out of it, and the model one is the more serious:
 *
 *  - a preset entry with no file: that name is simply unavailable.
 *  - a `machine_model_list` entry with no file: the model has no variants, so it
 *    is never registered at all (PresetBundle.cpp:4819) — and **every** printer
 *    preset naming it in `printer_model` is then rejected outright
 *    (PresetBundle.cpp:4988).
 *
 * Also here: a system printer preset whose `printer_model` / `printer_variant`
 * its own vendor does not declare. Vendor-scoped, and system-only — a user
 * printer preset is checked against a `Custom` vendor synthesised from its own
 * values (PresetBundle.cpp:2395-2416), which it cannot fail.
 */
function vendorIndexFindings(index: ConfigIndex): Finding[] {
  const out: Finding[] = [];

  for (const ref of index.vendorRefs) {
    if (ref.present) continue;
    const isModel = ref.list === 'machine_model_list';
    out.push({
      id: `vendor-missing:${ref.path}`,
      severity: isModel ? 'high' : 'medium',
      kind: 'missing-reference',
      title: isModel
        ? `${ref.vendor} declares printer model "${ref.name}" but its file is missing`
        : `${ref.vendor} declares "${ref.name}" but its file is missing`,
      detail: isModel
        ? `\`system/${ref.vendor}.json\` lists this model with \`sub_path: "${ref.subPath}"\`, and there is no file at ${ref.path}. A model with no variants is never registered (PresetBundle.cpp:4819), so every printer preset whose \`printer_model\` is "${ref.name}" is rejected on load — "defines invalid printer model … it will be ignored" (PresetBundle.cpp:4988).`
        : `\`system/${ref.vendor}.json\` lists this preset in \`${ref.list}\` with \`sub_path: "${ref.subPath}"\`, and there is no file at ${ref.path}. The name appears in the vendor's index and nowhere else, so anything inheriting from it or naming it has nothing to resolve to.`,
      presetIds: [],
      paths: [`system/${ref.vendor}.json`, ref.path],
      reference: {
        key: ref.list,
        unresolved: [{ name: ref.name, reason: 'absent' }],
      },
      weight: isModel ? 880 : 450,
    });
  }

  const modelsByVendor = new Map<string, Map<string, string[]>>();
  for (const m of index.vendorModels) {
    const byId = modelsByVendor.get(m.vendor) ?? new Map<string, string[]>();
    byId.set(m.id, m.variants);
    modelsByVendor.set(m.vendor, byId);
  }

  for (const p of index.presets) {
    if (p.origin !== 'system' || p.kind !== 'machine' || !p.vendor) continue;
    // A preset marked `instantiation: "false"` is a base for others to inherit,
    // not a printer you can select. It is stored and returned before the model
    // check ever runs (PresetBundle.cpp:4928), so `fdm_machine_common` having no
    // `printer_model` is correct rather than broken.
    if (p.raw.instantiation === 'false') continue;
    const declared = modelsByVendor.get(p.vendor);
    // A vendor with no `machine_model_list` at all is a different (and much
    // louder) problem than one model missing; do not report every preset twice.
    if (!declared || declared.size === 0) continue;
    const model = typeof p.raw.printer_model === 'string' ? p.raw.printer_model : '';
    const variant = typeof p.raw.printer_variant === 'string' ? p.raw.printer_variant : '';

    if (model === '' || !declared.has(model)) {
      out.push({
        id: `printer-model:${p.id}`,
        severity: 'high',
        kind: 'missing-reference',
        title:
          model === ''
            ? `${p.name} declares no printer_model, so it is never loaded`
            : `${p.name} names a printer model ${p.vendor} does not declare`,
        detail:
          model === ''
            ? `A printer preset in a vendor bundle with an empty \`printer_model\` is dropped on load — "defines no printer model, it will be ignored" (PresetBundle.cpp:4972). It will not appear in the slicer at all.`
            : `\`printer_model\` is "${model}", and \`system/${p.vendor}.json\` declares ${[...declared.keys()].map((k) => `"${k}"`).join(', ')}. The match is against the entry name in that vendor's own \`machine_model_list\` (PresetBundle.cpp:4718), so this preset is dropped on load — "defines invalid printer model … it will be ignored" (PresetBundle.cpp:4988).`,
        presetIds: [p.id],
        reference: {
          key: 'printer_model',
          unresolved: [{ name: model, reason: 'absent' }],
        },
        weight: 870,
      });
      continue;
    }

    const variants = declared.get(model) ?? [];
    if (variants.length > 0 && (variant === '' || !variants.includes(variant))) {
      out.push({
        id: `printer-variant:${p.id}`,
        severity: 'high',
        kind: 'missing-reference',
        title:
          variant === ''
            ? `${p.name} declares no printer_variant, so it is never loaded`
            : `${p.name} names a printer variant "${model}" does not have`,
        detail:
          variant === ''
            ? `A printer preset in a vendor bundle with an empty \`printer_variant\` is dropped on load — "defines no printer variant, it will be ignored" (PresetBundle.cpp:4981).`
            : `\`printer_variant\` is "${variant}", and the model file for "${model}" lists ${variants.map((v) => `"${v}"`).join(', ')} in its \`nozzle_diameter\` (PresetBundle.cpp:4739-4747). A variant that is not one of those means the preset is dropped on load — "defines invalid printer variant … it will be ignored" (PresetBundle.cpp:4997).`,
        presetIds: [p.id],
        reference: {
          key: 'printer_variant',
          unresolved: [{ name: variant, reason: 'absent' }],
        },
        weight: 860,
      });
    }
  }

  return out;
}

/**
 * Pairs of user presets that resolve to nearly the same thing. Compared on
 * *effective* settings, so a sparse preset and a detached copy of the same
 * thing are still recognised as the pair they are.
 */
export function findNearDuplicates(index: ConfigIndex, presets: Preset[]): Finding[] {
  const out: Finding[] = [];
  const byKind = new Map<string, Preset[]>();
  for (const p of presets) {
    const g = byKind.get(p.kind);
    if (g) g.push(p);
    else byKind.set(p.kind, [p]);
  }

  for (const [, group] of byKind) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const d = diffEffective(index, a, b);
        const real = d.rows.filter((r) => r.status !== 'cosmetic');
        if (real.length === 0) {
          out.push({
            id: `identical:${a.id}|${b.id}`,
            severity: 'medium',
            kind: 'near-duplicate',
            title: `"${a.name}" and "${b.name}" are identical in effect`,
            detail: `Every one of the ${d.compared} settings resolves the same${d.cosmetic > 0 ? `, though ${d.cosmetic} are written differently on disk` : ''}. One of them is redundant.`,
            presetIds: [a.id, b.id],
            weight: 700,
          });
        } else if (real.length <= NEAR_DUPLICATE_MAX_DIFFS) {
          const keys = real.slice(0, 5).map((r) => r.key);
          out.push({
            id: `near:${a.id}|${b.id}`,
            severity: 'low',
            kind: 'near-duplicate',
            title: `"${a.name}" and "${b.name}" differ in only ${real.length} setting${real.length === 1 ? '' : 's'}`,
            detail: `Of ${d.compared} settings compared, ${real.length} differ: ${keys.join(', ')}${real.length > keys.length ? ', …' : ''}.${d.cosmetic > 0 ? ` A further ${d.cosmetic} differ only in how they are written.` : ''}`,
            presetIds: [a.id, b.id],
            weight: 300 - real.length,
          });
        }
      }
    }
  }

  return out;
}

export interface ConfigStats {
  system: number;
  user: number;
  /** Cloud sync snapshots under `_local/`, indexed but excluded everywhere else. */
  snapshots: number;
  vendors: number;
  byKind: Record<string, { system: number; user: number }>;
  deepestChain: { name: string; depth: number } | null;
}

export function stats(index: ConfigIndex): ConfigStats {
  const byKind: Record<string, { system: number; user: number }> = {};
  for (const p of index.active) {
    byKind[p.kind] ??= { system: 0, user: 0 };
    byKind[p.kind][p.origin]++;
  }
  let deepest: { name: string; depth: number } | null = null;
  for (const p of index.active) {
    const d = resolve(index, p).chain.length;
    if (!deepest || d > deepest.depth) deepest = { name: p.name, depth: d };
  }
  return {
    system: index.active.filter((p) => p.origin === 'system').length,
    user: index.active.filter((p) => p.origin === 'user').length,
    snapshots: index.presets.length - index.active.length,
    vendors: index.vendors.length,
    byKind,
    deepestChain: deepest,
  };
}
