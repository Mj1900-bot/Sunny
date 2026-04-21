#!/usr/bin/env bash
# Store a Moonshot (Kimi) API key in the macOS Keychain so SUNNY can read it
# regardless of how the app is launched (Finder, Dock, cargo tauri dev, etc.).
#
# A Tauri .app started from Finder inherits only the launchd user environment,
# NOT the shell env from ~/.zshenv or ~/.zshrc — so plain `export MOONSHOT_API_KEY=...`
# in your shell profile is invisible to Sunny.app. Instead we stash the secret
# in the Keychain under service "sunny-moonshot-api-key" and let the Rust side
# (src-tauri/src/secrets.rs) read it via /usr/bin/security at startup.
#
# Moonshot's Kimi K2.6 (released 2026-04-20) is reached via
#   https://api.moonshot.ai/v1/chat/completions
# using Bearer auth. Get a key at https://platform.moonshot.ai
#
# Usage: scripts/install-moonshot-key.sh <key>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <moonshot-key>" >&2
  exit 2
fi

KEY="$1"

if [[ ${#KEY} -lt 16 ]]; then
  echo "key looks too short to be a real Moonshot API key" >&2
  exit 2
fi

# Remove any previous entry so -U updates cleanly even if ACLs drifted.
security delete-generic-password -a "$USER" -s "sunny-moonshot-api-key" >/dev/null 2>&1 || true
security add-generic-password \
  -a "$USER" \
  -s "sunny-moonshot-api-key" \
  -w "$KEY" \
  -U

echo "OK — stored in Keychain under service 'sunny-moonshot-api-key'"
echo ""
echo "Sunny will pick it up on next launch. In the Settings page (Models tab)"
echo "click the 'Z.AI GLM' / 'Ollama (local)' row's 'Kimi K2.6' button to"
echo "switch the active provider to kimi."
echo ""
echo "Verify:"
echo "  security find-generic-password -s sunny-moonshot-api-key -w"
