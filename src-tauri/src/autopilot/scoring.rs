//! Scoring — pure function `score()` over a signal + recent context bag.
//!
//! # Formula
//!
//!   score = w_novelty * novelty
//!         + w_urgency * urgency
//!         + w_user_value * user_value
//!         - w_nudge_density * nudge_density_penalty
//!
//! All components are in [0, 1] before weighting. The final score is clamped
//! to [0, 1]. No I/O — fully unit-testable.

/// Weights must sum to 1.0.
pub const W_NOVELTY: f32 = 0.30;
pub const W_URGENCY: f32 = 0.30;
pub const W_USER_VALUE: f32 = 0.30;
pub const W_NUDGE_DENSITY: f32 = 0.10;

/// Maximum number of recent signals considered for nudge-density calculation.
const DENSITY_WINDOW: usize = 10;
/// Nudge density is penalised linearly up to this many signals per window.
const DENSITY_PENALTY_AT: usize = 5;

/// Lightweight descriptor of a single incoming signal.
#[derive(Debug, Clone)]
pub struct Signal {
    /// Sensor source string, e.g. "idle", "fs_burst", "build", "clipboard".
    pub source: String,
    /// Urgency hint from the sensor: 0.0 (routine) → 1.0 (critical).
    pub urgency_hint: f32,
    /// Whether this signal type is inherently actionable for the user.
    pub actionable: bool,
}

/// Recent-bag entry: a record of signals seen in the coalescing window.
#[derive(Debug, Clone)]
pub struct BagEntry {
    /// Sensor source of the past signal.
    pub source: String,
    /// Unix second when it was emitted.
    pub at_secs: i64,
}

/// Minimal world-state context consumed by the scorer (avoids importing the
/// full `WorldState` — keeps this module dependency-free).
#[derive(Debug, Clone, Default)]
pub struct WorldContext {
    /// Current user activity string from the world model ("idle", "coding", etc.)
    pub activity: String,
    /// Whether the user appears to be idle (idle_secs > threshold).
    pub user_idle: bool,
}

