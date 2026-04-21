//! Semantic-memory compaction — cluster near-duplicate facts and keep the
//! strongest representative from each cluster.
//!
//! ### Why
//! Over time `memory_remember` accumulates overlapping facts with subtly
//! different phrasings: *"user likes espresso"*, *"Sunny prefers espresso in
//! the mornings"*, *"morning drink: espresso"*. None of them are wrong, but
//! they crowd out retrieval and blur the signal in the memory pack digest.
//!
//! ### How
//! Pure embedding-space clustering using the vectors the backfill loop has
//! already populated on the `semantic.embedding` BLOB column:
//!
//!   1. Load every live fact (non-tombstoned) that has an embedding.
//!   2. Single-pass greedy agglomerative cluster — for each fact, scan the
//!      existing cluster heads and join the first one whose representative
//!      is within the cosine-similarity threshold. Otherwise start a new
//!      cluster. Cost is O(n · k) where k = #clusters; on real semantic
//!      memory sizes (<10 k rows) that's well under a second.
//!   3. For each cluster with >1 member, keep the highest-confidence row as
//!      the survivor, merge the set-union of tags + concatenation of
//!      distinct sources into it, and tombstone the rest by writing a
//!      `deleted_at` timestamp. Rows are never physically DELETEd — a
//!      mistaken compaction is fully reversible by clearing the column.
//!
//! ### Safety
//! * **Soft delete** — rows get `deleted_at = now`; the SELECT helpers in
//!   `semantic.rs` filter them out, so the UI and retrieval stack stop
//!   seeing them without losing the audit trail.
//! * **Threshold floor** — callers can tune the threshold but the 0.85
//!   default matches the similarity band where nomic-embed-text
//!   consistently treats paraphrases as the same statement. Below that
//!   value the clusters start pulling in merely-related (not duplicate)
//!   facts and we'd lose information.
//! * **Survivor bias** — the representative is the cluster member with the
//!   max `confidence`; ties break on most-recent `updated_at`. User-asserted
//!   facts (confidence=1.0, source="user") never lose out to inferred ones.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{now_secs, with_conn};
use super::embed::{cosine, decode_f32_le};

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/// Default cosine similarity above which two facts are treated as duplicates.
/// Chosen so paraphrases ("user likes espresso" ↔ "prefers espresso") cluster
/// but merely-related statements ("likes coffee" vs "dislikes tea") stay
/// apart. The floor enforces this minimum even if a caller tries to pass a
/// looser value.
pub const DEFAULT_THRESHOLD: f32 = 0.85;

/// Hard lower bound on the clustering threshold. A threshold below this
/// would almost certainly erase information (unrelated facts collapsing).
/// Callers asking for less are clamped up to this floor.
pub const THRESHOLD_FLOOR: f32 = 0.70;

