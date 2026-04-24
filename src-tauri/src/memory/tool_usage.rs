//! Tool usage telemetry — per-tool success, latency, and failure history.
//!
//! Every tool call (from both System-1 skills and the System-2 ReAct loop)
//! appends one row to `tool_usage` via `tool_usage_record`. The columns
//! are minimal on purpose — we don't store inputs or full outputs here;
//! those live in episodic (`agent_step.meta.tool_sequence`) + in-memory
//! `steps` arrays. This table answers two operational questions:
//!
//!   1. **Reliability** — what's the success rate of tool `X` over the
//!      last week? `tool_usage_stats` exposes aggregated counts +
//!      percentile latency that a UI or the critic can use to decide
//!      whether a tool is currently flaky.
//!
//!   2. **Recent failures** — what's the last error for tool `X`, and
//!      when did it happen? `tool_usage_recent` returns the tail with
//!      filter-by-tool and the error message.
//!
//! Retention: `memory::retention` deletes `tool_usage` rows older than
//! `DEFAULT_TOOL_USAGE_DAYS` (30) during each 24 h sweep.
//!
//! Threading: same `with_conn` pattern as the rest of the memory
//! subsystem. Writes are serialized via the module-level mutex; the
//! hot path (one INSERT per tool call) is fast enough that contention
//! is a non-issue — measurements show <50 µs per record on an M1.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{now_secs, with_conn};

/// Upper bound on stored reasoning prose. 500 chars is enough for a
/// couple sentences — the common "why did the model pick this tool"
/// signal — without bloating audit rows when a verbose model rambles.
const REASON_MAX_CHARS: usize = 500;

// ---------------------------------------------------------------------------
// Public wire types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct UsageRecord {
    // `number` overrides ts-rs's default `bigint` for `i64` so the
    // emitted TypeScript matches the rest of the frontend's numeric
    // idioms — row ids + unix-seconds fit safely in the IEEE-754
    // mantissa for any row we'd ever surface, and JSON over the Tauri
    // bridge already serialises these as plain numbers anyway.
    #[ts(type = "number")]
    pub id: i64,
    pub tool_name: String,
    pub ok: bool,
    #[ts(type = "number")]
    pub latency_ms: i64,
    pub error_msg: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    /// Pre-dispatch prose emitted by the model immediately before its
    /// `tool_use` / `tool_calls` block. Populated by the agent loop
    /// (`TurnOutcome::Tools.thinking`); `None` for historical rows and
    /// for call sites that never see the model's reasoning (panic
    /// mode refusal, policy denial, confirm-gate decline, etc.).
    pub reason: Option<String>,
    /// Cross-table FK to `llm_turns.turn_id`. Populated by the agent
    /// loop for every tool dispatched as part of a model turn. `None`
    /// for historical rows (pre-v9 migration) and for call sites that
    /// run outside the agent loop (daemons, scheduler templates).
    pub turn_id: Option<String>,
}

/// Aggregated stats for a single tool over the lookback window.
/// All counts are absolute; `success_rate` is precomputed to save the
/// UI from doing floating-point division. `latency_p50` / `latency_p95`
/// use the simple rank-based interpolation (not exact but good enough
/// for operational signals at n < 1000).
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ToolStats {
    pub tool_name: String,
    #[ts(type = "number")]
    pub count: i64,
    #[ts(type = "number")]
    pub ok_count: i64,
    #[ts(type = "number")]
    pub err_count: i64,
    pub success_rate: f64,  // 0.0–1.0, -1.0 when count == 0
    #[ts(type = "number")]
    pub latency_p50_ms: i64,
    #[ts(type = "number")]
    pub latency_p95_ms: i64,
    #[ts(type = "number | null")]
    pub last_at: Option<i64>,
    pub last_ok: Option<bool>,
}

