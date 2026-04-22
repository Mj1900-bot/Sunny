//! # Session-scoped cache for expensive per-turn decisions.
//!
//! Three decisions were being re-run on every single turn of the ReAct
//! loop even though their answers don't change turn-to-turn within a
//! session:
//!
//! 1. **`pick_backend`** — keychain probes (anthropic / moonshot / zai
//!    key presence) cost 50-150 ms each on macOS.
//! 2. **`pick_model`** — for the Ollama backend this fires an HTTP probe
//!    to `http://localhost:11434/api/tags` with a 2000 ms timeout. On a
//!    warm session that's 2000 ms of pure waste every single turn.
//! 3. **`build_memory_digest`** — reads the semantic store + recent
//!    episodic rows and renders a bullet list. Up to ~500 ms on a
//!    populated vault.
//!
//! This module caches those three results per `session_id`. Main-agent
//! turns read through the cache; the first turn pays the compute, every
//! subsequent turn returns the cached value in microseconds.
//!
//! ## Sub-agent safety
//!
//! Sub-agents (`sub_id == Some(..)`) MUST NOT read from or write to
//! this cache. Two reasons:
//!
//! * A sub-agent's `session_id` may equal the parent's (the main-agent
//!   session is threaded into `spawn_subagent` so `memory_write` tools
//!   can invalidate the right entry). Sharing the backend/model/digest
//!   through the cache would leak the parent's routing decisions into
//!   a child that was explicitly asked to use a different model
//!   (`CRITIC_MODEL`, research-tier, etc.).
//! * Even when the ids differ, a sub-agent's compute is short-lived;
//!   caching it risks pinning a stale value past the sub-agent's exit.
//!
//! The call sites in `core.rs` gate on `ctx.is_main()` — this module
//! stays agnostic and trusts its callers.
//!
//! ## Invalidation model
//!
//! Backend and model are invalidated only via `invalidate_all` (for
//! "forget everything" style commands). Their inputs — `ChatRequest.
//! provider`, `ChatRequest.model`, and the keychain state — are stable
//! across a session.
//!
//! The memory digest is invalidated whenever a write lands in semantic
//! or episodic (`Note`/`Reflection` kind) storage. Write sites call
//! `invalidate_digest` (per-session) or `invalidate_all_digests`
//! (for UI-initiated writes that have no session_id). We do NOT
//! invalidate on conversation appends, perception events, tool-call
//! breadcrumbs, continuity upserts, or OCR notes — those don't feed
//! the digest shape.
//!
//! ## Memory bounds
//!
//! The cache map grows monotonically — one entry per distinct
//! `session_id` ever seen. Sessions are bounded in practice (~10s per
//! install: `main`, `voice`, `auto-<page>`, `daemon-<name>`) so no
//! eviction pass is worth the complexity today. Mirrors the session-
//! lock map policy.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};

use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::types::Backend;

/// Per-session cached decisions. All fields `None` means "never
/// computed for this session yet".
///
/// `digest_version` doubles as the "digest was ever computed" sentinel
/// so we can cache a `None` result without re-running the compute on
/// every subsequent turn. It is reset to `0` on invalidation so the
/// next `get_digest_or_compute` call sees a miss.
#[derive(Debug, Default)]
pub struct SessionCache {
    pub backend: Option<Backend>,
    pub model: Option<String>,
    pub digest: Option<String>,
    pub digest_version: u32,
}

/// Map of `session_id -> Arc<Mutex<SessionCache>>`.
///
/// The outer `std::sync::Mutex` is held only long enough to look up or
/// insert an entry — NEVER across an `.await`. The inner
/// `tokio::sync::Mutex` is what actually guards the cache cell; it's
/// async so holders can `.await` (memory-digest build, keychain probe)
/// while holding it.
static SESSION_CACHES: Lazy<StdMutex<HashMap<String, Arc<Mutex<SessionCache>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

