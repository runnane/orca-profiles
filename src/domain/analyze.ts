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
 *  - broken-parent `inherits` naming a preset the slicer cannot resolve — either
 *                  nothing has that name, or the file that does is one the slicer
 *                  itself never loads. The second reads as "but it is right
 *                  there", and is the case that used to be reported as *redundant
 *                  overrides* instead: with the parent silently absent, every
 *                  value in the child is the only value it has.
 *  - not-loaded    a file the slicer skips outright, so nothing in it takes
 *                  effect. `index.notLoaded` carries the gate it hit.
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
  FILAMENT_LIBRARY_VENDOR,
  loadOrder,
  notLoadedIds,
  tieIsArbitrary,
  type ConfigIndex,
  type LoadFailure,
  type ReferenceReason,
} from './index-config';
import { declaredVersion } from './preset-version';
import { presetReferences } from './references';
import { chainLookup, inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';
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
    | 'not-loaded'
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

  // Files the slicer never loads, so every other observation about them is moot —
  // reporting a dead file as "a detached copy" invites someone to go and fix a file
  // the slicer has never read. The graph needs the same set, so the rule lives in
  // `notLoadedPresets` rather than here.
  //
  // This is the suppression ORCA-17 is about, and it matters as much as the finding:
  // a preset whose parent never loads has *only* its own values, so calling those
  // "overrides that change nothing" is exactly backwards, and calling two such
  // presets "identical in effect" asserts an equivalence about two files the slicer
  // does not have.
  const shadowed = notLoadedIds(index);

  // When a name is claimed more than once, a title using only the name is
  // ambiguous — say which file it is.
  const nameCount = new Map<string, number>();
  for (const p of index.active) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const label = (p: Preset) =>
    (nameCount.get(p.name) ?? 0) > 1 ? `${p.name} (${p.path.split('/').pop()})` : p.name;

  for (const p of userPresets) {
    const failure = index.notLoaded.get(p.id);
    // A clash loser is already reported once, as `duplicate-name`, with the winner
    // named — a second finding about the same file would say less.
    if (failure?.reason === 'name-clash') continue;

    if (failure?.reason === 'bad-version') {
      const declared = declaredVersion(p.raw);
      findings.push({
        id: `not-loaded:${p.id}`,
        severity: 'high',
        kind: 'not-loaded',
        title: `${label(p)} is never loaded: ${declared === '' ? 'it has no `version`' : '`version` is not a version'}`,
        detail:
          `${
            declared === ''
              ? 'The file has no `version` key.'
              : `\`version\` is "${declared}", which the slicer's version parser rejects — it needs at least \`major.minor\`, all numeric.`
          } OrcaSlicer parses \`version\` before it does anything else with a user preset and skips the file when the parse fails, with no error and no log line (Preset.cpp:1653-1655). ` +
          'So this preset is not selectable, nothing in it has any effect, and it cannot be inherited from. ' +
          'Adding a valid `version` — the slicer writes one itself on every save — is the whole fix.',
        presetIds: [p.id],
        weight: 990,
      });
      continue;
    }

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
      const r = classifyReference(index, p, p.kind, missingParent, 'inherits');
      const near = r.others[0];
      findings.push({
        id: `broken:${p.id}`,
        severity: 'high',
        kind: 'broken-parent',
        title:
          r.reason === 'not-loaded'
            ? `${label(p)} inherits from a preset the slicer does not load`
            : `${label(p)} inherits from a missing preset`,
        detail: `It declares \`inherits: "${missingParent}"\`, but ${reasonClause(missingParent, r.reason, near, near && index.notLoaded.get(near.id))}. ${
          // The child is not partially loaded and then patched: `load_presets`
          // `continue`s on it, so the whole preset is gone from the slicer.
          'OrcaSlicer does not load the child either — it logs "can not find parent", counts an error and skips the file entirely (Preset.cpp:1686-1691) — so this preset is not selectable, and anything inheriting *it* fails the same way.'
        }`,
        presetIds: [p.id],
        reference: {
          key: 'inherits',
          targetKind: p.kind,
          unresolved: [{ name: missingParent, reason: r.reason, targetPath: near?.path }],
        },
        weight: 800,
      });
      // `broken-parent` has said everything true about this file. What follows is
      // advice about its contents, and its contents do not take effect.
      continue;
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
  findings.push(...crossVendorInheritFindings(index));

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
  const clauses = unresolved.map((u) => {
    const n = near(u);
    return reasonClause(u.name, u.reason, n, n && index.notLoaded.get(n.id));
  });
  return `but ${[...new Set(clauses)].join('; ')}`;
}

