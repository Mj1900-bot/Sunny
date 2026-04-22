//! GLM / Z.AI provider adapter.
//!
//! Drives the Z.AI Coding Plan endpoint (`https://api.z.ai/api/coding/paas/v4/…`)
//! which is OpenAI Chat Completions-compatible. See the inline block comment below
//! for wire-protocol notes (system prompt placement, tool_calls echo, etc.).
//!
//! **Usage token accounting (Phase 3):** `GlmUsage` captures `prompt_tokens` and
//! `completion_tokens` from the response `usage` field so the telemetry layer can
//! track spend across all three providers uniformly. GLM has no prompt-cache
//! semantics; `cache_read` / `cache_create` always land at 0.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::super::catalog::openai_chat_tools_catalog;
use super::super::types::{ToolCall, TurnOutcome};
use super::super::helpers::truncate;
use super::anthropic::{LLM_TIMEOUT_SECS, USER_AGENT};
use crate::event_bus::{publish, SunnyEvent};
use crate::telemetry::{record_llm_turn, TelemetryEvent};

/// Z.AI's Coding Plan endpoint. This is a deliberately different URL from
/// `api.z.ai/api/paas/v4/chat/completions`, which bills against a
/// separate pay-per-token balance and returns error code `1113:
/// Insufficient balance or no resource package` when the subscription
/// route is the one with credit. Every Coding Plan subscription
/// (GLM Coding Plan / Coding Max) lands HERE; pay-per-token lands at
/// `paas/v4`. Wire shape is OpenAI-compatible on both.
pub const GLM_URL: &str = "https://api.z.ai/api/coding/paas/v4/chat/completions";
pub const DEFAULT_GLM_MODEL: &str = "glm-5.1";

// Cost constants are centralised in telemetry::cost_rates — see
// crate::telemetry::cost_rates::GLM_* for billing rates.
// GLM-5.1 via Z.AI Coding Plan: $0.40/M input, $1.20/M output.

// ---------------------------------------------------------------------------
// GLM / Z.AI transport (OpenAI Chat Completions compatible)
//
// Z.AI exposes GLM-5.1 behind a drop-in OpenAI Chat Completions endpoint,
// so the wire shape here is the standard `messages[] + tools[] +
// tool_choice` triad. Key differences vs. Anthropic:
//
//   * System prompt is the first `messages[]` entry with `role: "system"`,
//     not a top-level `system` field.
//   * Tool definitions are `{type: "function", function: {...}}` with a
//     JSON-Schema `parameters` object (identical to Ollama's shape here).
//   * Assistant tool calls arrive on `choices[0].message.tool_calls[]`
//     where each entry has `.id`, `.type == "function"`, and
//     `.function.{name, arguments}`. Arguments are a JSON-encoded string
//     per the OpenAI spec — we parse it defensively (falling back to Null
//     rather than panicking on a malformed payload).
//   * On the next turn we must echo the *entire* assistant message back —
//     including the `tool_calls[]` array — so GLM can correlate each
//     `tool_call_id` to its result. This is why `assistant_message` below
//     preserves the raw structure verbatim instead of re-deriving it.
//
// Usage token accounting (Phase 3): `GlmUsage` captures `prompt_tokens`
// and `completion_tokens` from the `usage` field in every response.
// GLM has no prompt-cache semantics; cache_read / cache_create land at 0.
// ---------------------------------------------------------------------------

/// Token accounting block returned by GLM/Z.AI (OpenAI-compatible shape).
/// Field names match the OpenAI spec: `prompt_tokens` = input,
/// `completion_tokens` = output. GLM has no prompt-cache semantics,
/// so cache_read / cache_create always land at 0 in telemetry.
#[derive(Deserialize, Debug, Default)]
pub struct GlmUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

#[derive(Deserialize, Debug)]
pub struct GlmResponse {
    #[serde(default)]
    pub choices: Vec<GlmChoice>,
    #[serde(default)]
    pub usage: Option<GlmUsage>,
}

