/**
 * A documented subset of `compatible_printers_condition` /
 * `compatible_prints_condition`.
 *
 * These are PlaceholderParser expressions over a preset's config, not name lists.
 * We do not ship a PlaceholderParser, so the contract here is narrow and explicit:
 * evaluate the constructs this file implements, and return **`undetermined`** for
 * everything else — never a boolean. An honest "this depends on a condition we do
 * not evaluate" is a real answer; a guess is worth less than nothing, because it
 * looks like an answer.
 *
 * ## The grammar, from v2.4.2 PlaceholderParser.cpp:2215-2271
 *
 * Loosest first, and two of these will catch you out:
 *
 *     ?:  →  or ||  →  and &&  →  == != <> =~ !~  →  <= >= < >  →  + -  →  * / %  →  not ! - +  →  primary
 *
 * **`and` binds tighter than `or`**, and **equality binds looser than
 * comparison** — so `a == b < c` parses as `a == (b < c)`. Both are modelled.
 *
 * Supported: `and` `or` `not` (and `&&` `||` `!`), `==` `!=` `<>`, `<` `<=` `>`
 * `>=`, `=~` `!~`, parentheses, numbers, double-quoted strings, `true` / `false`,
 * and identifiers with an optional literal integer index (`nozzle_diameter[0]`).
 *
 * Not supported, and therefore `undetermined`: arithmetic, the ternary, every
 * function (`min`, `max`, `one_of`, `interpolate_table`, `empty`, `size`,
 * `is_nil`, `int`, `round`, …), and a computed index.
 *
 * ## Why nothing short-circuits
 *
 * It is tempting to fold `false and <unsupported>` to `false`. That is wrong, and
 * the reason is the most important fact about this whole feature: an unsupported
 * sub-expression is one of two things we cannot tell apart.
 *
 *  - Valid in the slicer, merely outside our subset → the slicer computes
 *    `false and X` and gets **false**.
 *  - Invalid → `process_macro` throws (PlaceholderParser.cpp:/process_macro/), the
 *    exception reaches `is_compatible_with_printer`, which catches it and
 *    `return true` — with a `//FIXME in case of an error, return "compatible with
 *    everything"` on it (Preset.cpp:832-835). The slicer's answer is **true**.
 *
 * Same text, opposite answers. So `undetermined` propagates through every
 * operator without exception.
 *
 * ## Why an unresolved identifier is undetermined rather than an error
 *
 * An unknown variable makes the slicer throw ("Variable does not exist",
 * PlaceholderParser.cpp:932) and therefore — per the above — report *compatible*.
 * But the slicer evaluates against a full `DynamicPrintConfig` holding a default
 * for every option, while we hold only what is on disk plus what is inherited. A
 * key we cannot find is far more likely an option sitting at its default than a
 * typo, and we do not ship OrcaSlicer's option definitions to tell them apart.
 *
 * ## The one divergence that is left, stated rather than hidden
 *
 * `compare_op` (PlaceholderParser.cpp:/compare_op/) branches on each side's
 * *declared type*: numeric-vs-numeric compares numerically with a `1e-8` epsilon,
 * and if either side is a string it compares `to_string()`. Every value we hold is
 * text and we have no type table, so: both sides numeric-parsable → numeric
 * compare with the same epsilon; a quoted literal on either side → string
 * compare; non-numeric text against a bare number → `undetermined`, because which
 * branch the slicer takes depends on a type we cannot see.
 *
 * What remains is narrow and worth knowing: a *string*-typed option whose value
 * looks numeric, compared against a numerically-equal but differently-written
 * literal (`"0.40" == 0.4`), is false in the slicer and true here. Making that
 * undetermined too would take `nozzle_diameter[0]==0.4` — the canonical condition
 * — with it, which would defeat the purpose.
 *
 * The regex dialect is the other place two implementations meet: the slicer uses
 * **boost::regex** in its default `perl` grammar (`USE_CPP11_REGEX` is commented
 * out, PlaceholderParser.cpp:59-66), which overlaps JS but is not identical. A
 * pattern JS cannot compile is `undetermined` rather than a non-match, and the one
 * default that differs materially — `.` matching a newline — is matched explicitly
 * with the `s` flag.
 */

