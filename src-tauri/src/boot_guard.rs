//! Boot guard — quarantines daemons when Sunny exited abnormally.
//!
//! The problem this solves: Sunny's `~/.sunny/daemons.json` persists
//! user-installed agent daemons across restarts. If a daemon (or a chain
//! of them) was the *cause* of a Sunny crash — process-budget exhaustion,
//! a panic inside a tool handler, a fork-bomb pattern — then the next
//! boot would replay exactly the same runaway. That's how one of Sunny's
//! prior fork-bomb incidents escalated: Sunny restarted, the same
//! schedule_recurring daemon fired, spawn fanout repeated.
//!
//! How it works:
//!
//! 1. `arm()` is called at startup, right after `process_budget::install_rlimit`.
//!    It checks for a marker file at `~/.sunny/booting.marker`.
//!    - If the marker **exists**, the previous session did not reach a
//!      clean shutdown. Report `BootState::Quarantine` so callers know
//!      to boot with daemons disabled.
//!    - If the marker **does not exist**, the previous session exited
//!      cleanly (or there was no previous session). Report
//!      `BootState::Clean`.
//!   In both cases, arm() writes a fresh marker before returning.
//!
//! 2. `disarm()` is called in the exit hook (Tauri `RunEvent::ExitRequested`
//!    or `RunEvent::Exit`). It removes the marker, so the **next** boot
//!    sees a clean slate.
//!
//! The marker is deliberately in `~/.sunny/` alongside `daemons.json` so
//! `disable_all` is a cheap two-file operation and so users can see the
//! quarantine state in Finder.

use std::fs;
use std::path::PathBuf;

const MARKER_NAME: &str = "booting.marker";
const DIR_NAME: &str = ".sunny";

/// Outcome of the boot check. Callers downstream decide what to do; this
/// module only detects the state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootState {
    /// Prior session exited cleanly (or no prior session). Load daemons
    /// normally and honour their `enabled` flags.
    Clean,
    /// Prior session crashed or was killed. Load daemons but force
    /// `enabled = false` on every one of them before returning to
    /// prevent a crash-loop replay. User re-enables explicitly from the
    /// HUD once they've understood what happened.
    Quarantine,
}

fn sunny_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(DIR_NAME))
}

/// Check whether the previous run exited cleanly, then write a fresh
/// marker so *this* run's exit will be observable by the next one.
///
/// Must be called exactly once, early in startup (after
/// `process_budget::install_rlimit`, before any code that reads
/// `daemons.json`).
pub fn arm() -> Result<BootState, String> {
    arm_in(&sunny_dir()?)
}

/// Same as `arm` but against a caller-supplied directory. Exists so the
/// unit tests don't touch `~/.sunny`.
pub fn arm_in(dir: &std::path::Path) -> Result<BootState, String> {
    fs::create_dir_all(dir).map_err(|e| format!("create sunny dir: {e}"))?;
    let marker = dir.join(MARKER_NAME);
    let state = if marker.exists() {
        BootState::Quarantine
    } else {
        BootState::Clean
    };
    // Write a fresh marker whether we're quarantining or not — this
    // run's exit is the one that needs to be observable next time.
    fs::write(
        &marker,
        format!(
            "pid={} booted_at={}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        ),
    )
    .map_err(|e| format!("write boot marker: {e}"))?;
    Ok(state)
}

/// Remove the marker, signalling that this session exited cleanly. Call
/// from the Tauri exit handler. Missing marker is not an error — if arm
/// never ran we still want disarm to be a no-op success.
pub fn disarm() -> Result<(), String> {
    disarm_in(&sunny_dir()?)
}

pub fn disarm_in(dir: &std::path::Path) -> Result<(), String> {
    let marker = dir.join(MARKER_NAME);
    match fs::remove_file(&marker) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove boot marker: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "sunny-bootguard-{tag}-{pid}-{nanos}-{seq}",
            pid = std::process::id()
        ));
        fs::create_dir_all(&p).expect("mk scratch");
        p
    }

    #[test]
    fn first_boot_is_clean_and_leaves_marker() {
        let dir = scratch("first");
        let state = arm_in(&dir).expect("arm");
        assert_eq!(state, BootState::Clean);
        assert!(dir.join(MARKER_NAME).exists(), "marker left for next boot");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn boot_after_clean_exit_is_clean() {
        let dir = scratch("clean-exit");
        // Simulate a full previous session: arm -> disarm.
        assert_eq!(arm_in(&dir).unwrap(), BootState::Clean);
        disarm_in(&dir).expect("disarm");
        assert!(!dir.join(MARKER_NAME).exists(), "disarm removes marker");

        // Next boot sees no marker -> Clean again.
        assert_eq!(arm_in(&dir).unwrap(), BootState::Clean);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn boot_after_crash_is_quarantine() {
        let dir = scratch("crash");
        // Session 1: arm but never disarm (crash).
        assert_eq!(arm_in(&dir).unwrap(), BootState::Clean);
        // Marker is still there — simulates crash (no disarm).

        // Session 2: marker present -> Quarantine. arm still writes
        // a fresh marker so session 3 can observe session 2's exit.
        assert_eq!(arm_in(&dir).unwrap(), BootState::Quarantine);
        assert!(dir.join(MARKER_NAME).exists(), "marker refreshed for next boot");

        // Disarm cleanly; next boot should be back to Clean.
        disarm_in(&dir).expect("disarm");
        assert_eq!(arm_in(&dir).unwrap(), BootState::Clean);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disarm_without_marker_is_ok() {
        let dir = scratch("no-marker");
        // Never armed in this dir — disarm must be a no-op success so
        // the Tauri exit hook can call it unconditionally.
        disarm_in(&dir).expect("disarm with no marker should succeed");
        fs::remove_dir_all(&dir).ok();
    }
}
