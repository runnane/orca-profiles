/**
 * Pick a printer, see which filaments and processes it gets — and why.
 *
 * The two questions the slicer cannot answer are "why can't I pick this filament
 * for this printer" and "why is this one here when I never set it up for this
 * machine". `compatibilityFor` answers both; this file only presents it, and
 * deliberately re-derives no part of the rule — every verdict, reason and piece of
 * evidence on screen comes straight out of the domain layer.
 *
 * Three presentation decisions that carry weight:
 *
 *  - **`undetermined` is its own state, not a boolean with a footnote.** It gets
 *    its own word, its own status colour and the expression verbatim in monospace,
 *    because "this depends on a condition we do not evaluate: `<expr>`" is the
 *    answer, not an apology for the lack of one.
 *  - **The process gate is shown as a second relation.** A filament's
 *    `compatible_prints` is checked against the selected *process*, so it appears
 *    as a note under the printer verdict and only becomes part of the verdict once
 *    a process is chosen — which is exactly what the slicer does
 *    (`is_compatible &= is_compatible_with_print`, Preset.cpp:3364).
 *  - **`named-via-parent` is spelled out.** "Available because this printer
 *    inherits from X, which the filament names" is the most surprising sentence in
 *    the feature and the one that stops a bug report being filed.
 *
 * Colour follows the graph view's precedent: status only, from the reserved
 * palette, and **always with the word** — a verdict is never conveyed by colour
 * alone. Rows are ordinary buttons, so keyboard navigation and screen-reader
 * semantics come from the platform rather than from a widget.
 */

import { useMemo, useState } from 'react';
import {
  compatibilityFor,
  compatibilitySummary,
  type Compatibility,
  type CompatibilityReason,
} from '../domain/compatibility';
import type { ConfigIndex } from '../domain/index-config';
import type { Preset } from '../domain/types';
import { CodeText } from './CodeText';
import { plainText } from './text';

type Verdict = 'available' | 'excluded' | 'undetermined';

function verdictOf(c: Compatibility): Verdict {
  return c.included === true ? 'available' : c.included === false ? 'excluded' : 'undetermined';
}

const VERDICT_LABEL: Record<Verdict, string> = {
  available: 'available',
  excluded: 'excluded',
  undetermined: 'undetermined',
};

/**
 * One sentence per reason, in the second person and naming the key that decided
 * it. `condition` is deliberately absent: its wording depends on the verdict, so
 * it is built in `explain` where both are in hand.
 */
const REASON_TEXT: Record<Exclude<CompatibilityReason, 'condition'>, string> = {
  'compatible-with-everything':
    'It names no printers at all, so OrcaSlicer offers it for every one of them.',
  'named-explicitly': 'This printer is named directly in its `compatible_printers`.',
  'named-via-parent': '',
  excluded: 'Its `compatible_printers` names other printers, and not this one.',
  'excluded-by-library':
    'This is a filament-library preset, and a vendor ships its own version of the same alias for this printer — so the library one is not offered here.',
  'never-loaded':
    'Another file claimed this name first, so OrcaSlicer never loads this one at all.',
};

function explain(c: Compatibility, machine: Preset): string {
  if (c.reason === 'condition') {
    if (c.included === 'undetermined') {
      return 'It has no `compatible_printers` list, so a condition decides — and this one is outside the subset this app evaluates. The expression is below, verbatim.';
    }
    return c.included
      ? `It has no \`compatible_printers\` list, so a condition decides, and it is true for ${machine.name}.`
      : `It has no \`compatible_printers\` list, so a condition decides, and it is false for ${machine.name}.`;
  }
  if (c.reason === 'named-via-parent') {
    // The surprising one, said out loud.
    return `Its \`compatible_printers\` does not name ${machine.name} — it names “${c.evidence.value}”, which ${machine.name} inherits from. OrcaSlicer treats that as a match, so the preset is offered here.`;
  }
  return REASON_TEXT[c.reason] || `Decided by \`${c.evidence.key}\`.`;
}

