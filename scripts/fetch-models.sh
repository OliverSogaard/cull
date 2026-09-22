#!/usr/bin/env bash
# Fetch model assets kept out of git (sha256-pinned). Run once per clone;
# release CI runs it before tauri build. Windows runners execute this via git-bash.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri/models"

# macOS ships shasum, Git Bash on the Windows runner ships sha256sum; either
# prints "<hex>  <file>".
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }

RELEASE_URL="https://github.com/OliverSogaard/cull/releases/download/models-v1"

# name<space>sha256 — one line per release-hosted model.
MODELS="\
clip_vitb32_visual.onnx 92ee3ff3cf2333bd927d94a5bf2a79a08e24ae2c5162c8f35be5bd24038d322c
dinov2s.onnx bc2bbab71ee5fceee6220cc6efd56177b96f6b9ba93860f3508a2de2ba49afb2"

fetch_one() {
  local file="$1" sha="$2"
  if [ -f "$file" ] && sha256 "$file" 2>/dev/null | grep -q "^$sha "; then
    echo "$file already present and verified"
    return 0
  fi
  echo "downloading $file ..."
  rm -f "$file.tmp"
  if ! curl -fL --retry 3 -o "$file.tmp" "$RELEASE_URL/$file" ||
    ! sha256 "$file.tmp" | grep -q "^$sha "; then
    rm -f "$file.tmp"
    return 1
  fi
  mv "$file.tmp" "$file"
  echo "$file fetched and verified"
}

while read -r name sha; do
  fetch_one "$name" "$sha"
done <<<"$MODELS"
