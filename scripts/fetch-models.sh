#!/usr/bin/env bash
# Fetch model assets too large for git (sha256-pinned). Run once per clone;
# release CI runs it before tauri build. Windows runners execute this via git-bash.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri/models"

CLIP_SHA="92ee3ff3cf2333bd927d94a5bf2a79a08e24ae2c5162c8f35be5bd24038d322c"
FILE="clip_vitb32_visual.onnx"
URL="https://github.com/OliverSogaard/cull/releases/download/models-v1/$FILE"

have_sha() { [ -f "$FILE" ] && shasum -a 256 "$FILE" 2>/dev/null | grep -q "^$CLIP_SHA " ; }

if have_sha; then
  echo "$FILE already present and verified"
  exit 0
fi

cleanup_tmp() { rm -f "$FILE.tmp"; }
trap cleanup_tmp EXIT

echo "downloading $FILE ..."
curl -fL --retry 3 -o "$FILE.tmp" "$URL"
echo "$CLIP_SHA  $FILE.tmp" | shasum -a 256 -c -
mv "$FILE.tmp" "$FILE"
echo "$FILE fetched and verified"
