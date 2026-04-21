//! Session-scoped cost aggregator for the SUNNY agent loop.
//!
//! Extends the crate-level `telemetry` ring with a per-session,
//! per-model view.  Unlike the global ring (which caps at 500 events
//! and is shared across all sessions), `CostAggregator` is owned by
//! one conversation and computes derived metrics over its own slice:
//!
//! * `total_cost_usd()`     — sum of per-turn USD costs
//! * `cache_hit_rate()`     — cache_read / (input + cache_read)
//! * `avg_cost_per_turn()`  — total / turn count
//! * `trend_last_10_turns()` — per-turn costs for the last ≤ 10 turns
//! * `to_summary_string()`  — human/overlay-ready one-liner
//!
//! # Immutability contract
//!
//! `CostAggregator` uses functional-update style: `add_metric` consumes
//! `self` and returns a new aggregator, keeping all values immutable.
//! No interior mutability or `Mutex` is involved — callers own the
//! aggregator and rebind it on each turn:
//!
//! ```rust,ignore
//! let agg = CostAggregator::new();
//! let agg = agg.add_metric(CostMetrics::from_event(&event));
//! ```

use crate::telemetry::TelemetryEvent;

// ---------------------------------------------------------------------------
// Provider hint — lightweight enum used by callers that want explicit routing
// ---------------------------------------------------------------------------

/// Which provider produced a turn.
///
/// Used by [`pricing::rates_for`] as an override hint — when `Some`, the hint
/// takes priority over slug-matching on the model ID.  Callers that use
/// [`CostMetrics::from_event`] typically rely on the slug path; callers that
/// construct metrics directly via [`CostMetrics::from_glm_usage`] or
/// [`CostMetrics::from_ollama_usage`] embed the provider in the model-id they
/// pass to [`CostAggregator::add_metric`] (e.g. `"glm-4-flash"`, `"ollama"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderHint {
    Anthropic,
    Glm,
    Ollama,
    Unknown,
}

// ---------------------------------------------------------------------------
// Pricing table — 2026-04 list prices
// ---------------------------------------------------------------------------

/// Per-model billing rates in USD per **1 000** tokens.
///
/// Sources:
///   Haiku 4.5:  $1 / MTok input,  $5 / MTok output  (Anthropic 2026-04)
///   Sonnet 4.6: $3 / MTok input, $15 / MTok output  (Anthropic 2026-04)
///   Opus 4.7:  $15 / MTok input, $75 / MTok output  (Anthropic 2026-04)
///   GLM-5.1:  $0.40/MTok input, $1.20/MTok output   (z.ai Coding Plan 2026-04)
///   Ollama:    $0.00/MTok input,  $0.00/MTok output  (local inference — free)
///
/// Cache-read is billed at 10% of the uncached input rate (Anthropic only).
/// Cache-creation is billed at 125% of the uncached input rate (Anthropic only).
/// GLM and Ollama do not have prompt-cache pricing; their cache rate fields are 0.
pub mod pricing {
    pub struct ModelRates {
        pub input_per_1k: f64,
        pub output_per_1k: f64,
        pub cache_read_per_1k: f64,
        pub cache_create_per_1k: f64,
    }

    impl ModelRates {
        /// Build rates with Anthropic-style prompt-cache pricing derived
        /// automatically (read = 10 %, create = 125 % of input).
        pub const fn new(input_per_1k: f64, output_per_1k: f64) -> Self {
            Self {
                input_per_1k,
                output_per_1k,
                cache_read_per_1k: input_per_1k * 0.10,
                cache_create_per_1k: input_per_1k * 1.25,
            }
        }

        /// Build rates with explicit cache fields.  Use for providers that
        /// have no cache tier (set both to 0) or non-standard cache multipliers.
        pub const fn new_explicit(
            input_per_1k: f64,
            output_per_1k: f64,
            cache_read_per_1k: f64,
            cache_create_per_1k: f64,
        ) -> Self {
            Self {
                input_per_1k,
                output_per_1k,
                cache_read_per_1k,
                cache_create_per_1k,
            }
        }
    }

