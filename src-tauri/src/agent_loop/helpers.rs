//! Shared helpers for the agent loop — event bus bridging and argument parsing.
//!
//! Two concerns live here:
//!
//! **Event-bus bridges.** `emit_agent_step` and `emit_sub_event` convert
//! internal loop state into `SunnyEvent` payloads and publish them on the
//! `sunny://agent.step` / `sunny://agent.sub` channels. Turn and run ids are
//! derived deterministically from `(session_id, iteration)` so a tailer can
//! fold events from the same logical step even if they arrive out of order.
//!
//! **Argument parsing.** `string_arg`, `optional_string_arg`, and
//! `pretty_short` are thin wrappers around `serde_json::Value` access with
//! consistent error messages. They exist so every dispatch arm reports missing
//! or mistyped keys with the same structured string the LLM can read, rather
//! than ad-hoc `.unwrap()` panics.

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::ai::ChatMessage;
use crate::event_bus::{publish, SunnyEvent};

// ---------------------------------------------------------------------------
// Event-bus bridge helpers
// ---------------------------------------------------------------------------

/// Derive a deterministic `turn_id` for the event-bus `AgentStep` variant.
/// The same (session, iteration) pair ALWAYS produces the same id, and the
/// sub-agent path is namespaced so a sub-agent step can't collide with a
/// main-agent step that happens to share the iteration number.
fn derive_turn_id(sub_id: Option<&str>, session_id: &Option<String>, iteration: u32) -> String {
    let session = session_id.as_deref().unwrap_or("main");
    match sub_id {
        Some(sub) => format!("sub:{sub}:{session}:{iteration}"),
        None => format!("{session}:{iteration}"),
    }
}

/// Derive a deterministic `run_id` for the event-bus `SubAgent` variant.
/// Every lifecycle event for the same sub-agent carries the same id so
/// tailers can fold them into one run.
fn derive_run_id(sub_id: &str) -> String {
    format!("sub:{sub_id}")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

pub fn string_arg(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing string arg `{key}`"))
}

pub fn optional_string_arg(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

pub fn u32_arg(v: &Value, key: &str) -> Option<u32> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .and_then(|n| u32::try_from(n).ok())
}

pub fn usize_arg(v: &Value, key: &str) -> Option<usize> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .and_then(|n| usize::try_from(n).ok())
}

