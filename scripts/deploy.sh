#!/usr/bin/env bash
#
# Deploy to the machine that holds the OrcaSlicer config.
#
# Syncs the source over the LAN and builds there, so nothing leaves the network
# and a deploy costs an incremental rsync rather than a ~167 MB image transfer.
# Verification runs from *this* machine on purpose: a health check made on the
# target itself proves nothing about whether it is actually reachable.
#
#   ./scripts/deploy.sh                 # gates, sync, build, verify
#   ./scripts/deploy.sh --skip-gates    # when you have just run them
#
# Settings come from deploy.env (gitignored) or the environment.

set -euo pipefail
cd "$(dirname "$0")/.."

[ -f deploy.env ] && . ./deploy.env

HOST="${ORCA_HOST:?set ORCA_HOST (e.g. workshop) in deploy.env}"
REMOTE_DIR="${ORCA_REMOTE_DIR:-/home/jon/apps/orca-profiles}"
CONFIG_DIR="${ORCA_CONFIG:?set ORCA_CONFIG to the OrcaSlicer config path on \$ORCA_HOST}"
BIND="${ORCA_BIND:-127.0.0.1}"
PORT="${ORCA_PORT:-8099}"
# Where to reach it *from here* for verification. The bind address unless it is
# loopback, which would only ever answer on the target itself.
VERIFY_URL="${ORCA_VERIFY_URL:-http://${BIND}:${PORT}}"

SKIP_GATES=0
[ "${1:-}" = "--skip-gates" ] && SKIP_GATES=1

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$SKIP_GATES" -eq 0 ]; then
  step "1/5  Gates"
  pnpm gates
else
  step "1/5  Gates — skipped"
fi

step "2/5  Sync → ${HOST}:${REMOTE_DIR}"
ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
# --delete keeps the remote a mirror, so a file removed here does not linger
# there and get built into the next image.
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude dist-cli --exclude dist-server \
  --exclude .git --exclude test-results --exclude playwright-report \
  --exclude e2e/screenshots --exclude 'public/sample-config.json' \
  --exclude deploy.env \
  ./ "$HOST:$REMOTE_DIR/"

# compose reads this; written every deploy so the remote cannot drift from the
# settings this script was run with.
ssh "$HOST" "cat > '$REMOTE_DIR/.env'" <<EOF
ORCA_CONFIG=$CONFIG_DIR
ORCA_BIND=$BIND
ORCA_PORT=$PORT
EOF

step "3/5  Build and start on ${HOST}"
ssh "$HOST" "cd '$REMOTE_DIR' && docker compose up -d --build"

step "4/5  Wait for health"
for i in $(seq 1 30); do
  if curl -fsS -m 5 "${VERIFY_URL}/api/health" >/dev/null 2>&1; then
    echo "  up after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  never became healthy — recent logs:" >&2
    ssh "$HOST" "cd '$REMOTE_DIR' && docker compose logs --tail 40" >&2
    exit 1
  fi
  sleep 1
done

step "5/5  Verify from $(hostname)"
node scripts/verify-deploy.mjs "$VERIFY_URL"

printf '\n\033[1mDeployed:\033[0m %s\n' "$VERIFY_URL"
