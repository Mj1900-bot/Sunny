#!/usr/bin/env bash
# doctor.sh — one-shot sanity check for SUNNY's build + runtime deps.
# Prints `OK` / `MISS` for each entry. Exits 0 even if things are missing;
# the caller reads the output.
set -u

pass() { printf "  OK   %-28s %s\n" "$1" "${2:-}"; }
fail() { printf "  MISS %-28s %s\n" "$1" "${2:-}"; MISSING=$((MISSING+1)); }

MISSING=0
REPO_ROOT="/Users/sunny/Sunny Ai"
TAURI_CONF="$REPO_ROOT/src-tauri/tauri.conf.json"

echo "SUNNY doctor"
echo "-----------"

# Required
command -v pnpm          >/dev/null 2>&1 && pass pnpm          "$(pnpm --version 2>/dev/null)"          || fail pnpm          "install Node 20+ and pnpm"
command -v rustc         >/dev/null 2>&1 && pass rustc         "$(rustc --version 2>/dev/null)"         || fail rustc         "rustup default stable"
xcode-select -p          >/dev/null 2>&1 && pass xcode-clt     "$(xcode-select -p 2>/dev/null)"         || fail xcode-clt     "xcode-select --install"

# Voice pipeline
command -v whisper-cli   >/dev/null 2>&1 && pass whisper-cli   "$(command -v whisper-cli)"              || fail whisper-cli   "brew install whisper-cpp"
command -v tesseract     >/dev/null 2>&1 && pass tesseract     "$(tesseract --version 2>&1 | head -1)"  || fail tesseract     "brew install tesseract"
[ -x "$HOME/.local/bin/koko" ]                        && pass koko              "$HOME/.local/bin/koko" || fail koko              "install koko CLI (see README)"
[ -f "$HOME/.cache/kokoros/kokoro-v1.0.onnx" ]        && pass kokoro-model      "found"                 || fail kokoro-model      "download kokoro-v1.0.onnx"
[ -f "$HOME/.cache/kokoros/voices-v1.0.bin" ]         && pass kokoro-voices     "found"                 || fail kokoro-voices     "download voices-v1.0.bin"

# Optional backends
command -v ollama        >/dev/null 2>&1 && pass ollama        "$(ollama --version 2>&1 | head -1)"     || fail ollama        "brew install ollama (optional)"
command -v openclaw      >/dev/null 2>&1 && pass openclaw      "$(command -v openclaw)"                 || fail openclaw      "npm i -g openclaw (optional)"

# Signing identity from tauri.conf.json
if [ -f "$TAURI_CONF" ]; then
  IDENTITY=$(/usr/bin/plutil -extract bundle.macOS.signingIdentity raw -o - "$TAURI_CONF" 2>/dev/null || true)
  if [ -n "$IDENTITY" ] && [ "$IDENTITY" != "null" ]; then
    pass signing-identity "$IDENTITY"
  else
    fail signing-identity "set bundle.macOS.signingIdentity in tauri.conf.json"
  fi
else
  fail signing-identity "tauri.conf.json not found at $TAURI_CONF"
fi

echo "-----------"
if [ "$MISSING" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$MISSING item(s) missing. See README Prerequisites for install steps."
fi
