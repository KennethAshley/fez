#!/usr/bin/env bash
#
# Ship the gateway and the units, then prove the endpoint actually
# routes. Separate from provision-router.sh so a policy change never
# touches system setup.
#
#   deploy/router/deploy-router.sh root@<ip>
#
# The gateway is one dependency-free file, same contract as the relay:
# the box needs Node and a directory, and nothing on it can drift from
# what's in this repo.
set -euo pipefail

TARGET="${1:?usage: deploy-router.sh user@host}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "── smoke test (locally, before it can break anything)"
gateway_bundle="$(mktemp "${TMPDIR:-/tmp}/fez-router.XXXXXX")"
trap 'rm -f "$gateway_bundle"' EXIT
npx --no-install esbuild deploy/router/gateway.mjs --bundle --format=esm --platform=node --outfile="$gateway_bundle"
node --check --input-type=module < "$gateway_bundle"
echo "   bundled gateway parses"

echo "── shipping to $TARGET"
scp -q "$gateway_bundle" "$TARGET:/opt/fez-router/gateway.mjs.new"
scp -q deploy/router/fez-router.service "$TARGET:/etc/systemd/system/fez-router.service"
scp -q deploy/router/fez-router-gateway.service "$TARGET:/etc/systemd/system/fez-router-gateway.service"

ssh "$TARGET" bash -euo pipefail <<'REMOTE'
  rollback() {
    local status=$?
    [ "$status" -eq 0 ] && return
    echo "   deployment failed; restoring previous gateway"
    if [ -f /opt/fez-router/gateway.mjs.prev ]; then
      cp /opt/fez-router/gateway.mjs.prev /opt/fez-router/gateway.mjs
      systemctl restart fez-router-gateway
    fi
  }
  [ -f /opt/fez-router/gateway.mjs ] && cp /opt/fez-router/gateway.mjs /opt/fez-router/gateway.mjs.prev
  trap rollback EXIT
  mv /opt/fez-router/gateway.mjs.new /opt/fez-router/gateway.mjs
  chown fezrouter:fezrouter /opt/fez-router/gateway.mjs

  systemctl daemon-reload
  systemctl enable fez-router fez-router-gateway >/dev/null 2>&1 || true
  systemctl start fez-router
  systemctl restart fez-router-gateway

  for unit in fez-router fez-router-gateway; do
    systemctl is-active --quiet "$unit" || {
      echo "   $unit FAILED TO START"; journalctl -u "$unit" -n 25 --no-pager; exit 1;
    }
  done
  echo "   both units active"

  # Verify the local fallback is ready separately: /models on a TypeSafe
  # gateway deliberately does not depend on the local model being up.
  node --input-type=module <<'NODE'
import { setTimeout as sleep } from "node:timers/promises";
try { process.loadEnvFile("/etc/fez-router.env"); } catch (e) { if (e.code !== "ENOENT") throw e; }
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch("http://127.0.0.1:8080/v1/models", { signal: AbortSignal.timeout(1000) });
    if (r.ok && (await r.json()).data?.[0]?.id) { ready = true; break; }
  } catch { /* loading */ }
  await sleep(1000);
}
if (!ready) throw new Error("Local fallback model did not become ready");
// systemd reports the gateway unit "active" as soon as the process is
// spawned, not once it's bound its port — restart + is-active can race
// ahead of the gateway's own startup. Poll /health instead of assuming.
let gatewayReady = false;
for (let i = 0; i < 15; i++) {
  try {
    const r = await fetch("http://127.0.0.1:8081/health", { signal: AbortSignal.timeout(1000) });
    if (r.ok) { gatewayReady = true; break; }
  } catch { /* starting */ }
  await sleep(500);
}
if (!gatewayReady) throw new Error("Gateway did not become ready on :8081");
const headers = { "Content-Type": "application/json",
  ...(process.env.ROUTER_API_KEY ? { Authorization: `Bearer ${process.env.ROUTER_API_KEY}` } : {}) };
const tools = [
  { name: "reviewer", description: "review code, critique pull requests, give feedback on changes" },
  { name: "deployer", description: "deploy, ship, release, roll out builds to production" },
].map(f => ({ type: "function", function: { ...f, parameters: { type: "object", properties: {} } } }));
const r = await fetch("http://127.0.0.1:8081/v1/chat/completions", {
  method: "POST", headers, signal: AbortSignal.timeout(35000),
  body: JSON.stringify({ model: "fez-router", tool_choice: "required",
    messages: [{ role: "user", content: "can you take a look at my pull request" }], tools }),
});
if (!r.ok) throw new Error(`Routing self-test HTTP ${r.status}`);
const body = await r.json();
if (body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name !== "reviewer") {
  throw new Error("Routing self-test did not select reviewer");
}
const backend = r.headers.get("x-fez-router-backend");
if (process.env.TYPESAFE_API_KEY && backend !== "typesafe") throw new Error("TypeSafe self-test fell back to local model");
console.log(`   routed correctly via ${backend ?? "local"}`);
NODE

REMOTE

echo "── done"
