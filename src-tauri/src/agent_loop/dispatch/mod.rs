//! Tool dispatcher — the single choke-point between the ReAct loop and every
//! tool implementation.
//!
//! `dispatch_tool` is the only public entry point. Every tool call the agent
//! loop produces passes through it in a fixed, non-bypassable order:
//!
//! 1. **Panic-mode short-circuit** — if `security::panic_mode()` is armed,
//!    all tool calls are refused and a `ToolCall` audit event is emitted
//!    immediately; no further checks run.
//! 2. **Pre-dispatch security audit** — rate-anomaly and screen-exfil
//!    correlators are updated, outbound-content and shell-safety scanners
//!    run, the pre-dispatch `SecurityEvent::ToolCall` is emitted, and
//!    sub-agent role scoping + the enforcement-policy kill-switch list are
//!    consulted.  Constitution gate (`constitution::check_tool`) runs last
//!    in this phase and blocks calls prohibited by
//!    `~/.sunny/constitution.json` before ConfirmGate opens.
//! 3. **ConfirmGate** — dangerous tools (and every tool when
//!    `force_confirm_all` is set) block until the user approves or the
//!    timeout fires.  Outbound-scan findings are appended to the modal
//!    preview so the user sees risk context inline.
//! 4. **Trait-registry dispatch** — `tool_trait::find(name)` looks up the
//!    `inventory::submit!`-registered `ToolSpec` and calls its `invoke`
//!    fn pointer.  Capability enforcement (`check_capabilities` against
//!    `~/.sunny/grants.json`) runs inside `run_tool` before the invoke.
//!    A miss returns `unknown tool: <name>`; there is no legacy `match`
//!    fallback.  Long-running tools opt out of the 30 s
//!    `TOOL_TIMEOUT_SECS` cap and rely on their own internal deadlines.
//!
//! A retry policy (up to 3 attempts with 200 ms / 600 ms backoffs) covers
//! transient network errors on read-only tools; dangerous or write tools
//! never retry to avoid duplicate side effects.

pub mod classify;
pub mod execute;
pub mod wrap;

// Re-export the public surface so existing `use crate::agent_loop::dispatch::*`
// call sites keep working without any changes.
pub use classify::{classify_error, classify_tool_error, ToolErrorClass};
pub use execute::{run_with_retry, validate_args};
pub use wrap::{escape_untrusted_marker, wrap_error, wrap_success};

use std::time::{Duration, Instant};

use tauri::AppHandle;
use uuid::Uuid;

use super::catalog::is_dangerous;
use super::confirm::request_confirm;
use super::types::{ToolCall, ToolOutput};
use crate::event_bus::{publish as publish_bus, SunnyEvent};
use crate::security::{self, SecurityEvent, Severity};

use execute::{run_tool, MAX_ATTEMPTS};

const TOOL_TIMEOUT_SECS: u64 = 30;

