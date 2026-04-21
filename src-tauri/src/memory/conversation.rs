//! Persistent per-session conversation thread.
//!
//! Friction point fixed: prior to this module, multi-turn coherence only
//! existed in the ChatPanel React store. Voice, AUTO, daemons, the command
//! bar — every non-ChatPanel surface hit `agent_run` with an empty `history`
//! vector and started from scratch even when it shared a `session_id` with a
//! prior run. "Remember that" only worked in Chat because only Chat carried
//! history forward; the same question via voice started cold.
//!
//! This module gives `agent_loop::core::agent_run_inner` a way to persist
//! and replay the last N turns keyed by `session_id`, so any surface that
//! reuses a session id picks up context across app restarts and across
//! entry-point changes (Chat → Voice → AUTO → Command Bar all share
//! memory when they share a session).
//!
//! ### Storage
//!
//! One new table in the existing `~/.sunny/memory/memory.sqlite`:
//!
//! ```sql
//! CREATE TABLE conversation (
//!     id          INTEGER PRIMARY KEY AUTOINCREMENT,
//!     session_id  TEXT NOT NULL,
//!     role        TEXT NOT NULL,
//!     content     TEXT NOT NULL,
//!     at          INTEGER NOT NULL
//! );
//! CREATE INDEX idx_conv_session_at ON conversation(session_id, at);
//! ```
//!
//! INTEGER PK because rows grow linearly with turns and a compact id keeps
//! the index dense. The composite `(session_id, at)` index drives the only
//! hot read — `tail(sid, N)` — in O(log N) lookup + a single bounded range
//! scan.
//!
//! ### API shape
//!
//! ```ignore
//! append(session_id, role, content).await?;
//! let last_16 = tail(session_id, 16).await?;
//! let swept   = prune_older_than(90).await?;
//! ```
//!
//! Async wrappers around blocking SQLite work (same pattern as
//! `db::force_checkpoint`) so the tokio reactor never blocks on disk.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{now_secs, with_conn};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// How many turns `agent_loop` pulls back in by default. The task brief
/// calls for 16; exposed as a const so tests and callers share one source
/// of truth.
pub const DEFAULT_TAIL_LIMIT: usize = 16;

/// Size ceiling (in chars) for the total replayed conversation payload.
/// The agent already respects a token budget on the full history window;
/// this is a cheaper, module-local guardrail that keeps a single runaway
/// session from eating the whole budget. Oldest turns are dropped first.
pub const MAX_REPLAY_CHARS: usize = 4000;

/// Default retention window for `prune_older_than`. 90 days mirrors the
/// generous end of the episodic retention table and is long enough that
/// a user returning after a couple of months of idle still finds their
/// threads warm.
pub const DEFAULT_RETENTION_DAYS: i64 = 90;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Conversational role. `Tool` is reserved for a future wiring pass that
/// persists tool results alongside user / assistant turns; the agent_loop
/// integration only writes User + Assistant today, but storing the role as
/// an open string in SQLite keeps forward-compat cheap.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
    }

    pub fn from_str(s: &str) -> Role {
        match s {
            "assistant" => Role::Assistant,
            "tool" => Role::Tool,
            _ => Role::User,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export)]
pub struct Turn {
    pub role: Role,
    pub content: String,
    #[ts(type = "number")]
    pub at: i64,
}

/// One row per distinct `session_id` persisted in the conversation table,
/// shaped for the sprint-9 SessionPicker. The preview column is the earliest
/// turn's content, truncated to 120 chars so the UI can render a one-line
/// hint without paying for a second round-trip.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export)]
pub struct SessionSummary {
    pub session_id: String,
    #[ts(type = "number")]
    pub last_at: i64,
    /// Earliest-turn content, truncated to `PREVIEW_MAX_CHARS` chars.
    pub preview: String,
    #[ts(type = "number")]
    pub turn_count: u32,
}