#[derive(Deserialize, Debug)]
pub struct GlmChoice {
    #[serde(default)]
    pub message: Option<GlmMessage>,
    #[serde(default)]
    #[allow(dead_code)]
    pub finish_reason: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
pub struct GlmMessage {
    #[serde(default)]
    pub content: Option<String>,
    /// GLM-5.1 (and other reasoning-mode variants on the Coding Plan
    /// endpoint) emit their prose reply in `reasoning_content` and leave
    /// `content` empty — same shape as qwen3-thinking on Ollama. Without
    /// this field the deserialiser drops the actual answer on the floor
    /// and every reasoning-mode turn lands blank in the chat UI.
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<GlmToolCall>>,
}

#[derive(Deserialize, Debug)]
pub struct GlmToolCall {
    pub id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub function: GlmFunctionCall,
}

#[derive(Deserialize, Debug, Default)]
pub struct GlmFunctionCall {
    #[serde(default)]
    pub name: String,
    /// Per OpenAI spec this is a JSON-encoded string, but some compatible
    /// implementations return an already-parsed object — accept both.
    #[serde(default)]
    pub arguments: Value,
}

pub async fn glm_turn(model: &str, system: &str, history: &[Value]) -> Result<TurnOutcome, String> {
    let key = crate::secrets::zai_api_key().await.ok_or_else(|| {
        "ZAI_API_KEY not configured — run scripts/install-zai-key.sh <key>".to_string()
    })?;

    // System prompt goes in as the first message; GLM/OpenAI reject a
    // top-level `system` field on this endpoint.  Run every string
    // leaf through the enforcement-policy scrubber so API keys or
    // PII in history don't leak to the cloud provider.
    let system_scrubbed = crate::security::enforcement::scrub_texts(&[system.to_string()])
        .pop()
        .unwrap_or_else(|| system.to_string());
    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 1);
    messages.push(json!({"role": "system", "content": system_scrubbed}));
    for m in history {
        messages.push(scrub_message_value(m));
    }

    let tools = openai_chat_tools_catalog().clone();

    // GLM-5.1 reasoning-mode can spend a lot of tokens on hidden
    // reasoning_content before emitting the final answer. Cap at
    // 2048 to keep turn latency bounded — same rationale as kimi.rs.
    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": false,
    });

    let started = Instant::now();
    let client = crate::http::client();
    let req = client
        .post(GLM_URL)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .header("user-agent", USER_AGENT)
        .json(&body);
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        crate::http::send(req),
    )
    .await
    .map_err(|_| "glm timed out".to_string())?
    .map_err(|e| format!("glm connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("glm http {status}: {}", truncate(&body, 400)));
    }

    let parsed: GlmResponse = resp
        .json()
        .await
        .map_err(|e| format!("glm decode: {e}"))?;

    // Decode the OpenAI-compatible usage block so BrainPage can track
    // real token costs. GLM has no prompt-cache semantics; cache fields
    // are always 0. Mirrors the anthropic.rs log_cache_usage pattern.
    {
        let (input_tok, output_tok) = parsed.usage.as_ref().map_or((0, 0), |u| {
            (u.prompt_tokens, u.completion_tokens)
        });
        log::info!(
            "glm tokens: input={} output={} model={} duration_ms={}",
            input_tok,
            output_tok,
            model,
            started.elapsed().as_millis(),
        );
        let cost_usd = crate::telemetry::cost_estimate(
            "glm",
            input_tok,
            output_tok,
            0,
            0,
        );
        record_llm_turn(TelemetryEvent {
            provider: "glm".to_string(),
            model: model.to_string(),
            input: input_tok,
            cache_read: 0,
            cache_create: 0,
            output: output_tok,
            duration_ms: started.elapsed().as_millis() as u64,
            at: chrono::Utc::now().timestamp(),
            cost_usd,
            tier: None,    // K5 wires this via route_model; None until then
        });
    }

    let msg = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message)
        .unwrap_or_default();

    // GLM-5.1 reasoning turns leave `content` empty and put the prose in
    // `reasoning_content`. Prefer content (standard path); fall back to
    // reasoning_content so a reasoning-mode final answer isn't lost.
    // Matches the ollama.rs fallback for thinking-mode qwen3.
    let reasoning_text = msg.reasoning_content.unwrap_or_default();
    let raw_content = msg.content.unwrap_or_default();
    let content_text = if !raw_content.trim().is_empty() {
        raw_content
    } else {
        reasoning_text
    };

    if let Some(tool_calls) = msg.tool_calls.filter(|v| !v.is_empty()) {
        let mut calls: Vec<ToolCall> = Vec::with_capacity(tool_calls.len());
        // Preserve the exact wire shape so the next-turn echo reaches GLM
        // byte-identical to what it just sent us.
        let mut raw_tool_calls: Vec<Value> = Vec::with_capacity(calls.capacity());

        for tc in tool_calls.into_iter() {
            // OpenAI spec: `arguments` is a JSON-encoded string. Tolerate
            // the non-compliant "already a Value::Object" case as well so
            // a future GLM behaviour shift doesn't brick tool dispatch.
            let input = match &tc.function.arguments {
                Value::String(s) => {
                    if s.trim().is_empty() {
                        Value::Object(Default::default())
                    } else {
                        serde_json::from_str(s).unwrap_or(Value::Null)
                    }
                }
                Value::Null => Value::Object(Default::default()),
                other => other.clone(),
            };

            raw_tool_calls.push(json!({
                "id": tc.id,
                "type": "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": match &tc.function.arguments {
                        Value::String(s) => Value::String(s.clone()),
                        other => Value::String(other.to_string()),
                    },
                }
            }));

            calls.push(ToolCall {
                id: tc.id,
                name: tc.function.name,
                input,
            });
        }

        // Echo verbatim: `content` may be null/empty when the model
        // decides to go straight to a tool call with no narrative.
        let assistant_message = json!({
            "role": "assistant",
            "content": if content_text.is_empty() { Value::Null } else { Value::String(content_text.clone()) },
            "tool_calls": raw_tool_calls,
        });

        let thinking = (!content_text.trim().is_empty()).then_some(content_text);
        Ok(TurnOutcome::Tools {
            thinking,
            calls,
            assistant_message,
        })
    } else {
        Ok(TurnOutcome::final_buffered(content_text))
    }
}

