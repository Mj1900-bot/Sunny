use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::super::catalog::openai_chat_tools_catalog;
use super::super::types::{ToolCall, TurnOutcome};
use super::super::helpers::truncate;
use super::anthropic::LLM_TIMEOUT_SECS; // Re-use the timeout constant
use crate::ai::ChatChunk;
use crate::event_bus::{publish, SunnyEvent};
use crate::telemetry::{record_llm_turn, TelemetryEvent};

pub const OLLAMA_URL: &str = "http://127.0.0.1:11434/api/chat";
pub const OLLAMA_TAGS_URL: &str = "http://127.0.0.1:11434/api/tags";

/// Drafter model for speculative voice TTFA. Small + fast enough to emit
/// the first token(s) inside ~1 s; results are verified against the
/// primary 30B model and corrected if they diverge. Must already be
/// pulled — `ollama list` on this machine has it at 6.6 GB.
pub const SPECULATIVE_DRAFT_MODEL: &str = "qwen3.5:9b-fast";

/// How many leading chars of the draft must match the primary for us to
/// keep the drafted stream verbatim. A short window catches the common
/// "same greeting, different details" divergence without punishing the
/// draft for minor whitespace drift mid-sentence.
const SPECULATIVE_MATCH_PREFIX: usize = 50;

/// Preferred local default — the non-thinking `-instruct-2507` variant.
///
/// We previously defaulted to `-thinking-2507` for a ~5-8pp BFCL tool-call
/// accuracy bump, but that trade-off was wrong for the interactive voice
/// path: thinking-mode models reason silently for 8-15 seconds *before*
/// emitting any visible token, so every turn looked dead in the UI while
/// the model was internally deliberating. The ReAct loop in `core.rs`
/// already provides iterative reasoning — each tool call + result cycle
/// is a reasoning step observable from the outside — so making the model
/// also think silently inside a single turn pays for reasoning twice.
///
/// Non-thinking path:
///   - TTFT drops from 8-15 s to ~200-400 ms on this machine
///   - Tool decisions stream out one iteration at a time, so the UI can
///     show "calling calendar_list_events…" instead of a spinner
///   - When the model picks a suboptimal tool, iteration 2 self-corrects
///     against the actual tool result — usually faster than a silent
///     pre-plan that guessed right
///
/// Thinking path remains available — callers can set `model` explicitly
/// in `~/.sunny/settings.json` or pick it per sub-agent via the model
/// override argument to `spawn_subagent`.
/// Default local model. Measured latency vs. quality trade-off on an
/// M3 Ultra, April 2026:
///   * qwen2.5:3b         —  0.79 s + FAILS on multi-step reasoning
///                           (e.g. gets scheduling logic wrong)
///   * qwen3.5:9b-nothink —  4.12 s + sometimes returns empty
///   * qwen3.5:9b-fast    —  6.23 s (misnomer, not fast)
///   * qwen3:30b-a3b      — 10-60 s + high quality but echo-prone
///                           on very short casual prompts
/// Keeping qwen3:30b-a3b as the default — it's the only local option
/// that gives Sunny-grade answers on planning / memory / multi-step
/// queries. The echo-on-greetings issue is cosmetic; cloud (Kimi K2.6
/// or GLM-5.1) is the right answer when latency matters more than
/// running fully offline.
pub const PREFERRED_OLLAMA_MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
/// Legacy alias kept for backward compatibility with call sites outside
/// this module. Points at the same model as `PREFERRED_OLLAMA_MODEL`.
pub const DEFAULT_OLLAMA_MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";

// Ollama runs fully locally — there is no per-token billing. The
// cost constant (crate::telemetry::cost_rates::OLLAMA_COST) is 0.0.
// Token counts from Ollama's /api/chat are also unavailable in the
// non-streaming path, so cost_usd will always be 0.0 for Ollama turns.

#[derive(Deserialize, Debug)]
pub struct OllamaResponse {
    #[serde(default)]
    pub message: Option<OllamaMessage>,
}

#[derive(Deserialize, Debug)]
pub struct OllamaMessage {
    #[serde(default)]
    pub content: String,
    /// Ollama thinking-mode models (e.g. qwen3:30b-a3b-thinking-2507) emit
    /// their prose in `thinking` and leave `content` empty. For turns
    /// that aren't a tool call we need this fallback — otherwise every
    /// final answer from a thinking model is a blank string.
    #[serde(default)]
    pub thinking: String,
    #[serde(default)]
    pub tool_calls: Option<Vec<OllamaToolCall>>,
}

#[derive(Deserialize, Debug)]
pub struct OllamaToolCall {
    #[serde(default)]
    pub function: OllamaFunction,
}

#[derive(Deserialize, Debug, Default)]
pub struct OllamaFunction {
    #[serde(default)]
    pub name: String,
    /// Ollama returns the args either as a JSON object or as a string —
    /// accept both.
    #[serde(default)]
    pub arguments: Value,
}