/**
 * Why one name did not resolve, as a clause that can follow "but".
 *
 * Every branch says what to do about it, because the three failures need three
 * different fixes and "not found" tells you which of them none of the time.
 */
function reasonClause(
  name: string,
  reason: ReferenceReason,
  near: Preset | undefined,
  failure?: LoadFailure,
): string {
  switch (reason) {
    case 'not-loaded':
      // The one case where "it is not installed" would be read as a lie: the file is
      // in the folder the slicer loads, under the right name, and is still not there
      // as far as the slicer is concerned. Say which gate it hit, because the fix is
      // different for each.
      return `the file that claims that name — ${near?.path ?? 'in this profile'} — is one OrcaSlicer skips${
        failure?.reason === 'bad-version'
          ? ', because its `version` does not parse and a user preset with an unparseable `version` is dropped silently (Preset.cpp:1653-1655). Give that file a valid `version` and this reference starts working'
          : failure?.reason === 'parent-not-loaded'
            ? `, because its own \`inherits\` (\`"${failure.parentName ?? ''}"\`) does not resolve, so it is skipped too (Preset.cpp:1686-1691). This chain has to be fixed from the top down — repairing the parent's parent repairs both`
            : ', because it lost a name clash and was never loaded ("Preset already present, not loading", Preset.cpp:1619)'
      }`;
    case 'unloaded-profile':
      return `a preset named "${name}" does exist, at ${near?.path ?? 'another user folder'} — in \`user/${near?.profile ?? '?'}\`, which OrcaSlicer does not load. Only one user folder is ever loaded (PresetBundle.cpp:528), so that file can never satisfy this reference and editing it changes nothing`;
    case 'wrong-kind':
      return `the only preset named "${name}" is a ${near?.kind ?? 'different'} preset. A name is resolved inside a single \`PresetCollection\`, which holds one preset type (\`find_preset2\`, Preset.cpp:3229), so a ${near?.kind ?? 'different'} preset cannot answer this`;
    case 'other-vendor':
      // The name exists, in the config, spelled right, and is still unreachable.
      // Worth its own wording because the fix is neither "install it" nor "rename
      // it" — the parent has to be moved, or duplicated into this vendor.
      return `"${name}" belongs to ${near?.vendor ?? 'another vendor'}, and a vendor's \`inherits\` is resolved against its **own** bundle plus \`${FILAMENT_LIBRARY_VENDOR}\` and nothing else — "The remaining vendors are independent (no cross-vendor inheritance)" (PresetBundle.cpp:2216-2219). ${
        near?.kind === 'filament'
          ? `Only ${FILAMENT_LIBRARY_VENDOR} is shared, so moving this base there would make it reachable`
          : `The shared bundle carries filament bases only — its config maps are handed over right after the filament loop (PresetBundle.cpp:5147-5151) — so a ${near?.kind ?? 'non-filament'} base cannot be shared at all and this vendor needs its own copy`
      }`;
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
/**
 * What one of `parse_subfile`'s printer guards actually costs, said once.
 *
 * The log text these guards emit is `"… it will be ignored"`, and the comment
 * above them says "These presets are considered not installed"
 * (PresetBundle.cpp:4970-4971). Both are wrong about the consequence, and the
 * finding used to repeat them. Each guard `return`s a non-empty `reason`, and the
 * machine loop turns that into a throw for the **whole vendor**:
 *
 * ```cpp
 * if (!reason.empty()) {
 *     ++m_errors;
 *     throw ConfigurationError(…);
 * }
 * ```
 * — PresetBundle.cpp:5161-5167
 *
 * The vendor is loaded into a temporary `PresetBundle` (:2253) which is merged
 * into the app's only when nothing threw (:2271-2283), so the whole bundle goes.
 * Marking the vendor's presets as not-loaded off the back of this is ORCA-27; the
 * wording is corrected here because leaving a sentence in place that I know
 * understates the damage by a whole bundle is not a smaller change than fixing it.
 */
const BUNDLE_ABORT = (vendor: string, line: number, logText: string): string =>
  `A vendor printer preset that fails this check does not merely go missing: \`parse_subfile\` returns a reason (PresetBundle.cpp:${line}, logged as "${logText} … it will be ignored") and the machine loop raises a \`ConfigurationError\` for **${vendor}'s entire bundle** (PresetBundle.cpp:5161-5167), which is then never merged (PresetBundle.cpp:2271-2283). The log line understates it; every preset ${vendor} ships is absent from the slicer.`;

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
    // Its whole bundle is gone, which `cross-vendor-inherits` already says at the
    // vendor level. A second finding blaming this file's `printer_model` would
    // send someone to fix a preset that is absent for a different reason.
    if (index.notLoaded.get(p.id)?.reason === 'bundle-failed') continue;
    // A preset marked `instantiation: "false"` is a base for others to inherit,
    // not a printer you can select. It is stored and returned before the model
    // check ever runs (PresetBundle.cpp:4928), so `fdm_machine_common` having no
    // `printer_model` is correct rather than broken.
    if (p.raw.instantiation === 'false') continue;
    const declared = modelsByVendor.get(p.vendor);
    // A vendor with no `machine_model_list` at all is a different (and much
    // louder) problem than one model missing; do not report every preset twice.
    if (!declared || declared.size === 0) continue;
    // **Off the chain, not off the file.** This is what ORCA-19 was about: the
    // guard reads `config.opt_string("printer_model")` *after*
    //
    //     config = *default_config;      // the parent's config, out of config_maps
    //     config.apply(config_src);      // this file's own keys over the top
    //                                      — PresetBundle.cpp:4926-4927
    //
    // so it sees the **inherited** value. Reading `p.raw` instead reported every
    // printer preset that leaves `printer_variant` to its vendor base — which is
    // most of them — and produced 28 `HIGH` findings on one real config, all
    // false. That they are false is also why OrcaSlicer's log had no matching
    // line: `BOOST_LOG_TRIVIAL(error)` is well above the default level
    // (PresetBundle.cpp:4975, :4983), so a real hit would have been recorded.
    const look = chainLookup(index, p);
    const settingText = (key: string): string => {
      const v = look(key)?.value;
      if (v === undefined) return '';
      return Array.isArray(v) ? String(v[0] ?? '').trim() : String(v).trim();
    };
    const model = settingText('printer_model');
    const variant = settingText('printer_variant');

    if (model === '' || !declared.has(model)) {
      out.push({
        id: `printer-model:${p.id}`,
        severity: 'high',
        kind: 'missing-reference',
        title:
          model === ''
            ? `${p.name} declares no printer_model, so ${p.vendor}'s whole bundle fails to load`
            : `${p.name} names a printer model ${p.vendor} does not declare`,
        detail:
          `${
            model === ''
              ? `Neither this file nor anything it inherits from sets \`printer_model\`.`
              : `\`printer_model\` resolves to "${model}", and \`system/${p.vendor}.json\` declares ${[...declared.keys()].map((k) => `"${k}"`).join(', ')}. The match is against the entry name in that vendor's own \`machine_model_list\` (PresetBundle.cpp:4718).`
          } ${BUNDLE_ABORT(p.vendor, model === '' ? 4972 : 4988, model === '' ? 'defines no printer model' : 'defines invalid printer model')}`,
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
            ? `${p.name} declares no printer_variant, so ${p.vendor}'s whole bundle fails to load`
            : `${p.name} names a printer variant "${model}" does not have`,
        detail:
          `${
            variant === ''
              ? `Neither this file nor anything it inherits from sets \`printer_variant\`.`
              : `\`printer_variant\` resolves to "${variant}", and the model file for "${model}" lists ${variants.map((v) => `"${v}"`).join(', ')} in its \`nozzle_diameter\` (PresetBundle.cpp:4739-4747).`
          } ${BUNDLE_ABORT(p.vendor, variant === '' ? 4981 : 4997, variant === '' ? 'defines no printer variant' : 'defines invalid printer variant')}`,
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
 * A vendor preset whose `inherits` reaches outside its own bundle.
 *
 * The only reference check that runs over **system** presets, and it is here rather
 * than folded into `broken-parent` because the consequence is a different size:
 * `parse_subfile` returns `"Can not find inherits"` (PresetBundle.cpp:4913-4916) and
 * the caller raises a `ConfigurationError` for that vendor's **whole bundle**
 * (:5121-5130). So this is not one preset going missing, it is every preset the
 * vendor ships.
 *
 * Only `other-vendor` is reported. A vendor base naming something genuinely absent
 * is a broken install rather than a modelling question, and `vendorIndexFindings`
 * already covers the index side of that.
 */
function crossVendorInheritFindings(index: ConfigIndex): Finding[] {
  const out: Finding[] = [];
  // Grouped by vendor: the failure is per bundle, so N presets in one vendor
  // reaching outside it is one thing to fix, not N findings saying the same.
  const byVendor = new Map<string, { preset: Preset; parent: Preset; name: string }[]>();

  for (const p of index.active) {
    if (p.origin !== 'system' || !p.inherits || !p.vendor) continue;
    const r = classifyReference(index, p, p.kind, p.inherits, 'inherits');
    if (r.reason !== 'other-vendor') continue;
    const parent = r.others[0];
    if (!parent) continue;
    byVendor.set(p.vendor, [...(byVendor.get(p.vendor) ?? []), { preset: p, parent, name: p.inherits }]);
  }

  for (const [vendor, hits] of byVendor) {
    const owners = [...new Set(hits.map((h) => h.parent.vendor ?? '?'))].sort();
    const first = hits[0];
    // What actually disappears, so the number in the finding is the number the
    // sidebar and the counts now show as not loaded rather than a rounder claim.
    const lost = index.active.filter((p) => p.vendor === vendor && p.origin === 'system');
    const lostModels = index.vendorModels.filter((m) => m.vendor === vendor);
    const byKind = (['machine', 'filament', 'process'] as PresetKind[])
      .map((k) => ({ k, n: lost.filter((p) => p.kind === k).length }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} ${x.k}${x.n === 1 ? '' : 's'}`);
    out.push({
      id: `cross-vendor-inherits:${vendor}`,
      severity: 'high',
      kind: 'missing-reference',
      title:
        hits.length === 1
          ? `${vendor}'s "${first.preset.name}" inherits from ${owners.join(' and ')}, which its bundle cannot see`
          : `${hits.length} ${vendor} presets inherit from ${owners.join(' and ')}, which its bundle cannot see`,
      detail: `${hits
        .slice(0, 4)
        .map((h) => `\`${h.preset.name}\` names "${h.name}"`)
        .join(', ')}${hits.length > 4 ? ', …' : ''}. Each vendor is loaded into its own bundle and resolves \`inherits\` against that bundle plus \`${FILAMENT_LIBRARY_VENDOR}\` only — "The remaining vendors are independent (no cross-vendor inheritance)" (PresetBundle.cpp:2216-2219). A name it cannot find is not a preset with an odd parent: \`parse_subfile\` returns "Can not find inherits" (PresetBundle.cpp:4913-4916) and the caller raises a \`ConfigurationError\` for **${vendor}'s entire bundle** (PresetBundle.cpp:5121-5130), so every preset this vendor ships is absent from the slicer, not just ${hits.length === 1 ? 'this one' : 'these'}. That is ${byKind.join(', ')}${
        lostModels.length > 0
          ? `, and ${lostModels.length} printer model${lostModels.length === 1 ? '' : 's'} — the models are emplaced into the same temporary bundle before any preset is read (PresetBundle.cpp:4824) and only reach the app through the merge that never happens (PresetBundle.cpp:2422)`
          : ''
      }. Anything of yours inheriting from ${vendor} is skipped too. Move the base into \`${FILAMENT_LIBRARY_VENDOR}\`, give ${vendor} its own copy, or uninstall ${vendor}.`,
      presetIds: hits.map((h) => h.preset.id),
      paths: [`system/${vendor}.json`],
      reference: {
        key: 'inherits',
        targetKind: first.preset.kind,
        unresolved: hits.map((h) => ({
          name: h.name,
          reason: 'other-vendor' as const,
          targetPath: h.parent.path,
        })),
      },
      weight: 985,
    });
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