/// Same shape as anthropic.rs — walk a JSON value and scrub every
/// string leaf.  Duplicated intentionally so each provider's leaf
/// policy stays independent (some providers pass structured blocks,
/// others raw strings, and we don't want a shared path to couple
/// them).
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

/// SSE-streaming variant of `glm_turn`. Emits `ChatChunk` events per
/// delta so the frontend can render tokens as they arrive instead of
/// blocking 8–14 s on the full buffered response.
///
/// Wire shape: OpenAI Chat Completions SSE — `data: {...}\n\n` frames
/// with `choices[0].delta.{content, reasoning_content}`. `stream_options.
/// include_usage` is set so the terminal frame carries prompt /
/// completion token counts (GLM supports this option).
///
/// Tool-call fallback: when any frame carries `choices[0].delta.
/// tool_calls`, abort the stream and re-issue as non-streaming via
/// `glm_turn`. Same rationale as `anthropic_turn_streaming` —
/// tool-use turns are rare, re-issue cost is acceptable, and the
/// buffered tool-call assembly stays untouched.
pub async fn glm_turn_streaming(
    _app: &AppHandle,
    model: &str,
    system: &str,
    history: &[Value],
) -> Result<TurnOutcome, String> {
    let key = crate::secrets::zai_api_key().await.ok_or_else(|| {
        "ZAI_API_KEY not configured — run scripts/install-zai-key.sh <key>".to_string()
    })?;

    let system_scrubbed = crate::security::enforcement::scrub_texts(&[system.to_string()])
        .pop()
        .unwrap_or_else(|| system.to_string());
    let mut messages: Vec<Value> = Vec::with_capacity(history.len() + 1);
    messages.push(json!({"role": "system", "content": system_scrubbed}));
    for m in history {
        messages.push(scrub_message_value(m));
    }

    let tools = openai_chat_tools_catalog().clone();

    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": true,
        "stream_options": {"include_usage": true},
    });

    // Stable turn_id for the event-bus ChatChunk mirror — shape matches
    // anthropic.rs / ollama.rs so frontend tailers can fold deltas.
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("glm:{model}:{turn_start_ms}:{turn_suffix}");

    let started = Instant::now();
    let client = crate::http::client();
    let req = client
        .post(GLM_URL)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .header("user-agent", USER_AGENT)
        .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
        .json(&body);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("glm stream connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("glm http {status}: {}", truncate(&body, 400)));
    }

    match drive_openai_sse_stream("glm", resp, &turn_id).await? {
        OpenAiSseResult::Final { text, usage } => {
            publish(SunnyEvent::ChatChunk {
                seq: 0,
                boot_epoch: 0,
                turn_id: turn_id.clone(),
                delta: String::new(),
                done: true,
                at: chrono::Utc::now().timestamp_millis(),
            });

            let (input_tok, output_tok) = usage
                .as_ref()
                .and_then(|u| serde_json::from_value::<GlmUsage>(u.clone()).ok())
                .map(|u| (u.prompt_tokens, u.completion_tokens))
                .unwrap_or((0, 0));
            log::info!(
                "glm tokens: input={} output={} model={} duration_ms={}",
                input_tok,
                output_tok,
                model,
                started.elapsed().as_millis(),
            );
            let cost_usd = crate::telemetry::cost_estimate("glm", input_tok, output_tok, 0, 0);
            record_llm_turn(TelemetryEvent {
                provider: "glm".to_string(),
                model: model.to_string(),
                input: input_tok,
                cache_read: 0,
                cache_create: 0,
                output: output_tok,
                duration_ms: started.elapsed().as_millis() as u64,
                at: chrono::Utc::now().timestamp(),
                cost_usd,
                tier: None,
            });

            Ok(TurnOutcome::Final { text, streamed: true })
        }
        OpenAiSseResult::ToolUseDetected => {
            log::info!(
                "glm_turn_streaming: tool_calls detected, falling back to non-streaming"
            );
            glm_turn(model, system, history).await
        }
    }
}

