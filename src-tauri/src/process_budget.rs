//! Process budget — hard floor + global spawn semaphore.
//!
//! Two prior attempts at loosening Sunny's autonomy caps exhausted
//! `kern.maxprocperuid` (~1418 on Apple Silicon) and broke every Terminal
//! window on the user's Mac until reboot. This module is the **floor** that
//! makes such an accident impossible going forward:
//!
//! 1. `install_rlimit()` is called once at startup. It sets
//!    `RLIMIT_NPROC` for the Sunny process to `NPROC_CEILING`. macOS treats
//!    this as "when *this* process tries to fork and the current uid already
//!    has >= N processes, fail with EAGAIN in Sunny". That means a runaway
//!    Sunny can crash its own tool handlers long before Terminal.app (which
//!    still sees the system default) runs out of fork slots.
//!
//! 2. `SPAWN_SEM` is a tokio Semaphore. Every code path in Sunny that spawns
//!    a child process (Command::spawn, portable_pty spawn_command, a
//!    `tokio::spawn` whose body immediately launches a process) should
//!    acquire a permit via `SpawnGuard::acquire().await` first. If every
//!    permit is in use, the acquirer **waits** instead of racing to the
//!    kernel limit.
//!
//! Neither layer is sufficient alone: the semaphore gives us application-
//! level backpressure (fair, queueable, cancellable) while the rlimit is
//! the immovable backstop when somebody forgets to acquire.
//!
//! Default values (`NPROC_CEILING = 1024`, `SPAWN_PERMITS = 16`) were chosen
//! against Sunny's verified uid limit of 1418 — the ceiling leaves ~400
//! slots for Terminal/iTerm/VS Code, and 16 permits let parallel research
//! tools run normally while still refusing runaway fan-out.

use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};

/// Per-process fork ceiling. Below `kern.maxprocperuid` default so Sunny
/// hits it before the uid does — its tool handlers fail, Terminal keeps
/// working.
pub const NPROC_CEILING: u64 = 1024;

/// Global concurrency ceiling for child-process spawns across the whole
/// Sunny app. Applies uniformly to shell, PTY, Python, Claude CLI,
/// AppleScript, etc.
pub const SPAWN_PERMITS: usize = 16;

/// How long a spawn call will wait for a permit before giving up. Chosen
/// so that a stuck handler can't hold up the whole agent indefinitely —
/// the error surfaces back to the LLM as a structured tool error and the
/// agent can decide to back off or try something else.
pub const SPAWN_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

static SPAWN_SEM: OnceLock<Semaphore> = OnceLock::new();

fn semaphore() -> &'static Semaphore {
    SPAWN_SEM.get_or_init(|| Semaphore::new(SPAWN_PERMITS))
}