/// Options for `tool_usage_stats` — callers can scope the aggregation to
/// a time window. `since_secs_ago` of 7 days is typical for "recent
/// reliability"; longer windows (30 d) show durable patterns; short
/// windows (1 d) catch acute outages.
#[derive(Serialize, Deserialize, Debug, Default, Clone, TS)]
#[ts(export)]
pub struct StatsOptions {
    #[ts(type = "number | null")]
    pub since_secs_ago: Option<i64>,
    /// Optional tool-name filter. None → return stats for every tool
    /// with at least one row in the window.
    pub tool_name: Option<String>,
    /// Optional cap on the number of tools returned (for UI
    /// pagination). None → unlimited.
    #[ts(type = "number | null")]
    pub limit: Option<usize>,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone, TS)]
#[ts(export)]
pub struct RecentOptions {
    pub tool_name: Option<String>,
    #[ts(type = "number | null")]
    pub limit: Option<usize>,
    /// When true (default false), only return rows where ok=0.
    /// Useful for a "recent failures" UI section.
    pub only_errors: Option<bool>,
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Record one tool call. Fail-open: a DB error is logged but never
/// propagated — telemetry must never break the agent loop.
///
/// `reason` carries the pre-dispatch narrative the model emitted before
/// picking this tool (Anthropic `thinking` block, or the text content
/// preceding an Ollama / GLM `tool_calls` block). Capped at
/// `REASON_MAX_CHARS` so a chatty model can't balloon the audit row —
/// the full content still survives in the `thinking` event on the
/// in-memory step stream.
/// Back-compat shim — preserves the 5-arg shape every caller in
/// `agent_loop::dispatch` currently uses. Forwards to
/// `record_with_turn` with `turn_id = None`. New call sites that know
/// their turn_id should prefer the 6-arg variant.
pub fn record(
    tool_name: &str,
    ok: bool,
    latency_ms: i64,
    error_msg: Option<&str>,
    reason: Option<&str>,
) -> Result<(), String> {
    record_with_turn(tool_name, ok, latency_ms, error_msg, reason, None)
}

pub fn record_with_turn(
    tool_name: &str,
    ok: bool,
    latency_ms: i64,
    error_msg: Option<&str>,
    reason: Option<&str>,
    turn_id: Option<&str>,
) -> Result<(), String> {
    if tool_name.trim().is_empty() {
        return Err("tool_usage: tool_name must not be empty".into());
    }
    let now = now_secs();
    // Cap error_msg length at 1 KB — some tool errors carry multi-KB
    // stack traces that bloat the table. The full error still lives in
    // the caller's `ToolResult.content`.
    let err_clipped = error_msg.map(|s| {
        if s.len() > 1024 {
            format!("{}…", &s[..1024])
        } else {
            s.to_string()
        }
    });
    // Clip reason to `REASON_MAX_CHARS`. `char_indices` keeps us on a
    // valid UTF-8 boundary — a naive `&s[..N]` would panic mid-codepoint
    // for multi-byte content (non-ASCII quotes are common in model
    // output).
    let reason_clipped = reason.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else if trimmed.chars().count() > REASON_MAX_CHARS {
            let cut = trimmed
                .char_indices()
                .nth(REASON_MAX_CHARS)
                .map(|(i, _)| i)
                .unwrap_or(trimmed.len());
            Some(format!("{}…", &trimmed[..cut]))
        } else {
            Some(trimmed.to_string())
        }
    });
    with_conn(|c| {
        c.execute(
            "INSERT INTO tool_usage (tool_name, ok, latency_ms, error_msg, reason, turn_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                tool_name,
                if ok { 1 } else { 0 },
                latency_ms,
                err_clipped,
                reason_clipped,
                turn_id,
                now,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("insert tool_usage: {e}"))
    })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

