/**
 * The inheritance forest.
 *
 * `resolve()` answers "where did this value come from?" for one preset. That is
 * the wrong shape for the questions a whole config raises, which are all shape
 * questions and none of which a list of chains can answer:
 *
 *  - which vendor base is carrying most of my presets, and what breaks if it
 *    changes
 *  - which of my presets are floating free (the detached full copies) rather
 *    than rooted in a vendor preset
 *  - where a chain is unexpectedly deep, or loops
 *  - which subtree is dead — shadowed by a name clash, or under a profile the
 *    slicer does not load
 *
 * So: nodes and edges, no layout, no React, no I/O. The view decides how to draw
 * it; this decides what is true about it.
 *
 * Two things this module refuses to do, both for the same reason — a diagram that
 * is subtly wrong is worse than no diagram:
 *
 *  1. **It never matches names itself.** Every edge comes from `lookupParent`, so
 *     the edge drawn is the one the *slicer* would follow. Where several files
 *     claim one name that distinction is the whole point: the winner is decided
 *     by load order (Preset.cpp:1583, :1619), and an edge drawn to a loser shows
 *     a chain that does not exist.
 *  2. **It draws a cycle rather than following one.** `inheritanceChain` detects
 *     a loop and stops; a graph that stopped the same way would silently omit the
 *     edge that *is* the fault. The closing edge is emitted and marked `back`.
 */

import { lookupParent, shadowedIds, type ConfigIndex } from './index-config';
import { inheritanceChain, isSettingKey, ownOverrides, resolve } from './resolve';
import type { Preset, PresetKind, PresetOrigin, PresetScope } from './types';

/**
 * Why an `inherits` name did not resolve, as far as this module can tell.
 *
 * ORCA-2 introduces `classifyReference`, which decides this once for every kind
 * of preset reference and with the slicer's own rules cited. Until that lands the
 * three cases worth distinguishing are computed here; when it does, this function
 * goes and the field is filled from the classifier instead. Keep the two in
 * agreement in the meantime — a reason is only useful if it is right.
 */
export type EdgeReason = 'absent' | 'unloaded-profile' | 'wrong-kind';

function unresolvedReason(index: ConfigIndex, from: Preset, name: string): EdgeReason {
  // `byName` already excludes `_local/` snapshots: the slicer never loads them,
  // so one claiming a name does not make the name exist.
  const claimed = (index.byName.get(name) ?? []).filter((c) => c.id !== from.id);
  if (claimed.length === 0) return 'absent';
  if (!claimed.some((c) => c.kind === from.kind)) return 'wrong-kind';
  return 'unloaded-profile';
}

export interface GraphNode {
  /** The preset's id, which is its path. */
  id: string;
  name: string;
  kind: PresetKind;
  origin: PresetOrigin;
  scope: PresetScope;
  /** Saved detached into `<kind>/base/` — a custom root others can inherit. */
  isCustomRoot: boolean;
  /** Keys stored in the file, metadata included. */
  stored: number;
  /** Own overrides that change an inherited value. */
  changed: number;
  /** Keys it sets that no ancestor defines at all. */
  novel: number;
  /** Keys it re-states with the value it already had — noise, not edits. */
  redundant: number;
  /** Settings in effect once the chain is resolved. */
  settings: number;
  /** Lost a name clash, so the slicer never loads it. Its subtree is dead. */
  shadowed: boolean;
  /** Distance from this node's root; 0 for a root. */
  depth: number;
  /** The root of this node's tree — the vendor base, or itself when detached. */
  rootId: string;
  /** The parent the slicer would use, when there is one. */
  parentId?: string;
  /** Descendants, root included, so a root can say what it carries. */
  subtreeSize: number;
}

export interface GraphEdge {
  childId: string;
  /** Absent when the name does not resolve. */
  parentId?: string;
  /** The `inherits` value verbatim, which is what a fix has to change. */
  name: string;
  /** Whether the slicer would find a parent for this name at all. */
  resolved: boolean;
  /** Set when `resolved` is false. */
  reason?: EdgeReason;
  /** This edge closes a loop: its parent is already below it in the chain. */
  back: boolean;
  /**
   * Several loaded files claim the parent's name, so the edge points at the one
   * load order picks and the others are dead files.
   */
  ambiguous: boolean;
}

export interface InheritanceGraph {
  /** Depth-first from each root, so tab order and row order follow the tree. */
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node ids with no parent, in the order their subtrees appear in `nodes`. */
  roots: string[];
  /** Presets left out by the current scope, so the UI can offer them honestly. */
  omitted: { systemOnly: number; inactive: number; snapshots: number };
}

export interface GraphOptions {
  /**
   * Include system presets that no user preset inherits from. Off by default: a
   * real config is a user folder plus a few thousand vendor presets, and a
   * diagram nobody can read is the same failure as the 359-key file.
   */
  includeSystemOnly?: boolean;
  /** Include user folders the slicer does not load. Off by default, as elsewhere. */
  includeInactive?: boolean;
  kinds?: PresetKind[];
}