pub async fn dispatch_tool(
    app: &AppHandle,
    call: &ToolCall,
    requesting_agent: Option<&str>,
    parent_session_id: Option<&str>,
    depth: u32,
    confirm_timeout_secs: u64,
    // Pre-dispatch narrative from the model — the `thinking` block on
    // `TurnOutcome::Tools`. Carries the reasoning that preceded this
    // tool pick so we can persist it alongside the telemetry row for
    // the audit surface. `None` when the caller doesn't have a
    // reasoning string (legacy call sites, ad-hoc invocations, tests).
    // Named `model_reason` rather than plain `reason` to avoid
    // shadowing the policy / constitution / confirm refusal `reason`
    // locals further down this function.
    model_reason: Option<&str>,
    // Turn ID shared across every tool call in this iteration so the
    // schema-v9 `tool_usage.turn_id` FK lets the analyzer reassemble
    // multi-tool turns. Passed by core.rs::run_staged_tools — legacy
    // call sites (tests, ad-hoc invocations) pass `None` and write
    // NULL the same way the back-compat `record()` shim does.
    turn_id: Option<&str>,
) -> ToolOutput {
    let t0 = Instant::now();
    let name = call.name.clone();
    let requester_label = requesting_agent.unwrap_or("main");
    let dangerous = is_dangerous(&name);
    let risk_tag: &'static str = if dangerous { "dangerous" } else { "standard" };
    let event_id = Uuid::new_v4().to_string();

    // Panic short-circuit — every tool is blocked while panic mode is
    // engaged. We emit a tool_call event tagged with `ok=false,
    // blocked=true` so the audit log shows the attempt.
    if security::panic_mode() {
        let preview = security::preview_input(&call.input, 256);
        security::emit(SecurityEvent::ToolCall {
            at: security::now(),
            id: event_id.clone(),
            tool: name.clone(),
            risk: risk_tag,
            dangerous,
            agent: requester_label.to_string(),
            input_preview: preview,
            ok: Some(false),
            output_bytes: Some(0),
            duration_ms: Some(0),
            severity: Severity::Warn,
        });
        let msg = format!("panic mode active — {name} refused");
        let _ = crate::memory::tool_usage::record_with_turn(
            &name,
            false,
            0,
            Some(&msg),
            model_reason,
            turn_id,
        );
        return wrap_error(&name, "panic_mode", msg, false);
    }

    // Rolling rate-anomaly check.
    security::behavior::record_tool_call(&name);

    // Mark screen-reading tool invocations for egress correlation.
    if security::egress_monitor::is_screen_tool(&name) {
        security::egress_monitor::observe_screen_tool(&name);
    }

    // Phase 4 pre-dispatch scanners: outbound content + shell.
    let outbound_hits = if security::outbound::is_outbound_tool(&name) {
        security::outbound::scan_outbound(&name, &call.input)
    } else {
        Vec::new()
    };
    let input_preview_pre = security::preview_input(&call.input, 256);
    // Hard-block shell patterns BEFORE we even open the confirm modal.
    if name == "run_shell" {
        if let Some(cmd) = call.input.get("cmd").and_then(|v| v.as_str()) {
            match security::shell_safety::verdict(cmd) {
                Ok(_hits) => { /* warn-level only; preview will show */ }
                Err(msg) => {
                    let _ = crate::memory::tool_usage::record_with_turn(&name, false, 0, Some(&msg), model_reason, turn_id);
                    security::emit(SecurityEvent::ToolCall {
                        at: security::now(),
                        id: event_id.clone(),
                        tool: name.clone(),
                        risk: risk_tag,
                        dangerous,
                        agent: requester_label.to_string(),
                        input_preview: input_preview_pre.clone(),
                        ok: Some(false),
                        output_bytes: Some(0),
                        duration_ms: Some(0),
                        severity: Severity::Crit,
                    });
                    return wrap_error(&name, "shell_hard_block", msg, false);
                }
            }
        }
    }
    // Canary in outbound body → auto-panic already fired inside
    // scan_outbound; short-circuit here too so the send doesn't
    // race the panic flag flipping.
    if outbound_hits.iter().any(|f| f.kind == "canary") {
        let msg = "outbound content contains canary — refused".to_string();
        let _ = crate::memory::tool_usage::record_with_turn(&name, false, 0, Some(&msg), model_reason, turn_id);
        return wrap_error(&name, "canary_denied", msg, false);
    }

    // Emit the pre-dispatch ToolCall event so the Security feed shows
    // the call before the tool actually runs.
    security::emit(SecurityEvent::ToolCall {
        at: security::now(),
        id: event_id.clone(),
        tool: name.clone(),
        risk: risk_tag,
        dangerous,
        agent: requester_label.to_string(),
        input_preview: input_preview_pre.clone(),
        ok: None,
        output_bytes: None,
        duration_ms: None,
        severity: if dangerous { Severity::Warn } else { Severity::Info },
    });

    // Sub-agent role scoping.
    if security::enforcement::snapshot().subagent_role_scoping
        && !super::scope::allowed_in_scope(&name)
    {
        let role = super::scope::current_scope()
            .map(|(r, _)| r)
            .unwrap_or_else(|| "unknown".into());
        let msg = format!("subagent role `{role}` not permitted to call `{name}`");
        security::emit(SecurityEvent::ToolCall {
            at: security::now(),
            id: event_id.clone(),
            tool: name.clone(),
            risk: risk_tag,
            dangerous,
            agent: requester_label.to_string(),
            input_preview: security::preview_input(&call.input, 256),
            ok: Some(false),
            output_bytes: Some(0),
            duration_ms: Some(0),
            severity: Severity::Warn,
        });
        let _ = crate::memory::tool_usage::record_with_turn(&name, false, 0, Some(&msg), model_reason, turn_id);
        return wrap_error(&name, "role_scope_denied", msg, false);
    }

    // Enforcement-policy consultation.
    let mut needs_confirm = match security::enforcement::tool_verdict(&name, dangerous) {
        Ok(nc) => nc,
        Err(reason) => {
            let msg = format!("policy: {reason}");
            let _ = crate::memory::tool_usage::record_with_turn(
                &name, false, 0, Some(&msg), model_reason, turn_id,
            );
            security::emit(SecurityEvent::ToolCall {
                at: security::now(),
                id: event_id.clone(),
                tool: name.clone(),
                risk: risk_tag,
                dangerous,
                agent: requester_label.to_string(),
                input_preview: input_preview_pre,
                ok: Some(false),
                output_bytes: Some(0),
                duration_ms: Some(0),
                severity: Severity::Warn,
            });
            return wrap_error(&name, "policy_denied", msg, false);
        }
    };

    // Safe-apps allowlist bypass. app_launch and app_activate are
    // flagged dangerous: true at the tool-spec level because they can
    // launch arbitrary GUI binaries, but the common agent pattern is
    // "open Safari to go to facebook.com" — asking the user to approve
    // every Safari / Finder / Calendar launch is exactly the
    // "automation-that-constantly-interrupts" anti-UX. When the input
    // name matches a known-safe app, suppress the confirm requirement.
    // The tool-dispatch audit event still fires so the action is
    // logged regardless.
    if needs_confirm && (name == "app_launch" || name == "app_activate") {
        let app_name = call
            .input
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if is_safe_app(&app_name) {
            log::info!("dispatch: auto-approving {name}({app_name}) via safe-apps allowlist");
            needs_confirm = false;
        }
    }

    // Rust-side constitution check.
    {
        let input_s = serde_json::to_string(&call.input).unwrap_or_else(|_| "{}".into());
        let con = crate::constitution::current();
        if let crate::constitution::Decision::Block(reason) = con.check_tool(&name, &input_s) {
            let msg = format!("constitution: {reason}");
            let _ = crate::memory::tool_usage::record_with_turn(
                &name, false, 0, Some(&msg), model_reason, turn_id,
            );
            security::emit(SecurityEvent::ToolCall {
                at: security::now(),
                id: event_id.clone(),
                tool: name.clone(),
                risk: risk_tag,
                dangerous,
                agent: requester_label.to_string(),
                input_preview: input_preview_pre,
                ok: Some(false),
                output_bytes: Some(0),
                duration_ms: Some(0),
                severity: Severity::Warn,
            });
            return wrap_error(&name, "constitution_denied", msg, false);
        }
    }

    // Voice-unsafe tools — hard refuse before ConfirmGate so the LLM
    // self-corrects to a safer path on the next turn. Covers tools
    // whose outputs are binary blobs (base64 PNGs from screen capture)
    // or depend on an optional multimodal model that may not be
    // installed (`image_describe`). Letting these through on voice
    // means Kokoro reads the raw bytes aloud.
    let is_voice = super::core_helpers::is_voice_session(parent_session_id);
    if is_voice && crate::agent_loop::catalog::is_voice_unsafe(&name) {
        let msg = format!(
            "voice_unsafe: `{name}` produces output that text-to-speech can't read \
             (binary blob or vision payload). Ask the user to try this one with \
             the HUD open, or pick a different tool."
        );
        let _ = crate::memory::tool_usage::record_with_turn(
            &name,
            false,
            t0.elapsed().as_millis() as i64,
            Some(&msg),
            model_reason,
            turn_id,
        );
        security::emit(SecurityEvent::ToolCall {
            at: security::now(),
            id: event_id.clone(),
            tool: name.clone(),
            risk: risk_tag,
            dangerous,
            agent: requester_label.to_string(),
            input_preview: input_preview_pre.clone(),
            ok: Some(false),
            output_bytes: Some(0),
            duration_ms: Some(t0.elapsed().as_millis() as i64),
            severity: Severity::Warn,
        });
        return wrap_error(&name, "voice_unsafe", msg, false);
    }

    // ConfirmGate — block the dispatch until the user approves.
    //
    // Voice sessions (`session_id.starts_with("sunny-voice-")`) skip the
    // modal entirely: a floating confirm dialog can't be addressed
    // hands-free, and waiting for it to time out would silently freeze
    // the voice pipeline (no TTS, no Orb state change) for the full
    // `confirm_timeout_secs`. Instead we auto-deny with a structured
    // reason the LLM can turn into a spoken ask — e.g. "I can't do that
    // hands-free — repeat it with the HUD open so you can approve."
    let preview_suffix = security::outbound::preview_suffix(&outbound_hits);
    if needs_confirm {
        if is_voice {
            let msg =
                "voice_confirm_unavailable: this tool needs visual confirmation — \
                 ask again with the HUD open, or type the request into the chat panel."
                    .to_string();
            let _ = crate::memory::tool_usage::record_with_turn(
                &name,
                false,
                t0.elapsed().as_millis() as i64,
                Some(&msg),
                model_reason,
                turn_id,
            );
            security::emit(SecurityEvent::ToolCall {
                at: security::now(),
                id: event_id,
                tool: name.clone(),
                risk: risk_tag,
                dangerous,
                agent: requester_label.to_string(),
                input_preview: input_preview_pre,
                ok: Some(false),
                output_bytes: Some(0),
                duration_ms: Some(t0.elapsed().as_millis() as i64),
                severity: Severity::Warn,
            });
            return wrap_error(&name, "voice_confirm_unavailable", msg, false);
        }
        if let Err(reason) = request_confirm(
            app,
            call,
            requester_label,
            confirm_timeout_secs,
            preview_suffix.as_deref(),
        ).await {
            let msg = format!("user declined: {reason}");
            let _ = crate::memory::tool_usage::record_with_turn(
                &name,
                false,
                t0.elapsed().as_millis() as i64,
                Some(&msg),
                model_reason,
                turn_id,
            );
            security::emit(SecurityEvent::ToolCall {
                at: security::now(),
                id: event_id,
                tool: name.clone(),
                risk: risk_tag,
                dangerous,
                agent: requester_label.to_string(),
                input_preview: input_preview_pre,
                ok: Some(false),
                output_bytes: Some(0),
                duration_ms: Some(t0.elapsed().as_millis() as i64),
                severity: Severity::Warn,
            });
            return wrap_error(&name, "denied", msg, false);
        }
    }

    // Long-running tools opt out of the per-tool timeout cap.
    let is_long_running = matches!(
        name.as_str(),
        "spawn_subagent"
            | "deep_research"
            | "claude_code_supervise"
            | "summarize_pdf"
            | "code_edit"
            | "web_browse"
            | "plan_execute"
            | "agent_reflect"
            | "council_decide"
            | "reflexion_answer"
            | "agent_wait"
    );
    let requester_owned: Option<String> = requesting_agent.map(String::from);

    // Retry policy for transient failures.
    let retry_eligible = !dangerous;
    let tool_name_for_log = name.clone();
    let (result, attempts_made) = run_with_retry(
        retry_eligible,
        move |_attempt| {
            let app = app.clone();
            let call = call.clone();
            let parent_session_id = parent_session_id.map(String::from);
            let requester_owned = requester_owned.clone();
            async move {
                let fut = run_tool(app, call, parent_session_id, depth, requester_owned);
                if is_long_running {
                    Ok(fut.await)
                } else {
                    tokio::time::timeout(Duration::from_secs(TOOL_TIMEOUT_SECS), fut).await
                }
            }
        },
        &tool_name_for_log,
    )
    .await;

    let elapsed_ms = t0.elapsed().as_millis() as i64;

    let output = match result {
        Ok(Ok(s)) => wrap_success(&name, s),
        Ok(Err(e)) => {
            let (kind, retriable) = classify_error(&e);
            let exhausted = attempts_made >= MAX_ATTEMPTS
                && matches!(classify_tool_error(&e), ToolErrorClass::Transient);
            let final_msg = if exhausted {
                format!("transient, {attempts_made} attempts exhausted — {e}")
            } else {
                e
            };
            wrap_error(&name, kind, final_msg, retriable)
        }
        Err(_) => {
            let msg = if attempts_made >= MAX_ATTEMPTS {
                format!(
                    "transient, {attempts_made} attempts exhausted — tool `{name}` \
                     timed out after {TOOL_TIMEOUT_SECS}s"
                )
            } else {
                format!("tool `{name}` timed out after {TOOL_TIMEOUT_SECS}s")
            };
            wrap_error(&name, "timeout", msg, true)
        }
    };

    let err_msg = if output.ok {
        None
    } else {
        Some(output.display.as_str())
    };
    let _ = crate::memory::tool_usage::record_with_turn(&name, output.ok, elapsed_ms, err_msg, model_reason, turn_id);

    // Final ToolCall row — carries the verdict + sizes for the audit feed.
    let sev = match (output.ok, dangerous) {
        (false, _) => Severity::Warn,
        (true, true) => Severity::Warn,
        (true, false) => Severity::Info,
    };

    // Human-readable step text for the agent UI (orb footer / PlanPanel /
    // AGENTS LIVE). The frontend's useAgentStepBridge splits this on the
    // Unicode arrow → so the `splitToolResult` parser can pull the tool
    // name + preview apart. Previously this emitted the raw JSON metadata
    // (`{"duration_ms":1643,"id":"…"}`) as the step text and the tool
    // NAME in the `tool` field — but the frontend uses `tool` as a kind
    // discriminator ("thinking" | "tool_call" | "tool_result" | "answer"),
    // so a real tool name like "weather_current" fell into the unknown-
    // kind path and rendered the JSON verbatim to the user.
    let preview = if output.ok {
        crate::agent_loop::helpers::truncate(&output.display, 200)
    } else {
        format!("error: {}", crate::agent_loop::helpers::truncate(&output.display, 200))
    };
    let human_text = format!("{name} \u{2192} {preview}");
    publish_bus(SunnyEvent::AgentStep {
        seq: 0,
        boot_epoch: 0,
        turn_id: event_id.clone(),
        iteration: 0,
        text: human_text,
        tool: Some(if output.ok { "tool_result".to_string() } else { "error".to_string() }),
        at: chrono::Utc::now().timestamp_millis(),
    });

    security::emit(SecurityEvent::ToolCall {
        at: security::now(),
        id: event_id,
        tool: name.clone(),
        risk: risk_tag,
        dangerous,
        agent: requester_label.to_string(),
        input_preview: security::preview_input(&call.input, 256),
        ok: Some(output.ok),
        output_bytes: Some(output.display.len()),
        duration_ms: Some(elapsed_ms),
        severity: sev,
    });

    output
}

