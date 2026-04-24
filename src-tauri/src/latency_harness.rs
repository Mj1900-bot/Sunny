//! Latency harness — Wave 2 measurement rig for the 2 s SLA.
//!
//! This module drives a prescribed user message through the production
//! `agent_loop::agent_run` entry point and records stage-level timing to
//! a persistent JSONL sink at `~/.sunny/latency/runs.jsonl`. Stage
//! boundaries are captured via `stage_marker` calls wired into the core
//! loop — the harness doesn't parallel-mock anything, it just wraps the
//! real runtime and reads the same markers production would emit.
//!
//! Threading model: a task-local `RunId` (set via `tokio::task_local!`)
//! scopes all markers inside an `agent_run` invocation. If the task-local
//! isn't set (normal production traffic) `stage_marker` is a no-op, so
//! production pays zero cost. The harness enters the scope by calling
//! `run_fixture` which spawns `agent_run` inside `RUN_ID.scope(...)`.
//!
//! The JSONL file is append-only and locked per-write with a short mutex
//! hold so concurrent harness invocations don't interleave lines. One
//! line per event; fields are flat for grep-friendly inspection:
//!
//! ```text
//! {"ts_ms":1713830400123,"run_id":"hx-a1b2","fixture":"latency/basic.json","stage":"turn_start","extra":null}
//! {"ts_ms":1713830400456,"run_id":"hx-a1b2","fixture":"latency/basic.json","stage":"first_token","extra":{"provider":"glm","model":"glm-5.1"}}
//! ```
//!
//! Fixture schema (JSON):
//! ```json
//! {
//!   "name": "basic_weather",
//!   "message": "what's the weather in Vancouver?",
//!   "session_id": "harness-basic-weather",
//!   "quality_mode": "Fast",
//!   "was_voice": false,
//!   "expect_tools": ["web_search"]
//! }
//! ```
//!
//! Only `message` is required; everything else is optional. Defaults keep
//! the fixture single-turn, non-voice, fast-mode.
//!
//! SAFETY: this command is gated behind `#[cfg(debug_assertions)]` so it
//! only ships in dev builds. Release bundles have no latency sink, no
//! command handler, no attack surface.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Task-local run context
// ---------------------------------------------------------------------------

tokio::task_local! {
    /// Harness run context, scoped to the future passed to `RUN_ID.scope`.
    /// Outside the scope every `stage_marker` call is a no-op, so the cost
    /// on normal production traffic is a single task-local lookup (~ns).
    static RUN_CTX: RunCtx;
}

#[derive(Clone, Debug)]
struct RunCtx {
    run_id: String,
    fixture: String,
    /// Start instant of the run; used to derive the `total_ms` on turn_end
    /// without relying on the wall-clock timestamps (which drift during
    /// streaming).
    started: Instant,
}

// ---------------------------------------------------------------------------
// Stage markers emitted by the agent loop + providers
// ---------------------------------------------------------------------------

/// Canonical stage names. Providers/core.rs call `stage_marker` with one
/// of these strings. Free-form so the list can grow without a breaking
/// enum change, but the harness analyser expects these canonical names
/// to compute per-stage budgets.
pub mod stages {
    pub const TURN_START: &str = "turn_start";
    pub const PREP_CONTEXT_END: &str = "prep_context_end";
    pub const FIRST_TOKEN: &str = "first_token";
    pub const TOOL_DISPATCH_START: &str = "tool_dispatch_start";
    pub const TOOL_DISPATCH_END: &str = "tool_dispatch_end";
    pub const FULL_RESPONSE_END: &str = "full_response_end";
    pub const CRITIC_START: &str = "critic_start";
    pub const CRITIC_END: &str = "critic_end";
    pub const TURN_END: &str = "turn_end";
    pub const TURN_TIMEOUT: &str = "turn_timeout";
}

