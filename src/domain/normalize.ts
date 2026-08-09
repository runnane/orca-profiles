/**
 * Value normalisation.
 *
 * The same setting is written two different ways depending on how the preset
 * was produced. A preset saved by the slicer stores vector options as JSON
 * arrays; one that has been round-tripped through an export, or hand-edited,
 * stores them as the serialised form the C++ config layer uses:
 *
 *   compatible_printers  ["Ender5", "M1.1"]        vs  '"Ender5";"M1.1"'
 *   wiping_volumes_...   ["70", "70"]              vs  '70,70'
 *   print_extruder_id    ["1"]                     vs  '1'
 *   post_process         []                        vs  ''
 *
 * Comparing those raw makes two identical presets look 12 keys apart, which is
 * exactly the confusion this app exists to remove. But over-normalising is the
 * worse failure: if we coerced every scalar into a list, genuinely different
 * values would compare equal and the app would tell you a difference is not
 * there. So scalars are only parsed as vectors when the other side *is* a
 * vector, and never otherwise.
 */

import type { RawValue } from './types';

/**
 * Split the `;`-separated form, honouring `"` quoting and `\` escapes.
 * This mirrors PrusaSlicer/OrcaSlicer's `ConfigOptionVectorBase::deserialize`
 * for string vectors, which quotes any item containing a separator, quote or
 * control character.
 */
export function parseQuotedList(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        // The file holds a literal backslash-n for an embedded newline.
        cur += next === 'n' ? '\n' : next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ';') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out;
}

/** Does this string look like a plain numeric vector (`70,70,70`)? */
function isNumericVector(s: string): boolean {
  return s.includes(',') && /^[\d\s.,eE+-]+$/.test(s);
}

/**
 * Parse a scalar into the vector it represents. Only called when the value is
 * being compared against a real array — see the module note.
 */
export function scalarAsList(s: string): string[] {
  if (s === '') return [];
  if (s.includes(';')) return parseQuotedList(s);
  if (isNumericVector(s)) return s.split(',').map((x) => x.trim());
  // A single quoted item, or a plain single value.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return parseQuotedList(s);
  }
  return [s];
}

/** Everything on disk compares as text; numbers appear only in hand-edited files. */
function asText(v: string | number): string {
  return typeof v === 'number' ? String(v) : v;
}

/** Compare two raw values, tolerating the two serialisation forms. */
export function valuesEqual(a: RawValue | undefined, b: RawValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;

  const aList = Array.isArray(a);
  const bList = Array.isArray(b);

  if (aList && bList) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }

  if (!aList && !bList) {
    return asText(a).trim() === asText(b).trim();
  }

  // Mixed: parse the scalar side as a vector and compare element-wise.
  const list = (aList ? a : b) as string[];
  const scalar = scalarAsList(asText((aList ? b : a) as string | number));
  if (list.length !== scalar.length) return false;
  return list.every((x, i) => x.trim() === scalar[i].trim());
}

/** A stable, human-readable rendering of a value for display and diffing. */
export function displayValue(v: RawValue | undefined): string {
  if (v === undefined) return '—';
  if (Array.isArray(v)) return v.length === 0 ? '(empty list)' : v.join(', ');
  return String(v);
}

/**
 * True when two values differ only in how they were serialised — same content,
 * different shape on disk. Surfaced separately so a diff can say "cosmetic"
 * instead of pretending nothing changed.
 */
export function isSerialisationOnlyDifference(a: RawValue | undefined, b: RawValue | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const sameShape = Array.isArray(a) === Array.isArray(b);
  return !sameShape && valuesEqual(a, b);
}
