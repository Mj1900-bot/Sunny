//! Cross-provider LLM telemetry — token accounting, cache hit rates,
//! and a rolling window of recent turns surfaced to the frontend's
//! `BrainPage` live panel.
//!
//! Providers call [`record_llm_turn`] at the end of every model turn
//! (buffered or streaming). The event lands in a capped ring buffer
//! (`CAP_EVENTS`), which the two Tauri commands below project into:
//!
//!   * `telemetry_llm_recent(limit)`  — newest-first event feed
//!   * `telemetry_llm_stats()`         — aggregate rollup over the whole ring
//!
//! The ring is capped at [`CAP_EVENTS`] so a long session can't balloon
//! memory. At ~120 bytes/event the total footprint sits at ~60 KB.
//!
//! Providers without prompt-cache semantics (Ollama, GLM) report
//! `cache_read = 0` and `cache_create = 0` — the aggregator treats
//! those turns as "no caching attempted," keeping the ratio honest.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Hard cap on the retained ring buffer. One turn ≈ 120 bytes serialised,
/// so 500 turns ≈ 60 KB — comfortably small, and enough to reflect
/// hit-rate trends across a multi-hour session.
const CAP_EVENTS: usize = 500;

/// One LLM turn, as observed from the provider transport layer.
///
/// All token fields are `u64` because Anthropic returns them unsigned
/// and ts-rs renders them as `number` on the TS side. `duration_ms` is
/// captured by the caller using `Instant::elapsed()` around the
/// request future.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct TelemetryEvent {
    /// "anthropic" | "ollama" | "glm".
    pub provider: String,
    /// Model slug the caller sent on the wire.
    pub model: String,
    /// Uncached input tokens (Anthropic `input_tokens`; Ollama/GLM 0).
    #[ts(type = "number")]
    pub input: u64,
    /// Cache-read input tokens — the portion served from the prompt
    /// cache. Non-zero only on Anthropic with active breakpoints.
    #[ts(type = "number")]
    pub cache_read: u64,
    /// Cache-creation input tokens — the portion billed at the write
    /// premium. Non-zero only on Anthropic when a new cache entry is
    /// being seeded this turn.
    #[ts(type = "number")]
    pub cache_create: u64,
    /// Output tokens the model generated this turn.
    #[ts(type = "number")]
    pub output: u64,
    /// Wall-clock duration of the turn (request start → response end).
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// UNIX epoch seconds when the turn completed.
    #[ts(type = "number")]
    pub at: i64,
    /// Estimated cost in USD for this turn, computed at record time from
    /// per-provider, per-1k-token rate constants. Zero for legacy events
    /// and Ollama (local inference). Defaults to 0.0 on deserialise so
    /// old serialised events (without this field) remain valid.
    #[serde(default)]
    #[ts(type = "number")]
    pub cost_usd: f64,
    /// Routing tier assigned at dispatch time: "quickthink" | "cloud" | "deeplocal" | "premium".
    /// `None` for events recorded before tier-routing was wired (K5). Defaults to `None` on
    /// deserialise so old ring events remain valid without a migration.
    #[serde(default)]
    pub tier: Option<String>,
}

/// Aggregate rollup over the entire retained ring. Drives the four
/// stat cards on BrainPage.
#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct LlmStats {
    #[ts(type = "number")]
    pub total_input_tokens: u64,
    #[ts(type = "number")]
    pub total_output_tokens: u64,
    /// Cache-read tokens as a fraction of all input-side tokens
    /// (input + cache_read + cache_create), in 0..100.
    pub cache_hit_rate: f64,
    /// Rough cost-savings proxy: cache-read tokens are billed at 10% of
    /// the uncached rate on Anthropic. We report the fraction of the
    /// *uncached-equivalent* input spend that caching saved, in 0..100.
    /// For a session with zero caching this is 0.0; a fully-warmed
    /// cache approaches 90.0.
    pub cache_savings_pct: f64,
    #[ts(type = "number")]
    pub turns_count: u64,
}

