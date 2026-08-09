/**
 * Tests run against `fixtures/config`, which `scripts/make-fixture.mjs`
 * generates before the suite (see the `test` script).
 *
 * The fixture is synthesised rather than copied from a real installation: the
 * shapes are the ones real configs accumulate — detached copies, redundant
 * overrides, two files claiming one name, an inactive profile, sync snapshots,
 * credentials that are actually set — but every name in it is invented, because
 * this repo is public and someone's preset and printer names are their own.
 */

import { describe, expect, it } from 'vitest';
import { analyze, stats } from './analyze';
import { compatibilityFor, compatibilitySummary } from './compatibility';
import { evaluateCondition, printerInjectedVars } from './condition';
import { diffEffective, diffRaw } from './diff';
import { buildGraph } from './graph';
import {
  buildIndex,
  classifyReference,
  loadOrder,
  lookupParent,
  shadowedIds,
  type ConfigIndex,
} from './index-config';
import { loadConfigDir } from './load-fixtures';
import { parseQuotedList, scalarAsList, valuesEqual } from './normalize';
import { presetReferences, referenceNames } from './references';
import { isSensitiveKey, maskValue, redactConfJson, redactPresetJson, REDACTED } from './redact';
import { inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';
import type { RawValue } from './types';

const FIXTURE = new URL('../../fixtures/config', import.meta.url).pathname;
const index: ConfigIndex = buildIndex(loadConfigDir(FIXTURE));

function byFile(file: string) {
  const p = index.presets.find((x) => x.path.endsWith(file));
  if (!p) throw new Error(`fixture missing file: ${file}`);
  return p;
}

describe('index', () => {
  it('parses the fixture without errors', () => {
    expect(index.parseErrors).toEqual([]);
    expect(index.presets.length).toBeGreaterThan(20);
  });

  it('counts system and user presets across vendors', () => {
    const s = stats(index);
    expect(s.user).toBeGreaterThan(5);
    expect(s.system).toBeGreaterThan(5);
    expect(s.vendors).toBe(2);
  });

  it('loads only the profile named by preset_folder', () => {
    // The fixture's conf leaves `preset_folder` empty, so `default` is live.
    expect(index.activeProfile).toBe('default');
    expect(index.inactiveProfiles).toEqual(['cloud-0000-1111']);
    expect(index.active.every((p) => p.origin === 'system' || p.profile === 'default')).toBe(true);
  });

  it('gives every preset a unique id', () => {
    // Names collide by design here, so keying on name collapsed rows that could
    // not then be opened separately.
    const ids = index.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(index.byId.size).toBe(index.presets.length);
  });

  it('keeps the same name in two profiles apart', () => {
    const live = byFile('user/default/filament/Studio ABS.json');
    const cloud = byFile('cloud-0000-1111/filament/Studio ABS.json');
    expect(live.id).not.toBe(cloud.id);
    expect(live.scope).toBe('active');
    expect(cloud.scope).toBe('inactive-profile');
  });

  it('marks base/ presets as detached custom roots', () => {
    // `base/` is where the slicer saves a preset detached from its parent
    // (Preset.cpp:3869); they load first so others can inherit them.
    const roots = index.presets.filter((p) => p.isCustomRoot);
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      expect(r.path).toContain('/base/');
      expect(r.inherits).toBeUndefined();
    }
  });

  it('separates active presets from sync snapshots', () => {
    expect(stats(index).snapshots).toBeGreaterThan(0);
    expect(index.active.every((p) => !p.path.includes('_local/'))).toBe(true);
  });

  it('never resolves a parent to a sync snapshot', () => {
    for (const list of index.byName.values()) {
      expect(list.every((p) => p.scope !== 'snapshot')).toBe(true);
    }
  });

  it('never resolves a parent across profiles', () => {
    // One PresetCollection holds the system bundles plus one user folder, so a
    // cross-profile parent cannot happen (PresetBundle.cpp:528).
    for (const p of index.presets) {
      if (!p.inherits || p.scope === 'snapshot') continue;
      const parent = lookupParent(index, p.inherits, p);
      if (parent && parent.origin === 'user') expect(parent.profile).toBe(p.profile);
    }
  });
});

describe('load order', () => {
  it('puts system first, then custom roots, then ordinary presets', () => {
    const root = byFile('process/base/Studio Base.json');
    const plain = byFile('user/default/process/Fast Draft.json');
    const system = byFile('system/Acme/process/fdm_process_common.json');
    const ordered = loadOrder([plain, root, system]);
    expect(ordered.map((p) => p.id)).toEqual([system.id, root.id, plain.id]);
  });
});

describe('normalize', () => {
  it('parses the quoted `;` vector form', () => {
    expect(parseQuotedList('"a";"b c";d')).toEqual(['a', 'b c', 'd']);
  });

  it('turns an escaped newline back into a newline', () => {
    expect(parseQuotedList('"\\n0.2,0.4444"')).toEqual(['\n0.2,0.4444']);
  });

  it('reads a plain numeric vector', () => {
    expect(scalarAsList('70,70,70')).toEqual(['70', '70', '70']);
  });

  it('treats an empty string as an empty vector', () => {
    expect(scalarAsList('')).toEqual([]);
  });

  it('considers the two serialisations of one value equal', () => {
    expect(valuesEqual(['70', '70'], '70,70')).toBe(true);
    expect(valuesEqual(['Direct Drive Standard'], '"Direct Drive Standard"')).toBe(true);
    expect(valuesEqual([], '')).toBe(true);
  });

  it('does NOT flatten genuinely different vectors', () => {
    // The failing direction: if this ever compares equal, the app is hiding a
    // real difference behind "same value, written differently".
    expect(valuesEqual(['a', 'b', 'c'], '"a"')).toBe(false);
    expect(valuesEqual(['70', '70'], '70,80')).toBe(false);
  });

  it('does not coerce unrelated scalars into vectors', () => {
    expect(valuesEqual('tree(auto)', 'normal(auto)')).toBe(false);
    expect(valuesEqual('15000', '20000')).toBe(false);
  });
});

