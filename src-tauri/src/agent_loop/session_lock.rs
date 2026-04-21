//! # Per-session serialization lock
//!
//! Two concurrent invocations of [`super::core::agent_run_inner`] on
//! the same `session_id` (e.g. a voice turn + an AUTO page refresh +
//! a daemon all firing on top of each other) would otherwise race on
//! the persisted conversation tail:
//!
//! 1. Both read the SAME tail via `memory::conversation::tail`.
//! 2. Both call the LLM on identical, stale context — neither sees
//!    the other's user message.
//! 3. Both append `[user, assistant]` sequentially, producing an
//!    interleaved thread `[..., U1, R1, U2, R2]` where R1 didn't know
//!    U2 was coming and R2 didn't know U1 happened.
//!
//! The correct semantic is: **turns on the same session_id serialize**.
//! There's no meaningful way two LLM turns can run concurrently on the
//! same conversation thread.
//!
//! ## How this module solves it
//!
//! One `tokio::sync::Mutex<()>` per `session_id`, held from BEFORE
//! the tail replay through AFTER both `conversation::append` calls.
//! The guard lives on `LoopCtx` so it drops on scope exit —
//! panic-safe via the `AssertUnwindSafe` wrap at `agent_run`.
//!
//! ## Who takes the lock
//!
//! * **Main agent** (depth 0) with a `session_id` → yes.
//! * **Sub-agents** (depth > 0) → no. Sub-agents either run on a
//!   different `session_id` (`sub-<uuid>`, set in `spawn_subagent`) or
//!   are called while the parent already holds the lock. Taking the
//!   lock here would deadlock the nested call.
//! * **Legacy callers with `session_id = None`** → no. There's no
//!   shared state to protect when nothing will be persisted.
//!
//! ## Memory
//!
//! The lock map grows monotonically — one `Arc<Mutex<()>>` per
//! distinct `session_id` ever seen. In practice session ids are
//! bounded (~10s per install: `main`, `voice`, `auto-<page>`,
//! `daemon-<name>`) so no cleanup pass is worth the complexity. If
//! this ever becomes a problem a `weak_table`-style eviction of
//! unused entries would be the fix.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::sync::atomic::{AtomicU64, Ordering};

use once_cell::sync::Lazy;
use tokio::sync::{Mutex, OwnedMutexGuard};

/// Map of `session_id → serialization mutex`. Entries are created
/// lazily on first lookup and never removed (see module docs).
///
/// The outer `std::sync::Mutex` is held only long enough to look up
/// or insert an `Arc<Mutex<()>>` — never across an `.await`. The
/// inner `tokio::sync::Mutex` is what actually serialises turns; it
/// is an async mutex so holders can `.await` (LLM calls, tool
/// dispatch) while holding it.
static SESSION_LOCKS: Lazy<StdMutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