import { scalarAsList } from './normalize';
import type { RawValue } from './types';

/** `undetermined` is a value, not an error and not a boolean with a caveat. */
export type ConditionResult = boolean | 'undetermined';

export interface ConditionContext {
  /**
   * A setting's value as the preset resolves it, or `undefined` when this config
   * does not carry the key — which yields `undetermined`, see the module note.
   */
  lookup(key: string): RawValue | undefined;
  /**
   * Variables injected by the caller rather than read from the config:
   * `printer_preset` and `num_extruders` on the printer path (Preset.cpp:845-849).
   * Not in scope for `compatible_prints_condition`, which the slicer evaluates
   * against the process config with no extras (Preset.cpp:782).
   */
  injected?: Record<string, RawValue>;
}

/** Anything the subset does not cover. Carried by exception, caught at the top. */
class Unsupported extends Error {}

type Value =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  /** Present in the config in principle, but not resolvable to a value here. */
  | { t: 'unknown' };

const UNKNOWN: Value = { t: 'unknown' };

/** Same epsilon the slicer uses for `==` between doubles. */
const EPSILON = 1e-8;

export function evaluateCondition(expr: string, ctx: ConditionContext): ConditionResult {
  const text = expr.trim();
  if (text === '') return 'undetermined';
  try {
    const p = new Parser(text, ctx);
    const v = p.parseOr();
    p.skipSpace();
    // Trailing input means we mis-parsed, not that the rest is irrelevant.
    if (!p.atEnd()) throw new Unsupported('trailing input');
    if (v.t === 'unknown') return 'undetermined';
    // `bool_expr_eval` throws unless the whole expression is boolean
    // (PlaceholderParser.cpp:2245), and a throw means compatible — which we
    // cannot claim, so it is undetermined here.
    if (v.t !== 'bool') return 'undetermined';
    return v.v;
  } catch {
    return 'undetermined';
  }
}

class Parser {
  private i = 0;
  private readonly s: string;
  private readonly ctx: ConditionContext;

  constructor(s: string, ctx: ConditionContext) {
    this.s = s;
    this.ctx = ctx;
  }

  atEnd(): boolean {
    return this.i >= this.s.length;
  }

  skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  /** Consume `lit` if it is next. Word operators must not match a prefix. */
  private eat(lit: string, word = false): boolean {
    this.skipSpace();
    if (!this.s.startsWith(lit, this.i)) return false;
    if (word) {
      const after = this.s[this.i + lit.length];
      if (after !== undefined && /[\w[]/.test(after)) return false;
    }
    this.i += lit.length;
    return true;
  }

  private peekOneOf(...lits: string[]): string | undefined {
    this.skipSpace();
    return lits.find((l) => this.s.startsWith(l, this.i));
  }

  parseOr(): Value {
    let left = this.parseAnd();
    for (;;) {
      if (!this.eat('||') && !this.eat('or', true)) return left;
      const right = this.parseAnd();
      left = logical(left, right, 'or');
    }
  }

  private parseAnd(): Value {
    let left = this.parseEquality();
    for (;;) {
      if (!this.eat('&&') && !this.eat('and', true)) return left;
      const right = this.parseEquality();
      left = logical(left, right, 'and');
    }
  }

  private parseEquality(): Value {
    let left = this.parseRelational();
    for (;;) {
      // `=~` and `!~` take a `/`-delimited pattern rather than an expression, so
      // they are read here where the parser knows a regex is coming — which is
      // also how `/` stays unambiguous without a lexer.
      if (this.eat('=~')) {
        left = this.regexMatch(left, false);
        continue;
      }
      if (this.eat('!~')) {
        left = this.regexMatch(left, true);
        continue;
      }
      const op = this.peekOneOf('==', '!=', '<>');
      if (!op) return left;
      this.i += op.length;
      const right = this.parseRelational();
      const eq = compare(left, right, '=');
      left = op === '==' ? eq : negate(eq);
    }
  }

  private parseRelational(): Value {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peekOneOf('<=', '>=', '<', '>');
      // `<>` is inequality, not `<` followed by `>`; it belongs to the equality
      // level and must not be consumed here.
      if (!op || this.s.startsWith('<>', this.i)) return left;
      this.i += op.length;
      const right = this.parseUnary();
      switch (op) {
        case '<':
          left = compare(left, right, '<');
          break;
        case '>':
          left = compare(left, right, '>');
          break;
        case '<=':
          left = negate(compare(left, right, '>'));
          break;
        default:
          left = negate(compare(left, right, '<'));
      }
    }
  }