describe('inheritance', () => {
  it('walks a chain to its base', () => {
    const { chain } = inheritanceChain(index, byFile('system/Acme/filament/Acme ABS @System.json'));
    expect(chain.map((c) => c.name)).toEqual([
      'Acme ABS @System',
      'fdm_filament_abs',
      'fdm_filament_common',
    ]);
  });

  it('resolves a sparse preset to far more settings than it stores', () => {
    const sparse = byFile('user/default/filament/Studio ABS.json');
    const stored = Object.keys(sparse.raw).length;
    const r = resolve(index, sparse);
    expect(stored).toBeLessThan(12);
    // The whole point: a handful of keys stored, many in effect.
    expect(r.settings.size).toBeGreaterThan(stored * 10);
  });

  it('attributes each resolved value to the preset that supplied it', () => {
    const r = resolve(index, byFile('user/default/filament/Studio ABS.json'));
    const own = [...r.settings.values()].filter((s) => s.depth === 0);
    const inherited = [...r.settings.values()].filter((s) => s.depth > 0);
    expect(own.length).toBeGreaterThan(0);
    expect(inherited.length).toBeGreaterThan(own.length);
  });

  it('accounts for every stored setting exactly once', () => {
    const p = byFile('user/default/filament/Studio ABS Hot.json');
    const o = ownOverrides(index, p);
    expect(o.effective.length + o.redundant.length + o.novel.length).toBe(
      Object.keys(p.raw).filter(isSettingKey).length,
    );
  });

  it('separates overrides that change something from ones that do not', () => {
    const o = ownOverrides(index, byFile('user/default/filament/Studio ABS Hot.json'));
    expect(o.effective.map((e) => e.key).sort()).toEqual([
      'filament_flow_ratio',
      'nozzle_temperature',
    ]);
    expect(o.redundant.map((r) => r.key).sort()).toEqual([
      'filament_max_volumetric_speed',
      'hot_plate_temp',
    ]);
  });

  it('shows a Copy is almost entirely redundant', () => {
    // The headline case: a large file whose real content is a couple of keys.
    const copy = byFile('0.28mm Draft @Acme - Copy.json');
    const o = ownOverrides(index, copy);
    expect(Object.keys(copy.raw).length).toBeGreaterThan(100);
    expect(o.effective.map((e) => e.key).sort()).toEqual(['top_shell_thickness', 'wall_loops']);
    expect(o.redundant.length).toBeGreaterThan(100);
  });

  it('survives a preset whose parent is missing', () => {
    const r = resolve(index, byFile('Orphaned Profile.json'));
    expect(r.missingParent).toBe('A Preset That Does Not Exist');
    expect(r.chain).toHaveLength(1);
    expect(r.settings.get('layer_height')?.value).toBe('0.2');
  });
});

describe('diff', () => {
  it('separates real differences from serialisation noise', () => {
    // Two files, same declared name, written in the two different forms.
    const a = byFile('user/default/process/Fast Draft.json');
    const b = byFile('user/default/process/Fast Draft 2.json');
    const d = diffRaw(a, b);

    expect(d.compared).toBeGreaterThan(100);
    // Three keys hold the same value written in the other form and must not
    // read as differences. (The fixture has a fourth, `print_extruder_variant`,
    // which is metadata and excluded from diffs entirely.)
    expect(d.cosmetic).toBe(3);
    const changed = d.rows.filter((r) => r.status === 'changed').map((r) => r.key);
    expect(changed.sort()).toEqual(['default_acceleration', 'enable_support', 'support_type']);
  });

  it('reports a preset compared with itself as entirely identical', () => {
    const a = byFile('user/default/process/Fast Draft.json');
    const d = diffEffective(index, a, a);
    expect(d.rows).toEqual([]);
    expect(d.identical).toBe(d.compared);
  });
});

describe('analyze', () => {
  const findings = analyze(index);

  it('flags detached full copies', () => {
    expect(findings.filter((f) => f.kind === 'detached').length).toBeGreaterThan(0);
  });

  it('flags a missing parent', () => {
    const f = findings.find((x) => x.kind === 'broken-parent' && x.title.includes('Orphaned Profile'));
    expect(f?.severity).toBe('high');
    expect(f?.reference?.unresolved[0].reason).toBe('absent');
  });

  it('flags a preset limited to printers that are gone', () => {
    const f = findings.find((x) => x.kind === 'orphaned-printer');
    expect(f?.title).toContain('Legacy PETG');
  });

  it('says two files claim one name, without predicting which wins', () => {
    // Both are ordinary presets in one directory, so the slicer's choice comes
    // down to directory iteration order — claiming a winner would be invention.
    const f = findings.find(
      (x) => x.kind === 'duplicate-name' && x.title.includes('Fast Draft'),
    );
    expect(f?.severity).toBe('high');
    expect(f?.detail).toContain('Preset already present, not loading');
    expect(f?.detail).toContain('decided by directory order');
  });

  it('does not report a cross-profile copy as a duplicate name', () => {
    // `Studio ABS` exists in both profiles. That is how sync works.
    const dup = findings.filter((f) => f.kind === 'duplicate-name');
    expect(dup.some((f) => f.title.includes('Studio ABS'))).toBe(false);
  });

  it('only analyses the profile the slicer actually loads', () => {
    for (const f of findings) {
      for (const id of f.presetIds) {
        const p = index.byId.get(id);
        if (p && p.origin === 'user') expect(p.scope).toBe('active');
      }
    }
  });

  it('never mentions a sync snapshot', () => {
    expect(findings.some((f) => f.detail.includes('_local/'))).toBe(false);
  });

  it('sorts high severity first', () => {
    const rank = { high: 0, medium: 1, low: 2 };
    const seq = findings.map((f) => rank[f.severity]);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });

  it('gives every finding something to act on', () => {
    // A vendor-index finding is about files rather than presets, so it names
    // paths instead — but a finding with neither cannot be acted on at all.
    for (const f of findings) {
      if (f.kind === 'parse-error') continue;
      expect(f.presetIds.length + (f.paths?.length ?? 0)).toBeGreaterThan(0);
    }
  });
});