    // Anthropic — $1 / MTok = $0.001 / 1K tok; $5 / MTok = $0.005 / 1K tok
    pub const HAIKU_4_5: ModelRates = ModelRates::new(0.001, 0.005);
    // Anthropic — $3 / MTok = $0.003; $15 / MTok = $0.015
    pub const SONNET_4_6: ModelRates = ModelRates::new(0.003, 0.015);
    // Anthropic — $15 / MTok = $0.015; $75 / MTok = $0.075
    pub const OPUS_4_7: ModelRates = ModelRates::new(0.015, 0.075);
    // z.ai GLM-5.1 Coding Plan — $0.40 / MTok input, $1.20 / MTok output.
    // No prompt-cache tier documented; cache rate fields are zero.
    pub const GLM_5_1: ModelRates =
        ModelRates::new_explicit(0.00040, 0.00120, 0.0, 0.0);
    // Local Ollama inference — always free.
    pub const OLLAMA: ModelRates =
        ModelRates::new_explicit(0.0, 0.0, 0.0, 0.0);

    /// Returns the rates for `model_id` with an optional `provider` hint.
    ///
    /// Resolution order:
    /// 1. `provider == Some("glm" | "zhipu" | "glm-5.1")` → [`GLM_5_1`]
    /// 2. `provider == Some("ollama")` → [`OLLAMA`]
    /// 3. Provider hint absent or unknown → slug-match on `model_id`:
    ///    - contains `"glm"`    → [`GLM_5_1`]
    ///    - contains `"ollama"` → [`OLLAMA`]
    ///    - contains `"haiku"`  → [`HAIKU_4_5`]
    ///    - contains `"opus"`   → [`OPUS_4_7`]
    ///    - default             → [`SONNET_4_6`] (new Claude variants never panic)
    pub fn rates_for(model_id: &str, provider: Option<&str>) -> &'static ModelRates {
        // Provider hint takes priority over slug matching.
        match provider {
            Some("glm") | Some("zhipu") | Some("glm-5.1") => return &GLM_5_1,
            Some("ollama") => return &OLLAMA,
            _ => {}
        }
        // Slug-based fallback.
        if model_id.contains("glm") {
            &GLM_5_1
        } else if model_id.contains("ollama") {
            &OLLAMA
        } else if model_id.contains("haiku") {
            &HAIKU_4_5
        } else if model_id.contains("opus") {
            &OPUS_4_7
        } else {
            // Sonnet is the default model; also the fallback for unknown slugs.
            &SONNET_4_6
        }
    }
}

// ---------------------------------------------------------------------------
// CostMetrics — one immutable turn record
// ---------------------------------------------------------------------------

/// Token counts and metadata for a single completed LLM turn.
///
/// All fields are `Copy` primitives — no heap allocation per turn.
///
/// Provider routing is determined by the `model_id` string stored alongside
/// this record in [`CostAggregator`].  Pass a model-id that contains `"glm"`
/// (e.g. `"glm-4-flash"`) or `"ollama"` to select non-Anthropic rates.
/// Alternatively, use the explicit `provider` override in [`pricing::rates_for`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CostMetrics {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Unix epoch seconds at which the turn completed.
    pub timestamp: i64,
}

impl CostMetrics {
    /// Compute the USD cost for this turn using the per-model pricing table.
    ///
    /// `model_id` is matched against the pricing table; GLM and Ollama are
    /// detected by slug (e.g. `"glm-4-flash"`, `"ollama"`).  Unknown slugs
    /// fall back to Sonnet 4.6 rates.
    pub fn cost_usd(&self, model_id: &str) -> f64 {
        let r = pricing::rates_for(model_id, None);
        let input = self.input_tokens as f64 / 1_000.0 * r.input_per_1k;
        let output = self.output_tokens as f64 / 1_000.0 * r.output_per_1k;
        let read = self.cache_read_tokens as f64 / 1_000.0 * r.cache_read_per_1k;
        let create = self.cache_creation_tokens as f64 / 1_000.0 * r.cache_create_per_1k;
        input + output + read + create
    }

    /// Build a `CostMetrics` from a crate-level [`TelemetryEvent`].
    ///
    /// This is the primary ingestion path — callers snapshot an event
    /// from `crate::telemetry::telemetry_llm_recent_impl` or receive one
    /// directly from the provider and wrap it here.
    pub fn from_event(ev: &TelemetryEvent) -> Self {
        Self {
            input_tokens: ev.input,
            output_tokens: ev.output,
            cache_read_tokens: ev.cache_read,
            cache_creation_tokens: ev.cache_create,
            timestamp: ev.at,
        }
    }

