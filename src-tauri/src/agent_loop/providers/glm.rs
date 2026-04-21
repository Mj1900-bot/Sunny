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

use super::super::catalog::catalog_merged;
use super::super::types::{ToolCall, TurnOutcome};
use super::super::helpers::truncate;
use super::anthropic::{LLM_TIMEOUT_SECS, USER_AGENT};
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

    let tools: Vec<Value> = catalog_merged()
        .iter()
        .map(|t| {
            let schema: Value = serde_json::from_str(t.input_schema)
                .unwrap_or_else(|_| json!({"type": "object", "properties": {}}));
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": schema,
                }
            })
        })
        .collect();

    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.7,
        "max_tokens": 4096,
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