// ---------------------------------------------------------------------------
// Public report type
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Default, TS)]
#[ts(export)]
pub struct CompactReport {
    /// How many facts were loaded (live, with embeddings).
    #[ts(type = "number")]
    pub considered: usize,
    /// How many clusters the loaded set collapsed to. Always ≤ `considered`.
    #[ts(type = "number")]
    pub clusters: usize,
    /// How many survivor rows had their tags/source merged from at least
    /// one sibling (equivalent to `clusters_with_siblings`).
    #[ts(type = "number")]
    pub merged: usize,
    /// How many rows were tombstoned (`considered - clusters`).
    #[ts(type = "number")]
    pub deleted: usize,
    /// Threshold that was actually applied (after floor clamp).
    pub threshold_used: f32,
    /// Unix seconds when compaction ran.
    #[ts(type = "number")]
    pub ran_at: i64,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Run one compaction pass on the semantic store using `threshold` (or
/// [`DEFAULT_THRESHOLD`] when `None`). Returns a [`CompactReport`]
/// summarising the outcome. Safe to re-run — a second pass collapses
/// nothing new because the first-pass survivors are already separated by
/// more than the threshold.
pub fn run_compaction(threshold: Option<f32>) -> Result<CompactReport, String> {
    let t = threshold.unwrap_or(DEFAULT_THRESHOLD).clamp(THRESHOLD_FLOOR, 0.9999);
    with_conn(|c| compact_in(c, t))
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// A fact loaded from the DB, with the bits the compactor cares about.
/// Tags live in the parsed `Vec<String>` form so the merge step is a
/// straight set-union rather than string surgery.
#[derive(Debug, Clone)]
struct LoadedFact {
    id: String,
    confidence: f64,
    updated_at: i64,
    tags: Vec<String>,
    source: String,
    embedding: Vec<f32>,
}

/// Transactional core — does everything inside a single SQLite tx so a
/// failure anywhere (e.g. a writer lock contention) rolls back the whole
/// compaction and the report reflects "no-op".
pub(crate) fn compact_in(conn: &Connection, threshold: f32) -> Result<CompactReport, String> {
    let now = now_secs();
    let facts = load_facts(conn)?;
    let considered = facts.len();
    if considered < 2 {
        return Ok(CompactReport {
            considered,
            clusters: considered,
            merged: 0,
            deleted: 0,
            threshold_used: threshold,
            ran_at: now,
        });
    }

    let clusters = cluster_facts(&facts, threshold);
    let cluster_count = clusters.len();

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("compact tx: {e}"))?;

    let mut merged = 0_usize;
    let mut deleted = 0_usize;

    for cluster in &clusters {
        if cluster.len() <= 1 {
            continue;
        }
        let (survivor_idx, survivor_id) = pick_survivor(&facts, cluster);
        let mut union_tags = facts[survivor_idx].tags.clone();
        let mut sources: Vec<String> = vec![facts[survivor_idx].source.clone()];

        for &idx in cluster {
            if idx == survivor_idx {
                continue;
            }
            for tag in &facts[idx].tags {
                if !union_tags.contains(tag) {
                    union_tags.push(tag.clone());
                }
            }
            let s = &facts[idx].source;
            if !sources.iter().any(|existing| existing == s) {
                sources.push(s.clone());
            }
            // Soft-delete the loser. The SELECT helpers filter on
            // `deleted_at IS NULL` so it immediately stops appearing in
            // UI lists and retrieval.
            tx.execute(
                "UPDATE semantic SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, facts[idx].id],
            )
            .map_err(|e| format!("tombstone {}: {e}", facts[idx].id))?;
            deleted += 1;
        }

        let tags_json = serde_json::to_string(&union_tags)
            .map_err(|e| format!("serialize merged tags: {e}"))?;
        // `+` is the conventional "multi-source" separator in the rest of
        // the memory code ("user+consolidator"); keeps parsing trivial.
        let merged_source = sources.join("+");
        tx.execute(
            "UPDATE semantic SET tags_json = ?1, source = ?2, updated_at = ?3 WHERE id = ?4",
            params![tags_json, merged_source, now, survivor_id],
        )
        .map_err(|e| format!("merge survivor {survivor_id}: {e}"))?;
        merged += 1;
    }

    // Record the last compaction run so a UI can show "last swept X ago".
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('compaction_last_run', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now.to_string()],
    )
    .map_err(|e| format!("mark compaction: {e}"))?;

    tx.commit().map_err(|e| format!("commit compact: {e}"))?;

    Ok(CompactReport {
        considered,
        clusters: cluster_count,
        merged,
        deleted,
        threshold_used: threshold,
        ran_at: now,
    })
}

/// Read the last compaction timestamp from the `meta` table. `None`
/// before the first run. Mirrors `retention::last_sweep_ts()`.
pub fn last_compaction_ts() -> Option<i64> {
    with_conn(|c| {
        let s: Option<String> = c
            .query_row(
                "SELECT value FROM meta WHERE key = 'compaction_last_run'",
                [],
                |r| r.get(0),
            )
            .ok();
        Ok(s.and_then(|v| v.parse::<i64>().ok()))
    })
    .ok()
    .flatten()
}

fn load_facts(conn: &Connection) -> Result<Vec<LoadedFact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, confidence, updated_at, tags_json, source, embedding
             FROM semantic
             WHERE deleted_at IS NULL
               AND embedding IS NOT NULL",
        )
        .map_err(|e| format!("prepare load facts: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let confidence: f64 = r.get(1)?;
            let updated_at: i64 = r.get(2)?;
            let tags_s: String = r.get(3)?;
            let source: String = r.get(4)?;
            let blob: Vec<u8> = r.get(5)?;
            Ok((id, confidence, updated_at, tags_s, source, blob))
        })
        .map_err(|e| format!("query load facts: {e}"))?;

    let mut out: Vec<LoadedFact> = Vec::new();
    for row in rows {
        let (id, confidence, updated_at, tags_s, source, blob) =
            row.map_err(|e| format!("row load facts: {e}"))?;
        let tags: Vec<String> = serde_json::from_str(&tags_s).unwrap_or_default();
        let Ok(embedding) = decode_f32_le(&blob) else {
            continue;
        };
        if embedding.is_empty() {
            continue;
        }
        out.push(LoadedFact {
            id,
            confidence,
            updated_at,
            tags,
            source,
            embedding,
        });
    }
    Ok(out)
}

