//! `route` — core routing logic: RoutingContext → RoutingDecision.
//!
//! Decision rules (evaluated in priority order):
//!
//! 1. `privacy_sensitive` → DeepLocal (never leave the machine).
//! 2. `quality_mode == CostAware` → clamp at Cloud (never Premium).
//! 3. `quality_mode == AlwaysBest` AND task in {Architectural, LongMultiStepPlan} → Premium.
//! 4. `inside_reflexion_critic` → Premium (critic needs the best).
//! 5. Simple lookup + short message → QuickThink.
//! 6. Default → Cloud.

use super::fallback::build_fallback_chain;
use super::tier::{Provider, QualityMode, Tier};

// ---------------------------------------------------------------------------
// Re-export TaskClass from here for convenience
// ---------------------------------------------------------------------------

/// Classification of the task style inferred by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskClass {
    /// Single-fact lookup, clarification, or trivial conversion.
    SimpleLookup,
    /// Coding, debugging, or moderate reasoning — the common case.
    CodingOrReasoning,
    /// Architecture review, multi-file refactor, system design.
    ArchitecturalDecision,
    /// A long, numbered, multi-step plan.
    LongMultiStepPlan,
}

// ---------------------------------------------------------------------------
// RoutingContext
// ---------------------------------------------------------------------------

/// Everything the router needs to make a decision.
///
/// All fields are immutable; callers build a new value each turn.
#[derive(Debug, Clone)]
pub struct RoutingContext {
    /// Full text of the user's latest message.
    pub message: String,

    /// Number of distinct tool calls already dispatched in this turn.
    pub tool_calls_so_far: usize,

    /// Caller's best guess at the task style. When `None` the router
    /// infers from `message` heuristics alone.
    pub task_class: Option<TaskClass>,

    /// `true` when this call is a retry after a tool-dispatch error.
    pub is_retry_after_tool_error: bool,

    /// `true` when this turn is running inside a `plan_execute` composite.
    pub inside_plan_execute: bool,

    /// `true` when this turn is a reflexion critic or refiner round.
    pub inside_reflexion_critic: bool,

    /// Iteration index within a reflexion loop (0 = first draft).
    pub reflexion_iteration: u8,

    /// Cost/quality trade-off. Defaults to `Balanced`.
    pub quality_mode: QualityMode,

    /// When `true` the request must stay on-device (DeepLocal or QuickThink).
    /// Callers set this after scanning for PII / sensitive content.
    pub privacy_sensitive: bool,
}

impl RoutingContext {
    /// Build a minimal context from the message text alone.
    /// All flags default to `false`; `quality_mode` defaults to `Balanced`.
    pub fn from_message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            tool_calls_so_far: 0,
            task_class: None,
            is_retry_after_tool_error: false,
            inside_plan_execute: false,
            inside_reflexion_critic: false,
            reflexion_iteration: 0,
            quality_mode: QualityMode::Balanced,
            privacy_sensitive: false,
        }
    }
}

// ---------------------------------------------------------------------------
// RoutingDecision
// ---------------------------------------------------------------------------

/// The router's full verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingDecision {
    /// Selected tier.
    pub tier: Tier,
    /// Provider that owns the tier.
    pub provider: Provider,
    /// Model identifier string to forward to the provider.
    pub model_id: &'static str,
    /// Human-readable explanation. Log via `log::debug!`, never to the UI.
    pub reasoning: String,
    /// Ordered fallback sequence starting at `tier`, ending at `QuickThink`.
    pub fallback_chain: Vec<Tier>,
}

// ---------------------------------------------------------------------------
// Core routing function
// ---------------------------------------------------------------------------

/// Select the best tier for `ctx`. Deterministic and pure (no side effects).
pub fn route_model(ctx: &RoutingContext) -> RoutingDecision {
    let (tier, reason) = decide_tier(ctx);
    let (provider, model_id) = tier.provider_and_model();
    let fallback_chain = build_fallback_chain(tier);

    let reasoning = format!(
        "model_router → {} [provider={:?}, model={}]: {}",
        tier.label(), provider, model_id, reason
    );

    RoutingDecision { tier, provider, model_id, reasoning, fallback_chain }
}