pub async fn ollama_turn(
    model: &str,
    system: &str,
    history: &[Value],
) -> Result<TurnOutcome, String> {
    // Ollama's chat endpoint wants the system prompt as the first
    // message, not a separate field. We also strip any prior role we
    // don't recognise — the /chat schema rejects unknown roles.
    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 1);
    messages.push(json!({"role": "system", "content": system}));
    for m in history {
        messages.push(m.clone());
    }

    let tools = openai_chat_tools_catalog().clone();

    let body = json!({
        "model": model,
        "stream": false,
        "messages": messages,
        "tools": tools,
        // Keep the model resident in VRAM between turns. Default Ollama
        // eviction is 5 min; for a voice assistant the first cold reload
        // costs ~4-6 s (our measurement for qwen3:30b-a3b on this Mac),
        // visible to the user as a suddenly slow turn after idle. 30 min
        // keep-alive trades a slice of VRAM for consistent voice latency.
        "keep_alive": "30m",
    });

    let started = Instant::now();
    let client = crate::http::client();
    let req = client.post(OLLAMA_URL).json(&body);
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        crate::http::send(req),
    )
    .await
    .map_err(|_| "ollama timed out".to_string())?
    .map_err(|e| format!("ollama connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ollama http {status}: {}", truncate(&body, 400)));
    }

    let parsed: OllamaResponse = resp
        .json()
        .await
        .map_err(|e| format!("ollama decode: {e}"))?;
    // Ollama's /api/chat doesn't surface token counts in the non-
    // streaming response body, and we have no cache semantics anyway.
    // Record a zero-token telemetry turn so the turn *count* still
    // reflects reality — BrainPage treats zero-input turns as
    // "unmeasured input" rather than silently dropping them.
    let total_ms = started.elapsed().as_millis() as u64;
    record_llm_turn(TelemetryEvent {
        provider: "ollama".to_string(),
        model: model.to_string(),
        input: 0,
        cache_read: 0,
        cache_create: 0,
        output: 0,
        duration_ms: total_ms,
        at: chrono::Utc::now().timestamp(),
        cost_usd: 0.0, // Ollama is local — no billing
        tier: None,    // K5 wires this via route_model; None until then
        // Buffered (non-streaming) path: TTFT == total duration.
        ttft_ms: Some(total_ms),
        generate_ms: Some(0),
        ..Default::default()
    });

    let msg = parsed.message.unwrap_or(OllamaMessage {
        content: String::new(),
        thinking: String::new(),
        tool_calls: None,
    });

    if let Some(tool_calls) = msg.tool_calls.filter(|v| !v.is_empty()) {
        let mut calls: Vec<ToolCall> = Vec::with_capacity(tool_calls.len());
        for (i, tc) in tool_calls.into_iter().enumerate() {
            // Ollama sometimes serialises arguments as a JSON-encoded
            // string; normalise to a Value object for the dispatcher.
            let input = match tc.function.arguments {
                Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
                other => other,
            };
            calls.push(ToolCall {
                id: format!("ollama-{i}"),
                name: tc.function.name,
                input,
            });
        }
        let assistant_message = json!({
            "role": "assistant",
            "content": msg.content,
            "tool_calls": calls_to_ollama_repr(&calls),
        });
        // Prefer narration from `content`; fall back to `thinking` so the
        // agent.step UI isn't blank on thinking-mode models.
        let thinking = if !msg.content.trim().is_empty() {
            Some(msg.content.clone())
        } else if !msg.thinking.trim().is_empty() {
            Some(msg.thinking.clone())
        } else {
            None
        };
        Ok(TurnOutcome::Tools {
            thinking,
            calls,
            assistant_message,
        })
    } else {
        // Final answer: thinking-mode models (qwen3:30b-a3b-thinking-2507
        // et al.) emit the prose reply in `thinking` and leave `content`
        // empty. Prefer content (standard path), fall back to thinking.
        // Without this fallback every final answer from a thinking model
        // is a blank response — which is what bit us on the model swap.
        let final_text = if !msg.content.trim().is_empty() {
            msg.content
        } else if !msg.thinking.trim().is_empty() {
            msg.thinking
        } else {
            String::new()
        };
        Ok(TurnOutcome::final_buffered(final_text))
    }
}

/// NDJSON-streaming turn. Emits `sunny://chat.chunk` deltas to the main
/// chat surface as the local model generates tokens. Only the main agent
/// (sub_id == None) should call this — sub-agent replies are piped back
/// as tool results and the user shouldn't see their token stream.
///
/// Tool-call handling (Bottleneck D fix, 2026-04):
///   Ollama emits tool_calls in the *terminal* NDJSON frame (done: true),
///   but intermediate frames may still carry `message.content` /
///   `message.thinking` deltas that we want to publish for TTFT. Before
///   this fix, any non-empty tool catalog (which the agent loop always
///   registers) short-circuited the whole streaming path back to the
///   buffered `ollama_turn`, killing TTFT on every local turn. Now we
///   drive the stream regardless and, when the terminal frame carries
///   tool_calls, accumulate them into `TurnOutcome::Tools` without a
///   second round-trip to /api/chat.
///
/// Escape hatch: `SUNNY_OLLAMA_STREAM_TOOLS=0` reverts to the legacy
/// buffered-for-tools behaviour so a specific model that regresses
/// (e.g. emits partial tool_call JSON piecewise across frames instead
/// of in one terminal frame) can be worked around without a recompile.
pub async fn ollama_turn_streaming(
    app: &AppHandle,
    model: &str,
    system: &str,
    history: &[Value],
) -> Result<TurnOutcome, String> {
    // Legacy short-circuit, opt-in via env var. Defaults to ON (i.e. use
    // the new streaming-with-tools path) because the measured cost of the
    // old branch is 5-47 s of hidden latency on every turn — structurally
    // incompatible with the 2 s voice SLA.
    let has_tools = !openai_chat_tools_catalog().is_empty();
    let stream_with_tools = std::env::var("SUNNY_OLLAMA_STREAM_TOOLS")
        .ok()
        .map(|v| !matches!(v.as_str(), "0" | "false" | "off" | ""))
        .unwrap_or(true);
    if has_tools && !stream_with_tools {
        log::debug!(
            "ollama_turn_streaming: SUNNY_OLLAMA_STREAM_TOOLS disabled — delegating to ollama_turn"
        );
        return ollama_turn(model, system, history).await;
    }

    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 1);
    messages.push(json!({"role": "system", "content": system}));
    for m in history {
        messages.push(m.clone());
    }

    let tools = openai_chat_tools_catalog().clone();

    let body = json!({
        "model": model,
        "stream": true,
        "messages": messages,
        "tools": tools,
        "keep_alive": "30m",
    });

    let started = Instant::now();
    // Stable turn_id for the event-bus ChatChunk mirror. Pinned to the
    // start of this streaming call so every delta + the terminal done
    // chunk share the same id.
    //
    // Appends a short uuid suffix: plain `{provider}:{model}:{ms}` can
    // collide when two streaming calls start in the same millisecond
    // (chat + sub-agent, or a voice retry). The uuid disambiguator keeps
    // turn_id unique across sessions without changing the provider
    // signature — tailers that split on `:` with limit=3 still work.
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("ollama:{model}:{turn_start_ms}:{turn_suffix}");
    let client = crate::http::client();
    // Per-request timeout applies as a read/response ceiling, not a
    // whole-body bound when streaming — mirrors anthropic_turn_streaming.
    let req = client
        .post(OLLAMA_URL)
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
        .json(&body);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("ollama stream connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ollama http {status}: {}", truncate(&body, 400)));
    }

    match drive_ndjson_stream(app, resp, &turn_id).await? {
        NdjsonResult::Final { text, ttft_ms } => {
            // MIGRATED sprint-9 → bus push channel only
            publish(SunnyEvent::ChatChunk {
                turn_id: turn_id.clone(),
                delta: String::new(),
                done: true,
                at: chrono::Utc::now().timestamp_millis(),
                seq: 0,
                boot_epoch: 0,
            });
            // Ollama streaming doesn't surface token counts — we
            // record a zero-token turn so BrainPage's turn count
            // and latency tracking still reflect local traffic.
            let total_ms = started.elapsed().as_millis() as u64;
            let generate_ms = ttft_ms.map(|t| total_ms.saturating_sub(t));
            record_llm_turn(TelemetryEvent {
                provider: "ollama".to_string(),
                model: model.to_string(),
                input: 0,
                cache_read: 0,
                cache_create: 0,
                output: 0,
                duration_ms: total_ms,
                at: chrono::Utc::now().timestamp(),
                cost_usd: 0.0, // Ollama is local — no billing
                tier: None,    // K5 wires this via route_model; None until then
                ttft_ms,
                generate_ms,
                turn_id: Some(turn_id.clone()),
                ..Default::default()
            });
            Ok(TurnOutcome::Final { text, streamed: true })
        }
        NdjsonResult::ToolCalls {
            content,
            thinking,
            raw,
            ttft_ms,
        } => {
            // Finalise the chat surface — even if no content deltas were
            // emitted (the model went straight to a tool call with no
            // narration), the frontend expects a terminal done frame per
            // turn_id to tear down the streaming indicator.
            publish(SunnyEvent::ChatChunk {
                turn_id: turn_id.clone(),
                delta: String::new(),
                done: true,
                at: chrono::Utc::now().timestamp_millis(),
                seq: 0,
                boot_epoch: 0,
            });
            let total_ms = started.elapsed().as_millis() as u64;
            let generate_ms = ttft_ms.map(|t| total_ms.saturating_sub(t));
            record_llm_turn(TelemetryEvent {
                provider: "ollama".to_string(),
                model: model.to_string(),
                input: 0,
                cache_read: 0,
                cache_create: 0,
                output: 0,
                duration_ms: total_ms,
                at: chrono::Utc::now().timestamp(),
                cost_usd: 0.0,
                tier: None,
                ttft_ms,
                generate_ms,
                turn_id: Some(turn_id.clone()),
                ..Default::default()
            });

            // Normalise tool_calls into the crate's ToolCall shape — same
            // logic as ollama_turn's buffered path. Ollama may serialise
            // arguments as a JSON-encoded string or an object; accept both.
            let mut calls: Vec<ToolCall> = Vec::with_capacity(raw.len());
            for (i, tc) in raw.into_iter().enumerate() {
                let input = match tc.function.arguments {
                    Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
                    other => other,
                };
                calls.push(ToolCall {
                    id: format!("ollama-{i}"),
                    name: tc.function.name,
                    input,
                });
            }

            // Echo the exact wire shape Ollama expects on the next turn
            // so the /api/chat round-trip stays clean.
            let assistant_message = json!({
                "role": "assistant",
                "content": content,
                "tool_calls": calls_to_ollama_repr(&calls),
            });

            // Prefer visible content for the UI narration slot; fall back
            // to thinking so agent.step isn't blank on a thinking-mode
            // model that went straight to a tool call.
            let thinking_out = if !content.trim().is_empty() {
                Some(content)
            } else if !thinking.trim().is_empty() {
                Some(thinking)
            } else {
                None
            };

            Ok(TurnOutcome::Tools {
                thinking: thinking_out,
                calls,
                assistant_message,
            })
        }
    }
}

