//! AI gateway — talks to OpenClaw / Ollama / the agent tool-use loop.
//!
//! Transports:
//!   1. OpenClaw CLI — `openclaw chat <prompt>` (if available on PATH)
//!   2. Ollama HTTP  — http://127.0.0.1:11434/api/chat (streaming NDJSON)
//!   3. Agent loop   — ReAct tool-use over ~20 tools (weather, web, browser,
//!      macOS, compute). Selected via `provider = "agent"` (auto-picks
//!      Anthropic if `ANTHROPIC_API_KEY` is set, else Ollama), or forced with
//!      `"agent:anthropic"` / `"agent:ollama"`. Implemented in
//!      `crate::agent_loop`.
//!
//! The `chat` command defaults to OpenClaw → falls back to Ollama.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use ts_rs::TS;

#[derive(Deserialize, Debug, Clone, TS)]
#[ts(export)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize, Debug, TS)]
#[ts(export)]
pub struct ChatRequest {
    pub message: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    /// Prior turns, oldest first. System/user/assistant roles. The current
    /// `message` is appended after these — callers don't need to include it.
    /// Used by the `ollama` provider (which is stateless). The `openclaw`
    /// provider uses `session_id` instead for stateful threading.
    #[serde(default)]
    pub history: Vec<ChatMessage>,
    /// Opaque session identifier. When provided, `openclaw` resumes that
    /// session so the agent remembers prior turns, memory writes, etc.
    /// Frontend generates one stable id per ChatPanel / voice conversation
    /// and persists it in localStorage so reloads don't start a new thread.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Optional conversational contract override. When `"brainstorm"`, the
    /// agent loop uses the brainstorm system prompt variant (3-sentence turns,
    /// one question per turn, willing to disagree).
    #[serde(default)]
    pub chat_mode: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ChatChunk {
    pub delta: String,
    pub done: bool,
}

#[derive(Deserialize, Debug)]
struct OllamaChunk {
    message: OllamaMessage,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize, Debug)]
struct OllamaMessage {
    content: String,
}

pub async fn stream_chat(app: AppHandle, req: ChatRequest) -> Result<String, String> {
    let provider = req.provider.as_deref().unwrap_or("ollama");
    match provider {
        // The settings UI exposes two provider buttons — Ollama and
        // OpenClaw CLI. We no longer route "ollama" to the bare
        // ollama_stream path because that has no tool access ("who's the
        // president right now" hallucinates from training data). Instead
        // it now goes through the ReAct agent loop with Ollama as its
        // LLM backend, which calls the live tool catalog (web_search,
        // weather, mail, calendar, browser, …). Users who actively want
        // a raw-LLM transport can still request it via the explicit
        // "ollama:raw" provider string — useful for model-only smoke
        // tests.
        // Every provider string that should reach the ReAct agent loop.
        // `auto` triggers the heuristic router in `pick_backend` (local for
        // chat, GLM for research/code); explicit `glm` / `agent:glm` forces
        // GLM for every turn; `anthropic` / `agent:anthropic` forces Claude;
        // `ollama` / `agent:ollama` forces local. Empty string (settings
        // default) behaves like `auto`.
        "" | "auto" | "ollama" | "agent" | "agent:anthropic" | "agent:ollama"
            | "anthropic" | "glm" | "agent:glm" => {
            crate::agent_loop::agent_run(app, req).await
        }
        "ollama:raw" => ollama_stream(app, &req).await,
        "openclaw" => openclaw_one_shot(app, &req).await,
        other => Err(format!("unknown provider: {other}")),
    }
}