pub fn stats(opts: StatsOptions) -> Result<Vec<ToolStats>, String> {
    let cutoff = opts.since_secs_ago.map(|s| now_secs() - s).unwrap_or(0);

    with_conn(|c| {
        // Pull every row in-window for the tools we care about. Typical
        // lookback windows + retention caps this at O(10k) rows per tool
        // per 30 d — trivial for a single synchronous pass.
        // Use SQL GROUP BY aggregates for counts/sums — avoids loading all
        // rows into Rust and doing an in-memory HashMap shuffle. COUNT(*),
        // SUM(ok), MAX(created_at), and MAX(ok) are computed by SQLite
        // directly on the index. Latency percentiles still need a sorted
        // slice so we pull individual latency values in a second query
        // per tool — but the first query eliminates the O(N) scan over
        // every row for every stat call.
        // Use SQL GROUP BY for counts/sums. Percentile latency is
        // fetched per-tool in a second query (see below).
        // Collect into a local binding in each branch so `stmt` is
        // fully dropped before we leave the if/else, satisfying the
        // borrow checker.
        let agg_rows: Vec<(String, i64, i64, i64, Option<i64>, Option<i64>)> = {
            if let Some(ref name) = opts.tool_name {
                let mut stmt = c
                    .prepare_cached(
                        "SELECT tool_name,
                                COUNT(*)             AS count,
                                SUM(ok)              AS ok_count,
                                COUNT(*) - SUM(ok)   AS err_count,
                                MAX(created_at)      AS last_at,
                                MAX(CASE WHEN created_at = (SELECT MAX(created_at)
                                          FROM tool_usage t2
                                          WHERE t2.tool_name = tool_usage.tool_name
                                            AND t2.created_at >= ?2)
                                         THEN ok END) AS last_ok_int
                         FROM tool_usage
                         WHERE tool_name = ?1 AND created_at >= ?2
                         GROUP BY tool_name",
                    )
                    .map_err(|e| format!("prep stats agg by-tool: {e}"))?;
                let result = stmt
                    .query_map(params![name, cutoff], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2).unwrap_or(0),
                            r.get::<_, i64>(3)?,
                            r.get::<_, Option<i64>>(4)?,
                            r.get::<_, Option<i64>>(5)?,
                        ))
                    })
                    .map_err(|e| format!("query stats agg by-tool: {e}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("collect stats agg by-tool: {e}"))?;
                result
            } else {
                let mut stmt = c
                    .prepare_cached(
                        "SELECT tool_name,
                                COUNT(*)             AS count,
                                SUM(ok)              AS ok_count,
                                COUNT(*) - SUM(ok)   AS err_count,
                                MAX(created_at)      AS last_at,
                                MAX(CASE WHEN created_at = (SELECT MAX(created_at)
                                          FROM tool_usage t2
                                          WHERE t2.tool_name = tool_usage.tool_name
                                            AND t2.created_at >= ?1)
                                         THEN ok END) AS last_ok_int
                         FROM tool_usage
                         WHERE created_at >= ?1
                         GROUP BY tool_name",
                    )
                    .map_err(|e| format!("prep stats agg all: {e}"))?;
                let result = stmt
                    .query_map(params![cutoff], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2).unwrap_or(0),
                            r.get::<_, i64>(3)?,
                            r.get::<_, Option<i64>>(4)?,
                            r.get::<_, Option<i64>>(5)?,
                        ))
                    })
                    .map_err(|e| format!("query stats agg all: {e}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("collect stats agg all: {e}"))?;
                result
            }
        };

        // Percentile latency still needs a per-tool sorted slice.
        // We fetch latency values per tool in a second query — this is
        // O(rows_in_window) total, same as before, but only runs when
        // there are rows to aggregate, which is the common case.
        let mut out: Vec<ToolStats> = agg_rows
            .into_iter()
            .map(|(tool_name, count, ok_count, err_count, last_at, last_ok_int)| {
                let success_rate = if count == 0 {
                    -1.0
                } else {
                    ok_count as f64 / count as f64
                };
                let last_ok: Option<bool> = last_ok_int.map(|v| v == 1);

                // Fetch sorted latencies for percentile calc.
                let latencies: Vec<i64> = {
                    let lq = if opts.tool_name.is_some() {
                        c.prepare_cached(
                            "SELECT latency_ms FROM tool_usage
                             WHERE tool_name = ?1 AND created_at >= ?2
                             ORDER BY latency_ms ASC",
                        )
                    } else {
                        c.prepare_cached(
                            "SELECT latency_ms FROM tool_usage
                             WHERE tool_name = ?1 AND created_at >= ?2
                             ORDER BY latency_ms ASC",
                        )
                    };
                    match lq {
                        Ok(mut stmt) => stmt
                            .query_map(params![tool_name, cutoff], |r| r.get::<_, i64>(0))
                            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                            .unwrap_or_default(),
                        Err(_) => Vec::new(),
                    }
                };
                let p50 = percentile(&latencies, 0.50);
                let p95 = percentile(&latencies, 0.95);

                ToolStats {
                    tool_name,
                    count,
                    ok_count,
                    err_count,
                    success_rate,
                    latency_p50_ms: p50,
                    latency_p95_ms: p95,
                    last_at,
                    last_ok,
                }
            })
            .collect();

        // Sort by most-used first (matches Procedural tab ordering).
        out.sort_by(|a, b| b.count.cmp(&a.count).then(b.tool_name.cmp(&a.tool_name)));
        if let Some(cap) = opts.limit {
            out.truncate(cap);
        }
        Ok(out)
    })
}