describe('dangling references', () => {
  const findings = analyze(index);
  const refs = findings.filter((f) => f.reference);

  it('checks the serialised list form, not only the JSON array', () => {
    // `Legacy PETG` writes `compatible_printers` as an array and `Retired PETG`
    // writes the same fault as '"A";"B"'. The array-only check saw only the
    // first, so this is the assertion that goes red if the parsing regresses.
    const orphans = findings.filter((f) => f.kind === 'orphaned-printer').map((f) => f.title);
    expect(orphans.some((t) => t.includes('Legacy PETG'))).toBe(true);
    expect(orphans.some((t) => t.includes('Retired PETG'))).toBe(true);
  });

  it('flags a filament pinned to a process that is not installed', () => {
    const f = refs.find(
      (x) => x.reference?.key === 'compatible_prints' && x.title.includes('Studio ABS Fine Only'),
    );
    expect(f?.kind).toBe('missing-reference');
    expect(f?.reference?.unresolved).toEqual([
      { name: '0.10mm Ultrafine @Acme', reason: 'absent', targetPath: undefined },
    ]);
    expect(f?.detail).toContain('is_compatible_with_print');
  });

  it("flags a printer's default process but not its default filament", () => {
    const own = refs.filter((f) => f.title.includes('Workshop Cube MK2'));
    expect(own.map((f) => f.reference?.key)).toEqual(['default_print_profile']);
    expect(own[0].detail).toContain('first visible');
  });

  it('says a parent exists but sits in a profile the slicer never loads', () => {
    const f = findings.find((x) => x.title.includes('Wants Cloud Base'));
    expect(f?.kind).toBe('broken-parent');
    expect(f?.reference?.unresolved[0].reason).toBe('unloaded-profile');
    // The point of the reason: the fix is "copy it here", not "recreate it".
    expect(f?.detail).toContain('cloud-0000-1111');
    expect(f?.detail).toContain('PresetBundle.cpp:528');
  });

  it('says a parent is the wrong kind rather than resolving it across kinds', () => {
    const f = findings.find((x) => x.title.includes('Muddled ABS'));
    expect(f?.reference?.unresolved[0].reason).toBe('wrong-kind');
    // The failing direction: if `inherits` ever resolves filament -> process
    // again, this preset gets a chain it does not have in the slicer.
    const muddled = byFile('user/default/filament/Muddled ABS.json');
    expect(inheritanceChain(index, muddled).chain).toHaveLength(1);
  });

  it('reports a vendor index entry whose file is not there', () => {
    const f = refs.find((x) => x.reference?.key === 'filament_list');
    expect(f?.title).toContain('Globex TPU @System');
    expect(f?.paths).toContain('system/Globex.json');
    expect(f?.presetIds).toEqual([]);
  });

  it('treats a missing printer model file as the more serious fault', () => {
    const f = refs.find((x) => x.reference?.key === 'machine_model_list');
    expect(f?.severity).toBe('high');
    expect(f?.title).toContain('Globex Slab');
    // Not "an untidy index": every preset of that model is rejected on load.
    expect(f?.detail).toContain('4819');
  });

  it('flags a system printer preset naming a model its vendor does not declare', () => {
    const f = refs.find((x) => x.reference?.key === 'printer_model');
    expect(f?.title).toContain('Globex Box 0.4 nozzle');
    expect(f?.severity).toBe('high');
  });

  it('does not flag the vendor printer preset that is declared correctly', () => {
    // Acme Cube 0.4 nozzle names a model Acme declares and a variant that model
    // lists, so neither check may fire on it.
    for (const f of refs) expect(f.title).not.toContain('Acme Cube 0.4 nozzle');
  });

  it('never reads a condition as a name', () => {
    // `compatible_printers_condition` is a PlaceholderParser expression and is
    // only consulted when the list is empty (Preset.cpp:825). Treating it as a
    // name would invent an orphan in a config that works.
    const built = buildIndex([
      { path: 'user/default/machine/m.json', text: JSON.stringify({ name: 'M', inherits: '' }) },
      {
        path: 'user/default/filament/f.json',
        text: JSON.stringify({
          name: 'F',
          inherits: '',
          compatible_printers: [],
          compatible_printers_condition: 'printer_notes=~/.*ACME.*/ and nozzle_diameter[0]==0.4',
        }),
      },
    ]);
    expect(analyze(built).filter((f) => f.reference)).toEqual([]);
  });

  it('honours the parent-printer rule instead of inventing an orphan', () => {
    // A `compatible_printers` entry is also satisfied by a user printer that
    // *inherits* that name (Preset.cpp:798-806), even when no preset by the name
    // is installed. Reporting it would be a false finding.
    const built = buildIndex([
      {
        path: 'user/default/machine/m.json',
        text: JSON.stringify({ name: 'Shop Printer', inherits: 'Vendor Base 0.4' }),
      },
      {
        path: 'user/default/filament/f.json',
        text: JSON.stringify({ name: 'F', inherits: '', compatible_printers: ['Vendor Base 0.4'] }),
      },
    ]);
    expect(analyze(built).some((f) => f.kind === 'orphaned-printer')).toBe(false);
  });

  it('resolves the slicer\'s Generic rewrite rather than calling it broken', () => {
    // `find_preset2(name, auto_match)` retries a `Generic …` name as
    // `Generic … @System` (Preset.cpp:3229-3245). Not modelling that reports a
    // parent as missing when the slicer finds it.
    const built = buildIndex([
      {
        path: 'system/OrcaFilamentLibrary/filament/Generic PLA @System.json',
        text: JSON.stringify({ name: 'Generic PLA @System', layer_height: '0.2' }),
      },
      {
        path: 'user/default/filament/mine.json',
        text: JSON.stringify({ name: 'Mine', inherits: 'Generic PLA' }),
      },
    ]);
    const mine = built.presets.find((p) => p.name === 'Mine')!;
    expect(lookupParent(built, 'Generic PLA', mine)?.name).toBe('Generic PLA @System');
    expect(analyze(built).some((f) => f.kind === 'broken-parent')).toBe(false);
  });
});

describe('reference enumeration', () => {
  it('reads both serialisations of a name list', () => {
    expect(referenceNames({ compatible_printers: ['A', 'B'] }, 'compatible_printers')).toEqual([
      'A',
      'B',
    ]);
    expect(referenceNames({ compatible_printers: '"A";"B c"' }, 'compatible_printers')).toEqual([
      'A',
      'B c',
    ]);
    // A single name is not a list, and must not be split into characters or
    // dropped for want of a separator.
    expect(referenceNames({ default_print_profile: 'One Name' }, 'default_print_profile')).toEqual([
      'One Name',
    ]);
  });

  it('treats an empty list as "no constraint", not as a name', () => {
    // Empty means "every printer" (Preset.cpp:826); yielding an empty-string name
    // would turn that into a dangling reference.
    for (const v of [[], '', ['', '']]) {
      expect(referenceNames({ compatible_printers: v }, 'compatible_printers')).toEqual([]);
    }
  });

  it('only enumerates the keys that key actually means something on', () => {
    const filament = byFile('user/default/filament/Studio ABS Fine Only.json');
    expect(presetReferences(filament).map((r) => r.key).sort()).toEqual([
      'compatible_printers',
      'compatible_prints',
      'inherits',
    ]);
    // A process is gated by printers only — never by other processes.
    const process = byFile('user/default/process/0.28mm Draft @Acme - Copy.json');
    expect(presetReferences(process).map((r) => r.key)).toEqual(['inherits']);
  });
});

describe('reference classification', () => {
  const preset = (path: string, raw: Record<string, unknown>) => ({
    path,
    text: JSON.stringify(raw),
  });

  it('points a clashing name at the file that actually wins', () => {
    // Two files claim one name; the reference resolves to whichever the slicer
    // loads first, and the others are dead. A graph edge drawn to a loser would
    // show a chain nothing has.
    const built = buildIndex([
      preset('user/default/process/base/Root.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/other.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/child.json', { name: 'Child', inherits: 'Root' }),
    ]);
    const child = built.presets.find((p) => p.name === 'Child')!;
    const r = classifyReference(built, child, 'process', 'Root');
    expect(r.reason).toBe('shadowed');
    expect(r.target?.path).toBe('user/default/process/base/Root.json');
    expect(r.others.map((o) => o.path)).toEqual(['user/default/process/other.json']);
    // `base/` is loaded first by guarantee (Preset.cpp:1583), so this one is not
    // a coin toss and must not be reported as one.
    expect(r.arbitrary).toBe(false);
  });

  it('admits when a clash is decided by directory order', () => {
    const built = buildIndex([
      preset('user/default/process/a.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/b.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/child.json', { name: 'Child', inherits: 'Root' }),
    ]);
    const child = built.presets.find((p) => p.name === 'Child')!;
    expect(classifyReference(built, child, 'process', 'Root').arbitrary).toBe(true);
  });

  it('does not accept a sync snapshot as the thing a name refers to', () => {
    const built = buildIndex([
      preset('user/cloud-1/_local/snap/process/Root.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/child.json', { name: 'Child', inherits: 'Root' }),
    ]);
    const child = built.presets.find((p) => p.name === 'Child')!;
    expect(classifyReference(built, child, 'process', 'Root').reason).toBe('absent');
  });
});