/**
 * The headline numbers, counted the way the slicer would count them.
 *
 * `system`, `user` and `byKind` are **loaded** presets: a file in
 * `index.notLoaded` is on disk and absent from the slicer, and counting it here
 * is how a config reads as bigger than the one the slicer has. `notLoaded` is the
 * difference, reported rather than swallowed — a vendor that vanishes with no
 * number next to it is worse than one that is wrongly counted.
 */
export interface ConfigStats {
  /** Selectable vendor presets. Excludes `instantiation: "false"` bases. */
  system: number;
  user: number;
  /**
   * Vendor bases — `instantiation: "false"` — which are inheritance sources and not
   * presets. Reported rather than merely subtracted: a number that dropped with no
   * explanation reads as presets having gone missing.
   */
  bases: number;
  /** Active files the slicer skips, whatever the gate. See `index.notLoaded`. */
  notLoaded: number;
  /** Vendors whose entire bundle failed, so every preset they ship is in `notLoaded`. */
  failedVendors: string[];
  /** Cloud sync snapshots under `_local/`, indexed but excluded everywhere else. */
  snapshots: number;
  /** Vendors with a bundle on disk. `failedVendors` is a subset. */
  vendors: number;
  byKind: Record<string, { system: number; user: number }>;
  deepestChain: { name: string; depth: number } | null;
}

