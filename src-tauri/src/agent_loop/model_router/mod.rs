//! `model_router` — four-tier heuristic model selection.
//!
//! ## Tiers
//!
//! | Tier        | Provider   | Model                               | Use-case                                  |
//! |-------------|------------|-------------------------------------|-------------------------------------------|
//! | QuickThink  | Ollama     | qwen2.5:3b                          | Classification, routing, trivial Q&A      |
//! | Cloud       | Glm        | glm-5.1                             | Default coding / reasoning (3-7 s TTFA)   |
//! | DeepLocal   | Ollama     | qwen3:30b-a3b-instruct-2507-q4_K_M  | Privacy-sensitive, offline, cost fallback |
//! | Premium     | ClaudeCode | opus                                | Architecture, critic, long plans          |
//!
//! ## Decision rules (ordered)
//!
//! 1. `privacy_sensitive` → DeepLocal
//! 2. `quality_mode == CostAware` → clamp ≤ Cloud
//! 3. `quality_mode == AlwaysBest` + {Architectural, LongMultiStepPlan} → Premium
//! 4. `inside_reflexion_critic` → Premium
//! 5. Simple lookup + short message → QuickThink
//! 6. Default → Cloud
//!
//! ## Backward compatibility
//!
//! `MODEL_HAIKU`, `MODEL_SONNET`, `MODEL_OPUS` constants are preserved as
//! legacy aliases. `route_model` now returns `RoutingDecision` with an
//! explicit `tier`, `provider`, `model_id`, `reasoning`, and `fallback_chain`.

pub mod fallback;
pub mod route;
pub mod tier;

// ---------------------------------------------------------------------------
// Flat re-exports — the public surface of this module
// ---------------------------------------------------------------------------

pub use tier::{Provider, QualityMode, Tier};
pub use tier::{MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET};
pub use route::{route_model, RoutingContext, RoutingDecision, TaskClass};
pub use fallback::build_fallback_chain;