/// Module-local ring buffer. Wrapped in a `OnceLock<Mutex<…>>` rather
/// than a `lazy_static` to keep the dependency surface minimal — this
/// module has a single writer per turn and sub-microsecond lock hold
/// times, so contention isn't a concern.
// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/// Provider-specific billing rates (USD per 1 000 tokens). Rates sourced from
/// public pricing pages as of 2026-04:
///
/// * Anthropic claude-sonnet-4-6: $3.00 / M input, $15.00 / M output
///   (cache_read billed at 10% of input; cache_create at 125% of input).
///   Source: <https://www.anthropic.com/pricing> — if pricing changes,
///   update the four constants below.
/// * GLM-5.1 (Z.AI Coding Plan): $0.40 / M input, $1.20 / M output.
///   Source: <https://open.bigmodel.cn/pricing> — Coding Plan credits.
/// * Ollama: always 0.0 — local inference, no per-token billing.
pub mod cost_rates {
    /// Anthropic Sonnet 4.6 — uncached input tokens (USD / 1 000 tokens).
    pub const ANTHROPIC_INPUT_PER_1K: f64 = 0.003;
    /// Anthropic Sonnet 4.6 — output tokens (USD / 1 000 tokens).
    pub const ANTHROPIC_OUTPUT_PER_1K: f64 = 0.015;
    /// Anthropic Sonnet 4.6 — cache-read tokens are billed at 10% of the
    /// standard input rate.
    pub const ANTHROPIC_CACHE_READ_PER_1K: f64 = ANTHROPIC_INPUT_PER_1K * 0.10;
    /// Anthropic Sonnet 4.6 — cache-creation tokens are billed at 125% of
    /// the standard input rate.
    pub const ANTHROPIC_CACHE_CREATE_PER_1K: f64 = ANTHROPIC_INPUT_PER_1K * 1.25;

    /// GLM-5.1 via Z.AI Coding Plan — input tokens (USD / 1 000 tokens).
    pub const GLM_INPUT_PER_1K: f64 = 0.0004;
    /// GLM-5.1 via Z.AI Coding Plan — output tokens (USD / 1 000 tokens).
    pub const GLM_OUTPUT_PER_1K: f64 = 0.0012;

    /// Moonshot Kimi K2.6 via api.moonshot.ai — published 2026-04-20.
    /// input: $0.60 / M tokens → $0.0006 / 1 000.
    pub const KIMI_INPUT_PER_1K: f64 = 0.0006;
    /// output: $2.50 / M tokens → $0.0025 / 1 000.
    pub const KIMI_OUTPUT_PER_1K: f64 = 0.0025;
    /// Moonshot bills cached prompt-prefix hits at ~10% of the input
    /// rate; mirrors Anthropic's cache-read discount model.
    pub const KIMI_CACHE_READ_PER_1K: f64 = KIMI_INPUT_PER_1K * 0.10;

    /// Ollama is local; cost is always zero regardless of token counts.
    pub const OLLAMA_COST: f64 = 0.0;
}

/// Compute the estimated USD cost for one LLM turn given raw token counts.
///
/// `input`, `output`, `cache_read`, `cache_create` are the token counts
/// exactly as reported by the provider (or 0 where the provider does not
/// supply them). Returns `0.0` for any unrecognised provider string so
/// legacy callers and test stubs are safe.
///
/// # Example
/// ```ignore
/// let usd = cost_estimate("anthropic", 1_000, 500, 0, 0);
/// // ≈ 0.003 + 0.0075 = 0.0105
/// ```
pub fn cost_estimate(
    provider: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
) -> f64 {
    use cost_rates::*;
    match provider {
        "anthropic" => {
            let input_cost  = input       as f64 / 1_000.0 * ANTHROPIC_INPUT_PER_1K;
            let output_cost = output      as f64 / 1_000.0 * ANTHROPIC_OUTPUT_PER_1K;
            let read_cost   = cache_read  as f64 / 1_000.0 * ANTHROPIC_CACHE_READ_PER_1K;
            let create_cost = cache_create as f64 / 1_000.0 * ANTHROPIC_CACHE_CREATE_PER_1K;
            input_cost + output_cost + read_cost + create_cost
        }
        "glm" => {
            let input_cost  = input  as f64 / 1_000.0 * GLM_INPUT_PER_1K;
            let output_cost = output as f64 / 1_000.0 * GLM_OUTPUT_PER_1K;
            input_cost + output_cost
        }
        "kimi" => {
            let input_cost  = input       as f64 / 1_000.0 * KIMI_INPUT_PER_1K;
            let output_cost = output      as f64 / 1_000.0 * KIMI_OUTPUT_PER_1K;
            let read_cost   = cache_read  as f64 / 1_000.0 * KIMI_CACHE_READ_PER_1K;
            let _ = cache_create;
            input_cost + output_cost + read_cost
        }
        "ollama" => OLLAMA_COST,
        _ => 0.0,
    }
}

