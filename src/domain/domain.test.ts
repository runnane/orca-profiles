/**
 * Tests run against a sanitised copy of a real OrcaSlicer config
 * (`fixtures/config`), not synthetic data — the behaviour worth pinning down
 * is exactly the messiness a real config accumulates.
 */

import { describe, expect, it } from 'vitest';
import { analyze, stats } from './analyze';
import { diffEffective, diffRaw } from './diff';
import { buildIndex, loadOrder, lookupParent, type ConfigIndex } from './index-config';
import { loadConfigDir } from './load-fixtures';
import { parseQuotedList, scalarAsList, valuesEqual } from './normalize';
import { isSensitiveKey, maskValue } from './redact';
import { inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';

const index: ConfigIndex = buildIndex(loadConfigDir(new URL('../../fixtures/config', import.meta.url).pathname));

function userPreset(name: string, kind: string) {
  const p = index.active.find((x) => x.origin === 'user' && x.name === name && x.kind === kind);
  if (!p) throw new Error(`fixture missing: ${kind} ${name}`);
  return p;
}

/** Presets are identified by declared name, which need not match the filename. */
function byFile(file: string) {
  const p = index.presets.find((x) => x.path.endsWith(file));
  if (!p) throw new Error(`fixture missing file: ${file}`);
  return p;
}

describe('index', () => {
  it('parses the fixture config without errors', () => {
    expect(index.parseErrors).toEqual([]);
    expect(index.presets.length).toBeGreaterThan(100);
  });

  it('finds both system and user presets across vendors', () => {
    const s = stats(index);
    expect(s.system).toBeGreaterThan(50);
    expect(s.user).toBeGreaterThan(20);
    expect(s.vendors).toBeGreaterThanOrEqual(3);
  });

  it('separates active presets from sync snapshots', () => {
    expect(index.active.length).toBeLessThan(index.presets.length);
    expect(index.active.every((p) => !p.path.includes('_local/'))).toBe(true);
  });

  it('gives every preset a unique id', () => {
    // Names collide by design: the local and cloud profiles each hold a "jon
    // ABS", and three files claim "ABS fast". Keying on name collapsed those
    // into one row that could not be opened separately.
    const ids = index.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(index.byId.size).toBe(index.presets.length);
  });

  it('loads only the profile named by preset_folder', () => {
    // This config has `preset_folder: ""`, so `default` is live.
    expect(index.activeProfile).toBe('default');
    expect(index.inactiveProfiles.length).toBeGreaterThan(0);
    expect(index.active.every((p) => p.origin === 'system' || p.profile === 'default')).toBe(true);
  });

  it('keeps the same name in two profiles apart', () => {
    const local = index.presets.find((p) => p.path === 'user/default/filament/jon ABS.json');
    const cloud = index.presets.find(
      (p) => p.profile !== 'default' && p.name === 'jon ABS' && p.origin === 'user',
    );
    expect(local).toBeDefined();
    expect(cloud).toBeDefined();
    expect(local!.id).not.toBe(cloud!.id);
    expect(local!.scope).toBe('active');
    expect(cloud!.scope).not.toBe('active');
  });

  it('marks base/ presets as detached custom roots', () => {
    // `base/` is where the slicer saves a preset detached from its parent
    // (Preset.cpp:3869); they are loaded first so others can inherit them.
    const roots = index.presets.filter((p) => p.isCustomRoot);
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      expect(r.path).toContain('/base/');
      expect(r.inherits).toBeUndefined();
    }
  });

  it('never resolves a parent to a sync snapshot', () => {
    for (const list of index.byName.values()) {
      expect(list.every((p) => p.scope !== 'snapshot')).toBe(true);
    }
  });

  it('never resolves a parent across profiles', () => {
    // A PresetCollection holds the system bundles plus one user folder, so a
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
    const group = index.presets.filter((p) => p.name === 'ABS fast');
    expect(group.length).toBeGreaterThan(1);
    const ordered = loadOrder(group);
    // A custom root under base/ is loaded before a same-named ordinary preset.
    const rootAt = ordered.findIndex((p) => p.isCustomRoot);
    const plainAt = ordered.findIndex((p) => !p.isCustomRoot && p.origin === 'user');
    if (rootAt !== -1 && plainAt !== -1) expect(rootAt).toBeLessThan(plainAt);
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
    // The failing direction: ABS fast lists three printers, ABS fast2 one.
    // If this ever passes as equal, the app is hiding a real difference.
    expect(valuesEqual(['a', 'b', 'c'], '"a"')).toBe(false);
    expect(valuesEqual(['70', '70'], '70,80')).toBe(false);
  });

  it('does not coerce unrelated scalars into vectors', () => {
    expect(valuesEqual('tree(auto)', 'normal(auto)')).toBe(false);
    expect(valuesEqual('15000', '20000')).toBe(false);
  });
});

