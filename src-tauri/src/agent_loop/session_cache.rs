//! # Session-scoped cache for expensive per-turn decisions.
//!
//! Two decisions were being re-run on every single turn of the ReAct
//! loop even though their answers don't change turn-to-turn within a
//! session:
//!
//! 1. **`pick_backend`** — keychain probes (anthropic / moonshot / zai
//!    key presence) cost 50-150 ms each on macOS.
//! 2. **`pick_model`** — for the Ollama backend this fires an HTTP probe
//!    to `http://localhost:11434/api/tags` with a 2000 ms timeout. On a
//!    warm session that's 2000 ms of pure waste every single turn.
//!
//! This module caches those two results per `session_id`. Main-agent
//! turns read through the cache; the first turn pays the compute, every
//! subsequent turn returns the cached value in microseconds.
//!
//! `build_memory_digest` was cached here in an earlier iteration but
//! removed because the digest embeds live world state (focus / activity
//! / battery), a history-keyed recent-conversation block, and
//! goal-weighted semantic FTS results — all of which legitimately
//! change turn-to-turn. The build is FTS-only (~5-10 ms typical,
//! 500 ms timeout-bounded worst case) so running it every turn is
//! cheap enough that correctness wins.
//!
//! ## Sub-agent safety
//!
//! Sub-agents (`sub_id == Some(..)`) MUST NOT read from or write to
//! this cache. Two reasons:
//!
//! * A sub-agent's `session_id` may equal the parent's (the main-agent
//!   session is threaded into `spawn_subagent`). Sharing the backend
//!   and model through the cache would leak the parent's routing
//!   decisions into a child that was explicitly asked to use a
//!   different model (`CRITIC_MODEL`, research-tier, etc.).
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
//! across a session (the provider pin is part of the cache key, so a
//! mid-session flip lands on a fresh entry rather than reusing a stale
//! one).
//!
//! ## Memory bounds
//!
//! The cache map grows monotonically — one entry per distinct
//! `(session_id, provider_pin)` pair ever seen. Sessions are bounded in
//! practice (~10s per install: `main`, `voice`, `auto-<page>`,
//! `daemon-<name>`) and the provider pin is a small fixed vocabulary
//! ({"auto", "anthropic", "ollama", "glm", "kimi"}) so the composite is
//! still bounded. Mirrors the session-lock map policy.
//!
//! ## Why key on provider instead of gating on heuristic route
//!
//! An earlier iteration skipped the cache entirely whenever the caller
//! supplied an explicit provider override — `pick_backend` and
//! `pick_model` (and the keychain probes inside `pick_backend`) ran
//! every turn. That re-paid 50-150 ms of keychain subprocess on every
//! turn for any user with a pinned provider in Settings. Including the
//! provider pin in the key gives pinned users the same "compute once
//! per session" behaviour as heuristic callers, while keeping
//! mid-session provider flips correct: a flip produces a fresh cache
//! entry (`"auto"` ≠ `"glm"` ≠ `"ollama"`) so the new turn recomputes
//! from scratch instead of reusing a stale value for the wrong provider.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use super::types::Backend;

// Process-cumulative hit/miss counters. Relaxed ordering is fine — we
// only use these for rough telemetry logs at turn end; stale reads
// across cores are acceptable.
static BACKEND_HITS: AtomicU64 = AtomicU64::new(0);
static BACKEND_MISSES: AtomicU64 = AtomicU64::new(0);
static MODEL_HITS: AtomicU64 = AtomicU64::new(0);
static MODEL_MISSES: AtomicU64 = AtomicU64::new(0);

/// Cumulative cache hit/miss counts since process start. Read at turn
/// end in `complete_main_turn` for the latency telemetry log line —
/// users eyeball turn-to-turn deltas to see if the cache is healthy.
#[derive(Debug, Clone, Copy, Default)]
pub struct CacheStats {
    pub backend_hits: u64,
    pub backend_misses: u64,
    pub model_hits: u64,
    pub model_misses: u64,
}

/// Snapshot of the cumulative counters. Cheap (four atomic loads).
pub fn snapshot() -> CacheStats {
    CacheStats {
        backend_hits: BACKEND_HITS.load(Ordering::Relaxed),
        backend_misses: BACKEND_MISSES.load(Ordering::Relaxed),
        model_hits: MODEL_HITS.load(Ordering::Relaxed),
        model_misses: MODEL_MISSES.load(Ordering::Relaxed),
    }
}

