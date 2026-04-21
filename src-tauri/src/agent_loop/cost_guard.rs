//! `cost_guard` — runtime budget check for K1's model router.
//!
//! Compares the session's accumulated spend (via [`CostAggregator`]) against
//! the configured daily cap and returns a [`CostStatus`] that the router uses
//! to decide whether to permit cloud calls.
//!
//! # Thresholds
//! | Status    | Condition                          | Router action            |
//! |-----------|-----------------------------------|--------------------------|
//! | Healthy   | spent < 80 % of cap               | Normal routing           |
//! | Warning   | 80 % ≤ spent < 100 % of cap       | Log + prefer cheaper models |
//! | Exhausted | spent ≥ 100 % of cap (or cap = 0) | Clamp to local-only tier |
//!
//! # Immutability contract
//! All functions are pure: they take references and return values; no mutation.

use crate::agent_loop::telemetry_cost::CostAggregator;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Budget health reported to the model router.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CostStatus {
    /// Under 80 % of the daily cap — normal operation.
    Healthy,
    /// Between 80 % and 100 % of the daily cap — prefer cheaper tiers.
    Warning {
        /// Fraction of cap consumed, in `[0.80, 1.00)`.
        fraction_used: f64,
    },
    /// At or over 100 % of the daily cap — clamp to local-only models.
    Exhausted,
}

// ---------------------------------------------------------------------------
// Thresholds (public so tests and router can reference them symbolically)
// ---------------------------------------------------------------------------

/// Fraction at which status transitions to [`CostStatus::Warning`].
pub const WARNING_THRESHOLD: f64 = 0.80;

/// Fraction at which status transitions to [`CostStatus::Exhausted`].
pub const EXHAUSTED_THRESHOLD: f64 = 1.00;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/// Evaluate budget health given an aggregator and a daily cap in USD.
///
/// # Arguments
/// * `aggregator`    — session cost accumulator; provides `total_cost_usd()`.
/// * `daily_cap_usd` — from `SunnySettings.providers.glm_daily_cap_usd`.
///                     A cap of `0.0` (or negative) is treated as **Exhausted**
///                     to fail-safe when settings are not yet configured.
///
/// # Returns
/// A [`CostStatus`] that the router should act on immediately.
#[must_use]
pub fn check(aggregator: &CostAggregator, daily_cap_usd: f64) -> CostStatus {
    // A zero or negative cap means we have no budget — always Exhausted.
    if daily_cap_usd <= 0.0 {
        return CostStatus::Exhausted;
    }

    let spent = aggregator.total_cost_usd();
    let fraction = spent / daily_cap_usd;

    // Small tolerance so token-math rounding (e.g. $0.799995 at exactly 80 %)
    // doesn't fail to cross the boundary. 1e-4 of fraction = 0.01 % slop.
    const EPS: f64 = 1e-4;
    if fraction + EPS >= EXHAUSTED_THRESHOLD {
        CostStatus::Exhausted
    } else if fraction + EPS >= WARNING_THRESHOLD {
        CostStatus::Warning { fraction_used: fraction }
    } else {
        CostStatus::Healthy
    }
}

