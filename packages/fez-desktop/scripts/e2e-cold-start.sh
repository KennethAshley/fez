#!/usr/bin/env bash
#
# Drive the FULL cold start on a real test machine over SSH and verify
# against the relay's actual event store — the composition test that
# headless evals cannot be: real Tauri invokes, real bundle install,
# real desktop-managed agent turns. Run FROM the dev machine:
#
#   bash scripts/e2e-cold-start.sh [host]     # default ken@100.90.101.74
#
# What it does: build the .app (adhoc-signed — rsync sets no quarantine,
# so Gatekeeper doesn't block it), replace /Applications/fez.app on the
# target, reset the target to fez-never-ran, seed an identity + a @fez
# persona (simulating a completed onboarding with the brain chosen),
# launch, then poll the relay store until the whole #welcome choreography
# has demonstrably happened in bootstrap-welcome — real Tauri invokes,
# real bundle install, real desktop-managed agent turns (the app spawns
# fez/drift/quill itself; no sentinel in the GUI path) — or dump every
# log when it hasn't.
set -euo pipefail

HOST="${1:-ken@100.90.101.74}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(dirname "$HERE")"
SSH=(ssh -o ConnectTimeout=5 -o BatchMode=yes "$HOST")


echo "▸ building fez.app (no notarization — E2E only)"
# The updater plugin insists on its signing key even for an app-only
# build; same custody build-signed.sh uses.
export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$(security find-generic-password -s fez-notary -a updater-key -w 2>/dev/null || true)}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
(cd "$PKG" && npx tauri build --bundles app 2>&1 | tail -2)
APP="$PKG/src-tauri/target/release/bundle/macos/fez.app"
[[ -d "$APP" ]] || { echo "✗ no app at $APP"; exit 1; }

echo "▸ replacing /Applications/fez.app on $HOST"
"${SSH[@]}" 'osascript -e "quit app \"fez\"" 2>/dev/null; sleep 1; rm -rf /Applications/fez.app'
rsync -a --delete "$APP" "$HOST":/Applications/

