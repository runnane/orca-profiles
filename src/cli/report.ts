/**
 * `orca-report <config-dir>` — the whole analysis, in a terminal.
 *
 * Exists because the browser app cannot be opened on a headless box, and
 * because the interesting config usually lives on the printer host rather than
 * on a machine with a desktop. Same domain code as the SPA, so a finding here
 * is the finding the app would show.
 *
 * Prints no setting values, so it is safe to paste: credentials are reported
 * only as set/not-set, and nothing else is quoted except preset and file names.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { analyze, stats } from '../domain/analyze';
import {
  compatibilityFor,
  compatibilitySummary,
  offering,
  type CompatibilityReason,
  type Offering,
  type VisibilityReason,
} from '../domain/compatibility';
import { buildIndex, type ConfigFile } from '../domain/index-config';
import { isSensitiveKey } from '../domain/redact';
import { ownOverrides } from '../domain/resolve';

const SKIP_DIRS = new Set(['cache', 'log', 'plugins', 'ota', 'resources']);

/**
 * Why a preset is or is not offered, in one clause. `undetermined` is a state of
 * its own here as it is in the domain type — a condition we do not evaluate is
 * reported as such rather than rounded to yes or no.
 */
const REASON: Record<CompatibilityReason, string> = {
  'compatible-with-everything': 'names no printers, so it goes with all of them',
  'named-explicitly': 'this printer is named in `compatible_printers`',
  'named-via-parent': 'this printer inherits from a preset it names',
  excluded: '`compatible_printers` names other printers only',
  'excluded-by-library': 'a vendor ships its own version of this alias for this printer',
  condition: 'decided by a condition on the printer\'s settings',
  'never-loaded': 'lost a name clash, so the slicer never loads it',
};

/** Why a preset the user never installed is not on offer, whatever it is compatible with. */
const NOT_INSTALLED: Partial<Record<VisibilityReason, string>> = {
  // The verdict word already says "not installed"; these say why.
  'not-installed': '`OrcaSlicer.conf` does not list it, so it is not in the list at all',
  'variant-not-installed': 'this printer model and nozzle are not among the installed ones',
};

function verdictWord(v: Offering): string {
  return v === 'not-installed' ? 'not installed' : v;
}

function readConfigDir(root: string): ConfigFile[] {
  const out: ConfigFile[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.name.endsWith('.json') || e.name === 'OrcaSlicer.conf') {
        try {
          out.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
        } catch {
          /* unreadable file: the index reports it as a parse error */
        }
      }
    }
  };
  walk(root);
  return out;
}

const root = process.argv[2];
if (!root) {
  console.error('usage: orca-report <orcaslicer-config-dir>');
  process.exit(2);
}

const files = readConfigDir(root);
const index = buildIndex(files);
const s = stats(index);
const findings = analyze(index);

const line = (n = 74) => '─'.repeat(n);

console.log(`\nOrcaSlicer config: ${root}`);
console.log(line());
console.log(`  active profile      user/${index.activeProfile}`);
if (index.inactiveProfiles.length > 0) {
  console.log(`  NOT loaded          ${index.inactiveProfiles.map((p) => `user/${p}`).join(', ')}`);
}
console.log(`  user presets        ${s.user}`);
console.log(`  system presets      ${s.system} from ${s.vendors} vendors`);
if (s.snapshots > 0) console.log(`  sync snapshots      ${s.snapshots} (ignored)`);
if (s.deepestChain) {
  console.log(`  deepest chain       ${s.deepestChain.depth} — ${s.deepestChain.name}`);
}
if (index.parseErrors.length > 0) console.log(`  unreadable files    ${index.parseErrors.length}`);

// Credentials: presence only, never a value.
const credentialed = index.active.filter((p) =>
  Object.entries(p.raw).some(([k, v]) => {
    if (!isSensitiveKey(k)) return false;
    const vals = Array.isArray(v) ? v : [v];
    return vals.some((x) => x !== '' && x !== null && x !== undefined);
  }),
);
if (credentialed.length > 0) {
  console.log(`  presets with a credential set   ${credentialed.length} (values not shown)`);
}

