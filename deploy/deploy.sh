#!/usr/bin/env bash
#
# Build the relay locally and ship it. Separate from provision.sh so a
# routine deploy never touches system setup.
#
#   deploy/deploy.sh root@67.205.188.204
#
# The relay is bundled to ONE file — no repo clone, no npm install, no
# registry, and nothing on the box that can drift from what was built
# here. The box needs Node and a directory; that's the whole contract.
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "── building"
npx esbuild packages/fez-relay/src/cli.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile=deploy/fez-relay.mjs \
  --banner:js='import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);'

# Refuse to ship something that won't start. Cheap, and it has caught a
# bad bundle before it reached the box.
echo "── smoke test"
node deploy/fez-relay.mjs --help >/dev/null
echo "   bundle runs"

echo "── shipping to $TARGET"
scp -q deploy/fez-relay.mjs "$TARGET:/opt/fez/fez-relay.mjs.new"
scp -q deploy/fez-relay.service "$TARGET:/etc/systemd/system/fez-relay.service"

ssh "$TARGET" bash -euo pipefail <<'REMOTE'
  chown fez:fez /opt/fez/fez-relay.mjs.new
  # Swap in atomically, keeping the previous build for a one-command
  # rollback: mv fez-relay.mjs.prev fez-relay.mjs && systemctl restart.
  [ -f /opt/fez/fez-relay.mjs ] && cp /opt/fez/fez-relay.mjs /opt/fez/fez-relay.mjs.prev
  mv /opt/fez/fez-relay.mjs.new /opt/fez/fez-relay.mjs
  systemctl daemon-reload
  systemctl enable fez-relay >/dev/null 2>&1 || true
  systemctl restart fez-relay
  sleep 2
  systemctl is-active --quiet fez-relay && echo "   relay active" || {
    echo "   RELAY FAILED TO START"; journalctl -u fez-relay -n 20 --no-pager; exit 1;
  }
REMOTE

echo "── done"
