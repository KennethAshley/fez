#!/usr/bin/env bash
#
# Drive the FULL cold start on a real test machine over SSH and verify
# against the relay's actual event store — the composition test that
# headless evals cannot be: real Tauri invokes, real bundle install,
# real sentinel, real agent turns. Run FROM the dev machine:
#
#   bash scripts/e2e-cold-start.sh [host]     # default ken@100.90.101.74
#
# What it does: build the .app (adhoc-signed — rsync sets no quarantine,
# so Gatekeeper doesn't block it), replace /Applications/fez.app on the
# target, reset the target to fez-never-ran, seed an identity + a
# claude-code @fez persona (simulating a completed onboarding with the
# brain chosen), launch, then poll the relay store until the whole first
# minute has demonstrably happened — or dump every log when it hasn't.
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
"${SSH[@]}" "# -A: any app may read these TEST items without a GUI ACL prompt — an
# item created by the security CLI would otherwise block the app's boot
# on an authorization dialog nobody is there to click. Production
# identities are created BY the app and never need this.
security add-generic-password -A -s fez-keys -a default -w $SEED_HEX
security add-generic-password -A -s fez-skill-env -a chutes.CHUTES_API_KEY -w '$CHUTES_KEY'
mkdir -p ~/.fez/personas ~/.pi/agent
cat > ~/.pi/agent/local-models.json <<PI
[{\"id\":\"56105ece7a\",\"name\":\"Chutes\",\"baseUrl\":\"https://llm.chutes.ai/v1\",\"apiKey\":\"$CHUTES_KEY\",\"status\":\"checking\"}]
PI
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
MD"

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
    hello=$(grep -c "fez-welcome.hello.v1" $E || true)
    opener=$(grep -c "fez-welcome.opener.v1" $E || true)
    notready=$(grep -c "One thing first" $E || true)
    team=$(grep -c "fez-welcome.team.v1" $E || true)
    kickoff=$(grep -c "fez-welcome.kickoff.v1" $E || true)
    announces=$(grep -c "\"kind\":47000" $E || true)
    speakers=$(grep "\"kind\":47103" $E | grep -o "\"pubkey\":\"[0-9a-f]*\"" | sort -u | wc -l | tr -d " ")
    personas=$(ls ~/.fez/personas/ 2>/dev/null | tr "\n" ",")
    echo "hello=$hello opener=$opener notready=$notready team=$team kickoff=$kickoff announces=$announces speakers=$speakers personas=$personas"
  ')
  echo "  [$SECONDS s] $STATE"
  if [[ "$STATE" == *"notready=0"* && "$STATE" == *"team=1"* && "$STATE" == *"kickoff=1"* ]]; then
    # team opener up, ready-variant opener, kickoff posted — now demand
    # REAL intros: ≥3 distinct 47103 speakers (guide + two teammates).
    SPEAKERS=$(sed -n 's/.*speakers=\([0-9]*\).*/\1/p' <<<"$STATE")
    if ((SPEAKERS >= 3)); then PASS=1; break; fi
  fi
done

if [[ -n "$PASS" ]]; then
  echo "✓ PASS — claimed workspace, ready opener, team summoned, real intros, kickoff."
  exit 0
fi

echo "✗ FAIL — final state above. Logs:"
"${SSH[@]}" '
  echo "--- sentinel.log:"; tail -15 ~/.fez/logs/sentinel.log 2>/dev/null
  echo "--- agent logs:"; for f in ~/.fez/logs/researcher.log ~/.fez/logs/scribe.log; do echo "· $f:"; tail -10 "$f" 2>/dev/null; done
  echo "--- relay.log:"; tail -5 ~/.fez/relay/relay.log 2>/dev/null
  echo "--- processes:"; pgrep -fl "fez-sentinel|fez-agent|claude" | head -5
  echo "--- 47103 contents:"; grep "\"kind\":47103" ~/.fez/relay/events.jsonl 2>/dev/null | python3 -c "import sys,json
for l in sys.stdin:
    e=json.loads(l); print(e[\"pubkey\"][:8], repr(e[\"content\"][:100]))"
'
exit 1
