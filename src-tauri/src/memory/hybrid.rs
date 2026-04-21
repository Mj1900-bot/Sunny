//! Hybrid semantic search — the single episodic-memory search surface.
//!
//! One entry point: `search(query, SearchOpts) -> Vec<Hit>`. Opts control
//! result cap, the BM25↔cosine blend, whether query expansion is run, and
//! how many paraphrase variants to generate. Before sprint-12 γ this file
//! exposed both `search` and `search_expanded`; the two have been folded
//! into one so callers never have to pick between "search" and "search,
//! but also expand". Pass `expand: true` on `SearchOpts` to enable the
//! paraphrase leg.
//!
//! Pipeline (single variant):
//!
//!   1. FTS5 BM25 prefilter at `limit * OVERFETCH_MUL` — a wider window so
//!      the cosine reranker has room to move a paraphrase-matched row to
//!      the top even when its BM25 rank was mediocre.
//!   2. Embed the query with a hard 500 ms budget. If embedding is not
//!      available (Ollama off, model missing, slow network), the cosine
//!      leg is skipped and we return the FTS order directly.
//!   3. For each candidate, compute `score = alpha * bm25 + (1-alpha) * cos`
//!      with BM25 normalised to [0, 1] via reciprocal-rank (`1 / (1 + rank)`).
//!      Rows with no embedding fall back to BM25-only; they are never
//!      dropped — on a cold backfill, returning something beats returning
//!      nothing.
//!   4. Stable-sort descending on blended score, truncate to `limit`.
//!
//! Pipeline (expanded, `opts.expand == true`):
//!
//!   1. Paraphrase the query into up to `max_variants` wordings using the
//!      small local instruct model (see `expand.rs`). The original query
//!      is always variant[0] so coverage strictly supersets the single
//!      variant case — expansion can only add hits, never lose them.
//!   2. Run the single-variant pipeline on each paraphrase serially (each
//!      grabs the sqlite mutex, so parallelism would serialise inside the
//!      lock anyway).
//!   3. Merge by row id: each hit's score is the MAX across variants; a
//!      tiny multi-hit bonus (`0.02` per extra variant, capped at `0.1`)
//!      acts as a tiebreaker so a row that surfaces across several
//!      phrasings ranks above a row that only matched one.
//!   4. Final sort + truncate.
//!
//! `alpha` defaults to 0.6 — slightly keyword-leaning, which wins the F1
//! beauty contest on realistic assistant-memory queries.

use std::collections::HashMap;
use std::time::Duration;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use super::db::{fts_phrase_from_query, with_reader};
use super::embed;
use super::episodic::{EpisodicItem, EpisodicKind};
use super::expand::expand_query;

/// Number of query variants (including the original) generated when
/// `opts.expand` is true. 5 is the sweet spot: the R16-H spec asked for
/// 4–6 variants, the underlying 7B paraphraser tends to stop producing
/// genuinely distinct rewrites beyond 5, and running 5 sequential hybrid
/// searches is still comfortably under a second on a warm DB.
pub const DEFAULT_EXPAND_VARIANTS: usize = 5;

/// Bonus added to a hit's score for every additional variant that also
/// matched it. Kept deliberately tiny (0.02 per extra variant, cap 0.1)
/// so it acts as a gentle tiebreaker rather than a score override — the
/// primary signal is still the best single-variant blended score.
const MULTI_HIT_BONUS_PER_VARIANT: f32 = 0.02;
const MULTI_HIT_BONUS_CAP: f32 = 0.1;

/// Hard budget for the query-side embedding call. If it doesn't return in
/// time we return BM25-only results rather than stall a tool call.
const EMBED_BUDGET: Duration = Duration::from_millis(500);

/// Default blend — keyword-leaning. 1.0 = pure BM25, 0.0 = pure cosine.
pub const DEFAULT_ALPHA: f32 = 0.6;