/// Convenience: returns `true` when the router must clamp to local-only models.
#[must_use]
#[inline]
pub fn is_exhausted(aggregator: &CostAggregator, daily_cap_usd: f64) -> bool {
    matches!(check(aggregator, daily_cap_usd), CostStatus::Exhausted)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_loop::telemetry_cost::{CostAggregator, CostMetrics};

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Build an aggregator with a fixed total spend (Sonnet 4.6 at 1k in/out
    /// per turn to get predictable pricing, then we scale turns).
    /// 1 turn of sonnet 1k in + 1k out = $0.003 + $0.015 = $0.018
    fn agg_with_spend(total_usd: f64) -> CostAggregator {
        // Use Ollama (free) turns to get to $0.00, then add one carefully-
        // sized Sonnet turn for exact dollar amounts via direct construction.
        // Simplest: build from a zero-turn aggregator + one direct metric.
        // CostMetrics for $X at Sonnet rates: solve
        //   input_tokens * 0.003/1000 + output_tokens * 0.015/1000 = total_usd
        // Use only output tokens for simplicity:
        //   output_tokens = total_usd / 0.000015  (= $0.015 / 1000)
        let output_tokens = (total_usd / 0.000015).round() as u64;
        let metric = CostMetrics {
            input_tokens: 0,
            output_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            timestamp: 0,
        };
        CostAggregator::new().add_metric("claude-sonnet-4-6", metric)
    }

    // -----------------------------------------------------------------------
    // State transitions
    // -----------------------------------------------------------------------

    #[test]
    fn healthy_when_under_80_pct() {
        // $0.79 of $1.00 cap = 79 % → Healthy
        let agg = agg_with_spend(0.79);
        assert_eq!(check(&agg, 1.00), CostStatus::Healthy);
    }

    #[test]
    fn warning_at_exactly_80_pct() {
        // $0.80 of $1.00 cap = 80 % → Warning
        let agg = agg_with_spend(0.80);
        match check(&agg, 1.00) {
            CostStatus::Warning { fraction_used } => {
                assert!(
                    (fraction_used - 0.80).abs() < 0.001,
                    "expected fraction ~0.80, got {fraction_used}"
                );
            }
            other => panic!("expected Warning at 80%, got {:?}", other),
        }
    }

    #[test]
    fn warning_between_80_and_100_pct() {
        let agg = agg_with_spend(0.90);
        assert!(
            matches!(check(&agg, 1.00), CostStatus::Warning { .. }),
            "expected Warning at 90%"
        );
    }

    #[test]
    fn exhausted_at_exactly_100_pct() {
        let agg = agg_with_spend(1.00);
        assert_eq!(check(&agg, 1.00), CostStatus::Exhausted);
    }

    #[test]
    fn exhausted_over_100_pct() {
        // Spend exceeds cap
        let agg = agg_with_spend(1.50);
        assert_eq!(check(&agg, 1.00), CostStatus::Exhausted);
    }

    #[test]
    fn healthy_when_zero_spend() {
        let agg = CostAggregator::new();
        assert_eq!(check(&agg, 5.00), CostStatus::Healthy);
    }

    #[test]
    fn exhausted_when_cap_is_zero() {
        let agg = CostAggregator::new(); // $0 spend
        assert_eq!(check(&agg, 0.00), CostStatus::Exhausted,
            "zero cap must be Exhausted regardless of spend");
    }

    #[test]
    fn exhausted_when_cap_is_negative() {
        let agg = CostAggregator::new();
        assert_eq!(check(&agg, -1.00), CostStatus::Exhausted,
            "negative cap must be Exhausted");
    }

    // -----------------------------------------------------------------------
    // is_exhausted convenience helper
    // -----------------------------------------------------------------------

    #[test]
    fn is_exhausted_false_when_healthy() {
        let agg = agg_with_spend(0.50);
        assert!(!is_exhausted(&agg, 1.00));
    }

    #[test]
    fn is_exhausted_false_when_warning() {
        let agg = agg_with_spend(0.85);
        assert!(!is_exhausted(&agg, 1.00));
    }

    #[test]
    fn is_exhausted_true_when_over_cap() {
        let agg = agg_with_spend(2.00);
        assert!(is_exhausted(&agg, 1.00));
    }

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn warning_fraction_reflects_actual_ratio() {
        // $0.45 of $0.50 = 90 %
        let agg = agg_with_spend(0.45);
        match check(&agg, 0.50) {
            CostStatus::Warning { fraction_used } => {
                assert!(
                    (fraction_used - 0.90).abs() < 0.005,
                    "expected fraction ~0.90, got {fraction_used}"
                );
            }
            other => panic!("expected Warning, got {:?}", other),
        }
    }

    #[test]
    fn tiny_cap_exhausts_quickly() {
        // $0.01 cap, $0.02 spend → Exhausted
        let agg = agg_with_spend(0.02);
        assert_eq!(check(&agg, 0.01), CostStatus::Exhausted);
    }

    #[test]
    fn large_cap_stays_healthy_with_small_spend() {
        // $1 spend of $10_000 cap → very healthy
        let agg = agg_with_spend(1.00);
        assert_eq!(check(&agg, 10_000.00), CostStatus::Healthy);
    }
}
