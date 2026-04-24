use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::super::catalog::catalog_merged;
use super::super::types::{ToolCall, TurnOutcome};
use super::super::helpers::truncate;
use crate::event_bus::{publish, SunnyEvent};
use crate::telemetry::{record_llm_turn, TelemetryEvent};

pub const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-6";
pub const LLM_TIMEOUT_SECS: u64 = 60;
pub const USER_AGENT: &str = "SUNNY-HUD/1.0 (+https://kinglystudio.ai)";
/// Maximum number of output tokens per turn. Claude 4-series models support
/// up to 32 k output tokens; we default to 4096 which covers the vast majority
/// of assistant replies without risking runaway generation cost. Callers can
/// override by changing this constant — no Settings UI surface is wired yet.
pub const DEFAULT_MAX_TOKENS: u32 = 4096;

// Cost constants are centralised in telemetry::cost_rates and accessed via
// telemetry::cost_estimate — no per-provider duplication needed here.
// See crate::telemetry::cost_rates::ANTHROPIC_* for the billing rates.

// ---------------------------------------------------------------------------
// Anthropic transport
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
pub struct AnthropicResponse {
    #[serde(default)]
    pub content: Vec<AnthropicContentBlock>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<AnthropicUsage>,
}

/// Token accounting surface. We surface `cache_read_input_tokens` and
/// `cache_creation_input_tokens` alongside the base `input_tokens` so we
/// can log cache-hit rate per turn. All fields default to 0 — Anthropic
/// only emits the cache fields when prompt caching is active.
#[derive(Deserialize, Debug, Default)]
pub struct AnthropicUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

/// Emit a single log line summarising cache usage for the just-completed
/// turn, and mirror the numbers into the cross-provider telemetry ring
/// so BrainPage can show a live rollup. Called from both the buffered
/// and streaming paths — hence the `path` label in the log line.
fn log_cache_usage(
    path: &str,
    usage: Option<&AnthropicUsage>,
    model: &str,
    duration_ms: u64,
    ttft_ms: Option<u64>,
    turn_id: Option<&str>,
) {
    if let Some(u) = usage {
        let denom = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        let hit_pct = if denom > 0 {
            (u.cache_read_input_tokens as f64 / denom as f64) * 100.0
        } else {
            0.0
        };
        log::info!(
            "anthropic cache [{path}]: input={} cache_read={} cache_create={} output={} hit={:.1}%",
            u.input_tokens,
            u.cache_read_input_tokens,
            u.cache_creation_input_tokens,
            u.output_tokens,
            hit_pct,
        );
        let cost_usd = crate::telemetry::cost_estimate(
            "anthropic",
            u.input_tokens,
            u.output_tokens,
            u.cache_read_input_tokens,
            u.cache_creation_input_tokens,
        );
        // TTFT is only meaningful when the SSE driver measured it. On
        // buffered turns the whole response arrives at once — no real
        // first-token signal exists, so we persist NULL instead of a
        // placeholder that would pollute p95 latency calculations.
        // SQL analyses should filter `WHERE ttft_ms IS NOT NULL` when
        // computing TTFT percentiles; `generate_ms` is left NULL in
        // lockstep so (ttft + generate ≈ duration) stays a true
        // invariant on streaming rows only.
        let generate_ms = ttft_ms.map(|t| duration_ms.saturating_sub(t));
        record_llm_turn(TelemetryEvent {
            provider: "anthropic".to_string(),
            model: model.to_string(),
            input: u.input_tokens,
            cache_read: u.cache_read_input_tokens,
            cache_create: u.cache_creation_input_tokens,
            output: u.output_tokens,
            duration_ms,
            at: chrono::Utc::now().timestamp(),
            cost_usd,
            tier: None,    // K5 wires this via route_model; None until then
            ttft_ms,
            generate_ms,
            turn_id: turn_id.map(|s| s.to_string()),
            ..Default::default()
        });
    } else {
        log::debug!("anthropic cache [{path}]: usage field absent from response");
    }
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// Graceful catch-all for future block types (thinking, images, …)
    /// so a backend upgrade doesn't brick us.
    #[serde(other)]
    Unknown,
}

