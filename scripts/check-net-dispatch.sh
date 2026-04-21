#!/usr/bin/env bash
# Enforces the browser module's "one-dispatcher" invariant: no Rust file
# outside `src-tauri/src/browser/transport.rs` may construct a
# `reqwest::Client` or call `reqwest::Proxy::all`. New network primitives
# go through `browser::dispatcher::Dispatcher::fetch`.
#
# Pre-existing call sites in other modules (e.g. `web.rs`, `worldinfo.rs`,
# `ai.rs`) are grandfathered via the `# ALLOWED` exception list below; the
# phased migration plan converts them one at a time so the browser module
# is the single network primitive eventually.
#
# Run: ./scripts/check-net-dispatch.sh
# CI: set SUNNY_NET_DISPATCH_STRICT=1 to fail on any new regression.

set -euo pipefail

cd "$(dirname "$0")/.."

ALLOWED=(
  "src-tauri/src/browser/transport.rs"
  # Legacy call sites — migrating to dispatcher in follow-up PRs.
  "src-tauri/src/web.rs"
  "src-tauri/src/worldinfo.rs"
  "src-tauri/src/ai.rs"
  "src-tauri/src/voice.rs"
  "src-tauri/src/audio.rs"
  "src-tauri/src/messaging.rs"
  "src-tauri/src/http.rs"
  "src-tauri/src/mail.rs"
  "src-tauri/src/reminders.rs"
  "src-tauri/src/calendar.rs"
  "src-tauri/src/notes_app.rs"
  "src-tauri/src/messages.rs"
  "src-tauri/src/messages_watcher.rs"
  "src-tauri/src/contacts_book.rs"
  "src-tauri/src/notify.rs"
  "src-tauri/src/tools_web.rs"
  "src-tauri/src/tools_weather.rs"
  "src-tauri/src/tools_browser.rs"
  "src-tauri/src/scan"
)

# Build a grep -v filter covering the allowed paths.
FILTER=""
for p in "${ALLOWED[@]}"; do
  FILTER+="${FILTER:+|}${p}"
done

PATTERN='reqwest::Client::builder|reqwest::Proxy::all|reqwest::Client::new'

# rg gives consistent output across macOS/Linux (grep on mac is BSD).
hits=$(rg --no-heading --line-number --type rust "$PATTERN" src-tauri/src || true)
if [[ -z "$hits" ]]; then
  echo "check-net-dispatch: no reqwest::Client constructions anywhere (surprising but OK)."
  exit 0
fi

violations=$(echo "$hits" | grep -Ev "^($FILTER)" || true)
if [[ -z "$violations" ]]; then
  echo "check-net-dispatch: OK — all reqwest::Client sites are inside the allow-list."
  exit 0
fi

echo "check-net-dispatch: disallowed reqwest client constructions detected:"
echo "$violations"
echo ""
echo "Route the call through browser::dispatcher::Dispatcher::fetch instead,"
echo "or add the file to the ALLOWED list with a migration plan."

if [[ "${SUNNY_NET_DISPATCH_STRICT:-0}" == "1" ]]; then
  exit 1
fi