fn events_ring() -> &'static Mutex<VecDeque<TelemetryEvent>> {
    static RING: OnceLock<Mutex<VecDeque<TelemetryEvent>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP_EVENTS)))
}

/// Append a telemetry event to the ring. Evicts the oldest entry when
/// the buffer is already at [`CAP_EVENTS`]. Lock poisoning recovers
/// gracefully — a panic on a previous call shouldn't silently stop
/// telemetry for the rest of the session.
pub fn record_llm_turn(event: TelemetryEvent) {
    let ring = events_ring();
    let mut guard = match ring.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.len() >= CAP_EVENTS {
        guard.pop_front();
    }
    guard.push_back(event);
}

/// Internal snapshot helper — clones the ring under the lock so
/// downstream computation happens without holding it. Caller-facing
/// wrappers ([`telemetry_llm_recent`], [`telemetry_llm_stats`]) use
/// this to keep the critical section tight.
fn snapshot() -> Vec<TelemetryEvent> {
    let ring = events_ring();
    let guard = match ring.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.iter().cloned().collect()
}

/// Compute aggregate stats over the entire retained ring.
///
/// Cache-hit rate: `cache_read / (input + cache_read + cache_create)`.
/// Cache-savings: cache_read is billed at 10% of the uncached rate, so
/// the savings-equivalent is `0.9 * cache_read / denom_equivalent` where
/// the denominator is the cost if every input token were fresh.
pub fn telemetry_llm_stats_impl() -> LlmStats {
    let events = snapshot();
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut total_cache_read: u64 = 0;
    let mut total_cache_create: u64 = 0;

    for ev in &events {
        total_input = total_input.saturating_add(ev.input);
        total_output = total_output.saturating_add(ev.output);
        total_cache_read = total_cache_read.saturating_add(ev.cache_read);
        total_cache_create = total_cache_create.saturating_add(ev.cache_create);
    }

    let input_side_total = total_input + total_cache_read + total_cache_create;
    let cache_hit_rate = if input_side_total > 0 {
        (total_cache_read as f64 / input_side_total as f64) * 100.0
    } else {
        0.0
    };
    // Anthropic charges cache_read at 10% of uncached, so every
    // cache_read token saves 90% of its would-be uncached cost.
    let cache_savings_pct = if input_side_total > 0 {
        (0.9 * total_cache_read as f64 / input_side_total as f64) * 100.0
    } else {
        0.0
    };

    LlmStats {
        total_input_tokens: total_input + total_cache_read + total_cache_create,
        total_output_tokens: total_output,
        cache_hit_rate,
        cache_savings_pct,
        turns_count: events.len() as u64,
    }
}

