//! Session-level L3 risk gate for sandbox tools.
//!
//! The first `sandbox_*` invocation in a session requires explicit user
//! confirmation.  Subsequent invocations within a 5-minute window are
//! auto-approved (the user already signalled intent to run code).
//!
//! The ledger is process-wide and intentionally simple: a `Mutex<HashMap>`
//! keyed by `session_id` → last-approved `Instant`.  No persistence across
//! app restarts — that is the correct UX: every new Sunny session starts with
//! a clean slate.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

/// Time window inside which a second sandbox invocation is auto-approved.
const AUTO_APPROVE_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Global ledger: session_id → last approved timestamp.
static LEDGER: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Result of a gate check.
#[derive(Debug, PartialEq, Eq)]
pub enum GateVerdict {
    /// First call in the window — caller must surface a user confirmation
    /// modal before proceeding.
    ConfirmRequired,
    /// A prior approval exists within the 5-minute window.
    AutoApproved,
}

/// Check whether `session_id` needs a confirmation dialog.
///
/// Does NOT record an approval; call [`record_approval`] after the user
/// clicks Allow so the timer resets from the confirmed moment.
pub fn check(session_id: &str) -> GateVerdict {
    let ledger = LEDGER.lock().expect("session_gate ledger poisoned");
    match ledger.get(session_id) {
        Some(ts) if ts.elapsed() < AUTO_APPROVE_WINDOW => GateVerdict::AutoApproved,
        _ => GateVerdict::ConfirmRequired,
    }
}

/// Record that the user approved a sandbox invocation for `session_id`.
/// Resets the 5-minute auto-approve window.
pub fn record_approval(session_id: &str) {
    let mut ledger = LEDGER.lock().expect("session_gate ledger poisoned");
    ledger.insert(session_id.to_string(), Instant::now());
}

/// Expire a session's approval (e.g. on explicit user deny or session end).
pub fn revoke(session_id: &str) {
    let mut ledger = LEDGER.lock().expect("session_gate ledger poisoned");
    ledger.remove(session_id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_session() -> String {
        format!("test-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn first_invocation_requires_confirm() {
        let sid = unique_session();
        assert_eq!(check(&sid), GateVerdict::ConfirmRequired);
    }

    #[test]
    fn after_approval_auto_approved() {
        let sid = unique_session();
        record_approval(&sid);
        assert_eq!(check(&sid), GateVerdict::AutoApproved);
    }

    #[test]
    fn revoke_resets_to_confirm_required() {
        let sid = unique_session();
        record_approval(&sid);
        revoke(&sid);
        assert_eq!(check(&sid), GateVerdict::ConfirmRequired);
    }

    #[test]
    fn independent_sessions_dont_share_approval() {
        let sid_a = unique_session();
        let sid_b = unique_session();
        record_approval(&sid_a);
        assert_eq!(check(&sid_a), GateVerdict::AutoApproved);
        assert_eq!(check(&sid_b), GateVerdict::ConfirmRequired);
    }
}
