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
import { diffEffective, diffRaw } from './diff';
import { buildGraph } from './graph';
import { buildIndex, loadOrder, lookupParent, type ConfigIndex } from './index-config';
import { loadConfigDir } from './load-fixtures';
import { parseQuotedList, scalarAsList, valuesEqual } from './normalize';
import { isSensitiveKey, maskValue, redactConfJson, redactPresetJson, REDACTED } from './redact';
import { inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';

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
    const f = findings.find((x) => x.kind === 'broken-parent');
    expect(f?.severity).toBe('high');
    expect(f?.title).toContain('Orphaned Profile');
  });

  it('flags a preset limited to printers that are gone', () => {
    const f = findings.find((x) => x.kind === 'orphaned-printer');
    expect(f?.title).toContain('Legacy PETG');
  });

  it('says two files claim one name, without predicting which wins', () => {
    // Both are ordinary presets in one directory, so the slicer's choice comes
    // down to directory iteration order — claiming a winner would be invention.
    const f = findings.find((x) => x.kind === 'duplicate-name');
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

  it('gives every finding at least one preset', () => {
    for (const f of findings) {
      if (f.kind !== 'parse-error') expect(f.presetIds.length).toBeGreaterThan(0);
    }
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
