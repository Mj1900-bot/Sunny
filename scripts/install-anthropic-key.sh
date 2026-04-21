#!/usr/bin/env bash
# Store an Anthropic API key in the macOS Keychain so SUNNY can read it
# regardless of how the app is launched (Finder, Dock, cargo tauri dev, etc.).
#
# A Tauri .app started from Finder inherits only the launchd user environment,
# NOT the shell env from ~/.zshenv or ~/.zshrc — so plain `export ANTHROPIC_API_KEY=...`
# in your shell profile is invisible to Sunny.app. Instead we stash the secret in
# the Keychain under service "sunny-anthropic-api-key" and let the Rust side
# (src-tauri/src/secrets.rs) read it via /usr/bin/security at startup.
#
# Usage: scripts/install-anthropic-key.sh <sk-ant-...>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <sk-ant-...>" >&2
  exit 2
fi

KEY="$1"

if [[ ! "$KEY" =~ ^sk- ]]; then
  echo "key does not look like an Anthropic API key (no sk- prefix)" >&2
  exit 2
fi

# Remove any previous entry so -U updates cleanly even if ACLs drifted.
security delete-generic-password -a "$USER" -s "sunny-anthropic-api-key" >/dev/null 2>&1 || true
security add-generic-password \
  -a "$USER" \
  -s "sunny-anthropic-api-key" \
  -w "$KEY" \
  -U

echo "OK — stored in Keychain under service 'sunny-anthropic-api-key'"
echo ""
echo "Sunny will pick it up on next launch."
echo ""
echo "Optional — also export to the launchd user env (so OTHER apps inherit it):"
echo "  cp scripts/ai.kinglystudio.sunny.env.plist.template \\"
echo "     ~/Library/LaunchAgents/ai.kinglystudio.sunny.env.plist"
echo "  launchctl bootstrap gui/\$UID ~/Library/LaunchAgents/ai.kinglystudio.sunny.env.plist"
echo ""
echo "Verify:"
echo "  security find-generic-password -s sunny-anthropic-api-key -w"