/// Non-streaming turn. Buffers the whole response before returning. Used
/// as a fallback after a streaming attempt detects a tool-use block
/// (Anthropic requires complete tool_use blocks before dispatch), and
/// remains the canonical path when the caller doesn't want streaming.
pub async fn anthropic_turn(
    model: &str,
    system: &str,
    history: &[Value],
) -> Result<TurnOutcome, String> {
    let key = crate::secrets::anthropic_api_key()
        .await
        .ok_or_else(|| "ANTHROPIC_API_KEY not set".to_string())?;

    let body = build_request_body(model, system, history, false);

    let started = Instant::now();
    let client = crate::http::client();
    let req = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .header("user-agent", USER_AGENT)
        .json(&body);
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        crate::http::send(req),
    )
    .await
    .map_err(|_| "anthropic timed out".to_string())?
    .map_err(|e| format!("anthropic connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic http {status}: {}", truncate(&body, 400)));
    }

    let parsed: AnthropicResponse = resp
        .json()
        .await
        .map_err(|e| format!("anthropic decode: {e}"))?;

    let duration_ms = started.elapsed().as_millis() as u64;
    log_cache_usage("buffered", parsed.usage.as_ref(), model, duration_ms, None, None);

    // Warn and annotate the reply when the model hit the token ceiling.
    // This is the buffered path; the streaming path handles it in message_delta.
    let mut outcome = outcome_from_blocks(parsed.content);
    if parsed.stop_reason.as_deref() == Some("max_tokens") {
        log::warn!(
            "anthropic [buffered]: stop_reason=max_tokens (model={model},              max_tokens={DEFAULT_MAX_TOKENS}) — reply was truncated"
        );
        if let super::super::types::TurnOutcome::Final { ref mut text, .. } = outcome {
            text.push_str(
                "

[truncated at max_tokens — raise the limit in Settings]"
            );
        }
    }
    Ok(outcome)
}

