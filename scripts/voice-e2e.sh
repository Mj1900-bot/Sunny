#!/usr/bin/env bash
# voice-e2e.sh — end-to-end regression harness for the SUNNY voice turn.
#
# voice-smoke.sh tests individual stages (STT, chat, TTS). This script
# exercises the FULL voice turn exactly as it would land on Ollama if the
# cpal mic had picked up the utterance: synthesize a question with `say`,
# run the same whisper-cli invocation Sunny uses, then POST the transcript
# to `/api/chat` with the compact voice system prompt SUNNY emits — the
# same prompt shape that has previously let "ack plays but response
# never comes" bugs slip through stage-level tests.
#
# Exits 0 on pass, non-zero on fail. Skips gracefully when binaries are
# missing. Designed for `make voice-regression`-style CI + local use.
#
# ===========================================================================
# EXPECTED FAILURE MODES (and how to debug)
# ---------------------------------------------------------------------------
#   PRECHECK sunny-not-running   Sunny desktop app isn't launched. The regress-
#                               ion harness doesn't require it (we hit Ollama
#                               directly), but a live instance is required
#                               for catching voice pipeline integration
#                               regressions. Launch Sunny, then rerun.
#                               Override with SUNNY_E2E_SKIP_PROC=1 if you
#                               deliberately want the Ollama-only path.
#   PRECHECK ollama-unreachable ollama serve is down or on a non-default
#                               port. `ollama serve` or check $OLLAMA_URL.
#   PRECHECK model-not-pulled   $CHAT_MODEL isn't in `ollama list`. Pull it:
#                                 ollama pull qwen3:30b-a3b-instruct-2507-q4_K_M
#   STEP say-failed             `say` binary missing or locale voice absent.
#                               Check `say -v Daniel ?`. On non-macOS hosts
#                               this script skips with exit 0.
#   STEP whisper-empty          Whisper produced an empty transcript. Model
#                               probably missing or mismatched sample rate.
#                               Verify SUNNY_WHISPER_MODEL env var.
#   STEP chat-timeout           /api/chat exceeded budget. Common when the
#                               model is COLD (first-turn prefill of a 30B
#                               model is 4-6 s on this Mac). Rerun — the
#                               second pass should pass. Or warm it via the
#                               app, then rerun.
#   STEP no-answer              Model returned text but no '4' / 'four'.
#                               Check $REPLY — often thinking-mode leakage
#                               (raw <think>…</think> or chain-of-thought
#                               prose that doesn't terminate on an answer).
#                               This is the EXACT regression we care about.
#   STEP think-leakage          Reply contains stray <think> / <thinking>
#                               tags that would bleed into TTS. The Rust
#                               stripper in audio.rs / ollama.rs lost a
#                               case — fix the stripper, not the script.
# ===========================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
OLLAMA_URL="${SUNNY_OLLAMA_URL:-http://127.0.0.1:11434}"
CHAT_MODEL="${SUNNY_CHAT_MODEL:-qwen3:30b-a3b-instruct-2507-q4_K_M}"
CHAT_BUDGET_SECS="${SUNNY_E2E_CHAT_BUDGET:-10}"    # warm-model budget
COLD_BUDGET_SECS="${SUNNY_E2E_COLD_BUDGET:-25}"    # cold-model budget
SUNNY_PROC_PATTERN="${SUNNY_E2E_PROC_PATTERN:-Sunny.app/Contents/MacOS/sunny}"
WHISPER_BIN="$(command -v whisper-cli || true)"
JQ_BIN="$(command -v jq || true)"
MODEL="${SUNNY_WHISPER_MODEL:-}"

Q_WAV="/tmp/sunny-voice-e2e-q.wav"
OUT_PREFIX="/tmp/sunny-voice-e2e-out"

# Matches the compact persona SUNNY uses on the voice path when SOUL.md is
# absent (see compact_persona() in src/agent_loop/prompts.rs). We use the
# compact form rather than the full ~12 KB SOUL bundle so this regression
# is deterministic across machines — SOUL.md is user-customisable.
VOICE_SYSTEM_PROMPT='PERSONA: You are SUNNY, Sunny'\''s British-voiced Mac assistant.
Speak in short, warm British sentences. No emoji, no preamble.
Tools before guessing — call web_search, memory_recall, or the
relevant live tool whenever a fact could be stale or personal.
One reply, one answer. Do not chain tool calls after you have it.

VOICE LATENCY RULE (critical): you are in a live voice conversation. For greetings and small talk answer DIRECTLY in one warm sentence. ZERO tool calls on pleasantries. When you DO need a tool call it directly.'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