async fn ollama_stream(app: AppHandle, req: &ChatRequest) -> Result<String, String> {
    // Suppress the `app` unused-parameter lint without breaking the public
    // signature — this path emits via the event bus rather than
    // `app.emit`, so the handle isn't needed directly.
    let _ = &app;
    let model = req.model.clone().unwrap_or_else(|| "llama3.2".into());
    // Stable turn_id for the bus ChatChunk mirror. Matches the shape
    // streaming providers use (`{provider}:{model}:{ms}:{uuid}`) so
    // cross-session tails can filter every LLM turn with one regex.
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("ollama-raw:{model}:{turn_start_ms}:{turn_suffix}");

    // Build messages: system prompt (unless the caller already supplied one),
    // then the history in order, then the current user turn.
    let mut messages: Vec<serde_json::Value> = Vec::with_capacity(req.history.len() + 2);
    let caller_has_system = req
        .history
        .first()
        .map(|m| m.role.eq_ignore_ascii_case("system"))
        .unwrap_or(false);
    if !caller_has_system {
        messages.push(serde_json::json!({
            "role": "system",
            "content": system_prompt(),
        }));
    }
    for m in &req.history {
        let role = m.role.to_lowercase();
        if role != "system" && role != "user" && role != "assistant" { continue; }
        messages.push(serde_json::json!({ "role": role, "content": m.content }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": req.message }));

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages,
    });

    // Use the process-wide shared client so the keep-alive connection
    // to the local Ollama daemon is reused across chat turns. The old
    // `Client::new()` built a fresh pool every call — fine for a cold
    // `127.0.0.1` TCP connect, but still paid handshake on every turn.
    let client = crate::http::client();
    let resp = crate::http::send(
        client
            .post("http://127.0.0.1:11434/api/chat")
            .json(&body),
    )
    .await
    .map_err(|e| format!("ollama connect: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("ollama http {}", resp.status()));
    }

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut accumulated = String::new();
    let mut buf = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("ollama stream: {e}"))?;
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line = buf.drain(..=pos).collect::<Vec<_>>();
            let line_str = String::from_utf8_lossy(&line);
            let trimmed = line_str.trim();
            if trimmed.is_empty() { continue; }
            if let Ok(c) = serde_json::from_str::<OllamaChunk>(trimmed) {
                if !c.message.content.is_empty() {
                    accumulated.push_str(&c.message.content);
                    // Bus push channel only — no `app.emit` here.
                    crate::event_bus::publish(crate::event_bus::SunnyEvent::ChatChunk {
                        seq: 0,
                        boot_epoch: 0,
                        turn_id: turn_id.clone(),
                        delta: c.message.content,
                        done: c.done,
                        at: chrono::Utc::now().timestamp_millis(),
                    });
                }
                if c.done {
                    // Bus push channel only — no `app.emit` here.
                    crate::event_bus::publish(crate::event_bus::SunnyEvent::ChatChunk {
                        seq: 0,
                        boot_epoch: 0,
                        turn_id: turn_id.clone(),
                        delta: String::new(),
                        done: true,
                        at: chrono::Utc::now().timestamp_millis(),
                    });
                    return Ok(accumulated);
                }
            }
        }
    }
    // Bus push channel only — no `app.emit` here.
    crate::event_bus::publish(crate::event_bus::SunnyEvent::ChatChunk {
        seq: 0,
        boot_epoch: 0,
        turn_id: turn_id.clone(),
        delta: String::new(),
        done: true,
        at: chrono::Utc::now().timestamp_millis(),
    });
    Ok(accumulated)
}

