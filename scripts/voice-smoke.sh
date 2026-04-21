#!/usr/bin/env bash
# voice-smoke.sh — end-to-end voice pipeline sanity check.
# Synthesizes a known utterance via macOS `say`, feeds it through the same
# whisper-cli invocation Sunny uses, and asserts the transcript is intact.
# Extended to exercise the full turn: STT -> Ollama chat -> Kokoro TTS -> afplay.
# Run after editing audio.rs / audio_capture.rs.

set -euo pipefail

INPUT="/tmp/sunny-voice-smoke-input.wav"
SILENCE="/tmp/sunny-voice-smoke-silence.wav"
Q_INPUT="/tmp/sunny-voice-smoke-question.wav"
TTS_OUT="/tmp/sunny-voice-smoke-tts.wav"
WHISPER_BIN="$(which whisper-cli || true)"
KOKO_BIN="$(which koko || true)"
JQ_BIN="$(which jq || true)"
MODEL="${SUNNY_WHISPER_MODEL:-}"
OLLAMA_URL="${SUNNY_OLLAMA_URL:-http://localhost:11434}"
CHAT_MODEL="${SUNNY_CHAT_MODEL:-qwen3:30b-a3b-instruct-2507-q4_K_M}"

if [[ -z "$MODEL" ]]; then
  for cand in \
    "$HOME/Library/Caches/sunny/whisper/ggml-large-v3-turbo.bin" \
    "/opt/homebrew/share/whisper-cpp/ggml-large-v3-turbo.bin" \
    "$HOME/Library/Caches/sunny/whisper/ggml-base.en.bin" \
    "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin"; do
    if [[ -f "$cand" ]]; then MODEL="$cand"; break; fi
  done
fi

if [[ -z "$WHISPER_BIN" ]]; then
  echo "FAIL: whisper-cli not on PATH. brew install whisper-cpp"
  exit 1
fi
if [[ -z "$MODEL" ]]; then
  echo "FAIL: no whisper ggml model found"
  exit 1
fi

echo "[smoke] whisper: $WHISPER_BIN"
echo "[smoke] model:   $MODEL"

# Portable millisecond timer using python3 (macOS `date` lacks %N).
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# Test 1: known utterance → expect "hello"
echo "[smoke] test 1: 'Hello SUNNY, this is a test'"
T0=$(now_ms)
say -v Daniel "Hello SUNNY, this is a test" -o "$INPUT" --data-format=LEI16@16000
OUT_PREFIX="/tmp/sunny-voice-smoke-out"
"$WHISPER_BIN" -m "$MODEL" -f "$INPUT" -l en -t 4 -bs 1 -bo 1 -fa -nt -np -otxt -of "$OUT_PREFIX" >/dev/null 2>&1 || true
T1=$(now_ms)
TRANSCRIPT=$(cat "${OUT_PREFIX}.txt" 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]' | xargs)
echo "[smoke] transcript: '$TRANSCRIPT'"
echo "[smoke] timing: STT=$((T1-T0))ms"
if [[ "$TRANSCRIPT" == *"hello"* ]]; then
  echo "[smoke] PASS test 1"
else
  echo "[smoke] FAIL test 1: expected 'hello' in '$TRANSCRIPT'"
  exit 1
fi

# Test 2: silence → expect hallucination-filter to apply (transcript empty or known hallucination)
echo "[smoke] test 2: 1.0s silence"
# Generate 1s of silence at 16kHz mono 16-bit PCM
python3 -c "
import wave, struct
w = wave.open('$SILENCE', 'w')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b'\x00\x00' * 16000)
w.close()
"
"$WHISPER_BIN" -m "$MODEL" -f "$SILENCE" -l en -t 4 -bs 1 -bo 1 -fa -nt -np -otxt -of "$OUT_PREFIX" >/dev/null 2>&1 || true
SIL_TRANSCRIPT=$(cat "${OUT_PREFIX}.txt" 2>/dev/null | tr '[:upper:]' '[:lower:]' | xargs)
echo "[smoke] silence transcript: '$SIL_TRANSCRIPT'"
# We pass regardless — this test just surfaces what whisper emits so the
# hallucination filter in audio.rs can be kept up to date.
echo "[smoke] (informational — check the Rust hallucination filter covers this)"

# ---------------------------------------------------------------------------
# Test 3: full pipeline — STT -> Ollama chat -> parse -> assert "4"/"four".
# ---------------------------------------------------------------------------
echo "[smoke] test 3: full pipeline (STT → Ollama chat)"
if [[ -z "$JQ_BIN" ]]; then
  echo "[smoke] SKIP test 3: jq not found (brew install jq)"