/// Emit one stage marker. No-op when not running inside a harness
/// `RUN_CTX.scope(...)` — production traffic pays a single task-local
/// try-with, nothing more. Errors writing the sink are logged at `warn`
/// and swallowed: telemetry must never break the agent loop.
pub fn stage_marker(stage: &str, extra: Option<Value>) {
    let Ok(ctx) = RUN_CTX.try_with(|c| c.clone()) else {
        return; // Not in a harness scope — production path, no-op.
    };
    let ts_ms = chrono::Utc::now().timestamp_millis();
    let rec = json!({
        "ts_ms": ts_ms,
        "run_id": ctx.run_id,
        "fixture": ctx.fixture,
        "stage": stage,
        "extra": extra,
    });
    if let Err(e) = append_line(&rec) {
        log::warn!("latency_harness: append {stage} failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// JSONL sink
// ---------------------------------------------------------------------------

fn sink_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    Ok(home.join(".sunny").join("latency"))
}

fn sink_path() -> Result<PathBuf, String> {
    Ok(sink_dir()?.join("runs.jsonl"))
}

/// Module-local write mutex — sqlite isn't in play here, and we want
/// concurrent harness runs (if any) to not interleave partial lines.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn append_line(rec: &Value) -> Result<(), String> {
    let dir = sink_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("create latency dir: {e}"))?;
    let path = sink_path()?;
    let line = serde_json::to_string(rec).map_err(|e| format!("jsonl encode: {e}"))?;
    let _guard = write_lock().lock().map_err(|_| "latency lock poisoned".to_string())?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    writeln!(f, "{line}").map_err(|e| format!("append: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Fixture + summary types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct Fixture {
    #[serde(default)]
    name: Option<String>,
    message: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    quality_mode: Option<String>,
    #[serde(default)]
    was_voice: Option<bool>,
    /// Purely informational — the harness does not enforce or compare
    /// against this, it's for human-auditable fixture authoring.
    #[serde(default)]
    #[allow(dead_code)]
    expect_tools: Option<Vec<String>>,
}

/// Summary returned from the Tauri command. The frontend dev-button
/// displays these fields inline; the full breakdown lives in the
/// JSONL sink and is surfaced by a separate analyser pass.
#[derive(Serialize, Debug)]
pub struct RunSummary {
    pub run_id: String,
    pub fixture: String,
    pub total_ms: u64,
    /// Set when the run completed; `None` if `agent_run` returned an
    /// error. The harness never swallows errors — they surface in
    /// the summary so the operator can triage.
    pub final_text: Option<String>,
    pub error: Option<String>,
    /// Absolute path to the JSONL sink so the dev UI can point the
    /// operator at the raw log.
    pub sink_path: String,
}

// ---------------------------------------------------------------------------
// Tauri command — dev-only
// ---------------------------------------------------------------------------

/// Load a fixture from disk and drive it through the agent loop,
/// emitting stage markers to the JSONL sink. Dev-only: gated behind
/// `#[cfg(debug_assertions)]` so release builds don't ship it.
///
/// `fixture_path` is interpreted relative to `~/.sunny/latency/fixtures/`
/// if it isn't absolute — keeps the UI trigger terse.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn latency_run_fixture(
    app: tauri::AppHandle,
    fixture_path: String,
) -> Result<RunSummary, String> {
    use crate::ai::ChatRequest;

    let resolved = resolve_fixture_path(&fixture_path)?;
    let raw = fs::read_to_string(&resolved)
        .map_err(|e| format!("read fixture {}: {e}", resolved.display()))?;
    let fixture: Fixture = serde_json::from_str(&raw)
        .map_err(|e| format!("parse fixture {}: {e}", resolved.display()))?;

    let fixture_label = fixture
        .name
        .clone()
        .unwrap_or_else(|| resolved.display().to_string());
    let run_id = format!("hx-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);

    let ctx = RunCtx {
        run_id: run_id.clone(),
        fixture: fixture_label.clone(),
        started: Instant::now(),
    };

    // `ChatRequest` does not derive `Default` (fields are populated by
    // serde from the Tauri IPC payload), so we spell every field here.
    // The safety aligner MUST re-confirm this matches the current
    // definition in `ai.rs` if new fields are added.
    let effective_session_id = if fixture.was_voice.unwrap_or(false) {
        // The loop's `is_voice_session` gate keys off the `sunny-voice-`
        // prefix (see `core_helpers::is_voice_session`). Respect any
        // operator-provided session_id but prefer voice branding when
        // the fixture asked for it.
        Some(
            fixture
                .session_id
                .clone()
                .unwrap_or_else(|| format!("sunny-voice-harness-{run_id}")),
        )
    } else {
        fixture.session_id.clone()
    };
    let req = ChatRequest {
        message: fixture.message.clone(),
        model: None,
        provider: None,
        history: Vec::new(),
        session_id: effective_session_id,
        chat_mode: None,
    };

    let app_clone = app.clone();
    let started = ctx.started;
    let fixture_for_sink = fixture_label.clone();
    let run_id_for_sink = run_id.clone();

    let outcome: Result<String, String> = RUN_CTX
        .scope(ctx, async move {
            stage_marker(stages::TURN_START, None);
            let r = crate::agent_loop::agent_run(app_clone, req).await;
            let extra = match &r {
                Ok(_) => json!({"ok": true}),
                Err(e) => json!({"ok": false, "error": e}),
            };
            stage_marker(stages::TURN_END, Some(extra));
            r
        })
        .await;

    let total_ms = started.elapsed().as_millis() as u64;
    let sink_path = sink_path()?.display().to_string();

    let summary = match outcome {
        Ok(text) => RunSummary {
            run_id: run_id_for_sink,
            fixture: fixture_for_sink,
            total_ms,
            final_text: Some(text),
            error: None,
            sink_path,
        },
        Err(e) => RunSummary {
            run_id: run_id_for_sink,
            fixture: fixture_for_sink,
            total_ms,
            final_text: None,
            error: Some(e),
            sink_path,
        },
    };
    Ok(summary)
}

/// Release-build stub. Keeps the `generate_handler!` macro uniform across
/// build profiles — release bundles have the command registered but it
/// always returns an error explaining the gating. Prevents accidental
/// use by an operator who forgot they swapped builds, and keeps the
/// macro from failing to resolve the symbol in `src/lib.rs`.
#[cfg(not(debug_assertions))]
#[tauri::command]
pub async fn latency_run_fixture(
    _app: tauri::AppHandle,
    _fixture_path: String,
) -> Result<RunSummary, String> {
    Err("latency_run_fixture is dev-only (requires debug_assertions)".to_string())
}

#[cfg(debug_assertions)]
fn resolve_fixture_path(p: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(p);
    if candidate.is_absolute() && candidate.exists() {
        return Ok(candidate);
    }
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    let under_sunny = home.join(".sunny").join("latency").join("fixtures").join(p);
    if under_sunny.exists() {
        return Ok(under_sunny);
    }
    Err(format!("fixture not found: {p} (tried absolute and ~/.sunny/latency/fixtures/)"))
}

// ---------------------------------------------------------------------------
// Tests — pure-unit, no runtime
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_marker_is_noop_outside_scope() {
        // Must not panic and must not create the sink if we're not in a
        // RUN_CTX.scope — production traffic has no harness context.
        stage_marker(stages::TURN_START, None);
        // (We can't cleanly assert "file doesn't exist" because a prior
        // test run may have created it. The real invariant is: no panic,
        // no error surfaced to the caller — both satisfied by a no-op.)
    }

    #[test]
    fn fixture_parses_minimum_shape() {
        let raw = r#"{"message":"hello"}"#;
        let f: Fixture = serde_json::from_str(raw).unwrap();
        assert_eq!(f.message, "hello");
        assert!(f.session_id.is_none());
        assert!(f.was_voice.is_none());
    }

    #[test]
    fn fixture_parses_full_shape() {
        let raw = r#"{
            "name":"basic",
            "message":"weather?",
            "session_id":"harness-1",
            "quality_mode":"Fast",
            "was_voice":true,
            "expect_tools":["web_search"]
        }"#;
        let f: Fixture = serde_json::from_str(raw).unwrap();
        assert_eq!(f.name.as_deref(), Some("basic"));
        assert_eq!(f.was_voice, Some(true));
    }
}
