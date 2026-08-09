/**
 * The findings list.
 *
 * Each finding names the presets it is about and links straight to them, so a
 * report is a place to act from rather than a wall of text. Severity is stated
 * in words as well as colour.
 */

import { useMemo, useState } from 'react';
import { analyze, type Finding, type FindingSeverity } from '../domain/analyze';
import type { ConfigIndex } from '../domain/index-config';

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
};

const KIND_LABEL: Record<Finding['kind'], string> = {
  detached: 'Detached copies',
  'redundant-overrides': 'Redundant overrides',
  'near-duplicate': 'Near-duplicates',
  'broken-parent': 'Missing parents',
  'circular-inherits': 'Inheritance loops',
  'orphaned-printer': 'Missing printers',
  'missing-reference': 'Dangling references',
  'duplicate-name': 'Files never loaded',
  'parse-error': 'Unreadable files',
};

export function HealthReport({
  index,
  onSelect,
  onCompare,
}: {
  index: ConfigIndex;
  onSelect: (id: string) => void;
  onCompare: (a: string, b: string) => void;
}) {
  const findings = useMemo(() => analyze(index), [index]);
  const [kindFilter, setKindFilter] = useState<Finding['kind'] | 'all'>('all');

  const kinds = useMemo(() => {
    const counts = new Map<Finding['kind'], number>();
    for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [findings]);

  const visible = kindFilter === 'all' ? findings : findings.filter((f) => f.kind === kindFilter);

  if (findings.length === 0) {
    return (
      <div className="notice">
        <strong>Nothing to flag.</strong> No detached copies, duplicate names, broken parents or
        redundant overrides in this config.
      </div>
    );
  }

  return (
    <div>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="chip"
          aria-pressed={kindFilter === 'all'}
          onClick={() => setKindFilter('all')}
        >
          All {findings.length}
        </button>
        {kinds.map(([k, n]) => (
          <button
            key={k}
            type="button"
            className="chip"
            aria-pressed={kindFilter === k}
            onClick={() => setKindFilter(k)}
          >
            {KIND_LABEL[k]} {n}
          </button>
        ))}
      </div>

      {visible.map((f) => {
        const presets = f.presetIds.map((id) => index.byId.get(id)).filter((p) => p !== undefined);
        return (
          <div key={f.id} className={`finding ${f.severity}`}>
            <div className="ftitle">
              <span className="fsev">{SEVERITY_LABEL[f.severity]}</span>
              {f.title}
            </div>
            <div className="fdetail">{f.detail}</div>
            {/* A finding about the vendor index names files rather than presets;
                without this it would have nothing to act on. */}
            {presets.length === 0 && f.paths && f.paths.length > 0 && (
              <div className="fdetail mono faint">{f.paths.join(' · ')}</div>
            )}
            <div className="factions">
              {presets.slice(0, 4).map((p) => (
                <button key={p.id} type="button" className="chip" onClick={() => onSelect(p.id)}>
                  Open {p.name}
                </button>
              ))}
              {presets.length >= 2 && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => onCompare(presets[0].id, presets[1].id)}
                >
                  Compare the two
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
