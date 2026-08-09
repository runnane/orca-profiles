/**
 * The inheritance forest, drawn.
 *
 * The presets tab answers "what is in this one preset". The questions a whole
 * config raises are shape questions — which vendor base is carrying everything,
 * which of my presets are floating free, where a chain loops — and a list cannot
 * answer any of them.
 *
 * Design notes worth keeping, because each is a decision rather than a default:
 *
 *  - **Layered indented tree, hand-rolled in SVG.** Depth is small and the graph
 *    is a forest, so the layout is `depth × indent` across and one row per node
 *    down: no measurement, no layout pass, no graph library in the bundle. It also
 *    gives the accessible structure for free, because DFS row order *is* reading
 *    order.
 *  - **Colour carries origin, and never alone.** Two hues only — the app's
 *    existing `--inherited` (system) and `--own` (yours), which is the pairing the
 *    settings table already uses, and which clears CVD separation comfortably
 *    (ΔE 22-25 across protan/deutan/tritan). Every node also *says* which it is,
 *    so the hue is a second encoding rather than the only one.
 *  - **Status is reserved and labelled.** `never loaded` and `not installed` are
 *    the app's danger colour plus the words; a loop is the warn colour plus the
 *    word `loop`. No state is communicated by colour on its own.
 *  - **Edges are recessive**, at 1.5px in the border colour — they are the grid
 *    here, not the data. Only a broken or looping edge is coloured.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { buildGraph, type GraphEdge, type GraphNode } from '../domain/graph';
import type { ConfigIndex } from '../domain/index-config';
import type { PresetKind } from '../domain/types';

const KINDS: PresetKind[] = ['filament', 'process', 'machine'];

/** Row pitch and indent, in px. Fixed, so edge geometry needs no measurement. */
const ROW = 40;
const INDENT = 26;

const REASON_LABEL: Record<string, string> = {
  absent: 'no preset by that name is installed',
  'unloaded-profile': 'it exists only in a user folder the slicer does not load',
  'wrong-kind': 'the only preset with that name is of another type',
};

