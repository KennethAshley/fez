#!/usr/bin/env bash
#
# Build every package and FAIL if any of them failed.
#
# This exists because three packages sat broken for hours behind a grep.
# The build was checked with `grep -i "error TS"` — but esbuild says
# `✘ [ERROR]`, so nothing matched, everything looked green, and the
# built output went stale while the source moved on. A check that can
# only recognize one toolchain's error format is not a check; the exit
# code is the only thing that means anything.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=()
if npm run build >/tmp/fez-build-root.log 2>&1; then
  echo "  ✓ root"
else
  echo "  ✗ root"; tail -5 /tmp/fez-build-root.log; failed+=("root")
fi

for dir in packages/*/; do
  pkg=$(basename "$dir")
  node -e "process.exit(require('./$dir/package.json').scripts?.build ? 0 : 1)" 2>/dev/null || continue
  if (cd "$dir" && npm run build) >"/tmp/fez-build-$pkg.log" 2>&1; then
    echo "  ✓ $pkg"
  else
    echo "  ✗ $pkg"
    grep -iE "✘|error" "/tmp/fez-build-$pkg.log" | head -4
    failed+=("$pkg")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "✗ ${#failed[@]} package(s) failed: ${failed[*]}"
  exit 1
fi
echo
echo "✓ everything builds"
