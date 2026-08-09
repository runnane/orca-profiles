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
