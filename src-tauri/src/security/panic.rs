//! Panic / kill-switch.
//!
//! When the user hits PANIC (from the nav strip, the Security
//! Overview tab, or the hotkey `!`), we do four things:
//!
//! 1. Flip the `panic_flag` so `dispatch_tool` and `http::send()` start
//!    short-circuiting.
//! 2. Disable every daemon in `~/.sunny/daemons.json` so periodic goals
//!    stop firing.
//! 3. Emit a `SecurityEvent::Panic` so the UI + audit log record it.
//! 4. Return a summary of what we stopped so the frontend can tell the
//!    user.
//!
//! Release is a second-step operation (`security_panic_reset`) — we
//! intentionally don't auto-release on timeout, because the whole
//! point of the button is to trust nothing until the user explicitly
//! resumes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::SecurityEvent;

/// Snapshot of what the panic call stopped, returned to the frontend
/// so we can render a confirmation toast.
#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct PanicReport {
    pub already_active: bool,
    #[ts(type = "number")]
    pub daemons_disabled: usize,
    pub note: String,
}

/// Engage panic mode.
pub fn engage(reason: String) -> PanicReport {
    if super::panic_mode() {
        return PanicReport {
            already_active: true,
            daemons_disabled: 0,
            note: "panic mode was already engaged".into(),
        };
    }
    super::set_panic_mode(true);

    // Stop every daemon. We deliberately don't delete them — the user
    // keeps their configuration, we just flip `enabled=false` on each
    // so the frontend runtime stops polling them.
    let daemons_disabled = match crate::daemons::disable_all() {
        Ok(n) => n,
        Err(e) => {
            log::warn!("security: panic disable_all failed: {e}");
            0
        }
    };

    super::emit(SecurityEvent::Panic {
        at: super::now(),
        reason: reason.clone(),
    });

    // Spawn the forensic capture in the background so `engage()`
    // returns quickly (the user just hit PANIC, we shouldn't make
    // them wait for file IO).  The bundle includes events that
    // landed before this line, plus the Panic event itself once the
    // ring flushes through.
    let reason_for_bundle = reason.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(path) = super::incident::capture(&reason_for_bundle).await {
            super::emit(SecurityEvent::Notice {
                at: super::now(),
                source: "incident".into(),
                message: format!("captured bundle at {}", path.display()),
                severity: super::Severity::Warn,
            });
        }
    });

    PanicReport {
        already_active: false,
        daemons_disabled,
        note: format!("reason: {reason}"),
    }
}

/// Release panic mode. Does not auto-re-enable daemons — the user
/// flips those back on deliberately from the AUTO page.
pub fn release(by: String) -> PanicReport {
    if !super::panic_mode() {
        return PanicReport {
            already_active: false,
            daemons_disabled: 0,
            note: "panic mode was not active".into(),
        };
    }
    super::set_panic_mode(false);
    super::emit(SecurityEvent::PanicReset {
        at: super::now(),
        by,
    });
    PanicReport {
        already_active: false,
        daemons_disabled: 0,
        note: "panic released — re-enable daemons from AUTO if desired".into(),
    }
}

