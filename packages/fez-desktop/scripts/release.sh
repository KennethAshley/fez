#!/usr/bin/env bash
#
# Cut a GitHub release: signed+notarized build, updater feed, assets up.
# The updater endpoint is releases/latest/download/latest.json — every
# release MUST carry a latest.json or installed apps stop seeing updates.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(dirname "$HERE")"
VERSION=$(node -p "require('$PKG/src-tauri/tauri.conf.json').version")
TAG="v$VERSION"

echo "▸ releasing fez $TAG"
bash "$HERE/build-signed.sh"

BUNDLE="$PKG/src-tauri/target/release/bundle"
DMG="$BUNDLE/dmg/fez_${VERSION}_aarch64.dmg"
TARGZ="$BUNDLE/macos/fez.app.tar.gz"
SIG="$BUNDLE/macos/fez.app.tar.gz.sig"
for f in "$DMG" "$TARGZ" "$SIG"; do
  [[ -f "$f" ]] || { echo "✗ missing artifact: $f"; exit 1; }
done

# Versioned asset name so old releases' archives never collide.
ASSET_TARGZ="fez_${VERSION}_aarch64.app.tar.gz"
cp "$TARGZ" "/tmp/$ASSET_TARGZ"

cat > /tmp/latest.json <<EOF
{
  "version": "$VERSION",
  "notes": "https://github.com/KennethAshley/fez/releases/tag/$TAG",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$(cat "$SIG")",
      "url": "https://github.com/KennethAshley/fez/releases/download/$TAG/$ASSET_TARGZ"
    }
  }
}
EOF

# A stable-named copy of the DMG rides every release so fez.chat's
# download button can point at releases/latest/download/fez-macos-arm64.dmg
# forever — the versioned name would break the link on every cut.
cp "$DMG" /tmp/fez-macos-arm64.dmg

echo "▸ creating GitHub release $TAG"
gh release create "$TAG" \
  --title "fez $VERSION" \
  --generate-notes \
  "$DMG" "/tmp/$ASSET_TARGZ" /tmp/latest.json /tmp/fez-macos-arm64.dmg
echo "✓ released: $(gh release view "$TAG" --json url -q .url)"
