#!/usr/bin/env bash
#
# The cold-start test loop, without a release: stage the locally-built
# app for a throwaway macOS account whose keychain, ~/.fez, and webview
# storage are all genuinely fresh. Re-running this script resets the
# account, so onboarding can be experienced as many times as it takes.
#
#   bash scripts/fresh-user.sh            # reset account + stage last build
#   bash scripts/fresh-user.sh --build    # signed build first, then stage
#
# Then: Apple menu →  Log Out / fast-user-switch → "feztest" (password:
# fez), open /Users/Shared/fez-fresh.dmg, drag to Applications, launch.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(dirname "$HERE")"
USER_NAME="feztest"
STAGE="/Users/Shared/fez-fresh.dmg"

if [[ "${1:-}" == "--build" ]]; then
  bash "$HERE/build-signed.sh"
fi

VERSION=$(node -p "require('$PKG/src-tauri/tauri.conf.json').version")
DMG="$PKG/src-tauri/target/release/bundle/dmg/fez_${VERSION}_aarch64.dmg"
[[ -f "$DMG" ]] || { echo "✗ no built dmg at $DMG — run with --build"; exit 1; }

echo "▸ staging $DMG → $STAGE"
cp "$DMG" "$STAGE"
chmod a+r "$STAGE"

# Localhost ports are machine-global: a relay from THIS account still
# listening on 7777 would be silently adopted by the test account's app
# — the "my old fez popped up" failure. Quit fez here, and down the relay.
echo "▸ stopping this account's fez relay (quit the fez app too, if open)"
pkill -f '\.fez/bin/fez-relay' 2>/dev/null || true

echo "▸ resetting macOS account '$USER_NAME' (sudo will prompt)"
sudo sysadminctl -deleteUser "$USER_NAME" 2>/dev/null || true
sudo sysadminctl -addUser "$USER_NAME" -fullName "fez test" -password fez
echo
echo "✓ fresh account ready."
echo "  1. Fast-user-switch to 'feztest' (password: fez)"
echo "  2. Open $STAGE, drag fez to Applications, launch"
echo "  3. Switch back when done — re-run this script to reset"