async fn openclaw_one_shot(app: AppHandle, req: &ChatRequest) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    use tokio::process::Command;

    // OpenClaw v2026.3+ uses `openclaw agent --message <text> --local --json`.
    // --local runs the embedded agent in-process using model provider keys
    // from the environment / openclaw.json. --json gives us a parseable reply.
    let bin = crate::paths::which("openclaw")
        .ok_or_else(|| "openclaw CLI not found on PATH".to_string())?;

    // OpenClaw 2026.3 requires --agent. We have a dedicated `sunny` agent
    // (see `openclaw agents add sunny --workspace ~/.openclaw/workspace-sunny`)
    // whose IDENTITY.md/USER.md carry the HUD-native persona — short
    // sentences, "AY-ruh" pronunciation, Kokoro George voice, no emoji
    // cheerleading. Legacy callers can still override via req.model.
    let agent_id = req.model.clone().unwrap_or_else(|| "sunny".into());

    // `--timeout` maps to openclaw's per-LLM-call timeout inside the embedded
    // agent. Default is 30 s, which is less than a cold gemma4:26b load on a
    // Mac (~45-60 s the first time the model is pulled into VRAM). Without
    // bumping this the very first "hello" of a session reliably fails and
    // the user sees a stuck "…" bubble. 180 s is generous enough to absorb
    // a fresh cold start while still surfacing genuinely dead models.
    let mut cmd = Command::new(&bin);
    cmd.arg("agent")
        .arg("--local")
        .arg("--agent").arg(&agent_id)
        .arg("--json")
        .arg("--timeout").arg("180")
        .arg("--message")
        .arg(&req.message)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Stateful conversation: when the caller supplies a session id, openclaw
    // resumes that session instead of starting a fresh one. This is how the
    // Overview chat + voice pipeline maintain memory across turns — every
    // user message in the same ChatPanel / voice conversation carries the
    // same id, and alfred's memory/prior context come back for free.
    if let Some(sid) = req.session_id.as_ref() {
        if !sid.is_empty() {
            cmd.arg("--session-id").arg(sid);
        }
    }
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn openclaw: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let mut raw = String::new();
    let mut err_raw = String::new();

    // openclaw's own --timeout=180 (set above) bounds each LLM call inside
    // the embedded agent, so the child process is guaranteed to exit within
    // ~3-6 minutes even when falling through every model fallback.
    let (_, _) = tokio::join!(
        stdout.read_to_string(&mut raw),
        stderr.read_to_string(&mut err_raw),
    );
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;

    // OpenClaw's --json emits a nested envelope. Walk it to find the assistant reply.
    let reply = extract_reply(&raw).unwrap_or_else(|| raw.trim().to_string());

    if reply.is_empty() {
        let code = status.code().unwrap_or(-1);
        let tail = err_raw
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("openclaw exit {code}: {tail}"));
    }

    // Bus push channel only — no `app.emit` here.
    // OpenClaw CLI returns the whole reply as one atomic payload, so the
    // bus mirror is a single terminal chunk carrying the full text.
    let _ = &app;
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("openclaw:{agent_id}:{turn_start_ms}:{turn_suffix}");
    crate::event_bus::publish(crate::event_bus::SunnyEvent::ChatChunk {
        seq: 0,
        boot_epoch: 0,
        turn_id,
        delta: reply.clone(),
        done: true,
        at: chrono::Utc::now().timestamp_millis(),
    });
    Ok(reply)
}

/// Walks the JSON envelope that `openclaw agent --json` emits, looking for a
/// text reply in the places the gateway/SDK put it across versions.
fn extract_reply(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;

    // OpenClaw 2026.3+ wraps the reply in a `payloads` array of
    // { text, mediaUrl } objects. Concatenate the text fields so multi-part
    // replies render as one turn.
    if let Some(payloads) = v.get("payloads").and_then(|x| x.as_array()) {
        let joined: String = payloads
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            return Some(joined);
        }
    }

    // Common top-level fields first.
    for key in ["reply", "text", "message", "content", "answer"] {
        if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }

    // Nested: result.reply, result.message, result.content, data.reply …
    for container in ["result", "data", "response", "output"] {
        if let Some(c) = v.get(container) {
            if let Some(payloads) = c.get("payloads").and_then(|x| x.as_array()) {
                let joined: String = payloads
                    .iter()
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !joined.is_empty() {
                    return Some(joined);
                }
            }
            for key in ["reply", "text", "message", "content", "answer"] {
                if let Some(s) = c.get(key).and_then(|x| x.as_str()) {
                    return Some(s.to_string());
                }
            }
            // Messages array with last assistant text.
            if let Some(msgs) = c.get("messages").and_then(|x| x.as_array()) {
                if let Some(last) = msgs.iter().rev().find(|m| {
                    m.get("role").and_then(|r| r.as_str()) == Some("assistant")
                }) {
                    if let Some(s) = last.get("content").and_then(|x| x.as_str()) {
                        return Some(s.to_string());
                    }
                }
            }
        }
    }
    None
}

