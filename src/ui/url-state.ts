/**
 * View state that lives in the URL.
 *
 * Everything the app shows was component-local `useState`, so a reload lost your
 * place and nothing could be linked to — which is most of the point of a
 * read-only explorer being a web app. This module is the layer that fixes that.
 *
 * **It carries preset ids, and a preset id is its path** — so a link reads
 * `?tab=printer&printer=user/default/machine/<printer name>.json` and puts a real
 * name into a string designed to be pasted. That was ORCA-16's open question and
 * it was decided deliberately, not by default: put the path in, and document it.
 * Two things settled it.
 *
 *  - A link is only useful to someone who already has the same config, and to
 *    them the names are already on screen.
 *  - The path is not one identifier among several. The slicer takes a **user
 *    preset's name from its filename** (Preset.cpp:1613-1622, ORCA-28), so the
 *    path is the identifier OrcaSlicer itself uses. Hashing it would have been
 *    indirection over the real name, paying a rename-fragility cost to obscure
 *    something the reader can already see.
 *
 * The presets search box `q` stays for the same reason it shipped in ORCA-14: the
 * *user* typed it and can see it in the address bar, which is a different act from
 * the app embedding an id.
 *
 * The graph's three filters are here too (ORCA-15) and carry no name either. They
 * were sequenced behind ORCA-12 for a reason worth remembering: until that landed,
 * leaving the graph tab and coming back was the *only* escape from an all-off
 * filter state, because `App` unmounts the view and the state died with it. URL
 * state survives the unmount, so that accidental escape hatch is gone — and the
 * on-screen way out ORCA-12 added is what replaces it.
 *
 * Decisions worth keeping:
 *
 *  - **A query string, not a path.** The app is served two ways — the container's
 *    SPA fallback and a static build under `BASE_URL` — and a query string needs
 *    no server-side routing in either.
 *  - **Only non-default values are written.** A fresh app has a bare URL, so what
 *    is in it is exactly what you changed, and a link says only what it means.
 *  - **Parsing and serialising are pure functions over a string**, and the hook is
 *    the only part that touches `history`. That is what lets the round-trips be
 *    tested in node without a DOM.
 *  - **`replaceState` for filters, `pushState` for the tab.** Back should undo
 *    "I went to Health", not each of the six chips you clicked on the way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Finding } from '../domain/analyze';
import type { ConfigIndex } from '../domain/index-config';
import type { Preset, PresetKind, PresetOrigin } from '../domain/types';

export type Tab = 'presets' | 'graph' | 'printer' | 'health' | 'compare';

const TABS: Tab[] = ['presets', 'graph', 'printer', 'health', 'compare'];
const KINDS: PresetKind[] = ['filament', 'process', 'machine'];
const ORIGINS: PresetOrigin[] = ['user', 'system'];

/**
 * Exhaustive by construction: a `Record` over the union, so adding a finding kind
 * to `analyze.ts` without teaching the URL about it is a type error rather than a
 * link that silently falls back to `all`.
 */
const FINDING_KINDS: Record<Finding['kind'], true> = {
  detached: true,
  'redundant-overrides': true,
  'near-duplicate': true,
  'broken-parent': true,
  'not-loaded': true,
  'circular-inherits': true,
  'orphaned-printer': true,
  'missing-reference': true,
  'duplicate-name': true,
  'parse-error': true,
};

export interface ViewState {
  tab: Tab;
  /** The presets search box. */
  q: string;
  /** Presets sidebar: which kinds are listed. */
  kinds: Set<PresetKind>;
  /** Presets sidebar: user presets, vendor presets, or both. */
  origins: Set<PresetOrigin>;
  /** Presets sidebar: include presets the slicer never loads. */
  showInactive: boolean;
  /** Health tab: one finding kind, or all of them. */
  healthKind: Finding['kind'] | 'all';
  /**
   * Graph tab: which kinds are drawn.
   *
   * Separate from the sidebar's `kinds` rather than shared. They look like the same
   * filter and are not: the sidebar picks what to *list*, the graph picks what to
   * *draw*, and the two have different useful defaults — narrowing a diagram to one
   * kind is normal, narrowing the sidebar to one kind while you are reading the
   * graph is not. Sharing one key would make each tab silently change the other.
   */
  graphKinds: Set<PresetKind>;
  /** Graph tab: include vendor presets nothing of yours inherits from. */
  graphSystemOnly: boolean;
  /** Graph tab: include user folders the slicer does not load. */
  graphInactive: boolean;
  /**
   * The four keys that name presets, each a preset **path**. Empty means unset.
   *
   * Unlike everything above, one of these can name something this config does not
   * have — a link made against a different config, or a preset since renamed. That
   * is why `resolveIds` exists rather than each caller doing `byId.get()`: the
   * failure has to be visible, and there are three outcomes, not two.
   */
  selected: string;
  compareA: string;
  compareB: string;
  printer: string;
  process: string;
}

