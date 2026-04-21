#!/usr/bin/env bash
# Inject macOS usage-description keys into the built Sunny.app Info.plist.
#
# Tauri 2's tauri.conf.json schema does not (yet) let us set arbitrary
# Info.plist keys inline. Without these keys, WKWebView silently refuses
# getUserMedia (mic), the user is never prompted, and our voice/audio meter
# features die quietly.
set -euo pipefail

APP="/Users/sunny/Sunny Ai/src-tauri/target/release/bundle/macos/Sunny.app"
PLIST="$APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "patch-info-plist: $PLIST not found — skipping (is the build done?)" >&2
  exit 0
fi

set_key() {
  local key="$1"
  local value="$2"
  # -replace if present, -insert otherwise. 2>/dev/null swallows "duplicate key".
  if /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$PLIST"
  else
    /usr/libexec/PlistBuddy -c "Add :$key string $value" "$PLIST"
  fi
}

set_key "NSMicrophoneUsageDescription" "SUNNY listens to your voice for hands-free commands and transcription. Audio is processed locally — nothing leaves your Mac unless you explicitly send it to a cloud model."
set_key "NSSpeechRecognitionUsageDescription" "SUNNY transcribes short voice commands locally via Whisper."
set_key "NSAppleEventsUsageDescription" "SUNNY uses AppleScript to read your Calendar, control apps, and answer questions about your Mac."
set_key "NSContactsUsageDescription" "SUNNY reads your iMessage conversation list (handles only) to power the Contacts module."
set_key "NSCameraUsageDescription" "SUNNY uses the camera only when you explicitly capture a screenshot or video frame."

# Verify the bundle is still valid.
if ! /usr/bin/plutil -lint "$PLIST" >/dev/null; then
  echo "patch-info-plist: lint failed for $PLIST" >&2
  exit 1
fi

# Re-sign the bundle. PlistBuddy's edits to Info.plist invalidate the
# earlier Tauri-applied code signature; without re-signing, macOS rejects
# the bundle with "plist or signature have been modified" and launchd
# refuses to spawn it.
#
# This is the FINAL, authoritative signature on the shipped bundle — Tauri's
# earlier sign pass is always clobbered by our plist edits, so Tauri's
# signature is effectively throw-away. That means any flags notarization
# requires (hardened runtime, secure timestamp) MUST be applied here, not
# in Tauri's conf. Without `--options runtime` + `--timestamp`, Apple's
# notary service rejects the bundle with "the executable does not have the
# hardened runtime enabled" and "the signature does not include a secure
# timestamp" — which would block CI/notarization even though local
# `codesign --verify` passes.
#
# Pull the signing identity out of tauri.conf.json so this script stays in
# sync with the build config — fall back to "-" (ad-hoc) when no identity
# is configured. Ad-hoc cannot be timestamped, so skip the timestamp flag
# in that path.
TAURI_CONF="/Users/sunny/Sunny Ai/src-tauri/tauri.conf.json"
IDENTITY=$(/usr/bin/plutil -extract bundle.macOS.signingIdentity raw -o - "$TAURI_CONF" 2>/dev/null || true)
if [ -z "$IDENTITY" ] || [ "$IDENTITY" = "null" ]; then
  IDENTITY="-"
fi

CODESIGN_FLAGS=(--force --deep --options runtime --sign "$IDENTITY")
if [ "$IDENTITY" != "-" ]; then
  # Secure timestamp requires a real identity; ad-hoc signing rejects it.
  CODESIGN_FLAGS+=(--timestamp)
fi

# Preserve the entitlements Tauri applied during the initial sign. Without
# --entitlements, codesign's re-sign strips them — and hardened-runtime +
# no entitlements means macOS blocks mic/camera/apple-events *before* the
# TCC prompt fires, so the user never even sees a permission dialog.
ENTITLEMENTS="/Users/sunny/Sunny Ai/src-tauri/entitlements.plist"
if [ -f "$ENTITLEMENTS" ]; then
  CODESIGN_FLAGS+=(--entitlements "$ENTITLEMENTS")
fi

echo "patch-info-plist: re-signing with identity: $IDENTITY (flags: ${CODESIGN_FLAGS[*]})"
/usr/bin/codesign "${CODESIGN_FLAGS[@]}" "$APP" 2>&1 | sed 's/^/  /'
if ! /usr/bin/codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "patch-info-plist: post-patch codesign --verify FAILED" >&2
  exit 1
fi

# Invalidate Launch Services signature cache — otherwise macOS may keep the
# old privacy prompts and still deny mic access on the first run after build.
/usr/bin/touch "$APP"
echo "patch-info-plist: merged usage descriptions into $PLIST"