/// Speculative drafting for voice TTFA (R16-G).
///
/// Fires BOTH the drafter (qwen3.5:9b-fast, ~1 s to first token on this
/// Mac) and the primary (qwen3:30b-a3b, 5-47 s cold) concurrently. The
/// drafter's NDJSON stream is piped straight to `sunny://chat.chunk` so
/// the TTS pipeline can start speaking immediately. When the primary
/// finishes we compare:
///   * First `SPECULATIVE_MATCH_PREFIX` chars match → keep the draft
///     verbatim (it was right), log "speculative: kept".
///   * Diverged → emit `sunny://chat.correction` with the primary text so
///     the frontend replaces what was already drafted, drop any
///     remaining draft tokens, log "speculative: corrected at token N".
///
/// Either way we return the **primary's** text as the turn's final
/// answer so memory, logging, and history stay consistent with the
/// authoritative model. Voice-only, opt-in gate lives in core.rs.
///
/// Not a general solution: no tool calls (the draft model isn't trusted
/// for that — voice turns rarely need tools), no sub-agent routing. If
/// either stream errors we propagate the error; the core loop will not
/// fall back silently, because falling back defeats the TTFA purpose.
pub async fn ollama_turn_speculative(
    app: &AppHandle,
    primary_model: &str,
    draft_model: &str,
    system: &str,
    history: &[Value],
) -> Result<TurnOutcome, String> {
    use futures_util::StreamExt;

    // Stable turn_id for the event-bus ChatChunk mirror. The draft path
    // emits every delta under this id; the terminal done chunk + any
    // correction share it too, so a tailer can fold the whole
    // speculative turn into one logical stream.
    //
    // Uses the same `{provider}:{model}:{ms}` shape as anthropic.rs and
    // `ollama_turn_streaming` so cross-session tails can filter every
    // local turn (including speculative ones) with a single prefix match.
    // The primary model — not the drafter — identifies the turn because
    // it's the authoritative voice; the drafter is an implementation
    // detail of this single turn's TTFA optimisation.
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    // Uuid suffix — same rationale as ollama_turn_streaming: avoids
    // same-ms cross-session collisions (e.g. chat + voice retry).
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("ollama:{primary_model}:{turn_start_ms}:{turn_suffix}");

    // Shared request body builder — same messages / system / keep_alive
    // for both calls. No tools: we're on the voice path, and both models
    // would otherwise emit `tool_calls` that the streaming parser would
    // short-circuit on.
    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 1);
    messages.push(json!({"role": "system", "content": system}));
    for m in history {
        messages.push(m.clone());
    }

    let draft_body = json!({
        "model": draft_model,
        "stream": true,
        "messages": messages,
        "keep_alive": "30m",
    });
    let primary_body = json!({
        "model": primary_model,
        "stream": false,
        "messages": messages,
        "keep_alive": "30m",
    });

    let client = crate::http::client();

    // Primary runs as a spawned task so it makes progress while we drive
    // the draft stream on this future. Buffered (non-streaming) — we
    // only need the final text to compare + return.
    let primary_handle = {
        let client = client.clone();
        let primary_body = primary_body.clone();
        tokio::spawn(async move {
            let req = client.post(OLLAMA_URL).json(&primary_body);
            let resp = tokio::time::timeout(
                Duration::from_secs(LLM_TIMEOUT_SECS),
                crate::http::send(req),
            )
            .await
            .map_err(|_| "ollama primary timed out".to_string())?
            .map_err(|e| format!("ollama primary connect: {e}"))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "ollama primary http {status}: {}",
                    truncate(&body, 400)
                ));
            }
            let parsed: OllamaResponse = resp
                .json()
                .await
                .map_err(|e| format!("ollama primary decode: {e}"))?;
            let msg = parsed.message.unwrap_or(OllamaMessage {
                content: String::new(),
                thinking: String::new(),
                tool_calls: None,
            });
            // Thinking-mode fallback mirrors ollama_turn.
            let text = if !msg.content.trim().is_empty() {
                msg.content
            } else if !msg.thinking.trim().is_empty() {
                msg.thinking
            } else {
                String::new()
            };
            Ok::<String, String>(text)
        })
    };

    // Draft: streaming NDJSON, piped directly to chat.chunk so TTS can
    // eat bytes the instant they land.
    let draft_req = client
        .post(OLLAMA_URL)
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
        .json(&draft_body);
    let draft_resp = crate::http::send(draft_req)
        .await
        .map_err(|e| format!("ollama draft connect: {e}"))?;

    if !draft_resp.status().is_success() {
        let status = draft_resp.status();
        let body = draft_resp.text().await.unwrap_or_default();
        // Abort the primary task so we don't leak a pending request — we
        // can't compare without a draft anyway.
        primary_handle.abort();
        return Err(format!(
            "ollama draft http {status}: {}",
            truncate(&body, 400)
        ));
    }

    // ---- Drive the draft stream concurrently with primary completion.
    // We emit every draft delta as a chat.chunk until either (a) the
    // draft's terminal `done: true` frame arrives, or (b) the primary
    // finishes first AND has already diverged from the draft, in which
    // case we stop draining, emit a correction, and bail early.
    let mut stream = draft_resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut draft_text = String::new();
    let mut draft_token_count: u32 = 0;
    let mut draft_done = false;
    let mut tool_use_in_draft = false;
    let mut was_thinking = false;

    // `primary_handle` stays an Option so we can `.take()` it out of the
    // select arm exactly once.
    let mut primary_slot = Some(primary_handle);
    let mut early_primary_text: Option<String> = None;
    let mut corrected = false;

    while !draft_done {
        tokio::select! {
            biased;

            // Primary arm: if the primary finishes while the draft is
            // still streaming, inspect its answer. If it already
            // diverges from what we've emitted, correct now — no point
            // letting the draft keep lying to TTS.
            primary_result = async {
                // Only poll the primary if we still have a handle.
                match primary_slot.as_mut() {
                    Some(h) => h.await,
                    None => std::future::pending().await,
                }
            }, if primary_slot.is_some() => {
                primary_slot = None;
                let primary_text = match primary_result {
                    Ok(Ok(t)) => t,
                    Ok(Err(e)) => return Err(e),
                    Err(join_err) => {
                        return Err(format!("ollama primary join: {join_err}"));
                    }
                };
                if !draft_matches(&draft_text, &primary_text) {
                    // Correct immediately; the caller replaces the
                    // already-drafted text in the UI.
                    if was_thinking {
                        // MIGRATED sprint-9 → bus push channel only
                        publish(SunnyEvent::ChatChunk {
                            turn_id: turn_id.clone(),
                            delta: "\n</think>\n".to_string(),
                            done: false,
                            at: chrono::Utc::now().timestamp_millis(),
                            seq: 0,
                            boot_epoch: 0,
                        });
                    }
                    // `sunny://chat.correction` is NOT a chat.chunk twin —
                    // leave in place. Sprint-9 only retires the
                    // chat.chunk / chat.done Tauri channel; correction
                    // has no bus equivalent yet.
                    let _ = app.emit(
                        "sunny://chat.correction",
                        ChatChunk {
                            delta: primary_text.clone(),
                            done: true,
                        },
                    );
                    log::info!(
                        "speculative: corrected at token {draft_token_count} \
                         (draft_len={} primary_len={})",
                        draft_text.len(),
                        primary_text.len()
                    );
                    corrected = true;
                    early_primary_text = Some(primary_text);
                    break;
                } else {
                    // Match — stash the primary text for final return,
                    // keep streaming the rest of the draft as-is.
                    early_primary_text = Some(primary_text);
                }
            }

            // Draft arm: pull the next chunk from the NDJSON stream.
            next = stream.next() => {
                match next {
                    Some(Ok(bytes)) => {
                        buf.extend_from_slice(&bytes);
                    }
                    Some(Err(e)) => {
                        return Err(format!("ollama draft stream read: {e}"));
                    }
                    None => {
                        // Draft stream closed without a terminal frame.
                        // Treat as done and hope the primary saves us.
                        break;
                    }
                }
                // Drain all complete lines currently in `buf`.
                while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = buf.drain(..nl).collect();
                    buf.drain(..1);
                    let line = String::from_utf8_lossy(&line_bytes);
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let payload: Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(e) => {
                            log::warn!(
                                "speculative draft NDJSON: bad JSON ({e}) → {}",
                                truncate(line, 160)
                            );
                            continue;
                        }
                    };
                    // Drafter isn't supposed to call tools on voice
                    // turns, but defend anyway — treat tool_calls as a
                    // hard abort so we don't emit half-baked output.
                    if payload
                        .get("message")
                        .and_then(|m| m.get("tool_calls"))
                        .and_then(|tc| tc.as_array())
                        .is_some_and(|arr| !arr.is_empty())
                    {
                        tool_use_in_draft = true;
                        draft_done = true;
                        break;
                    }
                    let msg = payload.get("message");
                    let mut delta_str = String::new();

                    if let Some(t) = msg.and_then(|m| m.get("thinking")).and_then(|t| t.as_str()).filter(|s| !s.is_empty()) {
                        if !was_thinking {
                            was_thinking = true;
                            delta_str.push_str("<think>\n");
                        }
                        delta_str.push_str(t);
                    } else if let Some(c) = msg.and_then(|m| m.get("content")).and_then(|c| c.as_str()).filter(|s| !s.is_empty()) {
                        if was_thinking {
                            was_thinking = false;
                            delta_str.push_str("\n</think>\n");
                        }
                        delta_str.push_str(c);
                    }

                    if !delta_str.is_empty() {
                        draft_text.push_str(&delta_str);
                        draft_token_count += 1;
                        // MIGRATED sprint-9 → bus push channel only
                        publish(SunnyEvent::ChatChunk {
                            turn_id: turn_id.clone(),
                            delta: delta_str,
                            done: false,
                            at: chrono::Utc::now().timestamp_millis(),
                            seq: 0,
                            boot_epoch: 0,
                        });
                    }
                    if payload
                        .get("done")
                        .and_then(|d| d.as_bool())
                        .unwrap_or(false)
                    {
                        if was_thinking {
                            // MIGRATED sprint-9 → bus push channel only
                            publish(SunnyEvent::ChatChunk {
                                turn_id: turn_id.clone(),
                                delta: "\n</think>\n".to_string(),
                                done: false,
                                at: chrono::Utc::now().timestamp_millis(),
                                seq: 0,
                                boot_epoch: 0,
                            });
                            was_thinking = false;
                        }
                        draft_done = true;
                        break;
                    }
                }
            }
        }
    }

    // If the drafter emitted a tool_use or closed early, cancel the
    // streaming UI state and wait on the primary (best effort).
    if tool_use_in_draft {
        log::warn!("speculative: draft emitted tool_calls, relying on primary");
    }

    // If the primary hadn't finished yet (draft beat it), await it now.
    let primary_text = if let Some(t) = early_primary_text.clone() {
        t
    } else if let Some(handle) = primary_slot.take() {
        match handle.await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => return Err(e),
            Err(join_err) => return Err(format!("ollama primary join: {join_err}")),
        }
    } else {
        // Should be unreachable — we always have one or the other.
        String::new()
    };

    // Final comparison (only if we haven't already corrected mid-stream
    // or the primary arrived after the draft finished).
    if !corrected {
        if draft_text.is_empty() {
            // Empty draft (pure thinking output, no visible tokens emitted):
            // treat as no-opinion — accept the primary silently. The TTS audio
            // is unrecoverable at this point regardless, so firing a correction
            // event would only update the UI text without any audio benefit.
            // Note: the draft HTTP response body is dropped silently here; this
            // is intentional — the already-spoken TTS audio is unrecoverable,
            // correction only fixes the UI.
            log::info!(
                "speculative: empty draft, accepting primary (primary_len={})",
                primary_text.len()
            );
        } else if draft_matches(&draft_text, &primary_text) {
            log::info!(
                "speculative: kept (draft_tokens={draft_token_count} \
                 draft_len={} primary_len={})",
                draft_text.len(),
                primary_text.len()
            );
        } else {
            // Correction needed. The draft HTTP response body is dropped
            // silently — the already-spoken TTS audio is unrecoverable,
            // correction only fixes the UI text.
            let _ = app.emit(
                "sunny://chat.correction",
                ChatChunk {
                    delta: primary_text.clone(),
                    done: true,
                },
            );
            log::info!(
                "speculative: corrected at token {draft_token_count} \
                 (post-stream, draft_len={} primary_len={})",
                draft_text.len(),
                primary_text.len()
            );
        }
    }

    // MIGRATED sprint-9 → bus push channel only
    // Finalise the chat surface with a zero-delta terminal frame — same
    // contract as ollama_turn_streaming so the frontend doesn't need a
    // special case beyond handling chat.correction.
    publish(SunnyEvent::ChatChunk {
        turn_id: turn_id.clone(),
        delta: String::new(),
        done: true,
        at: chrono::Utc::now().timestamp_millis(),
        seq: 0,
        boot_epoch: 0,
    });

    Ok(TurnOutcome::Final {
        text: primary_text,
        streamed: true,
    })
}

