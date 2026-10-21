#!/bin/bash
# One-shot: rebuild cat-jam (+ the separate JP romanizer extension), apply Spicetify, then re-strip the
# XPUI version gate (spicetify apply re-extracts a fresh xpui that reintroduces the gate). Use this
# instead of a bare `spicetify apply` so the konsol fix is never lost.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CFG="$(spicetify -c)"
EXT_DIR="$(dirname "$CFG")/Extensions"

npm run build   # main extension → Extensions/cat-jam.js

# Japanese romanizer: a SEPARATE extension built with OUR OWN esbuild. kuroshiro/kuromoji must NOT go
# through spicetify-creator's bundler (it mangles their CJS/ESM interop and crashes the whole extension).
# As its own isolated script it can never take down cat-jam.js; it registers window.__catjamJa and lazily
# downloads + IndexedDB-caches the ~10MB dictionary on first use (offline thereafter).
npx esbuild src/ja/entry.ts --bundle --format=iife --platform=browser --minify \
  --outfile="$EXT_DIR/catjam-ja-romanizer.js"

# Register the JP extension once (idempotent).
if ! grep -qE '^extensions.*catjam-ja-romanizer\.js' "$CFG"; then
  spicetify config extensions catjam-ja-romanizer.js
fi

spicetify apply
bash "$DIR/spicetify-konsol-fix.sh"