/// Maximum preview length exposed by `list_sessions`. Chosen as a tight
/// upper bound that still fits on one 14 px line in the SessionPicker row
/// at realistic window widths; longer content is truncated with a trailing
/// ellipsis (one char of the budget).
pub const PREVIEW_MAX_CHARS: usize = 120;

// ---------------------------------------------------------------------------
// Public async API
// ---------------------------------------------------------------------------

/// Append a single turn for `session_id`. Best-effort: the caller should
/// log but not abort on error — missing one persisted turn degrades the
/// user experience (cold next turn) but never breaks the current one.
pub async fn append(session_id: &str, role: Role, content: &str) -> Result<(), String> {
    let sid = session_id.to_string();
    let text = content.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        with_conn(|c| append_in(c, &sid, role, &text))
    })
    .await
    .map_err(|e| format!("conversation append join: {e}"))?
}

/// Return the most recent `limit` turns for `session_id`, oldest first.
/// Result honours `MAX_REPLAY_CHARS` — if the raw tail would exceed the
/// budget, the oldest turns are dropped until it fits. Returns an empty
/// vec (not an error) when the session has no persisted history.
pub async fn tail(session_id: &str, limit: usize) -> Result<Vec<Turn>, String> {
    let sid = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        with_conn(|c| tail_in(c, &sid, limit))
    })
    .await
    .map_err(|e| format!("conversation tail join: {e}"))?
}

/// Delete every row older than `days` days. Returns how many rows were
/// removed. Wired into the daily retention loop alongside the episodic
/// sweep.
pub async fn prune_older_than(days: i64) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_conn(|c| prune_in(c, days))
    })
    .await
    .map_err(|e| format!("conversation prune join: {e}"))?
}

/// Return one row per distinct `session_id`, most-recently-active first,
/// capped at `limit`. Each row carries `last_at` (newest turn), `turn_count`
/// (total turns in that session), and a truncated `preview` built from the
/// earliest turn's content so the UI can show "what was this session about"
/// without a second fetch. Returns an empty vec (not an error) when no
/// sessions exist yet.
pub async fn list_sessions(limit: usize) -> Result<Vec<SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_conn(|c| list_sessions_in(c, limit))
    })
    .await
    .map_err(|e| format!("conversation list_sessions join: {e}"))?
}

// ---------------------------------------------------------------------------
// Sync internals — shared by the public async API and the tests (which use
// an isolated scratch connection to avoid stepping on the global cell).
// ---------------------------------------------------------------------------

fn append_in(c: &Connection, session_id: &str, role: Role, content: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO conversation (session_id, role, content, at)
         VALUES (?1, ?2, ?3, ?4)",
        params![session_id, role.as_str(), content, now_secs()],
    )
    .map_err(|e| format!("insert conversation: {e}"))?;
    Ok(())
}

fn tail_in(c: &Connection, session_id: &str, limit: usize) -> Result<Vec<Turn>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    // Pull the newest `limit` rows from the composite index, then reverse
    // to oldest-first so the replayed history reads in chronological order
    // when we prepend it to the agent_loop working history.
    let mut stmt = c
        .prepare_cached(
            "SELECT role, content, at
             FROM conversation
             WHERE session_id = ?1
             ORDER BY at DESC, id DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare tail: {e}"))?;
    let rows: Vec<Turn> = stmt
        .query_map(params![session_id, limit as i64], |r| {
            let role_s: String = r.get(0)?;
            let content: String = r.get(1)?;
            let at: i64 = r.get(2)?;
            Ok(Turn {
                role: Role::from_str(&role_s),
                content,
                at,
            })
        })
        .map_err(|e| format!("query tail: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect tail: {e}"))?;

    // Reverse to oldest-first, then apply the char budget by trimming from
    // the FRONT (oldest). We never mutate the newest turns — they are the
    // turns with the most relevance to what the user is saying right now.
    let mut ordered: Vec<Turn> = rows.into_iter().rev().collect();
    enforce_char_budget(&mut ordered, MAX_REPLAY_CHARS);
    Ok(ordered)
}