echo "▸ resetting target + seeding identity and brain choice"
scp -q "$HERE/reset-machine.sh" "$HOST":/tmp/reset-machine.sh
"${SSH[@]}" 'bash /tmp/reset-machine.sh --yes' >/dev/null
# The brain: the Built-in path (pi + Chutes), because it's fully
# seedable — the Chutes key comes from THIS machine's keychain, while a
# Claude login can only be performed by the account's human. Same
# choreography either way.
SEED_HEX=$(python3 -c "import secrets; print(secrets.token_hex(32))")
CHUTES_KEY=$(security find-generic-password -s fez-skill-env -a chutes.CHUTES_API_KEY -w)
E2E_MODEL="${E2E_MODEL:-deepseek-ai/DeepSeek-V3.2-TEE}"
E2E_BRAIN="${E2E_BRAIN:-chutes}"   # chutes (fully seedable) | claude (needs `claude /login` on the target once)
# Unlock + seed in ONE remote session: on modern macOS an ssh keychain
# unlock is scoped to its own security session — unlocking in one
# connection and writing in the next fails with "User interaction is
# not allowed" (found the hard way, twice). The login password comes
# from THIS machine's keychain (fez-e2e/mini-login) over ssh stdin.
# -A on the test items: an item created by the security CLI would
# otherwise block the app's boot on an ACL dialog nobody is there to
# click. Production identities are created BY the app.
MINI_PW=$(security find-generic-password -s fez-e2e -a mini-login -w)
printf '%s\n' "$MINI_PW" | "${SSH[@]}" "IFS= read -r PW
security unlock-keychain -p \"\$PW\" ~/Library/Keychains/login.keychain-db || exit 1
security set-keychain-settings ~/Library/Keychains/login.keychain-db
echo '  keychain unlocked (auto-lock off)'
security add-generic-password -A -s fez-keys -a default -w $SEED_HEX
security add-generic-password -A -s fez-skill-env -a chutes.CHUTES_API_KEY -w '$CHUTES_KEY'
mkdir -p ~/.fez/personas ~/.pi/agent
cat > ~/.pi/agent/local-models.json <<PI
[{\"id\":\"56105ece7a\",\"name\":\"Chutes\",\"baseUrl\":\"https://llm.chutes.ai/v1\",\"apiKey\":\"$CHUTES_KEY\",\"status\":\"checking\"}]
PI
if [ "$E2E_BRAIN" = claude ]; then
  # Managed runtime + adapter, exactly the layout managed_node.rs makes
  # (Rust provisioning itself is verified by \`cargo test managed_provision\`).
  if [ ! -x ~/.fez/node-tools/bin/claude-agent-acp ]; then
    mkdir -p ~/.fez/runtimes/node && cd ~/.fez/runtimes/node
    curl -sO https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz
    echo 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1  node-v24.18.0-darwin-arm64.tar.gz' | shasum -a 256 -c - >/dev/null
    tar -xzf node-v24.18.0-darwin-arm64.tar.gz && mkdir -p v24.18.0 && rm -rf v24.18.0/darwin-arm64 && mv node-v24.18.0-darwin-arm64 v24.18.0/darwin-arm64 && rm node-v24.18.0-darwin-arm64.tar.gz
    PATH=~/.fez/runtimes/node/v24.18.0/darwin-arm64/bin:\$PATH ~/.fez/runtimes/node/v24.18.0/darwin-arm64/bin/npm install -g --prefix ~/.fez/node-tools @agentclientprotocol/claude-agent-acp@0.70.0 --no-fund --no-audit >/dev/null
  fi
  cat > ~/.fez/personas/fez.md <<MD
---
harness: claude-code
aliases: [orchestrator]
description: your guide to fez — ask how anything works, or hand over a task and the right agent gets it
---
You are @fez, the guide for this fez workspace. Answer questions about fez
plainly; for tasks, name the persona best suited and offer to bring it in.
MD
else
  cat > ~/.fez/personas/fez.md <<MD
---
harness: pi
provider: local-56105ece7a
model: $E2E_MODEL
aliases: [orchestrator]
description: your guide to fez — ask how anything works, or hand over a task and the right agent gets it
---
You are @fez, the guide for this fez workspace. Answer questions about fez
plainly; for tasks, name the persona best suited and offer to bring it in.
MD
fi"

echo "▸ launching fez"
"${SSH[@]}" 'open -a fez'

echo "▸ polling the relay store (up to 4 minutes)…"
DEADLINE=$((SECONDS + 240))
PASS=""
while ((SECONDS < DEADLINE)); do
  sleep 10
  STATE=$("${SSH[@]}" '
    E=~/.fez/relay/events.jsonl
    [[ -f $E ]] || { echo "no-store"; exit 0; }
    # Each grep is scoped to bootstrap-welcome (not bootstrap-general):
    # a marked event carries both the "client" marker tag and the "h"
    # channel tag on the same jsonl line, so chaining a second grep over
    # the channel id confirms it landed in #welcome.
    hello=$(grep "fez-welcome.hello.v1" $E | grep -c "bootstrap-welcome" || true)
    opener=$(grep "fez-welcome.opener.v1" $E | grep -c "bootstrap-welcome" || true)
    notready=$(grep "One thing first" $E | grep -c "bootstrap-welcome" || true)
    team=$(grep "fez-welcome.team.v1" $E | grep -c "bootstrap-welcome" || true)
    kickoff=$(grep "fez-welcome.kickoff.v1" $E | grep -c "bootstrap-welcome" || true)
    # The channel's name lives in the event's CONTENT, which the store
    # holds JSON-escaped (\"name\":\"welcome\") — match the literal
    # backslashes with -F, or this reads 0 against a perfect store.
    channel=$(grep "\"kind\":47101" $E | grep "bootstrap-welcome" | grep -cF '\"name\":\"welcome\"' || true)
    announces=$(grep -c "\"kind\":47000" $E || true)
    speakers=$(grep "\"kind\":47103" $E | grep "bootstrap-welcome" | grep -o "\"pubkey\":\"[0-9a-f]*\"" | sort -u | wc -l | tr -d " ")
    # Managed-agent logs, not a sentinel pidfile: the GUI spawns
    # fez/drift/quill itself now (managed_agents.rs), and a
    # <persona>.desktop.log per starter persona is the spawn witness.
    logs=1
    for f in fez drift quill; do [[ -s ~/.fez/logs/$f.desktop.log ]] || logs=0; done
    personas=$(ls ~/.fez/personas/ 2>/dev/null | tr "\n" ",")
    echo "hello=$hello opener=$opener notready=$notready team=$team kickoff=$kickoff channel=$channel announces=$announces speakers=$speakers logs=$logs personas=$personas"
  ')
  echo "  [$SECONDS s] $STATE"
  if [[ "$STATE" == *"hello=1"* && "$STATE" == *"opener=1"* && "$STATE" == *"notready=0"* \
     && "$STATE" == *"team=1"* && "$STATE" == *"kickoff=1"* && "$STATE" == *"channel=1"* \
     && "$STATE" == *"logs=1"* ]]; then
    # team opener up, ready-variant opener, kickoff posted, #welcome
    # channel present, managed-agent logs alive — now demand REAL
    # intros: ≥3 distinct 47103 speakers (guide + two teammates), i.e.
    # two messages authored by pubkeys that are neither owner nor @fez.
    SPEAKERS=$(sed -n 's/.*speakers=\([0-9]*\).*/\1/p' <<<"$STATE")
    if ((SPEAKERS >= 3)); then PASS=1; break; fi
  fi
done

if [[ -n "$PASS" ]]; then
  echo "✓ PASS — #welcome channel, hello, ready opener, team summoned, real intros, kickoff, managed-agent logs alive."
  exit 0
fi

echo "✗ FAIL — final state above. Logs:"
"${SSH[@]}" '
  echo "--- managed-agent logs:"; for f in fez drift quill; do echo "· $f.desktop.log:"; tail -10 ~/.fez/logs/$f.desktop.log 2>/dev/null; done
  echo "--- relay.log:"; tail -5 ~/.fez/relay/relay.log 2>/dev/null
  echo "--- processes:"; pgrep -fl "fez-agent|claude" | head -5
  echo "--- 47103 contents:"; grep "\"kind\":47103" ~/.fez/relay/events.jsonl 2>/dev/null | python3 -c "import sys,json
for l in sys.stdin:
    e=json.loads(l); print(e[\"pubkey\"][:8], repr(e[\"content\"][:100]))"
'
exit 1
