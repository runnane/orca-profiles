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
import {
  compatibilityFor,
  compatibilitySummary,
  machineVisibility,
  offering,
  visibilityIndex,
} from './compatibility';
import { evaluateCondition, printerInjectedVars } from './condition';
import { diffEffective, diffRaw } from './diff';
import { buildGraph } from './graph';
import {
  buildIndex,
  clashScope,
  classifyReference,
  loadedVendorModels,
  loadOrder,
  lookupParent,
  shadowedIds,
  type ConfigIndex,
} from './index-config';
import { groupLikeSlicer, presetAlias } from './grouping';
import { readInstalled } from './installed';
import { loadConfigDir } from './load-fixtures';
import { parseQuotedList, scalarAsList, valuesEqual } from './normalize';
import { parsesAsSemver } from './preset-version';
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

/**
 * A vendor filament as a real bundle ships one.
 *
 * `parse_subfile` fails the **whole vendor bundle** for an instantiable filament
 * with no `filament_id`, stated or inherited — "Can not find filament_id"
 * (PresetBundle.cpp:5071-5078). A synthetic config without one is therefore a
 * config the slicer cannot load, and every test built on it would be asserting
 * about a vendor that is not there.
 *
 * It lives here rather than in thirty literals because it is boilerplate: not one
 * test below is *about* `filament_id`, and spelling it out each time would bury
 * what each one actually asserts. The tests that ARE about it write their own
 * literals, so the thing under test is never supplied by the helper.
 *
 * Mirrors `withFilamentId` in `scripts/make-fixture.mjs`. `raw` wins, so a caller
 * can still state its own id.
 */
