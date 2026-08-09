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
 *  - duplicate-name  two files claiming one name. The slicer loads the first and
 *                  **never loads the rest** — so a file can be edited forever
 *                  with no effect. Three files claim "ABS fast" here.
 *
 * Everything is judged against the presets the slicer actually loads: one user
 * folder, never two, and never the `_local/` sync snapshots.
 */

import { diffEffective } from './diff';
import { loadOrder, shadowedIds, tieIsArbitrary, type ConfigIndex } from './index-config';
import { inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';
import type { Preset } from './types';

export type FindingSeverity = 'high' | 'medium' | 'low';

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
    | 'duplicate-name'
    | 'parse-error';
  title: string;
  detail: string;
  presetIds: string[];
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
      findings.push({
        id: `broken:${p.id}`,
        severity: 'high',
        kind: 'broken-parent',
        title: `${label(p)} inherits from a missing preset`,
        detail: `It declares \`inherits: "${missingParent}"\`, but no preset by that name is installed. Every value that parent would have supplied is simply absent.`,
        presetIds: [p.id],
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

  // Machines that exist, for the compatible_printers check.
  const machineNames = new Set(
    index.active.filter((p) => p.kind === 'machine').map((p) => p.name),
  );
  for (const p of userPresets) {
    if (p.kind === 'machine' || shadowed.has(p.id)) continue;
    const cp = p.raw.compatible_printers;
    const list = Array.isArray(cp) ? cp : undefined;
    if (!list || list.length === 0) continue;
    const missing = list.filter((n) => n && !machineNames.has(n));
    if (missing.length === list.length) {
      findings.push({
        id: `orphan:${p.id}`,
        severity: 'medium',
        kind: 'orphaned-printer',
        title: `${label(p)} is limited to printers that no longer exist`,
        detail: `\`compatible_printers\` names ${missing.map((m) => `"${m}"`).join(', ')}, none of which is installed. The preset will not appear for any printer.`,
        presetIds: [p.id],
        weight: 500,
      });
    } else if (missing.length > 0) {
      findings.push({
        id: `orphan-partial:${p.id}`,
        severity: 'low',
        kind: 'orphaned-printer',
        title: `${label(p)} references ${missing.length} missing printer${missing.length === 1 ? '' : 's'}`,
        detail: `Not installed: ${missing.map((m) => `"${m}"`).join(', ')}.`,
        presetIds: [p.id],
        weight: 100,
      });
    }
  }

  // Duplicate names within one profile. Across profiles is expected — the cloud
  // profile mirrors the local one — so only a clash inside a single profile is
  // an ambiguity the slicer has to break arbitrarily.
  const nameGroups = new Map<string, Preset[]>();
  for (const p of index.active) {
    const k = `${p.origin}:${p.profile ?? p.vendor ?? ''}:${p.kind}:${p.name}`;
    const g = nameGroups.get(k);
    if (g) g.push(p);
    else nameGroups.set(k, [p]);
  }
  for (const [, group] of nameGroups) {
    if (group.length < 2) continue;
    // The slicer loads system bundles, then `base/`, then the rest of the
    // folder, and refuses any name it already has. So this is not a tie the
    // slicer breaks arbitrarily — every file after the first is never loaded.
    const ordered = loadOrder(group);
    const [winner, ...losers] = ordered;
    const arbitrary = tieIsArbitrary(group);
    findings.push({
      id: `shadowed:${winner.id}`,
      severity: 'high',
      kind: 'duplicate-name',
      title: `${losers.length} file${losers.length === 1 ? ' is' : 's are'} never loaded: "${winner.name}" is claimed ${group.length} times`,
      detail: arbitrary
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