/// Compare the draft's leading window to the primary's. Case-insensitive,
/// whitespace-collapsed — small formatting drift shouldn't flip a
/// "kept" decision into "corrected".
fn draft_matches(draft: &str, primary: &str) -> bool {
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(|c| c.to_lowercase())
            .take(SPECULATIVE_MATCH_PREFIX)
            .collect()
    };
    let d = norm(draft);
    let p = norm(primary);
    if d.is_empty() || p.is_empty() {
        // Empty draft can't vouch for the primary; treat as non-match so
        // the correction event fires.
        return false;
    }
    // If the shorter prefix is a prefix of the longer, consider them
    // aligned. Handles the "draft has 50 chars, primary has 200" case.
    let (short, long) = if d.len() <= p.len() { (&d, &p) } else { (&p, &d) };
    long.starts_with(short.as_str())
}

pub async fn pick_ollama_model() -> String {
    let installed = list_ollama_models().await.unwrap_or_default();
    if installed.iter().any(|m| m == PREFERRED_OLLAMA_MODEL) {
        PREFERRED_OLLAMA_MODEL.to_string()
    } else {
        DEFAULT_OLLAMA_MODEL.to_string()
    }
}

async fn list_ollama_models() -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct TagsResp {
        #[serde(default)]
        models: Vec<TagItem>,
    }
    #[derive(Deserialize)]
    struct TagItem {
        name: String,
    }

    let client = crate::http::client();
    let req = client.get(OLLAMA_TAGS_URL);
    let resp = tokio::time::timeout(
        Duration::from_secs(2),
        crate::http::send(req),
    )
    .await
    .map_err(|_| "tags timed out".to_string())?
    .map_err(|e| format!("tags connect: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("tags http {}", resp.status()));
    }
    let parsed: TagsResp = resp
        .json()
        .await
        .map_err(|e| format!("tags decode: {e}"))?;
    Ok(parsed.models.into_iter().map(|m| m.name).collect())
}

