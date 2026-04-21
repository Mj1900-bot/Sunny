#!/usr/bin/env bash
# Rebuilds the Sunny .app bundle and replaces the Desktop alias so double-clicking
# always launches the freshest build. Works with iCloud Desktop sync.
#
# Uses AppleScript for both delete + create so Finder stays in sync with the
# filesystem and iCloud can't race us into spawning duplicate aliases.
set -euo pipefail

REPO="/Users/sunny/Sunny Ai"
APP="$REPO/src-tauri/target/release/bundle/macos/Sunny.app"
ICLOUD_DESKTOP="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop"

if [ ! -d "$APP" ]; then
  echo "Sunny.app not found at $APP — run 'pnpm tauri build --bundles app' first." >&2
  exit 1
fi

# Step 1: remove every existing Sunny alias via Finder so icon cache updates too.
osascript <<'OSA' >/dev/null 2>&1 || true
tell application "Finder"
  repeat
    set existing to (every item of desktop whose name is "Sunny")
    if (count of existing) is 0 then exit repeat
    repeat with it in existing
      delete it
    end repeat
  end repeat
end tell
OSA

# Belt-and-braces: remove any filesystem stragglers too.
rm -f "$HOME/Desktop/Sunny"
[ -d "$ICLOUD_DESKTOP" ] && rm -f "$ICLOUD_DESKTOP/Sunny"

# Let iCloud settle so it doesn't resurrect a stale copy before we create the new one.
sleep 0.5

# Step 2: create a single fresh alias pointing at the freshly built bundle.
osascript <<OSA
tell application "Finder"
  set targetApp to POSIX file "$APP" as alias
  set newAlias to make alias file to targetApp at desktop
  set name of newAlias to "Sunny"
end tell
OSA

echo "Desktop alias refreshed → $APP"
