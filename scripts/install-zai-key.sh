#!/usr/bin/env bash
# Store a z.ai (GLM) API key in the macOS Keychain so SUNNY can read it
# regardless of how the app is launched (Finder, Dock, cargo tauri dev, etc.).
#
# A Tauri .app started from Finder inherits only the launchd user environment,
# NOT the shell env from ~/.zshenv or ~/.zshrc — so plain `export ZAI_API_KEY=...`
# in your shell profile is invisible to Sunny.app. Instead we stash the secret
# in the Keychain under service "sunny-zai-api-key" and let the Rust side
# (src-tauri/src/secrets.rs) read it via /usr/bin/security at startup.
#
# Usage: scripts/install-zai-key.sh <key>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <z.ai-key>" >&2
  exit 2
fi

KEY="$1"

if [[ ${#KEY} -lt 16 ]]; then
  echo "key looks too short to be a real z.ai API key" >&2
  exit 2
fi

# Remove any previous entry so -U updates cleanly even if ACLs drifted.
security delete-generic-password -a "$USER" -s "sunny-zai-api-key" >/dev/null 2>&1 || true
security add-generic-password \
  -a "$USER" \
  -s "sunny-zai-api-key" \
  -w "$KEY" \
  -U

echo "OK — stored in Keychain under service 'sunny-zai-api-key'"
echo ""
echo "Sunny will pick it up on next launch. The agent loop will route"
echo "research / code queries to GLM-5.1 automatically when"
echo "  \"provider\": \"auto\""
echo "is set in ~/.sunny/settings.json."
echo ""
echo "Verify:"
echo "  security find-generic-password -s sunny-zai-api-key -w"