// ---------------------------------------------------------------------------
// NDJSON parser
// ---------------------------------------------------------------------------

enum NdjsonResult {
    /// Clean end-of-stream. `text` is the concatenation of every
    /// `message.content` (or `message.thinking` fallback) delta.
    /// `ttft_ms` is the wall-clock ms from driver entry to the first
    /// non-empty delta; `None` when the stream ended without emitting
    /// user-visible text.
    Final { text: String, ttft_ms: Option<u64> },
    /// The terminal frame carried `message.tool_calls`. Ollama emits all
    /// tool_calls atomically in the terminal (done: true) frame, so by
    /// the time we see any tool_calls entry we have the complete set.
    /// Intermediate frames before the terminal one may still have emitted
    /// `content` / `thinking` deltas; those are captured here so the
    /// caller can echo them as `assistant_message.content` / narration.
    ToolCalls {
        /// Concatenation of `message.content` deltas (user-visible narration).
        content: String,
        /// Concatenation of `message.thinking` deltas, wrapped in
        /// `<think>…</think>` tags by the parser the same way the Final
        /// variant does. Used as a fallback narration source when
        /// `content` is empty (straight-to-tool-call behaviour).
        thinking: String,
        /// Raw tool_calls from the terminal frame, preserved for
        /// normalisation by the caller (it already has the ToolCall
        /// conversion + argument-shape tolerance in one place).
        raw: Vec<OllamaToolCall>,
        /// Same TTFT semantics as `Final`. Non-None only when at least
        /// one content/thinking delta landed before the terminal frame.
        ttft_ms: Option<u64>,
    },
}