export function GraphView({
  index,
  onSelect,
}: {
  index: ConfigIndex;
  onSelect: (id: string) => void;
}) {
  const [kinds, setKinds] = useState<Set<PresetKind>>(new Set(KINDS));
  const [includeSystemOnly, setIncludeSystemOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const graph = useMemo(
    () =>
      buildGraph(index, {
        kinds: [...kinds],
        includeSystemOnly,
        includeInactive,
      }),
    [index, kinds, includeSystemOnly, includeInactive],
  );

  const rowOf = useMemo(() => new Map(graph.nodes.map((n, i) => [n.id, i])), [graph]);
  const edgeByChild = useMemo(
    () => new Map(graph.edges.map((e) => [e.childId, e])),
    [graph],
  );
  const maxDepth = graph.nodes.reduce((m, n) => Math.max(m, n.depth), 0);

  // Roving tabindex: one node is in the tab order and the arrows move it, which
  // is what makes a tree navigable without a mouse.
  const focusRow = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(i, Number.MAX_SAFE_INTEGER));
    setActive(clamped);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${clamped}"]`);
    el?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, i: number, node: GraphNode) => {
      const last = graph.nodes.length - 1;
      switch (e.key) {
        case 'ArrowDown':
          focusRow(Math.min(i + 1, last));
          break;
        case 'ArrowUp':
          focusRow(Math.max(i - 1, 0));
          break;
        case 'ArrowLeft': {
          const parent = node.parentId ? rowOf.get(node.parentId) : undefined;
          if (parent !== undefined) focusRow(parent);
          break;
        }
        case 'ArrowRight': {
          // The next row is a child exactly when it is one level deeper.
          if (graph.nodes[i + 1]?.depth === node.depth + 1) focusRow(i + 1);
          break;
        }
        case 'Home':
          focusRow(0);
          break;
        case 'End':
          focusRow(last);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [focusRow, graph.nodes, rowOf],
  );

  if (graph.nodes.length === 0) {
    return <div className="notice">Nothing to draw with these filters.</div>;
  }

  return (
    <div>
      <div className="chips" style={{ marginBottom: 8 }}>
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
      <div className="chips" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className="chip"
          aria-pressed={includeSystemOnly}
          onClick={() => setIncludeSystemOnly((v) => !v)}
          title="Vendor presets nothing of yours inherits from"
        >
          include vendor-only subtrees
          {graph.omitted.systemOnly > 0 && ` (${graph.omitted.systemOnly})`}
        </button>
        {index.inactiveProfiles.length > 0 && (
          <button
            type="button"
            className="chip"
            aria-pressed={includeInactive}
            onClick={() => setIncludeInactive((v) => !v)}
            title={`OrcaSlicer loads only user/${index.activeProfile}`}
          >
            include profiles the slicer ignores
          </button>
        )}
      </div>

      <p className="muted" style={{ margin: '0 0 10px' }}>
        {graph.nodes.length} preset{graph.nodes.length === 1 ? '' : 's'} in {graph.roots.length}{' '}
        tree{graph.roots.length === 1 ? '' : 's'}, {maxDepth + 1} deep. Edges point from a preset to
        the parent <strong>OrcaSlicer would load</strong> — where two files claim one name, that is
        the one that wins.
        {graph.omitted.snapshots > 0 && ` ${graph.omitted.snapshots} sync snapshots are never drawn.`}
      </p>

      <div className="graph-legend" aria-hidden="true">
        <span>
          <i className="swatch system" /> system
        </span>
        <span>
          <i className="swatch user" /> yours
        </span>
        <span>
          <i className="swatch danger" /> never loaded / unresolved
        </span>
        <span>
          <i className="swatch warn" /> loop
        </span>
      </div>

      <div className="graph" style={{ height: graph.nodes.length * ROW }}>
        <svg
          className="graph-edges"
          width={(maxDepth + 1) * INDENT + 40}
          height={graph.nodes.length * ROW}
          aria-hidden="true"
        >
          {graph.edges.map((e) => {
            const child = rowOf.get(e.childId);
            const parent = e.parentId ? rowOf.get(e.parentId) : undefined;
            if (child === undefined || parent === undefined) return null;
            const cd = graph.nodes[child].depth;
            const pd = graph.nodes[parent].depth;
            const x1 = pd * INDENT + 9;
            const y1 = parent * ROW + ROW / 2;
            const x2 = cd * INDENT + 3;
            const y2 = child * ROW + ROW / 2;
            return (
              <path
                key={`${e.childId}->${e.parentId}`}
                d={`M ${x1} ${y1} V ${y2} H ${x2}`}
                className={`edge${e.back ? ' back' : ''}${e.ambiguous ? ' ambiguous' : ''}`}
              />
            );
          })}
        </svg>

        <div className="graph-rows" role="tree" aria-label="Inheritance forest" ref={listRef}>
          {graph.nodes.map((n, i) => (
            <Row
              key={n.id}
              node={n}
              edge={edgeByChild.get(n.id)}
              row={i}
              tabbable={i === Math.min(active, graph.nodes.length - 1)}
              onKeyDown={(e) => onKeyDown(e, i, n)}
              onOpen={() => onSelect(n.id)}
              onFocus={() => setActive(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  node,
  edge,
  row,
  tabbable,
  onKeyDown,
  onOpen,
  onFocus,
}: {
  node: GraphNode;
  edge: GraphEdge | undefined;
  row: number;
  tabbable: boolean;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const where = node.origin === 'system' ? 'system' : node.scope === 'active' ? 'yours' : 'not loaded';
  const detached = node.origin === 'user' && !edge && node.stored > 40;
  const badges: { label: string; tone: 'danger' | 'warn' | 'plain' }[] = [];
  if (node.shadowed) badges.push({ label: 'never loaded', tone: 'danger' });
  if (edge && !edge.resolved) badges.push({ label: 'parent missing', tone: 'danger' });
  if (edge?.back) badges.push({ label: 'loop', tone: 'warn' });
  if (node.isCustomRoot) badges.push({ label: 'custom root', tone: 'plain' });
  if (detached) badges.push({ label: 'detached copy', tone: 'warn' });

  // Everything the visual encoding says, said in words too — this is what a screen
  // reader gets, and it is also the answer to "why is this node styled like that".
  const description = [
    node.name,
    node.kind,
    where,
    edge
      ? edge.resolved
        ? `inherits ${edge.name}`
        : `inherits ${edge.name}, which does not resolve: ${REASON_LABEL[edge.reason ?? ''] ?? 'unknown'}`
      : 'no parent',
    `${node.changed + node.novel} of ${node.settings} settings set here`,
    ...badges.map((b) => b.label),
  ].join(', ');

  return (
    <div
      role="treeitem"
      aria-level={node.depth + 1}
      aria-label={description}
      data-row={row}
      tabIndex={tabbable ? 0 : -1}
      className={`graph-node ${node.origin}${node.shadowed ? ' dead' : ''}`}
      style={{ top: row * ROW, left: node.depth * INDENT }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
          return;
        }
        onKeyDown(e);
      }}
      onClick={onOpen}
      onFocus={onFocus}
    >
      <span className="gname">{node.name}</span>
      <span className="gmeta">
        {node.kind} · {where}
        {edge && !edge.resolved && (
          <>
            {' · '}
            <span className="gbad">inherits “{edge.name}”</span>
          </>
        )}
        {node.depth === 0 && node.subtreeSize > 1 && ` · carries ${node.subtreeSize - 1}`}
        {` · ${node.changed + node.novel} of ${node.settings} set here`}
        {node.redundant > 0 && ` · ${node.redundant} redundant`}
      </span>
      {badges.map((b) => (
        <span key={b.label} className={`gbadge ${b.tone}`}>
          {b.label}
        </span>
      ))}
    </div>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