/// Over-fetch multiplier — BM25 top-N can miss a paraphrase; pull 3x and
/// let the reranker surface it.
const OVERFETCH_MUL: usize = 3;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// Options controlling a single call to `search`. Every field is optional;
/// `SearchOpts::default()` yields the safe baseline: 20 results, default
/// alpha, no expansion.
#[derive(Clone, Debug, Default)]
pub struct SearchOpts {
    /// Final result cap. `None` → 20.
    pub limit: Option<usize>,
    /// Blend weight, clamped to [0, 1]. `None` → `DEFAULT_ALPHA`.
    pub alpha: Option<f32>,
    /// When true, paraphrase the query and union the hit sets (formerly
    /// `search_expanded`). Off by default because it costs a small-model
    /// round trip per call and most lookups don't need it.
    pub expand: bool,
    /// Upper bound on paraphrase variants (including the original) when
    /// `expand` is true. `None` → `DEFAULT_EXPAND_VARIANTS`. Ignored when
    /// `expand` is false.
    pub max_variants: Option<usize>,
}

/// A single hybrid hit. `bm25` / `cosine` are exposed so callers (and the
/// memory inspector UI) can see *why* a row ranked where it did.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Hit {
    pub item: EpisodicItem,
    /// BM25 component normalised to [0, 1] via reciprocal-rank.
    pub bm25: f32,
    /// Cosine similarity to the query embedding, [-1, 1]. 0.0 when no
    /// embedding was available for the row.
    pub cosine: f32,
    /// Blended score, `alpha * bm25 + (1 - alpha) * cosine`. Sort key.
    pub score: f32,
    /// `false` when the row had no embedding — its score was BM25-only.
    pub had_embedding: bool,
}

// ---------------------------------------------------------------------------
// Public API — one entry point
// ---------------------------------------------------------------------------

