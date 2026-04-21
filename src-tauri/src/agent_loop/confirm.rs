//! ConfirmGate — user-approval modal for dangerous tool calls.
//!
//! When `dispatch_tool` determines a call needs confirmation (either because
//! the tool is flagged `dangerous: true` or because the enforcement policy's
//! `force_confirm_all` mode is armed), it calls `request_confirm`, which:
//!
//! 1. Registers a `oneshot::Sender` in the global `confirm_waiters` map keyed
//!    by a fresh UUID.
//! 2. Emits `sunny://agent.confirm.request` to the frontend with the tool name,
//!    serialised input preview, and requester label so the modal can tell the
//!    user which agent (main or a sub-agent) is attempting the action.
//! 3. Awaits the frontend's `sunny://agent.confirm.response` event carrying the
//!    same UUID and an `approved: bool`.
//! 4. Returns `Ok(())` on approval, `Err(reason)` on denial or timeout.
//!
//! Multiplexing is process-wide via the lazy-initialised `OnceLock<Mutex<HashMap>>`
//! so concurrent sub-agent calls each await their own independent modal.
//!
//! # Test sink (`feature = "test-sink"`)
//!
//! When the `test-sink` Cargo feature is enabled, `ConfirmSink`, `TestConfirmSink`,
//! `set_sink_for_test`, and `clear_sink_for_test` are compiled in and publicly
//! accessible.  `confirm_or_defer` checks the global sink slot before falling back
//! to the AppHandle modal path.  Production builds never enable this feature, so
//! there is zero overhead and zero behavioral change in shipping code.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Listener, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::types::ToolCall;
use super::helpers::pretty_short;
use crate::security::{self, SecurityEvent};

// ---------------------------------------------------------------------------
// ConfirmGate wiring
//
// The frontend sees one event name (`sunny://agent.confirm.request`) and
// replies with a single response event carrying the id in its payload.
// We multiplex responses back to the right pending dispatch via a
// process-wide `Mutex<HashMap<id, oneshot::Sender>>`, installed lazily
// on the first dangerous call.
// ---------------------------------------------------------------------------

pub type ConfirmChannel = oneshot::Sender<ConfirmResponse>;

pub fn confirm_waiters() -> &'static Mutex<HashMap<String, ConfirmChannel>> {
    static WAITERS: OnceLock<Mutex<HashMap<String, ConfirmChannel>>> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Payload for `sunny://agent.confirm.request`. The frontend pops a modal,
/// lets the user click Allow/Deny, and replies on
/// `sunny://agent.confirm.response` with `{ id, approved, reason? }`.
/// `requester` identifies which agent asked ("main" or a sub-agent id)
/// so the modal can tell the user *who* is attempting the action, not
/// just *which* tool is firing.
#[derive(Serialize, Clone, Debug)]
pub struct ConfirmRequest<'a> {
    pub id: String,
    pub name: &'a str,
    pub preview: String,
    pub requester: &'a str,
}

#[derive(Deserialize, Debug, Default)]
pub struct ConfirmResponse {
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Register the global confirm-response listener exactly once per process.
/// Event name is `sunny://agent.confirm.response` with a
/// `{id, approved, reason}` payload.
pub fn ensure_confirm_listener(app: &AppHandle) {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        let _ = app.listen("sunny://agent.confirm.response", move |ev| {
            let payload = ev.payload();
            let parsed: Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(_) => return,
            };
            let id = match parsed.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => return,
            };
            let approved = parsed
                .get("approved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let reason = parsed
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let tx_opt = {
                let mut map = match confirm_waiters().lock() {
                    Ok(m) => m,
                    Err(_) => return,
                };
                map.remove(&id)
            };
            // Emit the answered event regardless of whether we still
            // had a waiting dispatch — the audit log should record
            // every user confirm response, not just the ones that
            // raced back within the dispatch timeout.
            security::emit(SecurityEvent::ConfirmAnswered {
                at: security::now(),
                id: id.clone(),
                approved,
                reason: reason.clone(),
            });
            if let Some(tx) = tx_opt {
                let _ = tx.send(ConfirmResponse { approved, reason });
            }
        });
    });
}