/// Score a signal in [0, 1].
///
/// - `signal`: the incoming sensor signal.
/// - `recent_bag`: signals seen in the last N seconds (caller controls window).
/// - `world`: current world-model snapshot.
///
/// This is a pure function: no side effects, no I/O, deterministic.
pub fn score(signal: &Signal, recent_bag: &[BagEntry], world: &WorldContext) -> f32 {
    let novelty = compute_novelty(signal, recent_bag);
    let urgency = compute_urgency(signal, world);
    let user_value = compute_user_value(signal, world);
    let nudge_penalty = compute_nudge_density(recent_bag);

    let raw = W_NOVELTY * novelty
        + W_URGENCY * urgency
        + W_USER_VALUE * user_value
        - W_NUDGE_DENSITY * nudge_penalty;

    raw.clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Component functions (each returns a value in [0, 1])
// ---------------------------------------------------------------------------

/// Novelty: low when we've seen the same source recently, high when it's new.
fn compute_novelty(signal: &Signal, recent_bag: &[BagEntry]) -> f32 {
    let recent_same = recent_bag
        .iter()
        .rev()
        .take(DENSITY_WINDOW)
        .filter(|e| e.source == signal.source)
        .count();

    // Linear decay: 0 occurrences → 1.0, 5+ occurrences → 0.0.
    let penalty = (recent_same as f32 / DENSITY_PENALTY_AT as f32).min(1.0);
    1.0 - penalty
}

/// Urgency: combines the sensor's hint with world-state amplifiers.
fn compute_urgency(signal: &Signal, world: &WorldContext) -> f32 {
    let base = signal.urgency_hint.clamp(0.0, 1.0);

    // Build signals are more urgent when the user is actively coding.
    let coding_boost = if signal.source == "build" && world.activity == "coding" {
        0.20_f32
    } else {
        0.0
    };

    // Idle users tolerate lower urgency signals better — reduce pressure.
    let idle_reduction = if world.user_idle { 0.10_f32 } else { 0.0 };

    (base + coding_boost - idle_reduction).clamp(0.0, 1.0)
}

/// User value: does this signal represent something the user cares about?
fn compute_user_value(signal: &Signal, world: &WorldContext) -> f32 {
    let base: f32 = if signal.actionable { 0.80 } else { 0.40 };

    // Clipboard changes during coding are highly relevant (code snippet copy).
    let context_boost = if signal.source == "clipboard" && world.activity == "coding" {
        0.15_f32
    } else if signal.source == "fs_burst" && world.activity == "coding" {
        // Active save burst during coding → user is actively working.
        0.10_f32
    } else {
        0.0
    };

    (base + context_boost).clamp(0.0, 1.0)
}

/// Nudge density penalty: how many signals have we surfaced recently?
/// Returns a value in [0, 1] — higher means more recent nudges.
fn compute_nudge_density(recent_bag: &[BagEntry]) -> f32 {
    let window = recent_bag.iter().rev().take(DENSITY_WINDOW).count();
    (window as f32 / DENSITY_PENALTY_AT as f32).min(1.0)
}

// ---------------------------------------------------------------------------
// Tests — 10+ unit tests covering all components
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(source: &str, urgency: f32, actionable: bool) -> Signal {
        Signal {
            source: source.to_string(),
            urgency_hint: urgency,
            actionable,
        }
    }

    fn bag(sources: &[&str]) -> Vec<BagEntry> {
        sources
            .iter()
            .enumerate()
            .map(|(i, s)| BagEntry {
                source: s.to_string(),
                at_secs: 1_000_000 + i as i64,
            })
            .collect()
    }

    fn world(activity: &str, idle: bool) -> WorldContext {
        WorldContext {
            activity: activity.to_string(),
            user_idle: idle,
        }
    }

    // 1. Score is always in [0, 1].
    #[test]
    fn score_clamped_to_unit_interval() {
        let s = score(&sig("build", 1.0, true), &bag(&[]), &world("coding", false));
        assert!((0.0..=1.0).contains(&s), "score {s} out of [0,1]");
    }

    // 2. Novel signal (empty bag) scores higher than repeated signal.
    #[test]
    fn novelty_reduces_with_repetition() {
        let empty: Vec<BagEntry> = vec![];
        let repeated = bag(&["build", "build", "build", "build", "build"]);
        let s_novel = score(&sig("build", 0.5, true), &empty, &world("coding", false));
        let s_repeated = score(&sig("build", 0.5, true), &repeated, &world("coding", false));
        assert!(s_novel > s_repeated, "novel={s_novel} repeated={s_repeated}");
    }

    // 3. High-urgency signal scores higher than low-urgency.
    #[test]
    fn urgency_increases_score() {
        let w = world("coding", false);
        let low = score(&sig("build", 0.1, true), &bag(&[]), &w);
        let high = score(&sig("build", 0.9, true), &bag(&[]), &w);
        assert!(high > low, "high urgency should score higher: {high} vs {low}");
    }

    // 4. Actionable signals score higher than non-actionable.
    #[test]
    fn actionable_increases_user_value() {
        let w = world("idle", false);
        let non_act = score(&sig("idle", 0.3, false), &bag(&[]), &w);
        let act = score(&sig("idle", 0.3, true), &bag(&[]), &w);
        assert!(act > non_act, "actionable should score higher: {act} vs {non_act}");
    }

    // 5. Build signal gets coding boost when activity == "coding".
    #[test]
    fn build_coding_boost() {
        let empty: Vec<BagEntry> = vec![];
        let coding = score(&sig("build", 0.5, true), &empty, &world("coding", false));
        let other = score(&sig("build", 0.5, true), &empty, &world("browsing", false));
        assert!(coding > other, "coding boost missing: {coding} vs {other}");
    }

    // 6. Idle world reduces urgency component.
    #[test]
    fn idle_reduces_urgency() {
        let empty: Vec<BagEntry> = vec![];
        let active = score(&sig("build", 0.8, true), &empty, &world("coding", false));
        let idle = score(&sig("build", 0.8, true), &empty, &world("coding", true));
        assert!(active > idle, "idle should reduce score: active={active} idle={idle}");
    }

    // 7. Dense nudge bag penalises score.
    #[test]
    fn high_nudge_density_reduces_score() {
        let sparse: Vec<BagEntry> = vec![];
        let dense = bag(&["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
        let s_sparse = score(&sig("build", 0.6, true), &sparse, &world("coding", false));
        let s_dense = score(&sig("build", 0.6, true), &dense, &world("coding", false));
        assert!(s_sparse > s_dense, "dense bag should reduce score: {s_sparse} vs {s_dense}");
    }

    // 8. Weights sum to 1.0.
    #[test]
    fn weights_sum_to_one() {
        let sum = W_NOVELTY + W_URGENCY + W_USER_VALUE + W_NUDGE_DENSITY;
        assert!(
            (sum - 1.0).abs() < 1e-6,
            "weights should sum to 1.0, got {sum}"
        );
    }

    // 9. Clipboard + coding context boost.
    #[test]
    fn clipboard_coding_boost() {
        let empty: Vec<BagEntry> = vec![];
        let coding = score(&sig("clipboard", 0.3, true), &empty, &world("coding", false));
        let idle = score(&sig("clipboard", 0.3, true), &empty, &world("idle", false));
        assert!(coding > idle, "clipboard coding boost missing: {coding} vs {idle}");
    }

    // 10. fs_burst + coding context boost.
    #[test]
    fn fs_burst_coding_boost() {
        let empty: Vec<BagEntry> = vec![];
        let coding = score(&sig("fs_burst", 0.4, true), &empty, &world("coding", false));
        let other = score(&sig("fs_burst", 0.4, true), &empty, &world("browsing", false));
        assert!(coding > other, "fs_burst coding boost missing: {coding} vs {other}");
    }

    // 11. compute_novelty is 1.0 for an unseen source.
    #[test]
    fn compute_novelty_full_for_new_source() {
        let n = super::compute_novelty(&sig("newthing", 0.5, true), &bag(&["other", "other"]));
        assert!((n - 1.0).abs() < 1e-6, "novelty should be 1.0 for new source, got {n}");
    }

    // 12. compute_nudge_density is 1.0 when bag exceeds DENSITY_PENALTY_AT.
    #[test]
    fn compute_nudge_density_saturates_at_one() {
        let b = bag(&["a", "b", "c", "d", "e", "f"]);
        let d = super::compute_nudge_density(&b);
        assert!((d - 1.0).abs() < 1e-6, "density should saturate at 1.0, got {d}");
    }
}
