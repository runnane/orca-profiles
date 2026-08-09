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
import { defaultViewState, parseViewState, serialiseViewState, type ViewState } from './url-state';

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

  it('round-trips every group at once, not just one at a time', () => {
    const view: ViewState = {
      tab: 'health',
      q: 'draft',
      kinds: new Set(['machine']),
      origins: new Set(['system']),
      showInactive: true,
      healthKind: 'detached',
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
