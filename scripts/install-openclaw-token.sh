#!/usr/bin/env bash
# Store the OpenClaw gateway bearer token in the macOS Keychain so SUNNY can
# authenticate to the OpenClaw gateway regardless of how the app is launched
# (Finder, Dock, cargo tauri dev, etc.).
#
# A Tauri .app started from Finder inherits only the launchd user environment,
# NOT shell env from ~/.zshenv or ~/.zshrc — so a plain
# `export OPENCLAW_GATEWAY_TOKEN=...` in your shell profile is invisible to
# Sunny.app at runtime.  Instead we stash the token in the Keychain under
# service "sunny-openclaw-token" and let the bridge read it via
# /usr/bin/security at startup (see src-tauri/src/openclaw_bridge.rs).
#
# Usage:
#   scripts/install-openclaw-token.sh <token>
#
# To find the token:
#   openclaw config get gateway.token
#   — or check ~/.openclaw/config.json for the "token" field.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <gateway-token>" >&2
  echo "" >&2
  echo "Find your token: openclaw config get gateway.token" >&2
  exit 2
fi

TOKEN="$1"

if [ -z "${TOKEN}" ]; then
  echo "error: token must not be empty" >&2
  exit 2
fi

SERVICE="sunny-openclaw-token"

# Remove any previous entry so -U updates cleanly even if ACLs have drifted.
security delete-generic-password -a "$USER" -s "$SERVICE" >/dev/null 2>&1 || true
security add-generic-password \
  -a "$USER" \
  -s "$SERVICE" \
  -w "$TOKEN" \
  -U \
  -D "SUNNY OpenClaw gateway token" \
  -j "Created by SUNNY HUD — run scripts/install-openclaw-token.sh to update"

echo "OK — stored in Keychain under service '${SERVICE}'"
echo ""
echo "Sunny will pick it up on next launch (or when configure_from_env() is called)."
echo ""
echo "Verify:"
echo "  security find-generic-password -s ${SERVICE} -w"
echo ""
echo "Optional — also export via launchd so OTHER apps inherit it:"
echo "  launchctl setenv OPENCLAW_GATEWAY_TOKEN \"\$(security find-generic-password -s ${SERVICE} -w)\""