    /// Build a `CostMetrics` for a GLM-5.1 turn.
    ///
    /// GLM does not expose a prompt-cache breakdown, so cache fields are zero.
    /// Pricing: $0.40 / MTok input, $1.20 / MTok output (z.ai Coding Plan 2026-04).
    ///
    /// Pass `"glm-4-flash"` or any model-id containing `"glm"` to
    /// [`CostAggregator::add_metric`] to ensure correct rate selection.
    pub fn from_glm_usage(prompt_tokens: u64, completion_tokens: u64, timestamp: i64) -> Self {
        Self {
            input_tokens: prompt_tokens,
            output_tokens: completion_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            timestamp,
        }
    }

    /// Build a `CostMetrics` for a local Ollama turn.
    ///
    /// Ollama runs locally — all token costs are zero regardless of volume.
    ///
    /// Pass `"ollama"` or any model-id containing `"ollama"` to
    /// [`CostAggregator::add_metric`] to ensure correct (free) rate selection.
    pub fn from_ollama_usage(prompt_tokens: u64, completion_tokens: u64, timestamp: i64) -> Self {
        Self {
            input_tokens: prompt_tokens,
            output_tokens: completion_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            timestamp,
        }
    }
}

// ---------------------------------------------------------------------------
// CostAggregator — immutable session accumulator
// ---------------------------------------------------------------------------

/// Session-level cost accumulator.
///
/// Holds an ordered list of `(model_id, CostMetrics)` pairs — one per
/// completed turn.  All mutation is via functional-update: `add_metric`
/// returns a new `CostAggregator` rather than modifying `self`.
#[derive(Debug, Clone)]
pub struct CostAggregator {
    turns: Vec<(String, CostMetrics)>,
}

impl CostAggregator {
    /// Create an empty aggregator for a new session.
    pub fn new() -> Self {
        Self { turns: Vec::new() }
    }

    /// Return a new aggregator with `metrics` appended.
    ///
    /// The caller must rebind: `let agg = agg.add_metric("claude-sonnet-4-6", m);`
    pub fn add_metric(self, model_id: impl Into<String>, metrics: CostMetrics) -> Self {
        let mut turns = self.turns;
        turns.push((model_id.into(), metrics));
        Self { turns }
    }

    /// Number of turns recorded in this session.
    pub fn turn_count(&self) -> usize {
        self.turns.len()
    }

    /// Sum of USD cost across all turns, using per-model pricing.
    pub fn total_cost_usd(&self) -> f64 {
        self.turns.iter().map(|(model, m)| m.cost_usd(model)).sum()
    }

    /// Cache-hit rate: `cache_read / (cache_read + input_tokens)`.
    ///
    /// Returns `0.0` when there are no input-side tokens (avoids div/0).
    /// Note: cache_creation tokens are *not* in the denominator — they
    /// represent new cache writes, not reads.
    pub fn cache_hit_rate(&self) -> f64 {
        let (total_input, total_read): (u64, u64) =
            self.turns.iter().fold((0, 0), |(ti, tr), (_, m)| {
                (
                    ti.saturating_add(m.input_tokens),
                    tr.saturating_add(m.cache_read_tokens),
                )
            });
        let denom = total_input.saturating_add(total_read);
        if denom == 0 {
            0.0
        } else {
            total_read as f64 / denom as f64
        }
    }

    /// Average USD cost per turn.  Returns `0.0` for an empty session.
    pub fn avg_cost_per_turn(&self) -> f64 {
        let n = self.turns.len();
        if n == 0 {
            return 0.0;
        }
        self.total_cost_usd() / n as f64
    }

    /// Per-turn costs for the **last ≤ 10 turns**, oldest-first.
    ///
    /// Useful for a small sparkline or trend indicator in the HUD overlay.
    pub fn trend_last_10_turns(&self) -> Vec<f64> {
        let start = self.turns.len().saturating_sub(10);
        self.turns[start..]
            .iter()
            .map(|(model, m)| m.cost_usd(model))
            .collect()
    }