/// Look up (or lazily create) the cache cell for `session_id`.
///
/// Returns a cloned `Arc` — the caller is responsible for taking the
/// inner lock. The outer map lock is released before this function
/// returns so the caller's subsequent `.await` on the inner mutex is
/// safe (holding a std lock across an await would risk deadlocks when
/// tokio moves the task between workers).
pub fn get_or_init(session_id: &str) -> Arc<Mutex<SessionCache>> {
    let mut map = SESSION_CACHES
        .lock()
        .expect("SESSION_CACHES poisoned — another thread panicked while holding it");
    map.entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(SessionCache::default())))
        .clone()
}

/// Return the cached backend for `session_id`, or compute-and-cache.
///
/// `compute` is only awaited on a cache miss. Errors propagate — a
/// failed compute does not poison the cache entry (it remains `None`
/// so the next call will retry).
pub async fn get_backend_or_compute<F, Fut>(
    session_id: &str,
    compute: F,
) -> Result<Backend, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Backend, String>>,
{
    let cell = get_or_init(session_id);
    let mut guard = cell.lock().await;
    if let Some(b) = guard.backend {
        return Ok(b);
    }
    // Compute while holding the per-session lock. The
    // session-serialization lock in `session_lock.rs` already ensures
    // only one turn per session runs at a time, so this extra hold is
    // effectively free on the hot path.
    let backend = compute().await?;
    guard.backend = Some(backend);
    Ok(backend)
}

/// Return the cached model string for `session_id`/`backend`, or
/// compute-and-cache.
///
/// `backend` is part of the effective key: if a caller ever switches
/// backends mid-session (provider override), the cached model for the
/// previous backend is discarded and the new one is computed. In
/// practice `pick_backend` is cached above so this branch rarely fires.
pub async fn get_model_or_compute<F, Fut>(
    session_id: &str,
    backend: Backend,
    compute: F,
) -> String
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = String>,
{
    let cell = get_or_init(session_id);
    let mut guard = cell.lock().await;

    // If the backend flipped since we last computed the model, the
    // cached string is for the wrong provider — drop it.
    let cached_backend_matches = guard.backend == Some(backend);
    if cached_backend_matches {
        if let Some(m) = guard.model.as_ref() {
            return m.clone();
        }
    } else {
        guard.model = None;
    }

    let model = compute().await;
    guard.model = Some(model.clone());
    // Record the backend too so later `get_model_or_compute` calls can
    // detect a backend switch even if `get_backend_or_compute` wasn't
    // called first (defensive — in practice core.rs always calls
    // backend before model).
    guard.backend = Some(backend);
    model
}

/// Return the cached memory digest for `session_id`, or compute-and-
/// cache. `None` is a valid cached value (no digest material) — we do
/// NOT recompute on subsequent calls.
///
/// The sentinel for "never computed" is `digest_version == 0`.
/// After the first compute the version is `>= 1` regardless of whether
/// the digest itself was `Some` or `None`.
pub async fn get_digest_or_compute<F, Fut>(
    session_id: &str,
    compute: F,
) -> Option<String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let cell = get_or_init(session_id);
    let mut guard = cell.lock().await;

    if guard.digest_version > 0 {
        return guard.digest.clone();
    }

    let digest = compute().await;
    guard.digest = digest.clone();
    guard.digest_version = guard.digest_version.saturating_add(1).max(1);
    digest
}

/// Invalidate the cached digest for one session. Called after any
/// semantic/note write that could plausibly change the next digest.
///
/// Cheap — takes the inner mutex, clears the digest, and resets the
/// version so the next `get_digest_or_compute` recomputes.
pub async fn invalidate_digest(session_id: &str) {
    let cell = get_or_init(session_id);
    let mut guard = cell.lock().await;
    guard.digest = None;
    guard.digest_version = 0;
}

