/**
 * Credential handling.
 *
 * Machine presets carry printer-host credentials: `printhost_apikey`,
 * `printhost_password`, `print_host`, `printhost_user`, and a device serial.
 * They are ordinary keys in the same flat JSON as layer height, so anything
 * that renders "all settings" renders those too.
 *
 * Nothing leaves the browser in this app — there is no backend — but the
 * screen is still an exposure surface: screenshots, screen sharing, and a
 * pasted "here's my config" bug report. So these are masked at the point of
 * display and excluded from any export, and the mask is applied by key name
 * rather than by value, so a credential we have never seen is still covered.
 */

const SENSITIVE_PATTERNS = [
  'password',
  'apikey',
  'api_key',
  'token',
  'secret',
  'print_host',
  'printhost_user',
  'serial_number',
  'cafile',
  'authorization',
  // From `OrcaSlicer.conf` rather than from presets: LAN printer pairing codes,
  // device serials and per-device addresses.
  'access_code',
  'dev_sn',
  'dev_ip',
  'dev_name',
  'local_machines',
];

/** Should this setting's value be masked when displayed? */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => k.includes(p));
}

/**
 * What to show instead of the value. Whether a credential is *set* is useful
 * (an empty apikey and a populated one are different states worth seeing), so
 * that much is reported while the value itself never is.
 */
export function maskValue(value: unknown): string {
  const empty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.every((v) => v === '' || v === null));
  return empty ? '(not set)' : '•••••• (set, hidden)';
}

/** Stands in for a credential that is set. Never the credential itself. */
export const REDACTED = 'REDACTED';

/**
 * Strip credentials out of a preset before it crosses a network boundary.
 *
 * When the app runs from a container the config is served over HTTP, so the
 * browser-only guarantee ("it never leaves the machine") no longer holds by
 * construction and has to be enforced here instead. A set credential becomes
 * the `REDACTED` sentinel and an unset one stays empty, which preserves the
 * set/not-set distinction the UI reports without transmitting anything secret.
 *
 * Applied to the raw JSON text, so a key we have never seen is still covered:
 * the decision is made by key name, not by recognising a value.
 */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((x) => (x === '' || x === null || x === undefined ? '' : REDACTED));
  }
  return value === '' || value === null || value === undefined ? '' : REDACTED;
}

/** Recursively blank anything under a sensitive key, at any depth. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      if (Array.isArray(v)) {
        // Presets hold per-extruder lists of scalars here, and "which slots are
        // configured" is worth keeping. Anything structured inside is dropped:
        // its keys may themselves be the secret.
        out[k] = v.map((x) =>
          x !== null && typeof x === 'object' ? (Array.isArray(x) ? [] : {}) : redactValue(x),
        );
      } else if (v !== null && typeof v === 'object') {
        // An object under a sensitive key goes entirely — `local_machines` is
        // keyed by printer IP, so blanking values would leave the addresses.
        out[k] = {};
      } else {
        out[k] = redactValue(v);
      }
      continue;
    }
    out[k] = scrub(v);
  }
  return out;
}

export function redactPresetJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not parseable: the index will report it. Nothing to redact meaningfully,
    // and passing the raw text through would risk leaking whatever is in it.
    return '{}';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  return JSON.stringify(scrub(parsed));
}

/**
 * `OrcaSlicer.conf` gets an allowlist rather than the key denylist above.
 *
 * It is not a preset: it is a large, nested, undocumented application state
 * file, and the real one holds LAN pairing codes (`access_code`,
 * `user_access_code`), device serials, and a `local_machines` map **keyed by
 * printer IP address** with hostnames inside. A key that is itself the secret
 * cannot be caught by scrubbing values, and the shape can change between
 * releases — so guessing at what is dangerous is the wrong way round.
 *
 * The app needs three things out of this file, and takes only those three:
 *
 *  - `app.preset_folder` — which user profile is live.
 *  - `filaments` — the installed filament presets, which is half of the
 *    `is_visible` gate (see [`installed.ts`](installed.ts)). Preset names, all of
 *    which the served preset files already carry.
 *  - `models` — the installed printer model/variant list, the other half. Vendor
 *    ids, model ids and nozzle diameters, likewise already public product data
 *    present in `system/`.
 *
 * Each is **rebuilt from parsed values rather than passed through**, field by
 * field and type by type, so a key that happens to sit next to one of them —
 * `access_code` beside `models`, a future `local_machines`-shaped addition inside
 * a `models` entry — cannot ride along. That is what keeps this an allowlist
 * rather than three holes in one.
 *
 * `filaments` is emitted in its array form whichever form it arrived in, because
 * that is what the slicer itself writes (AppConfig.cpp:966-973) and one shape
 * across both transports is one shape to reason about.
 *
 * **A section we could not read is omitted, never emitted empty.** An empty
 * `filaments` is a claim — "nothing is installed" — and the reader acts on it by
 * gating a filament list down to almost nothing. Manufacturing that claim out of
 * a conf we failed to parse would empty the app's lists over a transport
 * accident, so absence is passed on as absence and the reader applies no gate.
 * An `filaments: []` that was genuinely in the file *is* forwarded: that one is
 * the config's claim, not ours.
 */
export function redactConfJson(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const app = (parsed?.app ?? {}) as Record<string, unknown>;
    const presetFolder = typeof app.preset_folder === 'string' ? app.preset_folder : '';
    const filaments = installedFilamentNames(parsed?.filaments);
    const models = installedModels(parsed?.models);
    return JSON.stringify({
      app: { preset_folder: presetFolder },
      ...(filaments ? { filaments } : {}),
      ...(models ? { models } : {}),
    });
  } catch {
    return JSON.stringify({ app: { preset_folder: '' } });
  }
}

/**
 * The `filaments` section as a list of names, from either serialisation.
 *
 * Mirrors `readFilaments` in `installed.ts`, including "a map entry with an empty
 * value is not installed" (Preset.cpp:869-872) — dropping such a name here rather
 * than forwarding it keeps the transport from carrying a state the reader would
 * have to re-decide.
 */
function installedFilamentNames(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v !== '');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([name, v]) => name !== '' && typeof v === 'string' && v !== '')
      .map(([name]) => name);
  }
  return undefined;
}

/**
 * The `models` section, rebuilt to exactly the three fields `AppConfig::load`
 * reads (AppConfig.cpp:735-746). An entry missing either identifier is dropped:
 * it cannot gate anything, so forwarding it would only carry whatever else is in
 * it.
 */
function installedModels(
  value: unknown,
): { vendor: string; model: string; nozzle_diameter: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { vendor: string; model: string; nozzle_diameter: string }[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.vendor !== 'string' || typeof e.model !== 'string') continue;
    if (e.vendor === '' || e.model === '') continue;
    const nd = e.nozzle_diameter;
    out.push({
      vendor: e.vendor,
      model: e.model,
      nozzle_diameter: typeof nd === 'string' ? nd : Array.isArray(nd) ? nd.map(String).join(';') : '',
    });
  }
  return out;
}
