/**
 * Inheritance resolution — the answer to "where did this value come from?".
 *
 * Walk `inherits` upwards collecting presets, then apply them from the base
 * down so nearer presets win. Every resolved setting remembers which preset
 * supplied it and what it shadowed, because that provenance *is* the feature:
 * the slicer shows a resolved number with no way to tell whether you set it,
 * the vendor set it, or it fell out of `fdm_process_common`.
 *
 * A malformed config must never hang the UI, so the walk defends against both
 * a missing parent and a cycle rather than assuming the files are sane.
 */

import { lookupParent, type ConfigIndex } from './index-config';
import { valuesEqual } from './normalize';
import { META_KEYS, type Preset, type RawValue, type Resolution, type ResolvedSetting } from './types';

const MAX_DEPTH = 32;

/** The chain from `preset` up to its root, nearest first. */
export function inheritanceChain(
  index: ConfigIndex,
  preset: Preset,
): { chain: Preset[]; missingParent?: string; circular: boolean } {
  const chain: Preset[] = [preset];
  const seen = new Set<string>([preset.id]);
  let current = preset;
  let missingParent: string | undefined;
  let circular = false;

  while (current.inherits && chain.length < MAX_DEPTH) {
    const parent = lookupParent(index, current.inherits, current);
    if (!parent) {
      missingParent = current.inherits;
      break;
    }
    if (seen.has(parent.id)) {
      circular = true;
      break;
    }
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }

  return { chain, missingParent, circular };
}

/** Is this key a print setting rather than bookkeeping? */
export function isSettingKey(key: string): boolean {
  return !META_KEYS.has(key);
}

/** One key's value, and which preset in the chain actually stated it. */
export interface ChainValue {
  value: RawValue;
  /** The preset that states the key: the preset itself, or an ancestor. */
  source: Preset;
  /** True when an ancestor supplied it — the file you would open to change it. */
  inherited: boolean;
}

/**
 * A reader for a single preset's *effective* keys, without resolving all of them.
 *
 * This exists because a preset file is not what the slicer reads. The loader
 * starts from the parent's config and applies the file's own keys on top —
 * `preset.config = inherit_preset->config;` then
 * `update_diff_values_to_child_config(config, …)` (v2.4.2 Preset.cpp:1679-1684) —
 * so a key absent from the file is not absent from the preset. Anything that asks
 * "does this preset have `compatible_printers`" and looks at the file gets the
 * wrong answer for every user preset that was saved from a vendor one, which is
 * most of them.
 *
 * `resolve()` answers the same question and builds a ~350-key map with full
 * shadowing provenance to do it. That is right for a settings table and far too
 * much for five keys across a few thousand presets on every printer selection, so
 * this walks the chain once and reads keys off it.
 *
 * **"States the key" means the key is present, not that it is non-empty.** A
 * child holding `compatible_printers: []` over a parent that names printers is
 * compatible with everything: the child's key is applied, and an empty vector is
 * a value. Testing for truthiness here would silently fall through to the parent
 * and invert that.
 */
export function chainLookup(
  index: ConfigIndex,
  preset: Preset,
): (key: string) => ChainValue | undefined {
  const { chain } = inheritanceChain(index, preset);
  return (key: string) => {
    for (const p of chain) {
      if (!Object.hasOwn(p.raw, key)) continue;
      const value = p.raw[key];
      if (value === undefined) continue;
      return { value, source: p, inherited: p.id !== preset.id };
    }
    return undefined;
  };
}

/** Resolve every effective setting, with provenance. */
export function resolve(index: ConfigIndex, preset: Preset): Resolution {
  const { chain, missingParent, circular } = inheritanceChain(index, preset);
  const settings = new Map<string, ResolvedSetting>();

  // Base first, so nearer presets overwrite and we can record what they shadow.
  for (let depth = chain.length - 1; depth >= 0; depth--) {
    const source = chain[depth];
    for (const [key, value] of Object.entries(source.raw)) {
      if (!isSettingKey(key)) continue;
      const existing = settings.get(key);
      if (existing) {
        // Same value re-stated further down is a redundant override, not a
        // change; keep the ancestor as the source so provenance stays honest.
        if (valuesEqual(existing.value, value)) {
          settings.set(key, { ...existing, redundantAt: [...(existing.redundantAt ?? []), source.name] });
          continue;
        }
        settings.set(key, {
          key,
          value: value as RawValue,
          sourceId: source.id,
          sourceName: source.name,
          depth,
          shadowed: [{ sourceName: existing.sourceName, value: existing.value }, ...existing.shadowed],
          redundantAt: existing.redundantAt,
        });
      } else {
        settings.set(key, {
          key,
          value: value as RawValue,
          sourceId: source.id,
          sourceName: source.name,
          depth,
          shadowed: [],
        });
      }
    }
  }

  return { preset, chain, settings, missingParent, circular };
}

/** Settings the preset itself sets, split by whether they actually change anything. */
export interface OwnOverrides {
  /** Set here and different from what would have been inherited. */
  effective: ResolvedSetting[];
  /** Set here to the value it already had — noise that hides the real edits. */
  redundant: { key: string; value: RawValue; inheritedFrom: string }[];
  /** Set here with no ancestor defining it at all. */
  novel: ResolvedSetting[];
}

export function ownOverrides(index: ConfigIndex, preset: Preset): OwnOverrides {
  const { chain } = inheritanceChain(index, preset);
  const ancestors = chain.slice(1);

  const effective: ResolvedSetting[] = [];
  const redundant: { key: string; value: RawValue; inheritedFrom: string }[] = [];
  const novel: ResolvedSetting[] = [];

  for (const [key, value] of Object.entries(preset.raw)) {
    if (!isSettingKey(key)) continue;

    // Nearest ancestor that defines this key.
    let inheritedFrom: Preset | undefined;
    let inheritedValue: RawValue | undefined;
    for (const a of ancestors) {
      if (key in a.raw) {
        inheritedFrom = a;
        inheritedValue = a.raw[key];
        break;
      }
    }

    const entry: ResolvedSetting = {
      key,
      value: value as RawValue,
      sourceId: preset.id,
      sourceName: preset.name,
      depth: 0,
      shadowed: inheritedFrom ? [{ sourceName: inheritedFrom.name, value: inheritedValue as RawValue }] : [],
    };

    if (!inheritedFrom) novel.push(entry);
    else if (valuesEqual(inheritedValue, value as RawValue))
      redundant.push({ key, value: value as RawValue, inheritedFrom: inheritedFrom.name });
    else effective.push(entry);
  }

  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key, 'en');
  effective.sort(byKey);
  redundant.sort(byKey);
  novel.sort(byKey);
  return { effective, redundant, novel };
}