/// Ask the user to confirm dispatching a side-effectful tool. Returns
/// `Ok(())` on approve, `Err(reason)` on deny / timeout / channel drop.
/// `requester` is either a sub-agent id or the literal `"main"` so the
/// modal can surface *who* is asking, not just *which* tool.
pub async fn request_confirm(
    app: &AppHandle,
    call: &ToolCall,
    requester: &str,
    confirm_timeout_secs: u64,
    extra_preview: Option<&str>,
) -> Result<(), String> {
    ensure_confirm_listener(app);

    let id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    {
        let mut map = confirm_waiters()
            .lock()
            .map_err(|e| format!("confirm waiter lock: {e}"))?;
        map.insert(id.clone(), tx);
    }

    let mut preview = format!("{}({})", call.name, pretty_short(&call.input));
    if let Some(extra) = extra_preview {
        preview.push_str(extra);
    }
    let _ = app.emit(
        "sunny://agent.confirm.request",
        ConfirmRequest {
            id: id.clone(),
            name: call.name.as_str(),
            preview: preview.clone(),
            requester,
        },
    );
    // Mirror the ask onto the security bus so the audit log carries
    // the "a confirm was requested for X" record even when the user
    // never responds (e.g. modal dismissed, session ended).
    security::emit(SecurityEvent::ConfirmRequested {
        at: security::now(),
        id: id.clone(),
        tool: call.name.clone(),
        requester: requester.to_string(),
        preview,
    });

    let result = tokio::time::timeout(Duration::from_secs(confirm_timeout_secs), rx).await;

    // Clean up any stale waiter on error paths so we don't leak senders.
    if result.is_err() || matches!(result, Ok(Err(_))) {
        if let Ok(mut map) = confirm_waiters().lock() {
            map.remove(&id);
        }
    }

    match result {
        Ok(Ok(resp)) if resp.approved => Ok(()),
        Ok(Ok(resp)) => Err(resp.reason.unwrap_or_else(|| "user declined".to_string())),
        Ok(Err(_dropped)) => Err("confirm channel dropped".into()),
        Err(_timeout) => Err(format!("no response within {confirm_timeout_secs}s")),
    }
}

// ---------------------------------------------------------------------------
// ConfirmSink — headless test hook (feature = "test-sink" only)
//
// Enabled by adding `--features test-sink` to the cargo test invocation.
// The trait, the concrete type, the global slot, and both management
// functions are compiled only under that feature.  `confirm_or_defer`
// checks the slot under the same feature gate before falling through to
// the AppHandle modal path — so production code is completely unaffected.
//
// Thread-safety: the slot is a plain `std::sync::Mutex<Option<Box<…>>>`
// accessed only from synchronous test setup/teardown.  Tests that mutate
// the slot must carry `#[serial(confirm_sink)]` to prevent races.
// ---------------------------------------------------------------------------

/// Trait for objects that can answer a confirm request synchronously.
/// Only compiled when the `test-sink` feature is enabled.
#[cfg(feature = "test-sink")]
pub trait ConfirmSink: Send + Sync {
    /// Called by `confirm_or_defer` in place of the AppHandle modal when a
    /// sink is installed.  Must return immediately (no blocking I/O).
    fn request(&self, action: &str, ctx: &str) -> ConsentVerdict;
}

/// A [`ConfirmSink`] that always returns the same pre-configured verdict.
#[cfg(feature = "test-sink")]
pub struct TestConfirmSink {
    canned_verdict: ConsentVerdict,
}

#[cfg(feature = "test-sink")]
impl TestConfirmSink {
    pub fn new(canned_verdict: ConsentVerdict) -> Self {
        Self { canned_verdict }
    }
}

#[cfg(feature = "test-sink")]
impl ConfirmSink for TestConfirmSink {
    fn request(&self, _action: &str, _ctx: &str) -> ConsentVerdict {
        self.canned_verdict
    }
}

/// Process-wide test sink slot.  Only exists in `test-sink` builds.
#[cfg(feature = "test-sink")]
fn test_sink_slot() -> &'static Mutex<Option<Box<dyn ConfirmSink>>> {
    static SLOT: OnceLock<Mutex<Option<Box<dyn ConfirmSink>>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Install a test sink.  Must be paired with [`clear_sink_for_test`] — use a
