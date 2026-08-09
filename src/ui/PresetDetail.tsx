/**
 * One preset, explained.
 *
 * The order is deliberate. The chain comes first, because "what is this built
 * on" is the question the slicer never answers. Then the preset's own edits,
 * split into the ones that change something and the ones that do not — a
 * distinction that turns a 359-key file into "five real changes". The full
 * resolved list comes last, since it is reference material rather than the
 * thing you came to find out.
 */

import { useMemo, useState } from 'react';
import type { ConfigIndex } from '../domain/index-config';
import { ownOverrides, resolve } from '../domain/resolve';
import type { Preset } from '../domain/types';
import { SettingsTable, type SettingRow } from './SettingsTable';

export function PresetDetail({
  index,
  preset,
  onSelect,
  onCompare,
}: {
  index: ConfigIndex;
  preset: Preset;
  onSelect: (id: string) => void;
  onCompare: (a: string, b: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);

  const resolution = useMemo(() => resolve(index, preset), [index, preset]);
  const overrides = useMemo(() => ownOverrides(index, preset), [index, preset]);

  const storedCount = Object.keys(preset.raw).length;
  const parent = resolution.chain[1];

  const allRows: SettingRow[] = useMemo(() => {
    const rows = [...resolution.settings.values()]
      .sort((a, b) => a.key.localeCompare(b.key, 'en'))
      .map((s) => ({
        key: s.key,
        value: s.value,
        source: s.sourceName,
        own: s.depth === 0,
      }));
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => r.key.toLowerCase().includes(q)) : rows;
  }, [resolution, filter]);

  return (
    <div>
      <div className="detail-head">
        <h2>{preset.name}</h2>
        <div className="path">{preset.path}</div>
        <div className="badges">
          <span className="badge">{preset.kind}</span>
          <span className="badge">{preset.origin}</span>
          {preset.vendor && <span className="badge">{preset.vendor}</span>}
          {preset.profile && <span className="badge">profile: {preset.profile}</span>}
          <span className="badge">
            {storedCount} keys stored → {resolution.settings.size} in effect
          </span>
          {!preset.inherits && preset.origin === 'user' && storedCount > 40 && (
            <span className="badge danger">detached copy</span>
          )}
          {preset.isCustomRoot && (
            <span className="badge own" title="Saved detached, in <type>/base/. Loaded before the rest of the folder.">
              custom root
            </span>
          )}
          {preset.scope !== 'active' && (
            <span className="badge danger">
              {preset.scope === 'snapshot' ? 'sync snapshot' : 'profile not loaded'}
            </span>
          )}
          {resolution.missingParent && <span className="badge danger">parent missing</span>}
        </div>
      </div>

      <section className="block">
        <h3>
          Inherits from
          <span className="count">{resolution.chain.length - 1} ancestor(s)</span>
          <span className="hint">nearest first — later presets win</span>
        </h3>
        <div className="chain">
          {resolution.chain.map((node, i) => (
            <span key={node.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 && <span className="chain-arrow">◂</span>}
              <button
                type="button"
                className={`chain-node ${i === 0 ? 'self' : ''}`}
                onClick={() => onSelect(node.id)}
                title={node.path}
              >
                <span>{node.name}</span>
                <span className="kcount">{Object.keys(node.raw).length}</span>
              </button>
            </span>
          ))}
          {resolution.missingParent && (
            <>
              <span className="chain-arrow">◂</span>
              <span className="chain-node missing" title="Named by `inherits` but not installed">
                {resolution.missingParent} (missing)
              </span>
            </>
          )}
        </div>
        {!preset.inherits && (
          <p className="muted" style={{ marginBottom: 0 }}>
            This preset has no parent — every value below is stored in the file itself.
            {preset.isCustomRoot &&
              ' It lives in base/, which is where OrcaSlicer puts a preset saved with the link to its parent deliberately cleared.'}
          </p>
        )}
        {preset.scope === 'inactive-profile' && (
          <div className="notice" style={{ marginTop: 10, borderColor: 'var(--danger)' }}>
            <strong>OrcaSlicer never loads this preset.</strong> It only loads one user folder, and
            this one is not it — so editing this file changes nothing you see in the slicer.
          </div>
        )}
      </section>

      <section className="block">
        <h3>
          What this preset changes
          <span className="count">{overrides.effective.length}</span>
          {parent && <span className="hint">compared with {parent.name}</span>}
        </h3>
        <SettingsTable
          rows={overrides.effective.map((s) => ({
            key: s.key,
            value: s.value,
            own: true,
            was: s.shadowed[0]?.value,
          }))}
          showSource={false}
          emptyMessage={
            preset.inherits
              ? 'Nothing. Every value here matches what it inherits — this preset is a copy in all but name.'
              : 'No parent to compare against.'
          }
        />
        {overrides.effective.length > 0 && parent && (
          <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
            Struck-through values are what {parent.name} would have given.
          </p>
        )}
      </section>

      {overrides.redundant.length > 0 && (
        <section className="block">
          <h3>
            Overrides that change nothing
            <span className="count">{overrides.redundant.length}</span>
            <span className="hint">identical to the inherited value</span>
          </h3>
          <p className="muted" style={{ marginTop: 0 }}>
            These are stored in the file but repeat what the parent already says. They are why the
            preset looks bigger than it is.
          </p>
          <SettingsTable
            rows={overrides.redundant.map((r) => ({
              key: r.key,
              value: r.value,
              source: r.inheritedFrom,
            }))}
          />
        </section>
      )}

      {overrides.novel.length > 0 && (
        <section className="block">
          <h3>
            Set here, defined nowhere above
            <span className="count">{overrides.novel.length}</span>
            <span className="hint">no ancestor mentions these keys</span>
          </h3>
          <p className="muted" style={{ marginTop: 0 }}>
            The slicer would otherwise fall back to its built-in default for each of these.
          </p>
          <SettingsTable
            rows={overrides.novel.map((s) => ({ key: s.key, value: s.value, own: true }))}
            showSource={false}
          />
        </section>
      )}

      <section className="block">
        <h3>
          Every effective setting
          <span className="count">{resolution.settings.size}</span>
          <span className="hint">what the slicer actually uses</span>
        </h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            type="search"
            placeholder="Filter settings…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {parent && (
            <button type="button" onClick={() => onCompare(preset.id, parent.id)} style={{ flex: '0 0 auto' }}>
              Compare with parent
            </button>
          )}
        </div>
        {showAll || filter ? (
          <SettingsTable rows={allRows} />
        ) : (
          <button type="button" onClick={() => setShowAll(true)}>
            Show all {resolution.settings.size} settings
          </button>
        )}
      </section>
    </div>
  );
}
