/**
 * Side-by-side comparison.
 *
 * Defaults to the effective diff, because "will these print differently" is
 * almost always the question. The raw toggle answers the other one — why one
 * file is 359 keys and the other 9.
 *
 * Cosmetic rows (same value, different serialisation) are counted separately
 * and hidden by default: they are a property of the files, not of the print.
 */

import { useMemo, useState } from 'react';
import { diffEffective, diffRaw } from '../domain/diff';
import type { ConfigIndex } from '../domain/index-config';
import type { Preset } from '../domain/types';
import { Value } from './SettingsTable';

function PresetPicker({
  label,
  presets,
  value,
  onChange,
}: {
  label: string;
  presets: Preset[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div>
      <div className="label-section" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a preset…</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.kind} · {p.origin}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CompareView({
  index,
  aId,
  bId,
  onPick,
}: {
  index: ConfigIndex;
  aId: string;
  bId: string;
  onPick: (a: string, b: string) => void;
}) {
  const [mode, setMode] = useState<'effective' | 'raw'>('effective');
  const [showCosmetic, setShowCosmetic] = useState(false);

  const sorted = useMemo(
    () =>
      [...index.active].sort(
        (x, y) => x.kind.localeCompare(y.kind, 'en') || x.name.localeCompare(y.name, 'en'),
      ),
    [index],
  );

  const a = index.byId.get(aId);
  const b = index.byId.get(bId);

  const diff = useMemo(() => {
    if (!a || !b) return null;
    return mode === 'raw' ? diffRaw(a, b) : diffEffective(index, a, b);
  }, [index, a, b, mode]);

  const visibleRows = useMemo(() => {
    if (!diff) return [];
    return showCosmetic ? diff.rows : diff.rows.filter((r) => r.status !== 'cosmetic');
  }, [diff, showCosmetic]);

  return (
    <div>
      <div className="compare-pickers">
        <PresetPicker label="A" presets={sorted} value={aId} onChange={(id) => onPick(id, bId)} />
        <PresetPicker label="B" presets={sorted} value={bId} onChange={(id) => onPick(aId, id)} />
      </div>

      {!a || !b ? (
        <p className="muted">Pick two presets to compare.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <div className="chips">
              <button
                type="button"
                className="chip"
                aria-pressed={mode === 'effective'}
                onClick={() => setMode('effective')}
              >
                Effective values
              </button>
              <button
                type="button"
                className="chip"
                aria-pressed={mode === 'raw'}
                onClick={() => setMode('raw')}
              >
                As written in the file
              </button>
            </div>
            {diff && diff.cosmetic > 0 && (
              <button
                type="button"
                className="chip"
                aria-pressed={showCosmetic}
                onClick={() => setShowCosmetic((v) => !v)}
              >
                {showCosmetic ? 'Hide' : 'Show'} {diff.cosmetic} formatting-only
              </button>
            )}
          </div>

          {diff && (
            <>
              <div className="diff-summary">
                <div className="stat">
                  <span className="n">{diff.rows.filter((r) => r.status === 'changed').length}</span>
                  <span className="l">Different</span>
                </div>
                <div className="stat">
                  <span className="n">{diff.rows.filter((r) => r.status === 'only-a').length}</span>
                  <span className="l">Only in A</span>
                </div>
                <div className="stat">
                  <span className="n">{diff.rows.filter((r) => r.status === 'only-b').length}</span>
                  <span className="l">Only in B</span>
                </div>
                <div className="stat">
                  <span className="n">{diff.identical}</span>
                  <span className="l">Identical</span>
                </div>
                <div className="stat">
                  <span className="n">{diff.cosmetic}</span>
                  <span className="l">Formatting only</span>
                </div>
              </div>

              {mode === 'effective' && diff.rows.filter((r) => r.status !== 'cosmetic').length === 0 && (
                <div className="notice">
                  <strong>These two presets print identically.</strong> Every one of the{' '}
                  {diff.compared} resolved settings matches
                  {diff.cosmetic > 0 && `, though ${diff.cosmetic} are written differently on disk`}.
                </div>
              )}

              <table className="settings">
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>{a.name}</th>
                    <th>{b.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => (
                    <tr key={r.key}>
                      <td className="k">
                        <span
                          className={`dot ${r.status === 'cosmetic' ? 'inherited' : 'warn'}`}
                          aria-hidden="true"
                        />
                        {r.key}
                        {r.status === 'cosmetic' && <span className="faint"> (formatting)</span>}
                      </td>
                      <td className="v">
                        {r.status === 'only-b' ? (
                          <span className="faint">not set</span>
                        ) : (
                          <>
                            <Value settingKey={r.key} value={r.a} />
                            {mode === 'effective' && r.aSource && (
                              <div className="faint">from {r.aSource}</div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="v">
                        {r.status === 'only-a' ? (
                          <span className="faint">not set</span>
                        ) : (
                          <>
                            <Value settingKey={r.key} value={r.b} />
                            {mode === 'effective' && r.bSource && (
                              <div className="faint">from {r.bSource}</div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