export function defaultViewState(): ViewState {
  return {
    tab: 'presets',
    q: '',
    kinds: new Set(KINDS),
    origins: new Set<PresetOrigin>(['user']),
    showInactive: false,
    healthKind: 'all',
    graphKinds: new Set(KINDS),
    graphSystemOnly: false,
    graphInactive: false,
    selected: '',
    compareA: '',
    compareB: '',
    printer: '',
    process: '',
  };
}

/**
 * Read a URL's query string into view state.
 *
 * Unknown values fall back to the default rather than rendering nothing: a bad
 * `tab` or `health` is a typo, not a broken link, and neither can point at
 * something missing from *this* config.
 *
 * **The five preset ids are the opposite case and are taken verbatim.** One of
 * them can name a file this config does not have, and silently falling back would
 * show the wrong preset or a blank pane to someone who followed a link. Deciding
 * that needs the config, which this function does not have, so it does not guess —
 * `resolveIds` does it once the index is loaded.
 */
export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search);
  const d = defaultViewState();
  const tab = p.get('tab');
  const health = p.get('health');
  return {
    tab: isTab(tab) ? tab : d.tab,
    q: p.get('q') ?? d.q,
    kinds: parseSet(p.get('kinds'), KINDS, d.kinds),
    origins: parseSet(p.get('origins'), ORIGINS, d.origins),
    showInactive: p.get('inactive') === '1',
    healthKind: health !== null && isFindingKind(health) ? health : d.healthKind,
    graphKinds: parseSet(p.get('gkinds'), KINDS, d.graphKinds),
    graphSystemOnly: p.get('gvendor') === '1',
    graphInactive: p.get('ginactive') === '1',
    // Taken verbatim. Whether the id names anything is a question for the config,
    // which this module does not have — see `resolveIds`.
    selected: p.get('preset') ?? d.selected,
    compareA: p.get('a') ?? d.compareA,
    compareB: p.get('b') ?? d.compareB,
    printer: p.get('printer') ?? d.printer,
    process: p.get('process') ?? d.process,
  };
}