/// Pull bytes off the wire, split on newlines, parse each line as a
/// complete JSON object. Ollama's /api/chat streaming format is NDJSON:
/// one JSON object per line, separated by `\n`. Each object looks like
/// `{"model": "...", "message": {"role": "assistant", "content": "<token>"}, "done": false}`
/// with a terminal frame carrying `"done": true`.
///
/// Bottleneck D fix: content + thinking deltas are accumulated into
/// `content_buf` / `thinking_buf` independently, so that if the terminal
/// frame turns out to carry tool_calls we can still hand the caller the
/// partial narration (rare — most tool-call turns have empty content —
/// but the model sometimes says "Let me check your calendar…" before
/// emitting the call). The accumulated `text` field in `Final` keeps
/// the legacy shape (content + `<think>`-wrapped thinking concatenated
/// as they landed) so the final-answer path is byte-identical to before.
async fn drive_ndjson_stream(
    _app: &AppHandle,
    resp: reqwest::Response,
    turn_id: &str,
) -> Result<NdjsonResult, String> {
    use futures_util::StreamExt;

    let stream_started = Instant::now();
    let mut ttft_ms: Option<u64> = None;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    // `accumulated` is the chronological concatenation of every delta
    // (content + <think>-wrapped thinking) — the legacy "Final.text"
    // shape. `content_buf` / `thinking_buf` track the split streams
    // for the tool-call path, where only one of the two is usually the
    // narration slot the caller wants.
    let mut accumulated = String::new();
    let mut content_buf = String::new();
    let mut thinking_buf = String::new();
    let mut was_thinking = false;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("ollama stream read: {e}"))?;
        buf.extend_from_slice(&bytes);

        // Drain every complete line in `buf`. Leftover (partial line)
        // stays in `buf` for the next chunk.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..nl).collect();
            buf.drain(..1); // consume the '\n' itself
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let payload: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!(
                        "ollama NDJSON: bad JSON line ({e}) → {}",
                        truncate(line, 160)
                    );
                    continue;
                }
            };

            // Tool-call detection. Ollama emits tool_calls atomically in
            // the terminal (done: true) frame, so the entire tool_calls
            // array is available here. Decode into `OllamaToolCall` via
            // serde so the caller gets the same shape the buffered path
            // has always produced, then return with whatever content /
            // thinking had already been streamed (usually none, but a
            // narrating model may have said "Let me check that…" first).
            if let Some(arr) = payload
                .get("message")
                .and_then(|m| m.get("tool_calls"))
                .and_then(|tc| tc.as_array())
                .filter(|arr| !arr.is_empty())
            {
                let raw: Vec<OllamaToolCall> = arr
                    .iter()
                    .filter_map(|v| serde_json::from_value(v.clone()).ok())
                    .collect();
                // Close any open <think> block the frontend is tracking
                // so the streaming UI doesn't show a dangling indicator.
                if was_thinking {
                    publish(SunnyEvent::ChatChunk {
                        turn_id: turn_id.to_string(),
                        delta: "\n</think>\n".to_string(),
                        done: false,
                        at: chrono::Utc::now().timestamp_millis(),
                        seq: 0,
                        boot_epoch: 0,
                    });
                    thinking_buf.push_str("\n</think>\n");
                }
                return Ok(NdjsonResult::ToolCalls {
                    content: content_buf,
                    thinking: thinking_buf,
                    raw,
                    ttft_ms,
                });
            }

            // Stream the content delta. Thinking-mode models emit prose
            // in `message.thinking`; we manually wrap it in `<think>` tags
            // so the frontend `streamSpeak` can strip it and the UI can style it.
            let msg = payload.get("message");
            let mut delta_str = String::new();

            if let Some(t) = msg.and_then(|m| m.get("thinking")).and_then(|t| t.as_str()).filter(|s| !s.is_empty()) {
                if !was_thinking {
                    was_thinking = true;
                    delta_str.push_str("<think>\n");
                    thinking_buf.push_str("<think>\n");
                }
                delta_str.push_str(t);
                thinking_buf.push_str(t);
            } else if let Some(c) = msg.and_then(|m| m.get("content")).and_then(|c| c.as_str()).filter(|s| !s.is_empty()) {
                if was_thinking {
                    was_thinking = false;
                    delta_str.push_str("\n</think>\n");
                    thinking_buf.push_str("\n</think>\n");
                }
                delta_str.push_str(c);
                content_buf.push_str(c);
            }

            if !delta_str.is_empty() {
                if ttft_ms.is_none() {
                    let elapsed = stream_started.elapsed().as_millis() as u64;
                    ttft_ms = Some(elapsed);
                    log::info!("ollama ttft: {elapsed}ms (first delta)");
                    crate::latency_harness::stage_marker(
                        crate::latency_harness::stages::FIRST_TOKEN,
                        Some(serde_json::json!({
                            "provider": "ollama",
                            "ttft_ms": elapsed,
                        })),
                    );
                }
                accumulated.push_str(&delta_str);
                // MIGRATED sprint-9 → bus push channel only
                publish(SunnyEvent::ChatChunk {
                    turn_id: turn_id.to_string(),
                    delta: delta_str,
                    done: false,
                    at: chrono::Utc::now().timestamp_millis(),
                    seq: 0,
                    boot_epoch: 0,
                });
            }

            // Terminal frame — return whatever we accumulated.
            if payload
                .get("done")
                .and_then(|d| d.as_bool())
                .unwrap_or(false)
            {
                if was_thinking {
                    accumulated.push_str("\n</think>\n");
                    thinking_buf.push_str("\n</think>\n");
                    // MIGRATED sprint-9 → bus push channel only
                    publish(SunnyEvent::ChatChunk {
                        turn_id: turn_id.to_string(),
                        delta: "\n</think>\n".to_string(),
                        done: false,
                        at: chrono::Utc::now().timestamp_millis(),
                        seq: 0,
                        boot_epoch: 0,
                    });
                }
                return Ok(NdjsonResult::Final { text: accumulated, ttft_ms });
            }
        }
    }

    log::warn!("ollama NDJSON: stream closed without done=true");
    if was_thinking {
        accumulated.push_str("\n</think>\n");
        thinking_buf.push_str("\n</think>\n");
        // MIGRATED sprint-9 → bus push channel only
        publish(SunnyEvent::ChatChunk {
            turn_id: turn_id.to_string(),
            delta: "\n</think>\n".to_string(),
            done: false,
            at: chrono::Utc::now().timestamp_millis(),
            seq: 0,
            boot_epoch: 0,
        });
    }
    Ok(NdjsonResult::Final { text: accumulated, ttft_ms })
}