pub(super) enum OpenAiSseResult {
    Final { text: String, usage: Option<Value> },
    ToolUseDetected,
}

/// Drive an OpenAI-compatible Chat Completions SSE stream. Parses
/// `data: {...}\n\n` frames, publishes `ChatChunk` events per content
/// or reasoning_content delta, and returns on terminal `[DONE]` or
/// stream close. Shared by GLM and Kimi since both expose the same
/// wire shape.
pub(super) async fn drive_openai_sse_stream(
    provider_tag: &'static str,
    resp: reqwest::Response,
    turn_id: &str,
) -> Result<OpenAiSseResult, String> {
    use futures_util::StreamExt;

    let stream_started = Instant::now();
    let mut ttft_ms: Option<u128> = None;

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut accumulated = String::new();
    let mut was_reasoning = false;
    let mut final_usage: Option<Value> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("{provider_tag} stream read: {e}"))?;
        buf.extend_from_slice(&bytes);

        // Drain every complete newline-terminated line. SSE spec says
        // events are separated by blank lines, but each field ends with
        // a single '\n'; we process line-by-line and skip empties.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..nl).collect();
            buf.drain(..1); // consume '\n'
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Some(data) = line.strip_prefix("data:") else {
                continue; // skip `event:` / `id:` / `:` comment lines
            };
            let data = data.trim();
            if data == "[DONE]" {
                continue; // terminal marker — usage already captured in prior frame
            }

            let payload: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!(
                        "{provider_tag} SSE: bad JSON line ({e}) → {}",
                        truncate(data, 160)
                    );
                    continue;
                }
            };

            // Tool-call short-circuit: OpenAI streams tool_calls as delta
            // objects with `tool_calls[].function.{name,arguments}`. As
            // soon as we see any tool_calls field in a delta, bail and
            // let the non-streaming path reassemble them cleanly.
            if payload
                .pointer("/choices/0/delta/tool_calls")
                .and_then(|v| v.as_array())
                .is_some_and(|arr| !arr.is_empty())
            {
                return Ok(OpenAiSseResult::ToolUseDetected);
            }

            // Content + reasoning_content deltas. GLM-5.1 / kimi-k2.6
            // reasoning turns emit prose in `reasoning_content`; wrap
            // those in `<think>…</think>` so the frontend streamSpeak
            // can strip them before TTS, same convention as ollama.rs
            // thinking-mode handling.
            let delta = payload.pointer("/choices/0/delta");
            let mut delta_str = String::new();

            if let Some(r) = delta
                .and_then(|d| d.get("reasoning_content"))
                .and_then(|r| r.as_str())
                .filter(|s| !s.is_empty())
            {
                if !was_reasoning {
                    was_reasoning = true;
                    delta_str.push_str("<think>\n");
                }
                delta_str.push_str(r);
            } else if let Some(c) = delta
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
            {
                if was_reasoning {
                    was_reasoning = false;
                    delta_str.push_str("\n</think>\n");
                }
                delta_str.push_str(c);
            }

            if !delta_str.is_empty() {
                if ttft_ms.is_none() {
                    let elapsed = stream_started.elapsed().as_millis();
                    ttft_ms = Some(elapsed);
                    log::info!(
                        "{provider_tag} ttft: {}ms (first delta)",
                        elapsed,
                    );
                }
                accumulated.push_str(&delta_str);
                publish(SunnyEvent::ChatChunk {
                    seq: 0,
                    boot_epoch: 0,
                    turn_id: turn_id.to_string(),
                    delta: delta_str,
                    done: false,
                    at: chrono::Utc::now().timestamp_millis(),
                });
            }

            // Terminal usage frame: `stream_options.include_usage=true`
            // asks the server to emit a final frame carrying usage with
            // empty choices. Capture the raw Value so each caller can
            // decode into its own provider-specific usage struct.
            if let Some(u) = payload.get("usage") {
                if !u.is_null() {
                    final_usage = Some(u.clone());
                }
            }
        }
    }

    // Close out an unterminated think block so the frontend's sanitiser
    // never sees a dangling `<think>`.
    if was_reasoning {
        accumulated.push_str("\n</think>\n");
        publish(SunnyEvent::ChatChunk {
            seq: 0,
            boot_epoch: 0,
            turn_id: turn_id.to_string(),
            delta: "\n</think>\n".to_string(),
            done: false,
            at: chrono::Utc::now().timestamp_millis(),
        });
    }

    // Log the full wall-clock + TTFT delta so the "streaming is fast"
    // claim is verifiable in production logs: a healthy turn shows
    // ttft ≪ total, proving tokens landed in the UI before the
    // buffered path would have returned at all.
    log::info!(
        "{provider_tag} stream complete: total={}ms ttft={} accumulated={} chars",
        stream_started.elapsed().as_millis(),
        ttft_ms.map(|v| format!("{v}ms")).unwrap_or_else(|| "n/a".to_string()),
        accumulated.len(),
    );

    Ok(OpenAiSseResult::Final {
        text: accumulated,
        usage: final_usage,
    })
}