/// Diagnostics-only: cumulative count of `acquire()` calls across the
/// process. A single session that's held through N turns will contribute
/// N. Never reset. The Diagnostics page reads this via [`snapshot`] to
/// show lock pressure.
static ACQUIRE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Acquire (or wait for) the serialization lock for `session_id`.
///
/// Returns an [`OwnedMutexGuard`] suitable for storing on `LoopCtx`
/// for the duration of a turn. Dropping the guard releases the lock —
/// this is panic-safe as long as the caller's future is wrapped in
/// `AssertUnwindSafe` (which `agent_run` already does).
///
/// If another turn is currently running on the same `session_id`, this
/// call **waits** for it to finish. It does **not** bounce the caller.
pub async fn acquire(session_id: &str) -> OwnedMutexGuard<()> {
    ACQUIRE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mutex = {
        // Scope-bound so we drop the std lock before the .await below.
        // Holding a std Mutex across an await is a deadlock waiting to
        // happen — tokio tasks can be moved between threads.
        let mut map = SESSION_LOCKS
            .lock()
            .expect("SESSION_LOCKS poisoned — another thread panicked while holding it");
        map.entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    mutex.lock_owned().await
}

/// Snapshot of session-lock pressure, exposed to the Diagnostics page.
///
/// Each entry is a `(session_id, holders_in_flight)` pair. A session
/// appears in the list exactly when its mutex has been created (first
/// acquire). `holders_in_flight` is `1` if a guard is currently held
/// (the lock is contended or in use), `0` if the entry exists but is
/// idle. We infer this from `Arc::strong_count`: the map owns one
/// Arc; every live `OwnedMutexGuard` holds another. So strong_count
/// minus one approximates live holders — it's a lower bound, accurate
/// on the hot path and off by one only during the brief window where
/// `clone()` has happened but `lock_owned` has not yet returned.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LockSnapshot {
    /// Session ids currently tracked in the lock map (one entry per
    /// distinct session_id ever seen).
    pub sessions: Vec<LockEntry>,
    /// Process-wide cumulative `acquire()` count.
    pub total_acquires: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LockEntry {
    pub session_id: String,
    /// Approximate count of live `OwnedMutexGuard` instances on this
    /// session's mutex. 0 = idle, ≥1 = contended/in-use.
    pub holders: usize,
}

/// Best-effort snapshot of the session-lock map. Never blocks for more
/// than a std-mutex acquire; safe to call from Tauri command handlers.
pub fn snapshot() -> LockSnapshot {
    let map = match SESSION_LOCKS.lock() {
        Ok(m) => m,
        Err(_) => {
            return LockSnapshot {
                sessions: Vec::new(),
                total_acquires: ACQUIRE_COUNTER.load(Ordering::Relaxed),
            };
        }
    };
    let sessions = map
        .iter()
        .map(|(id, arc)| LockEntry {
            session_id: id.clone(),
            holders: Arc::strong_count(arc).saturating_sub(1),
        })
        .collect();
    LockSnapshot {
        sessions,
        total_acquires: ACQUIRE_COUNTER.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;
    use tokio::time::sleep;

    /// Two tasks on the SAME session serialize — the second must wait
    /// for the first to release before entering the critical section.
    #[tokio::test]
    async fn same_session_serializes() {
        let counter = Arc::new(AtomicU32::new(0));
        let order = Arc::new(StdMutex::new(Vec::<u32>::new()));

        let c1 = counter.clone();
        let o1 = order.clone();
        let t1 = tokio::spawn(async move {
            let _guard = acquire("race-test-session").await;
            let n = c1.fetch_add(1, Ordering::SeqCst);
            o1.lock().unwrap().push(n);
            // Hold the lock long enough that t2, if it raced, would
            // interleave its increment before we release.
            sleep(Duration::from_millis(100)).await;
            let m = c1.fetch_add(1, Ordering::SeqCst);
            o1.lock().unwrap().push(m);
        });

        // Give t1 a head start so it definitely holds the lock before
        // t2 tries to take it.
        sleep(Duration::from_millis(10)).await;

        let c2 = counter.clone();
        let o2 = order.clone();
        let t2 = tokio::spawn(async move {
            let _guard = acquire("race-test-session").await;
            let n = c2.fetch_add(1, Ordering::SeqCst);
            o2.lock().unwrap().push(n);
            let m = c2.fetch_add(1, Ordering::SeqCst);
            o2.lock().unwrap().push(m);
        });

        t1.await.unwrap();
        t2.await.unwrap();

        // If serialization worked, t1's two increments finish before
        // t2's two increments start: [0, 1, 2, 3].
        let recorded = order.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![0, 1, 2, 3],
            "expected serialized order, got interleaved: {recorded:?}",
        );
    }

    /// Two tasks on DIFFERENT sessions run in parallel — no
    /// serialization between unrelated session ids.
    #[tokio::test]
    async fn different_sessions_run_concurrently() {
        let start = std::time::Instant::now();

        let t1 = tokio::spawn(async {
            let _guard = acquire("session-A").await;
            sleep(Duration::from_millis(100)).await;
        });
        let t2 = tokio::spawn(async {
            let _guard = acquire("session-B").await;
            sleep(Duration::from_millis(100)).await;
        });

        t1.await.unwrap();
        t2.await.unwrap();

        // Parallel execution: total wall clock well under 2× the
        // sleep. Serialized would be ≥ 200 ms; parallel is ~100 ms.
        assert!(
            start.elapsed() < Duration::from_millis(180),
            "different sessions serialized unexpectedly (elapsed: {:?})",
            start.elapsed(),
        );
    }

    /// Dropping the guard releases the lock so the next waiter can
    /// proceed. Sanity check that `OwnedMutexGuard` behaves as
    /// expected on scope exit.
    #[tokio::test]
    async fn lock_releases_on_guard_drop() {
        {
            let _guard = acquire("drop-test-session").await;
        }
        // If the guard didn't release, this acquire would hang forever —
        // the test timeout would trip. We additionally wrap in a
        // timeout so failure surfaces as a clear assertion, not a
        // stalled test run.
        let acquired = tokio::time::timeout(
            Duration::from_millis(500),
            acquire("drop-test-session"),
        )
        .await;
        assert!(
            acquired.is_ok(),
            "guard did not release on drop — second acquire timed out",
        );
    }
}
