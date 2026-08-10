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
 *  - **"not installed" is its own verdict, above the compatibility one.** It is a
 *    different gate with a different fix — Add/Remove filament, not
 *    `compatible_printers` — so a row says which of the two stopped it, and shows
 *    the compatibility verdict underneath as the answer to "and if I did install
 *    it?".
 *
 * Colour follows the graph view's precedent: status only, from the reserved
 * palette, and **always with the word** — a verdict is never conveyed by colour
 * alone. "Not installed" takes no status colour at all, because absence is
 * neither a fault nor a warning. Rows are ordinary buttons, so keyboard
 * navigation and screen-reader semantics come from the platform rather than from
 * a widget.
 */

import { useMemo, useState } from 'react';
import {
  compatibilityFor,
  compatibilitySummary,
  offering,
  visibilityIndex,
  type Compatibility,
  type CompatibilityReason,
  type Offering,
  type VisibilityReason,
} from '../domain/compatibility';
import type { ConfigIndex } from '../domain/index-config';
import type { Preset } from '../domain/types';
import { CodeText } from './CodeText';
import { plainText } from './text';

const VERDICT_LABEL: Record<Offering, string> = {
  available: 'available',
  excluded: 'excluded',
  undetermined: 'undetermined',
  'not-installed': 'not installed',
};

/**
 * Why a preset is not installed, in the second person. Only the reasons that can
 * reach a row are here: the visible ones never produce a verdict of their own, so
 * they are explained as a note beside the compatibility sentence instead.
 */
const NOT_INSTALLED_TEXT: Partial<Record<VisibilityReason, string>> = {
  'not-installed':
    'You have not added this filament in OrcaSlicer, so it is not in the list at all — whatever its `compatible_printers` says. “Add/Remove filament” is what changes this.',
  'variant-not-installed':
    'This printer model and nozzle are not among the ones you added, so OrcaSlicer does not offer this printer either.',
};