  private parseUnary(): Value {
    if (this.eat('!') || this.eat('not', true)) {
      const v = this.parseUnary();
      if (v.t === 'unknown') return UNKNOWN;
      // `not` on a non-boolean throws in the slicer, so we cannot claim a result.
      if (v.t !== 'bool') return UNKNOWN;
      return { t: 'bool', v: !v.v };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    this.skipSpace();
    if (this.atEnd()) throw new Unsupported('unexpected end');

    if (this.eat('(')) {
      const v = this.parseOr();
      if (!this.eat(')')) throw new Unsupported('unclosed (');
      return v;
    }

    const ch = this.s[this.i];

    if (ch === '"') return { t: 'str', v: this.readQuoted() };

    if (/[\d.]/.test(ch) || (ch === '-' && /[\d.]/.test(this.s[this.i + 1] ?? ''))) {
      const m = /^-?\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i));
      if (!m) throw new Unsupported('malformed number');
      this.i += m[0].length;
      return { t: 'num', v: Number(m[0]) };
    }

    const id = /^[A-Za-z_]\w*/.exec(this.s.slice(this.i));
    if (!id) throw new Unsupported(`unexpected ${ch}`);
    this.i += id[0].length;
    const name = id[0];

    if (name === 'true') return { t: 'bool', v: true };
    if (name === 'false') return { t: 'bool', v: false };

    // A function call is out of the subset. Bail before reading its arguments —
    // guessing at `one_of(...)` is exactly what this module exists not to do.
    if (this.peekOneOf('(')) throw new Unsupported(`function ${name}`);

    let index: number | undefined;
    if (this.eat('[')) {
      this.skipSpace();
      const m = /^\d+/.exec(this.s.slice(this.i));
      // The slicer allows an expression as an index; we allow a literal only.
      if (!m) throw new Unsupported('computed index');
      this.i += m[0].length;
      if (!this.eat(']')) throw new Unsupported('unclosed [');
      index = Number(m[0]);
    }

    return this.variable(name, index);
  }

  /** A `/`-delimited pattern, with `\` escapes (`regular_expression` rule). */
  private readRegex(): string {
    this.skipSpace();
    if (this.s[this.i] !== '/') throw new Unsupported('expected /pattern/');
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '\\') {
        // Kept verbatim: the escape is the regex's, not this parser's.
        out += c + (this.s[this.i + 1] ?? '');
        this.i += 2;
        continue;
      }
      if (c === '/') {
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
    throw new Unsupported('unterminated pattern');
  }

  private readQuoted(): string {
    this.i++; // opening quote
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '\\') {
        out += this.s[this.i + 1] ?? '';
        this.i += 2;
        continue;
      }
      if (c === '"') {
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
    throw new Unsupported('unterminated string');
  }

  private regexMatch(subject: Value, invert: boolean): Value {
    const pattern = this.readRegex();
    if (subject.t === 'unknown') return UNKNOWN;
    // "Left hand side of a regex match must be a string" (Preset.cpp:697-699) —
    // a throw, which means compatible, which we cannot claim.
    if (subject.t !== 'str') return UNKNOWN;
    let re: RegExp;
    try {
      // Two things, both of which silently invert real conditions if missed:
      //
      //  - `regex_match` requires the WHOLE subject to match, which is exactly why
      //    real conditions are written `/.*PATTERN.*/`. Hence the anchors.
      //  - the library is **boost::regex**, not `std::regex`: `USE_CPP11_REGEX` is
      //    commented out (PlaceholderParser.cpp:59-66), so this is not
      //    build-dependent. boost's default `perl` grammar lets `.` match a
      //    newline unless `match_not_dot_newline` is passed, and `regex_match` is
      //    called with no match flags. `printer_notes` is routinely multi-line, so
      //    without `s` every `/.*VENDOR.*/` against it would come back false.
      re = new RegExp(`^(?:${pattern})$`, 's');
    } catch {
      // A pattern JS cannot compile is not a non-match: the slicer's regex
      // dialect is close but not identical, and a compile failure there means
      // compatible anyway.
      return UNKNOWN;
    }
    const hit = re.test(subject.v);
    return { t: 'bool', v: invert ? !hit : hit };
  }

  private variable(name: string, index: number | undefined): Value {
    const injected = this.ctx.injected?.[name];
    const raw = injected !== undefined ? injected : this.ctx.lookup(name);
    if (raw === undefined) return UNKNOWN;

    const parts = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === 'number'
        ? [String(raw)]
        : scalarAsList(raw);

    if (index !== undefined) {
      // Out of range is a throw in the slicer, so no claim either way.
      if (index >= parts.length) return UNKNOWN;
      return asValue(parts[index]);
    }

    // An unindexed vector reference is not a scalar; the slicer needs the index.
    // A single-element value is the ordinary scalar case.
    if (Array.isArray(raw) && raw.length !== 1) return UNKNOWN;
    if (!Array.isArray(raw) && parts.length !== 1) return UNKNOWN;
    return asValue(parts[0]);
  }
}

