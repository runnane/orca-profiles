/**
 * The settings table, shared by the detail and compare views.
 *
 * Two things it must never do: print a credential, and show a value without
 * saying where it came from.
 */

import { displayValue } from '../domain/normalize';
import { isSensitiveKey, maskValue } from '../domain/redact';
import type { RawValue } from '../domain/types';

export interface SettingRow {
  key: string;
  value: RawValue | undefined;
  /** Preset that supplied the value. */
  source?: string;
  /** True when the selected preset set it itself. */
  own?: boolean;
  /** The value this one replaced, if any. */
  was?: RawValue;
}

export function Value({ settingKey, value }: { settingKey: string; value: RawValue | undefined }) {
  if (isSensitiveKey(settingKey)) {
    return (
      <span className="faint" title="Credentials are never displayed or exported">
        {maskValue(value)}
      </span>
    );
  }
  return <>{displayValue(value)}</>;
}

export function SettingsTable({
  rows,
  showSource = true,
  emptyMessage = 'Nothing here.',
}: {
  rows: SettingRow[];
  showSource?: boolean;
  emptyMessage?: string;
}) {
  if (rows.length === 0) return <p className="muted">{emptyMessage}</p>;

  return (
    <table className="settings">
      <thead>
        <tr>
          <th>Setting</th>
          <th>Value</th>
          {showSource && <th>From</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="k">{r.key}</td>
            <td className="v">
              <Value settingKey={r.key} value={r.value} />
              {r.was !== undefined && (
                <div className="was">
                  <Value settingKey={r.key} value={r.was} />
                </div>
              )}
            </td>
            {showSource && (
              <td className="src">
                <span className={`dot ${r.own ? 'own' : 'inherited'}`} aria-hidden="true" />
                {r.own ? 'this preset' : (r.source ?? 'unknown')}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