export function stats(index: ConfigIndex): ConfigStats {
  const loaded = index.active.filter((p) => !index.notLoaded.has(p.id));
  const byKind: Record<string, { system: number; user: number }> = {};
  // Counted over selectable presets only. A vendor base is not a preset you could
  // pick — it is never added to a collection at all (PresetBundle.cpp:4929-4941) —
  // and on a config with several vendors installed the `fdm_*` set is a large
  // fraction of the "System presets" figure and the `Presets N` badge.
  //
  // Off `loaded` rather than `index.active`, so the two subtractions compose: a
  // base in a vendor bundle that threw is neither selectable nor a base the
  // slicer holds, and it must not be counted by either figure.
  const selectable = loaded.filter((p) => p.instantiable);
  for (const p of selectable) {
    byKind[p.kind] ??= { system: 0, user: 0 };
    byKind[p.kind][p.origin]++;
  }
  // The deepest chain is measured over **everything**, bases included: a base is a
  // real root carrying real settings, and the chains it roots are exactly what that
  // number is about. Dropping it here would understate every depth by one.
  let deepest: { name: string; depth: number } | null = null;
  // Off the loaded set too: a chain running through a file the slicer skipped is
  // not a chain the slicer has.
  for (const p of loaded) {
    const d = resolve(index, p).chain.length;
    if (!deepest || d > deepest.depth) deepest = { name: p.name, depth: d };
  }
  return {
    system: selectable.filter((p) => p.origin === 'system').length,
    user: selectable.filter((p) => p.origin === 'user').length,
    bases: loaded.length - selectable.length,
    notLoaded: index.active.length - loaded.length,
    failedVendors: [...index.failedVendors.keys()].sort(),
    snapshots: index.presets.length - index.active.length,
    vendors: index.vendors.length,
    byKind,
    deepestChain: deepest,
  };
}