export function buildGraph(index: ConfigIndex, opts: GraphOptions = {}): InheritanceGraph {
  const kinds = new Set<PresetKind>(opts.kinds ?? ['filament', 'process', 'machine']);
  const pool = opts.includeInactive
    ? index.presets.filter((p) => p.scope !== 'snapshot')
    : index.active;

  // Start from the presets you actually edit, then pull in whatever they inherit
  // from. That keeps the vendor scaffolding that matters and drops the rest.
  const included = new Map<string, Preset>();
  const seeds = pool.filter((p) => kinds.has(p.kind) && (opts.includeSystemOnly || p.origin === 'user'));
  for (const seed of seeds) {
    for (const p of inheritanceChain(index, seed).chain) included.set(p.id, p);
  }
  // An ancestor of the wrong kind cannot happen, but an ancestor in another
  // profile can be reached only through a preset we already included, so no
  // second filter is needed here.

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const dead = shadowedIds(index);
  const childrenOf = new Map<string, string[]>();

  for (const p of included.values()) {
    const parent = p.inherits ? lookupParent(index, p.inherits, p) : undefined;
    const parentIncluded = parent && included.has(parent.id) ? parent : undefined;
    const o = p.inherits ? ownOverrides(index, p) : undefined;
    nodes.set(p.id, {
      id: p.id,
      name: p.name,
      kind: p.kind,
      origin: p.origin,
      scope: p.scope,
      isCustomRoot: p.isCustomRoot,
      stored: Object.keys(p.raw).length,
      changed: o?.effective.length ?? 0,
      // A preset with no parent has no inherited value to change, so everything
      // it stores is novel — counting it as "0 overrides" read as "sets nothing".
      novel: o ? o.novel.length : Object.keys(p.raw).filter(isSettingKey).length,
      redundant: o?.redundant.length ?? 0,
      settings: resolve(index, p).settings.size,
      shadowed: dead.has(p.id),
      depth: 0,
      rootId: p.id,
      parentId: parentIncluded?.id,
      subtreeSize: 1,
    });

    if (p.inherits) {
      const claimants = (index.byName.get(p.inherits) ?? []).filter(
        (c) => c.id !== p.id && c.kind === p.kind && (c.origin === 'system' || c.profile === p.profile),
      );
      edges.push({
        childId: p.id,
        parentId: parentIncluded?.id,
        name: p.inherits,
        resolved: parent !== undefined,
        reason: parent ? undefined : unresolvedReason(index, p, p.inherits),
        // Part of a loop: following parents from the parent comes back to this
        // child. In a two-preset loop that marks both edges, which is the honest
        // answer — the loop *is* both of them, and neither is the culprit.
        back: parent !== undefined && reachesUp(index, parent, p),
        ambiguous: claimants.length > 1,
      });
      if (parentIncluded) {
        childrenOf.set(parentIncluded.id, [...(childrenOf.get(parentIncluded.id) ?? []), p.id]);
      }
    }
  }

  // Roots: no parent inside the graph. A preset whose parent is missing is a root
  // of the drawing without being a root of the config, which the edge says.
  const roots = [...nodes.values()]
    .filter((n) => !n.parentId)
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind, 'en') ||
        Number(a.origin === 'user') - Number(b.origin === 'user') ||
        a.name.localeCompare(b.name, 'en'),
    )
    .map((n) => n.id);

  // Depth-first ordering, with a visited set so a cycle cannot make this walk
  // forever — the back edge is already recorded above.
  const ordered: GraphNode[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number, rootId: string) => {
    // Already placed: it belongs to whatever reached it first, and counting it
    // again would tell a root it carries a preset it does not.
    if (visited.has(id)) return 0;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) return 0;
    node.depth = depth;
    node.rootId = rootId;
    ordered.push(node);
    let size = 1;
    const kids = (childrenOf.get(id) ?? []).sort((a, b) =>
      (nodes.get(a)?.name ?? '').localeCompare(nodes.get(b)?.name ?? '', 'en'),
    );
    for (const kid of kids) size += walk(kid, depth + 1, rootId);
    node.subtreeSize = size;
    return size;
  };
  for (const root of roots) walk(root, 0, root);
  // A loop has no root at all, so nothing above reaches it — and dropping those
  // presets would hide exactly the fault the graph exists to show. One member is
  // used as the drawing's anchor; which one is arbitrary, so it is chosen by path
  // to stay deterministic rather than to imply anything.
  for (const node of [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    if (visited.has(node.id)) continue;
    walk(node.id, 0, node.id);
    roots.push(node.id);
  }

  const systemOnlyCount = index.active.filter(
    (p) => p.origin === 'system' && !included.has(p.id),
  ).length;

  return {
    nodes: ordered,
    edges,
    roots,
    omitted: {
      systemOnly: systemOnlyCount,
      inactive: index.presets.filter((p) => p.scope === 'inactive-profile' && !included.has(p.id))
        .length,
      snapshots: index.presets.filter((p) => p.scope === 'snapshot').length,
    },
  };
}

/** Is `to` reached by following `from`'s resolved parents upwards? */
function reachesUp(index: ConfigIndex, from: Preset, to: Preset): boolean {
  const seen = new Set<string>([from.id]);
  let current: Preset | undefined = from;
  if (from.id === to.id) return true;
  while (current?.inherits) {
    const next: Preset | undefined = lookupParent(index, current.inherits, current);
    if (!next || seen.has(next.id)) return false;
    if (next.id === to.id) return true;
    seen.add(next.id);
    current = next;
  }
  return false;
}