/// Run a hybrid FTS + embedding search against the episodic store.
///
/// Single entry point for all episodic recall. When `opts.expand` is true
/// the call fans out into several paraphrases and merges; when false it's
/// a single-variant pipeline. Behaviour degrades gracefully — an Ollama
/// outage collapses to pure BM25 ordering; a paraphrase-model failure
/// collapses to single-variant search; neither is a visible failure to
/// the caller.
pub async fn search(query: String, opts: SearchOpts) -> Result<Vec<Hit>, String> {
    let limit = opts.limit.unwrap_or(20).max(1);
    let alpha = opts.alpha.unwrap_or(DEFAULT_ALPHA).clamp(0.0, 1.0);

    if !opts.expand {
        return search_single(&query, limit, alpha).await;
    }

    // Expanded path — paraphrase, run single-variant search per wording,
    // merge on id with best-score-wins + multi-hit bonus.
    let variants_budget = opts.max_variants.unwrap_or(DEFAULT_EXPAND_VARIANTS);
    let variants = expand_query(&query, variants_budget).await;
    if variants.is_empty() {
        return Ok(Vec::new());
    }

    // Pull `limit * 2` from each variant so paraphrases disagreeing with
    // the original in the top slots still contribute. Final truncate
    // caps to the caller's `limit`.
    let per_variant_limit = limit.saturating_mul(2).max(limit);
    let mut aggregated: HashMap<String, AggregatedHit> = HashMap::new();

    for variant in &variants {
        let hits = match search_single(variant, per_variant_limit, alpha).await {
            Ok(h) => h,
            Err(e) => {
                // One variant failing is not fatal — would be silly to
                // sink the whole expanded search because one paraphrase
                // had a pathological FTS phrase. Log and carry on.
                log::debug!("hybrid::search expand: variant '{variant}' failed ({e}); skipping");
                continue;
            }
        };
        for hit in hits {
            aggregated
                .entry(hit.item.id.clone())
                .and_modify(|agg| agg.merge(&hit))
                .or_insert_with(|| AggregatedHit::from_first(hit));
        }
    }

    let mut out: Vec<Hit> = aggregated
        .into_values()
        .map(|agg| {
            let bonus = (agg.match_count.saturating_sub(1) as f32
                * MULTI_HIT_BONUS_PER_VARIANT)
                .min(MULTI_HIT_BONUS_CAP);
            Hit {
                score: agg.best.score + bonus,
                ..agg.best
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(limit);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Reranker primitive — shared with `pack.rs` so episodic rerank isn't
// reimplemented in two places.
// ---------------------------------------------------------------------------

/// Apply the blended-score rerank over a vector of `EpisodicItem` candidates
/// that arrived in FTS (bm25) order. Exposed so `pack::build_pack` can
/// reuse the exact same scoring rule on its goal-matched episodic slice,
/// keeping the pack's `matched_episodic` ordering consistent with the
/// `memory_recall` tool surface.
///
/// * `query_vec` — `Some(embedding)` triggers the cosine leg; `None` means
///   the caller couldn't embed the query and wants BM25-only ordering.
/// * `limit` — final cap on the returned vec.
/// * Returns the candidates unchanged when input is empty.
pub fn rerank_episodic(
    candidates: Vec<EpisodicItem>,
    query_vec: Option<&[f32]>,
    alpha: f32,
    limit: usize,
) -> Vec<EpisodicItem> {
    if candidates.is_empty() {
        return candidates;
    }
    let alpha = alpha.clamp(0.0, 1.0);

    // If we have no query embedding there's nothing to rerank against —
    // the input is already in BM25 order, so just truncate and return.
    let Some(q) = query_vec else {
        let mut out = candidates;
        out.truncate(limit);
        return out;
    };

    let ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
    let embeddings = embed::fetch_embeddings_by_id("episodic", &ids).unwrap_or_default();

    let mut scored: Vec<(f32, EpisodicItem)> = candidates
        .into_iter()
        .enumerate()
        .map(|(rank, item)| {
            let bm25 = rr_bm25(rank);
            let (cosine, has_embedding) = embeddings
                .get(&item.id)
                .map(|v| (embed::cosine(q, v), true))
                .unwrap_or((0.0, false));
            (blend_score(bm25, cosine, alpha, has_embedding), item)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored.into_iter().map(|(_, item)| item).collect()
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Single-variant pipeline: FTS prefilter → embed query (best effort) →
/// blend → sort. This is what `search` delegates to when `opts.expand`
/// is false, and what the expanded path calls per paraphrase.
async fn search_single(query: &str, limit: usize, alpha: f32) -> Result<Vec<Hit>, String> {
    // 1. FTS prefilter (over-fetched). Cheap path + fallback if embedding
    //    is unavailable, so do it first and return early on an empty set.
    let candidates: Vec<EpisodicItem> =
        with_reader(|c| fts_candidates(c, query, limit * OVERFETCH_MUL))?; // read-only path → reader pool
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Embed the query within a hard budget. A timeout or error here is
    //    NOT a failure — we degrade gracefully to BM25-only scoring.
    let query_vec: Option<Vec<f32>> = match tokio::time::timeout(
        EMBED_BUDGET,
        embed::embed(query),
    )
    .await
    {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            log::debug!("hybrid: embed failed ({e}); bm25-only");
            None
        }
        Err(_) => {
            log::debug!(
                "hybrid: embed exceeded {}ms budget; bm25-only",
                EMBED_BUDGET.as_millis()
            );
            None
        }
    };

    // 3. Fetch per-row embeddings for the FTS candidate set (one IN query).
    //    Skip entirely if the query embed failed — nothing to compare.
    let row_embeddings: HashMap<String, Vec<f32>> = if query_vec.is_some() {
        let ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
        embed::fetch_embeddings_by_id("episodic", &ids).unwrap_or_default()
    } else {
        HashMap::new()
    };

    // 4. Blend. `rank` is the FTS position, 0-based. bm25 component is
    //    `1 / (1 + rank)` so #0 → 1.0, #1 → 0.5, #2 → 0.333, etc. —
    //    monotonic, bounded, and emphasises the top FTS slots without
    //    pretending the tail has zero signal.
    let mut hits: Vec<Hit> = candidates
        .into_iter()
        .enumerate()
        .map(|(rank, item)| {
            let bm25 = rr_bm25(rank);
            let (cosine, had_embedding) = match (&query_vec, row_embeddings.get(&item.id)) {
                (Some(q), Some(v)) => (embed::cosine(q, v), true),
                _ => (0.0, false),
            };
            // Per-row fallback: if no embedding, pretend alpha=1 for this
            // row — scored purely on BM25, not dragged to 0 by a missing
            // cosine term.
            let effective_has_embedding = had_embedding && query_vec.is_some();
            let score = blend_score(bm25, cosine, alpha, effective_has_embedding);
            Hit {
                item,
                bm25,
                cosine,
                score,
                had_embedding,
            }
        })
        .collect();

    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

/// Intermediate accumulator for merging hits across query variants.
struct AggregatedHit {
    best: Hit,
    match_count: usize,
}

impl AggregatedHit {
    fn from_first(hit: Hit) -> Self {
        Self { best: hit, match_count: 1 }
    }

    fn merge(&mut self, candidate: &Hit) {
        self.match_count += 1;
        // Keep the row with the higher blended score and its associated
        // bm25/cosine/had_embedding so the inspector UI shows the
        // *winning* variant's rationale, not a stale one.
        if candidate.score > self.best.score {
            self.best = candidate.clone();
        }
    }
}

/// FTS5 query against the episodic store, sanitised. Mirrors the SQL in
/// `episodic::search_in` but kept local so this module is self-contained
/// (and doesn't risk the base module's ordering changing out from under us).
fn fts_candidates(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<EpisodicItem>, String> {
    let phrase = fts_phrase_from_query(query);
    if phrase.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT e.id, e.kind, e.text, e.tags_json, e.meta_json, e.created_at
             FROM episodic_fts f
             JOIN episodic e ON e.rowid = f.rowid
             WHERE episodic_fts MATCH ?1
             ORDER BY bm25(episodic_fts) ASC, e.created_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare hybrid fts: {e}"))?;
    let rows = stmt
        .query_map(params![phrase, limit as i64], row_to_episodic)
        .map_err(|e| format!("query hybrid fts: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect hybrid fts: {e}"))?;
    Ok(rows)
}

fn row_to_episodic(r: &rusqlite::Row) -> rusqlite::Result<EpisodicItem> {
    let id: String = r.get(0)?;
    let kind_s: String = r.get(1)?;
    let text: String = r.get(2)?;
    let tags_s: String = r.get(3)?;
    let meta_s: String = r.get(4)?;
    let created_at: i64 = r.get(5)?;
    let tags: Vec<String> = serde_json::from_str(&tags_s).unwrap_or_default();
    let meta: serde_json::Value =
        serde_json::from_str(&meta_s).unwrap_or(serde_json::Value::Null);
    Ok(EpisodicItem {
        id,
        kind: match kind_s.as_str() {
            "user" => EpisodicKind::User,
            "agent_step" => EpisodicKind::AgentStep,
            "tool_call" => EpisodicKind::ToolCall,
            "perception" => EpisodicKind::Perception,
            "reflection" => EpisodicKind::Reflection,
            _ => EpisodicKind::Note,
        },
        text,
        tags,
        meta,
        created_at,
    })
}

// ---------------------------------------------------------------------------
// Internal helpers exposed for tests — pure functions, no global state.
// ---------------------------------------------------------------------------

/// Core blending helper — exposed for unit tests so we can exercise the
/// scoring logic without any async plumbing or a real DB.
pub(crate) fn blend_score(bm25: f32, cosine: f32, alpha: f32, has_embedding: bool) -> f32 {
    if has_embedding {
        alpha.clamp(0.0, 1.0) * bm25 + (1.0 - alpha.clamp(0.0, 1.0)) * cosine
    } else {
        bm25
    }
}

/// Compute the reciprocal-rank BM25 component for position `rank` (0-based).
pub(crate) fn rr_bm25(rank: usize) -> f32 {
    1.0 / (1.0 + rank as f32)
}

// ---------------------------------------------------------------------------
// Tests — focus on the deterministic, non-network pieces. End-to-end
// `search()` wiring is exercised in the FTS module and the pack tests;
// re-running it here would need a live Ollama and buys little signal.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rr_bm25_is_monotonic_and_bounded() {
        assert_eq!(rr_bm25(0), 1.0);
        assert!((rr_bm25(1) - 0.5).abs() < 1e-6);
        assert!(rr_bm25(5) < rr_bm25(4));
        assert!(rr_bm25(100) > 0.0);
    }

    #[test]
    fn blend_honours_alpha_when_embedding_present() {
        // alpha=1.0 → pure BM25
        let s = blend_score(0.8, 0.5, 1.0, true);
        assert!((s - 0.8).abs() < 1e-6);
        // alpha=0.0 → pure cosine
        let s = blend_score(0.8, 0.5, 0.0, true);
        assert!((s - 0.5).abs() < 1e-6);
        // alpha=0.6 → weighted
        let s = blend_score(0.8, 0.5, 0.6, true);
        assert!((s - (0.6 * 0.8 + 0.4 * 0.5)).abs() < 1e-6);
    }

    #[test]
    fn blend_falls_back_to_bm25_when_no_embedding() {
        // Row has no embedding — score must equal bm25 regardless of alpha
        // or the (meaningless) cosine value.
        let s = blend_score(0.7, 0.99, 0.1, false);
        assert!((s - 0.7).abs() < 1e-6);
        let s = blend_score(0.25, -0.5, 0.5, false);
        assert!((s - 0.25).abs() < 1e-6);
    }

    #[test]
    fn blend_clamps_alpha_out_of_range() {
        // alpha > 1.0 is clamped to 1.0 — equivalent to pure BM25.
        let s = blend_score(0.4, 0.9, 2.0, true);
        assert!((s - 0.4).abs() < 1e-6);
        // alpha < 0.0 is clamped to 0.0 — equivalent to pure cosine.
        let s = blend_score(0.4, 0.9, -1.0, true);
        assert!((s - 0.9).abs() < 1e-6);
    }

    #[test]
    fn default_alpha_is_keyword_leaning() {
        // Documented invariant: DEFAULT_ALPHA > 0.5 (slightly keyword-biased).
        assert!(DEFAULT_ALPHA > 0.5);
        assert!(DEFAULT_ALPHA <= 1.0);
    }

    fn sample_hit(id: &str, score: f32) -> Hit {
        Hit {
            item: EpisodicItem {
                id: id.to_string(),
                kind: EpisodicKind::Note,
                text: format!("text for {id}"),
                tags: Vec::new(),
                meta: serde_json::Value::Null,
                created_at: 0,
            },
            bm25: score,
            cosine: 0.0,
            score,
            had_embedding: false,
        }
    }

    #[test]
    fn aggregated_hit_keeps_best_score_on_merge() {
        let mut agg = AggregatedHit::from_first(sample_hit("a", 0.4));
        agg.merge(&sample_hit("a", 0.7));
        agg.merge(&sample_hit("a", 0.5));
        assert_eq!(agg.match_count, 3);
        assert!((agg.best.score - 0.7).abs() < 1e-6);
    }

    #[test]
    fn multi_hit_bonus_is_bounded() {
        // A hit matched by 10 variants should not get a runaway bonus —
        // the cap keeps the tiebreaker from dominating the primary score.
        let raw_bonus = (10_usize.saturating_sub(1) as f32) * MULTI_HIT_BONUS_PER_VARIANT;
        let applied = raw_bonus.min(MULTI_HIT_BONUS_CAP);
        assert!(applied <= MULTI_HIT_BONUS_CAP + 1e-6);
        // And a single-hit row gets exactly zero bonus (no double-count).
        let single = (1_usize.saturating_sub(1) as f32) * MULTI_HIT_BONUS_PER_VARIANT;
        assert_eq!(single, 0.0);
    }

    #[test]
    fn rerank_episodic_without_query_vec_is_identity_plus_truncate() {
        // When the caller couldn't embed the query (Ollama off), rerank
        // must preserve the incoming BM25 order and just enforce the cap.
        let items: Vec<EpisodicItem> = (0..5)
            .map(|n| EpisodicItem {
                id: format!("id{n}"),
                kind: EpisodicKind::Note,
                text: format!("row {n}"),
                tags: Vec::new(),
                meta: serde_json::Value::Null,
                created_at: 0,
            })
            .collect();
        let out = rerank_episodic(items.clone(), None, DEFAULT_ALPHA, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].id, "id0");
        assert_eq!(out[2].id, "id2");
    }

    #[test]
    fn rerank_episodic_on_empty_input_is_empty() {
        let out = rerank_episodic(Vec::new(), None, DEFAULT_ALPHA, 10);
        assert!(out.is_empty());
    }

    #[test]
    fn search_opts_default_is_safe_baseline() {
        // Regression guard: the default opts must never enable expansion,
        // because that would silently wire Ollama into every memory_recall
        // call. Callers opt in via `expand: true`.
        let o = SearchOpts::default();
        assert!(!o.expand);
        assert!(o.limit.is_none());
        assert!(o.alpha.is_none());
        assert!(o.max_variants.is_none());
    }
}