export function PrinterView({
  index,
  machineId,
  onPickMachine,
  onSelect,
}: {
  index: ConfigIndex;
  machineId: string;
  onPickMachine: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const [processId, setProcessId] = useState('');
  const [only, setOnly] = useState<Verdict | 'all'>('all');

  const machines = useMemo(
    () =>
      index.active
        .filter((p) => p.kind === 'machine')
        .sort(
          (a, b) =>
            Number(a.origin === 'system') - Number(b.origin === 'system') ||
            a.name.localeCompare(b.name, 'en'),
        ),
    [index],
  );

  const machine = machineId ? index.byId.get(machineId) : undefined;
  const process = processId ? index.byId.get(processId) : undefined;

  const result = useMemo(
    () => (machine ? compatibilityFor(index, machine, process ? { process } : {}) : undefined),
    [index, machine, process],
  );

  if (machines.length === 0) {
    return <div className="notice">This config has no printer presets to explain.</div>;
  }

  return (
    <div>
      <div className="compare-pickers">
        <div>
          {/* A real label, associated with the control: the select is the only way
              into this view, and a floating div above it is not a label. */}
          <label className="label-section" htmlFor="printer-pick" style={{ display: 'block', marginBottom: 4 }}>
            Printer
          </label>
          <select id="printer-pick" value={machineId} onChange={(e) => onPickMachine(e.target.value)}>
            <option value="">Choose a printer…</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.origin}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label-section" htmlFor="process-pick" style={{ display: 'block', marginBottom: 4 }}>
            Scoped to process (optional)
          </label>
          <select id="process-pick" value={processId} onChange={(e) => setProcessId(e.target.value)}>
            <option value="">Printer only — ignore the process gate</option>
            {result?.processes
              .filter((c) => c.included === true)
              .map((c) => (
                <option key={c.preset.id} value={c.preset.id}>
                  {c.preset.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      {!machine || !result ? (
        <div className="notice">
          <strong>Pick a printer.</strong> Selecting one in OrcaSlicer silently rewrites the filament
          and process lists and never says on what grounds. This says.
        </div>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            What <strong>{machine.name}</strong> gets.
            {process ? (
              <>
                {' '}
                Filaments are scoped to <strong>{process.name}</strong>: a filament&rsquo;s{' '}
                <code>compatible_prints</code> is a second gate, checked against the process, and
                OrcaSlicer requires both.
              </>
            ) : (
              <>
                {' '}
                Filament verdicts cover the <strong>printer</strong> only. A{' '}
                <code>compatible_prints</code> gate is shown as a note; choose a process above to
                fold it in.
              </>
            )}
          </p>

          <div className="chips" style={{ marginBottom: 12 }}>
            {(['all', 'available', 'excluded', 'undetermined'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="chip"
                aria-pressed={only === v}
                onClick={() => setOnly(v)}
              >
                {v === 'all' ? 'all' : VERDICT_LABEL[v]}
              </button>
            ))}
          </div>

          <Section
            title="Filaments"
            list={result.filaments}
            only={only}
            machine={machine}
            onSelect={onSelect}
          />
          <Section
            title="Processes"
            list={result.processes}
            only={only}
            machine={machine}
            onSelect={onSelect}
          />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  list,
  only,
  machine,
  onSelect,
}: {
  title: string;
  list: Compatibility[];
  only: Verdict | 'all';
  machine: Preset;
  onSelect: (id: string) => void;
}) {
  const s = compatibilitySummary(list);
  const visible = only === 'all' ? list : list.filter((c) => verdictOf(c) === only);

  return (
    <section className="block">
      <h3>
        {title}
        <span className="count">
          {s.yes} available · {s.no} excluded
          {s.undetermined > 0 && ` · ${s.undetermined} undetermined`}
        </span>
      </h3>
      {visible.length === 0 ? (
        <p className="faint" style={{ margin: '4px 0 0' }}>
          Nothing in this group.
        </p>
      ) : (
        <div className="compat-list">
          {visible.map((c) => (
            <Row key={c.preset.id} c={c} machine={machine} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
}

function Row({
  c,
  machine,
  onSelect,
}: {
  c: Compatibility;
  machine: Preset;
  onSelect: (id: string) => void;
}) {
  const verdict = verdictOf(c);
  const gate = c.processGate;

  return (
    <button
      type="button"
      className={`compat-row ${verdict}`}
      onClick={() => onSelect(c.preset.id)}
      // Everything the colour says is in here as words, which is what a screen
      // reader gets and what makes the colour a second encoding rather than the
      // only one.
      aria-label={`${c.preset.name}: ${VERDICT_LABEL[verdict]}. ${plainText(explain(c, machine))}`}
    >
      <span className="compat-head">
        <span className={`verdict ${verdict}`}>
          <i className="dot" aria-hidden="true" />
          {VERDICT_LABEL[verdict]}
        </span>
        <span className="cname">{c.preset.name}</span>
        <span className="faint">{c.preset.origin}</span>
        {c.isPrinterDefault && (
          <span className="gbadge" title="Named by this printer's default_* keys">
            printer default
          </span>
        )}
      </span>
      <span className="compat-why">
        <CodeText text={explain(c, machine)} />
      </span>
      {c.reason === 'condition' && (
        <span className="compat-expr mono">{c.evidence.value}</span>
      )}
      {gate && (
        <span className="compat-gate">
          {gate.names.length > 0 ? (
            <>
              Second gate — <code>compatible_prints</code> accepts{' '}
              {gate.names.map((n) => `“${n}”`).join(', ')}
              {gate.passes === undefined
                ? '. Choose a process above to include it.'
                : gate.passes
                  ? '. The selected process is one of them.'
                  : '. The selected process is not one of them, so this filament is not offered.'}
            </>
          ) : (
            <>
              Second gate — <code>compatible_prints_condition</code> decides against the process:{' '}
              <span className="mono">{gate.condition}</span>
              {gate.passes === 'undetermined' && ' (outside the subset this app evaluates)'}
            </>
          )}
        </span>
      )}
    </button>
  );
}