/** Config values are text; a numeric-looking one is treated as a number. */
function asValue(text: string): Value {
  const t = text.trim();
  if (t !== '' && /^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(t)) return { t: 'num', v: Number(t) };
  return { t: 'str', v: t };
}

function negate(v: Value): Value {
  return v.t === 'bool' ? { t: 'bool', v: !v.v } : UNKNOWN;
}

/**
 * `compare_op`'s branches, minus the ones that need a type we cannot see. See the
 * module note on the residual divergence.
 */
function compare(lhs: Value, rhs: Value, op: '=' | '<' | '>'): Value {
  if (lhs.t === 'unknown' || rhs.t === 'unknown') return UNKNOWN;

  if (lhs.t === 'num' && rhs.t === 'num') {
    if (op === '=') return { t: 'bool', v: Math.abs(lhs.v - rhs.v) < EPSILON };
    return { t: 'bool', v: op === '<' ? lhs.v < rhs.v : lhs.v > rhs.v };
  }

  if (lhs.t === 'bool' && rhs.t === 'bool') {
    // Only equality is defined for two booleans; anything else throws.
    if (op !== '=') return UNKNOWN;
    return { t: 'bool', v: lhs.v === rhs.v };
  }

  if (lhs.t === 'str' && rhs.t === 'str') {
    if (op === '=') return { t: 'bool', v: lhs.v === rhs.v };
    return { t: 'bool', v: op === '<' ? lhs.v < rhs.v : lhs.v > rhs.v };
  }

  // Mixed string/number or string/bool: the slicer compares `to_string()`, but
  // only because it knows the option's declared type. We do not.
  return UNKNOWN;
}

function logical(lhs: Value, rhs: Value, op: 'and' | 'or'): Value {
  // No short-circuiting, deliberately — see the module note. An unsupported side
  // is either false-making or throw-making, and those give opposite answers.
  if (lhs.t !== 'bool' || rhs.t !== 'bool') return UNKNOWN;
  return { t: 'bool', v: op === 'and' ? lhs.v && rhs.v : lhs.v || rhs.v };
}

/**
 * The variables the slicer injects on the printer path — not config keys
 * (Preset.cpp:845-849, and identically in `update_compatible_internal`,
 * Preset.cpp:3342-3346).
 *
 * `num_extruders` is the **length of `nozzle_diameter`**, so it depends on how
 * that value is written; both serialisations are read the same way.
 */
export function printerInjectedVars(
  machineName: string,
  nozzleDiameter: RawValue | undefined,
): Record<string, RawValue> {
  const out: Record<string, RawValue> = { printer_preset: machineName };
  if (nozzleDiameter !== undefined) {
    const parts = Array.isArray(nozzleDiameter)
      ? nozzleDiameter
      : scalarAsList(String(nozzleDiameter));
    out.num_extruders = String(parts.length);
  }
  return out;
}
