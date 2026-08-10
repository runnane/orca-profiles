/**
 * Post-deploy verification, run from a *different* machine than the one serving.
 *
 * A request made on the host itself proves nothing about exposure — loopback
 * answers either way — so this is deliberately a remote check.
 *
 * The redaction assertions are structural rather than a search for known
 * secrets, so this works without ever reading the real config: it asserts that
 * nothing under a sensitive key survived, that `OrcaSlicer.conf` came back
 * reduced to its allowlisted fields **and that each of those was rebuilt rather
 * than forwarded**, and that no address-shaped string appears anywhere in the
 * payload.
 *
 *   node scripts/verify-deploy.mjs http://host:8099
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8099').replace(/\/$/, '');
const MIN_FILES = Number(process.env.ORCA_MIN_FILES ?? 100);

const SENSITIVE = [
  'password', 'apikey', 'api_key', 'token', 'secret', 'print_host',
  'printhost_user', 'serial_number', 'cafile', 'authorization',
  'access_code', 'dev_sn', 'dev_ip', 'dev_name', 'local_machines',
];
const isSensitive = (k) => SENSITIVE.some((s) => k.toLowerCase().includes(s));

const failures = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
};

async function main() {
  // 1. Health.
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  if (health?.ok !== true) return bad(`health did not report ok: ${JSON.stringify(health)}`);
  ok(`health 200 · config dir ${health.configDir}`);

  // 2. The SPA itself is served.
  const spa = await fetch(`${base}/`);
  spa.ok ? ok(`SPA 200 (${spa.headers.get('content-type')})`) : bad(`SPA returned ${spa.status}`);

  // 3. The config payload.
  const res = await fetch(`${base}/api/config`);
  if (!res.ok) return bad(`/api/config returned ${res.status}`);
  const text = await res.text();
  const payload = JSON.parse(text);
  const files = payload.files ?? [];

  files.length >= MIN_FILES
    ? ok(`config 200 · ${files.length} files`)
    : bad(`only ${files.length} files served (expected >= ${MIN_FILES}) — is the config mounted?`);

  // 4. Nothing survives under a sensitive key.
  let leaked = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (isSensitive(k)) {
        const vals = Array.isArray(v) ? v : [v];
        for (const x of vals) {
          if (x === '' || x === null || x === undefined || x === 'REDACTED') continue;
          if (typeof x === 'object' && Object.keys(x).length === 0) continue;
          leaked++;
        }
        continue;
      }
      walk(v);
    }
  };
  for (const f of files) {
    try { walk(JSON.parse(f.text)); } catch { /* the app reports unparseable files */ }
  }
  leaked === 0
    ? ok('no value survives under any credential-bearing key')
    : bad(`${leaked} credential value(s) present in the payload`);

  // 5. OrcaSlicer.conf reduced to its allowlisted shape: three fields, and each
  //    rebuilt rather than forwarded. The per-entry check on `models` is the one
  //    that matters most — an entry passed through whole would carry whatever the
  //    real conf keeps beside the three fields the slicer reads, and the top-level
  //    key check alone would not notice.
  const CONF_KEYS = ['app', 'filaments', 'models'];
  const MODEL_KEYS = ['vendor', 'model', 'nozzle_diameter'];
  const conf = files.find((f) => f.path === 'OrcaSlicer.conf');
  if (conf) {
    const parsed = JSON.parse(conf.text);
    const keys = Object.keys(parsed);
    const appKeys = Object.keys(parsed.app ?? {});
    const extra = keys.filter((k) => !CONF_KEYS.includes(k));
    extra.length === 0 && appKeys.every((k) => k === 'preset_folder')
      ? ok(`OrcaSlicer.conf reduced to { ${keys.join(', ')} }`)
      : bad(`OrcaSlicer.conf served extra fields: ${JSON.stringify(extra)} / ${JSON.stringify(appKeys)}`);

    const names = parsed.filaments ?? [];
    Array.isArray(names) && names.every((n) => typeof n === 'string')
      ? ok(`installed filaments served as ${names.length} name(s), nothing else`)
      : bad(`filaments section is not a list of names: ${JSON.stringify(names).slice(0, 120)}`);

    const models = parsed.models ?? [];
    const strayModelKeys = [
      ...new Set(
        (Array.isArray(models) ? models : []).flatMap((m) =>
          Object.keys(m ?? {}).filter((k) => !MODEL_KEYS.includes(k)),
        ),
      ),
    ];
    strayModelKeys.length === 0
      ? ok(`installed models served as ${models.length} entry(ies), three fields each`)
      : bad(`models entries carry unallowlisted fields: ${strayModelKeys.join(', ')}`);
  }

  // 6. No address-shaped strings anywhere. Catches a key that IS the secret,
  //    which no value-scrubbing can reach.
  const privateIp = /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b/g;
  const fqdn = /\b[a-z0-9-]+\.(?:srv|lan|local|home)\.[a-z0-9.-]+\b/gi;
  const ips = [...new Set(text.match(privateIp) ?? [])];
  const hosts = [...new Set(text.match(fqdn) ?? [])];
  ips.length === 0
    ? ok('no private IP addresses in the payload')
    : bad(`private IP(s) in payload: ${ips.slice(0, 3).join(', ')}`);
  hosts.length === 0
    ? ok('no device hostnames in the payload')
    : bad(`hostname(s) in payload: ${hosts.slice(0, 3).join(', ')}`);
}

main()
  .catch((e) => bad(`verification could not run: ${e.message}`))
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\nFAILED: ${failures.length} check(s). The previous container is still the`);
      console.error(`one you want — roll back with: docker rollout / redeploy the prior image.`);
      process.exit(1);
    }
    console.log(`\nOK — ${base} is healthy and leaking nothing.`);
  });
