//! `tier` — Tier enum, Provider enum, and their associated model-ID strings.
//!
//! This module is purely data: no logic, no mutation.

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/// The backend provider that owns a given tier's model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    /// Local Ollama daemon — free, zero data egress.
    Ollama,
    /// GLM cloud API — cost-effective cloud reasoning.
    Glm,
    /// Delegates via the `claude` CLI (ClaudeCode / Anthropic subscription).
    ClaudeCode,
}

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

/// Four-tier model selection hierarchy.
///
/// | Tier         | Provider    | Model                                | Typical TTFA |
/// |--------------|-------------|--------------------------------------|--------------|
/// | QuickThink   | Ollama      | qwen2.5:3b                           | <1 s         |
/// | Cloud        | Glm         | glm-5.1                              | 3-7 s        |
/// | DeepLocal    | Ollama      | qwen3:30b-a3b-instruct-2507-q4_K_M  | 10-30 s      |
/// | Premium      | ClaudeCode  | opus                                 | varies       |
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tier {
    /// Classification, routing, trivial Q&A, intent detection.
    /// Free and fast (<1 s TTFA).
    QuickThink,
    /// Default user-facing coding / reasoning. $0.40/M in tokens, 3-7 s TTFA.
    Cloud,
    /// Privacy-sensitive, offline, or cost-cap-exhausted fallback.
    /// Free but slow (10-30 s TTFA).
    DeepLocal,
    /// Architectural decisions, complex debugging, long multi-step plans.
    /// Delegates via `claude` CLI — costs Anthropic subscription dollars.
    Premium,
}

impl Tier {
    /// Return the canonical `(provider, model_id)` pair for this tier.
    pub fn provider_and_model(self) -> (Provider, &'static str) {
        match self {
            Tier::QuickThink => (Provider::Ollama, "qwen2.5:3b"),
            Tier::Cloud      => (Provider::Glm,   "glm-5.1"),
            Tier::DeepLocal  => (Provider::Ollama, "qwen3:30b-a3b-instruct-2507-q4_K_M"),
            Tier::Premium    => (Provider::ClaudeCode, "opus"),
        }
    }

    /// Short human-readable label, used in reasoning strings and logs.
    pub fn label(self) -> &'static str {
        match self {
            Tier::QuickThink => "quick_think",
            Tier::Cloud      => "cloud",
            Tier::DeepLocal  => "deep_local",
            Tier::Premium    => "premium",
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy model-ID constants (keep for callers that import them directly)
// ---------------------------------------------------------------------------

/// Legacy alias — callers expecting a Haiku-style fast model get QuickThink.
pub const MODEL_HAIKU: &str = "qwen2.5:3b";

/// Legacy alias — callers expecting a Sonnet-style model get Cloud tier.
pub const MODEL_SONNET: &str = "glm-5.1";

/// Legacy alias — callers expecting Opus-level depth get Premium tier.
pub const MODEL_OPUS: &str = "opus";

// ---------------------------------------------------------------------------
// QualityMode
// ---------------------------------------------------------------------------

/// Caller-controlled quality/cost trade-off knob.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QualityMode {
    /// Never use Premium; cap at Cloud tier. Good for batch or budget contexts.
    CostAware,
    /// Use the best tier that matches task complexity (default).
    #[default]
    Balanced,
    /// Upgrade to Premium for any task that could benefit from deeper reasoning.
    AlwaysBest,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_think_provider_and_model() {
        let (p, m) = Tier::QuickThink.provider_and_model();
        assert_eq!(p, Provider::Ollama);
        assert_eq!(m, "qwen2.5:3b");
    }

    #[test]
    fn cloud_provider_and_model() {
        let (p, m) = Tier::Cloud.provider_and_model();
        assert_eq!(p, Provider::Glm);
        assert_eq!(m, "glm-5.1");
    }

    #[test]
    fn deep_local_provider_and_model() {
        let (p, m) = Tier::DeepLocal.provider_and_model();
        assert_eq!(p, Provider::Ollama);
        assert_eq!(m, "qwen3:30b-a3b-instruct-2507-q4_K_M");
    }

    #[test]
    fn premium_provider_and_model() {
        let (p, m) = Tier::Premium.provider_and_model();
        assert_eq!(p, Provider::ClaudeCode);
        assert_eq!(m, "opus");
    }

    #[test]
    fn tier_labels_are_non_empty() {
        for t in [Tier::QuickThink, Tier::Cloud, Tier::DeepLocal, Tier::Premium] {
            assert!(!t.label().is_empty());
        }
    }

    #[test]
    fn legacy_constants_have_expected_values() {
        assert_eq!(MODEL_HAIKU,  "qwen2.5:3b");
        assert_eq!(MODEL_SONNET, "glm-5.1");
        assert_eq!(MODEL_OPUS,   "opus");
    }

    #[test]
    fn quality_mode_default_is_balanced() {
        assert_eq!(QualityMode::default(), QualityMode::Balanced);
    }
}