console.log(`\nFindings: ${findings.length}`);
console.log(line());
const bySeverity = { high: 0, medium: 0, low: 0 };
for (const f of findings) bySeverity[f.severity]++;
console.log(`  ${bySeverity.high} high · ${bySeverity.medium} medium · ${bySeverity.low} low\n`);

for (const f of findings.slice(0, 30)) {
  console.log(`[${f.severity.toUpperCase().padEnd(6)}] ${f.title}`);
  console.log(`          ${f.detail}`);
  console.log();
}
if (findings.length > 30) console.log(`… and ${findings.length - 30} more\n`);

// The headline table: how much of each preset is actually yours.
const rows = index.active
  .filter((p) => p.origin === 'user' && p.inherits)
  .map((p) => {
    const o = ownOverrides(index, p);
    return { name: p.name, stored: Object.keys(p.raw).length, real: o.effective.length, redundant: o.redundant.length };
  })
  .filter((r) => r.stored > 20)
  .sort((a, b) => b.stored - a.stored)
  .slice(0, 12);

// Per printer: what it actually gets. Same domain code as the app, so a line
// here is a line the app shows. Names only, never a setting value.
const machines = index.active.filter((p) => p.kind === 'machine' && p.origin === 'user');
if (machines.length > 0) {
  console.log('What each printer gets');
  console.log(line());
  for (const m of machines) {
    const c = compatibilityFor(index, m);
    const f = compatibilitySummary(c.filaments);
    const pr = compatibilitySummary(c.processes);
    const counts = (s: ReturnType<typeof compatibilitySummary>) =>
      `${s.yes} available${s.notInstalled > 0 ? ` · ${s.notInstalled} not installed` : ''} · ${s.no} excluded${
        s.undetermined > 0 ? ` · ${s.undetermined} undetermined` : ''
      }`;
    console.log(`  ${m.name}`);
    console.log(`    filaments  ${counts(f)}`);
    console.log(`    processes  ${counts(pr)}`);
    // Only the answers that need explaining: anything not plainly available, plus
    // the two that are available for a reason nobody would guess — the parent
    // clause, and a condition that matched.
    const notable = [...c.filaments, ...c.processes].filter(
      (x) => offering(x) !== 'available' || x.reason === 'named-via-parent' || x.reason === 'condition',
    );
    // Not installed is by far the largest group on a real config and the least
    // interesting line by line — the count above says it. What is worth the space
    // is everything the *compatibility* rule decided.
    const ranked = [
      ...notable.filter((x) => offering(x) !== 'not-installed'),
      ...notable.filter((x) => offering(x) === 'not-installed'),
    ];
    for (const x of ranked.slice(0, 8)) {
      const verdict = offering(x);
      const why =
        verdict === 'not-installed'
          ? (NOT_INSTALLED[x.visibility.reason] ?? 'not installed')
          : x.reason === 'condition' && x.included === 'undetermined'
            ? 'depends on a condition outside the subset we evaluate'
            : REASON[x.reason];
      console.log(`    ${verdictWord(verdict).padEnd(13)} ${x.preset.name} — ${why}`);
      // The expression verbatim, for the two cases where it is the answer.
      if (x.reason === 'condition' && verdict !== 'not-installed') {
        console.log(`                  ${x.evidence.value}`);
      }
    }
    if (notable.length > 8) console.log(`    … and ${notable.length - 8} more`);
    console.log();
  }
}

if (rows.length > 0) {
  console.log('Presets that look bigger than they are');
  console.log(line());
  console.log(`  ${'preset'.padEnd(46)} ${'stored'.padStart(6)} ${'real'.padStart(5)} ${'noise'.padStart(6)}`);
  for (const r of rows) {
    const name = r.name.length > 45 ? `${r.name.slice(0, 44)}…` : r.name;
    console.log(
      `  ${name.padEnd(46)} ${String(r.stored).padStart(6)} ${String(r.real).padStart(5)} ${String(r.redundant).padStart(6)}`,
    );
  }
  console.log();
}