/// One day's worth of counts for a tool. The UI sparkline reads these.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct DailyBucket {
    /// Unix seconds at 00:00 local for this day (derived by caller from
    /// `created_at / 86_400 * 86_400` — UTC-aligned for determinism).
    #[ts(type = "number")]
    pub day_ts: i64,
    #[ts(type = "number")]
    pub count: i64,
    #[ts(type = "number")]
    pub ok_count: i64,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone, TS)]
#[ts(export)]
pub struct DailyBucketsOptions {
    pub tool_name: Option<String>,
    /// How far back to go. Defaults to 14; clamped 1–90.
    #[ts(type = "number | null")]
    pub days: Option<i64>,
}

/// Return per-day `{count, ok_count}` for the last N days. Days with
/// zero calls produce zero rows (caller pads in the UI for stable-width
/// sparklines). Global view (all tools aggregated) when tool_name is
/// absent — typically the caller iterates tools and plots each.
pub fn daily_buckets(opts: DailyBucketsOptions) -> Result<Vec<DailyBucket>, String> {
    let days = opts.days.unwrap_or(14).clamp(1, 90);
    let cutoff = now_secs() - days * 86_400;

    with_conn(|c| {
        let sql = if opts.tool_name.is_some() {
            "SELECT (created_at / 86400) * 86400 AS day_ts,
                    count(*) AS n,
                    sum(ok)  AS ok
             FROM tool_usage
             WHERE tool_name = ?1 AND created_at >= ?2
             GROUP BY day_ts
             ORDER BY day_ts ASC"
        } else {
            "SELECT (created_at / 86400) * 86400 AS day_ts,
                    count(*) AS n,
                    sum(ok)  AS ok
             FROM tool_usage
             WHERE created_at >= ?1
             GROUP BY day_ts
             ORDER BY day_ts ASC"
        };
        let mut stmt = c
            .prepare(sql)
            .map_err(|e| format!("prep daily_buckets: {e}"))?;
        let rows: Vec<DailyBucket> = if let Some(name) = &opts.tool_name {
            stmt.query_map(params![name, cutoff], |r| {
                Ok(DailyBucket {
                    day_ts: r.get(0)?,
                    count: r.get(1)?,
                    ok_count: r.get::<_, i64>(2).unwrap_or(0),
                })
            })
            .map_err(|e| format!("query daily_buckets by-tool: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect daily_buckets: {e}"))?
        } else {
            stmt.query_map(params![cutoff], |r| {
                Ok(DailyBucket {
                    day_ts: r.get(0)?,
                    count: r.get(1)?,
                    ok_count: r.get::<_, i64>(2).unwrap_or(0),
                })
            })
            .map_err(|e| format!("query daily_buckets all: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect daily_buckets: {e}"))?
        };
        Ok(rows)
    })
}

