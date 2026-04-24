//! Memory pack — the unified "working memory" the agent loop receives at
//! the start of every turn.
//!
//! Pulls:
//!   * top-K semantic facts matching the goal text (high-signal ground truth)
//!   * recent episodic rows (chronological recency window)
//!   * goal-matched episodic rows (if any)
//!   * top-K procedural skills (name + trigger_text; ordered by uses_count)
//!   * lightweight stats so the agent can reason about "how much do I know?"
//!
//! All retrieval is bounded — no query can pull more than a few hundred rows
//! — so the packed prompt stays predictable in size. Phase 1b slots
//! embedding-based reranking between the FTS hit set and the final pack.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::with_reader;
use super::embed;
use super::episodic::{EpisodicItem, EpisodicKind};
use super::hybrid;
use super::procedural::ProceduralSkill;
use super::semantic::SemanticFact;
use super::{episodic, procedural, semantic};
use crate::world;

/// Hard per-turn budget for embedding the goal text before a pack build.
/// The call happens inside `spawn_blocking` (see `build_memory_digest`) so
/// it does NOT wedge a tokio worker — but we still cap it so a slow /
/// cold Ollama can't stall the pack past its outer 500 ms deadline. If
/// the embed overruns this budget the pack falls back to FTS-only order,
/// which is the same behaviour as pre-fix.
const GOAL_EMBED_BUDGET: Duration = Duration::from_millis(400);

// ---------------------------------------------------------------------------
// Duration stats — surfaced to the Diagnostics page (sprint-13 ε).
// ---------------------------------------------------------------------------
//
// Each `build_pack` records its wall-clock cost into two atomics: the
// most recent measurement and an exponentially-weighted moving average
// smoothed against prior builds. The pack is built ~once per agent turn,
// so "last" is the interesting number for a live HUD, while "ewma"
// rides out a single slow build caused by a cold Ollama.

/// Milliseconds taken by the most recent completed `build_pack` call.
/// Zero until the first build finishes.
static LAST_PACK_MS: AtomicU64 = AtomicU64::new(0);

/// Exponentially-weighted moving average of `build_pack` duration, in
/// milliseconds. Smoothing factor `EWMA_ALPHA` = 0.3 — low enough that a
/// single 400 ms cold-Ollama build doesn't push a historically-fast
/// 30 ms pack to an alarming number on the HUD, high enough that a
/// genuine regression visibly moves the average inside ~7 builds.
/// Stored as integer millis (no fractional component) to match the
/// u64 atomic; one-ms quantisation is fine for an observability gauge.
static EWMA_PACK_MS: AtomicU64 = AtomicU64::new(0);

/// EWMA smoothing factor, expressed as a rational `NUM / DEN` so the
/// update path stays on integer math. 0.3 ≈ "seven-build half-life":
/// after a step change the average is within ~10% of the new value by
/// the 7th sample. Kept as integer math so we don't need to spill to
/// f64 on every pack build.
const EWMA_ALPHA_NUM: u64 = 3;
const EWMA_ALPHA_DEN: u64 = 10;

/// Update the duration atomics after a `build_pack` completes. Called
/// from exactly one site at the tail of `build_pack` so the counters
/// can't double-count a build.
fn record_pack_duration(elapsed: Duration) {
    // Clamp to u64 — a pack build taking more than 584 million years
    // would overflow otherwise. Belt-and-braces; a real build is
    // single-digit seconds at worst (the embed timeout dominates).
    let ms = elapsed.as_millis().min(u64::MAX as u128) as u64;
    LAST_PACK_MS.store(ms, Ordering::Relaxed);

    // EWMA: new = alpha*sample + (1 - alpha)*prev. First sample short-
    // circuits to the raw value so a single build after boot isn't
    // diluted by the zero seed.
    let prev = EWMA_PACK_MS.load(Ordering::Relaxed);
    let next = if prev == 0 {
        ms
    } else {
        (EWMA_ALPHA_NUM * ms + (EWMA_ALPHA_DEN - EWMA_ALPHA_NUM) * prev) / EWMA_ALPHA_DEN
    };
    EWMA_PACK_MS.store(next, Ordering::Relaxed);
}