describe('inheritance', () => {
  it('walks a real system chain to its base', () => {
    const generic = index.presets.find((p) => p.name === 'Generic ABS @System');
    expect(generic).toBeDefined();
    const { chain } = inheritanceChain(index, generic!);
    expect(chain.map((c) => c.name)).toEqual(['Generic ABS @System', 'fdm_filament_abs', 'fdm_filament_common']);
  });

  it('resolves a sparse user preset to far more settings than it stores', () => {
    const jonAbs = userPreset('jon ABS', 'filament');
    const stored = Object.keys(jonAbs.raw).length;
    const r = resolve(index, jonAbs);
    expect(stored).toBeLessThan(12);
    // The whole point: the preset stores a handful of keys, the slicer uses many.
    expect(r.settings.size).toBeGreaterThan(40);
    expect(r.settings.size).toBeGreaterThan(stored * 4);
  });

  it('attributes each resolved value to the preset that supplied it', () => {
    const jonAbs = userPreset('jon ABS', 'filament');
    const r = resolve(index, jonAbs);
    const own = [...r.settings.values()].filter((s) => s.sourceName === 'jon ABS');
    const inherited = [...r.settings.values()].filter((s) => s.sourceName !== 'jon ABS');
    expect(own.length).toBeGreaterThan(0);
    expect(inherited.length).toBeGreaterThan(own.length);
  });

  it('accounts for every stored setting exactly once', () => {
    const jonAbs = userPreset('jon ABS', 'filament');
    const o = ownOverrides(index, jonAbs);
    const total = o.effective.length + o.redundant.length + o.novel.length;
    expect(total).toBe(Object.keys(jonAbs.raw).filter(isSettingKey).length);
  });

  it('shows a Copy is almost entirely redundant', () => {
    // The headline case: 359 keys stored, but only a handful differ from the
    // parent it still inherits from.
    const copy = byFile('0.28mm Extra Draft @Elegoo CC2 0.4 nozzle - Copy.json');
    const o = ownOverrides(index, copy);
    expect(Object.keys(copy.raw).length).toBeGreaterThan(300);
    expect(o.effective.length).toBeLessThan(10);
    expect(o.redundant.length).toBeGreaterThan(100);
  });

  it('survives a preset whose parent is missing', () => {
    const orphan = {
      id: 'user:filament:orphan',
      name: 'orphan',
      kind: 'filament' as const,
      origin: 'user' as const,
      scope: 'active' as const,
      isCustomRoot: false,
      profile: 'default',
      path: 'user/default/filament/orphan.json',
      inherits: 'No Such Preset',
      raw: { name: 'orphan', inherits: 'No Such Preset', nozzle_temperature: '250' },
    };
    const r = resolve(index, orphan);
    expect(r.missingParent).toBe('No Such Preset');
    expect(r.chain).toHaveLength(1);
    expect(r.settings.get('nozzle_temperature')?.value).toBe('250');
  });
});