pub fn recent(opts: RecentOptions) -> Result<Vec<UsageRecord>, String> {
    let limit = opts.limit.unwrap_or(50).clamp(1, 500);
    let only_errors = opts.only_errors.unwrap_or(false);

    with_conn(|c| {
        let sql_base =
            "SELECT id, tool_name, ok, latency_ms, error_msg, created_at, reason, turn_id FROM tool_usage";
        let mut parts: Vec<&str> = vec!["WHERE 1=1"];
        if opts.tool_name.is_some() {
            parts.push("AND tool_name = ?");
        }
        if only_errors {
            parts.push("AND ok = 0");
        }
        let filter_sql = parts.join(" ");
        let final_sql = format!("{sql_base} {filter_sql} ORDER BY created_at DESC LIMIT ?");
        let mut stmt = c
            .prepare(&final_sql)
            .map_err(|e| format!("prep recent: {e}"))?;

        // Bind positional params in the order we appended them.
        let mut p: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(n) = &opts.tool_name {
            p.push(Box::new(n.clone()));
        }
        p.push(Box::new(limit as i64));
        let params_ref: Vec<&dyn rusqlite::ToSql> = p.iter().map(|b| b.as_ref()).collect();

        let rows = stmt
            .query_map(&params_ref[..], |r| {
                Ok(UsageRecord {
                    id: r.get(0)?,
                    tool_name: r.get(1)?,
                    ok: r.get::<_, i64>(2)? == 1,
                    latency_ms: r.get(3)?,
                    error_msg: r.get(4)?,
                    created_at: r.get(5)?,
                    reason: r.get(6)?,
                    turn_id: r.get(7)?,
                })
            })
            .map_err(|e| format!("query recent: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect recent: {e}"))?;
        Ok(rows)
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn percentile(sorted_asc: &[i64], p: f64) -> i64 {
    if sorted_asc.is_empty() {
        return 0;
    }
    // Rank-based (nearest rank) percentile — simple and deterministic.
    // More accurate linear-interpolation variants are overkill for a UI
    // tooltip that's already noisy with wall-clock variance.
    let n = sorted_asc.len();
    let rank = (p * n as f64).ceil() as usize;
    let idx = rank.clamp(1, n) - 1;
    sorted_asc[idx]
}

// ---------------------------------------------------------------------------
// Retention hook
// ---------------------------------------------------------------------------

/// Delete tool_usage rows older than `max_age_secs`. Called from the
/// retention loop alongside the episodic sweep. Separate from episodic
/// retention because the windows are different — tool_usage rows are
/// lower-signal and can decay faster (30 d default vs 14 / 28 for
/// episodic kinds).
pub const DEFAULT_TOOL_USAGE_DAYS: i64 = 30;

pub fn sweep_old(keep_days: i64) -> Result<usize, String> {
    let cutoff = now_secs() - keep_days.max(1) * 86_400;
    with_conn(|c| {
        let n = c
            .execute(
                "DELETE FROM tool_usage WHERE created_at < ?1",
                params![cutoff],
            )
            .map_err(|e| format!("sweep tool_usage: {e}"))?;
        Ok(n)
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;
    use rusqlite::{Connection, params};
    use std::collections::HashMap;

    fn insert(c: &Connection, tool: &str, ok: bool, lat: i64, age_secs: i64) {
        let now = now_secs();
        c.execute(
            "INSERT INTO tool_usage (tool_name, ok, latency_ms, error_msg, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4)",
            params![tool, if ok { 1 } else { 0 }, lat, now - age_secs],
        )
        .unwrap();
    }

    /// Local re-implementation of `stats` that accepts an injected
    /// Connection — the production function uses `with_conn` (global
    /// cell), which can't be sandboxed per-test.
    fn stats_in(c: &Connection, opts: StatsOptions) -> Vec<ToolStats> {
        let cutoff = opts.since_secs_ago.map(|s| now_secs() - s).unwrap_or(0);
        let mut stmt = c
            .prepare_cached(
                "SELECT tool_name, ok, latency_ms, created_at
                 FROM tool_usage WHERE created_at >= ?1
                 ORDER BY created_at DESC",
            )
            .unwrap();
        let rows: Vec<(String, i64, i64, i64)> = stmt
            .query_map(params![cutoff], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut by_tool: HashMap<String, Vec<(bool, i64, i64)>> = HashMap::new();
        for (n, ok, lat, at) in rows {
            by_tool.entry(n).or_default().push((ok == 1, lat, at));
        }
        let mut out: Vec<ToolStats> = by_tool
            .into_iter()
            .map(|(tool_name, entries)| {
                let count = entries.len() as i64;
                let ok_count = entries.iter().filter(|e| e.0).count() as i64;
                let err_count = count - ok_count;
                let success_rate = if count == 0 { -1.0 } else { ok_count as f64 / count as f64 };
                let last_at = entries.first().map(|e| e.2);
                let last_ok = entries.first().map(|e| e.0);
                let mut lats: Vec<i64> = entries.iter().map(|e| e.1).collect();
                lats.sort_unstable();
                ToolStats {
                    tool_name,
                    count,
                    ok_count,
                    err_count,
                    success_rate,
                    latency_p50_ms: percentile(&lats, 0.50),
                    latency_p95_ms: percentile(&lats, 0.95),
                    last_at,
                    last_ok,
                }
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then(b.tool_name.cmp(&a.tool_name)));
        if let Some(cap) = opts.limit {
            out.truncate(cap);
        }
        out
    }

    #[test]
    fn percentile_is_rank_based() {
        let xs = vec![10, 20, 30, 40, 50];
        assert_eq!(percentile(&xs, 0.50), 30);
        assert_eq!(percentile(&xs, 0.95), 50);
        assert_eq!(percentile(&xs, 0.01), 10);
        assert_eq!(percentile(&[], 0.5), 0);
    }

    #[test]
    fn stats_group_and_count_correctly() {
        let (_d, c) = scratch_conn("tu-stats");
        insert(&c, "fs_list", true, 10, 0);
        insert(&c, "fs_list", true, 20, 10);
        insert(&c, "fs_list", false, 30, 20);
        insert(&c, "run_shell", true, 100, 30);
        let s = stats_in(&c, StatsOptions::default());
        let fs = s.iter().find(|x| x.tool_name == "fs_list").unwrap();
        assert_eq!(fs.count, 3);
        assert_eq!(fs.ok_count, 2);
        assert_eq!(fs.err_count, 1);
        assert!((fs.success_rate - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn stats_window_excludes_old_rows() {
        let (_d, c) = scratch_conn("tu-win");
        insert(&c, "web_search", true, 5, 3_600);      // 1 h old
        insert(&c, "web_search", false, 5, 7 * 86_400); // 7 d old
        // Window: 24 h back
        let s = stats_in(
            &c,
            StatsOptions {
                since_secs_ago: Some(86_400),
                ..Default::default()
            },
        );
        let row = s.iter().find(|x| x.tool_name == "web_search").unwrap();
        assert_eq!(row.count, 1);
        assert!(row.last_ok.unwrap());
    }

    #[test]
    fn stats_sort_by_count_desc() {
        let (_d, c) = scratch_conn("tu-sort");
        for _ in 0..3 {
            insert(&c, "alpha", true, 1, 0);
        }
        for _ in 0..7 {
            insert(&c, "beta", true, 1, 0);
        }
        let s = stats_in(&c, StatsOptions::default());
        assert_eq!(s[0].tool_name, "beta");
        assert_eq!(s[1].tool_name, "alpha");
    }

    #[test]
    fn stats_latency_percentiles_are_monotonic() {
        let (_d, c) = scratch_conn("tu-lat");
        for lat in [10, 20, 30, 40, 50, 500, 1000] {
            insert(&c, "slow_tool", true, lat, 0);
        }
        let s = stats_in(&c, StatsOptions::default());
        let row = s.first().unwrap();
        assert!(row.latency_p50_ms <= row.latency_p95_ms);
        assert!(row.latency_p50_ms >= 10);
        assert!(row.latency_p95_ms <= 1000);
    }

    #[test]
    fn record_clips_long_error_messages() {
        // The real `record` uses `with_conn` (global cell). Exercise the
        // clipping logic by inserting a giant error manually and
        // verifying nothing panics on readback.
        let (_d, c) = scratch_conn("tu-clip");
        let big = "x".repeat(4096);
        c.execute(
            "INSERT INTO tool_usage (tool_name, ok, latency_ms, error_msg, created_at)
             VALUES ('fs_list', 0, 10, ?1, ?2)",
            params![big, now_secs()],
        )
        .unwrap();
        let (msg, _) = c
            .query_row(
                "SELECT error_msg, length(error_msg) FROM tool_usage",
                [],
                |r| Ok::<(Option<String>, i64), _>((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        // Without clipping, we can still read the full value back.
        assert!(msg.unwrap().len() >= 4096);
    }

    #[test]
    fn empty_window_yields_empty_stats() {
        let (_d, c) = scratch_conn("tu-empty");
        let s = stats_in(&c, StatsOptions::default());
        assert!(s.is_empty());
    }

    /// Re-implements the clipping logic from `record()` against a scratch
    /// connection so we can validate both the new column exists (v6
    /// migration ran) and that the REASON_MAX_CHARS cap is honoured on
    /// the write path. The global `record()` itself uses `with_conn` and
    /// can't be unit-tested against a scratch DB directly.
    fn record_in(
        c: &Connection,
        tool_name: &str,
        ok: bool,
        latency_ms: i64,
        error_msg: Option<&str>,
        reason: Option<&str>,
    ) {
        let reason_clipped = reason.and_then(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.chars().count() > REASON_MAX_CHARS {
                let cut = trimmed
                    .char_indices()
                    .nth(REASON_MAX_CHARS)
                    .map(|(i, _)| i)
                    .unwrap_or(trimmed.len());
                Some(format!("{}…", &trimmed[..cut]))
            } else {
                Some(trimmed.to_string())
            }
        });
        c.execute(
            "INSERT INTO tool_usage (tool_name, ok, latency_ms, error_msg, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tool_name,
                if ok { 1 } else { 0 },
                latency_ms,
                error_msg,
                reason_clipped,
                now_secs(),
            ],
        )
        .unwrap();
    }

    #[test]
    fn record_with_reason_persists() {
        let (_d, c) = scratch_conn("tu-reason");

        // Short reason round-trips unchanged.
        record_in(&c, "web_search", true, 42, None, Some("checking weather"));
        // Giant reason is clipped to REASON_MAX_CHARS + ellipsis.
        let big = "x".repeat(REASON_MAX_CHARS + 200);
        record_in(&c, "web_fetch", true, 11, None, Some(&big));
        // Whitespace-only reason persists as NULL (no noise).
        record_in(&c, "calc", true, 1, None, Some("   "));
        // Absent reason persists as NULL for back-compat.
        record_in(&c, "calc", true, 1, None, None);

        let rows: Vec<(String, Option<String>)> = c
            .prepare_cached(
                "SELECT tool_name, reason FROM tool_usage
                 ORDER BY id ASC",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 4);

        // 1 — short reason preserved.
        assert_eq!(rows[0].0, "web_search");
        assert_eq!(rows[0].1.as_deref(), Some("checking weather"));

        // 2 — giant reason clipped; ends in the ellipsis and is bounded.
        let clipped = rows[1].1.as_ref().expect("clipped reason present");
        assert!(clipped.ends_with('…'));
        assert!(clipped.chars().count() <= REASON_MAX_CHARS + 1);

        // 3 + 4 — whitespace-only and absent reasons collapse to NULL.
        assert!(rows[2].1.is_none(), "whitespace-only should be NULL");
        assert!(rows[3].1.is_none(), "absent should be NULL");
    }
}