// ---------------------------------------------------------------------------
// Internal decision tree
// ---------------------------------------------------------------------------

/// Returns `(Tier, reason_string)`. Pure function; no allocations beyond
/// the reason string.
fn decide_tier(ctx: &RoutingContext) -> (Tier, &'static str) {
    // Rule 1 — privacy gate: must stay on-device.
    if ctx.privacy_sensitive {
        return (Tier::DeepLocal, "privacy_sensitive=true, staying on-device");
    }

    // Rule 2 — cost cap: clamp at Cloud, never Premium.
    // (We evaluate this before rules 3/4 so CostAware always wins over
    // quality-escalation signals.)
    if ctx.quality_mode == QualityMode::CostAware {
        // Within the cost cap, we still allow QuickThink for simple tasks.
        return match ctx.task_class {
            Some(TaskClass::SimpleLookup) if !is_long_message(&ctx.message) => {
                (Tier::QuickThink, "cost_aware + simple_lookup + short message")
            }
            _ => (Tier::Cloud, "cost_aware clamp: max=Cloud"),
        };
    }

    // Rule 3 — AlwaysBest + heavy task → Premium.
    if ctx.quality_mode == QualityMode::AlwaysBest {
        match ctx.task_class {
            Some(TaskClass::ArchitecturalDecision) => {
                return (Tier::Premium, "always_best + ArchitecturalDecision");
            }
            Some(TaskClass::LongMultiStepPlan) => {
                return (Tier::Premium, "always_best + LongMultiStepPlan");
            }
            _ => {}
        }
    }

    // Rule 4 — reflexion critic always uses Premium.
    if ctx.inside_reflexion_critic {
        return (Tier::Premium, "inside_reflexion_critic=true");
    }

    // Rule 5 — simple lookup + short message → QuickThink.
    if is_simple_lookup(ctx) && !is_long_message(&ctx.message) {
        return (Tier::QuickThink, "simple_lookup + short message");
    }

    // Rule 6 — default.
    (Tier::Cloud, "default: Cloud tier")
}

// ---------------------------------------------------------------------------
// Heuristic helpers (pure)
// ---------------------------------------------------------------------------

const LONG_MSG_CHARS: usize = 500;

fn is_long_message(msg: &str) -> bool {
    msg.len() >= LONG_MSG_CHARS
}