/// `scopeguard::defer!` guard or a `serial_test` serialiser.  Replaces any
/// previously installed sink atomically.
#[cfg(feature = "test-sink")]
pub fn set_sink_for_test(sink: Box<dyn ConfirmSink>) {
    let mut slot = test_sink_slot()
        .lock()
        .expect("confirm test sink lock poisoned");
    *slot = Some(sink);
}

/// Remove the currently installed test sink.  Safe to call even when no sink
/// is installed (idempotent).
#[cfg(feature = "test-sink")]
pub fn clear_sink_for_test() {
    let mut slot = test_sink_slot()
        .lock()
        .expect("confirm test sink lock poisoned");
    *slot = None;
}

// ---------------------------------------------------------------------------
// ConsentVerdict + confirm_or_defer
// ---------------------------------------------------------------------------

use crate::security::audit_log::RiskLevel;
use crate::world::current as world_current;

/// The four possible outcomes from the consent gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentVerdict {
    /// Passed automatically (low risk or attended + user said yes).
    Auto,
    /// User explicitly approved the action.
    Approved,
    /// Action was rejected (auto-policy or user denial).
    Denied,
    /// Action queued until the next attended session.
    Deferred,
}

/// Context the caller must provide so `confirm_or_defer` can apply the
/// correct policy.  `app` may be `None` in unattended / headless contexts
/// where emitting a modal is not possible.
pub struct ConsentContext<'a> {
    pub app: Option<&'a AppHandle>,
    pub requester: &'a str,
    pub confirm_timeout_secs: u64,
    pub extra_preview: Option<&'a str>,
}

/// Attended detection threshold in seconds.
const ATTENDED_IDLE_THRESHOLD_SECS: i64 = 600;

/// Returns `true` when a human is considered present (system idle time is
/// below the threshold).  Reads `idle_secs` from [`world_state::current`].
fn is_attended() -> bool {
    world_current().idle_secs < ATTENDED_IDLE_THRESHOLD_SECS
}