/// Snapshot of `(last_ms, ewma_ms)` — cheap (two atomic loads). Both
/// are zero until the first `build_pack` completes. Surfaced on the
/// Diagnostics page.
pub fn pack_stats() -> (u64, u64) {
    (
        LAST_PACK_MS.load(Ordering::Relaxed),
        EWMA_PACK_MS.load(Ordering::Relaxed),
    )
}

// ---------------------------------------------------------------------------
// Wire shapes — all serde-derived, ready for direct emit to the frontend.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct MemoryPack {
    pub goal: Option<String>,
    pub semantic: Vec<SemanticFact>,
    pub recent_episodic: Vec<EpisodicItem>,
    pub matched_episodic: Vec<EpisodicItem>,
    pub skills: Vec<ProceduralSkill>,
    /// Skills ranked by embedding similarity to the goal. Subset of `skills`,
    /// ordered best-first. Empty when no goal is provided or when embeddings
    /// aren't available. The planner uses this as a System-1 skill router —
    /// a top match above some threshold can bypass the LLM planning step.
    #[serde(default)]
    pub matched_skills: Vec<MatchedSkill>,
    pub stats: MemoryStats,
    #[ts(type = "number")]
    pub built_at: i64,
    /// `true` when hybrid (embedding) search was used; `false` when the
    /// pack fell back to FTS-only. Mostly informational for the UI.
    #[serde(default)]
    pub used_embeddings: bool,
    /// Continuously-updated snapshot of the user's digital environment —
    /// focused app, activity classifier, next calendar event, machine
    /// state. Folded into the pack so the agent always gets a "right now"
    /// block without paying a per-turn sampling cost.
    #[serde(default)]
    pub world: Option<world::WorldState>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct MatchedSkill {
    pub skill: ProceduralSkill,
    /// Cosine similarity, -1.0..=1.0. Practically: >0.75 is "clear match",
    /// >0.85 is "execute directly" threshold used by the System-1 router.
    pub score: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct MemoryStats {
    #[ts(type = "number")]
    pub episodic_count: i64,
    #[ts(type = "number")]
    pub semantic_count: i64,
    #[ts(type = "number")]
    pub procedural_count: i64,
    #[ts(type = "number | null")]
    pub oldest_episodic_secs: Option<i64>,
    #[ts(type = "number | null")]
    pub newest_episodic_secs: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Default, TS)]
