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
# The updater configuration is also the publication destination, so the
# feed cannot point somewhere different from the files we upload.
RELEASE_REPO=$(node -e '
  const config = require(process.argv[1]);
  const endpoint = config.plugins.updater.endpoints[0];
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/latest\.json$/.exec(endpoint);
  if (!match) throw new Error("updater endpoint must be a GitHub release feed");
  console.log(match[1]);
' "$PKG/src-tauri/tauri.conf.json")
[[ $(gh repo view "$RELEASE_REPO" --json visibility --jq .visibility) == PUBLIC ]] || {
  echo "✗ release destination must be public: $RELEASE_REPO"; exit 1;
}
RELEASE_URL="https://github.com/$RELEASE_REPO"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/fez-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

echo "▸ releasing fez $TAG to $RELEASE_REPO"
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
cp "$TARGZ" "$STAGE/$ASSET_TARGZ"

cat > "$STAGE/latest.json" <<EOF
{
  "version": "$VERSION",
  "notes": "$RELEASE_URL/releases/tag/$TAG",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$(cat "$SIG")",
      "url": "$RELEASE_URL/releases/download/$TAG/$ASSET_TARGZ"
    }
  }
}
EOF

# A stable-named copy of the DMG rides every release so fez.chat's
# download button can point at releases/latest/download/fez-macos-arm64.dmg
# forever — the versioned name would break the link on every cut.
cp "$DMG" "$STAGE/fez-macos-arm64.dmg"

echo "▸ creating GitHub release $TAG"
# Create the tag in the downloads repository. Never push the source
# repository's tag/history or generate public notes from private commits.
# gh creates an implicit draft and publishes only after every upload;
# its failure cleanup and release-ID binding also make retries safe.
gh release create "$TAG" \
  --repo "$RELEASE_REPO" \
  --latest \
  --title "fez $VERSION" \
  --notes "Signed and notarized Fez for macOS 13 or later (Apple silicon). Open the DMG and drag Fez into Applications. Versions before 0.4.27 need one manual install to switch to the public update channel." \
  "$DMG" "$STAGE/$ASSET_TARGZ" "$STAGE/latest.json" "$STAGE/fez-macos-arm64.dmg"
echo "✓ released: $(gh release view "$TAG" --repo "$RELEASE_REPO" --json url -q .url)"