/// Greedy single-pass clustering. For each fact, walk the existing cluster
/// heads (the first element of each cluster) and join the first head whose
/// similarity exceeds `threshold`; otherwise open a new cluster.
///
/// A head-only comparison (rather than full-cluster centroid) is cheap,
/// deterministic, and produces tight clusters in practice: once the head
/// is fixed, every joiner is within `threshold` of that one vector — no
/// drift across the cluster is possible.
fn cluster_facts(facts: &[LoadedFact], threshold: f32) -> Vec<Vec<usize>> {
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for (i, f) in facts.iter().enumerate() {
        let mut joined = false;
        for cluster in clusters.iter_mut() {
            let head = cluster[0];
            let sim = cosine(&facts[head].embedding, &f.embedding);
            if sim >= threshold {
                cluster.push(i);
                joined = true;
                break;
            }
        }
        if !joined {
            clusters.push(vec![i]);
        }
    }
    clusters
}

/// Pick the cluster representative: max `confidence`, ties to the most
/// recently updated row. Returns `(index_into_facts, id_string)`.
fn pick_survivor(facts: &[LoadedFact], cluster: &[usize]) -> (usize, String) {
    let best = cluster
        .iter()
        .copied()
        .max_by(|&a, &b| {
            let fa = &facts[a];
            let fb = &facts[b];
            fa.confidence
                .partial_cmp(&fb.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| fa.updated_at.cmp(&fb.updated_at))
        })
        .expect("cluster is non-empty");
    (best, facts[best].id.clone())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;
    use crate::memory::embed::encode_f32_le;
    use rusqlite::params;

    /// Insert a synthetic fact directly — bypasses the embed backfill loop
    /// so tests don't require Ollama. The `embedding` blob is the
    /// little-endian f32 encoding decode_f32_le expects.
    fn insert_with_embedding(
        conn: &Connection,
        subject: &str,
        text: &str,
        tags: &[&str],
        confidence: f64,
        source: &str,
        embedding: &[f32],
    ) -> String {
        let id = crate::memory::db::generate_id();
        let tags_json =
            serde_json::to_string(&tags.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        let now = now_secs();
        let blob = encode_f32_le(embedding);
        conn.execute(
            "INSERT INTO semantic
                (id, subject, text, tags_json, confidence, source,
                 created_at, updated_at, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![id, subject, text, tags_json, confidence, source, now, blob],
        )
        .unwrap();
        id
    }

    fn normalise(v: Vec<f32>) -> Vec<f32> {
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-8);
        v.into_iter().map(|x| x / norm).collect()
    }

    #[test]
    fn five_near_duplicates_collapse_to_one_survivor() {
        let (_dir, conn) = scratch_conn("compact-dup");
        // Five vectors all within tiny rotations of one another — cosine
        // ≈ 0.99. Any sane threshold should cluster them.
        let base = normalise(vec![1.0, 0.0, 0.0, 0.0]);
        let near1 = normalise(vec![0.99, 0.1, 0.0, 0.0]);
        let near2 = normalise(vec![0.98, 0.0, 0.1, 0.0]);
        let near3 = normalise(vec![0.99, 0.05, 0.05, 0.0]);
        let near4 = normalise(vec![0.97, 0.15, 0.0, 0.0]);

        // The user-asserted one has highest confidence → it should survive.
        let survivor_id = insert_with_embedding(
            &conn,
            "user.pref",
            "Sunny prefers espresso",
            &["drink", "morning"],
            1.0,
            "user",
            &base,
        );
        insert_with_embedding(
            &conn,
            "user.pref",
            "User likes espresso",
            &["drink", "coffee"],
            0.7,
            "consolidator",
            &near1,
        );
        insert_with_embedding(
            &conn,
            "user.pref",
            "Morning drink: espresso",
            &["morning", "habit"],
            0.6,
            "consolidator",
            &near2,
        );
        insert_with_embedding(
            &conn,
            "user.pref",
            "Likes strong coffee in AM",
            &["coffee"],
            0.5,
            "skill",
            &near3,
        );
        insert_with_embedding(
            &conn,
            "user.pref",
            "Espresso > drip for Sunny",
            &["drink"],
            0.4,
            "consolidator",
            &near4,
        );

        let report = compact_in(&conn, 0.85).unwrap();
        assert_eq!(report.considered, 5);
        assert_eq!(report.clusters, 1);
        assert_eq!(report.merged, 1);
        assert_eq!(report.deleted, 4);

        // Exactly one live row — the user-asserted survivor.
        let live: Vec<(String, String, String)> = conn
            .prepare(
                "SELECT id, tags_json, source FROM semantic WHERE deleted_at IS NULL",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].0, survivor_id, "highest confidence should win");

        // Union of tags from every cluster member is on the survivor.
        let tags: Vec<String> = serde_json::from_str(&live[0].1).unwrap();
        for expected in ["drink", "morning", "coffee", "habit"] {
            assert!(
                tags.contains(&expected.to_string()),
                "survivor missing merged tag `{expected}`: {:?}",
                tags
            );
        }

        // Source should carry every contributing origin.
        assert!(live[0].2.contains("user"));
        assert!(live[0].2.contains("consolidator"));
        assert!(live[0].2.contains("skill"));

        // Soft-deleted rows still exist physically — the tombstone is a
        // timestamp, not a DELETE. Important for rollback.
        let soft_deleted: i64 = conn
            .query_row(
                "SELECT count(*) FROM semantic WHERE deleted_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(soft_deleted, 4, "loser rows must be soft-deleted, not gone");
    }

    #[test]
    fn distinct_facts_stay_separate() {
        let (_dir, conn) = scratch_conn("compact-distinct");
        // Three orthogonal vectors — cosine = 0. No cluster should form.
        insert_with_embedding(
            &conn,
            "",
            "likes espresso",
            &["drink"],
            1.0,
            "user",
            &[1.0, 0.0, 0.0, 0.0],
        );
        insert_with_embedding(
            &conn,
            "",
            "lives in Vancouver",
            &["place"],
            1.0,
            "user",
            &[0.0, 1.0, 0.0, 0.0],
        );
        insert_with_embedding(
            &conn,
            "",
            "daughter's name is Aria",
            &["family"],
            1.0,
            "user",
            &[0.0, 0.0, 1.0, 0.0],
        );
        let report = compact_in(&conn, 0.85).unwrap();
        assert_eq!(report.considered, 3);
        assert_eq!(report.clusters, 3, "orthogonal facts should not cluster");
        assert_eq!(report.deleted, 0);
        let live: i64 = conn
            .query_row(
                "SELECT count(*) FROM semantic WHERE deleted_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(live, 3);
    }

    #[test]
    fn rerun_is_noop_after_first_compaction() {
        let (_dir, conn) = scratch_conn("compact-idem");
        let base = normalise(vec![1.0, 0.01, 0.0, 0.0]);
        let near = normalise(vec![1.0, 0.02, 0.0, 0.0]);
        insert_with_embedding(&conn, "", "a", &[], 1.0, "user", &base);
        insert_with_embedding(&conn, "", "b", &[], 0.5, "consolidator", &near);

        let first = compact_in(&conn, 0.85).unwrap();
        assert_eq!(first.deleted, 1);
        let second = compact_in(&conn, 0.85).unwrap();
        assert_eq!(second.deleted, 0, "second pass collapses nothing");
        assert_eq!(second.considered, 1, "only the survivor is considered");
    }

    #[test]
    fn empty_and_single_row_are_harmless() {
        let (_dir, conn) = scratch_conn("compact-empty");
        let r = compact_in(&conn, 0.85).unwrap();
        assert_eq!(r.considered, 0);
        assert_eq!(r.clusters, 0);
        assert_eq!(r.deleted, 0);

        insert_with_embedding(&conn, "", "only", &[], 1.0, "user", &[1.0, 0.0, 0.0, 0.0]);
        let r2 = compact_in(&conn, 0.85).unwrap();
        assert_eq!(r2.considered, 1);
        assert_eq!(r2.clusters, 1);
        assert_eq!(r2.deleted, 0);
    }

    #[test]
    fn threshold_floor_clamps_destructive_values() {
        // A 0.1 threshold would collapse unrelated facts together; the
        // floor (0.70) must clamp the caller's request.
        let report = run_compaction(Some(0.1)).unwrap_or(CompactReport {
            threshold_used: 0.0,
            ..Default::default()
        });
        // run_compaction uses the global cell; assert on the clamp
        // regardless of whether the cell is populated.
        assert!(
            report.threshold_used >= THRESHOLD_FLOOR,
            "clamp must enforce the floor"
        );
    }

    #[test]
    fn rows_without_embeddings_are_skipped() {
        let (_dir, conn) = scratch_conn("compact-no-embed");
        // Insert two rows without embedding — they should not crash the
        // loader and should be absent from the cluster set.
        conn.execute(
            "INSERT INTO semantic
                (id, subject, text, tags_json, confidence, source, created_at, updated_at)
             VALUES ('x', '', 't1', '[]', 1.0, 'user', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO semantic
                (id, subject, text, tags_json, confidence, source, created_at, updated_at)
             VALUES ('y', '', 't2', '[]', 1.0, 'user', 1, 1)",
            [],
        )
        .unwrap();
        let r = compact_in(&conn, 0.85).unwrap();
        assert_eq!(r.considered, 0, "no-embedding rows are not considered");
    }
}
