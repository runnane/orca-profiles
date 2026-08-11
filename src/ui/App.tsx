/**
 * The shell: load a config, then browse / diagnose / compare it.
 *
 * All state is in memory and the config is read-only. Nothing is written back
 * to disk and nothing is sent anywhere — see `src/source/fs-access.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stats } from '../domain/analyze';
import {
  buildIndex,
  type ConfigFile,
  type ConfigIndex,
  type LoadFailure,
  type NotLoadedReason,
} from '../domain/index-config';
import type { Preset, PresetKind, PresetOrigin } from '../domain/types';
import { isFileSystemAccessSupported, pickAndReadConfig } from '../source/fs-access';
import { fetchServerConfig, serverConfigAvailable } from '../source/http';
import { CompareView } from './CompareView';
import { GraphView } from './GraphView';
import { HealthReport } from './HealthReport';
import { PresetDetail } from './PresetDetail';
import { PrinterView } from './PrinterView';
import { unknownIds, useViewState, type Tab } from './url-state';

const KINDS: PresetKind[] = ['filament', 'process', 'machine'];
const ORIGINS: PresetOrigin[] = ['user', 'system'];

export function App() {
  const [index, setIndex] = useState<ConfigIndex | null>(null);
  const [rootName, setRootName] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The tab and the sidebar filters live in the URL, so a reload keeps your place
   * and a view can be linked to. `showInactive` is in there too: presets the
   * slicer never loads stay behind a toggle so they can be found when you go
   * looking but never pad the counts.
   *
   * The preset ids are deliberately *not* here — a preset id is its path, so
   * putting one in a URL publishes a real name. That is ORCA-16.
   */
  const [view, updateView] = useViewState();
  const { tab, q: query, kinds, origins, showInactive } = view;
  // Back should undo "I went to Health", not each chip clicked on the way there.
  const setTab = useCallback((t: Tab) => updateView({ tab: t }, { push: true }), [updateView]);

  // The five preset ids live in the URL too (ORCA-16). Opening a preset pushes,
  // for the same reason changing tab does: Back should close what you opened.
  const selectedId = view.selected;
  const setSelectedId = useCallback(
    (id: string) => updateView({ selected: id }, { push: true }),
    [updateView],
  );
  const compareA = view.compareA;
  const compareB = view.compareB;
  const printerId = view.printer;
  const setPrinterId = useCallback((id: string) => updateView({ printer: id }), [updateView]);

  // How long the last load took, so "is it slow?" has an answer on screen
  // rather than being a matter of opinion.
  const [timing, setTiming] = useState<{ files: number; readMs: number; indexMs: number } | null>(
    null,
  );

  // The first config arrives *after* the URL has been read — in container mode it
  // loads on its own — so honour the tab a link asked for. Opening a *second*
  // config is a deliberate act on a different config, and starting it on Presets
  // is right.
  const loadedOnce = useRef(false);

  const load = useCallback(
    (files: ConfigFile[], name: string, readMs: number) => {
      const t0 = performance.now();
      const built = buildIndex(files);
      const indexMs = performance.now() - t0;
      setIndex(built);
      setRootName(name);
      setTiming({ files: files.length, readMs, indexMs });
      // Only on a *second* config, and this is the line a deep link depends on.
      // Clearing unconditionally would wipe `?preset=…` between the URL being read
      // and the config arriving — in container mode the config loads by itself, so
      // that race is the normal path rather than an edge case. The ids are cleared
      // with the tab for the same reason the tab is: an id from one config means
      // nothing in another, and carrying it over would fire the "not in this
      // config" notice about a preset the user never asked for.
      if (loadedOnce.current) {
        updateView({ tab: 'presets', selected: '', compareA: '', compareB: '', printer: '', process: '' });
      }
      loadedOnce.current = true;
    },
    [updateView],
  );

  const openPicker = useCallback(async () => {
    setError(null);
    // The dialog is modal and can sit open for as long as the user likes, so
    // this must not claim to be reading anything yet.
    setLoading('Waiting for you to choose a folder…');
    try {
      const { rootName: name, files, elapsedMs } = await pickAndReadConfig(
        (p) => {
          if (p.phase === 'scanning') setLoading(`Scanning… ${p.files} files found`);
          else setLoading(`Reading ${p.files}/${p.total ?? '?'} files…`);
        },
        () => setLoading('Scanning…'),
      );
      if (files.length === 0) {
        setError('No preset files found there. Pick the OrcaSlicer config folder itself.');
      } else {
        load(files, name, elapsedMs);
      }
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      setLoading(null);
    }
  }, [load]);

  // Served by the container: the config is already on the server side, so load
  // it without asking. No picker, no Chromium requirement.
  const [serverMode, setServerMode] = useState<boolean | null>(null);
  const loadFromServer = useCallback(
    async (refresh = false) => {
      setError(null);
      setLoading('Loading config from server…');
      try {
        const data = await fetchServerConfig(refresh);
        load(data.files, data.rootName, data.readMs);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(null);
      }
    },
    [load],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available = await serverConfigAvailable();
      if (cancelled) return;
      setServerMode(available);
      if (available) void loadFromServer();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFromServer]);

  const loadSample = useCallback(async () => {
    setError(null);
    setLoading('Loading sample…');
    const t0 = performance.now();
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}sample-config.json`);
      if (!res.ok) throw new Error(`Sample config not available (${res.status})`);
      const data = (await res.json()) as { rootName: string; files: ConfigFile[] };
      load(data.files, data.rootName, performance.now() - t0);
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

  // One update, not three: two `updateView` calls in a row would write the first
  // to the address bar and then immediately replace it, so a Back from the compare
  // tab would land on a half-applied state.
  const showCompare = useCallback(
    (a: string, b: string) => updateView({ compareA: a, compareB: b, tab: 'compare' }, { push: true }),
    [updateView],
  );

  const showPreset = useCallback(
    (id: string) => updateView({ selected: id, tab: 'presets' }, { push: true }),
    [updateView],
  );

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
            {serverMode === null && <p className="muted" style={{ margin: 0 }}>Looking for a config server…</p>}
            {serverMode === true ? (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  {loading ?? 'Reading the config mounted into this container.'}
                </p>
                <button type="button" onClick={() => void loadFromServer(true)} disabled={!!loading}>
                  Retry
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const s = stats(index);
  const missingIds = unknownIds(index, view);

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
            aria-selected={tab === 'graph'}
            onClick={() => setTab('graph')}
          >
            Graph
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'printer'}
            onClick={() => setTab('printer')}
          >
            Printer
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
        {serverMode ? (
          <button type="button" className="ghost" onClick={() => void loadFromServer(true)}>
            Reload from disk
          </button>
        ) : (
          <button type="button" className="ghost" onClick={openPicker}>
            Open another…
          </button>
        )}
      </Topbar>

      <div className="body">
        {tab === 'presets' && (
          <aside className="sidebar">
            <div className="filters">
              <input
                type="search"
                placeholder="Search presets…"
                value={query}
                onChange={(e) => updateView({ q: e.target.value })}
              />
              <div className="chips">
                {ORIGINS.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className="chip"
                    aria-pressed={origins.has(o)}
                    onClick={() => updateView({ origins: toggle(origins, o) })}
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
                    onClick={() => updateView({ kinds: toggle(kinds, k) })}
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
                    onClick={() => updateView({ showInactive: !showInactive })}
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
                  failure={index.notLoaded.get(p.id)}
                  selected={p.id === selectedId}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))}
            </div>
          </aside>
        )}

        <main className="main">
          {/* A link that names a preset this config does not have fails **visibly**:
              the id is ignored, the tab is kept, and this says which id and why.
              Decided on ORCA-13 and not negotiable — silently showing the wrong
              preset, or a blank pane, is how someone concludes the tool is lying.
              Note this fires only for ids that name *nothing*; a preset that is
              here and that the slicer does not load is a different answer, and the
              detail pane already gives it. */}
          {missingIds.length > 0 && (
            <div className="notice" style={{ borderColor: 'var(--danger)' }}>
              <strong>
                This link names {missingIds.length === 1 ? 'a preset' : `${missingIds.length} presets`} that
                {missingIds.length === 1 ? ' is' : ' are'} not in this config
              </strong>{' '}
              — {missingIds.map((id) => <code key={id}>{id}</code>).reduce((a, b) => <>{a}, {b}</>)}.{' '}
              {missingIds.length === 1 ? 'It has' : 'They have'} been ignored. A preset id is its
              file path, so a link only works against the config it was made from.
            </div>
          )}

          {tab === 'presets' &&
            (selected ? (
              <PresetDetail
                index={index}
                preset={selected}
                onSelect={showPreset}
                onCompare={showCompare}
              />
            ) : (
              <Overview index={index} onOpenHealth={() => setTab('health')} timing={timing} />
            ))}

          {tab === 'graph' && (
            <GraphView
              index={index}
              kinds={view.graphKinds}
              includeSystemOnly={view.graphSystemOnly}
              includeInactive={view.graphInactive}
              // No `push`: a chip is fiddling, and Back should undo "I went to the
              // graph", not each of six clicks on the way through it.
              onFilters={(patch) =>
                updateView({
                  ...(patch.kinds !== undefined && { graphKinds: patch.kinds }),
                  ...(patch.includeSystemOnly !== undefined && {
                    graphSystemOnly: patch.includeSystemOnly,
                  }),
                  ...(patch.includeInactive !== undefined && {
                    graphInactive: patch.includeInactive,
                  }),
                })
              }
              onSelect={showPreset}
            />
          )}

          {tab === 'printer' && (
            <PrinterView
              index={index}
              machineId={printerId}
              processId={view.process}
              onPickMachine={setPrinterId}
              onPickProcess={(id) => updateView({ process: id })}
              onSelect={showPreset}
            />
          )}

          {tab === 'health' && (
            <HealthReport
              index={index}
              kindFilter={view.healthKind}
              onKindFilter={(k) => updateView({ healthKind: k })}
              onSelect={showPreset}
              onCompare={showCompare}
            />
          )}

          {tab === 'compare' && (
            <CompareView
              index={index}
              aId={compareA}
              bId={compareB}
              onPick={(a, b) => updateView({ compareA: a, compareB: b })}
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

/** Why a file in the loaded folder is nonetheless absent from the slicer. */
const NOT_LOADED_LABEL: Record<NotLoadedReason, string> = {
  'name-clash': 'name taken',
  'bad-version': 'bad version',
  'parent-not-loaded': 'parent missing',
  'bundle-failed': 'vendor failed',
};

function PresetRow({
  preset,
  failure,
  selected,
  onSelect,
}: {
  preset: Preset;
  /** Set when the slicer skips this file. See `index.notLoaded`. */
  failure?: LoadFailure;
  selected: boolean;
  onSelect: () => void;
}) {
  const stored = Object.keys(preset.raw).length;
  const detached = preset.origin === 'user' && !preset.inherits && stored > 40;
  // The same name legitimately exists in more than one place, so the row has to
  // carry where it lives or two rows are indistinguishable.
  const where = preset.origin === 'system' ? preset.vendor : preset.profile;
  // Two different ways of not being loaded, and both belong on the row. Scope is
  // "in a folder the slicer does not read"; `failure` is "in the folder it does
  // read, and skipped anyway" — which is the one that reads as "but it is right
  // there". Dropping the row instead would be silent absence, which for a whole
  // vendor disappearing at once is worse than being wrongly present.
  const inactive = preset.scope !== 'active';
  const skipped = failure !== undefined;
  return (
    <button
      type="button"
      className="row"
      aria-selected={selected}
      onClick={onSelect}
      style={inactive || skipped ? { opacity: 0.55 } : undefined}
    >
      <span className="name" title={preset.path}>
        {detached && <span className="dot warn" aria-hidden="true" title="Detached full copy" />}
        {preset.name}
      </span>
      <span className="meta">
        {inactive ? 'not loaded · ' : ''}
        {failure ? `${NOT_LOADED_LABEL[failure.reason]} · ` : ''}
        {/* A vendor base is kept in this list on purpose — opening one to see where
            an inherited value came from is the point of the app — but it is not a
            preset you could select, so it says so rather than sitting here looking
            like one. */}
        {!preset.instantiable ? 'base · ' : ''}
        {preset.isCustomRoot ? 'root · ' : ''}
        {where ? `${where} · ` : ''}
        {stored}
      </span>
    </button>
  );
}

function Overview({
  index,
  onOpenHealth,
  timing,
}: {
  index: ConfigIndex;
  onOpenHealth: () => void;
  timing: { files: number; readMs: number; indexMs: number } | null;
}) {
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
        {/* Reported rather than silently subtracted from the figure above. A base is
            an inheritance source, never selectable, and a count that dropped with no
            explanation reads as presets having gone missing. */}
        {s.bases > 0 && (
          <div className="stat">
            <span className="n">{s.bases}</span>
            <span className="l" title="instantiation: false — inheritance sources, not selectable">
              Vendor bases
            </span>
          </div>
        )}
        <div className="stat">
          <span className="n">{s.vendors}</span>
          <span className="l">Vendors</span>
        </div>
        <div className="stat">
          <span className="n">{s.deepestChain?.depth ?? 0}</span>
          <span className="l">Deepest chain</span>
        </div>
        {s.notLoaded > 0 && (
          <div className="stat">
            <span className="n">{s.notLoaded}</span>
            <span className="l">Never loaded</span>
          </div>
        )}
        {s.snapshots > 0 && (
          <div className="stat">
            <span className="n">{s.snapshots}</span>
            <span className="l">Sync snapshots</span>
          </div>
        )}
      </div>

      {/* Said here rather than only in Health: the counts above are the slicer's
          numbers, not the disk's, and a difference that large needs its reason on
          screen beside it. A whole vendor can be in here. */}
      {s.notLoaded > 0 && (
        <p className="muted">
          The counts above are what OrcaSlicer <strong>loads</strong>. A further {s.notLoaded}{' '}
          {s.notLoaded === 1 ? 'file is' : 'files are'} in the folder it reads and skipped anyway —
          editing {s.notLoaded === 1 ? 'it' : 'them'} changes nothing.
          {s.failedVendors.length > 0 && (
            <>
              {' '}
              That includes everything shipped by{' '}
              {s.failedVendors.map((v) => (
                <span key={v} className="mono">
                  {v}{' '}
                </span>
              ))}
              — one unresolvable <span className="mono">inherits</span> fails a vendor's whole
              bundle, presets and printer models together.
            </>
          )}{' '}
          <button type="button" className="chip" onClick={onOpenHealth}>
            Health
          </button>{' '}
          says which gate each one hit.
        </p>
      )}

      {timing && (
        <p className="faint mono" style={{ marginTop: -8, fontSize: 11 }}>
          read {timing.files} files in {(timing.readMs / 1000).toFixed(1)}s · indexed in{' '}
          {timing.indexMs.toFixed(0)}ms
        </p>
      )}

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