    /// Returns `true` if any turn in this session used a non-Anthropic provider
    /// (detected via model-id slug: contains `"glm"` or `"ollama"`).
    fn has_diverse_providers(&self) -> bool {
        self.turns
            .iter()
            .any(|(model, _)| model.contains("glm") || model.contains("ollama"))
    }

    /// Aggregate cost for all turns whose model-id contains `slug`.
    fn slug_cost_usd(&self, slug: &str) -> f64 {
        self.turns
            .iter()
            .filter(|(model, _)| model.contains(slug))
            .map(|(model, m)| m.cost_usd(model))
            .sum()
    }

    /// One-line human-readable summary, suitable for logging or HUD overlay.
    ///
    /// Single-provider (Anthropic only):
    ///   `"Session cost: $0.43 | 82% cache hit | 12 turns | avg $0.036/turn"`
    ///
    /// Multi-provider (when GLM or Ollama turns are present):
    ///   `"GLM: $0.1600 | Ollama: $0.00 (free) | total $0.178 | 85% cache hit"`
    pub fn to_summary_string(&self) -> String {
        let total = self.total_cost_usd();
        let hit_pct = self.cache_hit_rate() * 100.0;
        let turns = self.turn_count();
        let avg = self.avg_cost_per_turn();

        if self.has_diverse_providers() {
            let glm = self.slug_cost_usd("glm");
            format!(
                "GLM: ${:.4} | Ollama: $0.00 (free) | total ${:.3} | {:.0}% cache hit",
                glm, total, hit_pct,
            )
        } else {
            format!(
                "Session cost: ${:.3} | {:.0}% cache hit | {} turns | avg ${:.4}/turn",
                total, hit_pct, turns, avg,
            )
        }
    }
}

impl Default for CostAggregator {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helper: build a CostMetrics literal quickly (Anthropic / unknown)
    // -----------------------------------------------------------------------
    fn m(input: u64, output: u64, cache_read: u64, cache_create: u64) -> CostMetrics {
        CostMetrics {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_create,
            timestamp: 0,
        }
    }

    // -----------------------------------------------------------------------
    // (a) Pricing math — Haiku / Sonnet / Opus (Anthropic, unchanged)
    // -----------------------------------------------------------------------

