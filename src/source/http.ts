/**
 * Loading the config from the server.
 *
 * When the app is served by its container, the config comes down over HTTP
 * already redacted and there is no picker, no Chromium requirement and no
 * desktop session involved. When it is served as plain static files this
 * endpoint simply is not there, and the app falls back to the directory picker.
 */

import type { ConfigFile } from '../domain/index-config';

export interface ServerConfig {
  rootName: string;
  files: ConfigFile[];
  readMs: number;
}

/** Is a config server behind this origin? */
export async function serverConfigAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/health`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function fetchServerConfig(refresh = false): Promise<ServerConfig> {
  const res = await fetch(
    `${import.meta.env.BASE_URL}api/config${refresh ? '?refresh=1' : ''}`,
    { headers: { accept: 'application/json' } },
  );
  const body = (await res.json()) as ServerConfig & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Server returned ${res.status}`);
  return body;
}
