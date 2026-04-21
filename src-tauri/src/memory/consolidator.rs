//! Consolidator — support surface for the TypeScript-driven semantic
//! extraction loop.
//!
//! Division of labour:
//!   * **Rust (this module)** — tracks the last-consolidated watermark in
//!     the `meta` table, and returns episodic rows newer than that
//!     watermark (capped, filtered to fact-worthy kinds) for the frontend
//!     loop to feed into the LLM.
//!   * **TypeScript (`src/lib/consolidator.ts`)** — runs every N minutes,
//!     calls `memory_consolidator_pending()`, ships the rows to the LLM
//!     with an extraction prompt, parses the JSON reply, and writes the
//!     facts back via `memory_fact_add`. Advances the watermark by calling
//!     `memory_consolidator_mark_done(ts)` when finished.
//!
//! Doing the LLM call in TypeScript keeps the Rust side free of provider
//! plumbing (OpenClaw / Ollama / Anthropic routing already lives in the
//! frontend `chat` pipeline) and makes the consolidation visible in the UI
//! alongside normal agent runs.
//!
//! ## Watermark model (J v4 latent #1 fix)
//!
//! `created_at` is stored in unix seconds, so many rows can share the same
//! timestamp at write-heavy moments (batch ingests, retention backfills,
//! tight loops writing user + agent_step + note in the same second). The
//! original watermark was a single `ts` with a `WHERE created_at > ?1`
//! filter; when more than `PENDING_HARD_CAP` rows shared a second at a
//! batch boundary, rows past the LIMIT were permanently skipped because
//! `mark_done(ts)` advanced the watermark past their timestamp.
//!
//! Fix: use a composite `(created_at, id)` watermark. Query filter is
//! `created_at > ?1 OR (created_at = ?1 AND id > ?2)`, ordered by
//! `(created_at ASC, id ASC)`. `pending()` stashes the `(ts, id)` of the
//! last row it returned; `mark_done(ts)` promotes that stash to the
//! durable watermark when the caller's `ts` matches (the common path).
//! Callers that pass an unrelated `ts` (e.g. historical clamp-to-now)
//! still get correct forward motion — the stash just isn't used.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{now_secs, with_conn};
use super::episodic::EpisodicItem;

const META_KEY_LAST_TS: &str = "consolidator_last_run_ts";
const META_KEY_LAST_ID: &str = "consolidator_last_run_id";
const META_KEY_SERVED_TS: &str = "consolidator_served_ts";
const META_KEY_SERVED_ID: &str = "consolidator_served_id";

/// Hard cap on rows returned per pending() call — a single LLM turn can't
/// reasonably digest more and the prompt blows past context.
const PENDING_HARD_CAP: usize = 40;
/// Floor — fewer new rows than this and we defer consolidation to next tick
/// rather than burning an LLM call for a couple of events.
const PENDING_MIN_FLOOR: usize = 8;

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export)]
pub struct ConsolidationStatus {
    /// Unix seconds of the watermark — the oldest row the next pending()
    /// call will consider.
    #[ts(type = "number")]
    pub last_run_ts: i64,
    /// How many rows are currently past the watermark.
    #[ts(type = "number")]
    pub pending_count: i64,
    /// Threshold the TS loop uses to decide whether to run.
    #[ts(type = "number")]
    pub min_floor: i64,
}

