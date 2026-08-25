#!/usr/bin/env bash
#
# Return THIS machine to a fez-never-ran state, so the next launch shows
# onboarding and runs the full cold start. Destroys the local identity,
# every agent key, the local workspace relay and its events, and the
# app's webview storage. The identity is unrecoverable unless exported
# (Settings → identity backup / `fez keys export`) — hence the prompt.
set -euo pipefail

echo "This wipes fez from this machine: identity keys, agent keys,"
echo "~/.fez (workspace relay + events included), and app storage."
read -r -p "Type 'reset' to proceed: " answer
[[ "$answer" == "reset" ]] || { echo "aborted."; exit 1; }

echo "▸ stopping fez processes"
pkill -x fez 2>/dev/null || true
pkill -f '\.fez/bin/fez-relay' 2>/dev/null || true
pkill -f 'fez agent' 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.fez.sentinel" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.fez.orchestrator" 2>/dev/null || true

echo "▸ removing keychain items (fez-keys, fez-skill-env)"
while security delete-generic-password -s fez-keys >/dev/null 2>&1; do :; done
while security delete-generic-password -s fez-skill-env >/dev/null 2>&1; do :; done

echo "▸ removing ~/.fez and app storage"
rm -rf ~/.fez
rm -rf ~/Library/WebKit/com.fez.desktop \
       ~/Library/Caches/com.fez.desktop \
       "$HOME/Library/Application Support/com.fez.desktop"

echo "✓ fresh. Launch fez to onboard."
