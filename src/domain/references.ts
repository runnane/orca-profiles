/**
 * Every place a preset names another preset.
 *
 * `inherits` is the famous one, but it is one of five. Each of the others is
 * resolved by name just as silently, and each fails differently when the name is
 * gone — so they are enumerated here once, and both the health report and the
 * graph read them from the same place rather than each knowing its own subset.
 *
 * The keys, and what the slicer does with them:
 *
 *  - `inherits` — the parent, resolved inside one `PresetCollection`
 *    (`find_preset2`, v2.4.2 Preset.cpp:3229). Same type only.
 *  - `compatible_printers` on a filament or process — the machines it may be
 *    used with. A **non-empty** list that does not name the active printer
 *    excludes the preset (`is_compatible_with_printer`, Preset.cpp:809-841).
 *  - `compatible_prints` on a filament — the same relation against process
 *    presets (`is_compatible_with_print`, Preset.cpp:771-791). Filaments only:
 *    processes are updated with no active print at all
 *    (`prints.update_compatible(printer, nullptr, …)`, PresetBundle.cpp:5421,
 *    against `filaments.update_compatible(printer, &print, …)` on :5439), so a
 *    `compatible_prints` on a process is never consulted.
 *  - `default_print_profile` / `default_filament_profile` on a machine — what
 *    gets selected when that printer is chosen (PresetBundle.cpp:2142-2166).
 *    `default_print_profile` is a single name; `default_filament_profile` is a
 *    list, and only its first entry is ever used at that call site.
 *
 * The conditions (`compatible_printers_condition`,
 * `compatible_prints_condition`) are **not** reference keys: they are
 * PlaceholderParser expressions over the printer's config, not name lists, and
 * are only consulted at all when the corresponding list is empty
 * (`if (! has_compatible_printers && ! condition.empty())`, Preset.cpp:825).
 * Reading one as a name would invent a dangling reference out of a working
 * config, so `referenceNames` never touches them.
 */

import { parseQuotedList } from './normalize';
import type { Preset, PresetKind, RawPreset, RawValue } from './types';

/** A single name in a single key, and the kind of preset it has to resolve to. */
export interface PresetReference {
  key: string;
  name: string;
  targetKind: PresetKind;
  /** Which position in a list-valued key this came from; 0 for scalar keys. */
  index: number;
}

/**
 * The names in one key, in either serialisation.
 *
 * A preset saved by the slicer writes a vector as a JSON array; one that has
 * been round-tripped through an export or hand-edited writes the `'"A";"B"'`
 * form. The array-only reading this replaced skipped the second form entirely,
 * so a hand-edited `compatible_printers` was never checked at all.
 *
 * An empty value yields no names, which is the meaningful case rather than an
 * edge case: an empty `compatible_printers` means "every printer", not "no
 * printer" (`has_compatible_printers`, Preset.cpp:826).
 */
export function referenceNames(raw: RawPreset, key: string): string[] {
  const v: RawValue | undefined = raw[key];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x !== '');
  const text = String(v).trim();
  if (text === '') return [];
  // A scalar here is either the serialised vector form or a single name. Both
  // parse the same way; `parseQuotedList` returns the one name unchanged.
  return parseQuotedList(text)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

/** The reference-bearing keys for a preset of this kind, and what they point at. */
function referenceKeys(kind: PresetKind): { key: string; targetKind: PresetKind }[] {
  switch (kind) {
    case 'filament':
      return [
        { key: 'compatible_printers', targetKind: 'machine' },
        { key: 'compatible_prints', targetKind: 'process' },
      ];
    case 'process':
      // A process is gated by printers, but never by other processes.
      return [{ key: 'compatible_printers', targetKind: 'machine' }];
    case 'machine':
      return [
        { key: 'default_print_profile', targetKind: 'process' },
        { key: 'default_filament_profile', targetKind: 'filament' },
      ];
  }
}

/**
 * Every name this preset refers to, `inherits` included.
 *
 * Only what the preset states itself: an inherited `compatible_printers` belongs
 * to the ancestor that wrote it, and reporting it here would blame the same
 * dangling name on every descendant.
 */
export function presetReferences(preset: Preset): PresetReference[] {
  const out: PresetReference[] = [];
  if (preset.inherits) {
    out.push({ key: 'inherits', name: preset.inherits, targetKind: preset.kind, index: 0 });
  }
  for (const { key, targetKind } of referenceKeys(preset.kind)) {
    referenceNames(preset.raw, key).forEach((name, index) => {
      out.push({ key, name, targetKind, index });
    });
  }
  return out;
}