/// Re-serialise our normalised tool calls back into Ollama's wire
/// format so the assistant turn we echo back on the next round trips
/// cleanly through /api/chat.
fn calls_to_ollama_repr(calls: &[ToolCall]) -> Vec<Value> {
    calls
        .iter()
        .map(|c| {
            json!({
                "function": {
                    "name": c.name,
                    "arguments": c.input,
                }
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Pure NDJSON frame classifier — extracted so the publish contract
// (one bus event per mid-stream delta, same turn_id, monotonic sequence)
// is unit-testable without mocking a reqwest stream or AppHandle.
// ---------------------------------------------------------------------------

/// Outcome of parsing a single NDJSON frame from ollama's /api/chat.
///
/// Today this is a test-only mirror of the logic inside
/// `drive_ndjson_stream` — the frame-by-frame delta/done/tool_use shape
/// the streaming loop threads through. Extracted so frame classification
/// is unit-testable without mocking a reqwest stream or AppHandle.
/// A future refactor should have the live streaming path call this
/// function directly so the tests and prod don't drift.
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FrameOutcome {
    pub delta: Option<String>,
    pub was_thinking: bool,
    pub done: bool,
    pub tool_use: bool,
}

/// Classify one parsed NDJSON frame. Pure — no I/O, no side effects.
/// See `FrameOutcome` for the drift note.
#[cfg(test)]
pub(crate) fn classify_ndjson_frame(payload: &Value, was_thinking: bool) -> FrameOutcome {
    // Tool-call short-circuit: any tool_calls array aborts the stream.
    if payload
        .get("message")
        .and_then(|m| m.get("tool_calls"))
        .and_then(|tc| tc.as_array())
        .is_some_and(|arr| !arr.is_empty())
    {
        return FrameOutcome {
            delta: None,
            was_thinking,
            done: false,
            tool_use: true,
        };
    }

    let msg = payload.get("message");
    let mut delta_str = String::new();
    let mut next_thinking = was_thinking;

    if let Some(t) = msg
        .and_then(|m| m.get("thinking"))
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
    {
        if !next_thinking {
            next_thinking = true;
            delta_str.push_str("<think>\n");
        }
        delta_str.push_str(t);
    } else if let Some(c) = msg
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
    {
        if next_thinking {
            next_thinking = false;
            delta_str.push_str("\n</think>\n");
        }
        delta_str.push_str(c);
    }

    let done = payload
        .get("done")
        .and_then(|d| d.as_bool())
        .unwrap_or(false);

    FrameOutcome {
        delta: if delta_str.is_empty() {
            None
        } else {
            Some(delta_str)
        },
        was_thinking: next_thinking,
        done,
        tool_use: false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_bus::{self, tail_by_kind};
    use serde_json::json;

    /// A clean content-only delta frame produces one bus-ready delta
    /// and doesn't flip the thinking flag.
    #[test]
    fn content_frame_emits_plain_delta() {
        let frame = json!({
            "model": "qwen3",
            "message": {"role": "assistant", "content": "hello "},
            "done": false
        });
        let out = classify_ndjson_frame(&frame, false);
        assert_eq!(out.delta.as_deref(), Some("hello "));
        assert!(!out.was_thinking);
        assert!(!out.done);
        assert!(!out.tool_use);
    }

    /// First thinking frame wraps the delta in `<think>\n` and flips
    /// the was_thinking flag so subsequent frames don't re-open.
    #[test]
    fn first_thinking_frame_opens_think_tag() {
        let frame = json!({
            "message": {"role": "assistant", "thinking": "reasoning..."},
            "done": false
        });
        let out = classify_ndjson_frame(&frame, false);
        assert_eq!(out.delta.as_deref(), Some("<think>\nreasoning..."));
        assert!(out.was_thinking);
    }

    /// Switching from thinking to content closes the `<think>` block.
    #[test]
    fn thinking_to_content_closes_tag() {
        let frame = json!({
            "message": {"role": "assistant", "content": "the answer"},
            "done": false
        });
        let out = classify_ndjson_frame(&frame, /* was_thinking = */ true);
        assert_eq!(out.delta.as_deref(), Some("\n</think>\nthe answer"));
        assert!(!out.was_thinking);
    }

    /// Terminal frame with `done: true` is flagged so the caller can
    /// emit its own zero-delta done chunk on the bus.
    #[test]
    fn terminal_frame_flags_done() {
        let frame = json!({"message": {"role": "assistant", "content": ""}, "done": true});
        let out = classify_ndjson_frame(&frame, false);
        assert!(out.done);
        assert!(!out.tool_use);
        assert_eq!(out.delta, None);
    }

    /// Any tool_calls array flags the frame; the live driver then
    /// returns `NdjsonResult::ToolCalls` to the caller with the partial
    /// content + raw tool_calls so `ollama_turn_streaming` can assemble
    /// `TurnOutcome::Tools` without a second round-trip. Prior to the
    /// Bottleneck D fix this flagged a non-streaming re-issue via
    /// `ollama_turn`; the classifier contract (tool_use: true, no delta)
    /// is unchanged.
    #[test]
    fn tool_calls_frame_triggers_short_circuit() {
        let frame = json!({
            "message": {
                "role": "assistant",
                "tool_calls": [{"function": {"name": "x", "arguments": {}}}]
            },
            "done": false
        });
        let out = classify_ndjson_frame(&frame, false);
        assert!(out.tool_use);
        assert_eq!(out.delta, None);
    }

    /// turn_id for the streaming path uses the same
    /// `{provider}:{model}:{ms}:{uuid}` shape as anthropic.rs so
    /// cross-session tails can filter every LLM turn with one regex.
    /// The uuid suffix (sprint-8 ι) disambiguates same-ms cross-session
    /// collisions. Model names can themselves contain `:` (e.g.
    /// `qwen3:30b-a3b-…`), so we parse from the RIGHT: the last two
    /// `:`-separated tokens are always `{ms}:{uuid}`.
    #[test]
    fn turn_id_shape_matches_anthropic() {
        let model = "qwen3:30b-a3b-instruct-2507-q4_K_M";
        let ms = chrono::Utc::now().timestamp_millis();
        let suffix_o = uuid::Uuid::new_v4().simple().to_string();
        let suffix_a = uuid::Uuid::new_v4().simple().to_string();
        let ollama_id = format!("ollama:{model}:{ms}:{suffix_o}");
        let anthropic_id = format!("anthropic:{model}:{ms}:{suffix_a}");
        // rsplitn(3, ':') → [uuid, ms, "provider:model…"]. Assert that
        // the trailing ms + uuid slots are present and identical shape
        // across providers.
        let o: Vec<&str> = ollama_id.rsplitn(3, ':').collect();
        let a: Vec<&str> = anthropic_id.rsplitn(3, ':').collect();
        assert_eq!(o.len(), 3);
        assert_eq!(a.len(), 3);
        // Trailing slot is the uuid suffix — same length (32 hex chars
        // from `Uuid::simple()`).
        assert_eq!(o[0].len(), 32);
        assert_eq!(a[0].len(), 32);
        // Second-to-last slot is the ms — identical across providers
        // when started at the same instant.
        assert_eq!(o[1], ms.to_string());
        assert_eq!(a[1], ms.to_string());
        // Two turns started at the same ms must produce distinct ids.
        let ollama_id_2 = format!(
            "ollama:{model}:{ms}:{}",
            uuid::Uuid::new_v4().simple()
        );
        assert_ne!(
            ollama_id, ollama_id_2,
            "same-ms turn_ids must differ thanks to the uuid suffix"
        );
    }

    /// Full-stream integration test. Publishes a series of ChatChunk
    /// events the way `drive_ndjson_stream` would for a 4-frame
    /// ollama response (3 content deltas + a terminal done frame),
    /// then tails the bus and asserts:
    ///   * Exactly 4 ChatChunk rows landed (3 mid-stream + 1 terminal).
    ///   * Every row carries the same turn_id.
    ///   * `at` timestamps are monotonically non-decreasing.
    ///   * Only the last row has `done: true`.
    ///
    /// Runs against a tempdir-scoped event bus so the global ring
    /// isn't polluted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn multi_delta_stream_publishes_consistent_turn_id_and_monotonic_at() {
        // Scope the event bus DB to a tempdir so parallel tests don't
        // collide on the global $HOME/.sunny/events.sqlite.
        let tmp = std::env::temp_dir()
            .join(format!("sunny-ollama-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).expect("mkdir tmp");
        let _ = event_bus::init_in(&tmp);

        // Four frames: "hel", "lo ", "world", done.
        let frames = vec![
            json!({"message": {"content": "hel"}, "done": false}),
            json!({"message": {"content": "lo "}, "done": false}),
            json!({"message": {"content": "world"}, "done": false}),
            json!({"message": {"content": ""}, "done": true}),
        ];

        // Pin a deterministic turn_id (matches the production shape).
        let turn_start_ms = chrono::Utc::now().timestamp_millis();
        let model = "qwen3:test";
        let turn_id = format!("ollama:{model}:{turn_start_ms}");

        // Drive the classifier + bus publish the same way
        // drive_ndjson_stream does, but without reqwest/AppHandle.
        let mut was_thinking = false;
        let mut mid_stream_publishes = 0u32;
        for frame in &frames {
            let out = classify_ndjson_frame(frame, was_thinking);
            was_thinking = out.was_thinking;
            if let Some(delta) = out.delta {
                event_bus::publish(event_bus::SunnyEvent::ChatChunk {
                    turn_id: turn_id.clone(),
                    delta,
                    done: false,
                    at: chrono::Utc::now().timestamp_millis(),
                    seq: 0,
                    boot_epoch: 0,
                });
                mid_stream_publishes += 1;
            }
            // Terminal done frame — caller emits a zero-delta bus event
            // with done=true, mirroring ollama_turn_streaming.
            if out.done {
                event_bus::publish(event_bus::SunnyEvent::ChatChunk {
                    turn_id: turn_id.clone(),
                    delta: String::new(),
                    done: true,
                    at: chrono::Utc::now().timestamp_millis(),
                    seq: 0,
                    boot_epoch: 0,
                });
            }
        }
        assert_eq!(
            mid_stream_publishes, 3,
            "expected 3 mid-stream deltas, got {mid_stream_publishes}"
        );

        // Let the bus drain task commit.
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            let seen = tail_by_kind("ChatChunk", 50).await;
            // Sprint-7 event bus adds a monotonic `seq` field to every
            // variant; pattern-match it out alongside the turn_id so we
            // can assert both ordering invariants at once.
            let ours: Vec<_> = seen
                .iter()
                .filter_map(|e| match e {
                    event_bus::SunnyEvent::ChatChunk {
                        turn_id: t,
                        delta,
                        done,
                        at,
                        seq,
                        boot_epoch: _,
                    } if t == &turn_id => {
                        Some((delta.clone(), *done, *at, *seq))
                    }
                    _ => None,
                })
                .collect();
            if ours.len() >= 4 {
                // tail_by_kind is newest-first; reverse to chronological.
                let mut chrono: Vec<_> = ours.into_iter().rev().collect();
                assert_eq!(
                    chrono.len(),
                    4,
                    "expected 4 ChatChunk rows for turn, got {}",
                    chrono.len()
                );
                // Monotonic `at` AND strictly increasing `seq` — the
                // pair of guarantees κ's review flagged as missing from
                // Ollama's asymmetric publishes.
                for w in chrono.windows(2) {
                    assert!(
                        w[0].2 <= w[1].2,
                        "at timestamps regressed: {} > {}",
                        w[0].2,
                        w[1].2
                    );
                    assert!(
                        w[0].3 < w[1].3,
                        "seq must strictly increase across a turn: {} !< {}",
                        w[0].3,
                        w[1].3
                    );
                }
                // Only the last row is terminal.
                let terminal = chrono.pop().unwrap();
                assert!(terminal.1, "last chunk should have done=true");
                assert_eq!(terminal.0, "", "terminal chunk delta should be empty");
                for row in &chrono {
                    assert!(!row.1, "mid-stream chunk should have done=false");
                }
                // Re-assembled text matches the original stream.
                let joined: String = chrono.iter().map(|r| r.0.as_str()).collect();
                assert_eq!(joined, "hello world");
                let _ = std::fs::remove_dir_all(&tmp);
                return;
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        panic!("event bus never surfaced the 4 expected ChatChunk rows");
    }
}