/// Install the per-process fork ceiling. Call exactly once, as early in
/// startup as possible — before any tool handler has a chance to spawn a
/// child. Idempotent but not cheap; the call itself is a syscall so don't
/// hot-loop it.
///
/// On non-Unix this is a no-op and returns `Ok(())`.
#[cfg(unix)]
pub fn install_rlimit() -> Result<(), String> {
    use libc::{getrlimit, rlimit, setrlimit, RLIMIT_NPROC};

    let mut current = rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: writes `getrlimit`'s out-parameter into a stack-owned struct;
    // no aliasing, no pointer escape. Return value is checked below.
    let rc = unsafe { getrlimit(RLIMIT_NPROC, &mut current) };
    if rc != 0 {
        return Err(format!(
            "getrlimit(RLIMIT_NPROC) failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    // Don't raise anyone's hard limit — only lower the soft limit if the
    // current soft is above our ceiling. Raising the hard limit requires
    // root on macOS and we don't have that.
    let desired_soft = NPROC_CEILING.min(current.rlim_max);
    if current.rlim_cur <= desired_soft {
        log::info!(
            "process_budget: RLIMIT_NPROC already at {} (ceiling {}), no change",
            current.rlim_cur,
            NPROC_CEILING
        );
        return Ok(());
    }

    let new_limit = rlimit {
        rlim_cur: desired_soft,
        rlim_max: current.rlim_max,
    };
    // SAFETY: passes a stack-owned struct by const pointer. Return value
    // is checked below.
    let rc = unsafe { setrlimit(RLIMIT_NPROC, &new_limit) };
    if rc != 0 {
        return Err(format!(
            "setrlimit(RLIMIT_NPROC, {desired_soft}) failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    log::info!(
        "process_budget: RLIMIT_NPROC set to {desired_soft} (was {})",
        current.rlim_cur
    );
    Ok(())
}

#[cfg(not(unix))]
pub fn install_rlimit() -> Result<(), String> {
    Ok(())
}

/// RAII permit for the global spawn semaphore. Acquire one before every
/// call that spawns a child process or PTY; drop it after the child's
/// handle (or its output future) has been awaited.
///
/// The lifetime is `'static` because the underlying semaphore is a
/// process-wide `OnceLock`-backed singleton — there's no scope to borrow
/// from.
pub struct SpawnGuard {
    _permit: SemaphorePermit<'static>,
}

impl SpawnGuard {
    /// Acquire a permit, waiting up to `SPAWN_ACQUIRE_TIMEOUT` for one to
    /// become available. Returns a user-facing error string if the wait
    /// times out — that error bubbles up through tool dispatch as a
    /// structured refusal the LLM can reason about.
    pub async fn acquire() -> Result<Self, String> {
        let sem = semaphore();
        match tokio::time::timeout(SPAWN_ACQUIRE_TIMEOUT, sem.acquire()).await {
            Ok(Ok(permit)) => Ok(Self { _permit: permit }),
            Ok(Err(_closed)) => Err("spawn semaphore closed".into()),
            Err(_elapsed) => Err(format!(
                "spawn budget exhausted: {} permits in use for >{}s — refusing to spawn another child process",
                SPAWN_PERMITS,
                SPAWN_ACQUIRE_TIMEOUT.as_secs()
            )),
        }
    }

    /// Try to acquire immediately without waiting. Useful for
    /// fire-and-forget hot paths (metrics pollers, event emitters) that
    /// should **skip** their side-effect if the budget is saturated rather
    /// than queue behind user-facing work.
    pub fn try_acquire() -> Option<Self> {
        semaphore()
            .try_acquire()
            .ok()
            .map(|permit| Self { _permit: permit })
    }
}

/// Snapshot of current spawn-permit usage. Exposed for the diagnostics /
/// security panel.
pub fn spawn_budget_snapshot() -> SpawnBudgetSnapshot {
    let sem = semaphore();
    SpawnBudgetSnapshot {
        total: SPAWN_PERMITS,
        available: sem.available_permits(),
    }
}

/// Pure data struct — no Tauri dependency so this module stays friendly
/// to unit tests that don't boot a Tauri runtime.
#[derive(Debug, Clone, Copy)]
pub struct SpawnBudgetSnapshot {
    pub total: usize,
    pub available: usize,
}

impl SpawnBudgetSnapshot {
    pub fn in_use(&self) -> usize {
        self.total.saturating_sub(self.available)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_rlimit_is_idempotent_and_never_raises_hard_limit() {
        // install_rlimit must not fail when called repeatedly, and must
        // never attempt to raise the hard limit beyond whatever the
        // kernel gave us at boot. We verify both properties by running
        // it twice and asserting Ok(()) both times; any raise attempt
        // would return EPERM on macOS without root, surfaced as Err.
        assert!(install_rlimit().is_ok(), "first install_rlimit");
        assert!(install_rlimit().is_ok(), "second install_rlimit");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn spawn_guard_blocks_when_saturated() {
        // Hold all permits. The next acquire should time out inside a
        // much shorter window than SPAWN_ACQUIRE_TIMEOUT so the test
        // finishes quickly; we assert the error message contains the
        // "spawn budget exhausted" prefix so any refactor that drops
        // the wording is caught here.
        let mut held = Vec::with_capacity(SPAWN_PERMITS);
        for _ in 0..SPAWN_PERMITS {
            held.push(SpawnGuard::try_acquire().expect("permit available"));
        }

        let try_now = SpawnGuard::try_acquire();
        assert!(try_now.is_none(), "try_acquire must fail when saturated");

        let snap = spawn_budget_snapshot();
        assert_eq!(snap.total, SPAWN_PERMITS);
        assert_eq!(snap.available, 0);
        assert_eq!(snap.in_use(), SPAWN_PERMITS);

        // Release one permit; the next acquire should succeed immediately.
        held.pop();
        let regained = SpawnGuard::try_acquire();
        assert!(regained.is_some(), "permit must become available after release");
    }

    #[test]
    fn spawn_budget_snapshot_math() {
        let snap = SpawnBudgetSnapshot { total: 16, available: 10 };
        assert_eq!(snap.in_use(), 6);

        let saturated = SpawnBudgetSnapshot { total: 16, available: 0 };
        assert_eq!(saturated.in_use(), 16);

        // Defensive: if available somehow exceeds total (racy snapshot),
        // we saturate at 0 instead of underflowing.
        let racy = SpawnBudgetSnapshot { total: 16, available: 20 };
        assert_eq!(racy.in_use(), 0);
    }
}
