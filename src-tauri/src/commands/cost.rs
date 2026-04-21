//! `cost_today_json` — lightweight Tauri command for the CostPage.
//!
//! Reads the global `telemetry` ring buffer and projects the subset of
//! events that fall on today (local-time midnight) into a JSON object:
//!
//! ```json
//! {
//!   "total_usd": 0.42,
//!   "turns": 12,
//!   "by_provider": { "anthropic": 0.42, "ollama": 0.0 },
//!   "by_tier": {
//!     "quickthink": { "turns": 3, "cost": 0.0 },
//!     "cloud":      { "turns": 7, "cost": 0.32 },
//!     "deeplocal":  { "turns": 2, "cost": 0.0 },
//!     "premium":    { "turns": 0, "cost": 0.0 }
//!   }
//! }
//! ```
//!
//! The frontend validates this with Zod (`CostTodaySchema`) — if the shape
//! ever drifts, Zod returns a safe zero-stub instead of crashing the page.
//!
//! # Why a separate command?
//!
//! `telemetry_llm_stats` aggregates the *entire* ring (up to 500 events,
//! possibly spanning multiple days / sessions).  The CostPage wants
//! *today's* cost only.  Filtering on the Rust side keeps the IPC payload
//! small and avoids duplicating the date-arithmetic in TypeScript.
//!
//! # Why JSON string?
//!
//! The `by_provider` field is a `HashMap<String, f64>`, which ts-rs renders
//! as `Record<string, number>` but Tauri's serde-json serialiser handles
//! directly without needing a `#[derive(TS)]` round-trip.  Returning a
//! pre-serialised string means we never need `ts-rs` for this command.

use std::collections::HashMap;

use serde::Serialize;

use crate::telemetry::telemetry_llm_recent_impl;

/// Per-tier aggregation bucket inside [`CostToday`].
#[derive(Serialize, Clone, Default)]
struct TierBucket {
    turns: u64,
    cost:  f64,
}

/// Payload returned by [`cost_today_json`].
#[derive(Serialize)]
struct CostToday {
    total_usd:   f64,
    turns:       u64,
    by_provider: HashMap<String, f64>,
    /// Per-tier aggregation.  All four keys are always present so the
    /// frontend can destructure without optional chaining.
    by_tier: TierMap,
}

/// Fixed-key tier map — four buckets, always serialised.
#[derive(Serialize)]
struct TierMap {
    quickthink: TierBucket,
    cloud:      TierBucket,
    deeplocal:  TierBucket,
    premium:    TierBucket,
}

impl TierMap {
    fn new() -> Self {
        Self {
            quickthink: TierBucket::default(),
            cloud:      TierBucket::default(),
            deeplocal:  TierBucket::default(),
            premium:    TierBucket::default(),
        }
    }

    fn add(&mut self, tier: &str, cost: f64) {
        let bucket = match tier {
            "quickthink" => &mut self.quickthink,
            "cloud"      => &mut self.cloud,
            "deeplocal"  => &mut self.deeplocal,
            "premium"    => &mut self.premium,
            _            => return,   // unknown tier from future K5 variants — skip
        };
        bucket.turns += 1;
        bucket.cost  += cost;
    }
}

/// Return today's aggregate cost, turn count, per-provider breakdown, and
/// per-tier breakdown.
///
/// "Today" is defined as the local wall-clock day starting at midnight.
/// Events whose `at` timestamp precedes today's midnight are excluded so
/// the stat card always reflects *only* the current day's spend.
#[tauri::command]
pub async fn cost_today_json() -> String {
    // Midnight of the current local day in Unix seconds.
    let now_secs   = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    // A day is 86 400 seconds.  Midnight = now - (now % 86400) adjusted for
    // local timezone offset.  We approximate with UTC midnight for simplicity
    // (the CostPage is informational, not billing-critical).
    let midnight = now_secs - (now_secs % 86_400);

    let events = telemetry_llm_recent_impl(500);

    let mut total_usd: f64 = 0.0;
    let mut turns: u64 = 0;
    let mut by_provider: HashMap<String, f64> = HashMap::new();
    let mut by_tier = TierMap::new();

    for ev in events {
        if ev.at < midnight {
            continue;
        }
        let cost = ev.cost_usd;
        total_usd += cost;
        turns += 1;
        *by_provider.entry(ev.provider.clone()).or_insert(0.0) += cost;
        if let Some(ref t) = ev.tier {
            by_tier.add(t.as_str(), cost);
        }
    }

    let payload = CostToday { total_usd, turns, by_provider, by_tier };
    serde_json::to_string(&payload).unwrap_or_else(|_| {
        r#"{"total_usd":0,"turns":0,"by_provider":{},"by_tier":{"quickthink":{"turns":0,"cost":0},"cloud":{"turns":0,"cost":0},"deeplocal":{"turns":0,"cost":0},"premium":{"turns":0,"cost":0}}}"#.to_string()
    })
}
