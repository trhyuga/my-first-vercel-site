#!/usr/bin/env bash
# Refresh the local opencv.js bundle that the 整形プレビュー / 自動整形
# path in pdf/images-to-pdf/index.html loads first (same-origin, no CDN
# roundtrip). The CDN URLs in the loader are now fallbacks; this script
# keeps the local copy current with upstream stable.
#
# Usage:  bash update-opencv.sh
# Result: writes ./opencv.js (~10 MB) and prints its size for verification.
# Then:   git add opencv.js && git commit -m "..." && git push.

set -euo pipefail

cd "$(dirname "$0")"

# Pick the version we want to mirror. Bump this when a newer stable
# build is released (https://docs.opencv.org/<version>/opencv.js).
VERSION="${OPENCV_JS_VERSION:-4.10.0}"
URL="https://docs.opencv.org/${VERSION}/opencv.js"
OUT="opencv.js"

echo "→ downloading ${URL}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# -f: fail on HTTP error, -L: follow redirects, --retry: be resilient
curl -fL --retry 3 --retry-delay 2 -o "$TMP" "$URL"

# Sanity check: file should be > 1 MB and start with a JS-ish byte
size=$(stat -c%s "$TMP" 2>/dev/null || stat -f%z "$TMP")
if [ "$size" -lt 1000000 ]; then
  echo "✗ downloaded file is suspiciously small ($size bytes); aborting"
  exit 1
fi
head -c 10 "$TMP" | grep -qE '^(var|let|const|/\*|//|function|\(function)' \
  || { echo "✗ downloaded file does not look like JavaScript; aborting"; exit 1; }

mv "$TMP" "$OUT"
trap - EXIT
echo "✓ wrote $OUT ($(numfmt --to=iec --suffix=B "$size" 2>/dev/null || echo "$size bytes"))"
echo "  (commit this file so Vercel serves it as the local fallback)"