// ---------------------------------------------------------------------------
// Pure OpenAI-SSE frame classifier — extracted for unit tests so the
// delta / tool_use / reasoning-wrap / usage-capture logic can be
// exercised without a live stream. Mirrors `drive_openai_sse_stream`;
// if you change one, change the other. Ollama uses the same pattern
// with its NDJSON classifier (`classify_ndjson_frame`).
// ---------------------------------------------------------------------------

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SseFrameOutcome {
    pub delta: Option<String>,
    pub was_reasoning: bool,
    pub tool_use: bool,
    pub usage_captured: bool,
}

/// Classify one parsed OpenAI SSE frame. Pure — no I/O, no side effects.
/// `was_reasoning` tracks whether the prior frame had opened a
/// `<think>` block that hasn't been closed yet; the returned
/// `was_reasoning` reflects the state after processing this frame.
#[cfg(test)]
pub(crate) fn classify_openai_sse_frame(
    payload: &Value,
    was_reasoning: bool,
) -> SseFrameOutcome {
    // Tool-call short-circuit: any non-empty tool_calls array aborts.
    if payload
        .pointer("/choices/0/delta/tool_calls")
        .and_then(|v| v.as_array())
        .is_some_and(|arr| !arr.is_empty())
    {
        return SseFrameOutcome {
            delta: None,
            was_reasoning,
            tool_use: true,
            usage_captured: false,
        };
    }

    let delta_obj = payload.pointer("/choices/0/delta");
    let mut delta_str = String::new();
    let mut next_reasoning = was_reasoning;

    if let Some(r) = delta_obj
        .and_then(|d| d.get("reasoning_content"))
        .and_then(|r| r.as_str())
        .filter(|s| !s.is_empty())
    {
        if !next_reasoning {
            next_reasoning = true;
            delta_str.push_str("<think>\n");
        }
        delta_str.push_str(r);
    } else if let Some(c) = delta_obj
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
    {
        if next_reasoning {
            next_reasoning = false;
            delta_str.push_str("\n</think>\n");
        }
        delta_str.push_str(c);
    }

    let usage_captured = payload
        .get("usage")
        .is_some_and(|u| !u.is_null());

    SseFrameOutcome {
        delta: if delta_str.is_empty() { None } else { Some(delta_str) },
        was_reasoning: next_reasoning,
        tool_use: false,
        usage_captured,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A plain content-delta frame emits the string and leaves the
    /// reasoning flag off.
    #[test]
    fn content_delta_emits_string() {
        let frame = json!({
            "choices": [{"delta": {"content": "Hello"}, "finish_reason": null}]
        });
        let out = classify_openai_sse_frame(&frame, false);
        assert_eq!(out.delta.as_deref(), Some("Hello"));
        assert!(!out.was_reasoning);
        assert!(!out.tool_use);
    }

    /// First reasoning_content frame opens a `<think>` block and sets
    /// the flag so subsequent frames don't re-open.
    #[test]
    fn first_reasoning_frame_opens_think_tag() {
        let frame = json!({
            "choices": [{"delta": {"reasoning_content": "let me think..."}}]
        });
        let out = classify_openai_sse_frame(&frame, false);
        assert_eq!(out.delta.as_deref(), Some("<think>\nlet me think..."));
        assert!(out.was_reasoning);
    }

    /// Transitioning from reasoning to content closes the `<think>`.
    #[test]
    fn reasoning_to_content_closes_tag() {
        let frame = json!({
            "choices": [{"delta": {"content": "the answer is 42"}}]
        });
        let out = classify_openai_sse_frame(&frame, /* was_reasoning = */ true);
        assert_eq!(out.delta.as_deref(), Some("\n</think>\nthe answer is 42"));
        assert!(!out.was_reasoning);
    }

    /// Tool_calls on a delta aborts — caller re-issues non-streaming.
    /// GLM/Kimi emit tool_calls piecewise in streaming; we bail on
    /// the first sight and let the buffered path reassemble them.
    #[test]
    fn tool_calls_short_circuit() {
        let frame = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "open_app", "arguments": "{"}
                    }]
                }
            }]
        });
        let out = classify_openai_sse_frame(&frame, false);
        assert!(out.tool_use);
        assert_eq!(out.delta, None);
    }

    /// The terminal frame when `stream_options.include_usage=true`
    /// carries `usage` + an empty choices array. Flag that so the
    /// live driver captures the raw Value for telemetry.
    #[test]
    fn terminal_usage_frame_is_captured() {
        let frame = json!({
            "choices": [],
            "usage": {
                "prompt_tokens": 26000,
                "completion_tokens": 42
            }
        });
        let out = classify_openai_sse_frame(&frame, false);
        assert!(out.usage_captured);
        assert_eq!(out.delta, None);
    }

    /// A role-only first frame (OpenAI emits `{role: "assistant"}` with
    /// no content on the first chunk) should not emit a delta and
    /// should not flip the reasoning flag.
    #[test]
    fn role_only_first_frame_emits_nothing() {
        let frame = json!({
            "choices": [{"delta": {"role": "assistant", "content": ""}}]
        });
        let out = classify_openai_sse_frame(&frame, false);
        assert_eq!(out.delta, None);
        assert!(!out.was_reasoning);
    }

    /// Empty tool_calls array does NOT trigger short-circuit — only a
    /// non-empty array aborts the stream.
    #[test]
    fn empty_tool_calls_does_not_short_circuit() {
        let frame = json!({
            "choices": [{"delta": {"tool_calls": []}}]
        });
        let out = classify_openai_sse_frame(&frame, false);
        assert!(!out.tool_use);
    }
}
