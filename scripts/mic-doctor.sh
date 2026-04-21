#!/usr/bin/env bash
# mic-doctor.sh — diagnose SUNNY microphone input on macOS.
#
# Checks system input volume, lists audio input devices, records 2s of audio,
# plays it back, and reports RMS level with a verdict + suggested fixes.

set -uo pipefail

TMP_WAV="/tmp/mic-doctor.wav"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

echo
bold "=== SUNNY mic-doctor ==="
echo

# ---------------------------------------------------------------------------
# 1. System input volume
# ---------------------------------------------------------------------------
bold "[1/4] System input volume"
INPUT_VOL="$(osascript -e 'input volume of (get volume settings)' 2>/dev/null || echo "?")"
echo "  input volume: ${INPUT_VOL} / 100"
if [[ "${INPUT_VOL}" =~ ^[0-9]+$ ]] && (( INPUT_VOL < 50 )); then
  yellow "  warning: input volume is low (<50)"
fi
echo

# ---------------------------------------------------------------------------
# 2. List audio input devices
# ---------------------------------------------------------------------------
bold "[2/4] Audio input devices"
AUDIO_TXT="$(system_profiler SPAudioDataType 2>/dev/null || echo '')"

if [[ -z "${AUDIO_TXT}" ]]; then
  red "  system_profiler SPAudioDataType returned nothing"
else
  # Walk the indented text output, grouping by device block (devices sit under
  # an 'Input' section at depth 8 spaces or are marked 'Default Input Device: Yes').
  printf '%s\n' "${AUDIO_TXT}" | awk '
    /^        [A-Za-z0-9].*:$/ {
      # 8-space indented block header = a device name (strip trailing colon)
      name=$0
      sub(/^ +/,"",name); sub(/:$/,"",name)
      current=name; has_input=0; is_default_in=0
      buf[current]=1
      next
    }
    /Input Channels:/ {
      # Any nonzero input channel count = an input device
      val=$0; sub(/.*Input Channels:[[:space:]]*/,"",val)
      if (val+0 > 0) has_input=1
      if (current) { inp[current]=has_input }
    }
    /Default Input Device:/ {
      val=$0; sub(/.*Default Input Device:[[:space:]]*/,"",val)
      if (val ~ /Yes/) { is_default_in=1; def[current]=1 }
    }
    END {
      n=0
      for (d in buf) {
        if (inp[d] || def[d]) {
          mark = def[d] ? " <-- DEFAULT INPUT" : ""
          printf "  - %s%s\n", d, mark
          n++
        }
      }
      if (n==0) print "  (no input devices detected)"
    }
  '
fi
echo

# ---------------------------------------------------------------------------
# 3. Record + play + measure
# ---------------------------------------------------------------------------
bold "[3/4] Recording 2s from the default input..."

RECORDER=""
if command -v sox     >/dev/null 2>&1; then RECORDER="sox";     fi
if [[ -z "${RECORDER}" ]] && command -v ffmpeg >/dev/null 2>&1; then RECORDER="ffmpeg"; fi

if [[ -z "${RECORDER}" ]]; then
  red "  neither sox nor ffmpeg is on PATH — cannot record."
  echo "  install with: brew install sox    (or: brew install ffmpeg)"
  exit 1
fi

rm -f "${TMP_WAV}"
echo "  (speak now — using ${RECORDER})"

if [[ "${RECORDER}" == "sox" ]]; then
  sox -d -c 1 -r 16000 "${TMP_WAV}" trim 0 2 2>/dev/null
else
  ffmpeg -hide_banner -loglevel error -y \
    -f avfoundation -i ":default" -t 2 -ac 1 -ar 16000 "${TMP_WAV}" 2>/dev/null \
  || ffmpeg -hide_banner -loglevel error -y \
    -f avfoundation -i ":0" -t 2 -ac 1 -ar 16000 "${TMP_WAV}" 2>/dev/null
fi

if [[ ! -s "${TMP_WAV}" ]]; then
  red "  recording failed — ${TMP_WAV} is missing or empty"
  echo "  likely causes: mic permission denied, no default input, device busy"
  exit 1
fi

echo "  saved: ${TMP_WAV} ($(stat -f%z "${TMP_WAV}") bytes)"
echo "  playback (afplay)..."
afplay "${TMP_WAV}" 2>/dev/null || yellow "  afplay failed — continuing"
echo

bold "[4/4] RMS analysis"

RMS_DB=""
if command -v sox >/dev/null 2>&1; then
  SOX_STATS="$(sox "${TMP_WAV}" -n stats 2>&1 || true)"
  RMS_DB="$(printf '%s\n' "${SOX_STATS}" | awk '/RMS lev dB/ {print $4; exit}')"
  [[ -n "${RMS_DB}" ]] && echo "  sox RMS lev dB: ${RMS_DB}"
fi

if [[ -z "${RMS_DB}" ]] && command -v ffmpeg >/dev/null 2>&1; then
  FF_OUT="$(ffmpeg -hide_banner -nostats -i "${TMP_WAV}" -af volumedetect -f null - 2>&1 || true)"
  RMS_DB="$(printf '%s\n' "${FF_OUT}" | awk -F': ' '/mean_volume/ {gsub(/ dB/,"",$2); print $2; exit}')"
  [[ -n "${RMS_DB}" ]] && echo "  ffmpeg mean_volume dB: ${RMS_DB}"
fi

if [[ -z "${RMS_DB}" ]]; then
  red "  could not compute RMS"
  exit 1
fi

# Strip trailing non-numeric, keep sign
CLEAN_DB="$(printf '%s' "${RMS_DB}" | tr -d ' ')"

awk_verdict() {
  awk -v db="$1" 'BEGIN {
    if (db+0 > -30)      { print "HEALTHY" }
    else if (db+0 > -50) { print "LOW_GAIN" }
    else                 { print "SILENT" }
  }'
}

VERDICT="$(awk_verdict "${CLEAN_DB}")"
echo
bold "=== VERDICT ==="
case "${VERDICT}" in
  HEALTHY)
    green "  mic is healthy (RMS ${CLEAN_DB} dB)"
    ;;
  LOW_GAIN)
    yellow "  mic working but gain is low (RMS ${CLEAN_DB} dB) — bump volume"
    ;;
  SILENT)
    red "  mic is essentially silent (RMS ${CLEAN_DB} dB) — wrong device selected or hardware mute"
    ;;
esac
echo

# ---------------------------------------------------------------------------
# Suggested fixes
# ---------------------------------------------------------------------------
bold "Suggested fixes"
dim "  # raise input volume to 85%"
echo "  osascript -e 'set volume input volume 85'"
echo
dim "  # open Sound settings"
echo "  open 'x-apple.systempreferences:com.apple.Sound-Settings.extension?Input'"
echo
if command -v SwitchAudioSource >/dev/null 2>&1; then
  dim "  # list / switch inputs via SwitchAudioSource"
  echo "  SwitchAudioSource -a -t input"
  echo "  SwitchAudioSource -t input -s 'MacBook Pro Microphone'"
else
  dim "  # install SwitchAudioSource (optional) for CLI device switching"
  echo "  brew install switchaudio-osx"
fi
echo
dim "  # re-run this doctor after changes"
echo "  $0"
echo
