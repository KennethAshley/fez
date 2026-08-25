#!/usr/bin/env bash
#
# The release build: signed, notarized, stapled. Credentials come from
# the macOS keychain (service "fez-notary" — created by setup-signing.sh),
# never from dotfiles. Run from anywhere; paths are absolute.
#
# Order matters: prepare-pi-agent FIRST (so the bun-compiled binaries
# exist), then codesign them with the JIT entitlements (signatures travel
# with the files into the bundle AND through install_bundled_agent's copy
# to ~/.fez/bin), then `tauri build` — which signs the app, submits to
# Apple's notary service, and staples the ticket.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(dirname "$HERE")"

# The full toolchain, explicitly: a stripped shell PATH once shipped a
# VERSION=none agent-less build without a single error.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
export REQUIRE_PI_AGENT=1

kc() { security find-generic-password -s fez-notary -a "$1" -w; }
export APPLE_SIGNING_IDENTITY="$(kc identity)"
export APPLE_ID="$(kc apple-id)"
export APPLE_PASSWORD="$(kc password)"
export APPLE_TEAM_ID="$(kc team-id)"
# Updater artifact signing (minisign) — key lives in the keychain too.
export TAURI_SIGNING_PRIVATE_KEY="$(kc updater-key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
echo "▸ signing as: $APPLE_SIGNING_IDENTITY"

echo "▸ preparing bundled agent (bun: $(bun --version))"
node "$HERE/prepare-pi-agent.mjs"

echo "▸ signing bundled binaries (hardened runtime + JIT entitlements)"
for bin in "$PKG"/src-tauri/pi-agent/*; do
  [[ -f "$bin" ]] || continue
  file "$bin" | grep -q "Mach-O" || continue
  codesign --force --options runtime --timestamp \
    --entitlements "$PKG/src-tauri/pi-agent-entitlements.plist" \
    --sign "$APPLE_SIGNING_IDENTITY" "$bin"
  echo "  ✓ $(basename "$bin")"
done

echo "▸ tauri build (sign → notarize → staple; notarization takes minutes)"
cd "$PKG"
npm run tauri build

APP="$PKG/src-tauri/target/release/bundle/macos/fez.app"
echo "▸ verifying"
codesign --verify --deep --strict "$APP" && echo "  ✓ codesign verify"
spctl --assess --type execute -vv "$APP" 2>&1 | sed 's/^/  /'
xcrun stapler validate "$APP" | tail -1 | sed 's/^/  /'
ls "$PKG"/src-tauri/target/release/bundle/dmg/*.dmg | sed 's/^/  dmg: /'
echo "✓ signed release build complete"