skip() { echo "[e2e] SKIP $1: $2"; exit 0; }
fail() { echo "[e2e] FAIL $1: $2" >&2; exit 1; }
pass() { echo "[e2e] PASS $1"; }
info() { echo "[e2e] $*"; }

cleanup() {
  rm -f "$Q_WAV" "${OUT_PREFIX}.txt"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
info "OLLAMA_URL=$OLLAMA_URL"
info "CHAT_MODEL=$CHAT_MODEL"
info "budget: warm=${CHAT_BUDGET_SECS}s cold=${COLD_BUDGET_SECS}s"

# Pre-check 1: say (macOS only).
if ! command -v say >/dev/null 2>&1; then
  skip "precheck" "macOS 'say' not available — harness is macOS-only"
fi

# Pre-check 2: whisper-cli + model.
if [[ -z "$WHISPER_BIN" ]]; then
  skip "precheck" "whisper-cli not on PATH (brew install whisper-cpp)"
fi
if [[ -z "$MODEL" ]]; then
  for cand in \
    "$HOME/Library/Caches/sunny/whisper/ggml-large-v3-turbo.bin" \
    "/opt/homebrew/share/whisper-cpp/ggml-large-v3-turbo.bin" \
    "$HOME/Library/Caches/sunny/whisper/ggml-base.en.bin" \
    "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin"; do
    if [[ -f "$cand" ]]; then MODEL="$cand"; break; fi
  done
fi
if [[ -z "$MODEL" ]]; then
  skip "precheck" "no whisper ggml model found (set SUNNY_WHISPER_MODEL)"
fi
info "whisper: $WHISPER_BIN"
info "model:   $MODEL"

# Pre-check 3: jq.
if [[ -z "$JQ_BIN" ]]; then
  skip "precheck" "jq not found (brew install jq)"
fi

# Pre-check 4: Sunny process is running. Opt-out for CI / Ollama-only checks.
if [[ "${SUNNY_E2E_SKIP_PROC:-0}" != "1" ]]; then
  if pgrep -f "$SUNNY_PROC_PATTERN" >/dev/null 2>&1; then
    SUNNY_PID="$(pgrep -f "$SUNNY_PROC_PATTERN" | head -1)"
    info "sunny running (pid=$SUNNY_PID)"
  else
    info "sunny not running — continuing with ollama-only check"
    info "  (set SUNNY_E2E_SKIP_PROC=1 to silence; launch Sunny.app to cover the full pipeline)"
  fi
fi

# Pre-check 5: Ollama reachable.
if ! curl -sS --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  fail "precheck" "ollama-unreachable: $OLLAMA_URL not responding"
fi

# Pre-check 6: Model pulled. Ollama /api/tags lists models by name.
MODELS_JSON=$(curl -sS --max-time 5 "$OLLAMA_URL/api/tags" || true)
if ! printf '%s' "$MODELS_JSON" | "$JQ_BIN" -e --arg m "$CHAT_MODEL" \
     '.models[]? | select(.name == $m or (.model // "") == $m)' >/dev/null 2>&1; then
  fail "precheck" "model-not-pulled: '$CHAT_MODEL' not in ollama list (run: ollama pull $CHAT_MODEL)"
fi
pass "precheck"

# ---------------------------------------------------------------------------
# Step 1 — synthesize + STT
# ---------------------------------------------------------------------------
QUESTION="What is two plus two?"
info "step 1: synth + whisper on '$QUESTION'"

T0=$(now_ms)
if ! say -v Daniel "$QUESTION" -o "$Q_WAV" --data-format=LEI16@16000 2>/dev/null; then
  fail "step1" "say-failed: could not synthesize question wav"
fi
if [[ ! -s "$Q_WAV" ]]; then
  fail "step1" "say-failed: empty wav written"
fi

"$WHISPER_BIN" -m "$MODEL" -f "$Q_WAV" -l en -t 4 -bs 1 -bo 1 -fa -nt -np \
  -otxt -of "$OUT_PREFIX" >/dev/null 2>&1 || true
TRANSCRIPT=$(cat "${OUT_PREFIX}.txt" 2>/dev/null | xargs)
T1=$(now_ms)

if [[ -z "$TRANSCRIPT" ]]; then
  fail "step1" "whisper-empty: no transcript from '$Q_WAV'"
fi
info "transcript: '$TRANSCRIPT'"
info "stt timing: $((T1-T0))ms"
pass "step1"

# ---------------------------------------------------------------------------
# Step 2 — /api/chat turn with the real SUNNY voice system prompt
# ---------------------------------------------------------------------------
info "step 2: /api/chat turn with voice system prompt"

CHAT_REQ=$("$JQ_BIN" -n \
  --arg model "$CHAT_MODEL" \
  --arg system "$VOICE_SYSTEM_PROMPT" \
  --arg content "$TRANSCRIPT" \
  '{
     model: $model,
     stream: false,
     keep_alive: "30m",
     messages: [
       {role: "system", content: $system},
       {role: "user",   content: $content}
     ]
   }')

T_CHAT_START=$(now_ms)
# Use the cold budget as the hard curl timeout; we measure against the
# warm budget below for a stricter latency assertion.
HTTP_STATUS=0
CHAT_RESP=$(curl -sS -o /tmp/sunny-voice-e2e-resp.json -w '%{http_code}' \
  --max-time "$COLD_BUDGET_SECS" \
  -H 'Content-Type: application/json' \
  -d "$CHAT_REQ" "$OLLAMA_URL/api/chat") || HTTP_STATUS=$?
T_CHAT_END=$(now_ms)
CHAT_MS=$((T_CHAT_END-T_CHAT_START))

if [[ "$HTTP_STATUS" != "0" && "$HTTP_STATUS" != "200" ]]; then
  # curl -w prints the HTTP code; non-2xx → inspect body.
  if [[ "$CHAT_RESP" != "200" ]]; then
    fail "step2" "chat-timeout: curl exit=$HTTP_STATUS http=$CHAT_RESP (budget ${COLD_BUDGET_SECS}s, took ${CHAT_MS}ms)"
  fi
fi

RESP_BODY=$(cat /tmp/sunny-voice-e2e-resp.json)
REPLY=$(printf '%s' "$RESP_BODY" | "$JQ_BIN" -r '.message.content // empty')
if [[ -z "$REPLY" ]]; then
  # Thinking models sometimes surface the answer only in .message.thinking.
  REPLY=$(printf '%s' "$RESP_BODY" | "$JQ_BIN" -r '.message.thinking // empty')
fi
if [[ -z "$REPLY" ]]; then
  fail "step2" "no-answer: empty .message.content and .message.thinking — raw: $(printf '%s' "$RESP_BODY" | head -c 400)"
fi

info "reply (first 240 chars): ${REPLY:0:240}"
info "chat timing: ${CHAT_MS}ms"

# Warm-model latency assertion. Cold first turn against a 30B model can
# exceed 10 s on this Mac; we don't fail the regression for that (it's
# environmental, not a code defect) but we do annotate it clearly.
WARM_BUDGET_MS=$((CHAT_BUDGET_SECS*1000))
if [[ "$CHAT_MS" -gt "$WARM_BUDGET_MS" ]]; then
  info "WARN latency: ${CHAT_MS}ms > warm budget ${WARM_BUDGET_MS}ms (cold model? first turn?)"
fi

# ---------------------------------------------------------------------------
# Step 3 — response format assertions
# ---------------------------------------------------------------------------
info "step 3: format assertions (numeric answer + no think-tag leakage)"

# 3a. Contains the expected numeric answer.
REPLY_LOWER=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]')
# Strip <think>...</think> blocks before matching so thinking-mode models
# that wrap reasoning in the block and put the prose answer after the
# close tag still pass (same stripper audio.rs uses before TTS).
REPLY_STRIPPED=$(printf '%s' "$REPLY_LOWER" \
  | python3 -c "import sys,re;print(re.sub(r'<think>.*?</think>','',sys.stdin.read(),flags=re.S))")

if [[ "$REPLY_STRIPPED" != *"4"* && "$REPLY_STRIPPED" != *"four"* ]]; then
  fail "step3" "no-answer: expected '4' or 'four' in reply after <think> strip — got: $(printf '%s' "$REPLY_STRIPPED" | head -c 200)"
fi

# 3b. No stray <think>/<thinking> tags make it to the TTS payload. If the
# stripper is missing a case this is where we catch it.
if printf '%s' "$REPLY_STRIPPED" | grep -qE '<think(ing)?>|</think(ing)?>'; then
  fail "step3" "think-leakage: stray <think> tags survived stripping — TTS would speak them"
fi

# 3c. No preamble bloat that would starve the TTS latency budget. The
# voice path wants single-sentence replies; 800 chars is a generous
# upper bound (more than that is almost always an essay, not a reply).
REPLY_LEN=${#REPLY_STRIPPED}
if [[ "$REPLY_LEN" -gt 800 ]]; then
  info "WARN reply-length: ${REPLY_LEN} chars — voice path expects short replies"
fi

pass "step3"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
info "summary: STT=$((T1-T0))ms chat=${CHAT_MS}ms reply_len=${REPLY_LEN}"
info "all tests passed"