describe('diff', () => {
  it('separates real differences from serialisation noise on the ABS fast pair', () => {
    // Both files declare the name "ABS fast"; only the filenames differ.
    const a = byFile('user/default/process/ABS fast.json');
    const b = byFile('user/default/process/ABS fast2.json');
    const d = diffRaw(a, b);
    const real = d.rows.filter((r) => r.status === 'changed');

    // Both are detached full copies, so raw and effective agree here.
    expect(d.compared).toBeGreaterThan(300);
    expect(d.cosmetic).toBeGreaterThan(0);
    // A handful of real differences hiding behind hundreds of identical keys.
    expect(real.length).toBeLessThan(12);
    const keys = real.map((r) => r.key);
    expect(keys).toContain('default_acceleration');
    expect(keys).toContain('enable_support');
    expect(keys).toContain('support_type');
  });

  it('reports a preset compared with itself as entirely identical', () => {
    const a = userPreset('ABS fast', 'process');
    const d = diffEffective(index, a, a);
    expect(d.rows).toEqual([]);
    expect(d.identical).toBe(d.compared);
  });
});

describe('analyze', () => {
  const findings = analyze(index);

  it('flags detached full copies', () => {
    const detached = findings.filter((f) => f.kind === 'detached');
    expect(detached.length).toBeGreaterThan(0);
    expect(detached.some((f) => f.title.includes('ABS fast'))).toBe(true);
  });

  it('flags the two files in one profile that both claim "ABS fast"', () => {
    const dup = findings.filter((f) => f.kind === 'duplicate-name');
    expect(dup.some((f) => f.title.includes('ABS fast'))).toBe(true);
  });

  it('only analyses the profile the slicer actually loads', () => {
    // `preset_folder` is empty in this config, so `default` is live and the
    // cloud profile is inert. A finding about an inert preset is noise.
    for (const f of findings) {
      for (const id of f.presetIds) {
        const p = index.byId.get(id);
        if (p && p.origin === 'user') expect(p.scope).toBe('active');
      }
    }
  });

  it('does not report a cross-profile copy as a duplicate name', () => {
    // `jon ABS` exists in both the local and the cloud profile. That is how
    // sync works, not a fault.
    const dup = findings.filter((f) => f.kind === 'duplicate-name');
    expect(dup.some((f) => f.title.includes('jon ABS'))).toBe(false);
  });

  it('says which duplicate wins and which are never loaded', () => {
    // OrcaSlicer loads the first file under a name and skips the rest outright
    // (Preset.cpp:1619), so this is not a tie — it is dead files.
    const dup = findings.filter((f) => f.kind === 'duplicate-name');
    const absFast = dup.find((f) => f.title.includes('ABS fast'));
    expect(absFast).toBeDefined();
    expect(absFast!.severity).toBe('high');
    expect(absFast!.detail).toContain('Preset already present, not loading');
    // The winner is named first in presetIds.
    expect(absFast!.presetIds.length).toBeGreaterThan(1);
  });

  it('finds near-duplicate user presets', () => {
    const near = findings.filter((f) => f.kind === 'near-duplicate');
    expect(near.length).toBeGreaterThan(0);
  });

  it('ignores cloud sync snapshots', () => {
    // 21 `_local/` folders each mirror the synced presets. If they leaked into
    // the analysis every one of them would read as a duplicate.
    expect(findings.some((f) => f.detail.includes('_local/'))).toBe(false);
    const s = stats(index);
    expect(s.snapshots).toBeGreaterThan(0);
  });

  it('produces no finding without at least one preset or a parse error', () => {
    for (const f of findings) {
      if (f.kind !== 'parse-error') expect(f.presetIds.length).toBeGreaterThan(0);
    }
  });

  it('sorts high severity first', () => {
    const rank = { high: 0, medium: 1, low: 2 };
    const seq = findings.map((f) => rank[f.severity]);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
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

describe('active profile is read from OrcaSlicer.conf', () => {
  const preset = (path: string, name: string) => ({
    path,
    text: JSON.stringify({ name, inherits: '', layer_height: '0.2' }),
  });

  it('honours a non-default preset_folder', () => {
    // The failing direction: with `preset_folder` set to the cloud folder, the
    // cloud presets are live and `default` is the inert one — the opposite of
    // the fixture config. If this ever returns `default`, the conf is not
    // being read and every scope in the app is decided by a fallback.
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
        { path: 'OrcaSlicer.conf', text: '{not json' },
        preset('user/default/process/a.json', 'a'),
      ]).activeProfile,
    ).toBe('default');
  });
});
