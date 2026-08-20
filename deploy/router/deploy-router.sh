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
node --check deploy/router/gateway.mjs
echo "   gateway parses"

echo "── shipping to $TARGET"
scp -q deploy/router/gateway.mjs "$TARGET:/opt/fez-router/gateway.mjs.new"
scp -q deploy/router/fez-router.service "$TARGET:/etc/systemd/system/fez-router.service"
scp -q deploy/router/fez-router-gateway.service "$TARGET:/etc/systemd/system/fez-router-gateway.service"

ssh "$TARGET" bash -euo pipefail <<'REMOTE'
  [ -f /opt/fez-router/gateway.mjs ] && cp /opt/fez-router/gateway.mjs /opt/fez-router/gateway.mjs.prev
  mv /opt/fez-router/gateway.mjs.new /opt/fez-router/gateway.mjs
  chown fezrouter:fezrouter /opt/fez-router/gateway.mjs

  systemctl daemon-reload
  systemctl enable fez-router fez-router-gateway >/dev/null 2>&1 || true
  systemctl restart fez-router
  systemctl restart fez-router-gateway

  for unit in fez-router fez-router-gateway; do
    systemctl is-active --quiet "$unit" || {
      echo "   $unit FAILED TO START"; journalctl -u "$unit" -n 25 --no-pager; exit 1;
    }
  done
  echo "   both units active"

  # "active" only means systemd started the process. llama-server accepts
  # connections while it is still mapping 400 MB of weights and answers
  # 503 "Loading model" until it isn't — so wait for the model to be
  # LISTED, not for a fixed number of seconds. Sleeping and hoping is how
  # a deploy reports success against a router that can't route yet.
  echo "── waiting for the model to load"
  for i in $(seq 1 60); do
    if curl -sf http://127.0.0.1:8081/v1/models 2>/dev/null | grep -q '"id"'; then
      echo "   model ready after ${i}s"
      break
    fi
    [ "$i" = "60" ] && { echo "   MODEL NEVER LOADED"; journalctl -u fez-router -n 25 --no-pager; exit 1; }
    sleep 1
  done

  # An active unit is not a working router. Ask it to route something and
  # require a tool call back — this is the check that catches a bad model
  # file, a template that doesn't do tool calling, and a gateway clamp
  # that rejects its own traffic.
  echo "── routing self-test"
  model=$(curl -sf http://127.0.0.1:8081/v1/models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data[0].id)}catch{console.log("")}})')
  [ -n "$model" ] || { echo "   NO MODEL LISTED"; exit 1; }
  echo "   model: $model"

  picked=$(curl -sf http://127.0.0.1:8081/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"tool_choice\":\"required\",\"temperature\":0,
         \"messages\":[
           {\"role\":\"system\",\"content\":\"You are a router. Call exactly one function to pick who should handle the user's request. Do not write any prose. Do not answer the request yourself. If no function fits, call nobody.\"},
           {\"role\":\"user\",\"content\":\"can you take a look at my pull request\"}],
         \"tools\":[
           {\"type\":\"function\",\"function\":{\"name\":\"reviewer\",\"description\":\"review code, critique pull requests, give feedback on changes\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},
           {\"type\":\"function\",\"function\":{\"name\":\"deployer\",\"description\":\"deploy, ship, release, roll out builds to production\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).choices[0].message.tool_calls[0].function.name)}catch{console.log("")}})')

  [ "$picked" = "reviewer" ] || { echo "   SELF-TEST FAILED — expected reviewer, got '${picked:-<nothing>}'"; exit 1; }
  echo "   routed correctly → $picked"
REMOTE

echo "── done"