/// Return up to `limit` (default 40, capped at PENDING_HARD_CAP) episodic
/// rows newer than the consolidator's watermark. Only the kinds worth
/// mining for facts (user utterances + agent answers) are returned — tool
/// calls and raw perception are too low-signal to justify the LLM round.
///
/// If there are fewer than PENDING_MIN_FLOOR new rows, returns an empty
/// vec — the caller skips this tick without advancing the watermark, so
/// rows accumulate until the floor is reached.
pub fn pending(limit: Option<usize>) -> Result<Vec<EpisodicItem>, String> {
    let requested = limit.unwrap_or(PENDING_HARD_CAP).min(PENDING_HARD_CAP);
    with_conn(|c| {
        let (w_ts, w_id) = read_watermark(c)?;
        let new_count: i64 = c
            .query_row(
                "SELECT count(*) FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')",
                params![w_ts, w_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("count pending: {e}"))?;
        if (new_count as usize) < PENDING_MIN_FLOOR {
            return Ok(Vec::new());
        }
        let mut stmt = c
            .prepare(
                "SELECT id, kind, text, tags_json, meta_json, created_at
                 FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')
                 ORDER BY created_at ASC, id ASC
                 LIMIT ?3",
            )
            .map_err(|e| format!("prep pending: {e}"))?;
        let rows = stmt
            .query_map(
                params![w_ts, w_id, requested as i64],
                row_to_episodic,
            )
            .map_err(|e| format!("query pending: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect pending: {e}"))?;

        // Stash the composite cursor of the last row we served so
        // `mark_done(ts)` can promote the full (ts, id) pair atomically.
        // Without this, the LIMIT cut across a ts-tie would lose the rows
        // that didn't make the cut.
        if let Some(tail) = rows.last() {
            write_meta(c, META_KEY_SERVED_TS, &tail.created_at.to_string())?;
            write_meta(c, META_KEY_SERVED_ID, &tail.id)?;
        }

        Ok(rows)
    })
}

/// Advance the consolidator watermark. `ts` should be the `created_at` of
/// the last row the caller successfully processed (so a subsequent call
/// picks up exactly where we left off). The watermark is also clamped up
/// to the current time on out-of-range input.
///
/// Internally the watermark is a composite `(ts, id)` pair. The `id`
/// component is recovered from the stash `pending()` leaves behind when it
/// returns rows — this is what prevents a LIMIT cut across a timestamp
/// tie from skipping rows. If the caller passes a `ts` that doesn't match
/// the stash (e.g. they clamped it, or they never called `pending()`),
/// we fall back to `(ts, "")` which preserves the pre-composite behaviour
/// for that single transition.
pub fn mark_done(ts: i64) -> Result<(), String> {
    let clamped = ts.max(0).min(now_secs());
    with_conn(|c| {
        let served_ts = read_meta_i64(c, META_KEY_SERVED_TS)?;
        let served_id = read_meta_string(c, META_KEY_SERVED_ID)?;
        let (commit_ts, commit_id) = match (served_ts, served_id) {
            (Some(sts), Some(sid)) if sts == clamped => (sts, sid),
            _ => (clamped, String::new()),
        };
        write_meta(c, META_KEY_LAST_TS, &commit_ts.to_string())?;
        write_meta(c, META_KEY_LAST_ID, &commit_id)?;
        Ok(())
    })
}

pub fn status() -> Result<ConsolidationStatus, String> {
    with_conn(|c| {
        let (w_ts, w_id) = read_watermark(c)?;
        let pending_count: i64 = c
            .query_row(
                "SELECT count(*) FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')",
                params![w_ts, w_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        Ok(ConsolidationStatus {
            last_run_ts: w_ts,
            pending_count,
            min_floor: PENDING_MIN_FLOOR as i64,
        })
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn read_watermark(conn: &Connection) -> Result<(i64, String), String> {
    let ts = read_meta_i64(conn, META_KEY_LAST_TS)?.unwrap_or(0);
    let id = read_meta_string(conn, META_KEY_LAST_ID)?.unwrap_or_default();
    Ok((ts, id))
}

fn read_meta_string(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("read meta `{key}`: {other}")),
    })
}

fn read_meta_i64(conn: &Connection, key: &str) -> Result<Option<i64>, String> {
    Ok(read_meta_string(conn, key)?.and_then(|v| v.parse::<i64>().ok()))
}

fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("write meta `{key}`: {e}"))?;
    Ok(())
}

fn row_to_episodic(r: &rusqlite::Row) -> rusqlite::Result<EpisodicItem> {
    use super::episodic::EpisodicKind;
    let id: String = r.get(0)?;
    let kind_s: String = r.get(1)?;
    let text: String = r.get(2)?;
    let tags_s: String = r.get(3)?;
    let meta_s: String = r.get(4)?;
    let created_at: i64 = r.get(5)?;
    let tags: Vec<String> = serde_json::from_str(&tags_s).unwrap_or_default();
    let meta: serde_json::Value =
        serde_json::from_str(&meta_s).unwrap_or(serde_json::Value::Null);
    // Parse via the public string→enum function by round-tripping the match
    // that episodic.rs does — kept local to avoid export juggling.
    let kind = match kind_s.as_str() {
        "user" => EpisodicKind::User,
        "agent_step" => EpisodicKind::AgentStep,
        "tool_call" => EpisodicKind::ToolCall,
        "perception" => EpisodicKind::Perception,
        "reflection" => EpisodicKind::Reflection,
        _ => EpisodicKind::Note,
    };
    Ok(EpisodicItem {
        id,
        kind,
        text,
        tags,
        meta,
        created_at,
    })
}

// ---------------------------------------------------------------------------
// Tests — exercise the composite-watermark loop with a real scratch db.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;
    use crate::memory::episodic::EpisodicKind;

    /// Local mirrors of pending/mark_done that run against a scratch
    /// connection instead of the global one — otherwise parallel tests
    /// stomp on each other through the process-wide `with_conn`.
    fn pending_in(conn: &Connection, limit: Option<usize>) -> Vec<EpisodicItem> {
        let requested = limit.unwrap_or(PENDING_HARD_CAP).min(PENDING_HARD_CAP);
        let (w_ts, w_id) = read_watermark(conn).unwrap();
        let new_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')",
                params![w_ts, w_id],
                |r| r.get(0),
            )
            .unwrap();
        if (new_count as usize) < PENDING_MIN_FLOOR {
            return Vec::new();
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, text, tags_json, meta_json, created_at
                 FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')
                 ORDER BY created_at ASC, id ASC
                 LIMIT ?3",
            )
            .unwrap();
        let rows: Vec<EpisodicItem> = stmt
            .query_map(
                params![w_ts, w_id, requested as i64],
                row_to_episodic,
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        if let Some(tail) = rows.last() {
            write_meta(conn, META_KEY_SERVED_TS, &tail.created_at.to_string()).unwrap();
            write_meta(conn, META_KEY_SERVED_ID, &tail.id).unwrap();
        }
        rows
    }

    fn mark_done_in(conn: &Connection, ts: i64) {
        let clamped = ts.max(0).min(now_secs());
        let served_ts = read_meta_i64(conn, META_KEY_SERVED_TS).unwrap();
        let served_id = read_meta_string(conn, META_KEY_SERVED_ID).unwrap();
        let (commit_ts, commit_id) = match (served_ts, served_id) {
            (Some(sts), Some(sid)) if sts == clamped => (sts, sid),
            _ => (clamped, String::new()),
        };
        write_meta(conn, META_KEY_LAST_TS, &commit_ts.to_string()).unwrap();
        write_meta(conn, META_KEY_LAST_ID, &commit_id).unwrap();
    }

    /// Insert a fact-worthy episodic row at a caller-chosen `created_at`
    /// (seconds) so we can synthesise a timestamp tie without sleeping.
    fn insert_user_at(conn: &Connection, ts: i64, text: &str) -> String {
        let id = format!("t{:06}-{}", ts, text); // deterministic, sortable tail
        conn.execute(
            "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
             VALUES (?1, 'user', ?2, '[]', 'null', ?3)",
            params![id, text, ts],
        )
        .unwrap();
        let _ = EpisodicKind::User; // keep the import live for clarity
        id
    }

    /// J v4 latent #1 regression: 41 rows share a single `created_at`
    /// second — straddling the PENDING_HARD_CAP of 40. The original
    /// single-ts watermark with `created_at > ?1` lost the 41st row
    /// forever. With the composite watermark, every row surfaces across
    /// successive pending()/mark_done() rounds.
    #[test]
    fn pending_surfaces_all_rows_across_limit_cut_on_timestamp_tie() {
        let (_dir, conn) = scratch_conn("consolidator-tie");

        // 41 rows, all stamped to the same second. Use deterministic ids
        // so we can assert full coverage without ordering ambiguity.
        let base_ts = 1_700_000_000_i64;
        let mut inserted: Vec<String> = (0..41)
            .map(|i| insert_user_at(&conn, base_ts, &format!("msg{i:02}")))
            .collect();
        inserted.sort();

        // Round 1: hits the PENDING_HARD_CAP of 40.
        let batch1 = pending_in(&conn, None);
        assert_eq!(batch1.len(), 40, "first round must saturate the hard cap");
        let last_ts_1 = batch1.last().unwrap().created_at;
        mark_done_in(&conn, last_ts_1);

        // Round 2: the 41st row must still be visible. Under the old
        // `created_at > ?1` filter this came back empty because the
        // watermark had advanced past `base_ts`.
        let batch2_raw = pending_in(&conn, None);
        // PENDING_MIN_FLOOR (8) gates the second round to empty here —
        // only 1 row remains. Confirm that the *count query* would see
        // it so we know the filter is correct, then force the surface
        // by lowering the floor expectation via a direct query.
        assert!(
            batch2_raw.is_empty(),
            "floor correctly gates a single-row tail"
        );

        // Direct count past the new composite watermark proves the row
        // is still visible — not lost to the watermark as it was before.
        let (w_ts, w_id) = read_watermark(&conn).unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT count(*) FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')",
                params![w_ts, w_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            remaining, 1,
            "the 41st row must survive the LIMIT-cut across the ts tie",
        );

        // Collect the union of ids we've either returned or still see
        // pending — together they must cover all 41 inserted rows.
        let mut seen: Vec<String> = batch1.iter().map(|r| r.id.clone()).collect();
        let mut stmt = conn
            .prepare(
                "SELECT id FROM episodic
                 WHERE (created_at > ?1 OR (created_at = ?1 AND id > ?2))
                   AND kind IN ('user', 'agent_step', 'note')",
            )
            .unwrap();
        let tail_ids: Vec<String> = stmt
            .query_map(params![w_ts, w_id], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        seen.extend(tail_ids);
        seen.sort();
        seen.dedup();
        assert_eq!(
            seen, inserted,
            "every inserted row must be reachable through the composite cursor",
        );
    }

    /// Baseline: once the floor is cleared, successive pending() calls
    /// continue to advance without revisiting prior rows.
    #[test]
    fn pending_advances_monotonically_across_rounds() {
        let (_dir, conn) = scratch_conn("consolidator-mono");

        // 50 rows spread across two seconds: 40 at t0 + 10 at t0+1.
        let t0 = 1_700_000_100_i64;
        for i in 0..40 {
            insert_user_at(&conn, t0, &format!("a{i:02}"));
        }
        for i in 0..10 {
            insert_user_at(&conn, t0 + 1, &format!("b{i:02}"));
        }

        let r1 = pending_in(&conn, None);
        assert_eq!(r1.len(), 40);
        mark_done_in(&conn, r1.last().unwrap().created_at);

        let r2 = pending_in(&conn, None);
        // 10 remaining (at t0+1) clears the floor of 8.
        assert_eq!(r2.len(), 10);
        let r1_ids: std::collections::HashSet<_> =
            r1.iter().map(|r| r.id.clone()).collect();
        for row in &r2 {
            assert!(
                !r1_ids.contains(&row.id),
                "monotonic advance: round 2 must not re-serve round-1 ids",
            );
        }
        mark_done_in(&conn, r2.last().unwrap().created_at);

        let r3 = pending_in(&conn, None);
        assert!(r3.is_empty(), "nothing left after both rounds");
    }

    /// `mark_done(ts)` with a ts that doesn't match the stash still
    /// commits forward motion — back-compat with callers that pass a
    /// synthetic / clamped ts unrelated to what pending() returned.
    #[test]
    fn mark_done_without_matching_stash_still_commits_ts() {
        let (_dir, conn) = scratch_conn("consolidator-fallback");
        let t = 1_700_000_200_i64;
        mark_done_in(&conn, t);
        let (w_ts, w_id) = read_watermark(&conn).unwrap();
        assert_eq!(w_ts, t);
        assert_eq!(w_id, "");
    }
}