/// Lowercase app names that may be launched without a ConfirmGate
/// prompt. These are standard macOS first-party / widely-installed
/// apps where launching them is a plainly routine action — matching
/// the user expectation that "an automation assistant opens Safari
/// without asking". Anything not on this list still goes through
/// confirmation.
///
/// Keep the list conservative. Never auto-approve anything that can
/// execute arbitrary commands (Terminal, iTerm) or modify system
/// state without further confirmation on its own (Disk Utility, etc).
fn is_safe_app(name_lower: &str) -> bool {
    matches!(
        name_lower,
        // Apple first-party consumer apps
        "safari" | "finder" | "calendar" | "messages" | "mail" | "notes"
        | "reminders" | "maps" | "news" | "music" | "podcasts" | "tv"
        | "app store" | "books" | "photos" | "preview" | "contacts"
        | "facetime" | "weather" | "stocks" | "voice memos" | "home"
        | "system settings" | "system preferences" | "calculator"
        // Common third-party the user has per their memory
        | "antigravity" | "claude" | "cursor" | "vscode" | "visual studio code"
        | "chrome" | "firefox" | "arc" | "brave" | "edge"
        | "spotify" | "slack" | "discord" | "zoom" | "obsidian" | "notion"
        | "1password" | "chatgpt" | "chatgpt atlas"
    )
}