fn is_simple_lookup(ctx: &RoutingContext) -> bool {
    if let Some(tc) = ctx.task_class {
        return tc == TaskClass::SimpleLookup;
    }
    // Heuristic: short message with typical lookup keywords and zero tools.
    if ctx.tool_calls_so_far > 0 || is_long_message(&ctx.message) {
        return false;
    }
    let lower = ctx.message.to_lowercase();
    contains_any(&lower, &["what is", "define ", "when is", "how many", "convert ", "translate "])
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- helpers ---

    fn ctx(msg: &str) -> RoutingContext {
        RoutingContext::from_message(msg)
    }

    fn ctx_class(msg: &str, class: TaskClass) -> RoutingContext {
        RoutingContext { task_class: Some(class), ..ctx(msg) }
    }

    fn assert_tier(ctx: &RoutingContext, expected: Tier) {
        let d = route_model(ctx);
        assert_eq!(
            d.tier, expected,
            "expected {:?} but got {:?} — reason: {}",
            expected, d.tier, d.reasoning
        );
    }

    // === Rule 1: privacy gate ===

    #[test]
    fn privacy_sensitive_always_deep_local() {
        let c = RoutingContext { privacy_sensitive: true, ..ctx("my medical records") };
        assert_tier(&c, Tier::DeepLocal);
    }

    #[test]
    fn privacy_sensitive_overrides_always_best() {
        let c = RoutingContext {
            privacy_sensitive: true,
            quality_mode: QualityMode::AlwaysBest,
            task_class: Some(TaskClass::ArchitecturalDecision),
            ..ctx("design system with SSN data")
        };
        assert_tier(&c, Tier::DeepLocal);
    }

    #[test]
    fn privacy_sensitive_overrides_reflexion_critic() {
        let c = RoutingContext {
            privacy_sensitive: true,
            inside_reflexion_critic: true,
            ..ctx("critique the plan")
        };
        assert_tier(&c, Tier::DeepLocal);
    }

    // === Rule 2: CostAware clamp ===

    #[test]
    fn cost_aware_coding_clamps_to_cloud() {
        let c = RoutingContext {
            quality_mode: QualityMode::CostAware,
            task_class: Some(TaskClass::CodingOrReasoning),
            ..ctx("fix the bug")
        };
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn cost_aware_architectural_clamps_to_cloud() {
        let c = RoutingContext {
            quality_mode: QualityMode::CostAware,
            task_class: Some(TaskClass::ArchitecturalDecision),
            ..ctx("design the whole system")
        };
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn cost_aware_long_plan_clamps_to_cloud() {
        let c = RoutingContext {
            quality_mode: QualityMode::CostAware,
            task_class: Some(TaskClass::LongMultiStepPlan),
            ..ctx("build the entire pipeline")
        };
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn cost_aware_simple_lookup_short_routes_quick_think() {
        let c = RoutingContext {
            quality_mode: QualityMode::CostAware,
            task_class: Some(TaskClass::SimpleLookup),
            ..ctx("what is 2+2")
        };
        assert_tier(&c, Tier::QuickThink);
    }

    #[test]
    fn cost_aware_reflexion_critic_clamps_to_cloud_not_premium() {
        // Even though reflexion_critic normally → Premium, CostAware clamps it.
        let c = RoutingContext {
            quality_mode: QualityMode::CostAware,
            inside_reflexion_critic: true,
            ..ctx("critique this")
        };
        assert_tier(&c, Tier::Cloud);
    }

    // === Rule 3: AlwaysBest + heavy tasks ===

    #[test]
    fn always_best_architectural_routes_premium() {
        let c = RoutingContext {
            quality_mode: QualityMode::AlwaysBest,
            task_class: Some(TaskClass::ArchitecturalDecision),
            ..ctx("design the auth system")
        };
        assert_tier(&c, Tier::Premium);
    }

    #[test]
    fn always_best_long_plan_routes_premium() {
        let c = RoutingContext {
            quality_mode: QualityMode::AlwaysBest,
            task_class: Some(TaskClass::LongMultiStepPlan),
            ..ctx("outline the full migration")
        };
        assert_tier(&c, Tier::Premium);
    }

    #[test]
    fn always_best_coding_routes_cloud_not_premium() {
        // AlwaysBest only escalates specific heavy task classes.
        let c = RoutingContext {
            quality_mode: QualityMode::AlwaysBest,
            task_class: Some(TaskClass::CodingOrReasoning),
            ..ctx("fix the parser")
        };
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn always_best_simple_lookup_routes_quick_think() {
        let c = RoutingContext {
            quality_mode: QualityMode::AlwaysBest,
            task_class: Some(TaskClass::SimpleLookup),
            ..ctx("what is pi")
        };
        assert_tier(&c, Tier::QuickThink);
    }

    // === Rule 4: reflexion critic ===

    #[test]
    fn reflexion_critic_balanced_routes_premium() {
        let c = RoutingContext {
            inside_reflexion_critic: true,
            ..ctx("critique this draft")
        };
        assert_tier(&c, Tier::Premium);
    }

    // === Rule 5: QuickThink ===

    #[test]
    fn simple_lookup_class_short_message_routes_quick_think() {
        let c = ctx_class("what time is it in Tokyo", TaskClass::SimpleLookup);
        assert_tier(&c, Tier::QuickThink);
    }

    #[test]
    fn lookup_keyword_short_no_tools_routes_quick_think() {
        let c = ctx("what is a monad");
        assert_tier(&c, Tier::QuickThink);
    }

    #[test]
    fn simple_lookup_long_message_routes_cloud_not_quick_think() {
        let long_msg = format!("what is {}", "x".repeat(600));
        let c = ctx_class(&long_msg, TaskClass::SimpleLookup);
        assert_tier(&c, Tier::Cloud);
    }

    // === Rule 6: default Cloud ===

    #[test]
    fn default_empty_message_routes_cloud() {
        let c = ctx("");
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn coding_class_routes_cloud() {
        let c = ctx_class("fix the off-by-one in binary search", TaskClass::CodingOrReasoning);
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn long_message_no_keywords_routes_cloud() {
        let long_msg = "a".repeat(600);
        let c = ctx(&long_msg);
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn balanced_architectural_routes_cloud_not_premium() {
        // AlwaysBest is needed for Premium on ArchitecturalDecision; Balanced → Cloud.
        let c = ctx_class("design the whole system", TaskClass::ArchitecturalDecision);
        assert_tier(&c, Tier::Cloud);
    }

    #[test]
    fn balanced_long_plan_routes_cloud_not_premium() {
        let c = ctx_class("outline the migration steps", TaskClass::LongMultiStepPlan);
        assert_tier(&c, Tier::Cloud);
    }

    // === RoutingDecision shape ===

    #[test]
    fn decision_has_correct_provider_for_quick_think() {
        let c = ctx_class("what is 1+1", TaskClass::SimpleLookup);
        let d = route_model(&c);
        assert_eq!(d.provider, super::Provider::Ollama);
        assert_eq!(d.model_id, "qwen2.5:3b");
    }

    #[test]
    fn decision_has_correct_provider_for_cloud() {
        let c = ctx("fix the parser bug");
        let d = route_model(&c);
        assert_eq!(d.provider, super::Provider::Glm);
        assert_eq!(d.model_id, "glm-5.1");
    }

    #[test]
    fn decision_reasoning_is_non_empty() {
        let c = ctx("hello");
        let d = route_model(&c);
        assert!(!d.reasoning.is_empty());
    }

    #[test]
    fn decision_reasoning_contains_tier_label() {
        let c = RoutingContext {
            quality_mode: QualityMode::AlwaysBest,
            task_class: Some(TaskClass::ArchitecturalDecision),
            ..ctx("design this system")
        };
        let d = route_model(&c);
        assert!(d.reasoning.contains("premium"), "reasoning: {}", d.reasoning);
    }

    #[test]
    fn fallback_chain_present_in_decision() {
        let c = ctx("some task");
        let d = route_model(&c);
        assert!(!d.fallback_chain.is_empty());
        assert_eq!(d.fallback_chain[0], d.tier);
    }

    // === from_message defaults ===

    #[test]
    fn from_message_sets_all_defaults() {
        let c = RoutingContext::from_message("hi");
        assert_eq!(c.tool_calls_so_far, 0);
        assert!(!c.is_retry_after_tool_error);
        assert!(!c.inside_plan_execute);
        assert!(!c.inside_reflexion_critic);
        assert_eq!(c.reflexion_iteration, 0);
        assert!(c.task_class.is_none());
        assert_eq!(c.quality_mode, QualityMode::Balanced);
        assert!(!c.privacy_sensitive);
    }

    // === Immutability: route_model must not mutate ctx ===

    #[test]
    fn route_model_does_not_mutate_context() {
        let c = RoutingContext {
            message: "design the database".to_string(),
            tool_calls_so_far: 5,
            task_class: Some(TaskClass::ArchitecturalDecision),
            is_retry_after_tool_error: true,
            inside_plan_execute: true,
            inside_reflexion_critic: false,
            reflexion_iteration: 1,
            quality_mode: QualityMode::Balanced,
            privacy_sensitive: false,
        };
        let snapshot_msg = c.message.clone();
        let snapshot_tools = c.tool_calls_so_far;
        let _ = route_model(&c);
        assert_eq!(c.message, snapshot_msg);
        assert_eq!(c.tool_calls_so_far, snapshot_tools);
    }
}