describe('vendor index', () => {
  it('does not count a printer model file as a machine preset', () => {
    // Model files sit in `machine/` beside the presets, and the slicer parses
    // them into `vendor_profile.models` (PresetBundle.cpp:4712-4820). Counting
    // one as a preset invents a machine that cannot be selected.
    expect(index.presets.some((p) => p.path === 'system/Acme/machine/Acme Cube.json')).toBe(false);
    expect(index.vendorModels.find((m) => m.id === 'Acme Cube')?.variants).toEqual(['0.4', '0.6']);
  });

  it('records whether each index entry has a file behind it', () => {
    const missing = index.vendorRefs.filter((r) => !r.present).map((r) => r.name);
    expect(missing).toContain('Globex TPU @System');
    expect(missing).toContain('Globex Slab');
    expect(index.vendorRefs.filter((r) => r.name === 'fdm_filament_common')[0].present).toBe(true);
  });
});

describe('dead files', () => {
  const findings = analyze(index);

  it('reports a shadowed file once, and not as a separate problem', () => {
    // One of the two "Fast Draft" files is never loaded. It is also a detached
    // full copy — but saying so invites fixing a file the slicer never reads,
    // so only the duplicate-name finding should mention it.
    const ordered = loadOrder(index.active.filter((p) => p.name === 'Fast Draft'));
    const dead = ordered[ordered.length - 1];
    const mentions = findings.filter((f) => f.presetIds.includes(dead.id));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].kind).toBe('duplicate-name');
  });

  it('disambiguates titles when a name is claimed more than once', () => {
    const titles = findings.filter((f) => f.kind === 'detached').map((f) => f.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('inheritance graph', () => {
  const g = buildGraph(index);
  const node = (file: string) => {
    const n = g.nodes.find((x) => x.id.endsWith(file));
    if (!n) throw new Error(`not in the graph: ${file}`);
    return n;
  };
  const edgeFrom = (file: string) => g.edges.find((e) => e.childId.endsWith(file));

  it('holds every user preset and only the system presets they inherit from', () => {
    // The scale rule: a real config is a user folder plus a few thousand vendor
    // presets, so the default view is the part that is yours plus its ancestry.
    const user = index.active.filter((p) => p.origin === 'user');
    for (const p of user) expect(g.nodes.some((n) => n.id === p.id)).toBe(true);
    const system = g.nodes.filter((n) => n.origin === 'system');
    expect(system.length).toBeGreaterThan(0);
    expect(system.length).toBeLessThan(index.active.filter((p) => p.origin === 'system').length);
    expect(g.omitted.systemOnly).toBeGreaterThan(0);
    // Nothing the slicer does not load, unless asked for.
    expect(g.nodes.every((n) => n.scope === 'active')).toBe(true);
    expect(g.omitted.snapshots).toBeGreaterThan(0);
  });

  it('gives every node exactly one edge per `inherits` it declares', () => {
    const withParent = g.nodes.filter((n) => index.byId.get(n.id)?.inherits);
    expect(g.edges).toHaveLength(withParent.length);
    expect(new Set(g.edges.map((e) => e.childId)).size).toBe(g.edges.length);
  });

  it('draws the edge at the file load order actually picks', () => {
    // Two files claim "Studio Base"; `base/` is loaded first (Preset.cpp:1583),
    // so the child's parent is that one. This is the assertion that fails if the
    // graph ever matches names itself instead of asking `lookupParent`.
    const e = edgeFrom('Studio Base Fine.json');
    expect(e?.resolved).toBe(true);
    expect(e?.parentId).toBe('user/default/process/base/Studio Base.json');
    expect(e?.ambiguous).toBe(true);
    // And the file that lost is in the graph, marked dead rather than omitted.
    expect(node('user/default/process/Studio Base.json').shadowed).toBe(true);
    expect(node('process/base/Studio Base.json').shadowed).toBe(false);
  });

  it('draws a loop as a marked back edge instead of following it', () => {
    const a = edgeFrom('Loop A.json');
    const b = edgeFrom('Loop B.json');
    expect(a?.back).toBe(true);
    expect(b?.back).toBe(true);
    // Both presets are still in the graph: dropping them would hide the fault.
    expect(node('Loop A.json')).toBeDefined();
    expect(node('Loop B.json')).toBeDefined();
    // …and the walk terminated, which is the whole reason for the visited set.
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
  });

  it('marks an ordinary edge as neither back nor ambiguous', () => {
    // The failing direction for the two flags above: if either is computed
    // wrongly, a config with no loop and no clash lights up everywhere.
    const e = edgeFrom('user/default/filament/Studio ABS.json');
    expect(e).toMatchObject({ resolved: true, back: false, ambiguous: false });
  });

  it('says why an edge did not resolve', () => {
    expect(edgeFrom('Orphaned Profile.json')).toMatchObject({
      resolved: false,
      reason: 'absent',
      parentId: undefined,
    });
  });

  it('measures a root by what it carries', () => {
    // "Which vendor base is carrying most of my presets" — the question a list of
    // chains cannot answer.
    const root = node('system/Acme/process/fdm_process_common.json');
    expect(root.depth).toBe(0);
    expect(root.subtreeSize).toBeGreaterThan(3);
    expect(g.roots).toContain(root.id);
    const leaf = node('0.28mm Draft @Acme - Copy.json');
    expect(leaf.depth).toBe(4);
    expect(leaf.rootId).toBe(root.id);
    expect(leaf.subtreeSize).toBe(1);
  });

  it('orders nodes depth-first so a parent always precedes its children', () => {
    const at = new Map(g.nodes.map((n, i) => [n.id, i]));
    for (const e of g.edges) {
      if (!e.parentId || e.back) continue;
      expect(at.get(e.parentId)!).toBeLessThan(at.get(e.childId)!);
    }
  });

  it('separates a detached copy from one rooted in a vendor preset', () => {
    // A detached full copy is its own root — that *is* the finding, drawn.
    const detached = node('user/default/process/Fast Draft.json');
    expect(detached.rootId).toBe(detached.id);
    // A detached copy changes nothing — it has no parent to change — but it does
    // set everything, and reporting that as "0 overrides" read as "sets nothing".
    expect(detached.changed).toBe(0);
    expect(detached.novel).toBeGreaterThan(100);
    expect(detached.settings).toBeGreaterThan(100);
    const rooted = node('user/default/filament/Studio ABS.json');
    expect(rooted.rootId).not.toBe(rooted.id);
    expect(rooted.changed).toBeGreaterThan(0);
    expect(rooted.novel).toBeGreaterThan(0);
  });

  it('brings in the profiles the slicer ignores only when asked', () => {
    const wide = buildGraph(index, { includeInactive: true, includeSystemOnly: true });
    expect(wide.nodes.length).toBeGreaterThan(g.nodes.length);
    expect(wide.nodes.some((n) => n.scope === 'inactive-profile')).toBe(true);
    expect(wide.omitted.systemOnly).toBe(0);
    // A snapshot is never drawn, at any setting: the slicer never loads one.
    expect(wide.nodes.every((n) => n.scope !== 'snapshot')).toBe(true);
  });

  it('filters by kind without stranding an ancestor', () => {
    const filaments = buildGraph(index, { kinds: ['filament'] });
    expect(filaments.nodes.every((n) => n.kind === 'filament')).toBe(true);
    for (const e of filaments.edges) {
      if (!e.parentId) continue;
      expect(filaments.nodes.some((n) => n.id === e.parentId)).toBe(true);
    }
  });
});

describe('condition subset', () => {
  const ctx = (values: Record<string, RawValue>, injected?: Record<string, RawValue>) => ({
    lookup: (k: string) => values[k],
    injected,
  });
  const ev = (expr: string, values: Record<string, RawValue> = {}, injected?: Record<string, RawValue>) =>
    evaluateCondition(expr, ctx(values, injected));

  it('matches a regex against the whole subject, not a substring', () => {
    // `=~` compiles to `regex_match` (PlaceholderParser.cpp:687-709), which
    // requires the WHOLE subject to match. This is the trap: an unanchored JS
    // RegExp inverts every real condition, which are all written `/.*X.*/`
    // *because* of this rule.
    const notes = { printer_notes: 'PRINTER_VENDOR_ACME\nPRINTER_MODEL_CUBE' };
    expect(ev('printer_notes=~/.*ACME.*/', notes)).toBe(true);
    expect(ev('printer_notes=~/ACME/', notes)).toBe(false);
    expect(ev('printer_notes!~/ACME/', notes)).toBe(true);
    expect(ev('printer_notes=~/.*NOPE.*/', notes)).toBe(false);
  });

  it('compares an indexed vector element numerically', () => {
    for (const nozzle of ['0.4,0.6', ['0.4', '0.6']] as RawValue[]) {
      expect(ev('nozzle_diameter[0]==0.4', { nozzle_diameter: nozzle })).toBe(true);
      expect(ev('nozzle_diameter[1]>0.5', { nozzle_diameter: nozzle })).toBe(true);
      expect(ev('nozzle_diameter[0]>=0.4 and nozzle_diameter[0]<=0.4', { nozzle_diameter: nozzle })).toBe(
        true,
      );
      // Out of range is a throw in the slicer, so no claim either way.
      expect(ev('nozzle_diameter[7]==0.4', { nozzle_diameter: nozzle })).toBe('undetermined');
    }
  });

  it('uses the slicer\'s epsilon for numeric equality', () => {
    // `std::abs(lhs - rhs) < 1e-8` (compare_op), not an exact float compare.
    expect(ev('layer_height==0.2', { layer_height: '0.20000000001' })).toBe(true);
    expect(ev('layer_height==0.2', { layer_height: '0.2001' })).toBe(false);
  });

  it('reads the variables the slicer injects rather than the config', () => {
    const injected = printerInjectedVars('Shop One', '0.4,0.4');
    expect(ev('num_extruders>1', {}, injected)).toBe(true);
    expect(ev('num_extruders==2', {}, injected)).toBe(true);
    expect(ev('printer_preset=~/.*One.*/', {}, injected)).toBe(true);
    // A single-nozzle printer, written either way.
    expect(ev('num_extruders==1', {}, printerInjectedVars('X', ['0.4']))).toBe(true);
    expect(ev('num_extruders==1', {}, printerInjectedVars('X', '0.4'))).toBe(true);
  });

  it('binds `and` tighter than `or`', () => {
    // The precedence trap (PlaceholderParser.cpp:2223-2231). With the wrong
    // grouping — `(true or false) and false` — this is false.
    expect(ev('true or false and false')).toBe(true);
    expect(ev('(true or false) and false')).toBe(false);
    expect(ev('false and true or true')).toBe(true);
  });

  it('binds equality looser than comparison', () => {
    // `a == b < c` parses as `a == (b < c)`, so this compares a bool to a bool.
    expect(ev('true==1<2')).toBe(true);
    expect(ev('false==1<2')).toBe(false);
  });

  it('handles not, parentheses and both operator spellings', () => {
    expect(ev('not false')).toBe(true);
    expect(ev('!false')).toBe(true);
    expect(ev('true && !(false || false)')).toBe(true);
    // `nothing` must not be read as `not` + `hing`.
    expect(ev('nothing==1', { nothing: '1' })).toBe(true);
  });

  it('never short-circuits to a boolean past something it cannot evaluate', () => {
    // THE important one, and it has to use sides that *parse* — an expression that
    // fails to parse is undetermined for that reason alone, which would make this
    // test pass without exercising the rule at all.
    //
    // An operand we cannot evaluate is either valid-but-unmodelled (so the slicer
    // computes `false and X` = false) or invalid (so it throws, and a throw means
    // compatible = true). Opposite answers, nothing to tell them apart.
    const known = { layer_height: '0.2' };
    expect(ev('layer_height==0.9 and absent_key=="x"', known)).toBe('undetermined');
    expect(ev('layer_height==0.2 or absent_key=="x"', known)).toBe('undetermined');
    expect(ev('absent_key=="x" and layer_height==0.9', known)).toBe('undetermined');
    // An uncompilable pattern parses fine and is equally unevaluable.
    expect(ev('layer_height==0.9 and printer_notes=~/[/', { ...known, printer_notes: 'X' })).toBe(
      'undetermined',
    );
    // The determinate cases still are determinate — this must not swallow everything.
    expect(ev('layer_height==0.9 and layer_height==0.2', known)).toBe(false);
    expect(ev('layer_height==0.9 or layer_height==0.2', known)).toBe(true);
  });

  it('is undetermined for every construct outside the subset', () => {
    for (const expr of [
      'interpolate_table(nozzle_diameter[0], (0.4, 1)) > 0.5',
      'min(1, 2) == 1',
      'empty(printer_notes)',
      'size(nozzle_diameter) == 2',
      'is_nil(layer_height)',
      'true ? true : false',
      'layer_height * 2 == 0.4',
      'layer_height + 1 > 1',
      'nozzle_diameter[0+1]==0.6',
      'printer_notes',
      'layer_height',
      '',
      '(true',
      'true and',
      'printer_notes=~/(unclosed/',
    ]) {
      expect(evaluateCondition(expr, ctx({ layer_height: '0.2', printer_notes: 'X', nozzle_diameter: '0.4,0.6' }))).toBe(
        'undetermined',
      );
    }
  });

  it('is undetermined for an uncompilable pattern rather than a non-match', () => {
    // The slicer's regex dialect is close to JS but not identical, and a compile
    // failure there means compatible anyway — so this is never `false`.
    expect(ev('printer_notes=~/[/', { printer_notes: 'X' })).toBe('undetermined');
  });

  it('is undetermined when the left side of a match is not a string', () => {
    // "Left hand side of a regex match must be a string" (Preset.cpp:697-699).
    expect(ev('layer_height=~/.*2.*/', { layer_height: '0.2' })).toBe('undetermined');
  });

  it('is undetermined for a key this config does not carry', () => {
    // The slicer evaluates against a config holding a default for every option;
    // we hold only what is on disk plus what is inherited. An absent key is much
    // more likely a default than a typo, and we cannot tell.
    expect(ev('printer_notes=~/.*X.*/')).toBe('undetermined');
    expect(ev('printer_notes=~/.*X.*/ and true')).toBe('undetermined');
  });

  it('is undetermined for a comparison whose branch depends on a type we lack', () => {
    // `compare_op` string-compares when either side is a string and numerically
    // when both are numeric; the option's declared type decides, and we do not
    // have it.
    expect(ev('printer_model==0.4', { printer_model: 'Cube' })).toBe('undetermined');
    // Explicit string literals are unambiguous, so those do compare.
    expect(ev('printer_model=="Cube"', { printer_model: 'Cube' })).toBe(true);
    expect(ev('printer_model!="Slab"', { printer_model: 'Cube' })).toBe(true);
  });

  it('reads an unindexed single-element vector as the scalar it is', () => {
    expect(ev('nozzle_diameter==0.4', { nozzle_diameter: ['0.4'] })).toBe(true);
    // …but a multi-element one needs an index, as the slicer does.
    expect(ev('nozzle_diameter==0.4', { nozzle_diameter: ['0.4', '0.6'] })).toBe('undetermined');
  });
});

describe('printer compatibility', () => {
  const machine = byFile('user/default/machine/Workshop Cube.json');
  const c = compatibilityFor(index, machine);
  const verdict = (name: string) => {
    const v = [...c.filaments, ...c.processes].find((x) => x.preset.name === name);
    if (!v) throw new Error(`not judged: ${name}`);
    return v;
  };

  it('offers a filament that names no printers to every printer', () => {
    // Empty means "every printer" (Preset.cpp:826). Reading it as "no printer"
    // inverts the answer for most of a real config.
    expect(verdict('Acme PLA @System')).toMatchObject({
      included: true,
      reason: 'compatible-with-everything',
    });
  });

  it('offers a filament that names this printer', () => {
    expect(verdict('Studio ABS')).toMatchObject({
      included: true,
      reason: 'named-explicitly',
      evidence: { key: 'compatible_printers', value: 'Workshop Cube' },
    });
  });

  it('offers a filament that names the preset this printer inherits from', () => {
    // The clause that looks wrong and is not: a filament naming the *vendor*
    // printer is offered on every user printer derived from it
    // (`is_compatible_with_parent_printer`, Preset.cpp:798-806). A model built on
    // name-matching alone reports this as excluded, which is a false negative on
    // the most common real setup there is.
    expect(verdict('Studio PLA Inherited')).toMatchObject({
      included: true,
      reason: 'named-via-parent',
      evidence: { key: 'compatible_printers', value: 'Acme Cube 0.4 nozzle' },
    });
  });

  it('does not extend the parent clause to a system printer', () => {
    // The source checks `! active_printer.preset.is_system` before consulting the
    // parent (Preset.cpp:841). So a filament naming `fdm_machine_common` reaches a
    // *user* printer that inherits it and not the vendor preset that also does.
    const built = buildIndex([
      {
        path: 'system/Acme/machine/base.json',
        text: JSON.stringify({ name: 'Acme Base' }),
      },
      {
        path: 'system/Acme/machine/vendor.json',
        text: JSON.stringify({ name: 'Acme Cube', inherits: 'Acme Base' }),
      },
      {
        path: 'user/default/machine/mine.json',
        text: JSON.stringify({ name: 'Shop One', inherits: 'Acme Base' }),
      },
      {
        path: 'user/default/filament/f.json',
        text: JSON.stringify({ name: 'F', compatible_printers: ['Acme Base'] }),
      },
    ]);
    const pick = (printer: string) =>
      compatibilityFor(built, built.presets.find((p) => p.name === printer)!).filaments.find(
        (x) => x.preset.name === 'F',
      );
    expect(pick('Shop One')).toMatchObject({ included: true, reason: 'named-via-parent' });
    expect(pick('Acme Cube')).toMatchObject({ included: false, reason: 'excluded' });
  });

  it('excludes a filament whose list names another installed printer', () => {
    expect(verdict('Studio PLA MK2 Only')).toMatchObject({
      included: false,
      reason: 'excluded',
      evidence: { key: 'compatible_printers', value: 'Workshop Cube MK2' },
    });
  });

  it('reads the serialised list form as well as the array', () => {
    // The failing direction: an unparsed `'"A";"B"'` reads as an empty list, which
    // means "compatible with everything" — the opposite of what it says.
    const gate = verdict('Studio PLA Fine Process').processGate;
    expect(gate?.names).toEqual(['0.20mm Standard @Acme']);
  });

  it('evaluates a condition inside the subset, against resolved settings', () => {
    // `printer_notes=~/.*ACME_CUBE.*/ and nozzle_diameter[0]==0.4`. Neither key is
    // written on `Workshop Cube`; both come from the vendor preset it inherits, so
    // this also pins that conditions see the *resolved* config.
    const v = verdict('Studio PLA Conditional');
    expect(v.included).toBe(true);
    expect(v.reason).toBe('condition');
    expect(v.evidence.key).toBe('compatible_printers_condition');
  });

  it('reaches the opposite verdict for a printer the condition excludes', () => {
    // Same filament, and `Workshop Cube MK2` overrides `nozzle_diameter` to 0.6.
    const mk2 = byFile('user/default/machine/Workshop Cube MK2.json');
    const v = compatibilityFor(index, mk2).filaments.find(
      (x) => x.preset.name === 'Studio PLA Conditional',
    );
    expect(v?.included).toBe(false);
    expect(v?.reason).toBe('condition');
  });

  it('stays undetermined for a condition outside the subset', () => {
    // `interpolate_table(…)` — a function we do not implement. The expression is
    // reported verbatim so the answer is "it depends on this", not a guess.
    const v = verdict('Studio PLA Opaque');
    expect(v.included).toBe('undetermined');
    expect(v.reason).toBe('condition');
    expect(v.evidence.value).toContain('interpolate_table');
  });

  it('never treats a condition as a name list', () => {
    const v = verdict('Studio PLA Conditional');
    expect(v.reason).not.toBe('excluded');
    expect(v.reason).not.toBe('compatible-with-everything');
  });

  it('scopes a filament to a process only when asked, and ands the two gates', () => {
    const fine = byFile('system/Acme/process/0.20mm Standard @Acme.json');
    const draft = byFile('system/Acme/process/0.28mm Draft @Acme.json');
    const withFine = compatibilityFor(index, machine, { process: fine });
    const withDraft = compatibilityFor(index, machine, { process: draft });
    const name = 'Studio PLA Fine Process';
    const pick = (r: ReturnType<typeof compatibilityFor>) =>
      r.filaments.find((x) => x.preset.name === name)!;

    // Unscoped, the printer axis is the answer and the gate is a note.
    expect(verdict(name).included).toBe(true);
    expect(verdict(name).processGate?.passes).toBeUndefined();
    expect(pick(withFine)).toMatchObject({ included: true });
    expect(pick(withFine).processGate?.passes).toBe(true);
    // `is_compatible &= is_compatible_with_print` (Preset.cpp:3364).
    expect(pick(withDraft).included).toBe(false);
    expect(pick(withDraft).processGate?.passes).toBe(false);
  });

  it('never gates a process by compatible_prints', () => {
    // `is_compatible_with_print` is only applied to filaments — processes are
    // updated with no active print at all (PresetBundle.cpp:5421 vs :5439), so a
    // `compatible_prints` on a process is not a restriction the slicer applies.
    expect(c.processes.every((x) => x.processGate === undefined)).toBe(true);
  });

  it('marks the printer defaults without making them a verdict', () => {
    // Being the default decides what gets *selected* (PresetBundle.cpp:2142-2166),
    // not what is compatible — so it must not change `included` or `reason`.
    const vendorPrinter = byFile('system/Acme/machine/Acme Cube 0.4 nozzle.json');
    const r = compatibilityFor(index, vendorPrinter);
    const dflt = r.filaments.find((x) => x.preset.name === 'Acme PLA @System');
    expect(dflt?.isPrinterDefault).toBe(true);
    expect(dflt?.reason).toBe('compatible-with-everything');
    expect(r.processes.find((x) => x.preset.name === '0.20mm Standard @Acme')?.isPrinterDefault).toBe(
      true,
    );
    expect(r.filaments.filter((x) => x.isPrinterDefault)).toHaveLength(1);
  });

  it('leaves out the presets the slicer never loads, unless asked', () => {
    expect(c.processes.some((x) => x.preset.name === 'Cloud Only')).toBe(false);
    const wide = compatibilityFor(index, machine, { includeNeverLoaded: true });
    const dead = wide.processes.filter((x) => x.reason === 'never-loaded');
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((x) => x.included === false)).toBe(true);
    // A snapshot is never judged at all: the slicer does not load one.
    expect(wide.processes.every((x) => x.preset.scope !== 'snapshot')).toBe(true);
  });

  it('excludes a library filament a vendor supersedes for this printer', () => {
    // `m_excluded_from` is derived, not stored: a library filament with an empty
    // `compatible_printers` inherits the exclusions of every other vendor's preset
    // sharing its `alias` (Preset.cpp:3704-3733). Built inline because the fixture
    // has no filament library — synthesising one there would double its size for
    // one rule.
    const built = buildIndex([
      {
        path: 'user/default/machine/m.json',
        text: JSON.stringify({ name: 'Shop One', inherits: 'Vendor Base 0.4' }),
      },
      {
        path: 'system/OrcaFilamentLibrary/filament/Generic PLA @System.json',
        text: JSON.stringify({ name: 'Generic PLA @System', alias: 'Generic PLA' }),
      },
      {
        path: 'system/Acme/filament/Generic PLA @Acme.json',
        text: JSON.stringify({
          name: 'Generic PLA @Acme',
          alias: 'Generic PLA',
          compatible_printers: ['Vendor Base 0.4'],
        }),
      },
    ]);
    const printer = built.presets.find((p) => p.name === 'Shop One')!;
    const r = compatibilityFor(built, printer);
    expect(r.filaments.find((x) => x.preset.name === 'Generic PLA @System')).toMatchObject({
      included: false,
      reason: 'excluded-by-library',
      evidence: { key: 'alias', value: 'Generic PLA' },
    });
    // The vendor's own version is the one offered, via the parent clause.
    expect(r.filaments.find((x) => x.preset.name === 'Generic PLA @Acme')).toMatchObject({
      included: true,
      reason: 'named-via-parent',
    });
  });

  it('summarises without re-deriving anything', () => {
    const s = compatibilitySummary(c.filaments);
    expect(s.yes + s.no + s.undetermined).toBe(c.filaments.length);
    // One of the two conditional filaments is now decided; the `interpolate_table`
    // one is not, and must not be rounded to a boolean.
    expect(s.undetermined).toBe(1);
  });
});

describe('cross-vendor name clashes', () => {
  const findings = analyze(index);
  const crossVendor = findings.filter(
    (f) => f.kind === 'duplicate-name' && f.title.includes('Shared PLA @System'),
  );

  it('reports a name two vendors both ship', () => {
    // One collection per preset type holds every vendor's presets, so the merge
    // discards the second arrival — a different mechanism from the intra-folder
    // clash, and one our vendor-scoped grouping used to miss entirely.
    expect(crossVendor).toHaveLength(1);
    expect(crossVendor[0].severity).toBe('high');
    expect(crossVendor[0].title).toContain('Acme');
    expect(crossVendor[0].title).toContain('Globex');
    expect(crossVendor[0].detail).toContain('Found duplicated preset');
    // Not the intra-folder rule, and must not claim to be.
    expect(crossVendor[0].detail).not.toContain('Preset already present');
  });

  it('refuses to predict which vendor survives', () => {
    // Vendor files are enumerated with `directory_iterator` over `system/*.json`
    // (PresetBundle.cpp:2205), so between two ordinary vendors the order is
    // filesystem-dependent and naming a winner would be invention.
    expect(crossVendor[0].detail).toContain('not safe to predict');
    expect(crossVendor[0].presetIds).toHaveLength(2);
  });

  it('treats the loser as never loaded, so nothing else is reported about it', () => {
    const dead = [...shadowedIds(index)].filter((id) => id.includes('Shared PLA @System'));
    expect(dead).toHaveLength(1);
    for (const f of findings) {
      if (f.kind === 'duplicate-name') continue;
      expect(f.presetIds).not.toContain(dead[0]);
    }
  });

  it('does NOT report two vendors shipping the same base', () => {
    // The case the issue behind this thought was the likely one, and the one that
    // cannot happen: a preset marked `instantiation: "false"` never enters a
    // collection — it goes into a per-bundle map that is local to one vendor's
    // load (PresetBundle.cpp:4929, :5134). "The remaining vendors are independent
    // (no cross-vendor inheritance)", says the source. Reporting it would be a
    // false finding.
    const built = buildIndex([
      {
        path: 'system/Acme/filament/base.json',
        text: JSON.stringify({ name: 'fdm_filament_common', instantiation: 'false' }),
      },
      {
        path: 'system/Globex/filament/base.json',
        text: JSON.stringify({ name: 'fdm_filament_common', instantiation: 'false' }),
      },
    ]);
    expect(analyze(built).filter((f) => f.kind === 'duplicate-name')).toEqual([]);
    expect(shadowedIds(built).size).toBe(0);
  });

  it('lets the filament library win, because it is merged first', () => {
    // `OrcaFilamentLibrary` is loaded into the bundle synchronously before any
    // other vendor is merged (PresetBundle.cpp:2231-2241), so this clash is not a
    // coin toss and must not be reported as one.
    const built = buildIndex([
      {
        path: 'system/OrcaFilamentLibrary/filament/x.json',
        text: JSON.stringify({ name: 'Generic PLA @System' }),
      },
      {
        path: 'system/Acme/filament/x.json',
        text: JSON.stringify({ name: 'Generic PLA @System' }),
      },
    ]);
    const f = analyze(built).find((x) => x.kind === 'duplicate-name');
    expect(f?.detail).toContain('merged first and always wins');
    expect(f?.detail).toContain('system/OrcaFilamentLibrary/filament/x.json');
    expect(f?.detail).not.toContain('not safe to predict');
    // …and the library's copy is the one that survives.
    const dead = [...shadowedIds(built)];
    expect(dead).toEqual(['system/Acme/filament/x.json']);
  });

  it('keeps the Template vendor exception', () => {
    // The guard is `instantiation == "false" && "Template" != vendor_name`
    // (PresetBundle.cpp:4929), so a Template-vendor base *is* loaded — and can
    // therefore clash. Easy to lose in a refactor, so it is pinned.
    const built = buildIndex([
      {
        path: 'system/Template/filament/x.json',
        text: JSON.stringify({ name: 'Shared Base', instantiation: 'false' }),
      },
      {
        path: 'system/Acme/filament/x.json',
        text: JSON.stringify({ name: 'Shared Base' }),
      },
    ]);
    expect(analyze(built).filter((f) => f.kind === 'duplicate-name')).toHaveLength(1);
  });

  it('still does not report the same name in two user profiles', () => {
    // Sync copies the live profile into the cloud one; only one is ever loaded.
    const dup = analyze(index).filter((f) => f.kind === 'duplicate-name');
    expect(dup.some((f) => f.title.includes('Studio ABS'))).toBe(false);
  });
});

describe('redaction', () => {
  it('masks credential-bearing keys by name', () => {
    for (const k of ['printhost_apikey', 'printhost_password', 'print_host', 'printhost_user']) {
      expect(isSensitiveKey(k)).toBe(true);
    }
  });

  it('leaves print settings alone', () => {
    for (const k of ['nozzle_temperature', 'layer_height', 'support_type']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });

  it('reports whether a credential is set without revealing it', () => {
    expect(maskValue('hunter2')).toBe('•••••• (set, hidden)');
    expect(maskValue('')).toBe('(not set)');
    expect(maskValue(['', ''])).toBe('(not set)');
  });
});

describe('transport redaction', () => {
  it('replaces a set credential with the sentinel and never the value', () => {
    const raw = JSON.stringify({
      name: 'my printer',
      printhost_apikey: 'super-secret-key',
      printhost_password: 'hunter2',
      print_host: ['printer.example.invalid', ''],
      nozzle_temperature: '250',
    });
    const out = redactPresetJson(raw);
    expect(out).not.toContain('super-secret-key');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('printer.example.invalid');

    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.printhost_apikey).toBe(REDACTED);
    // Set-ness survives per element, so "which slots are configured" is visible.
    expect(parsed.print_host).toEqual([REDACTED, '']);
    expect(parsed.nozzle_temperature).toBe('250');
  });

  it('leaves an unset credential empty so the UI can say "not set"', () => {
    const out = JSON.parse(redactPresetJson(JSON.stringify({ printhost_apikey: '' })));
    expect(out.printhost_apikey).toBe('');
  });

  it('keeps the redacted value readable as "set" by the UI', () => {
    expect(maskValue(REDACTED)).toBe('•••••• (set, hidden)');
  });

  it('scrubs a sensitive subtree at any depth, not just top-level keys', () => {
    // Presets are flat, but this also ran over OrcaSlicer.conf, which is not —
    // which is how a real printer address once reached the browser.
    const out = redactPresetJson(
      JSON.stringify({
        app: { preset_folder: '', printhost_apikey: 'nested-secret' },
        outer: { inner: { printhost_password: 'deep' } },
      }),
    );
    expect(out).not.toContain('nested-secret');
    expect(out).not.toContain('deep');
  });

  it('drops a sensitive subtree whose KEYS are the secret', () => {
    // `local_machines` is keyed by printer address. Blanking values would leave
    // the addresses sitting in the key positions.
    const out = redactPresetJson(
      JSON.stringify({
        local_machines: { '192.0.2.10': { dev_ip: '192.0.2.10', dev_name: 'printer' } },
      }),
    );
    expect(out).not.toContain('192.0.2.10');
    expect(out).not.toContain('printer');
    expect(JSON.parse(out).local_machines).toEqual({});
  });

  it('reduces OrcaSlicer.conf to the one field the app needs', () => {
    const out = redactConfJson(
      JSON.stringify({
        app: { preset_folder: 'cloud-abc', other_setting: 'kept out' },
        access_code: { printer1: 'pairing-code' },
        user_access_code: 'secret',
        dev_sn: { a: 'SERIAL123' },
        local_machines: { '192.0.2.5': { dev_name: 'ender' } },
      }),
    );
    expect(JSON.parse(out)).toEqual({ app: { preset_folder: 'cloud-abc' } });
    for (const leak of ['pairing-code', 'SERIAL123', '192.0.2.5', 'ender', 'secret', 'kept out']) {
      expect(out).not.toContain(leak);
    }
  });

  it('still yields a usable conf when it cannot be parsed', () => {
    expect(JSON.parse(redactConfJson('{broken'))).toEqual({ app: { preset_folder: '' } });
  });

  it('refuses to pass through a file it cannot parse', () => {
    // An unparseable file might contain anything; forwarding it verbatim would
    // route around the key-name check entirely.
    expect(redactPresetJson('{"printhost_apikey": "leak"')).toBe('{}');
  });

  it('reduces the fixture conf, which carries every dangerous shape at once', () => {
    const raw = loadConfigDir(FIXTURE).find((f) => f.path === 'OrcaSlicer.conf');
    expect(raw).toBeDefined();
    const out = redactConfJson(raw!.text);
    for (const leak of ['00112233', 'abcdef123456', 'SNEXAMPLE0001', '192.0.2.10']) {
      expect(out).not.toContain(leak);
    }
  });
});

describe('active profile is read from OrcaSlicer.conf', () => {
  const preset = (path: string, name: string) => ({
    path,
    text: JSON.stringify({ name, inherits: '', layer_height: '0.2' }),
  });

  it('honours a non-default preset_folder', () => {
    // The failing direction: with `preset_folder` set, the cloud presets are
    // live and `default` is the inert one — the opposite of the fixture. If this
    // ever returns `default`, the conf is not being read at all.
    const built = buildIndex([
      { path: 'OrcaSlicer.conf', text: JSON.stringify({ app: { preset_folder: 'cloud-abc' } }) },
      preset('user/default/process/a.json', 'a'),
      preset('user/cloud-abc/process/b.json', 'b'),
    ]);
    expect(built.activeProfile).toBe('cloud-abc');
    expect(built.active.map((p) => p.name)).toEqual(['b']);
    expect(built.inactiveProfiles).toEqual(['default']);
  });

  it('falls back to `default` when preset_folder is empty', () => {
    const built = buildIndex([
      { path: 'OrcaSlicer.conf', text: JSON.stringify({ app: { preset_folder: '' } }) },
      preset('user/default/process/a.json', 'a'),
      preset('user/cloud-abc/process/b.json', 'b'),
    ]);
    expect(built.activeProfile).toBe('default');
    expect(built.active.map((p) => p.name)).toEqual(['a']);
  });

  it('falls back to `default` when the conf is missing or unreadable', () => {
    expect(buildIndex([preset('user/default/process/a.json', 'a')]).activeProfile).toBe('default');
    expect(
      buildIndex([
        { path: 'OrcaSlicer.conf', text: '{broken' },
        preset('user/default/process/a.json', 'a'),
      ]).activeProfile,
    ).toBe('default');
  });
});