/// Invalidate cached digests across ALL sessions. Used by UI-initiated
/// writes (Tauri commands from the memory panel) that have no session
/// context — we don't know which session's digest the user's next turn
/// will draw from, so we conservatively clear everything.
///
/// The backend/model cache is NOT cleared — those don't depend on
/// memory state. This keeps the 2000 ms Ollama probe win intact even
/// after a UI edit.
pub async fn invalidate_all_digests() {
    let cells: Vec<Arc<Mutex<SessionCache>>> = {
        let map = SESSION_CACHES
            .lock()
            .expect("SESSION_CACHES poisoned");
        map.values().cloned().collect()
    };
    for cell in cells {
        let mut guard = cell.lock().await;
        guard.digest = None;
        guard.digest_version = 0;
    }
}

/// Blow away every cached field for `session_id`. Used by "forget
/// everything" style commands — a fresh turn will re-run backend
/// routing, model pick, and digest build from scratch.
pub async fn invalidate_all(session_id: &str) {
    let cell = get_or_init(session_id);
    let mut guard = cell.lock().await;
    guard.backend = None;
    guard.model = None;
    guard.digest = None;
    guard.digest_version = 0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn backend_computed_once_then_cached() {
        let calls = Arc::new(AtomicU32::new(0));
        let sid = "test-backend-once";
        // Ensure a clean slate in case another test polluted the map.
        invalidate_all(sid).await;

        let c1 = calls.clone();
        let b1 = get_backend_or_compute(sid, || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Ollama)
        })
        .await
        .unwrap();

        let c2 = calls.clone();
        let b2 = get_backend_or_compute(sid, || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Anthropic) // would-be new value
        })
        .await
        .unwrap();

        assert_eq!(b1, Backend::Ollama);
        assert_eq!(b2, Backend::Ollama, "cached value must win");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "compute ran once");
    }

    #[tokio::test]
    async fn digest_none_is_cached() {
        let calls = Arc::new(AtomicU32::new(0));
        let sid = "test-digest-none";
        invalidate_all(sid).await;

        let c1 = calls.clone();
        let d1 = get_digest_or_compute(sid, || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            Option::<String>::None
        })
        .await;

        let c2 = calls.clone();
        let d2 = get_digest_or_compute(sid, || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            Some("should-not-be-used".to_string())
        })
        .await;

        assert!(d1.is_none());
        assert!(d2.is_none(), "cached None must win — no recompute");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidate_digest_forces_recompute() {
        let calls = Arc::new(AtomicU32::new(0));
        let sid = "test-digest-invalidate";
        invalidate_all(sid).await;

        let c1 = calls.clone();
        let _ = get_digest_or_compute(sid, || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            Some("v1".to_string())
        })
        .await;

        invalidate_digest(sid).await;

        let c2 = calls.clone();
        let d2 = get_digest_or_compute(sid, || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            Some("v2".to_string())
        })
        .await;

        assert_eq!(d2.as_deref(), Some("v2"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn model_recomputes_on_backend_switch() {
        let calls = Arc::new(AtomicU32::new(0));
        let sid = "test-model-backend-switch";
        invalidate_all(sid).await;

        let c1 = calls.clone();
        let m1 = get_model_or_compute(sid, Backend::Ollama, || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            "llama3:8b".to_string()
        })
        .await;

        let c2 = calls.clone();
        let m2 = get_model_or_compute(sid, Backend::Anthropic, || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            "claude-sonnet".to_string()
        })
        .await;

        assert_eq!(m1, "llama3:8b");
        assert_eq!(m2, "claude-sonnet");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidate_all_digests_clears_every_session() {
        let sid_a = "test-invalidate-all-a";
        let sid_b = "test-invalidate-all-b";
        invalidate_all(sid_a).await;
        invalidate_all(sid_b).await;

        let _ = get_digest_or_compute(sid_a, || async { Some("a".to_string()) }).await;
        let _ = get_digest_or_compute(sid_b, || async { Some("b".to_string()) }).await;

        invalidate_all_digests().await;

        let calls = Arc::new(AtomicU32::new(0));
        let c1 = calls.clone();
        let _ = get_digest_or_compute(sid_a, || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            Some("a2".to_string())
        })
        .await;
        let c2 = calls.clone();
        let _ = get_digest_or_compute(sid_b, || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            Some("b2".to_string())
        })
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 2, "both sessions recomputed");
    }
}