/** The note under an *installed* row, when something other than the user installed it. */
const INSTALLED_NOTE: Partial<Record<VisibilityReason, string>> = {
  'installed-under-old-name':
    'Installed under an earlier name of this preset, which its `renamed_from` still claims.',
  'installed-as-default':
    'Installed by OrcaSlicer rather than by you: this printer model lists it in `default_materials`, and a printer is never left with no filament at all.',
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

/**
 * The sentence a row leads with: the gate that actually stopped it. `offering`
 * decides which that is, so the wording can never disagree with the verdict word
 * beside it.
 */
function explain(c: Compatibility, machine: Preset): string {
  if (offering(c) === 'not-installed') {
    return (
      NOT_INSTALLED_TEXT[c.visibility.reason] ??
      `Not installed, decided by \`${c.visibility.evidence.key}\`.`
    );
  }
  return explainCompatibility(c, machine);
}

function explainCompatibility(c: Compatibility, machine: Preset): string {
  return `${compatibilitySentence(c, machine)}${inherited(c.evidence.from, c.evidence.key)}`;
}

/**
 * Where the deciding key actually lives, when it is not in this preset's file.
 *
 * A user preset saved from a vendor one stores its overrides and nothing else, so
 * the gate that decided its verdict is usually in a file the user has never
 * opened. Saying "its `compatible_printers` names other printers" without saying
 * *whose* is how someone goes looking for a key that is not there.
 */
function inherited(from: string | undefined, key: string): string {
  return from
    ? ` It does not state \`${key}\` itself — that comes from “${from}”, which it inherits, and which is the file to change.`
    : '';
}

function compatibilitySentence(c: Compatibility, machine: Preset): string {
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
  const [only, setOnly] = useState<Offering | 'all'>('all');

  const visibility = useMemo(() => visibilityIndex(index), [index]);

  // Split rather than filtered: a vendor printer whose model/variant the user
  // never added is not in OrcaSlicer's printer list either, so it does not belong
  // beside the ones that are — but this app explains configs, and dropping it
  // outright would leave "why is this printer not offered" unanswerable. It goes
  // in a second group, named.
  const machines = useMemo(() => {
    const all = index.active
      .filter((p) => p.kind === 'machine')
      .sort(
        (a, b) =>
          Number(a.origin === 'system') - Number(b.origin === 'system') ||
          a.name.localeCompare(b.name, 'en'),
      );
    const offered = (p: Preset) => visibility.get(p.id)?.visible !== false;
    return { offered: all.filter(offered), notOffered: all.filter((p) => !offered(p)) };
  }, [index, visibility]);

  const machine = machineId ? index.byId.get(machineId) : undefined;
  const process = processId ? index.byId.get(processId) : undefined;

  const result = useMemo(
    () => (machine ? compatibilityFor(index, machine, process ? { process } : {}) : undefined),
    [index, machine, process],
  );

  if (machines.offered.length + machines.notOffered.length === 0) {
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
            {machines.offered.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.origin}
              </option>
            ))}
            {machines.notOffered.length > 0 && (
              <optgroup label="Not installed — OrcaSlicer does not offer these">
                {machines.notOffered.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.origin}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div>
          <label className="label-section" htmlFor="process-pick" style={{ display: 'block', marginBottom: 4 }}>
            Scoped to process (optional)
          </label>
          <select id="process-pick" value={processId} onChange={(e) => setProcessId(e.target.value)}>
            <option value="">Printer only — ignore the process gate</option>
            {result?.processes
              .filter((c) => offering(c) === 'available')
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
          {!index.installed.present && (
            <div className="notice">
              <strong>No readable <code>OrcaSlicer.conf</code> here.</strong> That file is the only
              record of which presets you have actually <em>installed</em>, and OrcaSlicer requires
              installed <em>and</em> compatible before it offers anything. Without it these lists are
              the compatibility half only, so they are wider than the slicer&rsquo;s.
            </div>
          )}
          {visibility.get(machine.id)?.visible === false && (
            <div className="notice">
              <strong>This printer is not installed.</strong> Its model and nozzle are not in{' '}
              <code>OrcaSlicer.conf</code>&rsquo;s <code>models</code>, so OrcaSlicer does not offer{' '}
              {machine.name} at all. What follows is what it <em>would</em> get.
            </div>
          )}
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
            {(['all', 'available', 'not-installed', 'excluded', 'undetermined'] as const).map((v) => (
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
  only: Offering | 'all';
  machine: Preset;
  onSelect: (id: string) => void;
}) {
  const s = compatibilitySummary(list);
  const visible = only === 'all' ? list : list.filter((c) => offering(c) === only);

  return (
    <section className="block">
      <h3>
        {title}
        <span className="count">
          {s.yes} available
          {s.notInstalled > 0 && ` · ${s.notInstalled} not installed`} · {s.no} excluded
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
  const verdict = offering(c);
  const gate = c.processGate;
  // For a row the installed gate stopped, the compatibility verdict is still the
  // answer to "and if I install it?" — so it moves to a note rather than being
  // dropped. `installedNote` is the mirror case: installed, but not by the user.
  const wouldBe = verdict === 'not-installed' ? explainCompatibility(c, machine) : undefined;
  const installedNote = wouldBe ? undefined : INSTALLED_NOTE[c.visibility.reason];

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
      {wouldBe && (
        <span className="compat-gate">
          Once installed — <CodeText text={wouldBe} />
        </span>
      )}
      {installedNote && (
        <span className="compat-gate">
          <CodeText text={installedNote} />
        </span>
      )}
      {c.reason === 'condition' && verdict !== 'not-installed' && (
        <span className="compat-expr mono">{c.evidence.value}</span>
      )}
      {gate && (
        <span className="compat-gate">
          {gate.names.length > 0 ? (
            <>
              Second gate — <code>compatible_prints</code>
              {gate.from && <> (inherited from “{gate.from}”)</>} accepts{' '}
              {gate.names.map((n) => `“${n}”`).join(', ')}
              {gate.passes === undefined
                ? '. Choose a process above to include it.'
                : gate.passes
                  ? '. The selected process is one of them.'
                  : '. The selected process is not one of them, so this filament is not offered.'}
            </>
          ) : (
            <>
              Second gate — <code>compatible_prints_condition</code>
              {gate.from && <> (inherited from “{gate.from}”)</>} decides against the process:{' '}
              <span className="mono">{gate.condition}</span>
              {gate.passes === 'undetermined' && ' (outside the subset this app evaluates)'}
            </>
          )}
        </span>
      )}
    </button>
  );
}