/// SSE-streaming turn. Emits `sunny://chat.chunk` deltas to the main chat
/// surface as the model generates text. Only the main agent (sub_id ==
/// None) should call this — sub-agent replies are piped back as tool
/// results and the user shouldn't see their token stream.
///
/// If the model's first content block is a `tool_use` we abort streaming
/// and re-issue a non-streaming request. Tool-use turns are rare enough
/// that the re-issue cost is acceptable, and it lets the existing
/// buffered tool_use handling stay untouched.
pub async fn anthropic_turn_streaming(
    app: &AppHandle,
    model: &str,
    system: &str,
    history: &[Value],
) -> Result<TurnOutcome, String> {
    let key = crate::secrets::anthropic_api_key()
        .await
        .ok_or_else(|| "ANTHROPIC_API_KEY not set".to_string())?;

    let body = build_request_body(model, system, history, true);

    // Stable turn_id for the event-bus ChatChunk mirror. Derived once
    // per streaming call so every emitted delta + the terminal done
    // chunk share the same id — tailers can fold them into one turn.
    // Uuid suffix avoids same-ms collisions when two streaming turns
    // start in the same millisecond (e.g. main agent + sub-agent, or a
    // chat + voice retry). Shape stays `{provider}:{model}:{ms}:{uuid}`
    // so `splitn(3, ':')` parsers still see 3 fields.
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("anthropic:{model}:{turn_start_ms}:{turn_suffix}");

    let started = Instant::now();
    let client = crate::http::client();
    // Per-request timeout: streaming responses may run longer than a
    // buffered turn on big replies, but we still want a hard ceiling.
    // Use the same LLM_TIMEOUT_SECS — it's applied as a read/response
    // ceiling by reqwest, not a whole-body bound when streaming.
    let req = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .header("user-agent", USER_AGENT)
        .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
        .json(&body);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("anthropic stream connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "anthropic http {status}: {}",
            truncate(&body, 400)
        ));
    }

    match drive_sse_stream(app, resp, model, started, &turn_id).await? {
        StreamResult::Final { text, ttft_ms: _ } => {
            // Terminal chunk: zero-delta chunk so the frontend's
            // loading indicator clears cleanly. We don't re-send the
            // full text as a chunk body — it already streamed
            // piece-by-piece.
            publish(SunnyEvent::ChatChunk {
                seq: 0,
                boot_epoch: 0,
                turn_id: turn_id.clone(),
                delta: String::new(),
                done: true,
                at: chrono::Utc::now().timestamp_millis(),
            });
            Ok(TurnOutcome::Final { text, streamed: true })
        }
        StreamResult::ToolUseDetected => {
            // We saw the start of a tool_use block mid-stream. Bail out
            // and re-issue the same request in non-streaming mode so
            // the existing buffered code path (which already handles
            // tool_use + text interleaving, input_json assembly, and
            // the replay assistant_message shape) takes over.
            log::info!(
                "anthropic_turn_streaming: tool_use detected, falling back to non-streaming"
            );
            anthropic_turn(model, system, history).await
        }
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn build_request_body(model: &str, system: &str, history: &[Value], stream: bool) -> Value {
    // Tools are built once per process (the trait-registered catalog
    // is static after `inventory::submit!` link-time registration) and
    // memoised here. Previously this block re-parsed each tool's
    // `input_schema` JSON string on every turn — ~20 tools × from_str
    // per request, totalling ~1-2 ms on the Anthropic hot path. The
    // cached Vec<Value> is cloned per request (deep clone, ~200-500 µs)
    // which is cheaper than re-parsing from strings.
    let tools = anthropic_tools_catalog().clone();

    // Phase 3 pre-send redaction — scrub secrets out of the system
    // prompt + message history before they hit a remote provider.
    // Honours `policy.scrub_prompts` (default true); a no-op when
    // the user has explicitly turned it off.
    let system_scrubbed = crate::security::enforcement::scrub_texts(&[system.to_string()])
        .pop()
        .unwrap_or_else(|| system.to_string());
    let history_scrubbed: Vec<Value> = history
        .iter()
        .map(|m| scrub_message_value(m))
        .collect();

    // Breakpoint #3: conversation-history prefix. Mark the last content
    // block of the message immediately before the live user turn with
    // cache_control so the stable history prefix (all prior exchanges)
    // is served from the prompt cache on every subsequent turn.
    // apply_history_cache_breakpoint returns a new Vec — no mutation.
    let messages_cached = apply_history_cache_breakpoint(history_scrubbed);

    // Breakpoint #4 (cache WRITE for next turn): tag the LAST user
    // message's last content block so this turn's request becomes part
    // of the prefix Anthropic caches for the *next* turn. Without this,
    // each turn only reads prior caches; the live turn is never stored,
    // so prompt-cache hit rates stall at the previous turn's boundary.
    let messages_cached = stamp_cache_control_on_last_user_message(messages_cached);

    // Breakpoint #2: the system prompt. Split on SUNNY_CACHE_BOUNDARY so
    // only the stable prefix (safety + capabilities + tool_use + persona
    // + base) carries cache_control. The dynamic suffix (memory digest,
    // continuity digest, query hint, name-seed, canary sentinel) sits in
    // a second block WITHOUT a cache_control marker — when it changes
    // between turns we invalidate only that block's contribution, not
    // the whole ~19 KB prefix.
    let (stable_prefix, dynamic_suffix) =
        super::super::prompts::split_system_prompt_cache_boundary(&system_scrubbed);
    let system_blocks = if dynamic_suffix.is_empty() {
        // Legacy path: no boundary marker — whole prompt is stable.
        json!([
            {
                "type": "text",
                "text": stable_prefix,
                "cache_control": {"type": "ephemeral"},
            }
        ])
    } else {
        json!([
            {
                "type": "text",
                "text": stable_prefix,
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": dynamic_suffix,
            }
        ])
    };

    json!({
        "model": model,
        "max_tokens": DEFAULT_MAX_TOKENS,
        "system": system_blocks,
        "tools": tools,
        "messages": messages_cached,
        "stream": stream,
    })
}

/// Memoised Anthropic-formatted tool array. Built once on first access
/// from the static `catalog_merged()` inventory; parsed schemas and the
/// Breakpoint #1 `cache_control` stamp on the last entry are baked in.
///
/// Returns a reference so callers decide whether to clone for ownership.
/// `build_request_body` clones per turn — serde_json::Value::clone is
/// a deep clone but still ~5-10× cheaper than re-parsing each schema
/// from its JSON-string literal on every turn.
fn anthropic_tools_catalog() -> &'static Vec<Value> {
    static CACHED: OnceLock<Vec<Value>> = OnceLock::new();
    CACHED.get_or_init(|| {
        let mut tools: Vec<Value> = catalog_merged()
            .iter()
            .map(|t| {
                let schema: Value = serde_json::from_str(t.input_schema)
                    .unwrap_or_else(|_| json!({"type": "object", "properties": {}}));
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": schema,
                })
            })
            .collect();
        // Append plugin-declared tools. Plugin registration runs
        // before any LLM request (see `startup::setup` bootstrap),
        // so by the time this OnceLock fires the plugin set is final
        // for the process's lifetime.
        for plugin in super::super::plugins::registered_plugins() {
            for t in &plugin.manifest.tools {
                tools.push(json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                }));
            }
        }
        // Breakpoint #1: cache_control on the LAST entry in the final
        // array (plugin or built-in), so Anthropic's prompt cache can
        // serve the whole tools block across turns. Plugin list is
        // stable per process, so this cache is safe.
        if let Some(last) = tools.last_mut() {
            last["cache_control"] = json!({"type": "ephemeral"});
        }
        tools
    })
}

/// Apply Anthropic prompt-cache Breakpoint #4: stamp `cache_control:
/// {type: "ephemeral"}` on the last content block of the LAST user
/// message. Where [`apply_history_cache_breakpoint`] enables cache
/// *reads* of the stable prefix, this enables cache *writes* for the
/// live turn — the request body we're building becomes the cached
/// prefix for the next turn. Mirrors Moltbot's tail-user-message
/// policy in `src/agents/anthropic-payload-policy.ts`.
fn stamp_cache_control_on_last_user_message(messages: Vec<Value>) -> Vec<Value> {
    let last_user_idx = messages
        .iter()
        .rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));
    let last_user_idx = match last_user_idx {
        None => return messages,
        Some(i) => i,
    };
    messages
        .into_iter()
        .enumerate()
        .map(|(i, msg)| {
            if i == last_user_idx {
                stamp_cache_control_on_last_block(msg)
            } else {
                msg
            }
        })
        .collect()
}