    #[test]
    fn haiku_pricing_1m_tokens() {
        // 1 000 000 input + 1 000 000 output → $1 + $5 = $6
        let metric = m(1_000_000, 1_000_000, 0, 0);
        let cost = metric.cost_usd("claude-haiku-4-5");
        let expected = 1.0 + 5.0;
        assert!(
            (cost - expected).abs() < 1e-6,
            "haiku 1M+1M: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn sonnet_pricing_1k_tokens() {
        // 1 000 input @ $3/MTok = $0.003; 1 000 output @ $15/MTok = $0.015
        let metric = m(1_000, 1_000, 0, 0);
        let cost = metric.cost_usd("claude-sonnet-4-6");
        let expected = 0.003 + 0.015;
        assert!(
            (cost - expected).abs() < 1e-9,
            "sonnet 1k+1k: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn opus_pricing_1k_tokens() {
        // 1 000 input @ $15/MTok = $0.015; 1 000 output @ $75/MTok = $0.075
        let metric = m(1_000, 1_000, 0, 0);
        let cost = metric.cost_usd("claude-opus-4-7");
        let expected = 0.015 + 0.075;
        assert!(
            (cost - expected).abs() < 1e-9,
            "opus 1k+1k: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn sonnet_cache_read_billed_at_10_pct() {
        // 1 000 cache_read @ 10% of $3/MTok = $0.30/MTok = $0.0003
        let metric = m(0, 0, 1_000, 0);
        let cost = metric.cost_usd("claude-sonnet-4-6");
        let expected = 0.0003;
        assert!(
            (cost - expected).abs() < 1e-9,
            "sonnet cache_read: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn sonnet_cache_create_billed_at_125_pct() {
        // 1 000 cache_create @ 125% of $3/MTok = $3.75/MTok = $0.00375
        let metric = m(0, 0, 0, 1_000);
        let cost = metric.cost_usd("claude-sonnet-4-6");
        let expected = 0.00375;
        assert!(
            (cost - expected).abs() < 1e-9,
            "sonnet cache_create: expected ${expected}, got ${cost}"
        );
    }

    // -----------------------------------------------------------------------
    // (b) GLM-5.1 pricing — $0.40/MTok input, $1.20/MTok output
    // -----------------------------------------------------------------------

    #[test]
    fn glm_pricing_1m_input_tokens() {
        // 1 000 000 input @ $0.40/MTok = $0.40
        let metric = CostMetrics::from_glm_usage(1_000_000, 0, 0);
        let cost = metric.cost_usd("glm-4-flash");
        let expected = 0.40;
        assert!(
            (cost - expected).abs() < 1e-9,
            "GLM 1M input: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn glm_pricing_1m_output_tokens() {
        // 1 000 000 output @ $1.20/MTok = $1.20
        let metric = CostMetrics::from_glm_usage(0, 1_000_000, 0);
        let cost = metric.cost_usd("glm-4-flash");
        let expected = 1.20;
        assert!(
            (cost - expected).abs() < 1e-9,
            "GLM 1M output: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn glm_pricing_combined_1m_each() {
        // 1M in + 1M out = $0.40 + $1.20 = $1.60
        let metric = CostMetrics::from_glm_usage(1_000_000, 1_000_000, 0);
        let cost = metric.cost_usd("glm-4-flash");
        let expected = 0.40 + 1.20;
        assert!(
            (cost - expected).abs() < 1e-9,
            "GLM 1M+1M: expected ${expected}, got ${cost}"
        );
    }

    #[test]
    fn glm_cache_tokens_do_not_add_cost() {
        // GLM_5_1 has cache_read_per_1k = 0 and cache_create_per_1k = 0,
        // so even large cache values add nothing to the bill.
        let metric = CostMetrics {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 999_999,
            cache_creation_tokens: 999_999,
            timestamp: 0,
        };
        let cost = metric.cost_usd("glm-4-flash");
        assert_eq!(cost, 0.0, "GLM cache tokens must never add cost");
    }

    // -----------------------------------------------------------------------
    // (c) Ollama — always free
    // -----------------------------------------------------------------------

    #[test]
    fn ollama_always_free() {
        let metric = CostMetrics::from_ollama_usage(5_000_000, 5_000_000, 0);
        let cost = metric.cost_usd("ollama");
        assert_eq!(cost, 0.0, "ollama must always cost $0.00");
    }

    #[test]
    fn ollama_round_trip_from_usage() {
        let metric = CostMetrics::from_ollama_usage(1_234, 5_678, 1_700_000_000);
        assert_eq!(metric.input_tokens, 1_234);
        assert_eq!(metric.output_tokens, 5_678);
        assert_eq!(metric.timestamp, 1_700_000_000);
        // Both bare "ollama" and namespaced "ollama/llama3" must be free.
        assert_eq!(metric.cost_usd("ollama"), 0.0);
        assert_eq!(metric.cost_usd("ollama/llama3"), 0.0);
    }

    // -----------------------------------------------------------------------
    // (d) Provider hint in rates_for beats slug-match
    // -----------------------------------------------------------------------

    #[test]
    fn rates_for_glm_provider_hint_beats_claude_slug() {
        // Provider hint "glm" must return GLM_5_1 even when model_id is a Claude slug.
        let r = pricing::rates_for("claude-sonnet-4-6", Some("glm"));
        assert!(
            (r.input_per_1k - 0.00040).abs() < 1e-9,
            "rates_for provider='glm' must return GLM input rate, got {}",
            r.input_per_1k
        );
        assert!(
            (r.output_per_1k - 0.00120).abs() < 1e-9,
            "rates_for provider='glm' must return GLM output rate"
        );
    }

    #[test]
    fn rates_for_ollama_provider_hint_beats_claude_slug() {
        let r = pricing::rates_for("claude-opus-4-7", Some("ollama"));
        assert_eq!(r.input_per_1k, 0.0, "ollama hint must override opus slug");
        assert_eq!(r.output_per_1k, 0.0);
    }

    #[test]
    fn rates_for_glm_slug_routing() {
        // Without a provider hint, "glm-4-flash" slug routes to GLM_5_1.
        let r = pricing::rates_for("glm-4-flash", None);
        assert!(
            (r.input_per_1k - 0.00040).abs() < 1e-9,
            "glm slug must route to GLM_5_1 input rate"
        );
    }

    #[test]
    fn rates_for_ollama_slug_routing() {
        let r = pricing::rates_for("ollama/llama3", None);
        assert_eq!(r.input_per_1k, 0.0, "ollama slug must route to OLLAMA rates");
    }

    // -----------------------------------------------------------------------
    // (e) from_glm_usage round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn from_glm_usage_round_trip() {
        let metric = CostMetrics::from_glm_usage(8_000, 2_000, 1_700_100_000);
        assert_eq!(metric.input_tokens, 8_000);
        assert_eq!(metric.output_tokens, 2_000);
        assert_eq!(metric.cache_read_tokens, 0);
        assert_eq!(metric.cache_creation_tokens, 0);
        assert_eq!(metric.timestamp, 1_700_100_000);
        // 8k input @ $0.40/MTok = 8 × $0.00040/1k; 2k output @ $1.20/MTok = 2 × $0.00120/1k
        let cost = metric.cost_usd("glm-4-flash");
        let expected = 8.0 * 0.00040 + 2.0 * 0.00120;
        assert!(
            (cost - expected).abs() < 1e-12,
            "from_glm_usage cost mismatch: expected {expected:.8}, got {cost:.8}"
        );
    }

    // -----------------------------------------------------------------------
    // (f) Cache hit rate — unchanged behaviour
    // -----------------------------------------------------------------------

    #[test]
    fn cache_hit_rate_zero_when_no_reads() {
        let agg = CostAggregator::new()
            .add_metric("claude-sonnet-4-6", m(500, 200, 0, 0))
            .add_metric("claude-sonnet-4-6", m(800, 300, 0, 0));
        assert_eq!(
            agg.cache_hit_rate(),
            0.0,
            "hit rate must be 0.0 when no cache reads"
        );
    }

    #[test]
    fn cache_hit_rate_zero_for_empty_aggregator() {
        let agg = CostAggregator::new();
        assert_eq!(agg.cache_hit_rate(), 0.0);
    }

    #[test]
    fn cache_hit_rate_correct_with_reads() {
        // 100 input + 900 cache_read → 900/1000 = 0.90
        let agg = CostAggregator::new().add_metric("claude-sonnet-4-6", m(100, 50, 900, 0));
        let rate = agg.cache_hit_rate();
        assert!(
            (rate - 0.9).abs() < 1e-9,
            "expected 0.9 hit rate, got {rate}"
        );
    }

    // -----------------------------------------------------------------------
    // (g) trend_last_10_turns
    // -----------------------------------------------------------------------

    #[test]
    fn trend_capped_at_10() {
        let mut agg = CostAggregator::new();
        for i in 0..15_u64 {
            agg = agg.add_metric("claude-sonnet-4-6", m(i * 100, i * 50, 0, 0));
        }
        let trend = agg.trend_last_10_turns();
        assert_eq!(
            trend.len(),
            10,
            "trend must return exactly 10 items for 15 turns"
        );
    }

    #[test]
    fn trend_fewer_than_10_returns_all() {
        let agg = CostAggregator::new()
            .add_metric("claude-sonnet-4-6", m(100, 50, 0, 0))
            .add_metric("claude-haiku-4-5", m(200, 80, 0, 0));
        let trend = agg.trend_last_10_turns();
        assert_eq!(trend.len(), 2);
    }

    #[test]
    fn trend_empty_for_empty_aggregator() {
        let agg = CostAggregator::new();
        assert!(agg.trend_last_10_turns().is_empty());
    }

    // -----------------------------------------------------------------------
    // (h) to_summary_string — single-provider (Anthropic) format
    // -----------------------------------------------------------------------

    #[test]
    fn summary_string_format_stable() {
        // 2 sonnet turns: 1k input + 1k output each → $0.018 total / 2 = $0.009 avg
        let agg = CostAggregator::new()
            .add_metric("claude-sonnet-4-6", m(1_000, 1_000, 0, 0))
            .add_metric("claude-sonnet-4-6", m(1_000, 1_000, 0, 0));
        let s = agg.to_summary_string();
        assert!(
            s.starts_with("Session cost: $"),
            "missing 'Session cost: $' in: {s}"
        );
        assert!(s.contains("cache hit"), "missing 'cache hit' in: {s}");
        assert!(s.contains("turns"), "missing 'turns' in: {s}");
        assert!(s.contains("avg $"), "missing 'avg $' in: {s}");
        assert!(s.contains("/turn"), "missing '/turn' in: {s}");
        assert!(s.contains("$0.036"), "expected $0.036 total cost in: {s}");
    }

    #[test]
    fn summary_string_empty_session() {
        let s = CostAggregator::new().to_summary_string();
        assert!(
            s.contains("$0.000"),
            "empty session cost must be $0.000: {s}"
        );
        assert!(
            s.contains("0 turns"),
            "empty session must show 0 turns: {s}"
        );
    }

    // -----------------------------------------------------------------------
    // (i) to_summary_string — multi-provider format (GLM + Ollama + Anthropic)
    // -----------------------------------------------------------------------

    #[test]
    fn summary_string_multi_provider_format() {
        // GLM turn: 1M in + 1M out = $1.60
        // Ollama turn: any tokens = $0.00
        // Sonnet turn: 1k in + 1k out = $0.018
        let glm_m = CostMetrics::from_glm_usage(1_000_000, 1_000_000, 0);
        let ollama_m = CostMetrics::from_ollama_usage(500_000, 500_000, 0);
        let agg = CostAggregator::new()
            .add_metric("glm-4-flash", glm_m)
            .add_metric("ollama", ollama_m)
            .add_metric("claude-sonnet-4-6", m(1_000, 1_000, 0, 0));

        let s = agg.to_summary_string();
        assert!(s.contains("GLM:"), "expected 'GLM:' segment in: {s}");
        assert!(
            s.contains("Ollama: $0.00 (free)"),
            "expected 'Ollama: $0.00 (free)' in: {s}"
        );
        assert!(s.contains("total $"), "expected 'total $' in: {s}");
        assert!(s.contains("cache hit"), "expected 'cache hit' in: {s}");
        assert!(
            !s.starts_with("Session cost:"),
            "multi-provider must not start with 'Session cost:': {s}"
        );
    }

    #[test]
    fn summary_string_three_providers_cache_hit_shown() {
        // GLM turn + Anthropic turn with high cache read
        let glm_m = CostMetrics::from_glm_usage(100_000, 100_000, 0);
        // 100 input + 900 cache_read → 90 % cache hit rate
        let anthropic_m = m(100, 50, 900, 0);
        let agg = CostAggregator::new()
            .add_metric("glm-4-flash", glm_m)
            .add_metric("claude-sonnet-4-6", anthropic_m);
        let s = agg.to_summary_string();
        assert!(
            s.contains("cache hit"),
            "cache hit must appear in multi-provider summary: {s}"
        );
    }

    // -----------------------------------------------------------------------
    // (j) Immutability: original aggregator unchanged after add_metric
    // -----------------------------------------------------------------------

    #[test]
    fn add_metric_does_not_mutate_original() {
        let agg0 = CostAggregator::new();
        let agg1 = agg0
            .clone()
            .add_metric("claude-sonnet-4-6", m(1_000, 500, 0, 0));
        assert_eq!(agg0.turn_count(), 0);
        assert_eq!(agg1.turn_count(), 1);
    }

    // -----------------------------------------------------------------------
    // (k) from_event round-trip (Anthropic)
    // -----------------------------------------------------------------------

    #[test]
    fn from_event_round_trip() {
        let ev = TelemetryEvent {
            provider: "anthropic".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            input: 500,
            cache_read: 200,
            cache_create: 50,
            output: 300,
            duration_ms: 750,
            at: 1_700_000_000,
            cost_usd: 0.0,
            tier: None,
        };
        let m = CostMetrics::from_event(&ev);
        assert_eq!(m.input_tokens, 500);
        assert_eq!(m.cache_read_tokens, 200);
        assert_eq!(m.cache_creation_tokens, 50);
        assert_eq!(m.output_tokens, 300);
        assert_eq!(m.timestamp, 1_700_000_000);
    }
}