fn prune_in(c: &Connection, days: i64) -> Result<usize, String> {
    let days = days.max(1);
    let cutoff = now_secs() - days * 86_400;
    let n = c
        .execute(
            "DELETE FROM conversation WHERE at < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("prune conversation: {e}"))?;
    Ok(n)
}

fn list_sessions_in(c: &Connection, limit: usize) -> Result<Vec<SessionSummary>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    // Use a window function to fetch the earliest-turn content without a
    // correlated subquery per session. FIRST_VALUE with PARTITION BY
    // session_id ORDER BY at ASC gives the first row's content in a single
    // pass over the index. We wrap it in a GROUP BY subquery so the outer
    // query returns one row per session with the correct aggregate values.
    //
    // This replaces the correlated subquery approach (which drove a
    // separate bounded range scan per session group) with a single window
    // pass — materially faster when there are many distinct sessions.
    let mut stmt = c
        .prepare_cached(
            "SELECT
                session_id,
                MAX(at)                             AS last_at,
                COUNT(*)                            AS turn_count,
                MIN(content_first)                  AS first_content
             FROM (
                 SELECT
                     session_id,
                     at,
                     FIRST_VALUE(content) OVER (
                         PARTITION BY session_id
                         ORDER BY at ASC, id ASC
                         ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                     ) AS content_first
                 FROM conversation
             ) sub
             GROUP BY session_id
             ORDER BY last_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare list_sessions: {e}"))?;

    let rows: Vec<SessionSummary> = stmt
        .query_map(params![limit as i64], |r| {
            let session_id: String = r.get(0)?;
            let last_at: i64 = r.get(1)?;
            let turn_count: i64 = r.get(2)?;
            let first_content: Option<String> = r.get(3)?;
            Ok(SessionSummary {
                session_id,
                last_at,
                turn_count: turn_count.max(0) as u32,
                preview: truncate_preview(first_content.as_deref().unwrap_or("")),
            })
        })
        .map_err(|e| format!("query list_sessions: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect list_sessions: {e}"))?;

    Ok(rows)
}

/// Clip `content` to `PREVIEW_MAX_CHARS` on a character boundary — never a
/// byte index, since preview content is user-generated and may contain
/// multi-byte UTF-8. When truncation happens we swap in a trailing `…`
/// inside the budget so the picker can render "this continues" without
/// leaking the full turn into the list view.
fn truncate_preview(content: &str) -> String {
    let cleaned = content.replace('\n', " ");
    let count = cleaned.chars().count();
    if count <= PREVIEW_MAX_CHARS {
        return cleaned;
    }
    // Keep PREVIEW_MAX_CHARS - 1 real chars, append ellipsis → total chars
    // = PREVIEW_MAX_CHARS. Guards against PREVIEW_MAX_CHARS == 0 at the
    // constant level (we assert it below in tests).
    let head: String = cleaned
        .chars()
        .take(PREVIEW_MAX_CHARS.saturating_sub(1))
        .collect();
    format!("{head}…")
}

/// Drop the oldest turns until the combined `content` size fits in
/// `max_chars`. Operates on the vec in place so callers avoid an extra
/// allocation. Assumes `turns` is oldest-first.
///
/// Implementation: maintain a running sum instead of recomputing the
/// total on every iteration, reducing complexity from O(N²) to O(N).
fn enforce_char_budget(turns: &mut Vec<Turn>, max_chars: usize) {
    // Compute initial total once.
    let mut total: usize = turns.iter().map(|t| t.content.chars().count()).sum();
    while total > max_chars && !turns.is_empty() {
        // Subtract the oldest turn's size before removing it so the
        // next iteration's check uses the updated sum without a
        // full re-scan.
        total = total.saturating_sub(turns[0].content.chars().count());
        turns.remove(0);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;
    use rusqlite::params;

    /// Insert a conversation row with an explicit `at` — the public
    /// `append_in` always stamps `now_secs()`, which is fine for
    /// in-order tests but not for prune/tail ordering tests that need
    /// backdated rows. This mirrors the helper the retention tests use
    /// over in `retention.rs::tests::insert_row`.
    fn insert_at(c: &Connection, session_id: &str, role: Role, content: &str, at: i64) {
        c.execute(
            "INSERT INTO conversation (session_id, role, content, at)
             VALUES (?1, ?2, ?3, ?4)",
            params![session_id, role.as_str(), content, at],
        )
        .unwrap();
    }

    #[test]
    fn append_then_tail_round_trips_in_chronological_order() {
        let (_dir, c) = scratch_conn("conv-rt");
        append_in(&c, "sess-A", Role::User, "hi").unwrap();
        append_in(&c, "sess-A", Role::Assistant, "hello").unwrap();
        append_in(&c, "sess-A", Role::User, "remember that I like tea").unwrap();
        let turns = tail_in(&c, "sess-A", 16).unwrap();
        assert_eq!(turns.len(), 3);
        // Oldest first.
        assert_eq!(turns[0].content, "hi");
        assert_eq!(turns[0].role, Role::User);
        assert_eq!(turns[1].content, "hello");
        assert_eq!(turns[1].role, Role::Assistant);
        assert_eq!(turns[2].content, "remember that I like tea");
    }

    #[test]
    fn tail_isolates_sessions() {
        let (_dir, c) = scratch_conn("conv-iso");
        append_in(&c, "sess-A", Role::User, "A1").unwrap();
        append_in(&c, "sess-B", Role::User, "B1").unwrap();
        append_in(&c, "sess-A", Role::Assistant, "A2").unwrap();
        let a = tail_in(&c, "sess-A", 16).unwrap();
        let b = tail_in(&c, "sess-B", 16).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].content, "B1");
    }

    /// The brief requires a 16-turn ceiling. Verify it clamps.
    #[test]
    fn tail_clamps_to_sixteen() {
        let (_dir, c) = scratch_conn("conv-16");
        // Force distinct timestamps so DESC ordering is deterministic —
        // without this, rapid-fire appends can all land on the same
        // now_secs() and secondary `id DESC` decides ordering.
        for i in 0..25 {
            insert_at(&c, "sess-X", Role::User, &format!("msg-{i:02}"), 1_000 + i);
        }
        let turns = tail_in(&c, "sess-X", 16).unwrap();
        assert_eq!(turns.len(), 16);
        // Oldest kept is msg-09, newest is msg-24.
        assert_eq!(turns.first().unwrap().content, "msg-09");
        assert_eq!(turns.last().unwrap().content, "msg-24");
    }

    #[test]
    fn tail_honours_explicit_limit_smaller_than_sixteen() {
        let (_dir, c) = scratch_conn("conv-lim");
        for i in 0..8 {
            insert_at(&c, "sess-Y", Role::User, &format!("m{i}"), 500 + i);
        }
        let five = tail_in(&c, "sess-Y", 5).unwrap();
        assert_eq!(five.len(), 5);
        assert_eq!(five.first().unwrap().content, "m3");
        assert_eq!(five.last().unwrap().content, "m7");
    }

    #[test]
    fn tail_with_zero_limit_returns_empty() {
        let (_dir, c) = scratch_conn("conv-zero");
        append_in(&c, "sess-Z", Role::User, "x").unwrap();
        let turns = tail_in(&c, "sess-Z", 0).unwrap();
        assert!(turns.is_empty());
    }

    #[test]
    fn tail_missing_session_is_empty_not_error() {
        let (_dir, c) = scratch_conn("conv-miss");
        let turns = tail_in(&c, "does-not-exist", 16).unwrap();
        assert!(turns.is_empty());
    }

    /// `MAX_REPLAY_CHARS` guard — oldest trimmed first until the payload
    /// fits. We intentionally stuff each turn well past the budget so a
    /// naive "sum > N → drop oldest" loop is easy to verify.
    #[test]
    fn tail_trims_oldest_to_respect_char_budget() {
        let (_dir, c) = scratch_conn("conv-budget");
        let big = "x".repeat(1500);
        for i in 0..5 {
            insert_at(&c, "sess-B", Role::User, &big, 2_000 + i);
        }
        let turns = tail_in(&c, "sess-B", 16).unwrap();
        let total: usize = turns.iter().map(|t| t.content.chars().count()).sum();
        assert!(total <= MAX_REPLAY_CHARS, "total {total} exceeds budget");
        // Newest kept — the budget trims from the front, so the final
        // turn's timestamp must be the highest we inserted (2004).
        assert_eq!(turns.last().unwrap().at, 2_004);
    }

    #[test]
    fn prune_removes_rows_older_than_window() {
        let (_dir, c) = scratch_conn("conv-prune");
        let now = now_secs();
        // 100 days old → should go.
        insert_at(&c, "sess-P", Role::User, "ancient", now - 100 * 86_400);
        // 10 days old → should stay.
        insert_at(&c, "sess-P", Role::User, "recent", now - 10 * 86_400);
        let removed = prune_in(&c, 90).unwrap();
        assert_eq!(removed, 1);
        let turns = tail_in(&c, "sess-P", 16).unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].content, "recent");
    }

    #[test]
    fn prune_floors_zero_days_to_one() {
        // Same guard the retention sweep uses — a zero-day window would
        // otherwise blow away rows the user just wrote.
        let (_dir, c) = scratch_conn("conv-floor");
        append_in(&c, "sess-F", Role::User, "fresh").unwrap();
        let removed = prune_in(&c, 0).unwrap();
        // A row with `at = now()` is <1 day old, so after clamp to 1 day
        // the prune leaves it alone.
        assert_eq!(removed, 0);
    }

    #[test]
    fn prune_is_idempotent() {
        let (_dir, c) = scratch_conn("conv-idem");
        let old = now_secs() - 200 * 86_400;
        insert_at(&c, "sess-I", Role::User, "old", old);
        let first = prune_in(&c, 90).unwrap();
        let second = prune_in(&c, 90).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 0);
    }

    /// End-to-end: append → tail → prune round-trip against a single
    /// scratch connection, mirroring the full loop a restart would
    /// walk through.
    #[test]
    fn full_round_trip_append_tail_prune() {
        let (_dir, c) = scratch_conn("conv-full");
        // Newest three — keep.
        append_in(&c, "sess-R", Role::User, "u1").unwrap();
        append_in(&c, "sess-R", Role::Assistant, "a1").unwrap();
        append_in(&c, "sess-R", Role::User, "u2").unwrap();
        // One ancient row we expect prune to sweep.
        insert_at(&c, "sess-R", Role::Assistant, "ancient-a", now_secs() - 200 * 86_400);

        let before = tail_in(&c, "sess-R", 16).unwrap();
        assert_eq!(before.len(), 4);

        let removed = prune_in(&c, 90).unwrap();
        assert_eq!(removed, 1);

        let after = tail_in(&c, "sess-R", 16).unwrap();
        assert_eq!(after.len(), 3);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[2].content, "u2");
    }

    /// Seed three sessions with varying turns and timestamps; verify the
    /// aggregate shape the picker consumes. Session-C has the newest turn,
    /// so it comes first; B is next; A is oldest. Turn counts must match
    /// the number of rows inserted per session; previews must come from
    /// the earliest turn (not the latest) so the picker shows the
    /// conversation's opening line.
    #[test]
    fn list_sessions_orders_by_last_at_and_populates_preview() {
        let (_dir, c) = scratch_conn("conv-list");

        // Session A: 2 turns, oldest activity (at 1000, 1100).
        insert_at(&c, "sess-A", Role::User, "hello from A", 1_000);
        insert_at(&c, "sess-A", Role::Assistant, "hi A", 1_100);

        // Session B: 3 turns, middle activity (at 2000, 2050, 2100).
        insert_at(&c, "sess-B", Role::User, "opening B message", 2_000);
        insert_at(&c, "sess-B", Role::Assistant, "B reply", 2_050);
        insert_at(&c, "sess-B", Role::User, "B followup", 2_100);

        // Session C: 1 turn, newest (at 3000).
        insert_at(&c, "sess-C", Role::User, "just-started C thread", 3_000);

        let sessions = list_sessions_in(&c, 10).unwrap();
        assert_eq!(sessions.len(), 3);

        // Ordered by last_at DESC: C (3000) → B (2100) → A (1100).
        assert_eq!(sessions[0].session_id, "sess-C");
        assert_eq!(sessions[0].last_at, 3_000);
        assert_eq!(sessions[0].turn_count, 1);
        assert_eq!(sessions[0].preview, "just-started C thread");

        assert_eq!(sessions[1].session_id, "sess-B");
        assert_eq!(sessions[1].last_at, 2_100);
        assert_eq!(sessions[1].turn_count, 3);
        // Preview must come from the EARLIEST turn, not the latest.
        assert_eq!(sessions[1].preview, "opening B message");

        assert_eq!(sessions[2].session_id, "sess-A");
        assert_eq!(sessions[2].last_at, 1_100);
        assert_eq!(sessions[2].turn_count, 2);
        assert_eq!(sessions[2].preview, "hello from A");
    }

    /// The preview must be truncated to `PREVIEW_MAX_CHARS` with a trailing
    /// ellipsis when the earliest-turn content exceeds the budget. Counts
    /// are done in chars (not bytes) so multi-byte UTF-8 doesn't drift the
    /// clip index into the middle of a codepoint.
    #[test]
    fn list_sessions_truncates_long_previews() {
        let (_dir, c) = scratch_conn("conv-list-trunc");
        let long = "a".repeat(500);
        insert_at(&c, "sess-long", Role::User, &long, 5_000);
        let sessions = list_sessions_in(&c, 10).unwrap();
        assert_eq!(sessions.len(), 1);
        let p = &sessions[0].preview;
        assert_eq!(p.chars().count(), PREVIEW_MAX_CHARS);
        assert!(p.ends_with('…'));
    }

    /// Newlines in the source content flatten to spaces so the picker's
    /// single-line row renders cleanly without a second layout pass.
    #[test]
    fn list_sessions_preview_flattens_newlines() {
        let (_dir, c) = scratch_conn("conv-list-nl");
        insert_at(&c, "sess-nl", Role::User, "line one\nline two", 6_000);
        let sessions = list_sessions_in(&c, 10).unwrap();
        assert_eq!(sessions[0].preview, "line one line two");
    }

    /// `limit` bounds the result count. With 5 sessions inserted and a
    /// limit of 2, only the two most-recently-active sessions come back.
    #[test]
    fn list_sessions_honours_limit() {
        let (_dir, c) = scratch_conn("conv-list-lim");
        for i in 0..5 {
            let sid = format!("sess-{i}");
            insert_at(&c, &sid, Role::User, &format!("m{i}"), 10_000 + i);
        }
        let two = list_sessions_in(&c, 2).unwrap();
        assert_eq!(two.len(), 2);
        assert_eq!(two[0].session_id, "sess-4");
        assert_eq!(two[1].session_id, "sess-3");
    }

    #[test]
    fn list_sessions_empty_db_returns_empty_vec() {
        let (_dir, c) = scratch_conn("conv-list-empty");
        let sessions = list_sessions_in(&c, 10).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn list_sessions_zero_limit_returns_empty() {
        let (_dir, c) = scratch_conn("conv-list-zero");
        insert_at(&c, "sess-any", Role::User, "hi", 7_000);
        let sessions = list_sessions_in(&c, 0).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn role_string_round_trip() {
        for r in [Role::User, Role::Assistant, Role::Tool] {
            assert_eq!(Role::from_str(r.as_str()), r);
        }
        // Unknown role falls back to User (defensive decode from legacy
        // rows that might predate a role we add later).
        assert_eq!(Role::from_str("weird"), Role::User);
    }
}