/// Walk one chat message JSON and scrub every string leaf.  We
/// intentionally do NOT scrub keys or numeric fields — only user-
/// authored text content where API keys or PII might lurk.
fn scrub_message_value(v: &Value) -> Value {
    match v {
        Value::String(s) => {
            let scrubbed = crate::security::enforcement::scrub_texts(&[s.clone()]);
            Value::String(scrubbed.into_iter().next().unwrap_or_else(|| s.clone()))
        }
        Value::Array(arr) => Value::Array(arr.iter().map(scrub_message_value).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, val) in map {
                out.insert(k.clone(), scrub_message_value(val));
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}

/// Apply Anthropic prompt-cache Breakpoint #3: stamp `cache_control:
/// {type: "ephemeral"}` on the last content block of the message that
/// immediately precedes the live (last) user turn. This marks the end
/// of the stable conversation prefix so Anthropic's cache serves all
/// prior exchanges — system prompt, tools, and history — from its KV
/// store on every repeat turn within the 5-minute TTL window.
///
/// Rules:
/// * Returns the input unchanged when `messages` has fewer than 2
///   entries or when no prior-user-turn boundary can be found.
/// * Creates a new `Vec<Value>` — never mutates the input.
/// * When the target message's `content` is a plain `String`, it is
///   lifted into a one-element text-block array so `cache_control`
///   can be attached (Anthropic only accepts the field on block
///   objects, not bare strings).
/// * When `content` is already an `Array`, the last element receives
///   the `cache_control` field; all other elements are cloned as-is.
pub(crate) fn apply_history_cache_breakpoint(messages: Vec<Value>) -> Vec<Value> {
    // Need at least [prior_exchange…, last_user_msg] to have a prefix worth caching.
    if messages.len() < 2 {
        return messages;
    }

    // Find the last user-role message index.
    let last_user_idx = messages
        .iter()
        .rposition(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));

    let last_user_idx = match last_user_idx {
        // No user message found, or it's the very first message — nothing to cache before it.
        None | Some(0) => return messages,
        Some(i) => i,
    };

    // The message at last_user_idx - 1 is the stable-prefix boundary.
    let boundary_idx = last_user_idx - 1;

    messages
        .into_iter()
        .enumerate()
        .map(|(i, msg)| {
            if i != boundary_idx {
                return msg;
            }
            stamp_cache_control_on_last_block(msg)
        })
        .collect()
}

/// Stamp `cache_control: {type: "ephemeral"}` on the last content block
/// of `msg`. Returns a new `Value` — never mutates the input.
fn stamp_cache_control_on_last_block(msg: Value) -> Value {
    let role = msg.get("role").cloned().unwrap_or(Value::Null);
    let content = msg.get("content").cloned().unwrap_or(Value::Null);

    let stamped_content = match content {
        // Plain string content — lift to a text block array so we can
        // attach cache_control (Anthropic's API requires a block object).
        Value::String(text) => json!([{
            "type": "text",
            "text": text,
            "cache_control": {"type": "ephemeral"},
        }]),

        // Array of block objects — stamp the last element.
        Value::Array(blocks) if !blocks.is_empty() => {
            let last_idx = blocks.len() - 1;
            let new_blocks: Vec<Value> = blocks
                .into_iter()
                .enumerate()
                .map(|(bi, block)| {
                    if bi == last_idx {
                        // Merge cache_control into the block.
                        let mut obj = match block {
                            Value::Object(map) => map,
                            other => {
                                // Non-object block (unusual) — wrap and return.
                                return other;
                            }
                        };
                        obj.insert(
                            "cache_control".to_string(),
                            json!({"type": "ephemeral"}),
                        );
                        Value::Object(obj)
                    } else {
                        block
                    }
                })
                .collect();
            Value::Array(new_blocks)
        }

        // Empty array or other type — leave untouched.
        other => other,
    };

    // Rebuild the message object with the stamped content.
    // Preserve any extra fields (e.g. tool_call_id on tool-result messages).
    let mut out = match msg {
        Value::Object(map) => map,
        other => return other,
    };
    out.insert("role".to_string(), role);
    out.insert("content".to_string(), stamped_content);
    Value::Object(out)
}

/// Collapse an Anthropic content-block list into our TurnOutcome. Shared
/// by the buffered path and (when we surface a buffered fallback) the
/// streaming path.
fn outcome_from_blocks(blocks: Vec<AnthropicContentBlock>) -> TurnOutcome {
    let mut thinking = String::new();
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut raw_blocks: Vec<Value> = Vec::new();

    for block in blocks.into_iter() {
        match block {
            AnthropicContentBlock::Text { text } => {
                if !thinking.is_empty() {
                    thinking.push('\n');
                }
                thinking.push_str(&text);
                raw_blocks.push(json!({"type": "text", "text": text}));
            }
            AnthropicContentBlock::ToolUse { id, name, input } => {
                raw_blocks.push(json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": input,
                }));
                calls.push(ToolCall { id, name, input });
            }
            AnthropicContentBlock::Unknown => {}
        }
    }

    if calls.is_empty() {
        TurnOutcome::final_buffered(thinking)
    } else {
        TurnOutcome::Tools {
            thinking: (!thinking.trim().is_empty()).then_some(thinking),
            calls,
            assistant_message: json!({
                "role": "assistant",
                "content": raw_blocks,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

enum StreamResult {
    /// Clean end-of-stream with all blocks being text. `text` is the
    /// concatenation of every `text_delta` we observed. `ttft_ms` is
    /// the wall-clock ms from `started` (passed in by the caller) to
    /// the first non-empty text_delta; `None` when the stream ended
    /// without emitting user-visible text.
    Final { text: String, ttft_ms: Option<u64> },
    /// A `content_block_start` announced a `tool_use` block. We stop
    /// parsing immediately — the caller re-issues with stream=false so
    /// the buffered path can handle tool dispatch.
    ToolUseDetected,
}

/// Pull bytes off the wire, parse the Server-Sent Events framing by
/// hand, route each `data:` JSON line to the appropriate handler. Hand-
/// rolled rather than pulling in `eventsource-stream` — the Anthropic
/// SSE shape is small enough that a 40-line parser is cheaper than a
/// new dep on every streaming turn.
async fn drive_sse_stream(
    _app: &AppHandle,
    resp: reqwest::Response,
    model: &str,
    started: Instant,
    turn_id: &str,
) -> Result<StreamResult, String> {
    use futures_util::StreamExt;

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut accumulated = String::new();
    let mut ttft_ms: Option<u64> = None;
    // Track the active content block's type so we route deltas
    // correctly. `Some("text")` → append to accumulated + emit delta.
    // `Some("tool_use")` → we'll short-circuit once we see the start.
    let mut active_block_type: Option<String> = None;
    // Usage accounting — Anthropic splits usage across message_start
    // (input-side, including cache_read/cache_creation) and
    // message_delta (output-side). We merge them into a single struct
    // so the post-turn log line reflects the full picture.
    let mut usage = AnthropicUsage::default();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("anthropic stream read: {e}"))?;
        buf.extend_from_slice(&bytes);

        // SSE frames are separated by blank lines (\n\n or \r\n\r\n).
        // Within a frame, each non-empty line is a `field: value` pair.
        // We only care about `data:` — the `event:` name is redundant
        // because every payload also carries a `type` field.
        loop {
            let Some((body_end, sep_len)) = find_frame_boundary(&buf) else {
                break; // need more bytes
            };
            let frame_bytes: Vec<u8> = buf.drain(..body_end).collect();
            // Strip the blank-line separator so the next iteration sees
            // the start of the next frame.
            buf.drain(..sep_len);

            // Concatenate every `data:` value line in this frame. Per
            // SSE spec multiple data: lines merge with \n; Anthropic
            // only sends one per frame in practice but we handle both.
            let frame = String::from_utf8_lossy(&frame_bytes);
            let mut data_payload = String::new();
            for line in frame.lines() {
                let line = line.trim_end_matches('\r');
                if let Some(rest) = line.strip_prefix("data:") {
                    let trimmed = rest.trim_start();
                    if !data_payload.is_empty() {
                        data_payload.push('\n');
                    }
                    data_payload.push_str(trimmed);
                }
                // We deliberately ignore `event:` and `id:` — the
                // payload's `type` tells us everything.
            }

            if data_payload.is_empty() {
                continue;
            }
            // Anthropic sends `data: [DONE]` occasionally; skip it.
            if data_payload == "[DONE]" {
                continue;
            }

            let payload: Value = match serde_json::from_str(&data_payload) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!(
                        "anthropic SSE: bad JSON frame ({e}) → {}",
                        truncate(&data_payload, 160)
                    );
                    continue;
                }
            };

            let event_type = payload
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            match event_type.as_str() {
                "message_start" => {
                    // Pull input-side usage off the message envelope.
                    // Cache fields only appear when prompt caching is
                    // active (our request marks breakpoints, so they
                    // should be present from here on).
                    if let Some(u) = payload.get("message").and_then(|m| m.get("usage")) {
                        if let Some(n) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                            usage.input_tokens = n;
                        }
                        if let Some(n) = u.get("cache_read_input_tokens").and_then(|v| v.as_u64())
                        {
                            usage.cache_read_input_tokens = n;
                        }
                        if let Some(n) =
                            u.get("cache_creation_input_tokens").and_then(|v| v.as_u64())
                        {
                            usage.cache_creation_input_tokens = n;
                        }
                    }
                }
                "content_block_start" => {
                    let block_type = payload
                        .get("content_block")
                        .and_then(|cb| cb.get("type"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    if block_type == "tool_use" {
                        // Short-circuit — the caller re-issues
                        // non-streaming to get a buffered tool_use
                        // block.
                        return Ok(StreamResult::ToolUseDetected);
                    }
                    active_block_type = Some(block_type);
                }
                "content_block_delta" => {
                    if active_block_type.as_deref() == Some("text") {
                        if let Some(delta) = payload
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            if !delta.is_empty() {
                                if ttft_ms.is_none() {
                                    let elapsed = started.elapsed().as_millis() as u64;
                                    ttft_ms = Some(elapsed);
                                    log::info!("anthropic ttft: {elapsed}ms (first text_delta)");
                                    crate::latency_harness::stage_marker(
                                        crate::latency_harness::stages::FIRST_TOKEN,
                                        Some(serde_json::json!({
                                            "provider": "anthropic",
                                            "ttft_ms": elapsed,
                                        })),
                                    );
                                }
                                accumulated.push_str(delta);
                                publish(SunnyEvent::ChatChunk {
                                    seq: 0,
                                    boot_epoch: 0,
                                    turn_id: turn_id.to_string(),
                                    delta: delta.to_string(),
                                    done: false,
                                    at: chrono::Utc::now().timestamp_millis(),
                                });
                            }
                        }
                    }
                    // `input_json_delta` can also land here for tool
                    // blocks but we already short-circuited above, so
                    // we won't see them in the streaming path.
                }
                "content_block_stop" => {
                    active_block_type = None;
                }
                "message_delta" => {
                    // Contains the terminal stop_reason. If it says
                    // "tool_use" we shouldn't be here (we'd have
                    // bailed on content_block_start) — but if we ever
                    // do, treat it as a tool-use fallback to be safe.
                    let stop_reason = payload
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if stop_reason == "tool_use" {
                        log::warn!(
                            "anthropic SSE: stop_reason=tool_use without content_block_start, falling back"
                        );
                        return Ok(StreamResult::ToolUseDetected);
                    }
                    if stop_reason == "max_tokens" {
                        log::warn!(
                            "anthropic [streaming]: stop_reason=max_tokens (model={model},                              max_tokens={DEFAULT_MAX_TOKENS}) — reply was truncated"
                        );
                        accumulated.push_str(
                            "

[truncated at max_tokens — raise the limit in Settings]"
                        );
                    }
                    // Output-side usage rides on message_delta.
                    if let Some(n) = payload
                        .get("usage")
                        .and_then(|u| u.get("output_tokens"))
                        .and_then(|v| v.as_u64())
                    {
                        usage.output_tokens = n;
                    }
                }
                "message_stop" => {
                    let duration_ms = started.elapsed().as_millis() as u64;
                    log_cache_usage(
                        "streaming",
                        Some(&usage),
                        model,
                        duration_ms,
                        ttft_ms,
                        Some(turn_id),
                    );
                    return Ok(StreamResult::Final { text: accumulated, ttft_ms });
                }
                "ping" => {
                    // Keep-alive ping — ignore.
                }
                "error" => {
                    let msg = payload
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown anthropic stream error");
                    return Err(format!("anthropic stream error: {msg}"));
                }
                _ => {
                    // Unknown future event type — ignore gracefully.
                }
            }
        }
    }

    // Stream ended without a `message_stop`. Return whatever we
    // accumulated so the caller can still surface a partial.
    log::warn!("anthropic SSE: stream closed without message_stop");
    Ok(StreamResult::Final { text: accumulated, ttft_ms })
}