elif ! curl -sS --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  echo "[smoke] SKIP test 3: ollama not reachable at $OLLAMA_URL"
else
  say -v Daniel "What is two plus two?" -o "$Q_INPUT" --data-format=LEI16@16000

  T_STT_START=$(now_ms)
  "$WHISPER_BIN" -m "$MODEL" -f "$Q_INPUT" -l en -t 4 -bs 1 -bo 1 -fa -nt -np -otxt -of "$OUT_PREFIX" >/dev/null 2>&1 || true
  T_STT_END=$(now_ms)
  Q_TRANSCRIPT=$(cat "${OUT_PREFIX}.txt" 2>/dev/null | xargs)
  echo "[smoke] question transcript: '$Q_TRANSCRIPT'"
  if [[ -z "$Q_TRANSCRIPT" ]]; then
    echo "[smoke] FAIL test 3: empty STT transcript"
    exit 1
  fi

  CHAT_REQ=$(jq -n \
    --arg model "$CHAT_MODEL" \
    --arg content "$Q_TRANSCRIPT" \
    '{model:$model, stream:false, messages:[{role:"user", content:$content}]}')

  T_CHAT_START=$(now_ms)
  CHAT_RESP=$(curl -sS --max-time 120 -H 'Content-Type: application/json' \
    -d "$CHAT_REQ" "$OLLAMA_URL/api/chat") || {
      echo "[smoke] FAIL test 3: chat request failed"; exit 1; }
  T_CHAT_END=$(now_ms)

  REPLY=$(printf '%s' "$CHAT_RESP" | jq -r '.message.content // empty')
  if [[ -z "$REPLY" ]]; then
    echo "[smoke] FAIL test 3: no .message.content in response"
    echo "[smoke] raw: $CHAT_RESP"
    exit 1
  fi
  REPLY_SANITIZED=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]')
  # Strip <think>...</think> blocks if the model emits them.
  REPLY_STRIPPED=$(printf '%s' "$REPLY_SANITIZED" | python3 -c "import sys,re;print(re.sub(r'<think>.*?</think>','',sys.stdin.read(),flags=re.S))")
  echo "[smoke] chat reply: ${REPLY:0:200}"
  echo "[smoke] timing: STT=$((T_STT_END-T_STT_START))ms chat=$((T_CHAT_END-T_CHAT_START))ms"
  if [[ "$REPLY_STRIPPED" == *"4"* || "$REPLY_STRIPPED" == *"four"* ]]; then
    echo "[smoke] PASS test 3"
  else
    echo "[smoke] FAIL test 3: expected '4' or 'four' in reply"
    exit 1
  fi

  # -------------------------------------------------------------------------
  # Test 4: reply text -> koko TTS -> afplay.
  # -------------------------------------------------------------------------
  echo "[smoke] test 4: TTS (koko) → afplay"
  if [[ -z "$KOKO_BIN" ]]; then
    echo "[smoke] SKIP test 4: koko not found on PATH"
  else
    # Clip reply to keep TTS fast; koko `text` takes a positional string.
    REPLY_CLIPPED=$(printf '%s' "$REPLY_STRIPPED" | tr '\n' ' ' | cut -c1-240)
    T_TTS_START=$(now_ms)
    if ! "$KOKO_BIN" text "$REPLY_CLIPPED" -o "$TTS_OUT" >/dev/null 2>&1; then
      echo "[smoke] FAIL test 4: koko synthesis failed"
      exit 1
    fi
    T_TTS_END=$(now_ms)
    if [[ ! -s "$TTS_OUT" ]]; then
      echo "[smoke] FAIL test 4: koko produced empty WAV"
      exit 1
    fi
    T_PLAY_START=$(now_ms)
    if command -v afplay >/dev/null 2>&1; then
      afplay "$TTS_OUT" >/dev/null 2>&1 || {
        echo "[smoke] FAIL test 4: afplay exit=$?"; exit 1; }
    else
      echo "[smoke] SKIP afplay: not found (unusual on macOS)"
    fi
    T_PLAY_END=$(now_ms)
    echo "[smoke] timing: TTS=$((T_TTS_END-T_TTS_START))ms play=$((T_PLAY_END-T_PLAY_START))ms"
    echo "[smoke] PASS test 4"
  fi
fi

# Cleanup
rm -f "$INPUT" "$SILENCE" "$Q_INPUT" "$TTS_OUT" "${OUT_PREFIX}.txt"

echo "[smoke] all tests passed"