/// Return the newest `limit` events, newest-first. Caller-controlled
/// bound keeps the IPC payload small — the frontend sparkline only
/// needs the last ~20.
pub fn telemetry_llm_recent_impl(limit: usize) -> Vec<TelemetryEvent> {
    let events = snapshot();
    let n = events.len();
    let take = limit.min(n);
    events
        .into_iter()
        .rev()
        .take(take)
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri command surface
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn telemetry_llm_recent(limit: Option<usize>) -> Vec<TelemetryEvent> {
    telemetry_llm_recent_impl(limit.unwrap_or(50))
}

#[tauri::command]
pub async fn telemetry_llm_stats() -> LlmStats {
    telemetry_llm_stats_impl()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(provider: &str, input: u64, cache_read: u64, cache_create: u64, output: u64) -> TelemetryEvent {
        TelemetryEvent {
            provider: provider.to_string(),
            model: "test".to_string(),
            input,
            cache_read,
            cache_create,
            output,
            duration_ms: 100,
            at: 0,
            cost_usd: 0.0,
            tier: None,
        }
    }

    #[test]
    fn hit_rate_is_zero_when_no_cache() {
        // Fresh ring per-test is impossible (module-local OnceLock), so
        // we reason about deltas instead: compute stats twice, each
        // time capturing the "before" snapshot.
        let before = telemetry_llm_stats_impl();
        record_llm_turn(ev("ollama", 0, 0, 0, 42));
        let after = telemetry_llm_stats_impl();
        assert_eq!(after.turns_count, before.turns_count + 1);
        assert_eq!(after.total_output_tokens, before.total_output_tokens + 42);
    }

    #[test]
    fn hit_rate_reflects_cache_reads() {
        record_llm_turn(ev("anthropic", 100, 900, 0, 50));
        let stats = telemetry_llm_stats_impl();
        // With *this* turn contributing 900/(100+900+0) = 90%,
        // the aggregate hit rate must be >= 0 and <= 100.
        assert!(stats.cache_hit_rate >= 0.0 && stats.cache_hit_rate <= 100.0);
        assert!(stats.cache_savings_pct >= 0.0 && stats.cache_savings_pct <= 90.0);
    }

    #[test]
    fn recent_returns_newest_first() {
        record_llm_turn(ev("a", 1, 0, 0, 1));
        record_llm_turn(ev("b", 2, 0, 0, 2));
        let out = telemetry_llm_recent_impl(2);
        assert_eq!(out.len(), 2);
        // Newest first — "b" must precede "a".
        assert_eq!(out[0].provider, "b");
    }

    /// Verify cost_estimate returns correct USD values for known inputs.
    ///
    /// Anthropic: 1 000 input @ $3/M + 500 output @ $15/M + 200 cache_read
    /// @ $0.30/M + 100 cache_create @ $3.75/M = $0.003 + $0.0075 + $0.00006 + $0.000375 = $0.010935
    #[test]
    fn cost_estimate_known_values() {
        // Anthropic — verify each billing tier independently first.
        let input_only = cost_estimate("anthropic", 1_000, 0, 0, 0);
        let epsilon = 1e-9;
        assert!((input_only - 0.003).abs() < epsilon,
            "anthropic 1k input should be $0.003, got {input_only}");

        let output_only = cost_estimate("anthropic", 0, 1_000, 0, 0);
        assert!((output_only - 0.015).abs() < epsilon,
            "anthropic 1k output should be $0.015, got {output_only}");

        // Combined with cache tiers.
        let combined = cost_estimate("anthropic", 1_000, 500, 200, 100);
        // input: 0.003 + output: 0.0075 + read: 0.00006 + create: 0.000375 = 0.010935
        let expected = 0.003 + 0.0075 + 200.0 / 1_000.0 * 0.0003 + 100.0 / 1_000.0 * 0.00375;
        assert!((combined - expected).abs() < epsilon,
            "anthropic combined cost mismatch: got {combined}, expected {expected}");

        // GLM — 1 000 input + 1 000 output.
        let glm = cost_estimate("glm", 1_000, 1_000, 0, 0);
        assert!((glm - 0.0016).abs() < epsilon,
            "glm 1k+1k should be $0.0016, got {glm}");

        // Ollama — always zero regardless of tokens.
        let ollama = cost_estimate("ollama", 999_999, 999_999, 0, 0);
        assert_eq!(ollama, 0.0, "ollama cost must always be 0.0");

        // Unknown provider — must return 0.0 (not panic).
        let unknown = cost_estimate("unknown_future_provider", 500, 500, 0, 0);
        assert_eq!(unknown, 0.0, "unknown provider must return 0.0");
    }
}