/** The query string for a state, `?`-prefixed, or `''` when nothing differs from the default. */
export function serialiseViewState(view: ViewState): string {
  const d = defaultViewState();
  const p = new URLSearchParams();
  if (view.tab !== d.tab) p.set('tab', view.tab);
  if (view.q !== d.q) p.set('q', view.q);
  if (!sameSet(view.kinds, d.kinds)) p.set('kinds', order(view.kinds, KINDS).join(','));
  if (!sameSet(view.origins, d.origins)) p.set('origins', order(view.origins, ORIGINS).join(','));
  if (view.showInactive) p.set('inactive', '1');
  if (view.healthKind !== d.healthKind) p.set('health', view.healthKind);
  // `g`-prefixed, because the graph's kind filter is a different filter from the
  // sidebar's and a shared key would make one tab move the other.
  if (!sameSet(view.graphKinds, d.graphKinds)) {
    p.set('gkinds', order(view.graphKinds, KINDS).join(','));
  }
  if (view.graphSystemOnly) p.set('gvendor', '1');
  if (view.graphInactive) p.set('ginactive', '1');
  if (view.selected !== d.selected) p.set('preset', view.selected);
  if (view.compareA !== d.compareA) p.set('a', view.compareA);
  if (view.compareB !== d.compareB) p.set('b', view.compareB);
  if (view.printer !== d.printer) p.set('printer', view.printer);
  if (view.process !== d.process) p.set('process', view.process);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export type UpdateView = (patch: Partial<ViewState>, opts?: { push?: boolean }) => void;

/**
 * The view state, backed by the address bar.
 *
 * `push` is for the things a person would expect Back to undo — changing tab —
 * and everything else replaces, so fiddling with chips does not bury the entry
 * they actually want to return to.
 */
export function useViewState(): [ViewState, UpdateView] {
  const [view, setView] = useState<ViewState>(() => parseViewState(window.location.search));
  // The patch is applied to what is on screen now, not to whatever `setView`'s
  // updater is given: React runs updaters twice under StrictMode and a
  // `pushState` inside one would fire twice with it.
  const current = useRef(view);
  current.current = view;

  const write = useCallback((next: ViewState, push: boolean) => {
    const url = `${window.location.pathname}${serialiseViewState(next)}${window.location.hash}`;
    if (push) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, []);

  // A link with a typo in it, or a stale one, should not leave the address bar
  // saying something the app is not doing. Normalising on mount also drops any
  // keys we no longer understand.
  useEffect(() => {
    write(current.current, false);
  }, [write]);

  useEffect(() => {
    const onPop = () => setView(parseViewState(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const update = useCallback<UpdateView>(
    (patch, opts) => {
      const next = { ...current.current, ...patch };
      current.current = next;
      write(next, opts?.push === true);
      setView(next);
    },
    [write],
  );

  return [view, update];
}

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as string[]).includes(v);
}

function isFindingKind(v: string): v is Finding['kind'] {
  return Object.hasOwn(FINDING_KINDS, v);
}

/**
 * A comma list of set members.
 *
 * Three cases, and they are deliberately different: absent means "not stated,
 * use the default", empty means an empty set — turning every chip off is a real
 * state and a link to it should survive — and a value whose every token is
 * unknown means the link is garbage, so the default is safer than showing an
 * empty list nobody asked for. Unknown tokens *alongside* known ones are just
 * dropped.
 */
function parseSet<T extends string>(raw: string | null, valid: T[], fallback: Set<T>): Set<T> {
  if (raw === null) return new Set(fallback);
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
  const kept = tokens.filter((t): t is T => (valid as string[]).includes(t));
  if (tokens.length > 0 && kept.length === 0) return new Set(fallback);
  return new Set(kept);
}

function order<T>(set: Set<T>, canonical: T[]): T[] {
  return canonical.filter((v) => set.has(v));
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/**
 * What a preset id in a URL actually points at, once there is a config to ask.
 *
 * **Three outcomes, not two**, and the third is new. A link can name:
 *
 *  - a preset that is there and loaded — the ordinary case;
 *  - a preset that is there and that **OrcaSlicer does not load** — its vendor's
 *    bundle failed (ORCA-26/27), it lost a name clash, its `version` does not
 *    parse, or it names a sibling in its own directory (ORCA-22). The preset
 *    resolves; showing it is right, and so is saying it is inert. Reporting this
 *    as "unknown" would send someone looking for a file they are looking at;
 *  - nothing at all — a link from a different config, or a since-renamed file.
 *
 * Only the last is a broken link, and the parent epic decided long ago how it
 * behaves: ignore the id, keep the tab, say why on screen. Never silently show
 * something else.
 */
export type IdStatus = 'ok' | 'not-loaded' | 'unknown';

export interface ResolvedId {
  /** The id as the URL gave it, so a message can quote what was asked for. */
  id: string;
  status: IdStatus;
  /** Present unless `unknown`. */
  preset?: Preset;
}

export function resolveId(index: ConfigIndex, id: string): ResolvedId | undefined {
  if (id === '') return undefined;
  const preset = index.byId.get(id);
  if (!preset) return { id, status: 'unknown' };
  // A snapshot under `_local/` is on disk and never loaded either, and is not in
  // `notLoaded` because that map is over active presets only.
  const inert = preset.scope !== 'active' || index.notLoaded.has(preset.id);
  return { id, status: inert ? 'not-loaded' : 'ok', preset };
}

/** Every id in the view that named nothing, so the app can say so once. */
export function unknownIds(index: ConfigIndex, view: ViewState): string[] {
  return [view.selected, view.compareA, view.compareB, view.printer, view.process]
    .map((id) => resolveId(index, id))
    .filter((r): r is ResolvedId => r?.status === 'unknown')
    .map((r) => r.id);
}
