/**
 * The URL layer, tested as the pure pair it is: `parseViewState` and
 * `serialiseViewState` over strings, no DOM.
 *
 * A round-trip test that only checks the tab would pass while every filter was
 * dropped on the floor, so there is one per group. The interesting cases are the
 * three ways a set can arrive — absent, deliberately empty, and garbage — which
 * a link from an older build or a typo will produce and which must not be
 * conflated.
 */

import { describe, expect, it } from 'vitest';
import { buildIndex } from '../domain/index-config';
import { loadConfigDir } from '../domain/load-fixtures';
import { defaultViewState, parseViewState, serialiseViewState, type ViewState, resolveId, unknownIds } from './url-state';

/** Parse what we serialised: what a link does, in one step. */
const roundTrip = (view: ViewState) => parseViewState(serialiseViewState(view));

describe('view state in the URL', () => {
  it('writes nothing when nothing differs from the default', () => {
    expect(serialiseViewState(defaultViewState())).toBe('');
  });

  it('round-trips the tab', () => {
    for (const tab of ['presets', 'graph', 'printer', 'health', 'compare'] as const) {
      expect(roundTrip({ ...defaultViewState(), tab }).tab).toBe(tab);
    }
  });

  it('round-trips the search box, including characters that need escaping', () => {
    const q = 'Fast Draft & 0.2mm';
    const search = serialiseViewState({ ...defaultViewState(), q });
    expect(search).not.toContain(' ');
    expect(parseViewState(search).q).toBe(q);
  });

  it('round-trips the sidebar kinds, empty set included', () => {
    const cases = [new Set(['filament' as const]), new Set(['process' as const, 'machine' as const]), new Set([])];
    for (const kinds of cases) {
      expect([...roundTrip({ ...defaultViewState(), kinds }).kinds]).toEqual([...kinds]);
    }
  });

  it('round-trips the sidebar origins and showInactive', () => {
    const view: ViewState = {
      ...defaultViewState(),
      origins: new Set(['user' as const, 'system' as const]),
      showInactive: true,
    };
    const back = roundTrip(view);
    expect([...back.origins]).toEqual(['user', 'system']);
    expect(back.showInactive).toBe(true);
  });

  it('round-trips the health kind filter', () => {
    expect(roundTrip({ ...defaultViewState(), healthKind: 'duplicate-name' }).healthKind).toBe(
      'duplicate-name',
    );
  });

  it('round-trips the graph’s kinds, empty set included', () => {
    // The all-off state is the one that matters: it used to be escapable only by
    // leaving the tab, which URL state removes, so a link to it has to survive and
    // ORCA-12's on-screen way out is what recovers from it.
    const cases = [
      new Set(['machine' as const]),
      new Set(['filament' as const, 'process' as const]),
      new Set([]),
    ];
    for (const graphKinds of cases) {
      expect([...roundTrip({ ...defaultViewState(), graphKinds }).graphKinds]).toEqual([
        ...graphKinds,
      ]);
    }
  });

  it('round-trips the graph’s two include-toggles', () => {
    const view: ViewState = {
      ...defaultViewState(),
      graphSystemOnly: true,
      graphInactive: true,
    };
    const back = roundTrip(view);
    expect(back.graphSystemOnly).toBe(true);
    expect(back.graphInactive).toBe(true);
    // Each independently, so one is not carrying the other.
    expect(roundTrip({ ...defaultViewState(), graphSystemOnly: true }).graphInactive).toBe(false);
    expect(roundTrip({ ...defaultViewState(), graphInactive: true }).graphSystemOnly).toBe(false);
  });

  it('keeps the graph’s kinds separate from the sidebar’s', () => {
    // They look like the same filter and are not. One key for both would make
    // narrowing the diagram silently narrow the sidebar too.
    const view: ViewState = {
      ...defaultViewState(),
      kinds: new Set(['filament']),
      graphKinds: new Set(['machine']),
    };
    const back = roundTrip(view);
    expect([...back.kinds]).toEqual(['filament']);
    expect([...back.graphKinds]).toEqual(['machine']);
    const search = serialiseViewState(view);
    expect(search).toContain('kinds=filament');
    expect(search).toContain('gkinds=machine');
  });

  it('round-trips every group at once, not just one at a time', () => {
    const view: ViewState = {
      tab: 'health',
      q: 'draft',
      kinds: new Set(['machine']),
      origins: new Set(['system']),
      showInactive: true,
      healthKind: 'detached',
      graphKinds: new Set(['filament', 'process']),
      graphSystemOnly: true,
      graphInactive: true,
      selected: 'user/default/filament/Studio ABS.json',
      compareA: 'user/default/process/Fast Draft.json',
      compareB: 'user/default/process/Loop A.json',
      printer: 'user/default/machine/Workshop Cube.json',
      process: 'system/Acme/process/0.20mm Standard @Acme.json',
    };
    expect(roundTrip(view)).toEqual(view);
  });

  it('falls back on a tab that does not exist', () => {
    expect(parseViewState('?tab=nonsense').tab).toBe('presets');
    expect(parseViewState('?tab=').tab).toBe('presets');
  });

  it('falls back on a health kind that does not exist', () => {
    expect(parseViewState('?health=not-a-finding').healthKind).toBe('all');
  });

  it('drops an unknown kind but keeps the ones it understands', () => {
    expect([...parseViewState('?kinds=filament,nonsense').kinds]).toEqual(['filament']);
  });

  it('tells the graph’s empty set apart from a garbage value too', () => {
    expect([...parseViewState('').graphKinds]).toEqual(['filament', 'process', 'machine']);
    expect([...parseViewState('?gkinds=').graphKinds]).toEqual([]);
    expect([...parseViewState('?gkinds=nonsense').graphKinds]).toEqual([
      'filament',
      'process',
      'machine',
    ]);
    expect([...parseViewState('?gkinds=machine,nonsense').graphKinds]).toEqual(['machine']);
  });

  it('tells an empty set apart from a value it could make nothing of', () => {
    // Absent: not stated, so the default stands.
    expect([...parseViewState('').kinds]).toEqual(['filament', 'process', 'machine']);
    // Empty: every chip off is a real state, and a link to it has to survive.
    expect([...parseViewState('?kinds=').kinds]).toEqual([]);
    // All-garbage: the link is broken, and an empty list nobody asked for is a
    // worse answer than the default.
    expect([...parseViewState('?kinds=nonsense,rubbish').kinds]).toEqual([
      'filament',
      'process',
      'machine',
    ]);
  });

  it('serialises in a stable order, so the same view is always the same link', () => {
    const a: ViewState = { ...defaultViewState(), kinds: new Set(['machine', 'filament']) };
    const b: ViewState = { ...defaultViewState(), kinds: new Set(['filament', 'machine']) };
    expect(serialiseViewState(a)).toBe(serialiseViewState(b));
    expect(serialiseViewState(a)).toBe('?kinds=filament%2Cmachine');
  });

  it('ignores keys it does not know', () => {
    expect(parseViewState('?tab=graph&selected=some/path.json&nope=1').tab).toBe('graph');
    expect(serialiseViewState(parseViewState('?tab=graph&nope=1'))).toBe('?tab=graph');
  });
});


