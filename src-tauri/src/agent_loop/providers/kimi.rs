//! Moonshot / Kimi provider adapter.
//!
//! Drives the Moonshot Chat Completions endpoint
//! (`https://api.moonshot.ai/v1/chat/completions`), which is OpenAI-compatible.
//! Default model is `kimi-k2.6` (1T total / 32B active MoE, 256K context,
//! released 2026-04-20). The model is purpose-built for agentic coding +
//! long-horizon tool use — SWE-Bench Pro: 58.6, HLE-with-tools: 54.0 (leads
//! Opus 4.6, GPT-5.4, Gemini 3.1 Pro), and supports swarm coordination of up
//! to 300 sub-agents across 4,000+ steps.
//!
//! The wire shape mirrors `glm.rs` almost exactly — both endpoints are
//! OpenAI Chat Completions drop-ins — but Moonshot has no reasoning-content
//! split (the model writes its answer into `content` directly). Duplicating
//! the glm.rs skeleton is intentional: each provider keeps its own leaf
//! scrubber + usage decoder so a future divergence (tool-call shape change,
//! new usage fields, etc.) stays local to one file.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::super::catalog::catalog_merged;
use super::super::types::{ToolCall, TurnOutcome};
use super::super::helpers::truncate;
use super::anthropic::{LLM_TIMEOUT_SECS, USER_AGENT};
use crate::telemetry::{record_llm_turn, TelemetryEvent};

pub const KIMI_URL: &str = "https://api.moonshot.ai/v1/chat/completions";
pub const DEFAULT_KIMI_MODEL: &str = "kimi-k2.6";

// Cost constants (Moonshot K2.6 published 2026-04-20):
//   input   : $0.60 / M tokens
//   output  : $2.50 / M tokens
// Centralise in telemetry::cost_rates if you add Kimi to the rates table;
// for now we pass through zeros and let the telemetry layer no-op.

/// Token accounting block from the OpenAI-compatible `usage` field.
#[derive(Deserialize, Debug, Default)]
pub struct KimiUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    /// Moonshot returns a `cached_tokens` field for prompts served from
    /// their KV cache — surfaced here so telemetry can credit cache hits.
    #[serde(default)]
    pub cached_tokens: u64,
}

#[derive(Deserialize, Debug)]
pub struct KimiResponse {
    #[serde(default)]
    pub choices: Vec<KimiChoice>,
    #[serde(default)]
    pub usage: Option<KimiUsage>,
}

#[derive(Deserialize, Debug)]
pub struct KimiChoice {
    #[serde(default)]
    pub message: Option<KimiMessage>,
    #[serde(default)]
    #[allow(dead_code)]
    pub finish_reason: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
pub struct KimiMessage {
    #[serde(default)]
    pub content: Option<String>,
    /// Kimi K2.6 is a reasoning model. For hard questions it writes
    /// chain-of-thought into `reasoning_content` and the final concise
    /// answer into `content`. When max_tokens is tight, reasoning can
    /// consume the whole budget and `content` lands empty — in that
    /// case fall back to `reasoning_content` so the user at least sees
    /// the model's work. Same pattern as GLM-5.1 thinking mode.
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<KimiToolCall>>,
}

#[derive(Deserialize, Debug)]
pub struct KimiToolCall {
    pub id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub function: KimiFunctionCall,
}

#[derive(Deserialize, Debug, Default)]
pub struct KimiFunctionCall {
    #[serde(default)]
    pub name: String,
    /// Per OpenAI spec this is a JSON-encoded string, but tolerant of the
    /// already-parsed object shape some compatible implementations emit.
    #[serde(default)]
    pub arguments: Value,
}

pub async fn kimi_turn(model: &str, system: &str, history: &[Value]) -> Result<TurnOutcome, String> {
    let key = crate::secrets::moonshot_api_key().await.ok_or_else(|| {
        "MOONSHOT_API_KEY not configured — run scripts/install-moonshot-key.sh <key>".to_string()
    })?;

    // Scrub sensitive strings before they leave the process. Same pattern
    // as glm.rs / anthropic.rs — each provider runs its own leaf scrubber
    // so a policy divergence stays local.
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

    // K2.6 quirks (as of 2026-04-20 launch):
    //   * temperature is locked to 1.0 — Moonshot rejects any other
    //     value with HTTP 400 "invalid temperature: only 1 is allowed
    //     for this model".
    //   * It's a reasoning model — outputs reasoning_content BEFORE
    //     the user-visible content. Unbounded max_tokens invites the
    //     model to reason for 30+ seconds on casual prompts, which
    //     translates to the 'talking forever' UX complaint. 2048
    //     tokens (input+output combined cap via the model) keeps
    //     total latency under ~10s for most turns and still allows
    //     ~500 words of reasoning + final answer. Costs less, faster.
    let body = json!({
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 1,
        "max_tokens": 2048,
        "stream": false,
    });

    let started = Instant::now();
    let client = crate::http::client();
    let req = client
        .post(KIMI_URL)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .header("user-agent", USER_AGENT)
        .json(&body);
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        crate::http::send(req),
    )
    .await
    .map_err(|_| "kimi timed out".to_string())?
    .map_err(|e| format!("kimi connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("kimi http {status}: {}", truncate(&body, 400)));
    }

    let parsed: KimiResponse = resp
        .json()
        .await
        .map_err(|e| format!("kimi decode: {e}"))?;

    {
        let (input_tok, output_tok, cache_read) = parsed.usage.as_ref().map_or((0, 0, 0), |u| {
            (u.prompt_tokens, u.completion_tokens, u.cached_tokens)
        });
        log::info!(
            "kimi tokens: input={} output={} cache_read={} model={} duration_ms={}",
            input_tok,
            output_tok,
            cache_read,
            model,
            started.elapsed().as_millis(),
        );
        let cost_usd = crate::telemetry::cost_estimate(
            "kimi",
            input_tok,
            output_tok,
            cache_read,
            0,
        );
        record_llm_turn(TelemetryEvent {
            provider: "kimi".to_string(),
            model: model.to_string(),
            input: input_tok,
            cache_read,
            cache_create: 0,
            output: output_tok,
            duration_ms: started.elapsed().as_millis() as u64,
            at: chrono::Utc::now().timestamp(),
            cost_usd,
            tier: None,
        });
    }

    let msg = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message)
        .unwrap_or_default();

    // Prefer final `content`; fall back to `reasoning_content` so a
    // reasoning-exhausted turn still surfaces something the user can
    // read (see comment on KimiMessage.reasoning_content).
    let reasoning_text = msg.reasoning_content.unwrap_or_default();
    let raw_content = msg.content.unwrap_or_default();
    let content_text = if !raw_content.trim().is_empty() {
        raw_content
    } else {
        reasoning_text
    };

    if let Some(tool_calls) = msg.tool_calls.filter(|v| !v.is_empty()) {
        let mut calls: Vec<ToolCall> = Vec::with_capacity(tool_calls.len());
        let mut raw_tool_calls: Vec<Value> = Vec::with_capacity(calls.capacity());

        for tc in tool_calls.into_iter() {
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