/// Per-session cached decisions. Backend + model are session-stable:
/// the same `ChatRequest.provider` and the same keychain state
/// produce the same answer every turn within a session, so we can
/// safely cache across the whole session lifetime.
///
/// The memory digest is NOT cached here even though a prior iteration
/// did so — it embeds live world state (focus / activity / battery /
/// next event), a history-keyed recent-conversation block, and
/// goal-weighted semantic FTS results, all of which legitimately
/// change turn-to-turn. Rebuilding per turn (~5-10 ms typical,
/// 500 ms timeout-bounded worst case) is the price of freshness.
#[derive(Debug, Default)]
pub struct SessionCache {
    pub backend: Option<Backend>,
    pub model: Option<String>,
}

/// Composite cache key: `(session_id, provider_pin)`.
///
/// `provider_pin` is the normalised caller-supplied provider hint —
/// `"auto"` for `None` / empty / `"auto"` / unknown, otherwise the
/// canonical lowercase backend name (`"anthropic"`, `"ollama"`,
/// `"glm"`, `"kimi"`). Keeping it in the key means a mid-session flip
/// from `"auto"` → `"glm"` gets a fresh cache entry instead of
/// accidentally reusing the `"auto"` path's resolved backend.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    pub session_id: String,
    pub provider_pin: &'static str,
}

/// Normalise a `ChatRequest.provider` string into the fixed vocabulary
/// used as part of the cache key. The returned `&'static str` is safe
/// to embed in the key — the vocabulary is closed, so there's no
/// unbounded string churn.
///
/// Unknown / misspelled provider names fall back to `"auto"` because
/// `pick_backend` itself falls through to heuristic routing in that
/// case; keying the same bucket keeps the cache consistent with the
/// router's actual behaviour.
pub fn normalize_provider_pin(provider: Option<&str>) -> &'static str {
    let raw = match provider {
        Some(s) => s,
        None => return "auto",
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "auto";
    }
    let lower = trimmed.to_ascii_lowercase();
    let name = lower.strip_prefix("agent:").unwrap_or(&lower);
    match name {
        "anthropic" => "anthropic",
        "ollama" => "ollama",
        "glm" => "glm",
        "kimi" => "kimi",
        _ => "auto",
    }
}

/// Map of `(session_id, provider_pin) -> Arc<Mutex<SessionCache>>`.
///
/// The outer `std::sync::Mutex` is held only long enough to look up or
/// insert an entry — NEVER across an `.await`. The inner
/// `tokio::sync::Mutex` is what actually guards the cache cell; it's
/// async so holders can `.await` (memory-digest build, keychain probe)
/// while holding it.
static SESSION_CACHES: Lazy<StdMutex<HashMap<CacheKey, Arc<Mutex<SessionCache>>>>> =
    Lazy::new(|| StdMutex::new(HashMap::new()));

/// Look up (or lazily create) the cache cell for `(session_id,
/// provider_pin)`.
///
/// Returns a cloned `Arc` — the caller is responsible for taking the
/// inner lock. The outer map lock is released before this function
/// returns so the caller's subsequent `.await` on the inner mutex is
/// safe (holding a std lock across an await would risk deadlocks when
/// tokio moves the task between workers).
pub fn get_or_init(session_id: &str, provider_pin: &'static str) -> Arc<Mutex<SessionCache>> {
    let key = CacheKey {
        session_id: session_id.to_string(),
        provider_pin,
    };
    let mut map = SESSION_CACHES
        .lock()
        .expect("SESSION_CACHES poisoned — another thread panicked while holding it");
    map.entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(SessionCache::default())))
        .clone()
}