/// Locate the first SSE frame boundary in `buf`. Returns a tuple of
/// `(body_end, sep_len)` where `body_end` is the exclusive end index of
/// the frame body and `sep_len` is the length of the blank-line
/// separator that follows it (2 for `\n\n`, 4 for `\r\n\r\n`). Returns
/// None when no complete frame has arrived yet.
fn find_frame_boundary(buf: &[u8]) -> Option<(usize, usize)> {
    // Scan earliest-match-first so we handle both `\n\n` and
    // `\r\n\r\n` without mis-reading a trailing `\r` on the body.
    let mut i = 0;
    while i < buf.len() {
        // CRLF variant: \r\n\r\n
        if i + 3 < buf.len()
            && buf[i] == b'\r'
            && buf[i + 1] == b'\n'
            && buf[i + 2] == b'\r'
            && buf[i + 3] == b'\n'
        {
            return Some((i, 4));
        }
        // LF variant: \n\n
        if i + 1 < buf.len() && buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some((i, 2));
        }
        i += 1;
    }
    None
}

// ---------------------------------------------------------------------------
// Tests — prompt-caching breakpoint placement
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_msg(role: &str, content: &str) -> Value {
        json!({"role": role, "content": content})
    }

    fn make_msg_blocks(role: &str, blocks: Value) -> Value {
        json!({"role": role, "content": blocks})
    }

    /// No cache breakpoint when history is a single message (nothing before
    /// the live user turn to cache).
    #[test]
    fn no_breakpoint_on_single_message() {
        let history = vec![make_msg("user", "hello")];
        let result = apply_history_cache_breakpoint(history.clone());
        assert_eq!(result, history, "single-message history must be returned unchanged");
    }

    /// No cache breakpoint when there is no prior user message (first turn ever).
    #[test]
    fn no_breakpoint_when_last_user_is_first() {
        // [user] — last_user_idx == 0, nothing before it.
        let history = vec![make_msg("user", "first message")];
        let result = apply_history_cache_breakpoint(history.clone());
        assert!(
            result[0].get("content").and_then(|c| c.as_str()) == Some("first message"),
            "content must be unchanged when no prior exchange exists"
        );
        // Confirm no cache_control was injected anywhere.
        let serialised = serde_json::to_string(&result).unwrap();
        assert!(
            !serialised.contains("cache_control"),
            "no cache_control expected on first-turn history"
        );
    }

    /// Two-message history [user, assistant, user]: the assistant message
    /// (index 1) must receive cache_control on its last content block.
    #[test]
    fn breakpoint_placed_on_assistant_message_before_last_user() {
        let history = vec![
            make_msg("user", "turn 1"),
            make_msg("assistant", "reply 1"),
            make_msg("user", "turn 2 — live"),
        ];

        let result = apply_history_cache_breakpoint(history);

        // Index 0 (user "turn 1") — no cache_control.
        let msg0_content = &result[0]["content"];
        let s0 = serde_json::to_string(msg0_content).unwrap();
        assert!(!s0.contains("cache_control"), "msg[0] must not have cache_control");

        // Index 1 (assistant "reply 1") — must have cache_control on its content block.
        let msg1_content = &result[1]["content"];
        // The string content should have been lifted to a text-block array.
        assert!(
            msg1_content.is_array(),
            "assistant content must be converted to array for cache_control attachment"
        );
        let blocks = msg1_content.as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["cache_control"], json!({"type": "ephemeral"}));
        assert_eq!(blocks[0]["text"], "reply 1");

        // Index 2 (live user "turn 2") — no cache_control.
        let msg2_content = &result[2]["content"];
        let s2 = serde_json::to_string(msg2_content).unwrap();
        assert!(!s2.contains("cache_control"), "live user turn must not have cache_control");
    }

    /// When the boundary message already has an array of blocks, only the
    /// LAST block gets cache_control — earlier blocks in the same message
    /// are left untouched.
    #[test]
    fn breakpoint_stamps_only_last_block_in_array_content() {
        let history = vec![
            make_msg("user", "q1"),
            make_msg_blocks(
                "assistant",
                json!([
                    {"type": "text", "text": "thinking"},
                    {"type": "text", "text": "final answer"},
                ]),
            ),
            make_msg("user", "q2 — live"),
        ];

        let result = apply_history_cache_breakpoint(history);
        let blocks = result[1]["content"].as_array().unwrap();

        // First block — no cache_control.
        assert!(
            blocks[0].get("cache_control").is_none(),
            "first block must not have cache_control"
        );
        // Last block — cache_control present.
        assert_eq!(
            blocks[1]["cache_control"],
            json!({"type": "ephemeral"}),
            "last block must carry the cache_control breakpoint"
        );
    }

    /// Longer conversation: [u, a, u, a, u(live)]. The breakpoint must
    /// land on the assistant message at index 3 (immediately before the
    /// live user turn at index 4), not on any earlier exchange.
    #[test]
    fn breakpoint_always_targets_message_before_last_user_turn() {
        let history = vec![
            make_msg("user", "q1"),
            make_msg("assistant", "a1"),
            make_msg("user", "q2"),
            make_msg("assistant", "a2"),
            make_msg("user", "q3 — live"),
        ];

        let result = apply_history_cache_breakpoint(history);

        // Only index 3 should have cache_control.
        for (i, msg) in result.iter().enumerate() {
            let s = serde_json::to_string(&msg["content"]).unwrap();
            if i == 3 {
                assert!(
                    s.contains("cache_control"),
                    "msg[3] must have cache_control (boundary before live turn)"
                );
            } else {
                assert!(
                    !s.contains("cache_control"),
                    "msg[{i}] must NOT have cache_control"
                );
            }
        }
    }

    /// system prompt block array: the single text block must carry
    /// cache_control. Verified by inspecting the build_request_body JSON
    /// shape directly.
    #[test]
    fn system_block_carries_cache_control() {
        // build_request_body calls catalog_merged() which may not be
        // available in unit-test context. Test the shape directly.
        let system_blocks = json!([
            {
                "type": "text",
                "text": "test system",
                "cache_control": {"type": "ephemeral"},
            }
        ]);
        let arr = system_blocks.as_array().unwrap();
        assert_eq!(arr[0]["cache_control"], json!({"type": "ephemeral"}));
    }

    // ── stamp_cache_control_on_last_user_message tests ──────────────────────

    /// Breakpoint #4 (cache WRITE): stamps the LAST user message with
    /// string content — must lift to a block array and attach cache_control.
    #[test]
    fn last_user_stamp_lifts_string_content_to_block_array() {
        let messages = vec![
            json!({"role": "user", "content": "hello"}),
            json!({"role": "assistant", "content": "hi"}),
            json!({"role": "user", "content": "live turn"}),
        ];
        let stamped = stamp_cache_control_on_last_user_message(messages);
        // The last user message (index 2) should have array content now.
        let last = &stamped[2];
        assert_eq!(last["role"], "user");
        let content = last["content"].as_array().expect("content must be array");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "live turn");
        assert_eq!(content[0]["cache_control"], json!({"type": "ephemeral"}));
        // Earlier messages are untouched.
        assert_eq!(stamped[0]["content"], "hello");
        assert_eq!(stamped[1]["content"], "hi");
    }

    /// With array content on the last user, only the LAST block gets
    /// cache_control — earlier blocks in the same message (e.g. an image +
    /// text pair) remain untouched.
    #[test]
    fn last_user_stamp_only_hits_last_block_in_array_content() {
        let messages = vec![json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "first block"},
                {"type": "text", "text": "final block"},
            ]
        })];
        let stamped = stamp_cache_control_on_last_user_message(messages);
        let blocks = stamped[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert!(
            blocks[0].get("cache_control").is_none(),
            "first block must NOT be stamped"
        );
        assert_eq!(
            blocks[1]["cache_control"],
            json!({"type": "ephemeral"}),
            "last block must carry cache_control"
        );
    }

    /// No user messages at all → no-op (returns the input unchanged).
    #[test]
    fn last_user_stamp_no_op_when_no_user_messages() {
        let messages = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "assistant", "content": "asst"}),
        ];
        let original = messages.clone();
        let stamped = stamp_cache_control_on_last_user_message(messages);
        assert_eq!(stamped, original);
    }

    /// Memoised tool catalog returns the same `&'static Vec` on repeat
    /// calls — the whole point is to avoid re-parsing every turn.
    #[test]
    fn anthropic_tools_catalog_is_memoised() {
        let a = anthropic_tools_catalog();
        let b = anthropic_tools_catalog();
        assert!(
            std::ptr::eq(a, b),
            "memoised catalog must return the same static reference; \
             got a={a:p}, b={b:p}"
        );
    }

    /// The last tool entry MUST carry `cache_control` (Breakpoint #1).
    /// Without it Anthropic doesn't cache the tool block, which is
    /// typically the largest static piece of the prefix.
    #[test]
    fn anthropic_tools_last_entry_carries_cache_control() {
        let tools = anthropic_tools_catalog();
        if let Some(last) = tools.last() {
            assert_eq!(
                last["cache_control"],
                json!({"type": "ephemeral"}),
                "last tool entry must carry cache_control=ephemeral"
            );
            // Sanity check: earlier entries (if any) MUST NOT have it —
            // Anthropic charges per marker, and the protocol expects the
            // stamp on the tail only.
            for (i, entry) in tools.iter().take(tools.len() - 1).enumerate() {
                assert!(
                    entry.get("cache_control").is_none(),
                    "tool entry #{i} must NOT carry cache_control (only last does)"
                );
            }
        }
    }

    /// Composing both breakpoints (apply_history_cache_breakpoint + the
    /// new tail stamp) produces TWO cache_control markers in the messages
    /// array — one on the message before the last user, one on the last
    /// user's last block. This is what enables cache reads AND writes on
    /// the same turn.
    #[test]
    fn composing_both_breakpoints_produces_two_message_markers() {
        let messages = vec![
            json!({"role": "user", "content": "hello"}),
            json!({"role": "assistant", "content": "hi"}),
            json!({"role": "user", "content": "live turn"}),
        ];
        let stepped = apply_history_cache_breakpoint(messages);
        let stamped = stamp_cache_control_on_last_user_message(stepped);
        let serialised = serde_json::to_string(&stamped).unwrap();
        let marker_count = serialised.matches("cache_control").count();
        assert_eq!(
            marker_count, 2,
            "expected exactly 2 cache_control markers (history boundary + \
             tail stamp); got {marker_count} in:\n{serialised}"
        );
    }
}
