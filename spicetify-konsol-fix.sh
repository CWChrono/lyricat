#!/bin/bash
# Re-strips the Spotify XPUI "konsol" version gate (a[1]>=2&&a[2]<31?r:) from
# helper/spicetifyWrapper.js. Run AFTER `spicetify apply` — apply re-extracts a fresh
# xpui from the backup, which reintroduces the gate, so this must re-run each time.
# Path-aware (asks spicetify where Spotify is), idempotent, and sudo-free in the normal
# (post-apply, extracted) case.
set -uo pipefail

RAW_STRING='a\[1\]>=2&&a\[2\]<31?r:'

SPOTIFY_RES="$(spicetify config spotify_path 2>/dev/null)"
[ -z "$SPOTIFY_RES" ] && SPOTIFY_RES="/Applications/Spotify.app/Contents/Resources"
APPS_DIR="$SPOTIFY_RES/Apps"

patch_in_place() { # $1 = file to sed
  if ! grep -q "$RAW_STRING" "$1"; then
    echo "konsol-fix: already patched — nothing to do."
    return 0
  fi
  sed -i '' "s/$RAW_STRING//g" "$1" && echo "konsol-fix: patched $1 — restart Spotify."
}

# Normal case: a spicetify-applied Spotify keeps xpui as an extracted folder.
EXTRACTED="$APPS_DIR/xpui/helper/spicetifyWrapper.js"
if [ -f "$EXTRACTED" ]; then
  patch_in_place "$EXTRACTED"
  exit $?
fi

# Fallback: a vanilla Spotify still has the packed xpui.spa — extract, patch, repack.
SPA="$APPS_DIR/xpui.spa"
if [ -f "$SPA" ]; then
  WORK="/tmp/spotify_xpui_patch"
  rm -rf "$WORK"; mkdir -p "$WORK/extracted"
  cp "$SPA" "$WORK/xpui.zip" && unzip -q "$WORK/xpui.zip" -d "$WORK/extracted"
  TARGET="$WORK/extracted/helper/spicetifyWrapper.js"
  if [ ! -f "$TARGET" ]; then echo "konsol-fix: wrapper not found in archive."; rm -rf "$WORK"; exit 1; fi
  if ! grep -q "$RAW_STRING" "$TARGET"; then echo "konsol-fix: already patched."; rm -rf "$WORK"; exit 0; fi
  sed -i '' "s/$RAW_STRING//g" "$TARGET"
  ( cd "$WORK/extracted" && zip -q -r "../xpui_patched.spa" ./* )
  cp "$WORK/xpui_patched.spa" "$SPA" && echo "konsol-fix: patched xpui.spa — restart Spotify."
  rm -rf "$WORK"
  exit 0
fi

echo "konsol-fix: no xpui found under $APPS_DIR"
exit 1