/// Return the cached backend for `(session_id, provider_pin)`, or
/// compute-and-cache.
///
/// `compute` is only awaited on a cache miss. Errors propagate — a
/// failed compute does not poison the cache entry (it remains `None`
/// so the next call will retry).
pub async fn get_backend_or_compute<F, Fut>(
    session_id: &str,
    provider_pin: &'static str,
    compute: F,
) -> Result<Backend, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Backend, String>>,
{
    let cell = get_or_init(session_id, provider_pin);
    let mut guard = cell.lock().await;
    if let Some(b) = guard.backend {
        BACKEND_HITS.fetch_add(1, Ordering::Relaxed);
        return Ok(b);
    }
    BACKEND_MISSES.fetch_add(1, Ordering::Relaxed);
    // Compute while holding the per-session lock. The
    // session-serialization lock in `session_lock.rs` already ensures
    // only one turn per session runs at a time, so this extra hold is
    // effectively free on the hot path.
    let backend = compute().await?;
    guard.backend = Some(backend);
    Ok(backend)
}

/// Return the cached model string for `(session_id, provider_pin,
/// backend)`, or compute-and-cache.
///
/// `backend` is part of the effective key: if a caller ever switches
/// backends mid-session (provider override), the cached model for the
/// previous backend is discarded and the new one is computed. In
/// practice `pick_backend` is cached above so this branch rarely fires.
pub async fn get_model_or_compute<F, Fut>(
    session_id: &str,
    provider_pin: &'static str,
    backend: Backend,
    compute: F,
) -> String
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = String>,
{
    let cell = get_or_init(session_id, provider_pin);
    let mut guard = cell.lock().await;

    // If the backend flipped since we last computed the model, the
    // cached string is for the wrong provider — drop it.
    let cached_backend_matches = guard.backend == Some(backend);
    if cached_backend_matches {
        if let Some(m) = guard.model.as_ref() {
            MODEL_HITS.fetch_add(1, Ordering::Relaxed);
            return m.clone();
        }
    } else {
        guard.model = None;
    }
    MODEL_MISSES.fetch_add(1, Ordering::Relaxed);

    let model = compute().await;
    guard.model = Some(model.clone());
    // Record the backend too so later `get_model_or_compute` calls can
    // detect a backend switch even if `get_backend_or_compute` wasn't
    // called first (defensive — in practice core.rs always calls
    // backend before model).
    guard.backend = Some(backend);
    model
}