fn system_prompt() -> &'static str {
    "You are SUNNY, a personal assistant running on Sunny's Mac. Your voice is \
    British male (crisp, calm, dry wit when appropriate). You have access to the \
    computer: files, apps, terminal, calendar. Be concise. When asked to do \
    something, confirm briefly and proceed."
}

// ---------------------------------------------------------------------------
// Ollama model listing (shared by agent_loop and the Settings → MODELS tab).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// `llm_oneshot` — single provider round-trip, no ReAct, no tool dispatch.
//
// The existing `chat` path runs the full ReAct loop on the Rust side for
// every invocation, which is fine when Rust owns orchestration — but the
// new TS-side orchestrator calls Tauri once per iteration and wants just
// the LLM round-trip. Going through `chat` for that doubles every layer:
// TS's system prompt gets stuffed into `req.message`, Anthropic's prompt
// cache misses, tools get dispatched on the Rust side even though the TS
// orchestrator will re-dispatch them itself, and every iteration burns
// 3–8× the tokens it should.
//
// `llm_oneshot` is the thin path: the caller owns the system prompt and
// the messages array, we make exactly one provider call, emit the same
// `sunny://chat.chunk` / `sunny://chat.done` events the voice pipeline
// listens for, and return the final text. No memory digest, no ReAct,
// no tool catalog. Anthropic gets the system prompt as a single
// `cache_control: ephemeral` block so the TS orchestrator's stable
// system prompt actually hits Agent E's prompt cache across turns.
// ---------------------------------------------------------------------------

use crate::agent_loop::providers::anthropic::{
    ANTHROPIC_URL, ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_MODEL, LLM_TIMEOUT_SECS, USER_AGENT,
};
use crate::agent_loop::providers::auth::{anthropic_key_present, zai_key_present};
use crate::agent_loop::providers::glm::{DEFAULT_GLM_MODEL, GLM_URL};
use crate::agent_loop::providers::ollama::{pick_ollama_model, OLLAMA_URL};

#[derive(Deserialize, Debug)]
pub struct LlmOneshotRequest {
    /// Full system prompt text. Caller owns it; we place it verbatim in
    /// the provider's `system` field (Anthropic) or as a
    /// `role: "system"` first message (Ollama / GLM).
    pub system: String,
    /// Prior turns, oldest first. Only `role: "user"` and
    /// `role: "assistant"` are accepted; anything else is dropped so a
    /// stray system turn from the caller can't double-stuff the system
    /// prompt path.
    pub messages: Vec<ChatMessage>,
    /// `"ollama"` | `"anthropic"` | `"glm"` | `"auto"`. Omit / empty →
    /// `"auto"`. Routes via the same preference order as the agent
    /// loop's `pick_backend` (Anthropic if key set, else Ollama).
    pub provider: Option<String>,
    /// Optional model override. When omitted we pick the default for
    /// the chosen backend.
    pub model: Option<String>,
    /// Provider-specific max output tokens. Defaults to 1024.
    pub max_tokens: Option<u32>,
}