function sysFilament(path: string, raw: Record<string, unknown>) {
  return { path, text: JSON.stringify({ filament_id: 'TESTFIL0001', ...raw }) };
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
    // Acme, Globex, Initech, Hooli, Vandelay, Bluth, and OrcaFilamentLibrary —
    // which is a vendor bundle like any other, and is counted as one.
    expect(s.vendors).toBe(7);
    expect(index.vendors).toContain('OrcaFilamentLibrary');
    // `vendors` is what is on disk; `failedVendors` is the subset the slicer
    // never ends up holding, and the two are deliberately different numbers.
    // Four of the seven fail, and each fails a different way — see the
    // bundle-guard suite. `vendors` is what is on disk; this is the subset the
    // slicer never ends up holding.
    expect(s.failedVendors).toEqual(['Bluth', 'Hooli', 'Initech', 'Vandelay']);
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
    for (const r of roots) expect(r.path).toContain('/base/');
    // `isCustomRoot` is "lives in `base/`", not "has no parent". That is nearly
    // always the same thing, because detaching is what puts a preset there — but a
    // hand-edited file can declare an `inherits` from inside `base/`, and the
    // fixture holds one on purpose (ORCA-22). Asserting no root ever has a parent
    // would make that shape unwritable.
    expect(roots.filter((r) => r.inherits).map((r) => r.name)).toEqual([
      'Bench Rig Base Derived',
    ]);
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

  it('says two files claim one name, and here it can name the winner', () => {
    // The only shape a *user* name clash can take since ORCA-28: two directories,
    // `<kind>/base/` and `<kind>/`. Two files in one directory cannot share a name
    // at all, because a user preset is named by its filename.
    //
    // Which also means a user clash is never a coin toss — `base/` is a completed
    // earlier pass (Preset.cpp:1583-1586), so the winner is knowable and is named.
    // The arbitrary case is two *vendors*, and it has its own test.
    const f = findings.find(
      (x) => x.kind === 'duplicate-name' && x.title.includes('Studio Base'),
    );
    expect(f?.severity).toBe('high');
    expect(f?.detail).toContain('Preset already present, not loading');
    expect(f?.detail).not.toContain('decided by directory order');
    expect(f?.detail).toContain('user/default/process/base/Studio Base.json');
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
    expect(f?.title).toContain('Vandelay TPU @System');
    expect(f?.paths).toContain('system/Vandelay.json');
    expect(f?.presetIds).toEqual([]);
  });

  it('treats a missing printer model file as the more serious fault', () => {
    const f = refs.find((x) => x.reference?.key === 'machine_model_list');
    expect(f?.severity).toBe('high');
    expect(f?.title).toContain('Hooli Slab');
    // Not "an untidy index", and no longer merely "every preset of that model is
    // rejected": the model files are read before any preset, with no existence
    // check and a catch that rethrows, so the whole vendor goes (ORCA-27).
    expect(f?.detail).toContain("Hooli's entire bundle");
    expect(f?.detail).toContain('PresetBundle.cpp:4714-4821');
  });

  it('flags a system printer preset naming a model its vendor does not declare', () => {
    // Bluth declares "Bluth Banana" and its printer names "Bluth Stair Car".
    const f = refs.find((x) => x.reference?.key === 'printer_model');
    expect(f?.title).toContain('Bluth Stair Car 0.4 nozzle');
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
        path: 'user/default/machine/Shop Printer.json',
        text: JSON.stringify({ name: 'Shop Printer', inherits: 'Vendor Base 0.4' }),
      },
      {
        path: 'user/default/filament/F.json',
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
      sysFilament('system/OrcaFilamentLibrary/filament/Generic PLA @System.json', { name: 'Generic PLA @System', layer_height: '0.2' }),
      {
        path: 'user/default/filament/Mine.json',
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
  // `version` by default, because a user preset without a parseable one is never
  // loaded at all (Preset.cpp:1653-1655) and these cases are about *which* loaded
  // file a name means. A case that wants the version gate passes its own.
  const preset = (path: string, raw: Record<string, unknown>) => ({
    path,
    text: JSON.stringify({ version: '2.4.0.3', ...raw }),
  });

  it('points a clashing name at the file that actually wins', () => {
    // Two files claim one name; the reference resolves to whichever the slicer
    // loads first, and the others are dead. A graph edge drawn to a loser would
    // show a chain nothing has.
    const built = buildIndex([
      preset('user/default/process/base/Root.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/Root.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/Child.json', { name: 'Child', inherits: 'Root' }),
    ]);
    const child = built.presets.find((p) => p.name === 'Child')!;
    const r = classifyReference(built, child, 'process', 'Root');
    expect(r.reason).toBe('shadowed');
    expect(r.target?.path).toBe('user/default/process/base/Root.json');
    expect(r.others.map((o) => o.path)).toEqual(['user/default/process/Root.json']);
    // `base/` is loaded first by guarantee (Preset.cpp:1583), so this one is not
    // a coin toss and must not be reported as one.
    expect(r.arbitrary).toBe(false);
  });

  it('admits when a clash is decided by directory order — which needs two vendors', () => {
    const built = buildIndex([
      // Not two user files: since ORCA-28 a user preset is named by its filename,
      // so two of them in one directory cannot share a name, and `base/` versus the
      // folder is a *knowable* order. The only clash left that is genuinely a coin
      // toss is between two vendors, whose files are enumerated with
      // `directory_iterator` over `system/*.json` (PresetBundle.cpp:2205).
      {
        path: 'system/Acme/process/a.json',
        text: JSON.stringify({ name: 'Root', inherits: '' }),
      },
      {
        path: 'system/Globex/process/b.json',
        text: JSON.stringify({ name: 'Root', inherits: '' }),
      },
      preset('user/default/process/Child.json', { name: 'Child', inherits: 'Root' }),
    ]);
    const child = built.presets.find((p) => p.name === 'Child')!;
    expect(classifyReference(built, child, 'process', 'Root').arbitrary).toBe(true);
  });

  it('does not accept a sync snapshot as the thing a name refers to', () => {
    const built = buildIndex([
      preset('user/cloud-1/_local/snap/process/Root.json', { name: 'Root', inherits: '' }),
      preset('user/default/process/Child.json', { name: 'Child', inherits: 'Root' }),
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
    expect(missing).toContain('Vandelay TPU @System');
    expect(missing).toContain('Hooli Slab');
    expect(index.vendorRefs.filter((r) => r.name === 'fdm_filament_common')[0].present).toBe(true);
  });
});

describe('dead files', () => {
  const findings = analyze(index);

  it('reports a shadowed file once, and not as a separate problem', () => {
    // The folder copy of `Studio Base` is never loaded — `base/` got there first.
    // Saying anything else about it invites fixing a file the slicer never reads,
    // so only the duplicate-name finding should mention it.
    const ordered = loadOrder(index.active.filter((p) => p.name === 'Studio Base'));
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

describe('the version gate', () => {
  // A port of the parser the slicer links (`deps_src/semver/semver.c`), not of the
  // semver spec — they disagree, and it is the former that decides whether a user
  // preset loads. Each case here is one branch of it.
  it('accepts what semver.c accepts', () => {
    // Two to four numeric components: `semver_parse_version` counts iterations and
    // ends on `index == 2 || index == 3 || index == 4` (semver.c:212-213).
    expect(parsesAsSemver('1.9')).toBe(true);
    expect(parsesAsSemver('1.9.0')).toBe(true);
    expect(parsesAsSemver('2.4.0.3')).toBe(true);
    // Leading zeros are fine: `strtol`, not a spec-compliant grammar.
    expect(parsesAsSemver('01.09.00.02')).toBe(true);
    // The loop stops at four slices, so a fifth is never examined and cannot fail.
    expect(parsesAsSemver('1.2.3.4.5')).toBe(true);
    // `parse_slice` cuts metadata then prerelease off the head first (semver.c:154-155).
    expect(parsesAsSemver('1.9.0-beta')).toBe(true);
    expect(parsesAsSemver('1.9.0+build7')).toBe(true);
  });

  it('rejects what semver.c rejects, starting with the empty string', () => {
    // The case that matters most: a missing `version` key reaches the parser as `""`,
    // because `key_values` only gains an entry when the file has one
    // (Config.cpp:885-887) and `std::map::operator[]` default-constructs.
    expect(parsesAsSemver('')).toBe(false);
    // One component: `index == 1`, which is not in the accepted set.
    expect(parsesAsSemver('1')).toBe(false);
    // `strtol` has to consume each slice whole.
    expect(parsesAsSemver('1.x')).toBe(false);
    expect(parsesAsSemver('draft')).toBe(false);
    // Outside `VALID_CHARS` (semver.c:20) — a space is not in it.
    expect(parsesAsSemver('1.9 ')).toBe(false);
    expect(parsesAsSemver('1_9')).toBe(false);
    // `has_valid_length`: MAX_SIZE is 255 (semver.c:22).
    expect(parsesAsSemver(`1.${'9'.repeat(255)}`)).toBe(false);
    // SLICE_SIZE is 50 (semver.c:13).
    expect(parsesAsSemver(`1.${'9'.repeat(51)}`)).toBe(false);
  });

  it('does not apply the gate to system presets', () => {
    // `parse_subfile` (PresetBundle.cpp:4836+) has no version gate at all, and no
    // vendor preset in the fixture declares one. Applying the user rule to them
    // would empty the config. A system preset can still be excluded for losing a
    // *name clash*, which is a different rule and stays.
    const system = index.active.filter((p) => p.origin === 'system');
    expect(system.length).toBeGreaterThan(0);
    const excluded = system
      .map((p) => index.notLoaded.get(p.id)?.reason)
      .filter((r) => r !== undefined);
    expect(excluded).not.toContain('bad-version');
    expect(excluded).not.toContain('parent-not-loaded');
  });
});

describe('a parent that exists as a file and is still not loadable', () => {
  const findings = analyze(index);
  const base = byFile('machine/base/Bench Rig Base.json');
  const child = byFile('machine/Bench Rig A.json');
  const sibling = byFile('machine/Bench Rig B.json');
  const grandchild = byFile('machine/Bench Rig A Fine.json');
  const control = byFile('machine/Bench Rig C.json');
  const of = (id: string) => findings.filter((f) => f.presetIds.includes(id));

  it('knows the parent is not loaded, and why', () => {
    expect(index.notLoaded.get(base.id)).toEqual({ reason: 'bad-version' });
  });

  it('refuses to resolve a name onto it', () => {
    // The bug: as long as *a file* claimed the name we treated the chain as intact.
    const r = classifyReference(index, child, 'machine', 'Bench Rig Base');
    expect(r.reason).toBe('not-loaded');
    expect(r.target).toBeUndefined();
    expect(r.others.map((o) => o.path)).toEqual([base.path]);
    expect(inheritanceChain(index, child).missingParent).toBe('Bench Rig Base');
    expect(inheritanceChain(index, child).chain).toHaveLength(1);
  });

  it('cascades to every child of the skipped base', () => {
    // A skipped preset is not in the collection, so its own children fail the same
    // lookup. One pass over the config finds the first and misses the rest.
    for (const p of [child, sibling]) {
      expect(index.notLoaded.get(p.id)).toEqual({
        reason: 'parent-not-loaded',
        parentName: 'Bench Rig Base',
      });
    }
  });

  it('does not cascade a second level, because a second level cannot exist', () => {
    // `Bench Rig A Fine` names `Bench Rig A`, its sibling in the same directory —
    // which the slicer never resolves whatever happened to `Bench Rig A` itself
    // (ORCA-22). So the cascade is exactly one level deep for user presets: a
    // `<kind>/base/` parent and its `<kind>/` children, and no further.
    expect(index.notLoaded.get(grandchild.id)).toEqual({
      reason: 'parent-not-loaded',
      parentName: 'Bench Rig A',
    });
    expect(classifyReference(index, grandchild, 'machine', 'Bench Rig A', 'inherits').reason).toBe(
      'same-directory',
    );
  });

  it('reports broken-parent on the child and on the cascade', () => {
    for (const p of [child, sibling]) {
      const broken = of(p.id).filter((f) => f.kind === 'broken-parent');
      expect(broken).toHaveLength(1);
      expect(broken[0].reference?.unresolved[0].reason).toBe('not-loaded');
    }
    // The sibling-in-the-same-folder case is a different rule and says so.
    const g = of(grandchild.id).filter((f) => f.kind === 'broken-parent');
    expect(g).toHaveLength(1);
    expect(g[0].reference?.unresolved[0].reason).toBe('same-directory');
  });

  it('says which gate the parent hit, differently for each', () => {
    const direct = of(child.id).find((f) => f.kind === 'broken-parent')!;
    expect(direct.detail).toContain('`version` does not parse');
    expect(direct.detail).toContain('Preset.cpp:1653-1655');
    // The other one failed for a different reason and needs a different fix —
    // move the parent, rather than repair it.
    const sameDir = of(grandchild.id).find((f) => f.kind === 'broken-parent')!;
    expect(sameDir.detail).toContain('same pass');
    expect(sameDir.detail).toContain('user/default/machine/base/');
    expect(sameDir.detail).not.toContain('`version` does not parse');
  });

  it('reports the unloadable parent itself, with the fix', () => {
    const own = of(base.id);
    expect(own.map((f) => f.kind)).toEqual(['not-loaded']);
    expect(own[0].title).toContain('has no `version`');
    expect(own[0].detail).toContain('cannot be inherited from');
  });

  it('distinguishes a version that is present from one that is missing', () => {
    const half = byFile('process/Half Versioned.json');
    expect(index.notLoaded.get(half.id)).toEqual({ reason: 'bad-version' });
    const own = of(half.id);
    expect(own.map((f) => f.kind)).toEqual(['not-loaded']);
    expect(own[0].title).toContain('`version` is not a version');
    expect(own[0].detail).toContain('"1"');
  });

  // The suppression, which the issue rates as mattering as much as the finding. The
  // child stores 122 keys and every one of them is the only value it has, because
  // the parent is never applied.
  it('does not call the child’s only values redundant overrides', () => {
    expect(of(child.id).filter((f) => f.kind === 'redundant-overrides')).toEqual([]);
  });

  it('does not claim two unloaded siblings are identical in effect', () => {
    const pair = findings.filter(
      (f) =>
        f.kind === 'near-duplicate' &&
        f.presetIds.includes(child.id) &&
        f.presetIds.includes(sibling.id),
    );
    expect(pair).toEqual([]);
    // Nor paired with anything else: neither file is in the slicer at all.
    expect(findings.filter((f) => f.kind === 'near-duplicate' && f.presetIds.includes(child.id)))
      .toEqual([]);
  });

  it('says nothing else about a file the slicer never read', () => {
    // Exactly one finding each, and it is the one that explains the absence.
    expect(of(child.id).map((f) => f.kind)).toEqual(['broken-parent']);
    expect(of(grandchild.id).map((f) => f.kind)).toEqual(['broken-parent']);
  });

  // The control. A check that suppresses everything is not a check — the same shape
  // with a parseable `version` has to keep behaving as it always did.
  it('still gives ordinary advice when the parent does load', () => {
    expect(index.notLoaded.has(control.id)).toBe(false);
    expect(inheritanceChain(index, control).chain.map((p) => p.name)).toEqual([
      'Bench Rig C',
      'Bench Rig Base OK',
    ]);
    expect(of(control.id).map((f) => f.kind)).toContain('redundant-overrides');
  });

  it('draws the unresolved edge and marks the subtree dead', () => {
    const graph = buildGraph(index, { kinds: ['machine'] });
    const edge = graph.edges.find((e) => e.childId === child.id)!;
    expect(edge.resolved).toBe(false);
    expect(edge.reason).toBe('not-loaded');
    expect(edge.parentId).toBeUndefined();
    const dead = new Set(graph.nodes.filter((n) => n.shadowed).map((n) => n.id));
    for (const p of [base, child, sibling, grandchild]) expect(dead.has(p.id)).toBe(true);
    expect(dead.has(control.id)).toBe(false);
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
    // **Not** ambiguous, which changed with ORCA-22 and is the sharper answer.
    // The other claimant sits in `Studio Base Fine`'s own directory, so it was
    // never a candidate for *this* edge — the child could only ever have reached
    // the `base/` copy. The edge is no longer described as a coin toss that
    // happened to land right.
    expect(e?.ambiguous).toBe(false);
    // The name clash is still real, and still reported: when the folder pass runs,
    // `base/Studio Base` is already in the collection, so the folder file is
    // skipped with "Preset already present, not loading" (Preset.cpp:1617-1620).
    // Two different questions — "which file is dead" and "was this edge a guess".
    expect(node('user/default/process/Studio Base.json').shadowed).toBe(true);
    expect(node('process/base/Studio Base.json').shadowed).toBe(false);
    expect(index.notLoaded.get('user/default/process/Studio Base.json')?.reason).toBe('name-clash');
  });

  it('draws a hand-written loop as two unresolved edges, because it is not a loop', () => {
    // It used to draw as a pair of back edges. Since ORCA-22 it does not, and that
    // is the truer picture: `Loop A` and `Loop B` are in one directory, so each is
    // loaded in the same pass as the one it names and neither lookup ever finds
    // the other. The slicer skips both, separately, and there is no cycle to draw.
    const a = edgeFrom('Loop A.json');
    const b = edgeFrom('Loop B.json');
    for (const e of [a, b]) {
      expect(e?.resolved).toBe(false);
      expect(e?.back).toBe(false);
      expect(e?.reason).toBe('same-directory');
    }
    // Both presets are still in the graph: dropping them would hide the fault.
    expect(node('Loop A.json')).toBeDefined();
    expect(node('Loop B.json')).toBeDefined();
    expect(node('Loop A.json').shadowed).toBe(true);
    // …and the walk terminated, which is the whole reason for the visited set.
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
  });

  it('still marks a back edge where one can actually occur', () => {
    // The cycle guard is not dead code just because a *user* loop is impossible.
    // Within one vendor bundle we deliberately do not model `config_maps` build
    // order (`parse_subfile` fills it as the vendor's own list is walked), so two
    // presets in one bundle naming each other do resolve here — and the graph must
    // still close the loop with a marked edge rather than walking it forever.
    const built = buildIndex([
      { path: 'system/Acme/process/a.json', text: JSON.stringify({ name: 'Ring A', inherits: 'Ring B' }) },
      { path: 'system/Acme/process/b.json', text: JSON.stringify({ name: 'Ring B', inherits: 'Ring A' }) },
    ]);
    const ring = buildGraph(built, { includeSystemOnly: true });
    expect(ring.edges).toHaveLength(2);
    expect(ring.edges.every((e) => e.back)).toBe(true);
    expect(new Set(ring.nodes.map((n) => n.id)).size).toBe(2);
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
        path: 'user/default/machine/Shop One.json',
        // `version` matters here: a user preset whose version does not parse is
        // dropped by the slicer, and `compatibilityFor` no longer offers one.
        text: JSON.stringify({ name: 'Shop One', version: '2.4.0.3', inherits: 'Acme Base' }),
      },
      {
        path: 'user/default/filament/F.json',
        text: JSON.stringify({ name: 'F', version: '2.4.0.3', compatible_printers: ['Acme Base'] }),
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
    // sharing its `alias` (Preset.cpp:3704-3733). Built inline so both sides state
    // an `alias` outright; the fixture covers the *derived* alias separately.
    const built = buildIndex([
      {
        path: 'user/default/machine/Shop One.json',
        text: JSON.stringify({ name: 'Shop One', inherits: 'Vendor Base 0.4' }),
      },
      sysFilament('system/OrcaFilamentLibrary/filament/Generic PLA @System.json', { name: 'Generic PLA @System', alias: 'Generic PLA' }),
      sysFilament('system/Acme/filament/Generic PLA @Acme.json', {
          name: 'Generic PLA @Acme',
          alias: 'Generic PLA',
          compatible_printers: ['Vendor Base 0.4'],
        }),
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

  it('never offers a vendor base preset, which the slicer does not load at all', () => {
    // `instantiation: "false"` means the loader stores a config map for others to
    // inherit and returns before constructing a preset (PresetBundle.cpp:4929) —
    // so `fdm_filament_common` is not selectable for any printer, and listing it
    // as "available" would describe something that is not there.
    const names = [...c.filaments, ...c.processes].map((x) => x.preset.name);
    expect(names).not.toContain('fdm_filament_common');
    expect(names).not.toContain('fdm_filament_abs');
    expect(names).not.toContain('fdm_process_common');
    // …but an instantiable vendor preset is still offered.
    expect(names).toContain('Acme PLA @System');
  });

  it('keeps the Template vendor exception', () => {
    // The guard is `instantiation == "false" && "Template" != vendor_name`
    // (PresetBundle.cpp:4929), so a Template-vendor base *is* loaded.
    const built = buildIndex([
      { path: 'user/default/machine/M.json', text: JSON.stringify({ name: 'M' }) },
      sysFilament('system/Template/filament/base.json', { name: 'Template Base', instantiation: 'false' }),
      sysFilament('system/Acme/filament/base.json', { name: 'Acme Base', instantiation: 'false' }),
    ]);
    const r = compatibilityFor(built, built.presets.find((p) => p.name === 'M')!);
    const names = r.filaments.map((x) => x.preset.name);
    expect(names).toContain('Template Base');
    expect(names).not.toContain('Acme Base');
  });

  it('summarises without re-deriving anything', () => {
    const s = compatibilitySummary(c.filaments);
    expect(s.yes + s.no + s.undetermined + s.notInstalled).toBe(c.filaments.length);
    // One of the two conditional filaments is now decided; the `interpolate_table`
    // one is not, and must not be rounded to a boolean. Both are user presets, so
    // the installed gate never reaches them.
    expect(s.undetermined).toBe(1);
    // Every count comes from `offering`, so a header cannot disagree with its list.
    for (const [key, want] of [
      ['yes', 'available'],
      ['no', 'excluded'],
      ['undetermined', 'undetermined'],
      ['notInstalled', 'not-installed'],
    ] as const) {
      expect(s[key]).toBe(c.filaments.filter((x) => offering(x) === want).length);
    }
  });
});

describe('gates are inherited, because the slicer reads the resolved config', () => {
  // `preset.config = inherit_preset->config` followed by the file's own keys on
  // top (Preset.cpp:1679-1684), and every compatibility read goes through that
  // config (Preset.cpp:778, :800, :825; Preset.hpp:339, :347). A preset file is
  // therefore not what the slicer judges, and reading one as if it were reported
  // 47 filaments available where OrcaSlicer offered 18.
  const machine = byFile('user/default/machine/Workshop Cube.json');
  const c = compatibilityFor(index, machine);
  const of = (name: string) => {
    const v = [...c.filaments, ...c.processes].find((x) => x.preset.name === name);
    if (!v) throw new Error(`not judged: ${name}`);
    return v;
  };

  it('excludes a filament whose only compatible_printers is its parent’s', () => {
    // The bug, in one assertion. The file mentions no printers; the preset is
    // pinned to `Acme Cube 0.6 nozzle`, which this printer neither is nor
    // inherits. Read from the file it is "compatible with everything" and
    // available — the exact wrong answer, for most of a real config.
    expect(of('Studio ABS From Cube6')).toMatchObject({
      included: false,
      reason: 'excluded',
      evidence: {
        key: 'compatible_printers',
        value: 'Acme Cube 0.6 nozzle',
        // The point of walking the chain instead of flattening it: the verdict
        // names the file you would have to open.
        from: 'Acme ABS @Cube6',
      },
    });
    expect(offering(of('Studio ABS From Cube6'))).toBe('excluded');
  });

  it('offers that same filament for the printer its parent’s list names', () => {
    const cube6 = compatibilityFor(index, byFile('system/Acme/machine/Acme Cube 0.6 nozzle.json'));
    expect(cube6.filaments.find((x) => x.preset.name === 'Studio ABS From Cube6')).toMatchObject({
      included: true,
      reason: 'named-explicitly',
    });
  });

  it('lets a child clear an inherited list by stating an empty one', () => {
    // The failing direction for "stated counts, empty or not". The loader applies
    // the child's keys over the parent's config and an empty vector is a value, so
    // this preset is genuinely unpinned. Testing for a non-empty value instead
    // would fall through to the parent and invert it.
    expect(of('Studio ABS Unpinned')).toMatchObject({
      included: true,
      reason: 'compatible-with-everything',
    });
    expect(of('Studio ABS Unpinned').evidence.from).toBeUndefined();
  });

  it('judges a child by a condition only its parent states', () => {
    // `compatible_printers_condition()` is a config accessor, so this child is
    // decided by an expression that appears nowhere in its file — and this one is
    // false for the Acme Cube, so the verdict flips.
    expect(of('Studio PLA From Globex')).toMatchObject({
      included: false,
      reason: 'condition',
      evidence: {
        key: 'compatible_printers_condition',
        value: 'printer_notes=~/.*GLOBEX.*/',
        from: 'Acme PLA @Globex',
      },
    });
  });

  it('reads an inherited compatible_prints as the second gate', () => {
    expect(of('Studio PLA From Fine').processGate).toMatchObject({
      names: ['0.20mm Standard @Acme'],
      from: 'Acme PLA @Fine',
    });
    // And it still ANDs against a chosen process rather than being a note only.
    const scoped = compatibilityFor(index, machine, {
      process: byFile('user/default/process/Fast Draft.json'),
    });
    expect(scoped.filaments.find((x) => x.preset.name === 'Studio PLA From Fine')).toMatchObject({
      included: false,
      processGate: { passes: false },
    });
  });

  it('finds a user printer’s defaults on the vendor preset it was saved from', () => {
    // `Workshop Cube` states neither `default_*` key; both come from
    // `Acme Cube 0.4 nozzle`, and `PresetBundle` reads them off the printer's
    // config (PresetBundle.cpp:2142-2166).
    expect(machine.raw.default_filament_profile).toBeUndefined();
    expect(of('Acme PLA @System').isPrinterDefault).toBe(true);
    expect(of('0.20mm Standard @Acme').isPrinterDefault).toBe(true);
  });

  it('does not attribute a preset’s own gate to an ancestor', () => {
    // `from` is the difference between "your file says this" and "a vendor file
    // says this", and getting it wrong sends someone to edit the wrong preset.
    expect(of('Studio ABS').evidence.from).toBeUndefined();
    expect(of('Studio PLA Conditional').evidence.from).toBeUndefined();
  });
});

describe('the installed gate', () => {
  const machine = byFile('user/default/machine/Workshop Cube.json');
  const c = compatibilityFor(index, machine);
  const of = (name: string) => {
    const v = [...c.filaments, ...c.processes].find((x) => x.preset.name === name);
    if (!v) throw new Error(`not judged: ${name}`);
    return v;
  };

  it('is a second gate, not a re-reading of the first', () => {
    // The bug this whole thing exists for. `Shared PLA @System` names no printers,
    // so it is compatible with every one of them — and it is not in the conf's
    // `filaments`, so OrcaSlicer does not offer it. Both statements are true at
    // once, and collapsing them into one boolean is what listed 320 filaments
    // where the slicer listed 18.
    expect(of('Shared PLA @System')).toMatchObject({
      included: true,
      reason: 'compatible-with-everything',
      visibility: { visible: false, reason: 'not-installed' },
    });
    expect(offering(of('Shared PLA @System'))).toBe('not-installed');
  });

  it('offers a vendor filament the conf lists', () => {
    expect(of('Acme PLA @System').visibility).toMatchObject({
      visible: true,
      reason: 'installed',
      evidence: { key: 'filaments', value: 'Acme PLA @System' },
    });
    expect(offering(of('Acme PLA @System'))).toBe('available');
  });

  it('never gates a user preset, however absent from the conf it is', () => {
    // `if (vendor == nullptr) { return; }` (Preset.cpp:858). No user filament is
    // in the fixture's `filaments` list, and every one of them is still offered —
    // if this ever goes red the app shows a user their own presets as missing.
    const users = c.filaments.filter((x) => x.preset.origin === 'user');
    expect(users.length).toBeGreaterThan(5);
    expect(index.installed.filaments.has('Studio ABS')).toBe(false);
    for (const u of users) {
      expect(u.visibility).toMatchObject({ visible: true, reason: 'not-gated' });
    }
  });

  it('never gates a process, because the slicer does not', () => {
    // `set_visible_from_appconfig` handles TYPE_PRINTER, TYPE_FILAMENT and
    // TYPE_SLA_MATERIAL. A process is none of them, so a process list is decided
    // by compatibility alone — including the vendor ones.
    const system = c.processes.filter((x) => x.preset.origin === 'system');
    expect(system.length).toBeGreaterThan(0);
    for (const p of c.processes) {
      expect(p.visibility.reason).toBe('not-gated');
    }
  });

  it('counts a rename the conf has not caught up with as installed', () => {
    expect(of('Globex PETG @System').visibility).toMatchObject({
      visible: true,
      reason: 'installed-under-old-name',
      evidence: { key: 'renamed_from', value: 'Globex PETG Legacy' },
    });
  });

  it('derives the old name the loader derives, `@` deleted and space kept', () => {
    // "Acme PETG @Cube" -> "Acme PETG Cube": `alias_name` is not right-trimmed
    // until after the concatenation, so the space before the `@` survives
    // (PresetBundle.cpp:5089-5093). Off by that space and this preset reads as
    // uninstalled.
    expect(of('Acme PETG @Cube').visibility).toMatchObject({
      visible: true,
      reason: 'installed-under-old-name',
      evidence: { key: 'renamed_from', value: 'Acme PETG Cube' },
    });
  });

  it('does not derive an old name for a preset that states its own alias', () => {
    // The failing direction for the rule above: the conf lists "Acme PLA-CF Cube",
    // and `Acme PLA-CF @Cube` declares `alias`, so the C++ never builds that name
    // (`if (alias_name.empty())`, PresetBundle.cpp:5086). Deriving it regardless
    // would show a filament OrcaSlicer does not.
    expect(index.installed.filaments.has('Acme PLA-CF Cube')).toBe(true);
    expect(of('Acme PLA-CF @Cube').visibility).toMatchObject({
      visible: false,
      reason: 'not-installed',
    });
  });

  it('gates a vendor printer on its model and variant', () => {
    // Same vendor, same model, the other nozzle: the conf installs `0.4` only.
    expect(machineVisibility(index, byFile('system/Acme/machine/Acme Cube 0.4 nozzle.json'))).toMatchObject({
      visible: true,
      reason: 'variant-installed',
      evidence: { key: 'models', value: 'Acme · Acme Cube · 0.4' },
    });
    expect(machineVisibility(index, byFile('system/Acme/machine/Acme Cube 0.6 nozzle.json'))).toMatchObject({
      visible: false,
      reason: 'variant-not-installed',
    });
  });

  it('never gates a user printer', () => {
    expect(machineVisibility(index, machine)).toMatchObject({ reason: 'not-gated', visible: true });
  });

  it('leaves a vendor printer with nothing to gate on visible', () => {
    // `if (model.empty() || variant.empty()) return;` (Preset.cpp:861-863) leaves
    // `is_visible` at its load-time value, which for anything instantiable is
    // true. Reading the early return as "not installed" would hide every printer
    // preset that inherits its model rather than stating one.
    const built = buildIndex([
      { path: 'OrcaSlicer.conf', text: JSON.stringify({ models: [] }) },
      {
        path: 'system/Acme/machine/m.json',
        text: JSON.stringify({ name: 'No Model', instantiation: 'true' }),
      },
    ]);
    expect(machineVisibility(built, built.presets[0])).toMatchObject({
      visible: true,
      reason: 'no-variant-declared',
    });
  });

  it('applies no gate at all when there is no conf to read', () => {
    // Absent is not empty. Without the file we know nothing about what is
    // installed, and gating on that would empty the list on our own ignorance —
    // the same instinct as "a condition we cannot evaluate means compatible".
    const built = buildIndex([
      sysFilament('system/Acme/filament/f.json', { name: 'Acme PLA @System' }),
    ]);
    expect(built.installed.present).toBe(false);
    const v = visibilityIndex(built);
    expect([...v.values()][0]).toMatchObject({ visible: true, reason: 'config-unreadable' });
  });

  it('reads the map serialisation too, and an empty value means not installed', () => {
    // The C++ believes it is reading `name -> value` and tests
    // `! it->second.empty()` (Preset.cpp:869-872). Nothing writes that form today,
    // so this is the branch a future release reverting to ini would need.
    const built = buildIndex([
      {
        path: 'OrcaSlicer.conf',
        text: JSON.stringify({ filaments: { 'Acme PLA @System': 'true', 'Acme ABS @System': '' } }),
      },
      sysFilament('system/Acme/filament/a.json', { name: 'Acme PLA @System' }),
      sysFilament('system/Acme/filament/b.json', { name: 'Acme ABS @System' }),
    ]);
    expect([...built.installed.filaments]).toEqual(['Acme PLA @System']);
  });
});

describe('filaments the slicer installs on the user’s behalf', () => {
  // `load_installed_filaments` (PresetBundle.cpp:2541-2600): a visible vendor
  // printer with no compatible installed filament gets its model's
  // `default_materials` marked installed. Built here rather than in the fixture
  // because the shape needs a printer that *nothing* installed is compatible
  // with, and the fixture deliberately holds a filament compatible with
  // everything.
  const files = (installed: string[]) => [
    {
      path: 'OrcaSlicer.conf',
      text: JSON.stringify({
        filaments: installed,
        models: [{ vendor: 'Acme', model: 'Acme Cube', nozzle_diameter: '0.4' }],
      }),
    },
    {
      path: 'system/Acme.json',
      text: JSON.stringify({
        machine_model_list: [{ name: 'Acme Cube', sub_path: 'machine/Acme Cube.json' }],
      }),
    },
    {
      path: 'system/Acme/machine/Acme Cube.json',
      text: JSON.stringify({
        name: 'Acme Cube',
        nozzle_diameter: '0.4',
        default_materials: 'Acme PLA @System',
      }),
    },
    {
      path: 'system/Acme/machine/p.json',
      text: JSON.stringify({
        name: 'Acme Cube 0.4 nozzle',
        printer_model: 'Acme Cube',
        printer_variant: '0.4',
      }),
    },
    sysFilament('system/Acme/filament/default.json', { name: 'Acme PLA @System' }),
    // Installed, and pinned to a printer that is not this one — so it does not
    // count as "this printer already has a filament".
    sysFilament('system/Acme/filament/other.json', { name: 'Acme ABS @System', compatible_printers: ['Other Printer'] }),
  ];

  const visibilityOf = (installed: string[], name: string) => {
    const built = buildIndex(files(installed));
    const p = built.presets.find((x) => x.name === name)!;
    return visibilityIndex(built).get(p.id)!;
  };

  it('installs a printer model default when nothing installed fits that printer', () => {
    expect(visibilityOf(['Acme ABS @System'], 'Acme PLA @System')).toMatchObject({
      visible: true,
      reason: 'installed-as-default',
      evidence: { key: 'default_materials', value: 'Acme PLA @System' },
    });
  });

  it('does not install defaults for a printer that already has one', () => {
    // The failing direction, and the reason this is not just "always add the
    // defaults": `add_default_materials` is set false by the first installed
    // filament that fits (PresetBundle.cpp:2559-2566). Here `Acme ABS @System`
    // fits, so `Acme PLA @System` stays uninstalled.
    const built = buildIndex(
      files(['Acme ABS @System']).map((f) =>
        f.path === 'system/Acme/filament/other.json'
          ? { ...f, text: JSON.stringify({ name: 'Acme ABS @System' }) }
          : f,
      ),
    );
    const p = built.presets.find((x) => x.name === 'Acme PLA @System')!;
    expect(visibilityIndex(built).get(p.id)).toMatchObject({
      visible: false,
      reason: 'not-installed',
    });
  });

  it('does not seed from a printer the user has not installed', () => {
    // `if (printer.is_visible && …)` comes first (PresetBundle.cpp:2551). With no
    // installed variant the printer is not in the slicer's own list, so its
    // defaults are not installed on anyone's behalf either.
    const built = buildIndex(
      files(['Acme ABS @System']).map((f) =>
        f.path === 'OrcaSlicer.conf'
          ? {
              ...f,
              text: JSON.stringify({
                filaments: ['Acme ABS @System'],
                models: [{ vendor: 'Acme', model: 'Acme Cube', nozzle_diameter: '0.8' }],
              }),
            }
          : f,
      ),
    );
    const p = built.presets.find((x) => x.name === 'Acme PLA @System')!;
    expect(visibilityIndex(built).get(p.id)).toMatchObject({ visible: false });
  });

  it('reads default_materials off the model file, in the `;` form', () => {
    const model = index.vendorModels.find((m) => m.id === 'Acme Cube');
    expect(model?.defaultMaterials).toEqual(['Acme PLA @System', 'Acme ABS @System']);
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
      sysFilament('system/Acme/filament/base.json', { name: 'fdm_filament_common', instantiation: 'false' }),
      sysFilament('system/Globex/filament/base.json', { name: 'fdm_filament_common', instantiation: 'false' }),
    ]);
    expect(analyze(built).filter((f) => f.kind === 'duplicate-name')).toEqual([]);
    expect(shadowedIds(built).size).toBe(0);
  });

  it('lets the filament library win, because it is merged first', () => {
    // `OrcaFilamentLibrary` is loaded into the bundle synchronously before any
    // other vendor is merged (PresetBundle.cpp:2231-2241), so this clash is not a
    // coin toss and must not be reported as one.
    const built = buildIndex([
      sysFilament('system/OrcaFilamentLibrary/filament/x.json', { name: 'Generic PLA @System' }),
      sysFilament('system/Acme/filament/x.json', { name: 'Generic PLA @System' }),
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
      sysFilament('system/Template/filament/x.json', { name: 'Shared Base', instantiation: 'false' }),
      sysFilament('system/Acme/filament/x.json', { name: 'Shared Base' }),
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

  it('reduces OrcaSlicer.conf to the four fields the app needs', () => {
    const out = redactConfJson(
      JSON.stringify({
        app: { preset_folder: 'cloud-abc', other_setting: 'kept out' },
        access_code: { printer1: 'pairing-code' },
        user_access_code: 'secret',
        dev_sn: { a: 'SERIAL123' },
        local_machines: { '192.0.2.5': { dev_name: 'ender' } },
        filaments: ['Acme PLA @System'],
        models: [{ vendor: 'Acme', model: 'Acme Cube', nozzle_diameter: '0.4' }],
      }),
    );
    expect(JSON.parse(out)).toEqual({
      app: { preset_folder: 'cloud-abc' },
      filaments: ['Acme PLA @System'],
      models: [{ vendor: 'Acme', model: 'Acme Cube', nozzle_diameter: '0.4' }],
      // Readable, and genuinely names no `printer_type` — so an empty list is the
      // *config's* claim rather than ours, forwarded for the same reason a real
      // `filaments: []` is. An unreadable section is omitted instead; see below.
      bound_models: [],
    });
    for (const leak of ['pairing-code', 'SERIAL123', '192.0.2.5', 'ender', 'secret', 'kept out']) {
      expect(out).not.toContain(leak);
    }
  });

  it('takes only the model id out of local_machines, and nothing else', () => {
    // ORCA-18 widened the allowlist by one field, and this is the guard on it.
    // The input is written in the failing direction: every entry carries the
    // address, name and serial that a forwarded-object-with-fields-deleted would
    // emit, and the map is keyed by IP so the *keys* leak too if they are kept.
    const out = redactConfJson(
      JSON.stringify({
        local_machines: {
          '192.0.2.10': {
            dev_ip: '192.0.2.10',
            dev_name: 'Workshop Cube',
            dev_id: '00M00A000000001',
            access_code: '11223344',
            printer_type: 'acme-cube',
          },
          '198.51.100.7': {
            dev_ip: '198.51.100.7',
            dev_name: 'Back Room Box',
            dev_id: '00M00G000000003',
            printer_type: 'globex-box',
          },
          // A second device of a model already listed: deduped, so the payload
          // says which models are bound and not how many machines there are.
          '203.0.113.9': { dev_ip: '203.0.113.9', printer_type: 'acme-cube' },
        },
      }),
    );
    expect(JSON.parse(out).bound_models).toEqual(['acme-cube', 'globex-box']);
    for (const leak of [
      '192.0.2.10',
      '198.51.100.7',
      '203.0.113.9',
      'Workshop Cube',
      'Back Room Box',
      '00M00A000000001',
      '00M00G000000003',
      '11223344',
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it('omits bound_models when the section cannot be read', () => {
    // Absence is passed on as absence. An empty list would be the claim "no
    // printer is paired", and the reader acts on it by reporting nothing — so
    // manufacturing it out of a section we failed to read would turn a transport
    // accident into a clean bill of health.
    for (const value of ['not-an-object', 42, null, ['a', 'list']]) {
      const out = JSON.parse(redactConfJson(JSON.stringify({ local_machines: value })));
      expect(out).not.toHaveProperty('bound_models');
    }
    // …and absent entirely is absent too.
    expect(JSON.parse(redactConfJson('{}'))).not.toHaveProperty('bound_models');
  });

  it('rebuilds a models entry rather than forwarding it', () => {
    // The allowlist grew by two fields, and a field is not a subtree: an entry is
    // reassembled from the three keys `AppConfig::load` reads
    // (AppConfig.cpp:735-746), so anything sitting beside them inside it is gone
    // rather than merely unread. Written in the failing direction — the input
    // carries an address that a spread or a `JSON.parse` passthrough would emit.
    const out = redactConfJson(
      JSON.stringify({
        models: [
          {
            vendor: 'Acme',
            model: 'Acme Cube',
            nozzle_diameter: '0.4',
            dev_ip: '192.0.2.77',
            access_code: '00112233',
          },
        ],
      }),
    );
    expect(out).not.toContain('192.0.2.77');
    expect(out).not.toContain('00112233');
    expect(JSON.parse(out).models).toEqual([
      { vendor: 'Acme', model: 'Acme Cube', nozzle_diameter: '0.4' },
    ]);
  });

  it('normalises the installed filaments to the array form the slicer writes', () => {
    const out = JSON.parse(
      redactConfJson(JSON.stringify({ filaments: { 'Acme PLA @System': 'true', Blank: '' } })),
    );
    expect(out.filaments).toEqual(['Acme PLA @System']);
  });

  it('drops a models entry that cannot gate anything', () => {
    const out = JSON.parse(
      redactConfJson(
        JSON.stringify({
          models: [{ vendor: 'Acme', nozzle_diameter: '0.4' }, { model: 'X' }, 'not an object', null],
        }),
      ),
    );
    expect(out.models).toEqual([]);
  });

  it('still yields a usable conf when it cannot be parsed', () => {
    expect(JSON.parse(redactConfJson('{broken'))).toEqual({ app: { preset_folder: '' } });
  });

  it('omits a gate section it could not read instead of emitting it empty', () => {
    // Load-bearing, and the failing direction is the dangerous one: an empty
    // `filaments` is the claim "nothing is installed", and the reader acts on it
    // by hiding almost every filament. Emitting that for a conf we merely failed
    // to parse would empty the app's lists over a transport accident. Absence has
    // to survive the trip as absence.
    for (const input of ['{broken', JSON.stringify({ app: { preset_folder: '' } })]) {
      const out = JSON.parse(redactConfJson(input));
      expect(out).not.toHaveProperty('filaments');
      expect(out).not.toHaveProperty('models');
      expect(readInstalled([{ path: 'OrcaSlicer.conf', text: JSON.stringify(out) }]).present).toBe(
        false,
      );
    }
    // But a section the *config* stated is forwarded, empty and all: that claim is
    // the config's, and it is a real state.
    const stated = JSON.parse(redactConfJson(JSON.stringify({ filaments: [] })));
    expect(stated.filaments).toEqual([]);
    expect(
      readInstalled([{ path: 'OrcaSlicer.conf', text: JSON.stringify(stated) }]).present,
    ).toBe(true);
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

describe('a vendor inherits inside its own bundle', () => {
  const findings = analyze(index);
  const sys = (file: string) => {
    const p = index.active.find((x) => x.path === file);
    if (!p) throw new Error(`fixture missing: ${file}`);
    return p;
  };
  const inherits = (from: ReturnType<typeof sys>, name: string) =>
    classifyReference(index, from, from.kind, name, 'inherits');

  it('resolves a same-vendor parent', () => {
    // The control. This rule can turn a working chain into a reported fault, which
    // is the failure mode ORCA-10 was written to avoid, so the passing cases carry
    // as much weight as the failing one.
    const r = inherits(sys('system/Acme/filament/Acme ABS @System.json'), 'fdm_filament_abs');
    expect(r.reason).toBe('resolved');
    expect(r.target?.vendor).toBe('Acme');
  });

  it('resolves a library parent from another vendor', () => {
    // The one exemption. `OrcaFilamentLibrary` is loaded first, into the bundle every
    // other vendor then gets as its `base_bundle` (PresetBundle.cpp:2216-2245).
    const r = inherits(sys('system/Globex/filament/Globex PETG @System.json'), 'fdm_filament_common');
    expect(r.reason).toBe('resolved');
    expect(r.target?.vendor).toBe('OrcaFilamentLibrary');
  });

  it('refuses a cross-vendor parent that is not in the library', () => {
    const initech = sys('system/Initech/filament/Initech ABS @System.json');
    const r = inherits(initech, 'fdm_filament_abs');
    expect(r.reason).toBe('other-vendor');
    expect(r.target).toBeUndefined();
    // The file it names is still reported, so the finding can say whose it is.
    expect(r.others[0].vendor).toBe('Acme');
    expect(lookupParent(index, 'fdm_filament_abs', initech)).toBeUndefined();
  });

  it('names the owning vendor, and says the whole bundle fails', () => {
    const f = findings.filter((x) => x.id === 'bundle-failed:Initech');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('high');
    expect(f[0].title).toContain('Initech');
    expect(f[0].title).toContain('Acme');
    // Not "this preset is missing": the caller raises a ConfigurationError for the
    // vendor's entire bundle, which is a much bigger claim and the actionable one.
    expect(f[0].detail).toContain("Initech's entire bundle");
    expect(f[0].detail).toContain('PresetBundle.cpp:2216-2219');
    expect(f[0].reference?.unresolved[0].reason).toBe('other-vendor');
  });

  it('groups one finding per vendor, not one per preset', () => {
    const built = buildIndex([
      sysFilament('system/Acme/filament/b.json', { name: 'acme_base', instantiation: 'false' }),
      sysFilament('system/Globex/filament/x.json', { name: 'X', inherits: 'acme_base' }),
      sysFilament('system/Globex/filament/y.json', { name: 'Y', inherits: 'acme_base' }),
    ]);
    // One finding, naming one violating preset — not two findings, and not a list
    // of every preset the vendor happens to ship. The failure is per bundle.
    const f = analyze(built).filter((x) => x.id.startsWith('bundle-failed:'));
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe('bundle-failed:Globex');
    expect(f[0].presetIds).toHaveLength(1);
  });

  it('does not let a non-filament reach the library', () => {
    // `m_config_maps` is handed to the base bundle right after the *filament* loop
    // and the maps are cleared per preset type (PresetBundle.cpp:5133-5151), so the
    // shared bundle can carry a filament base and nothing else.
    const built = buildIndex([
      {
        path: 'system/OrcaFilamentLibrary/machine/b.json',
        text: JSON.stringify({ name: 'shared_machine_base', instantiation: 'false' }),
      },
      {
        path: 'system/Acme/machine/x.json',
        text: JSON.stringify({ name: 'X', inherits: 'shared_machine_base' }),
      },
    ]);
    const from = built.active.find((p) => p.name === 'X')!;
    expect(classifyReference(built, from, 'machine', 'shared_machine_base', 'inherits').reason).toBe(
      'other-vendor',
    );
  });

  it('does not let the library itself reach another vendor', () => {
    // It is loaded with no `base_bundle` of its own (PresetBundle.cpp:2231-2241).
    const built = buildIndex([
      sysFilament('system/Acme/filament/b.json', { name: 'acme_base', instantiation: 'false' }),
      sysFilament('system/OrcaFilamentLibrary/filament/x.json', { name: 'Lib PLA', inherits: 'acme_base' }),
    ]);
    const from = built.active.find((p) => p.name === 'Lib PLA')!;
    expect(classifyReference(built, from, 'filament', 'acme_base', 'inherits').reason).toBe(
      'other-vendor',
    );
  });

  it('does not apply the bundle boundary to a user preset', () => {
    // A user preset inherits inside its own collection, which holds every vendor's
    // presets after the merge. Scoping it would invent faults across the fixture.
    const studio = sys('user/default/filament/Studio ABS.json');
    expect(inherits(studio, 'Acme ABS @System').reason).toBe('resolved');
    for (const p of index.active.filter((x) => x.origin === 'user' && x.inherits)) {
      const r = classifyReference(index, p, p.kind, p.inherits as string, 'inherits');
      expect(r.reason).not.toBe('other-vendor');
    }
  });

  it('does not apply the bundle boundary to keys that are not `inherits`', () => {
    // The guard that keeps this from inventing faults. `compatible_printers` and the
    // `default_*` keys are matched against the merged collections long after the
    // bundles are loaded, so a vendor naming another vendor's printer is ordinary —
    // and `classifyReference` defaults to that permissive reading.
    const built = buildIndex([
      {
        path: 'system/Acme/machine/p.json',
        text: JSON.stringify({ name: 'Acme Cube 0.4 nozzle', instantiation: 'true' }),
      },
      sysFilament('system/Globex/filament/f.json', {
          name: 'Globex PLA',
          compatible_printers: ['Acme Cube 0.4 nozzle'],
        }),
    ]);
    const from = built.active.find((p) => p.name === 'Globex PLA')!;
    expect(classifyReference(built, from, 'machine', 'Acme Cube 0.4 nozzle').reason).toBe('resolved');
    // And explicitly under the stricter reading it would not, which is why the
    // parameter exists rather than the rule being global.
    expect(
      classifyReference(built, from, 'machine', 'Acme Cube 0.4 nozzle', 'inherits').reason,
    ).toBe('other-vendor');
  });

  it('leaves the fixture’s vendor machine bases unreported', () => {
    // Acme, Globex and Initech each ship `fdm_machine_common`, which they have to:
    // the library cannot supply a machine base. A base never enters a collection
    // (PresetBundle.cpp:4929), so this is not a duplicate name.
    const both = index.active.filter((p) => p.name === 'fdm_machine_common');
    expect(both).toHaveLength(4);
    expect(new Set(both.map((p) => p.vendor))).toEqual(
      new Set(['Acme', 'Globex', 'Initech', 'Bluth']),
    );
    expect(findings.filter((f) => f.kind === 'duplicate-name' && f.title.includes('fdm_machine_common'))).toEqual([]);
  });

  it('does not move the deepest chain', () => {
    // The issue asked for this rather than assuming nothing else shifts: the
    // fixture's deepest chain is a user process and is unaffected by a vendor rule.
    expect(stats(index).deepestChain).toEqual({ name: '0.28mm Draft @Acme - Copy', depth: 5 });
  });
});

describe('a failed vendor bundle takes everything the vendor ships', () => {
  // ORCA-26. `parse_subfile` returning a reason is not a skipped preset: each of
  // the three per-type loops turns it into `throw ConfigurationError`
  // (PresetBundle.cpp:5123-5129, :5141-5147, :5161-5167), the vendor was loaded
  // into a temporary `PresetBundle` (:2253), and a bundle that threw is never
  // merged (:2271-2283). Initech is the fixture's doomed vendor.
  const findings = analyze(index);
  const initech = index.active.filter((p) => p.vendor === 'Initech');
  const failure = (id: string) => index.notLoaded.get(id);

  it('marks every one of the vendor’s presets, not just the violating one', () => {
    expect(initech.length).toBeGreaterThan(3);
    for (const p of initech) {
      expect(failure(p.id)).toMatchObject({ reason: 'bundle-failed', vendor: 'Initech' });
    }
    // Including the presets with nothing wrong with them, which is the whole
    // point — `Initech PLA @System` inherits a library base and would load fine
    // in a bundle that had not already thrown.
    expect(failure('system/Initech/filament/Initech PLA @System.json')).toMatchObject({
      reason: 'bundle-failed',
      parentName: 'fdm_filament_abs',
    });
  });

  it('names one violating preset as the cause, so the failure is explainable', () => {
    expect(index.failedVendors.get('Initech')).toMatchObject({
      vendor: 'Initech',
      presetName: 'Initech ABS @System',
      inherits: 'fdm_filament_abs',
      ownerVendor: 'Acme',
    });
  });

  it('leaves the other vendors completely untouched', () => {
    // The parallel loads are independent (PresetBundle.cpp:2250-2265), so one bad
    // bundle must not take a good one with it. This is the guard against the
    // change quietly emptying a healthy config.
    // Four vendors fail, each tripping a different guard, and each is reported as
    // the guard that actually fired first rather than a generic "bad bundle".
    expect(
      Object.fromEntries([...index.failedVendors].map(([v, f]) => [v, f.guard])),
    ).toEqual({
      Initech: 'inherits',
      Hooli: 'model-file-missing',
      Vandelay: 'preset-file-missing',
      Bluth: 'printer-model-undeclared',
    });
    // …and the three healthy vendors are untouched, which is the guard against
    // this change quietly emptying a config.
    const healthy = ['Acme', 'Globex', 'OrcaFilamentLibrary'];
    for (const v of healthy) expect(index.failedVendors.has(v)).toBe(false);
    for (const p of index.active) {
      if (!p.vendor || !healthy.includes(p.vendor)) continue;
      expect(failure(p.id)?.reason).not.toBe('bundle-failed');
    }
    // And Acme, whose base was the one reached for, still resolves it itself.
    const acme = index.active.find((p) => p.path === 'system/Acme/filament/Acme ABS @System.json')!;
    expect(classifyReference(index, acme, 'filament', 'fdm_filament_abs', 'inherits').reason).toBe(
      'resolved',
    );
  });

  it('does not count them as loaded', () => {
    const s = stats(index);
    expect(s.notLoaded).toBeGreaterThanOrEqual(initech.length);
    // Four of the seven fail, and each fails a different way — see the
    // bundle-guard suite. `vendors` is what is on disk; this is the subset the
    // slicer never ends up holding.
    expect(s.failedVendors).toEqual(['Bluth', 'Hooli', 'Initech', 'Vandelay']);
    // The count has to be the loaded set, not the on-disk set: the badge reading
    // higher than the slicer's is the symptom this issue is about. `bases` is the
    // other subtraction (ORCA-9) and the two have to compose, not overlap.
    const loaded = index.active.filter((p) => !index.notLoaded.has(p.id));
    expect(s.system + s.user + s.bases).toBe(loaded.length);
    expect(s.system + s.user + s.bases).toBeLessThan(index.active.length);
  });

  it('takes the vendor’s printer models with it', () => {
    // `vendor_profile.models` is emplaced into the same temporary bundle at
    // PresetBundle.cpp:4824, before any preset is read, and reaches the app only
    // through the merge at :2422.
    expect(index.vendorModels.some((m) => m.vendor === 'Initech')).toBe(true);
    expect(loadedVendorModels(index).some((m) => m.vendor === 'Initech')).toBe(false);
    expect(loadedVendorModels(index).some((m) => m.vendor === 'Acme')).toBe(true);
  });

  it('stops offering the vendor’s filaments for a printer', () => {
    const c = compatibilityFor(index, byFile('user/default/machine/Workshop Cube.json'));
    expect(c.filaments.some((x) => x.preset.vendor === 'Initech')).toBe(false);
    // …and still offers the healthy vendors', so this is not "offer nothing".
    expect(c.filaments.some((x) => x.preset.vendor === 'Acme')).toBe(true);
  });

  it('draws them as dead in the graph rather than dropping them', () => {
    // Silent absence is the failure mode this issue's "care needed" section warns
    // about, so the node stays and is marked.
    const g = buildGraph(index, { includeSystemOnly: true });
    const node = g.nodes.find((n) => n.id === 'system/Initech/filament/Initech PLA @System.json');
    expect(node).toBeDefined();
    expect(node?.shadowed).toBe(true);
  });

  it('says in the finding what actually disappears', () => {
    const f = findings.find((x) => x.id === 'bundle-failed:Initech')!;
    expect(f.detail).toContain("Initech's entire bundle");
    expect(f.detail).toContain('printer model');
    // Abbreviated after the file is named once earlier in the same sentence.
    expect(f.detail).toContain('(:4824)');
    expect(f.detail).toContain('(:2422)');
  });

  it('cascades into a user preset that inherits from the dropped vendor', () => {
    const built = buildIndex([
      sysFilament('system/Acme/filament/base.json', { name: 'acme_base', instantiation: 'false' }),
      sysFilament('system/Initech/filament/bad.json', { name: 'Initech ABS', inherits: 'acme_base' }),
      sysFilament('system/Initech/filament/ok.json', { name: 'Initech PLA' }),
      {
        path: 'user/default/filament/Mine.json',
        text: JSON.stringify({ name: 'Mine', version: '2.4.0.3', inherits: 'Initech PLA' }),
      },
    ]);
    expect(built.notLoaded.get('system/Initech/filament/ok.json')?.reason).toBe('bundle-failed');
    // The user gate is the existing `inherits` fixpoint: the parent is not in the
    // collection, so the child is skipped exactly as if its version had failed.
    expect(built.notLoaded.get('user/default/filament/Mine.json')).toMatchObject({
      reason: 'parent-not-loaded',
      parentName: 'Initech PLA',
    });
  });

  it('does not fail a bundle over a parent that is simply absent', () => {
    // Deliberately narrower than the C++, and in lockstep with the finding: the
    // slicer fails the bundle here too, but `crossVendorInheritFindings` does not
    // report an absent name, and a vendor emptying out with nothing on screen to
    // explain it is worse than one wrongly present.
    const built = buildIndex([
      sysFilament('system/Initech/filament/x.json', { name: 'X', inherits: 'nothing_has_this_name' }),
    ]);
    expect(built.failedVendors.size).toBe(0);
    expect(built.notLoaded.size).toBe(0);
  });

  it('does not fail a bundle whose inherits resolve inside it', () => {
    // The control for the whole rule. A healthy two-vendor config must come back
    // with nothing marked at all.
    const built = buildIndex([
      sysFilament('system/OrcaFilamentLibrary/filament/base.json', { name: 'fdm_filament_common', instantiation: 'false' }),
      sysFilament('system/Acme/filament/a.json', { name: 'Acme PLA', inherits: 'fdm_filament_common' }),
      {
        path: 'system/Globex/machine/base.json',
        text: JSON.stringify({ name: 'globex_base', instantiation: 'false' }),
      },
      {
        path: 'system/Globex/machine/m.json',
        text: JSON.stringify({ name: 'Globex Box', inherits: 'globex_base' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
    expect([...built.notLoaded.keys()]).toEqual([]);
    expect(stats(built).notLoaded).toBe(0);
  });

  it('fails each violating bundle separately, and only those', () => {
    const built = buildIndex([
      sysFilament('system/Acme/filament/base.json', { name: 'acme_base', instantiation: 'false' }),
      sysFilament('system/Acme/filament/a.json', { name: 'Acme PLA', inherits: 'acme_base' }),
      sysFilament('system/Globex/filament/g.json', { name: 'Globex PLA', inherits: 'acme_base' }),
      sysFilament('system/Initech/filament/i.json', { name: 'Initech PLA', inherits: 'acme_base' }),
    ]);
    expect([...built.failedVendors.keys()].sort()).toEqual(['Globex', 'Initech']);
    expect(built.notLoaded.has('system/Acme/filament/a.json')).toBe(false);
    // Acme's two files and nothing else — the other two are gone with their
    // bundles. One of Acme's is a base, so it lands in `bases` rather than
    // `system` (ORCA-9); together they are the whole loaded set.
    const s = stats(built);
    expect([s.system, s.bases, s.notLoaded]).toEqual([1, 1, 2]);
  });
});

describe('the printer_model / printer_variant guards read the chain', () => {
  // ORCA-19. Over one real config the app emitted 28 `HIGH` findings of the shape
  // "<PRESET> declares no printer_variant, so it is never loaded" — every `HIGH`
  // finding it produced for that config — while OrcaSlicer's own log for the same
  // config had **no** matching line.
  //
  // The issue offered two explanations: the slicer logs it below the default level,
  // or the condition tested here is not the condition the slicer tests. It is the
  // second. Two facts settle it, both read at v2.4.2:
  //
  //  1. The guards log at `BOOST_LOG_TRIVIAL(error)` (PresetBundle.cpp:4975, :4983),
  //     which is well above the default level — a real hit would be in the log. So
  //     explanation 1 is ruled out rather than merely unlikely.
  //  2. They read `config.opt_string("printer_variant")` *after*
  //     `config = *default_config; config.apply(config_src);` (:4926-4927) — the
  //     value with inheritance applied, not the file's own key.
  const findings = analyze(index);
  const inheriting = byFile('system/Acme/machine/Acme Cube 0.4 nozzle Fast.json');

  it('does not flag a preset that inherits both values', () => {
    // The whole issue, in one assertion. This preset states neither key and
    // inherits both from `Acme Cube 0.4 nozzle`.
    expect(inheriting.raw.printer_model).toBeUndefined();
    expect(inheriting.raw.printer_variant).toBeUndefined();
    expect(resolve(index, inheriting).settings.get('printer_model')?.value).toBe('Acme Cube');
    expect(resolve(index, inheriting).settings.get('printer_variant')?.value).toBe('0.4');
    expect(findings.filter((f) => f.presetIds.includes(inheriting.id))).toEqual([]);
  });

  it('still flags a preset whose resolved model the vendor never declares', () => {
    // The control in the other direction: reading the chain must not rescue a
    // preset that is genuinely wrong. Bluth's `Bluth Stair Car 0.4 nozzle` states
    // a `printer_model` its own vendor index has no entry for.
    const f = findings.find((x) => x.id === 'bundle-failed:Bluth');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('high');
    expect(f?.title).toContain('Bluth Stair Car 0.4 nozzle');
    expect(f?.reference?.key).toBe('printer_model');
  });

  it('says the whole bundle fails, not that one preset is ignored', () => {
    // The log text is "it will be ignored" and the finding used to repeat it. Each
    // guard returns a reason, and the machine loop turns that into a throw for the
    // vendor (PresetBundle.cpp:5161-5167) whose bundle is then never merged
    // (:2271-2283). Quoting the slicer's own misleading sentence as the consequence
    // understated it by a whole bundle.
    const f = findings.find((x) => x.id === 'bundle-failed:Bluth')!;
    expect(f.detail).toContain("Bluth's entire bundle");
    expect(f.detail).toContain('PresetBundle.cpp:5123-5129');
    expect(f.detail).toContain('understates it by a whole bundle');
  });

  it('reports no printer_variant finding anywhere in the fixture', () => {
    // Every fixture printer preset either states a valid variant or inherits one,
    // which is what a healthy bundle looks like. This is the assertion that would
    // have caught the 28 false positives: it counts them rather than describing
    // them.
    expect(findings.filter((f) => f.id.startsWith('printer-variant:'))).toEqual([]);
  });
});

describe('a user preset cannot inherit from a sibling in its own directory', () => {
  // ORCA-22. `load_presets` collects a directory into a **local** deque
  // (Preset.cpp:1609) and merges it into the collection only after the whole
  // directory has been walked (:1764-1765), while the `inherits` lookup is a binary
  // search over the already-merged collection (`find_preset2` → `find_preset` →
  // `find_preset_internal`, :3229, :3211-3213). So nothing loaded in the current
  // pass is visible, and an `inherits` can only reach an *earlier* pass.
  //
  // This is the rule that can invent faults, so the passing cases below carry as
  // much weight as the failing ones.
  const findings = analyze(index);
  const inherits = (p: ReturnType<typeof byFile>, name: string) =>
    classifyReference(index, p, p.kind, name, 'inherits');
  const of = (id: string) => findings.filter((f) => f.presetIds.includes(id));

  it('still resolves a `base/` root from the folder proper', () => {
    // The control that matters most. `base/` is a separate, *completed* recursive
    // call made before the folder is read (Preset.cpp:1583-1586), so it is an
    // earlier pass and must keep working. Break this and the rule empties configs.
    const child = byFile('machine/Bench Rig C.json');
    const r = inherits(child, 'Bench Rig Base OK');
    expect(r.reason).toBe('resolved');
    expect(r.target?.path).toBe('user/default/machine/base/Bench Rig Base OK.json');
    expect(index.notLoaded.has(child.id)).toBe(false);
    expect(resolve(index, child).chain).toHaveLength(2);
  });

  it('still resolves a system parent from anywhere', () => {
    // The system bundles are merged before any user folder is read, so they are
    // always an earlier pass.
    const studio = byFile('user/default/filament/Studio ABS.json');
    expect(inherits(studio, 'Acme ABS @System').reason).toBe('resolved');
    // And nothing in the fixture that reaches a system parent broke. `shadowed`
    // counts as reaching it — it means the name resolved *and* other files claim
    // it, which is the two-vendors-one-name shape and not a failure.
    for (const p of index.active) {
      if (p.origin !== 'user' || !p.inherits) continue;
      const r = inherits(p, p.inherits);
      if (r.target?.origin === 'system') expect(['resolved', 'shadowed']).toContain(r.reason);
    }
  });

  it('refuses a sibling in the same directory, and names the rule', () => {
    const fine = byFile('machine/Bench Rig A Fine.json');
    const r = inherits(fine, 'Bench Rig A');
    expect(r.reason).toBe('same-directory');
    expect(r.target).toBeUndefined();
    // The file it names is still reported, so the finding can point at it.
    expect(r.others.map((o) => o.path)).toContain('user/default/machine/Bench Rig A.json');
    // "absent" would send someone looking for a file that is right there.
    const f = of(fine.id).find((x) => x.kind === 'broken-parent')!;
    expect(f.detail).toContain('same pass');
    expect(f.detail).toContain('Preset.cpp:1609');
    expect(f.detail).not.toContain('not installed');
  });

  it('refuses one `base/` preset naming another', () => {
    // `base/` is one pass of its own, so the rule applies inside it too — the case
    // that looks like it should work, because `base/` is "loaded first".
    const derived = byFile('machine/base/Bench Rig Base Derived.json');
    expect(derived.isCustomRoot).toBe(true);
    expect(inherits(derived, 'Bench Rig Base Shared').reason).toBe('same-directory');
    expect(index.notLoaded.get(derived.id)).toEqual({
      reason: 'parent-not-loaded',
      parentName: 'Bench Rig Base Shared',
    });
    // …and the one it names is untouched, since it has no parent of its own.
    expect(index.notLoaded.has(byFile('machine/base/Bench Rig Base Shared.json').id)).toBe(false);
  });

  it('does not let a `base/` preset reach the folder proper', () => {
    // The other direction, and why this is `isCustomRoot` rather than a directory
    // comparison: `base/` runs *before* the folder, so a `base/` preset naming a
    // folder preset is naming a **later** pass. Comparing directories alone would
    // resolve it — and a config could then describe a cycle the slicer cannot have.
    const built = buildIndex([
      {
        path: 'user/default/process/base/Root.json',
        text: JSON.stringify({ name: 'Root', version: '2.4.0.3', inherits: 'Leaf' }),
      },
      {
        path: 'user/default/process/Leaf.json',
        text: JSON.stringify({ name: 'Leaf', version: '2.4.0.3' }),
      },
    ]);
    const root = built.active.find((p) => p.name === 'Root')!;
    expect(classifyReference(built, root, 'process', 'Leaf', 'inherits').reason).toBe(
      'same-directory',
    );
  });

  it('makes a user-to-user loop impossible', () => {
    // Every user edge runs from a later pass to an earlier one, so no chain of them
    // returns. `Loop A` and `Loop B` are a hand-written cycle, and the slicer sees
    // two independently broken files rather than a loop.
    for (const name of ['Loop A', 'Loop B']) {
      const p = byFile(`process/${name}.json`);
      expect(inherits(p, p.inherits as string).reason).toBe('same-directory');
      expect(resolve(index, p).circular).toBe(false);
      expect(index.notLoaded.get(p.id)?.reason).toBe('parent-not-loaded');
    }
    // No user chain in the whole fixture reports as circular any more.
    expect(index.active.filter((p) => p.origin === 'user' && resolve(index, p).circular)).toEqual(
      [],
    );
  });

  it('leaves keys that are not `inherits` alone', () => {
    // The guard against the rule leaking. `compatible_printers` and the `default_*`
    // keys are matched against the merged collections long after every pass is
    // done, so a preset naming a sibling there is ordinary — and `classifyReference`
    // defaults to that permissive reading.
    const built = buildIndex([
      {
        path: 'user/default/machine/Shop One.json',
        text: JSON.stringify({ name: 'Shop One', version: '2.4.0.3' }),
      },
      {
        path: 'user/default/filament/Mine.json',
        text: JSON.stringify({
          name: 'Mine',
          version: '2.4.0.3',
          compatible_printers: ['Shop One'],
        }),
      },
    ]);
    const f = built.active.find((p) => p.name === 'Mine')!;
    expect(classifyReference(built, f, 'machine', 'Shop One').reason).toBe('resolved');
  });

  it('does not move the deepest chain', () => {
    // The issue asked for this rather than assuming nothing else shifts. The
    // fixture's deepest chain runs through system presets, which the rule does not
    // touch — a user chain is now at most `<kind>/` → `<kind>/base/` deep.
    expect(stats(index).deepestChain).toEqual({ name: '0.28mm Draft @Acme - Copy', depth: 5 });
  });
});

describe('the alias a library exclusion joins on is derived, not stated', () => {
  // ORCA-23. A vendor preset's alias is never empty by the time
  // `update_library_profile_excluded_from` compares them: stated, else the name up
  // to the first `@` right-trimmed, else the whole name
  // (PresetBundle.cpp:5086-5097). Keying on the stated value alone computed *no*
  // exclusions for a library filament that states none — the exact case
  // `m_excluded_from` exists for.
  const cube04 = byFile('system/Acme/machine/Acme Cube 0.4 nozzle.json');
  const cube06 = byFile('system/Acme/machine/Acme Cube 0.6 nozzle.json');
  const workshop = byFile('user/default/machine/Workshop Cube.json');
  const verdict = (machine: typeof cube04, name: string) =>
    compatibilityFor(index, machine).filaments.find((x) => x.preset.name === name);

  it('excludes on an alias neither file states', () => {
    // `Generic PLA  @System` (library, no `alias`) and `Generic PLA @Acme Cube`
    // (Acme, no `alias`, names this printer) both derive "Generic PLA". Neither
    // file mentions the other; the derived alias is the whole join.
    expect(verdict(cube04, 'Generic PLA  @System')).toMatchObject({
      included: false,
      reason: 'excluded-by-library',
      // The derived alias, because that is what the exclusion was keyed on. The
      // preset's own name here would read "Generic PLA  @System", which is not
      // the value anything was joined on.
      evidence: { key: 'alias', value: 'Generic PLA' },
    });
  });

  it('right-trims the derived alias', () => {
    // Two spaces before the `@` in the fixture, on purpose: `boost::trim_right`
    // runs on the alias, and the near-identical `renamed_from` derivation on the
    // line above concatenates *before* that trim and keeps them. One character
    // between two rules — pinned here so folding them together goes red.
    const lib = byFile('system/OrcaFilamentLibrary/filament/Generic PLA  @System.json');
    expect(lib.name).toBe('Generic PLA  @System');
    expect(verdict(cube04, lib.name)?.evidence.value).toBe('Generic PLA');
  });

  it('treats a name with no `@` as its own alias', () => {
    // The last branch: `if (alias_name.empty()) loaded.alias = preset_name;`.
    // `Generic TPU` has no `@`, and Acme's `Generic TPU @Acme Cube` derives the
    // same string and names the 0.6 printer.
    expect(verdict(cube06, 'Generic TPU')).toMatchObject({
      included: false,
      reason: 'excluded-by-library',
      evidence: { key: 'alias', value: 'Generic TPU' },
    });
    // …and only for that printer. An exclusion is per printer, not global.
    expect(verdict(cube04, 'Generic TPU')?.reason).not.toBe('excluded-by-library');
  });

  it('lets a stated alias win over anything derived from the name', () => {
    // `Generic PETG @System` states `alias: "Library PETG"`, so Acme's
    // `Generic PETG @Acme Cube` — which derives "Generic PETG" — does not join it.
    // Without this the derivation would silently override a vendor's own choice.
    expect(verdict(cube04, 'Generic PETG @System')?.reason).not.toBe('excluded-by-library');
  });

  it('does not exclude the library filament for an unrelated printer', () => {
    // The control. This rule can only ever remove things from a list, so a test
    // that an unrelated printer is unaffected carries as much weight as the
    // failing case. `Bench Rig C` descends from a user custom root, not from an
    // Acme Cube, and none of Acme's tuned generics names it.
    const bench = byFile('user/default/machine/Bench Rig C.json');
    expect(verdict(bench, 'Generic PLA  @System')?.reason).not.toBe('excluded-by-library');
    expect(verdict(bench, 'Generic TPU')?.reason).not.toBe('excluded-by-library');
  });

  it('carries the exclusion to a user printer through its `inherits`', () => {
    // Not an accident of the derivation, and worth pinning because the control
    // above was written expecting the opposite: the exclusion is checked against
    // the printer's name **or its `inherits`** (Preset.cpp:816-824). `Workshop
    // Cube` inherits `Acme Cube 0.4 nozzle`, so Acme's tuned `Generic PLA` wins
    // there too — which is the behaviour someone saving a printer from a vendor
    // preset actually gets.
    expect(workshop.inherits).toBe('Acme Cube 0.4 nozzle');
    expect(verdict(workshop, 'Generic PLA  @System')).toMatchObject({
      included: false,
      reason: 'excluded-by-library',
      evidence: { key: 'alias', value: 'Generic PLA' },
    });
    // And not for the alias Acme pinned to the *other* nozzle.
    expect(verdict(workshop, 'Generic TPU')?.reason).not.toBe('excluded-by-library');
  });

  it('ignores a user filament, however its alias comes out', () => {
    // `if (preset.vendor == nullptr …) continue;` (Preset.cpp:3718-3720) — and
    // `vendor` is set only for presets out of a vendor bundle
    // (PresetBundle.cpp:5057), so a user preset contributes no exclusions at all.
    //
    // Load-bearing precisely *because* the alias is now derived: this user preset
    // derives "Generic PLA" from its own name, and without the guard it would
    // exclude the library's copy for a printer the slicer never excludes it for.
    const built = buildIndex([
      sysFilament('system/OrcaFilamentLibrary/filament/lib.json', { name: 'Generic PLA @System' }),
      {
        path: 'user/default/machine/Shop One.json',
        text: JSON.stringify({ name: 'Shop One', version: '2.4.0.3' }),
      },
      {
        path: 'user/default/filament/Generic PLA @Mine.json',
        text: JSON.stringify({
          name: 'Generic PLA @Mine',
          version: '2.4.0.3',
          compatible_printers: ['Shop One'],
        }),
      },
    ]);
    const printer = built.presets.find((p) => p.name === 'Shop One')!;
    const r = compatibilityFor(built, printer).filaments.find(
      (x) => x.preset.name === 'Generic PLA @System',
    );
    expect(r?.reason).not.toBe('excluded-by-library');
    expect(r?.included).toBe(true);
  });
});

describe('every parse_subfile guard costs the whole vendor bundle', () => {
  // ORCA-27. `parse_subfile` returns a reason in more than one place, and each of
  // the three per-type loops turns a reason into `throw ConfigurationError`
  // (PresetBundle.cpp:5123-5129, :5141-5147, :5161-5167). The vendor is loaded into
  // a temporary `PresetBundle` (:2253) merged only when nothing threw
  // (:2271-2283), so every one of them costs the vendor rather than the preset.
  //
  // Four are demonstrated end to end in the fixture, one vendor each, because each
  // needed a home that could afford to die. The two "empty" printer guards are
  // synthetic here: a fixture vendor for each would be four more dead vendors for
  // no extra coverage.
  const vendorOf = (built: ConfigIndex, v: string) => built.failedVendors.get(v)?.guard;

  it('reports each fixture vendor under the guard that actually fired', () => {
    expect(
      Object.fromEntries([...index.failedVendors].map(([v, f]) => [v, f.guard])),
    ).toEqual({
      Initech: 'inherits',
      Hooli: 'model-file-missing',
      Vandelay: 'preset-file-missing',
      Bluth: 'printer-model-undeclared',
    });
  });

  it('loses everything a vendor ships when a listed preset file is absent', () => {
    // Vandelay's `Vandelay PLA @System` is correct in every respect and absent
    // from the slicer anyway, because a *sibling* entry in the same list has no
    // file. `load_from_json` catches every failure to read and sets a reason
    // (Config.cpp:278-291), which `parse_subfile` returns at :4861-4866.
    const ok = byFile('system/Vandelay/filament/Vandelay PLA @System.json');
    expect(index.notLoaded.get(ok.id)).toMatchObject({
      reason: 'bundle-failed',
      vendor: 'Vandelay',
    });
  });

  it('fires the printer guards off the chain, not off the file', () => {
    // Composes with ORCA-19: the guard runs after `config.apply(config_src)`
    // (:4926-4927). A preset that inherits a *valid* model must not trip it…
    const built = buildIndex([
      {
        path: 'system/Acme.json',
        text: JSON.stringify({
          name: 'Acme',
          machine_model_list: [{ name: 'Cube', sub_path: 'machine/Cube.json' }],
          machine_list: [],
          filament_list: [],
          process_list: [],
        }),
      },
      {
        path: 'system/Acme/machine/Cube.json',
        text: JSON.stringify({ name: 'Cube', nozzle_diameter: '0.4' }),
      },
      {
        path: 'system/Acme/machine/base.json',
        text: JSON.stringify({
          name: 'acme_base',
          instantiation: 'false',
          printer_model: 'Cube',
          printer_variant: '0.4',
        }),
      },
      {
        path: 'system/Acme/machine/p.json',
        text: JSON.stringify({ name: 'Cube Fast', instantiation: 'true', inherits: 'acme_base' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
  });

  it('fails the bundle when nothing in the chain sets printer_model', () => {
    const built = buildIndex([
      {
        path: 'system/Acme.json',
        text: JSON.stringify({
          name: 'Acme',
          machine_model_list: [{ name: 'Cube', sub_path: 'machine/Cube.json' }],
          machine_list: [],
          filament_list: [],
          process_list: [],
        }),
      },
      {
        path: 'system/Acme/machine/Cube.json',
        text: JSON.stringify({ name: 'Cube', nozzle_diameter: '0.4' }),
      },
      {
        path: 'system/Acme/machine/p.json',
        text: JSON.stringify({ name: 'Nameless', instantiation: 'true' }),
      },
    ]);
    expect(vendorOf(built, 'Acme')).toBe('printer-model-empty');
  });

  it('fails the bundle when nothing in the chain sets printer_variant', () => {
    const built = buildIndex([
      {
        path: 'system/Acme.json',
        text: JSON.stringify({
          name: 'Acme',
          machine_model_list: [{ name: 'Cube', sub_path: 'machine/Cube.json' }],
          machine_list: [],
          filament_list: [],
          process_list: [],
        }),
      },
      {
        path: 'system/Acme/machine/Cube.json',
        text: JSON.stringify({ name: 'Cube', nozzle_diameter: '0.4' }),
      },
      {
        path: 'system/Acme/machine/p.json',
        text: JSON.stringify({ name: 'Cube ?', instantiation: 'true', printer_model: 'Cube' }),
      },
    ]);
    expect(vendorOf(built, 'Acme')).toBe('printer-variant-empty');
  });

  it('fails the bundle for a variant the model file does not list', () => {
    const built = buildIndex([
      {
        path: 'system/Acme.json',
        text: JSON.stringify({
          name: 'Acme',
          machine_model_list: [{ name: 'Cube', sub_path: 'machine/Cube.json' }],
          machine_list: [],
          filament_list: [],
          process_list: [],
        }),
      },
      {
        path: 'system/Acme/machine/Cube.json',
        text: JSON.stringify({ name: 'Cube', nozzle_diameter: '0.4;0.6' }),
      },
      {
        path: 'system/Acme/machine/p.json',
        text: JSON.stringify({
          name: 'Cube 0.8',
          instantiation: 'true',
          printer_model: 'Cube',
          printer_variant: '0.8',
        }),
      },
    ]);
    expect(vendorOf(built, 'Acme')).toBe('printer-variant-undeclared');
  });

  it('fails the bundle for a filament with no filament_id', () => {
    // Written by hand rather than through `sysFilament`, because the id is the
    // thing under test — a helper that supplies it would be testing itself.
    const built = buildIndex([
      {
        path: 'system/Acme/filament/a.json',
        text: JSON.stringify({ name: 'Acme PLA @System' }),
      },
    ]);
    expect(vendorOf(built, 'Acme')).toBe('filament-id-missing');
  });

  it('does not fail a bundle for a filament that inherits its id', () => {
    // The control the issue asked for. `filament_id` is inherited, so a preset
    // stating none is only a fault when nothing above it states one either.
    const built = buildIndex([
      {
        path: 'system/Acme/filament/base.json',
        text: JSON.stringify({
          name: 'fdm_filament_common',
          instantiation: 'false',
          filament_id: 'ACMEBASE0001',
        }),
      },
      {
        path: 'system/Acme/filament/a.json',
        text: JSON.stringify({ name: 'Acme PLA @System', inherits: 'fdm_filament_common' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
  });

  it('lets a filament inherit its id across the library boundary', () => {
    // The one `inherits` that crosses vendors, and `filament_id` rides it: the
    // loader falls back to `base_bundle->m_filament_id_maps` (:4904-4909), which
    // is the library's map. `chainValue` goes through `inheritsScope`, so this is
    // the same boundary the `inherits` guard uses rather than a second opinion.
    const built = buildIndex([
      {
        path: 'system/OrcaFilamentLibrary/filament/base.json',
        text: JSON.stringify({
          name: 'fdm_filament_common',
          instantiation: 'false',
          filament_id: 'ORCALIB0001',
        }),
      },
      {
        path: 'system/Acme/filament/a.json',
        text: JSON.stringify({ name: 'Acme PLA @System', inherits: 'fdm_filament_common' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
  });

  it('exempts a vendor base and the Template vendor from the filament guard', () => {
    // Two exemptions, both by the same line of C++ shape: a base returns before
    // the guard (:4929-4941), and `Template` is excepted by name in both places.
    const built = buildIndex([
      {
        path: 'system/Acme/filament/base.json',
        text: JSON.stringify({ name: 'fdm_filament_common', instantiation: 'false' }),
      },
      {
        path: 'system/Template/filament/t.json',
        text: JSON.stringify({ name: 'Template PLA' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
  });

  it('exempts a vendor base from the printer guards', () => {
    // `instantiation: "false"` is stored in the config map and returns before the
    // printer checks ever run (:4929-4941), so `fdm_machine_common` having no
    // `printer_model` is correct rather than fatal. Without this the rule would
    // fail every vendor in existence.
    const built = buildIndex([
      {
        path: 'system/Acme.json',
        text: JSON.stringify({
          name: 'Acme',
          machine_model_list: [{ name: 'Cube', sub_path: 'machine/Cube.json' }],
          machine_list: [],
          filament_list: [],
          process_list: [],
        }),
      },
      {
        path: 'system/Acme/machine/Cube.json',
        text: JSON.stringify({ name: 'Cube', nozzle_diameter: '0.4' }),
      },
      {
        path: 'system/Acme/machine/base.json',
        text: JSON.stringify({ name: 'fdm_machine_common', instantiation: 'false' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
  });

  it('does not judge a printer for a vendor whose model list it cannot see', () => {
    // The conservative direction, and deliberate. A vendor with printers and no
    // model list fails in the slicer too — `it_model == end()` for every one — but
    // that is a config we have not fully read rather than one we have read and
    // found wanting. Inventing a whole-vendor failure out of a partial view is the
    // wrong way to be wrong, and every synthetic config in these tests is partial.
    const built = buildIndex([
      {
        path: 'system/Acme/machine/p.json',
        text: JSON.stringify({ name: 'Lonely', instantiation: 'true' }),
      },
    ]);
    expect(built.failedVendors.size).toBe(0);
  });

  it('keeps one finding per vendor, naming the guard and what goes', () => {
    const findings = analyze(index);
    const bundle = findings.filter((f) => f.id.startsWith('bundle-failed:'));
    expect(bundle).toHaveLength(4);
    for (const f of bundle) {
      expect(f.severity).toBe('high');
      // Each says the bundle goes, and each points at the vendor index to edit.
      expect(f.detail).toContain('entire bundle');
      expect(f.paths?.[0]).toMatch(/^system\/[A-Za-z]+\.json$/);
    }
    // The four guards want four different sentences, not one shared one.
    expect(new Set(bundle.map((f) => f.title)).size).toBe(4);
    expect(new Set(bundle.map((f) => f.reference?.key))).toEqual(
      new Set(['inherits', 'machine_model_list', 'sub_path', 'printer_model']),
    );
  });

  it('words the filament_id failure as a bundle failure, and points at the author', () => {
    const built = buildIndex([
      { path: 'system/Acme/filament/a.json', text: JSON.stringify({ name: 'Acme PLA @System' }) },
    ]);
    const f = analyze(built).find((x) => x.id === 'bundle-failed:Acme')!;
    expect(f.severity).toBe('high');
    expect(f.title).toContain('no filament_id');
    expect(f.detail).toContain("Acme's entire bundle");
    expect(f.reference?.key).toBe('filament_id');
    // This one is a rule on whoever authored the bundle, not on the user, and the
    // wording says so rather than implying there is a file of theirs to edit.
    expect(f.detail).toContain('report it there');
    // …and it does not claim the log understates it: unlike the printer guards,
    // this one logs "can not find filament_id", which is accurate as far as it goes.
    expect(f.detail).not.toContain('understates it');
  });

  it('says the log text understates it, where the log says anything', () => {
    // Four of the guards log "it will be ignored" and the comment above them says
    // "These presets are considered not installed" (:4970-4971). The finding used
    // to repeat that. It now contradicts it, on purpose.
    const f = analyze(index).find((x) => x.id === 'bundle-failed:Bluth')!;
    expect(f.detail).toContain('understates it by a whole bundle');
    // …and the `inherits` guard logs no such thing, so it does not claim it does.
    const i = analyze(index).find((x) => x.id === 'bundle-failed:Initech')!;
    expect(i.detail).not.toContain('understates it');
  });
});

describe('a bound printer with no device profile', () => {
  // ORCA-18, decided: extend the conf allowlist with a derived list of
  // `local_machines[*].printer_type` — model ids only — and gate the check on it.
  const findings = analyze(index);
  const of = (id: string) => findings.find((f) => f.id === `device-profile:${id}`);

  it('reads the bound models the server derived, and nothing more', () => {
    expect([...index.installed.boundModels].sort()).toEqual([
      'acme-cube',
      'globex-box',
      'shed-special',
    ]);
    // The fixture binds two devices of one model on two addresses; the payload
    // carries the model once and no address at all.
    expect(index.installed.boundModels.size).toBe(3);
  });

  it('says nothing about a model whose profile is downloaded', () => {
    expect(index.deviceProfiles.has('acme-cube')).toBe(true);
    expect(of('acme-cube')).toBeUndefined();
  });

  it('reports a declared model with no profile as a sync gap', () => {
    const f = of('globex-box')!;
    expect(f.severity).toBe('low');
    expect(f.title).toContain('Globex');
    // The consequence, stated as small as the source says it is.
    expect(f.detail).toContain('json_diff.cpp:92-107');
    expect(f.detail).toContain('host upload, `compatible_printers` and preset resolution');
    expect(f.detail).not.toContain('costs the network');
  });

  it('reports a user-defined model as informational, not as a fault', () => {
    // "Do not report the second as an error" — the issue's own words. There will
    // never be a file for a self-defined machine, so telling someone to fix it
    // would be telling them to fix the unfixable.
    const f = of('shed-special')!;
    expect(f.severity).toBe('low');
    expect(f.detail).toContain('Nothing is wrong');
    expect(f.weight).toBeLessThan(of('globex-box')!.weight);
  });

  it('reports nothing at all when no printer is paired', () => {
    // The gate, and the reason the whole issue needed a decision: ungated, this
    // check fires for most models on any install and is wrong for any printer
    // that does not speak the Bambu protocol.
    const built = buildIndex([
      {
        path: 'OrcaSlicer.conf',
        text: JSON.stringify({ app: { preset_folder: '' }, filaments: ['x'] }),
      },
      {
        path: 'system/Acme.json',
        text: JSON.stringify({
          name: 'Acme',
          machine_model_list: [{ name: 'Cube', sub_path: 'machine/Cube.json' }],
          machine_list: [],
          filament_list: [],
          process_list: [],
        }),
      },
      {
        path: 'system/Acme/machine/Cube.json',
        text: JSON.stringify({ name: 'Cube', model_id: 'acme-cube', nozzle_diameter: '0.4' }),
      },
    ]);
    expect(built.installed.boundModels.size).toBe(0);
    expect(analyze(built).filter((f) => f.id.startsWith('device-profile:'))).toEqual([]);
  });
});

describe('a user preset is named by its filename', () => {
  // ORCA-28. `load_presets` strips `.json` off the directory entry and never reads
  // the `name` key on that path:
  //
  //     std::string name = file_name.erase(file_name.size() - 5);
  //     std::string canonical_name = this->canonical_preset_name(name, resolved_origin);
  //     …
  //     Preset preset(m_type, canonical_name, false);
  //                                        — v2.4.2 Preset.cpp:1613-1622
  //
  // A *vendor* preset is the opposite: `parse_subfile` takes the name out of the
  // file (PresetBundle.cpp:4867). The two rules are per origin, not shared.
  const findings = analyze(index);

  it('indexes a disagreeing file under its filename, not its `name` key', () => {
    const p = byFile('user/default/process/base/Renamed On Disk.json');
    expect(p.raw.name).toBe('Old Studio Name');
    expect(p.name).toBe('Renamed On Disk');
    // And the stated name exists nowhere, because nothing is named by it.
    expect(index.byName.has('Old Studio Name')).toBe(false);
  });

  it('resolves an `inherits` that names the file', () => {
    const child = byFile('user/default/process/Wants Renamed By File.json');
    const r = classifyReference(index, child, 'process', 'Renamed On Disk', 'inherits');
    expect(r.reason).toBe('resolved');
    expect(r.target?.path).toBe('user/default/process/base/Renamed On Disk.json');
    expect(index.notLoaded.has(child.id)).toBe(false);
    // Which is the whole point: reading the `name` key would report this chain as
    // broken — a false "missing parent", the class this repo has five of on record.
    expect(findings.filter((f) => f.presetIds.includes(child.id) && f.kind === 'broken-parent'))
      .toEqual([]);
  });

  it('does not resolve an `inherits` that names the `name` key', () => {
    const child = byFile('user/default/process/Wants Renamed By File.json');
    expect(classifyReference(index, child, 'process', 'Old Studio Name', 'inherits').reason).toBe(
      'absent',
    );
  });

  it('keeps the declared name for a vendor preset', () => {
    // The control, and the reason the rule is per origin. Vendor presets are named
    // from the file and from the index entry, and getting this backwards would
    // rename every system preset to its `sub_path` basename.
    const p = byFile('system/Acme/filament/Acme PETG @Cube.json');
    expect(p.name).toBe('Acme PETG @Cube');
    const base = byFile('system/OrcaFilamentLibrary/filament/fdm_filament_common.json');
    expect(base.name).toBe('fdm_filament_common');
  });

  it('makes a same-directory name clash impossible for user presets', () => {
    // Two files in one directory cannot share a name, because the name *is* the
    // filename. So the only user clash left is across the two passes — `base/` and
    // the folder — and it is knowable rather than a coin toss.
    const byDir = new Map<string, Set<string>>();
    for (const p of index.presets) {
      if (p.origin !== 'user') continue;
      const dir = p.path.slice(0, p.path.lastIndexOf('/'));
      const seen = byDir.get(dir) ?? new Set<string>();
      expect(seen.has(p.name)).toBe(false);
      seen.add(p.name);
      byDir.set(dir, seen);
    }
    // …and the clash that does exist is the `base/` one.
    expect(index.notLoaded.get('user/default/process/Studio Base.json')?.reason).toBe('name-clash');
  });
});

describe('the dropdown’s own grouping', () => {
  // Modelled on `PlaterPresetComboBox::update` (v2.4.2 PresetComboBoxes.cpp), so
  // that the two lists can be read side by side rather than reconciled by eye.
  const machine = byFile('user/default/machine/Workshop Cube.json');
  const c = compatibilityFor(index, machine);
  const groups = groupLikeSlicer(index, c.filaments);
  const titled = (g: string) => groups.find((x) => x.group === g);

  it('emits the slicer’s sections, in the slicer’s order and words', () => {
    // `User presets`, `System presets`, `Unsupported presets` (:1421-1430), then
    // the two this app adds.
    expect(groups.map((g) => g.group)).toEqual([
      'user',
      'system',
      'unsupported',
      'undetermined',
      'not-installed',
    ]);
    expect(groups.slice(0, 3).map((g) => g.title)).toEqual([
      'User presets',
      'System presets',
      'Unsupported presets',
    ]);
  });

  it('marks the two groups the slicer does not have', () => {
    // Neither exists in the dropdown: a condition it cannot evaluate does not
    // arise, and an uninstalled preset is simply absent. Presenting either as one
    // of the slicer's sections would be claiming it hides them.
    expect(groups.filter((g) => g.ours).map((g) => g.group)).toEqual([
      'undetermined',
      'not-installed',
    ]);
  });

  it('sub-groups system filaments by filament_vendor, and only those', () => {
    expect(titled('system')?.subgroups.map((s) => s.title)).toEqual(['Acme', 'Unspecified']);
    // `groupByGroup` is false for exactly the system group (:1324); every other
    // group renders as one list.
    for (const g of groups.filter((x) => x.group !== 'system')) {
      expect(g.subgroups.map((s) => s.title)).toEqual(['']);
    }
  });

  it('never sub-groups processes, whose vendor and type are empty', () => {
    // The by-vendor grouping reads filament-only attributes (:1418-1422), so
    // applying it here would bucket every process under "Unspecified".
    for (const g of groupLikeSlicer(index, c.processes)) {
      expect(g.subgroups.map((s) => s.title)).toEqual(['']);
    }
  });

  it('labels a row with its alias, as the plater combo does', () => {
    // `Preset::label(false)` = alias when there is one (:1098-1100).
    const rows = groups.flatMap((g) => g.subgroups.flatMap((s) => s.items));
    const stated = rows.find((r) => r.name === 'Acme PLA-CF @Cube');
    expect(stated?.label).toBe('Acme PLA-CF');
    // Derived, because that preset states no alias: the name up to the `@`,
    // right-trimmed (PresetBundle.cpp:5086-5099).
    expect(rows.find((r) => r.name === 'Acme PETG @Cube')?.label).toBe('Acme PETG');
    // No `@` at all: the alias is the whole name.
    expect(rows.find((r) => r.name === 'Studio ABS')?.label).toBe('Studio ABS');
  });

  it('does not confuse the alias derivation with the renamed_from one', () => {
    // One character apart and easy to implement once by accident: the alias is
    // right-trimmed (`boost::trim_right`), the `renamed_from` name keeps the
    // space because it is concatenated before the trim. `Acme PETG @Cube` is
    // therefore alias "Acme PETG" and old name "Acme PETG Cube".
    const p = byFile('system/Acme/filament/Acme PETG @Cube.json');
    expect(presetAlias(index, p)).toBe('Acme PETG');
    expect(index.installed.filaments.has('Acme PETG Cube')).toBe(true);
  });
});

describe('the dropdown’s row order', () => {
  const files = (names: { name: string; vendor?: string; type?: string }[]) => [
    { path: 'OrcaSlicer.conf', text: JSON.stringify({ filaments: names.map((n) => n.name), models: [] }) },
    { path: 'user/default/machine/Mine.json', text: JSON.stringify({ name: 'Mine' }) },
    ...names.map((n, i) => (sysFilament(`system/V/filament/f${i}.json`, {
        name: n.name,
        ...(n.vendor === undefined ? {} : { filament_vendor: n.vendor }),
        ...(n.type === undefined ? {} : { filament_type: n.type }),
      }))),
  ];
  const order = (names: { name: string; vendor?: string; type?: string }[], group = 'system') => {
    const built = buildIndex(files(names));
    const m = built.presets.find((p) => p.name === 'Mine')!;
    const g = groupLikeSlicer(built, compatibilityFor(built, m).filaments).find((x) => x.group === group)!;
    return g.subgroups.flatMap((s) => s.items).map((i) => i.name);
  };

  it('puts PLA, PETG, ABS and TPU first, then falls back to the name', () => {
    // `first_types` (:1316), which is why a real `Generic` submenu reads PLA,
    // PETG, ABS, TPU, then ASA, PA, PA-CF… Sorted alphabetically it would open
    // with ABS, and the two lists stop lining up row for row.
    expect(
      order([
        { name: 'G ASA', vendor: 'Generic', type: 'ASA' },
        { name: 'G ABS', vendor: 'Generic', type: 'ABS' },
        { name: 'G PLA', vendor: 'Generic', type: 'PLA' },
        { name: 'G PVA', vendor: 'Generic', type: 'PVA' },
        { name: 'G PETG', vendor: 'Generic', type: 'PETG' },
      ]),
    ).toEqual(['G PLA', 'G PETG', 'G ABS', 'G ASA', 'G PVA']);
  });

  it('orders the vendor submenus with Bambu and Generic first', () => {
    // `first_vendors` (:1315).
    const built = buildIndex(
      files([
        { name: 'A one', vendor: 'Acme', type: 'PLA' },
        { name: 'B one', vendor: 'Generic', type: 'PLA' },
        { name: 'C one', vendor: 'Bambu Lab', type: 'PLA' },
      ]),
    );
    const m = built.presets.find((p) => p.name === 'Mine')!;
    const sys = groupLikeSlicer(built, compatibilityFor(built, m).filaments).find(
      (x) => x.group === 'system',
    )!;
    // And "Bambu Lab" is rewritten to "Bambu" (:1223-1224) — the submenu is
    // labelled with the short name, so matching on the raw value finds nothing.
    expect(sys.subgroups.map((s) => s.title)).toEqual(['Bambu', 'Generic', 'Acme']);
  });

  it('sorts by bytes, not by locale, so two spellings of one name stay apart', () => {
    // The comparator ends in `std::string <`. `localeCompare` orders "jon PLA"
    // before "Jon PLA"; the slicer does the opposite, and a config holding both
    // is exactly the one someone is trying to make sense of.
    expect(order([{ name: 'jon PLA' }, { name: 'Jon PLA' }])).toEqual(['Jon PLA', 'jon PLA']);
    expect(['jon PLA', 'Jon PLA'].sort((a, b) => a.localeCompare(b, 'en'))[0]).toBe('jon PLA');
  });
});

describe('vendor bases are not presets you can pick', () => {
  const findings = analyze(index);
  const bases = index.active.filter((p) => !p.instantiable);

  it('flags exactly the `fdm_*` set in the fixture', () => {
    // Keyed by vendor as well as name, because two vendors ship a
    // `fdm_machine_common` and that is not a mistake: the shared bundle can only
    // supply a *filament* base (PresetBundle.cpp:5147-5151), so each vendor needs
    // its own machine base. A name-only assertion would read as a duplicate.
    expect(bases.map((p) => `${p.vendor}/${p.name}`).sort()).toEqual([
      'Acme/fdm_filament_abs',
      'Acme/fdm_machine_common',
      'Acme/fdm_process_acme_common',
      'Acme/fdm_process_common',
      'Bluth/fdm_machine_common',
      'Globex/fdm_machine_common',
      'Initech/fdm_machine_common',
      'OrcaFilamentLibrary/fdm_filament_common',
    ]);
    // The flag is on the preset, decided once in `buildIndex`, so nothing has to
    // re-derive it — and the `Template` exception exists in one place.
    expect(bases.every((p) => p.raw.instantiation === 'false')).toBe(true);
    expect(index.active.filter((p) => p.origin === 'user' && !p.instantiable)).toEqual([]);
  });

  it('keeps them out of the counts', () => {
    // Pinned against the fixture rather than left as "greater than 5": the whole
    // point is that a number moved, and a loose assertion would not have noticed.
    const s = stats(index);
    // Both subtractions compose, and the arithmetic is pinned so neither can be
    // quietly folded into the other: active = selectable + bases + never-loaded.
    // Initech's base is in `notLoaded`, not in `bases` — its bundle threw, so the
    // slicer holds it as neither.
    const loaded = index.active.filter((p) => !index.notLoaded.has(p.id));
    expect(s.bases).toBe(loaded.filter((p) => !p.instantiable).length);
    // Seven `instantiation: "false"` files on disk, six counted: Initech's is in
    // `notLoaded`, so it is neither selectable nor a base the slicer holds.
    expect(s.bases).toBe(6);
    expect(bases).toHaveLength(8);
    expect(s.system).toBe(loaded.filter((p) => p.origin === 'system' && p.instantiable).length);
    expect(s.system + s.bases + s.user + s.notLoaded).toBe(index.active.length);
    // `byKind` drives the sidebar's origin chips, so it has to agree.
    const kindTotal = Object.values(s.byKind).reduce((n, k) => n + k.system + k.user, 0);
    expect(kindTotal).toBe(s.system + s.user);
  });

  it('still measures the deepest chain through them', () => {
    // Deliberately *not* filtered here: a base is a real root and the chains it
    // roots are what the number is about. Excluding it understates every depth.
    const s = stats(index);
    expect(s.deepestChain).toEqual({ name: '0.28mm Draft @Acme - Copy', depth: 5 });
    const chain = resolve(index, byFile('process/0.28mm Draft @Acme - Copy.json')).chain;
    expect(chain.some((p) => !p.instantiable)).toBe(true);
  });

  it('keeps drawing them in the graph, labelled', () => {
    const graph = buildGraph(index, { includeSystemOnly: true });
    const drawn = graph.nodes.filter((n) => !n.instantiable);
    expect(drawn.length).toBe(bases.length);
    // The alternative — hiding them — would break every chain below them.
    for (const b of bases) {
      const node = graph.nodes.find((n) => n.id === b.id);
      expect(node).toBeDefined();
      expect(node?.instantiable).toBe(false);
    }
  });

  it('does not report a base as a fault', () => {
    // Pinned because it is currently true by accident: `analyze` only raises the
    // content findings for `origin === 'user'`, and a base is always a vendor
    // preset. A later change that widened that would start telling people to fix
    // `fdm_filament_common`.
    const baseIds = new Set(bases.map((p) => p.id));
    expect(findings.filter((f) => f.presetIds.some((id) => baseIds.has(id)))).toEqual([]);
  });

  it('honours the Template vendor exception', () => {
    // The guard is `instantiation == "false" && "Template" != vendor_name`
    // (PresetBundle.cpp:4929), so Template's non-instantiable presets *are*
    // constructed and do enter the collection. Easy to lose in a refactor, which is
    // why this is its own test.
    const built = buildIndex([
      sysFilament('system/Template/filament/t.json', { name: 'Template PLA', instantiation: 'false' }),
      sysFilament('system/Acme/filament/a.json', { name: 'Acme base', instantiation: 'false' }),
    ]);
    const template = built.active.find((p) => p.name === 'Template PLA')!;
    const acme = built.active.find((p) => p.name === 'Acme base')!;
    expect(template.instantiable).toBe(true);
    expect(acme.instantiable).toBe(false);
    expect(stats(built).bases).toBe(1);
    // And it therefore *can* clash, which is the observable consequence.
    expect(clashScope(template)).toBeDefined();
    expect(clashScope(acme)).toBeUndefined();
  });

  it('uses one rule for the printer view and the counts', () => {
    // `compatibilityFor` had its own copy of the instantiation check, added when the
    // printer view was the only place the bug showed. Two copies of a rule with an
    // exception in it is the drift this collapses.
    const machine = byFile('machine/Workshop Cube.json');
    const compat = compatibilityFor(index, machine);
    const offered = new Set([...compat.filaments, ...compat.processes].map((c) => c.preset.id));
    for (const b of bases) expect(offered.has(b.id)).toBe(false);
    expect(offered.size).toBeGreaterThan(0);
  });
});