/// Blow away every cached field for every provider_pin under
/// `session_id`. Used by "forget everything" style commands — a fresh
/// turn will re-run backend routing and model pick from scratch.
///
/// Iterates the outer map because the composite key means a single
/// session may have multiple live entries (one per pinned provider
/// the user has exercised during the session).
pub async fn invalidate_all(session_id: &str) {
    let cells: Vec<Arc<Mutex<SessionCache>>> = {
        let map = SESSION_CACHES
            .lock()
            .expect("SESSION_CACHES poisoned — another thread panicked while holding it");
        map.iter()
            .filter(|(k, _)| k.session_id == session_id)
            .map(|(_, v)| v.clone())
            .collect()
    };
    for cell in cells {
        let mut guard = cell.lock().await;
        guard.backend = None;
        guard.model = None;
    }
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
        let b1 = get_backend_or_compute(sid, "auto", || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Ollama)
        })
        .await
        .unwrap();

        let c2 = calls.clone();
        let b2 = get_backend_or_compute(sid, "auto", || async move {
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
    async fn model_recomputes_on_backend_switch() {
        let calls = Arc::new(AtomicU32::new(0));
        let sid = "test-model-backend-switch";
        invalidate_all(sid).await;

        let c1 = calls.clone();
        let m1 = get_model_or_compute(sid, "auto", Backend::Ollama, || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            "llama3:8b".to_string()
        })
        .await;

        let c2 = calls.clone();
        let m2 = get_model_or_compute(sid, "auto", Backend::Anthropic, || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            "claude-sonnet".to_string()
        })
        .await;

        assert_eq!(m1, "llama3:8b");
        assert_eq!(m2, "claude-sonnet");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidate_all_clears_backend_and_model() {
        let sid = "test-invalidate-all";
        // Seed cache
        let _ = get_backend_or_compute(sid, "auto", || async {
            Ok::<_, String>(Backend::Ollama)
        })
        .await
        .unwrap();
        let _ = get_model_or_compute(sid, "auto", Backend::Ollama, || async {
            "llama3:8b".to_string()
        })
        .await;

        invalidate_all(sid).await;

        // Next call must recompute — prove it by counting compute invocations.
        let calls = Arc::new(AtomicU32::new(0));
        let c = calls.clone();
        let _ = get_backend_or_compute(sid, "auto", || async move {
            c.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Anthropic)
        })
        .await
        .unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "invalidate_all must clear the backend cache"
        );
    }

    /// Pinning `glm` then `ollama` on the same `session_id` MUST produce
    /// two independent cache entries so the glm-resolved backend can
    /// never be served to the ollama-pinned turn (or vice versa). Also
    /// the glm-pinned path must be cached after the first turn —
    /// that's the whole point of Fix 1.
    #[tokio::test]
    async fn pinned_providers_get_independent_cache_entries() {
        let calls_glm = Arc::new(AtomicU32::new(0));
        let calls_ollama = Arc::new(AtomicU32::new(0));
        let sid = "test-pinned-providers";
        invalidate_all(sid).await;

        // First glm pin computes.
        let c1 = calls_glm.clone();
        let b1 = get_backend_or_compute(sid, "glm", || async move {
            c1.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Glm)
        })
        .await
        .unwrap();

        // Second glm pin hits cache.
        let c2 = calls_glm.clone();
        let b2 = get_backend_or_compute(sid, "glm", || async move {
            c2.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Anthropic) // would-be new value
        })
        .await
        .unwrap();

        // Flip to ollama: fresh compute (separate key).
        let c3 = calls_ollama.clone();
        let b3 = get_backend_or_compute(sid, "ollama", || async move {
            c3.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>(Backend::Ollama)
        })
        .await
        .unwrap();

        assert_eq!(b1, Backend::Glm);
        assert_eq!(b2, Backend::Glm, "glm pin must return cached value");
        assert_eq!(b3, Backend::Ollama, "ollama pin must not see glm's cache");
        assert_eq!(calls_glm.load(Ordering::SeqCst), 1);
        assert_eq!(calls_ollama.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn normalize_provider_pin_collapses_aliases_into_fixed_vocab() {
        assert_eq!(normalize_provider_pin(None), "auto");
        assert_eq!(normalize_provider_pin(Some("")), "auto");
        assert_eq!(normalize_provider_pin(Some("   ")), "auto");
        assert_eq!(normalize_provider_pin(Some("auto")), "auto");
        assert_eq!(normalize_provider_pin(Some("AUTO")), "auto");
        assert_eq!(normalize_provider_pin(Some("GLM")), "glm");
        assert_eq!(normalize_provider_pin(Some("agent:glm")), "glm");
        assert_eq!(normalize_provider_pin(Some("agent:ollama")), "ollama");
        assert_eq!(normalize_provider_pin(Some("anthropic")), "anthropic");
        assert_eq!(normalize_provider_pin(Some("kimi")), "kimi");
        // Unknown names fall back to `"auto"` so the cache bucket
        // matches the router's own fall-through behaviour.
        assert_eq!(normalize_provider_pin(Some("gpt-9000")), "auto");
    }

    /// `invalidate_all` must clear EVERY provider_pin entry for the
    /// session, not just the first one it happens to hit. Otherwise a
    /// "forget everything" command would leave stale backend/model
    /// values under a different pin.
    #[tokio::test]
    async fn invalidate_all_clears_every_provider_pin() {
        let sid = "test-invalidate-all-across-pins";
        invalidate_all(sid).await;

        // Seed three different pinned-provider entries.
        let _ = get_backend_or_compute(sid, "auto", || async {
            Ok::<_, String>(Backend::Ollama)
        })
        .await
        .unwrap();
        let _ = get_backend_or_compute(sid, "glm", || async {
            Ok::<_, String>(Backend::Glm)
        })
        .await
        .unwrap();
        let _ = get_backend_or_compute(sid, "anthropic", || async {
            Ok::<_, String>(Backend::Anthropic)
        })
        .await
        .unwrap();

        invalidate_all(sid).await;

        // Every entry must now recompute.
        let calls = Arc::new(AtomicU32::new(0));
        for pin in ["auto", "glm", "anthropic"] {
            let c = calls.clone();
            let _ = get_backend_or_compute(sid, pin, || async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(Backend::Ollama)
            })
            .await
            .unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "every provider_pin entry must have been invalidated"
        );
    }
}
