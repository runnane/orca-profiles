/**
 * Comparing two presets.
 *
 * Two modes, and the distinction is the point:
 *
 *  - `raw`      compares what is written in each file. Answers "why does one
 *               file have 354 keys and the other 3?"
 *  - `effective` compares fully resolved settings. Answers "will these two
 *               actually print differently?" — which is nearly always the real
 *               question, and is invisible in the files themselves.
 *
 * Differences that are purely serialisation (`["70","70"]` vs `"70,70"`) are
 * reported in their own bucket. Folding them into "same" would hide a real
 * property of the file; folding them into "different" is the noise that makes
 * two identical presets look 12 keys apart.
 */

import { isSerialisationOnlyDifference, valuesEqual } from './normalize';
import { resolve } from './resolve';
import type { ConfigIndex } from './index-config';
import { isSettingKey } from './resolve';
import type { Preset, RawValue } from './types';

export type DiffStatus = 'changed' | 'only-a' | 'only-b' | 'cosmetic';

export interface DiffRow {
  key: string;
  status: DiffStatus;
  a?: RawValue;
  b?: RawValue;
  /** For an effective diff: which preset in each chain supplied the value. */
  aSource?: string;
  bSource?: string;
}

export interface DiffResult {
  rows: DiffRow[];
  /** Keys compared, including the ones that matched. */
  compared: number;
  /** Keys that matched exactly. */
  identical: number;
  /** Differences that are serialisation-only. */
  cosmetic: number;
}

function build(
  aMap: Map<string, { value: RawValue; source?: string }>,
  bMap: Map<string, { value: RawValue; source?: string }>,
): DiffResult {
  const keys = [...new Set([...aMap.keys(), ...bMap.keys()])].sort((x, y) => x.localeCompare(y, 'en'));
  const rows: DiffRow[] = [];
  let identical = 0;
  let cosmetic = 0;

  for (const key of keys) {
    const a = aMap.get(key);
    const b = bMap.get(key);

    if (a && !b) {
      rows.push({ key, status: 'only-a', a: a.value, aSource: a.source });
      continue;
    }
    if (b && !a) {
      rows.push({ key, status: 'only-b', b: b.value, bSource: b.source });
      continue;
    }
    if (!a || !b) continue;

    if (valuesEqual(a.value, b.value)) {
      if (isSerialisationOnlyDifference(a.value, b.value)) {
        cosmetic++;
        rows.push({
          key,
          status: 'cosmetic',
          a: a.value,
          b: b.value,
          aSource: a.source,
          bSource: b.source,
        });
      } else {
        identical++;
      }
      continue;
    }

    rows.push({ key, status: 'changed', a: a.value, b: b.value, aSource: a.source, bSource: b.source });
  }

  return { rows, compared: keys.length, identical, cosmetic };
}

/** Compare the bytes on disk. */
export function diffRaw(a: Preset, b: Preset): DiffResult {
  const toMap = (p: Preset) => {
    const m = new Map<string, { value: RawValue }>();
    for (const [k, v] of Object.entries(p.raw)) {
      if (isSettingKey(k)) m.set(k, { value: v });
    }
    return m;
  };
  return build(toMap(a), toMap(b));
}

/** Compare what the slicer would actually use. */
export function diffEffective(index: ConfigIndex, a: Preset, b: Preset): DiffResult {
  const toMap = (p: Preset) => {
    const m = new Map<string, { value: RawValue; source: string }>();
    for (const [k, s] of resolve(index, p).settings) {
      m.set(k, { value: s.value, source: s.sourceName });
    }
    return m;
  };
  return build(toMap(a), toMap(b));
}