/// Single provider round-trip. No tools, no ReAct, no memory injection.
/// Emits `sunny://chat.chunk { delta: text, done: true }` and
/// `sunny://chat.done` with the text so voice listeners terminate cleanly.
#[tauri::command]
pub async fn llm_oneshot(
    app: AppHandle,
    req: LlmOneshotRequest,
) -> Result<String, String> {
    // Same preference order `pick_backend` uses — but inline and without
    // the ReAct-specific heuristics (no "routes to GLM when research-
    // shaped", no `req.message` introspection). The caller already knows
    // what they want; we just respect it.
    let provider = req
        .provider
        .as_deref()
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "auto".to_string());
    let chosen = match provider.as_str() {
        "anthropic" | "agent:anthropic" => {
            if !anthropic_key_present().await {
                return Err("ANTHROPIC_API_KEY not set".into());
            }
            "anthropic"
        }
        "ollama" | "agent:ollama" => "ollama",
        "glm" | "agent:glm" => {
            if !zai_key_present().await {
                return Err(
                    "ZAI_API_KEY not configured — run scripts/install-zai-key.sh <key>".into(),
                );
            }
            "glm"
        }
        "" | "auto" | "agent:auto" => {
            if anthropic_key_present().await {
                "anthropic"
            } else {
                "ollama"
            }
        }
        other => return Err(format!("unknown provider: {other}")),
    };

    let max_tokens = req.max_tokens.unwrap_or(1024);
    let text = match chosen {
        "anthropic" => {
            let model = req
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_ANTHROPIC_MODEL.to_string());
            anthropic_oneshot(&model, &req.system, &req.messages, max_tokens).await?
        }
        "ollama" => {
            let model = match req.model.clone() {
                Some(m) => m,
                None => pick_ollama_model().await,
            };
            ollama_oneshot(&model, &req.system, &req.messages, max_tokens).await?
        }
        "glm" => {
            let model = req
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_GLM_MODEL.to_string());
            glm_oneshot(&model, &req.system, &req.messages, max_tokens).await?
        }
        _ => unreachable!(),
    };

    // Bus push channel only — no `app.emit` here.
    // Single terminal chunk on the event bus carrying the full text —
    // matches the contract the frontend's voice / streamSpeak listeners
    // honour via `useEventBus({ kind: 'ChatChunk' })`.
    let _ = &app;
    let model_label = req.model.clone().unwrap_or_else(|| chosen.to_string());
    let turn_start_ms = chrono::Utc::now().timestamp_millis();
    let turn_suffix = uuid::Uuid::new_v4().simple().to_string();
    let turn_id = format!("{chosen}-oneshot:{model_label}:{turn_start_ms}:{turn_suffix}");
    crate::event_bus::publish(crate::event_bus::SunnyEvent::ChatChunk {
        seq: 0,
        boot_epoch: 0,
        turn_id,
        delta: text.clone(),
        done: true,
        at: chrono::Utc::now().timestamp_millis(),
    });

    Ok(text)
}

/// Filter a caller-provided messages array down to strictly
/// `user`/`assistant` turns. The `system` field is owned by the caller
/// and set on the outer request — we don't let a stray system-role turn
/// double-stuff it.
fn sanitize_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .filter_map(|m| {
            let role = m.role.to_ascii_lowercase();
            if role != "user" && role != "assistant" {
                return None;
            }
            Some(serde_json::json!({
                "role": role,
                "content": m.content,
            }))
        })
        .collect()
}

/// Build the Anthropic request body for a one-shot call. Exposed as
/// `pub(crate)` so the unit test can verify the `cache_control: ephemeral`
/// marker is in place — that marker is what makes Agent E's prompt cache
/// actually hit when the TS orchestrator reuses the same system prompt
/// across iterations.
pub(crate) fn build_anthropic_oneshot_body(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> serde_json::Value {
    // System prompt as a single text block with an ephemeral cache
    // breakpoint. Bare-string `system` cannot carry `cache_control`, so
    // the array form is mandatory for prompt caching to kick in — same
    // pattern as the main agent loop.
    let system_blocks = serde_json::json!([
        {
            "type": "text",
            "text": system,
            "cache_control": { "type": "ephemeral" },
        }
    ]);

    serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system_blocks,
        "messages": sanitize_messages(messages),
        "stream": false,
    })
}

