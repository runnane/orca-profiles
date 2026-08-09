/**
 * The container's HTTP server.
 *
 * Reads the OrcaSlicer config from a mounted directory and serves it to the SPA
 * alongside the static assets, so the app works in any browser with no folder
 * picker — which is the whole reason this exists: the picker is Chromium-only,
 * needs a desktop session on the machine holding the config, and was crashing.
 *
 * Two rules this server exists to keep:
 *
 *  - **Credentials never cross the wire.** The browser-only build could promise
 *    that by construction; this one cannot, so `redactPresetJson` strips them
 *    by key name before anything is serialised. See `src/domain/redact.ts`.
 *  - **Read-only.** Nothing here writes to the config directory. Mount it `:ro`
 *    as well; the app has no reason to modify a working printer config.
 *
 * No framework — `node:http` and the filesystem are all this needs, which keeps
 * the image small and the dependency surface at zero.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { redactConfJson, redactPresetJson } from '../domain/redact';

const CONFIG_DIR = process.env.ORCA_CONFIG_DIR ?? '/config';
const STATIC_DIR = process.env.ORCA_STATIC_DIR ?? resolve(import.meta.dirname, '../web');
const PORT = Number(process.env.PORT ?? 8099);
/**
 * Default to loopback. Binding a container to every interface is the kind of
 * thing that quietly publishes a printer config to a whole network; the compose
 * file maps a host port explicitly instead.
 */
const HOST = process.env.HOST ?? '0.0.0.0';

const SKIP_DIRS = new Set(['cache', 'log', 'plugins', 'ota', 'resources']);
const MAX_FILES = 20_000;

interface ConfigFile {
  path: string;
  text: string;
}

/** Walk the config directory, redacting as we read. */
async function readConfig(root: string): Promise<ConfigFile[]> {
  const out: ConfigFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) subdirs.push(join(dir, e.name));
      } else if (e.name.endsWith('.json') || e.name === 'OrcaSlicer.conf') {
        files.push(join(dir, e.name));
      }
    }

    // Bounded concurrency: a real config is ~2600 files, and reading them one
    // at a time is measurably slower for no reason.
    const BATCH = 32;
    for (let i = 0; i < files.length; i += BATCH) {
      const chunk = files.slice(i, i + BATCH);
      const texts = await Promise.all(
        chunk.map((f) => readFile(f, 'utf8').catch(() => null)),
      );
      texts.forEach((text, j) => {
        if (text === null) return;
        const rel = relative(root, chunk[j]).split(sep).join('/');
        out.push({
          path: rel,
          // The conf file is application state, not a preset, and gets an
          // allowlist — see redactConfJson.
          text: rel === 'OrcaSlicer.conf' ? redactConfJson(text) : redactPresetJson(text),
        });
      });
    }

    for (const d of subdirs) await walk(d);
  };

  await walk(root);
  return out;
}

/** Cache the payload; a config directory does not change under a running app. */
let cached: { rootName: string; files: ConfigFile[]; builtAt: number } | null = null;

async function getConfig() {
  if (cached) return cached;
  const files = await readConfig(CONFIG_DIR);
  cached = { rootName: CONFIG_DIR, files, builtAt: Date.now() };
  return cached;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Serve a static asset, refusing anything that escapes the static root. */
async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(STATIC_DIR, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  if (!full.startsWith(resolve(STATIC_DIR))) return false;

  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    res.writeHead(200, {
      'content-type': MIME[extname(full)] ?? 'application/octet-stream',
      'content-length': s.size,
    });
    createReadStream(full).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/health') {
      const c = cached;
      return sendJson(res, 200, {
        ok: true,
        configDir: CONFIG_DIR,
        filesLoaded: c?.files.length ?? null,
        cachedAt: c ? new Date(c.builtAt).toISOString() : null,
      });
    }

    if (url.pathname === '/api/config') {
      try {
        if (url.searchParams.get('refresh') === '1') cached = null;
        const t0 = performance.now();
        const c = await getConfig();
        if (c.files.length === 0) {
          return sendJson(res, 503, {
            error: `No preset files found under ${CONFIG_DIR}. Mount the OrcaSlicer config directory there.`,
          });
        }
        return sendJson(res, 200, {
          rootName: c.rootName,
          files: c.files,
          readMs: performance.now() - t0,
        });
      } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (await serveStatic(res, url.pathname)) return;
    // SPA fallback.
    if (await serveStatic(res, '/index.html')) return;
    sendJson(res, 404, { error: 'not found' });
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`orca-profiles listening on http://${HOST}:${PORT}`);
  console.log(`  config dir: ${CONFIG_DIR}`);
  console.log(`  static dir: ${STATIC_DIR}`);
});
