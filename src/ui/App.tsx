/**
 * The shell: load a config, then browse / diagnose / compare it.
 *
 * All state is in memory and the config is read-only. Nothing is written back
 * to disk and nothing is sent anywhere — see `src/source/fs-access.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { stats } from '../domain/analyze';
import { buildIndex, type ConfigFile, type ConfigIndex } from '../domain/index-config';
import type { Preset, PresetKind, PresetOrigin } from '../domain/types';
import { isFileSystemAccessSupported, pickAndReadConfig } from '../source/fs-access';
import { CompareView } from './CompareView';
import { HealthReport } from './HealthReport';
import { PresetDetail } from './PresetDetail';

type Tab = 'presets' | 'health' | 'compare';

const KINDS: PresetKind[] = ['filament', 'process', 'machine'];
const ORIGINS: PresetOrigin[] = ['user', 'system'];

export function App() {
  const [index, setIndex] = useState<ConfigIndex | null>(null);
  const [rootName, setRootName] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('presets');
  const [selectedId, setSelectedId] = useState<string>('');
  const [compareA, setCompareA] = useState('');
  const [compareB, setCompareB] = useState('');

  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<Set<PresetKind>>(new Set(KINDS));
  const [origins, setOrigins] = useState<Set<PresetOrigin>>(new Set<PresetOrigin>(['user']));
  // Presets the slicer never loads, kept behind a toggle so they can be found
  // when you go looking but never pad the counts.
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback((files: ConfigFile[], name: string) => {
    const built = buildIndex(files);
    setIndex(built);
    setRootName(name);
    setSelectedId('');
    setTab('presets');
  }, []);

  const openPicker = useCallback(async () => {
    setError(null);
    setLoading('Reading config…');
    try {
      const { rootName: name, files } = await pickAndReadConfig((p) =>
        setLoading(`Reading… ${p.files} files`),
      );
      if (files.length === 0) {
        setError('No preset files found there. Pick the OrcaSlicer config folder itself.');
      } else {
        load(files, name);
      }
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      setLoading(null);
    }
  }, [load]);

  const loadSample = useCallback(async () => {
    setError(null);
    setLoading('Loading sample…');
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}sample-config.json`);
      if (!res.ok) throw new Error(`Sample config not available (${res.status})`);
      const data = (await res.json()) as { rootName: string; files: ConfigFile[] };
      load(data.files, data.rootName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }, [load]);

  const filtered = useMemo(() => {
    if (!index) return [];
    const q = query.trim().toLowerCase();
    const pool = showInactive
      ? index.presets.filter((p) => p.scope !== 'snapshot')
      : index.active;
    return pool
      .filter((p) => kinds.has(p.kind) && origins.has(p.origin))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.kind.localeCompare(b.kind, 'en') || a.name.localeCompare(b.name, 'en'));
  }, [index, query, kinds, origins, showInactive]);

  const selected = index && selectedId ? index.byId.get(selectedId) : undefined;

  const showCompare = useCallback((a: string, b: string) => {
    setCompareA(a);
    setCompareB(b);
    setTab('compare');
  }, []);

  const showPreset = useCallback((id: string) => {
    setSelectedId(id);
    setTab('presets');
  }, []);

  // Keep the selection valid when filters change it out of view.
  useEffect(() => {
    if (selectedId && filtered.length > 0 && !filtered.some((p) => p.id === selectedId)) {
      // Selection still exists in the index; leave it shown rather than
      // clearing it, so filtering does not silently lose the user's place.
    }
  }, [filtered, selectedId]);

  if (!index) {
    return (
      <div className="app">
        <Topbar />
        <div className="empty">
          <div className="inner">
            <h2 style={{ margin: 0, fontSize: 18 }}>Open an OrcaSlicer config</h2>
            <p className="muted" style={{ margin: 0 }}>
              Point at your OrcaSlicer configuration folder. Everything is read in this browser —
              nothing is uploaded, and printer credentials are never displayed.
            </p>
            {isFileSystemAccessSupported() ? (
              <button type="button" className="primary" onClick={openPicker} disabled={!!loading}>
                {loading ?? 'Choose folder…'}
              </button>
            ) : (
              <div className="notice">
                <strong>This browser cannot open a folder.</strong> The File System Access API is
                Chromium-only. Use Chrome or Edge, or explore the bundled sample below.
              </div>
            )}
            <button type="button" onClick={loadSample} disabled={!!loading}>
              Load sample config
            </button>
            {error && (
              <div className="notice" style={{ borderColor: 'var(--danger)' }}>
                {error}
              </div>
            )}
            <p className="faint mono" style={{ margin: 0, fontSize: 11 }}>
              ~/.config/OrcaSlicer · or the AppImage's <code>.config</code> folder
            </p>
          </div>
        </div>
      </div>
    );
  }

  const s = stats(index);

  return (
    <div className="app">
      <Topbar>
        <span className="mono faint">{rootName}</span>
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'presets'}
            onClick={() => setTab('presets')}
          >
            Presets<span className="count">{s.user + s.system}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'health'}
            onClick={() => setTab('health')}
          >
            Health
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'compare'}
            onClick={() => setTab('compare')}
          >
            Compare
          </button>
        </div>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={openPicker}>
          Open another…
        </button>
      </Topbar>

      <div className="body">
        {tab === 'presets' && (
          <aside className="sidebar">
            <div className="filters">
              <input
                type="search"
                placeholder="Search presets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="chips">
                {ORIGINS.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className="chip"
                    aria-pressed={origins.has(o)}
                    onClick={() => setOrigins(toggle(origins, o))}
                  >
                    {o} {o === 'user' ? s.user : s.system}
                  </button>
                ))}
              </div>
              <div className="chips">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="chip"
                    aria-pressed={kinds.has(k)}
                    onClick={() => setKinds(toggle(kinds, k))}
                  >
                    {k}
                  </button>
                ))}
              </div>
              {index.inactiveProfiles.length > 0 && (
                <div className="chips">
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={showInactive}
                    onClick={() => setShowInactive((v) => !v)}
                    title={`OrcaSlicer loads only user/${index.activeProfile}`}
                  >
                    include profiles the slicer ignores
                  </button>
                </div>
              )}
            </div>
            <div className="list">
              <div className="list-group-label label-section">
                {filtered.length} preset{filtered.length === 1 ? '' : 's'}
                {s.snapshots > 0 && ` · ${s.snapshots} sync snapshots hidden`}
              </div>
              {filtered.map((p) => (
                <PresetRow
                  key={p.id}
                  preset={p}
                  selected={p.id === selectedId}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))}
            </div>
          </aside>
        )}

        <main className="main">
          {tab === 'presets' &&
            (selected ? (
              <PresetDetail
                index={index}
                preset={selected}
                onSelect={showPreset}
                onCompare={showCompare}
              />
            ) : (
              <Overview index={index} onOpenHealth={() => setTab('health')} />
            ))}

          {tab === 'health' && (
            <HealthReport index={index} onSelect={showPreset} onCompare={showCompare} />
          )}

          {tab === 'compare' && (
            <CompareView
              index={index}
              aId={compareA}
              bId={compareB}
              onPick={(a, b) => {
                setCompareA(a);
                setCompareB(b);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function Topbar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="topbar">
      <h1>Orca Profiles</h1>
      {children}
    </header>
  );
}

function PresetRow({
  preset,
  selected,
  onSelect,
}: {
  preset: Preset;
  selected: boolean;
  onSelect: () => void;
}) {
  const stored = Object.keys(preset.raw).length;
  const detached = preset.origin === 'user' && !preset.inherits && stored > 40;
  // The same name legitimately exists in more than one place, so the row has to
  // carry where it lives or two rows are indistinguishable.
  const where = preset.origin === 'system' ? preset.vendor : preset.profile;
  const inactive = preset.scope !== 'active';
  return (
    <button
      type="button"
      className="row"
      aria-selected={selected}
      onClick={onSelect}
      style={inactive ? { opacity: 0.55 } : undefined}
    >
      <span className="name" title={preset.path}>
        {detached && <span className="dot warn" aria-hidden="true" title="Detached full copy" />}
        {preset.name}
      </span>
      <span className="meta">
        {inactive ? 'not loaded · ' : ''}
        {preset.isCustomRoot ? 'root · ' : ''}
        {where ? `${where} · ` : ''}
        {stored}
      </span>
    </button>
  );
}

function Overview({ index, onOpenHealth }: { index: ConfigIndex; onOpenHealth: () => void }) {
  const s = stats(index);
  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 17 }}>Config loaded</h2>
      <div className="stats-row">
        <div className="stat">
          <span className="n">{s.user}</span>
          <span className="l">Your presets</span>
        </div>
        <div className="stat">
          <span className="n">{s.system}</span>
          <span className="l">System presets</span>
        </div>
        <div className="stat">
          <span className="n">{s.vendors}</span>
          <span className="l">Vendors</span>
        </div>
        <div className="stat">
          <span className="n">{s.deepestChain?.depth ?? 0}</span>
          <span className="l">Deepest chain</span>
        </div>
        {s.snapshots > 0 && (
          <div className="stat">
            <span className="n">{s.snapshots}</span>
            <span className="l">Sync snapshots</span>
          </div>
        )}
      </div>

      <div className="notice">
        A preset stores only what it <strong>overrides</strong>; everything else comes from the
        chain above it. Pick one on the left to see which values are actually yours — or start with{' '}
        <button type="button" className="chip" onClick={onOpenHealth}>
          Health
        </button>{' '}
        to see what is tangled.
      </div>

      <p className="muted">
        OrcaSlicer loads exactly one user folder — this config uses{' '}
        <span className="mono">user/{index.activeProfile}</span>.
        {index.inactiveProfiles.length > 0 && (
          <>
            {' '}
            Presets in{' '}
            {index.inactiveProfiles.map((p) => (
              <span key={p} className="mono">
                user/{p}{' '}
              </span>
            ))}
            are on disk but never loaded, so editing them changes nothing.
          </>
        )}
        {s.snapshots > 0 && (
          <>
            {' '}
            A further {s.snapshots} files under <span className="mono">_local/</span> are cloud sync
            snapshots.
          </>
        )}
      </p>
    </div>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