async fn anthropic_oneshot(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<String, String> {
    use std::time::Duration;

    let key = crate::secrets::anthropic_api_key()
        .await
        .ok_or_else(|| "ANTHROPIC_API_KEY not set".to_string())?;

    let body = build_anthropic_oneshot_body(model, system, messages, max_tokens);

    let client = crate::http::client();
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        client
            .post(ANTHROPIC_URL)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .header("user-agent", USER_AGENT)
            .json(&body)
            .send(),
    )
    .await
    .map_err(|_| "anthropic timed out".to_string())?
    .map_err(|e| format!("anthropic connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic http {status}: {body}"));
    }

    // Minimal decode — one-shot path has no tool_use blocks to worry
    // about, so we just concatenate every `text` block the model returned.
    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("anthropic decode: {e}"))?;
    let mut out = String::new();
    if let Some(blocks) = parsed.get("content").and_then(|v| v.as_array()) {
        for b in blocks {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
    }
    Ok(out)
}

async fn ollama_oneshot(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<String, String> {
    use std::time::Duration;

    // Ollama wants `system` as the first `role: "system"` message, not a
    // top-level field. Keep `stream: false` so we can return the final
    // text as one string without driving an NDJSON parser.
    let mut msgs: Vec<serde_json::Value> = Vec::with_capacity(messages.len() + 1);
    msgs.push(serde_json::json!({ "role": "system", "content": system }));
    msgs.extend(sanitize_messages(messages));

    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": msgs,
        // 30m keep_alive mirrors the agent_loop path so voice turns don't
        // pay a cold-reload penalty after idle.
        "keep_alive": "30m",
        "options": { "num_predict": max_tokens },
    });

    let client = crate::http::client();
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        client.post(OLLAMA_URL).json(&body).send(),
    )
    .await
    .map_err(|_| "ollama timed out".to_string())?
    .map_err(|e| format!("ollama connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("ollama http {status}: {body}"));
    }

    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("ollama decode: {e}"))?;
    // Thinking-mode models (qwen3-thinking et al.) emit prose in
    // `message.thinking` and leave `message.content` empty. Prefer
    // content; fall back to thinking so one-shot calls to a thinking
    // model don't land blank.
    let msg = parsed.get("message");
    let content = msg
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if !content.trim().is_empty() {
        return Ok(content.to_string());
    }
    let thinking = msg
        .and_then(|m| m.get("thinking"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    Ok(thinking.to_string())
}

async fn glm_oneshot(
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<String, String> {
    use std::time::Duration;

    let key = crate::secrets::zai_api_key().await.ok_or_else(|| {
        "ZAI_API_KEY not configured — run scripts/install-zai-key.sh <key>".to_string()
    })?;

    // OpenAI-compat: system goes in as the first message; top-level
    // `system` is rejected on the /coding/paas/v4 endpoint.
    let mut msgs: Vec<serde_json::Value> = Vec::with_capacity(messages.len() + 1);
    msgs.push(serde_json::json!({ "role": "system", "content": system }));
    msgs.extend(sanitize_messages(messages));

    let body = serde_json::json!({
        "model": model,
        "messages": msgs,
        "temperature": 0.7,
        "max_tokens": max_tokens,
        "stream": false,
    });

    let client = crate::http::client();
    let resp = tokio::time::timeout(
        Duration::from_secs(LLM_TIMEOUT_SECS),
        client
            .post(GLM_URL)
            .header("authorization", format!("Bearer {key}"))
            .header("content-type", "application/json")
            .header("user-agent", USER_AGENT)
            .json(&body)
            .send(),
    )
    .await
    .map_err(|_| "glm timed out".to_string())?
    .map_err(|e| format!("glm connect: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("glm http {status}: {body}"));
    }

    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("glm decode: {e}"))?;
    // Prefer `choices[0].message.content`; GLM-5.1 reasoning mode leaves
    // it empty and puts the answer in `reasoning_content`, so fall back
    // there — same treatment as agent_loop/providers/glm.rs.
    let msg = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"));
    let content = msg
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if !content.trim().is_empty() {
        return Ok(content.to_string());
    }
    let reasoning = msg
        .and_then(|m| m.get("reasoning_content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    Ok(reasoning.to_string())
}

#[cfg(test)]
mod llm_oneshot_tests {
    use super::*;

    #[test]
    fn anthropic_body_has_ephemeral_cache_breakpoint() {
        // Core invariant: Agent E's prompt cache only kicks in when the
        // system block carries `cache_control.type == "ephemeral"`. If
        // we ever regress to a bare string (or drop the marker), the TS
        // orchestrator's stable system prompt stops hitting the cache
        // and we're right back to 3–8× token burn.
        let body = build_anthropic_oneshot_body(
            "claude-sonnet-4-6",
            "you are sunny",
            &[ChatMessage {
                role: "user".into(),
                content: "hi".into(),
            }],
            512,
        );

        let system = body
            .get("system")
            .and_then(|s| s.as_array())
            .expect("system should be a block array");
        assert_eq!(system.len(), 1);
        let block = &system[0];
        assert_eq!(block.get("type").and_then(|t| t.as_str()), Some("text"));
        assert_eq!(
            block.get("text").and_then(|t| t.as_str()),
            Some("you are sunny"),
        );
        assert_eq!(
            block
                .get("cache_control")
                .and_then(|c| c.get("type"))
                .and_then(|t| t.as_str()),
            Some("ephemeral"),
            "system block must carry cache_control.type=ephemeral",
        );

        // Messages array should reflect the sanitized user turn.
        let messages = body
            .get("messages")
            .and_then(|m| m.as_array())
            .expect("messages array");
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].get("role").and_then(|r| r.as_str()),
            Some("user"),
        );
        assert_eq!(
            messages[0].get("content").and_then(|c| c.as_str()),
            Some("hi"),
        );

        // max_tokens + non-streaming flag on the outer body.
        assert_eq!(
            body.get("max_tokens").and_then(|n| n.as_u64()),
            Some(512),
        );
        assert_eq!(body.get("stream").and_then(|s| s.as_bool()), Some(false));
    }

    #[test]
    fn sanitize_messages_drops_system_role() {
        // Caller owns the system prompt via `req.system`. A stray
        // `role: "system"` in the messages array must be dropped so we
        // don't double-stuff the system prompt path.
        let cleaned = sanitize_messages(&[
            ChatMessage { role: "system".into(), content: "noise".into() },
            ChatMessage { role: "USER".into(), content: "one".into() },
            ChatMessage { role: "assistant".into(), content: "two".into() },
            ChatMessage { role: "tool".into(), content: "drop me".into() },
        ]);
        assert_eq!(cleaned.len(), 2);
        assert_eq!(cleaned[0]["role"], "user");
        assert_eq!(cleaned[0]["content"], "one");
        assert_eq!(cleaned[1]["role"], "assistant");
        assert_eq!(cleaned[1]["content"], "two");
    }
}

/// Fetch the list of installed Ollama models from the local daemon.
///
/// Returns an empty `Vec` on any failure — the Settings UI presents that
/// as "Ollama not running", and the agent loop falls back to its curated
/// defaults. We wrap the request in a short 2s timeout so a stuck daemon
/// never blocks the Settings tab from rendering.
pub async fn list_ollama_models() -> Vec<String> {
    use std::time::Duration;

    #[derive(serde::Deserialize)]
    struct TagsResp {
        #[serde(default)]
        models: Vec<TagItem>,
    }
    #[derive(serde::Deserialize)]
    struct TagItem {
        name: String,
    }

    let client = crate::http::client();
    let fut = client.get("http://127.0.0.1:11434/api/tags").send();
    let resp = match tokio::time::timeout(Duration::from_secs(2), fut).await {
        Ok(Ok(r)) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let parsed: TagsResp = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    parsed.models.into_iter().map(|m| m.name).collect()
}