pub fn f64_arg(v: &Value, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .ok_or_else(|| format!("missing number arg `{key}`"))
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/// Emit a step event. The main agent publishes to the event bus
/// (`SunnyEvent::AgentStep`); a sub-agent (`sub_id == Some`) still emits
/// to `sunny://agent.sub` with `kind: "step"` and a nested payload so the
/// UI can route to the right sub-agent card.
pub fn emit_agent_step(
    app: &AppHandle,
    sub_id: Option<&str>,
    session_id: &Option<String>,
    iteration: u32,
    kind: &str,
    content: &str,
) {
    match sub_id {
        None => {
            // Main-agent steps go to the event bus only; no Tauri emit.
        }
        Some(id) => {
            // `emit_sub_event` publishes via `SunnyEvent::SubAgent` only;
            // the `sunny://agent.sub` Tauri emit is retired.
            let payload = json!({
                "iteration": iteration,
                "kind": kind,
                "content": content,
                "session_id": session_id,
            });
            emit_sub_event(app, id, "step", payload);
        }
    }

    // Belt + braces: also publish to the persistent event spine so the
    // StatusBanner tail and cross-session replay see agent iterations
    // even when no frontend listener is attached. Fire-and-forget per
    // the bus's non-blocking contract.
    publish(SunnyEvent::AgentStep {
        seq: 0,
        boot_epoch: 0,
        turn_id: derive_turn_id(sub_id, session_id, iteration),
        iteration,
        text: content.to_string(),
        tool: Some(kind.to_string()).filter(|s| !s.is_empty()),
        at: now_ms(),
    });
}

/// Emit a sub-agent lifecycle event onto the event bus (`SunnyEvent::SubAgent`).
/// `kind` is one of `"start" | "step" | "done" | "error"`; the UI uses
/// it to update the sub-agent card state.
///
/// `sunny://agent.sub` Tauri emit is retired; consumers subscribe via
/// `useEventBus({ kind: 'SubAgent' })`. The bus variant carries
/// `iteration / step_kind / content`, preserving every field the old
/// Tauri payload shipped:
///
///   - `step` lifecycle → iteration / step_kind / content carry the
///     per-iteration body verbatim. `goal` is unused.
///   - `start` lifecycle → `goal` carries the task; `content` carries a
///     JSON blob with {role, model, parent, depth} so the UI can build
///     the sub-agent card.
///   - `done` lifecycle → `content` carries the final answer; `goal`
///     carries the role (optional hint for replayers).
///   - `error` lifecycle → `content` carries the error message; `goal`
///     carries the role.
pub fn emit_sub_event(app: &AppHandle, sub_id: &str, kind: &str, payload: Value) {
    // `app` is retained (not `_app`) so the signature stays stable for
    // future callers that need a handle — every existing call site
    // already passes one. Silences the unused-variable lint without a
    // rename that would ripple through subagents.rs / agent_loop.
    let _ = app;

    // Extract the structured fields the bus variant exposes directly.
    // Everything else is folded into `content` as a JSON blob for the
    // frontend to decode. Missing / wrong-typed fields fall back to
    // sensible defaults — the UI tolerates empty strings.
    let iteration = payload
        .get("iteration")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0);

    let (step_kind, content, goal) = match kind {
        "step" => {
            let step_kind = payload
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = payload
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (step_kind, content, None)
        }
        "start" => {
            // `task` becomes the goal so downstream SQLite tailers can
            // filter by it. `role/model/parent/depth` ride inside a JSON
            // blob on `content`.
            let task = payload
                .get("task")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            let blob = json!({
                "role": payload.get("role").and_then(|v| v.as_str()).unwrap_or(""),
                "model": payload.get("model").and_then(|v| v.as_str()).unwrap_or(""),
                "parent": payload.get("parent").and_then(|v| v.as_str()),
                "depth": payload.get("depth").and_then(|v| v.as_u64()).unwrap_or(0),
            });
            let content = serde_json::to_string(&blob).unwrap_or_else(|_| "{}".into());
            (String::new(), content, task)
        }
        "done" => {
            let answer = payload
                .get("answer")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let role = payload
                .get("role")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            (String::new(), answer, role)
        }
        "error" => {
            let err_msg = payload
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let role = payload
                .get("role")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            (String::new(), err_msg, role)
        }
        _ => {
            // Unknown lifecycle — preserve the `goal` fallback behavior
            // so legacy callers that packed everything into `goal` still
            // show up on the bus.
            let goal = payload
                .get("goal")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            (String::new(), String::new(), goal)
        }
    };

    publish(SunnyEvent::SubAgent {
        seq: 0,
        boot_epoch: 0,
        run_id: derive_run_id(sub_id),
        lifecycle: kind.to_string(),
        goal,
        iteration,
        kind: step_kind,
        content,
        at: now_ms(),
    });
}

/// Emit a closing `chat.chunk` / `chat.done` pair for the degraded
/// paths (timeout, max-iterations). Sub-agent runs skip the chat
/// streaming (their answer flows back as a tool result instead). Always
/// returns the full string so the command-level return value stays
/// correct.
pub fn finalize_with_note(
    app: &AppHandle,
    session_id: &Option<String>,
    sub_id: Option<&str>,
    partial: String,
    last_thinking: String,
    note: &str,
    max_iterations: u32,
) -> String {
    let base = if !partial.trim().is_empty() {
        partial
    } else {
        last_thinking
    };
    let out = if base.trim().is_empty() {
        note.to_string()
    } else {
        format!("{base} {note}")
    };
    emit_agent_step(app, sub_id, session_id, max_iterations, "answer", &out);
    if sub_id.is_none() {
        // Bus push channel only. Consumers subscribe to SunnyEvent::ChatChunk
        // via `useEventBus`; the legacy `sunny://chat.chunk` / `sunny://chat.done`
        // Tauri emits are retired.
        publish(SunnyEvent::ChatChunk {
            seq: 0,
            boot_epoch: 0,
            turn_id: derive_turn_id(None, session_id, max_iterations),
            delta: out.clone(),
            done: true,
            at: now_ms(),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub fn message_to_value(m: &ChatMessage) -> Value {
    // Roles Ollama and Anthropic both accept: user, assistant. Anything
    // else is coerced to user to avoid an API rejection on replay.
    let role = match m.role.to_ascii_lowercase().as_str() {
        "assistant" => "assistant",
        _ => "user",
    };
    json!({ "role": role, "content": m.content })
}

pub fn extract_system_prompt(history: &[ChatMessage]) -> Option<String> {
    history
        .iter()
        .find(|m| m.role.eq_ignore_ascii_case("system"))
        .map(|m| m.content.clone())
}

/// Compact a JSON value into a short label for the agent.step event.
pub fn pretty_short(v: &Value) -> String {
    let raw = serde_json::to_string(v).unwrap_or_else(|_| "{}".into());
    truncate(&raw, 160)
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}