describe('the preset ids in the URL', () => {
  // ORCA-16, decided: the path goes in, documented. These are the keys that can
  // name something this config does not have, which is what makes them different
  // from every other key in the URL.
  const FIXTURE = new URL('../../fixtures/config', import.meta.url).pathname;
  const index = buildIndex(loadConfigDir(FIXTURE));

  it('round-trips each group on its own, not just all at once', () => {
    // A test per group, as the epic asked — one test over all five would pass with
    // four of the keys silently dropped.
    const groups = [
      { selected: 'user/default/filament/Studio ABS.json' },
      {
        compareA: 'user/default/process/Fast Draft.json',
        compareB: 'user/default/process/Loop A.json',
      },
      { printer: 'user/default/machine/Workshop Cube.json' },
      { process: 'system/Acme/process/0.20mm Standard @Acme.json' },
    ];
    for (const group of groups) {
      const view = { ...defaultViewState(), ...group };
      expect(parseViewState(serialiseViewState(view))).toEqual(view);
    }
  });

  it('keeps a bare URL bare', () => {
    // The ids are only written when set, so a fresh app has no query string and a
    // link says exactly what it means.
    expect(serialiseViewState(defaultViewState())).toBe('');
  });

  it('puts the path in the URL, which is the decision', () => {
    // Pinned rather than assumed: this is the thing that was decided, and a later
    // change to hashing would be a decision reversal rather than a refactor.
    const search = serialiseViewState({
      ...defaultViewState(),
      printer: 'user/default/machine/Workshop Cube.json',
    });
    // `+` for space is what `URLSearchParams` writes, and what it reads back — the
    // round-trip above proves the decode. Asserted in the encoded form because
    // that is the string a person actually copies out of the address bar.
    expect(search).toBe('?printer=user%2Fdefault%2Fmachine%2FWorkshop+Cube.json');
    expect(parseViewState(search).printer).toBe('user/default/machine/Workshop Cube.json');
  });

  it('resolves an id that is present and loaded', () => {
    const r = resolveId(index, 'user/default/filament/Studio ABS.json');
    expect(r).toMatchObject({ status: 'ok' });
    expect(r?.preset?.name).toBe('Studio ABS');
  });

  it('distinguishes present-but-not-loaded from unknown', () => {
    // The third outcome, and the one today's rules made common. `Loop A` names a
    // sibling in its own directory (ORCA-22) and an Initech preset went down with
    // its vendor's bundle (ORCA-26/27). Both are *here*; neither is loaded.
    // Calling either "not in this config" would send someone looking for a file
    // they are looking at.
    expect(resolveId(index, 'user/default/process/Loop A.json')?.status).toBe('not-loaded');
    expect(
      resolveId(index, 'system/Initech/filament/Initech PLA @System.json')?.status,
    ).toBe('not-loaded');
    expect(resolveId(index, 'user/default/filament/Nope.json')?.status).toBe('unknown');
  });

  it('reports only the ids that name nothing', () => {
    const view = {
      ...defaultViewState(),
      selected: 'user/default/filament/Studio ABS.json', // ok
      compareA: 'user/default/process/Loop A.json', // not loaded, but here
      printer: 'user/default/machine/From Another Config.json', // gone
    };
    expect(unknownIds(index, view)).toEqual(['user/default/machine/From Another Config.json']);
  });

  it('treats an unset id as no question at all', () => {
    expect(resolveId(index, '')).toBeUndefined();
    expect(unknownIds(index, defaultViewState())).toEqual([]);
  });
});