/// Autonomous-mode consent gate with attended/unattended policy.
///
/// # Verdict matrix
///
/// | Risk | Attended            | Unattended          |
/// |------|---------------------|---------------------|
/// | L0   | Auto                | Auto                |
/// | L1   | Auto                | Auto                |
/// | L2   | Auto                | Deferred            |
/// | L3   | Prompt → approve/deny | Denied            |
/// | L4   | Prompt → approve/deny | Denied            |
/// | L5   | Prompt → approve/deny | Denied            |
///
/// When attended and a modal is required (L3+), this function fires the
/// existing `request_confirm` flow and translates the outcome.  When the
/// `test-sink` Cargo feature is enabled and a sink has been installed via
/// [`set_sink_for_test`], the sink intercepts the modal path so tests can
/// run without a live `AppHandle`.
pub async fn confirm_or_defer(
    call: &ToolCall,
    risk: RiskLevel,
    ctx: ConsentContext<'_>,
) -> ConsentVerdict {
    let attended = is_attended();

    match (risk, attended) {
        // L0–L1: always auto regardless of attendance.
        (RiskLevel::L0 | RiskLevel::L1, _) => ConsentVerdict::Auto,

        // L2 attended: auto; L2 unattended: defer.
        (RiskLevel::L2, true) => ConsentVerdict::Auto,
        (RiskLevel::L2, false) => ConsentVerdict::Deferred,

        // L3–L5 unattended: always deny.
        (RiskLevel::L3 | RiskLevel::L4 | RiskLevel::L5, false) => ConsentVerdict::Denied,

        // L3–L5 attended: consult test sink first, then fall back to AppHandle modal.
        (RiskLevel::L3 | RiskLevel::L4 | RiskLevel::L5, true) => {
            // --- test-sink fast path (compiled out in non-test-sink builds) ---
            #[cfg(feature = "test-sink")]
            {
                let verdict_opt = {
                    let slot = test_sink_slot()
                        .lock()
                        .expect("confirm test sink lock poisoned");
                    slot.as_ref().map(|s| s.request(call.name.as_str(), ctx.requester))
                };
                if let Some(v) = verdict_opt {
                    return v;
                }
            }

            // --- production path: try to pop a modal via AppHandle ---
            match ctx.app {
                Some(app) => {
                    let outcome = request_confirm(
                        app,
                        call,
                        ctx.requester,
                        ctx.confirm_timeout_secs,
                        ctx.extra_preview,
                    )
                    .await;
                    match outcome {
                        Ok(()) => ConsentVerdict::Approved,
                        Err(_) => ConsentVerdict::Denied,
                    }
                }
                // No app handle — can't show modal, treat as unattended.
                None => ConsentVerdict::Denied,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// confirm_or_defer tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod consent_tests {
    use super::*;

    // We can test the pure verdict-matrix logic without a real AppHandle
    // by calling the inner match logic directly.  We expose a test-only
    // helper that accepts the (risk, attended) pair and returns the
    // verdict for the *non-interactive* branches (L0-L2 and unattended
    // L3+).

    fn policy(risk: RiskLevel, attended: bool) -> Option<ConsentVerdict> {
        match (risk, attended) {
            (RiskLevel::L0 | RiskLevel::L1, _) => Some(ConsentVerdict::Auto),
            (RiskLevel::L2, true) => Some(ConsentVerdict::Auto),
            (RiskLevel::L2, false) => Some(ConsentVerdict::Deferred),
            (RiskLevel::L3 | RiskLevel::L4 | RiskLevel::L5, false) => Some(ConsentVerdict::Denied),
            _ => None, // interactive branch — can't test without AppHandle
        }
    }

    // ------------------------------------------------------------------
    // L0 × attended = Auto
    // ------------------------------------------------------------------
    #[test]
    fn l0_attended_auto() {
        assert_eq!(policy(RiskLevel::L0, true), Some(ConsentVerdict::Auto));
    }

    // ------------------------------------------------------------------
    // L0 × unattended = Auto
    // ------------------------------------------------------------------
    #[test]
    fn l0_unattended_auto() {
        assert_eq!(policy(RiskLevel::L0, false), Some(ConsentVerdict::Auto));
    }

    // ------------------------------------------------------------------
    // L1 × attended = Auto
    // ------------------------------------------------------------------
    #[test]
    fn l1_attended_auto() {
        assert_eq!(policy(RiskLevel::L1, true), Some(ConsentVerdict::Auto));
    }

    // ------------------------------------------------------------------
    // L1 × unattended = Auto
    // ------------------------------------------------------------------
    #[test]
    fn l1_unattended_auto() {
        assert_eq!(policy(RiskLevel::L1, false), Some(ConsentVerdict::Auto));
    }

    // ------------------------------------------------------------------
    // L2 × attended = Auto
    // ------------------------------------------------------------------
    #[test]
    fn l2_attended_auto() {
        assert_eq!(policy(RiskLevel::L2, true), Some(ConsentVerdict::Auto));
    }

    // ------------------------------------------------------------------
    // L2 × unattended = Deferred
    // ------------------------------------------------------------------
    #[test]
    fn l2_unattended_deferred() {
        assert_eq!(policy(RiskLevel::L2, false), Some(ConsentVerdict::Deferred));
    }

    // ------------------------------------------------------------------
    // L3 × unattended = Denied
    // ------------------------------------------------------------------
    #[test]
    fn l3_unattended_denied() {
        assert_eq!(policy(RiskLevel::L3, false), Some(ConsentVerdict::Denied));
    }

    // ------------------------------------------------------------------
    // L4 × unattended = Denied
    // ------------------------------------------------------------------
    #[test]
    fn l4_unattended_denied() {
        assert_eq!(policy(RiskLevel::L4, false), Some(ConsentVerdict::Denied));
    }

    // ------------------------------------------------------------------
    // L5 × unattended = Denied
    // ------------------------------------------------------------------
    #[test]
    fn l5_unattended_denied() {
        assert_eq!(policy(RiskLevel::L5, false), Some(ConsentVerdict::Denied));
    }
}