#[ts(export)]
pub struct BuildOptions {
    /// Free-text goal for the current turn. Used to search both semantic
    /// and episodic stores; absent → recency-only pack.
    pub goal: Option<String>,
    /// Semantic fact top-K (default 8).
    #[ts(type = "number | null")]
    pub semantic_limit: Option<usize>,
    /// Recent episodic window (default 20).
    #[ts(type = "number | null")]
    pub recent_limit: Option<usize>,
    /// Matched episodic top-K (default 8, only applied when goal present).
    #[ts(type = "number | null")]
    pub matched_limit: Option<usize>,
    /// Procedural skill list size (default 5).
    #[ts(type = "number | null")]
    pub skill_limit: Option<usize>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn build_pack(opts: BuildOptions) -> Result<MemoryPack, String> {
    // Duration stamp — closed out at every return path so the
    // Diagnostics page's last-ms / ewma-ms tiles reflect every build,
    // even the error path (an embed-failure burn is exactly what the
    // operator wants to see surfaced). Stored via `record_pack_duration`.
    let pack_start = Instant::now();

    let semantic_limit = opts.semantic_limit.unwrap_or(8);
    let recent_limit = opts.recent_limit.unwrap_or(20);
    let matched_limit = opts.matched_limit.unwrap_or(8);
    let skill_limit = opts.skill_limit.unwrap_or(5);

    let goal_text = opts.goal.as_deref().unwrap_or("").trim().to_string();
    let have_goal = !goal_text.is_empty();

    // --------------------------------------------------------------------
    // Goal-matched retrieval (semantic + episodic + procedural).
    //
    // Strategy:
    //   1. FTS prefilter — cheap, always available, handles keyword queries.
    //   2. If Ollama is reachable, embed the goal once and rerank each
    //      candidate set by cosine similarity. FTS hits without embeddings
    //      keep their FTS order at the tail of the list.
    //   3. If embed fails, skip step 2 and return the FTS order as-is.
    //
    // We embed synchronously here (blocking the pack build on the network)
    // rather than async because the pack is built once per agent run — a
    // single ~30ms round trip is cheap compared to the value of goal-scoped
    // memory retrieval. When Ollama is absent, the embed call errors out
    // quickly (ECONNREFUSED) and we degrade to FTS-only.
    // --------------------------------------------------------------------

    // Start from FTS candidate sets (wider than the final top-K so the
    // reranker has room to reorder).
    let fts_widen = 4_usize;

    // Concurrent FTS prefilter + goal embed when we have a goal. FTS is
    // synchronous SQLite; the embed is an async HTTP call to Ollama.
    // Running them concurrently collapses the worst case from
    // `fts + embed` to `max(fts, embed)` — ~20-80ms savings on cold
    // sqlite page cache, most meaningful on the first turn of a
    // session. Both paths honour `GOAL_EMBED_BUDGET`; embed misses
    // silently degrade to FTS-only ranking.
    //
    // Thread safety: `build_pack` already runs inside `spawn_blocking`,
    // so a nested `block_on` on a `join!` won't wedge a tokio worker —
    // we're on the blocking thread pool, not the reactor. `spawn_blocking`
    // for the FTS chunk is a NESTED blocking task; rusqlite is fine
    // with that and the handle resolves before embed does in the
    // happy path.
    let (raw_semantic, raw_episodic, goal_vec): (
        Vec<semantic::SemanticFact>,
        Vec<episodic::EpisodicItem>,
        Option<Vec<f32>>,
    ) = if have_goal {
        let goal_for_fts = goal_text.clone();
        let fts_task = tokio::task::spawn_blocking(move || {
            let sem = semantic::search_facts(
                goal_for_fts.clone(),
                Some(semantic_limit * fts_widen),
            )?;
            let epi = episodic::search(
                goal_for_fts,
                Some(matched_limit * fts_widen),
            )?
            .into_iter()
            .filter(|e| !matches!(e.kind, EpisodicKind::Reflection))
            .collect::<Vec<_>>();
            Ok::<_, String>((sem, epi))
        });
        let embed_fut = async {
            match tokio::time::timeout(GOAL_EMBED_BUDGET, embed::embed(&goal_text)).await {
                Ok(Ok(v)) => Some(v),
                Ok(Err(e)) => {
                    log::debug!("pack: goal embed failed ({e}); falling back to FTS-only");
                    None
                }
                Err(_) => {
                    log::debug!(
                        "pack: goal embed exceeded {}ms budget; FTS-only",
                        GOAL_EMBED_BUDGET.as_millis()
                    );
                    None
                }
            }
        };
        let (fts_join, goal_vec) = tauri::async_runtime::block_on(async {
            tokio::join!(fts_task, embed_fut)
        });
        let (sem, epi) = fts_join
            .map_err(|e| format!("pack: FTS join failure: {e}"))??;
        (sem, epi, goal_vec)
    } else {
        // No goal → recency-only pack. Use the pinned-first variant so core
        // identity facts (user.name, user.location, user.preference.*) stay
        // in the digest even after a burst of newer facts would otherwise
        // rotate them out of the 8-slot budget. No embed needed.
        (
            semantic::list_facts_pinned_first(semantic_limit)?,
            Vec::new(),
            None,
        )
    };

    // Procedural — FTS isn't indexed for this store (trigger_text is short,
    // small row count), so pull the full list and let the embedder rank.
    let all_skills = procedural::list_skills()?;

    let (matched_semantic, matched_episodic, matched_skills) = match &goal_vec {
        Some(q) => rerank_all(q, raw_semantic, raw_episodic, &all_skills, semantic_limit, matched_limit),
        None => (
            raw_semantic.into_iter().take(semantic_limit).collect(),
            raw_episodic.into_iter().take(matched_limit).collect(),
            Vec::new(),
        ),
    };

    // Final pack assembly.
    let recent_episodic = episodic::list(Some(recent_limit), Some(0))?;
    let skills = {
        let mut all = all_skills;
        all.truncate(skill_limit);
        all
    };

    let stats = stats()?;
    let pack = MemoryPack {
        goal: if have_goal { Some(goal_text) } else { None },
        semantic: matched_semantic,
        recent_episodic,
        matched_episodic,
        skills,
        matched_skills,
        stats,
        built_at: super::db::now_secs(),
        used_embeddings: goal_vec.is_some(),
        world: Some(world::current()),
    };
    // Record the successful-build wall-clock. The error paths above
    // use `?` and don't reach this point — that's fine; a build that
    // errors out early isn't a meaningful duration sample and folding
    // it into the EWMA would dilute the real steady-state signal.
    record_pack_duration(pack_start.elapsed());
    Ok(pack)
}

/// Rerank the three goal-matched candidate sets by cosine similarity to the
/// query vector. Candidates without embeddings keep their FTS order at the
/// tail so an Ollama-less machine still sees SOMETHING in each slot.
///
/// The episodic slice is delegated to `hybrid::rerank_episodic` so the pack
/// and `memory_recall` agree on ordering (same blended bm25+cosine score,
/// same per-row fallback). Semantic and procedural go through the generic
/// `embed::rerank_by_id` cosine path since their incoming FTS ordering
/// isn't meaningful as a BM25 prior.
fn rerank_all(
    q: &[f32],
    semantic_candidates: Vec<SemanticFact>,
    episodic_candidates: Vec<EpisodicItem>,
    procedural_candidates: &[ProceduralSkill],
    semantic_limit: usize,
    episodic_limit: usize,
) -> (Vec<SemanticFact>, Vec<EpisodicItem>, Vec<MatchedSkill>) {
    let sem_embeddings = embed::fetch_embeddings_by_id(
        "semantic",
        &semantic_candidates.iter().map(|f| f.id.clone()).collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    let sem = embed::rerank_by_id(q, semantic_candidates, &sem_embeddings, semantic_limit, |f| {
        f.id.clone()
    });

    // Episodic uses the same blended-score rerank as the `memory_recall`
    // tool surface — one reranker path, one ordering rule across the
    // whole memory layer.
    let epi = hybrid::rerank_episodic(
        episodic_candidates,
        Some(q),
        hybrid::DEFAULT_ALPHA,
        episodic_limit,
    );

    let skills = rerank_skills(q, procedural_candidates);
    (sem, epi, skills)
}

/// Procedural skills have a slightly different shape from the generic
/// cosine rerank: we surface the score alongside each skill (so the
/// System-1 router in `agentLoop.ts` can threshold-gate execution) and
/// drop rows that fall below a relevance floor. Otherwise it's the same
/// `embed::fetch_embeddings_by_id` + `embed::cosine` flow as the other
/// stores — no bespoke logic here.
fn rerank_skills(q: &[f32], candidates: &[ProceduralSkill]) -> Vec<MatchedSkill> {
    if candidates.is_empty() {
        return Vec::new();
    }
    let ids: Vec<String> = candidates.iter().map(|s| s.id.clone()).collect();
    let embeddings = embed::fetch_embeddings_by_id("procedural", &ids).unwrap_or_default();
    let mut scored: Vec<MatchedSkill> = candidates
        .iter()
        .filter_map(|s| {
            let v = embeddings.get(&s.id)?;
            let score = embed::cosine(q, v);
            Some(MatchedSkill {
                skill: s.clone(),
                score,
            })
        })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    // Keep a few best; low-score skills don't belong in the prompt.
    scored.truncate(5);
    scored.retain(|m| m.score > 0.25); // floor: below this is probably noise
    scored
}

/// Cache wrapper — `stats()` is called on every `build_pack` invocation
/// and runs 5 non-cached aggregates (3× COUNT, MIN, MAX) over the full
/// episodic / semantic / procedural tables. The answer barely changes
/// between consecutive agent turns, so caching for a short TTL turns
/// the hot path into a read-through with negligible staleness cost.
struct CachedStats {
    at: Instant,
    value: MemoryStats,
}

/// TTL for the `stats()` cache. 10s is long enough that turn-bursts
/// (several agent iterations in quick succession) all hit the cache,
/// short enough that the Diagnostics page reflects reality within two
/// poll cycles.
const STATS_TTL: Duration = Duration::from_secs(10);

static STATS_CACHE: OnceLock<Mutex<Option<CachedStats>>> = OnceLock::new();

fn stats_cache() -> &'static Mutex<Option<CachedStats>> {
    STATS_CACHE.get_or_init(|| Mutex::new(None))
}

/// The 5-query core of [`stats`], extracted so integration tests can
/// exercise it against a scratch connection without touching the global
/// singleton. Production callers go through [`stats`] which adds the TTL
/// cache + reader-pool checkout.
fn stats_from(c: &Connection) -> Result<MemoryStats, String> {
    let ep: i64 = c
        .query_row("SELECT count(*) FROM episodic", [], |r| r.get(0))
        .map_err(|e| format!("count episodic: {e}"))?;
    let se: i64 = c
        .query_row("SELECT count(*) FROM semantic", [], |r| r.get(0))
        .map_err(|e| format!("count semantic: {e}"))?;
    let pr: i64 = c
        .query_row("SELECT count(*) FROM procedural", [], |r| r.get(0))
        .map_err(|e| format!("count procedural: {e}"))?;
    let oldest: Option<i64> = c
        .query_row("SELECT MIN(created_at) FROM episodic", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .unwrap_or(None);
    let newest: Option<i64> = c
        .query_row("SELECT MAX(created_at) FROM episodic", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .unwrap_or(None);
    Ok(MemoryStats {
        episodic_count: ep,
        semantic_count: se,
        procedural_count: pr,
        oldest_episodic_secs: oldest,
        newest_episodic_secs: newest,
    })
}

pub fn stats() -> Result<MemoryStats, String> {
    // Read path — return cached value if fresh. `try_lock` is the right
    // primitive: a parallel `stats()` caller re-computing isn't worse
    // than a briefly-contended lock, and we'd rather re-query than
    // block.
    if let Ok(guard) = stats_cache().try_lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.at.elapsed() < STATS_TTL {
                return Ok(cached.value.clone());
            }
        }
    }

    // Slow path — 5 queries against one pooled reader connection. WAL mode
    // means readers never block writers (and vice versa), and the connection
    // is checked out of the pool for the whole closure so all 5 queries see
    // a consistent snapshot.
    let fresh = with_reader(stats_from)?;

    // Best-effort cache write — a failed write means next caller re-queries,
    // which is fine. Poisoned lock → skip, again fine.
    if let Ok(mut guard) = stats_cache().lock() {
        *guard = Some(CachedStats {
            at: Instant::now(),
            value: fresh.clone(),
        });
    }
    Ok(fresh)
}

/// Invalidate the `stats()` cache. Call after any mutating operation on
/// episodic / semantic / procedural that a caller wants to see reflected
/// before the TTL expires (episodic add, consolidation sweep, retention
/// prune). Today callers don't use this — the TTL is short enough that
/// normal use eats the staleness — but the hook exists for explicit
/// invalidation if/when it's needed.
#[allow(dead_code)]
pub fn invalidate_stats_cache() {
    if let Ok(mut guard) = stats_cache().lock() {
        *guard = None;
    }
}

// ---------------------------------------------------------------------------
// Tests — use the real global DB init in scratch mode is awkward, so we
// test the pure pack-assembly logic on a fresh in-memory connection.
// ---------------------------------------------------------------------------

// The retrieval-assembly logic is exercised by the per-store tests in
// episodic.rs / semantic.rs / procedural.rs. The `stats_from` function
// is covered below via a scratch-conn integration test that seeds the
// three tables and asserts the returned counts + min/max. The stats
// cache below is pure primitives and testable without hitting the DB.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalidate_stats_cache_clears_stored_entry() {
        // Seed the cache with a synthetic entry, then invalidate.
        {
            let mut guard = stats_cache().lock().expect("cache lock");
            *guard = Some(CachedStats {
                at: Instant::now(),
                value: MemoryStats {
                    episodic_count: 42,
                    semantic_count: 7,
                    procedural_count: 3,
                    oldest_episodic_secs: Some(1_700_000_000),
                    newest_episodic_secs: Some(1_800_000_000),
                },
            });
        }
        invalidate_stats_cache();
        let guard = stats_cache().lock().expect("cache lock");
        assert!(
            guard.is_none(),
            "invalidate should wipe the cached entry"
        );
    }

    #[test]
    fn cached_stats_ttl_expires() {
        // Write an entry with an Instant far enough in the past that
        // STATS_TTL has definitely lapsed.
        {
            let mut guard = stats_cache().lock().expect("cache lock");
            *guard = Some(CachedStats {
                at: Instant::now() - STATS_TTL - Duration::from_secs(1),
                value: MemoryStats::default(),
            });
        }
        // Re-read the cache and check that the `elapsed() < STATS_TTL`
        // gate would reject it. We can't call `stats()` here without a
        // live DB, so we assert the predicate directly.
        let guard = stats_cache().lock().expect("cache lock");
        let stale = guard
            .as_ref()
            .map(|c| c.at.elapsed() >= STATS_TTL)
            .unwrap_or(false);
        assert!(stale, "synthetic entry should be older than STATS_TTL");
        drop(guard);
        invalidate_stats_cache(); // clean up for neighbouring tests
    }

    // ---------------------------------------------------------------------
    // stats_from — scratch-conn integration tests (Phase 4 closeout)
    // ---------------------------------------------------------------------

    #[test]
    fn stats_from_empty_db_returns_zero_counts_and_none_timestamps() {
        use crate::memory::db::scratch_conn;
        let (_dir, c) = scratch_conn("pack-stats-empty");

        let s = stats_from(&c).expect("stats_from on empty DB");
        assert_eq!(s.episodic_count, 0);
        assert_eq!(s.semantic_count, 0);
        assert_eq!(s.procedural_count, 0);
        assert_eq!(s.oldest_episodic_secs, None);
        assert_eq!(s.newest_episodic_secs, None);
    }

    #[test]
    fn stats_from_seeded_db_returns_accurate_counts_and_timestamps() {
        use crate::memory::db::scratch_conn;
        use rusqlite::params;
        let (_dir, c) = scratch_conn("pack-stats-seeded");

        // Two episodic rows with distinct created_at values.
        let ep_old = 1_700_000_000_i64;
        let ep_new = 1_800_000_000_i64;
        for (id, ts) in [("ep-1", ep_old), ("ep-2", ep_new)] {
            c.execute(
                "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
                 VALUES (?1, 'perception', 'seed', '[]', '{}', ?2)",
                params![id, ts],
            )
            .unwrap();
        }

        // Three semantic rows.
        for i in 0..3 {
            let id = format!("sem-{i}");
            c.execute(
                "INSERT INTO semantic
                    (id, subject, text, tags_json, confidence, source, created_at, updated_at)
                 VALUES (?1, 'subj', 'fact', '[]', 0.9, 'seed', ?2, ?2)",
                params![id, 1_700_000_000_i64 + i as i64],
            )
            .unwrap();
        }

        // One procedural row (match the compact.rs schema: no signature columns).
        c.execute(
            "INSERT INTO procedural
                (id, name, description, trigger_text, skill_path,
                 uses_count, last_used_at, created_at, recipe_json)
             VALUES ('proc-1', 'skill', '', '', 'skills/demo.yaml', 0, NULL, 1700000000, '{}')",
            [],
        )
        .unwrap();

        let s = stats_from(&c).expect("stats_from on seeded DB");
        assert_eq!(s.episodic_count, 2, "two episodic rows inserted");
        assert_eq!(s.semantic_count, 3, "three semantic rows inserted");
        assert_eq!(s.procedural_count, 1, "one procedural row inserted");
        assert_eq!(s.oldest_episodic_secs, Some(ep_old));
        assert_eq!(s.newest_episodic_secs, Some(ep_new));
    }
}
