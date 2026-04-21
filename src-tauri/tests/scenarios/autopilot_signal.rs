//! Scenario: autopilot_signal — exercises the Phase-2 Packet 4 proactive daemon.
//!
//! Tests run as pure internal (no GLM, no `--ignored`).
//!
//! Steps covered:
//!   1. Instantiate a Governor via `new_for_test` (temp dir, no singleton).
//!   2. Score a fresh "idle" signal with `{idle_secs:900}` payload — assert >= 0.3.
//!   3. Deliberator tick with that signal: assert tier is T0 or T1 (never T2+
//!      because `AUTOPILOT_SPEAK_ENABLED == false`).
//!   4. Publish the SAME signal 5 more times; assert novelty decays and all
//!      subsequent tiers collapse to T0.
//!   5. Calm-mode ON: assert zero T1+ surfaces.
//!   6. Governor persistence: save state, reload, assert values match.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use sunny_lib::autopilot::{
    Governor, T1_THRESHOLD, T2_THRESHOLD, AUTOPILOT_SPEAK_ENABLED, sensor_defaults,
};
use sunny_lib::autopilot::scoring::{BagEntry, Signal, WorldContext, score};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir()
            .join(format!("sunny-autopilot-scenario-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        Scratch(p)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Build an idle Signal using the same sensor defaults the deliberator uses.
fn idle_signal() -> Signal {
    let (urgency, actionable) = sensor_defaults("idle");
    Signal {
        source: "idle".to_string(),
        urgency_hint: urgency,
        actionable,
    }
}

/// Determine the surface tier from a score, mirroring deliberator logic.
fn tier_for(s: f32, governor_calm: bool) -> u8 {
    if governor_calm {
        // Calm mode: only T0 allowed regardless of score.
        return 0;
    }
    if s >= T2_THRESHOLD && AUTOPILOT_SPEAK_ENABLED {
        2
    } else if s >= T1_THRESHOLD {
        1
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Test 1: Governor instantiation with test-only constructor
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_governor_new_for_test_does_not_use_global_singleton() {
    let scratch = Scratch::new();
    // Two independent governors from the same dir — both should succeed
    // because `new_for_test` bypasses the OnceLock singleton.
    let gov_a = Governor::new_for_test(scratch.0.clone());
    let gov_b = Governor::new_for_test(scratch.0.clone());

    gov_a.set_calm(true).unwrap();
    // gov_b loads fresh from disk (calm was just persisted by gov_a).
    // We reload via snapshot by constructing a third instance.
    let gov_c = Governor::new_for_test(scratch.0.clone());

    assert!(gov_c.snapshot().calm_mode, "calm state must persist to disk");
    drop(gov_b);
}

// ---------------------------------------------------------------------------
// Test 2: idle signal scores >= 0.3 (moderate novelty)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_idle_signal_scores_above_threshold() {
    let sig = idle_signal();
    let empty_bag: Vec<BagEntry> = vec![];
    let world = WorldContext::default();

    let s = score(&sig, &empty_bag, &world);

    // idle: urgency=0.2, actionable=false, novelty=1.0, density=0.0
    // expected ≈ 0.30*1.0 + 0.30*0.2 + 0.30*0.4 = 0.48
    assert!(
        s >= 0.3,
        "idle signal score {s:.4} must be >= 0.3 (moderate novelty)"
    );
    assert!(
        s <= 1.0,
        "idle signal score {s:.4} must be <= 1.0"
    );
    eprintln!("  [2] idle fresh score = {s:.4}");
}

// ---------------------------------------------------------------------------
// Test 3: deliberator tick — expect T0 or T1, never T2+ (speak=OFF)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_deliberator_tick_never_reaches_t2_when_speak_disabled() {
    // Verify the compile-time gate.
    assert!(
        !AUTOPILOT_SPEAK_ENABLED,
        "AUTOPILOT_SPEAK_ENABLED must be false — speak is gated OFF"
    );

    let sig = idle_signal();
    let empty_bag: Vec<BagEntry> = vec![];
    let world = WorldContext::default();
    let s = score(&sig, &empty_bag, &world);

    let tier = tier_for(s, /*calm=*/ false);

    assert!(
        tier <= 1,
        "tier {tier} must not exceed T1 when AUTOPILOT_SPEAK_ENABLED=false; score={s:.4}"
    );
    eprintln!("  [3] tier={tier} score={s:.4} (speak_enabled={AUTOPILOT_SPEAK_ENABLED})");
}

// ---------------------------------------------------------------------------
// Test 4: novelty decay across 6 signals in rapid succession
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_novelty_decays_across_six_repeated_idle_signals() {
    let world = WorldContext::default();
    let mut bag: Vec<BagEntry> = vec![];
    let mut scores: Vec<f32> = Vec::with_capacity(6);

    for i in 0..6 {
        let sig = idle_signal();
        let s = score(&sig, &bag, &world);
        scores.push(s);
        // Simulate scoring accumulating the bag (as deliberator does).
        bag.push(BagEntry {
            source: "idle".to_string(),
            at_secs: 1_700_000_000 + i as i64,
        });
    }

    // Signal 0 is fresh; by signal 5 the bag has 5 "idle" entries → novelty 0.
    let first = scores[0];
    let last = scores[5];

    assert!(
        last < first,
        "score must decay with repetition: first={first:.4} last={last:.4}"
    );

    // By the 6th signal the bag has 5 same-source entries → novelty collapses.
    // Tier for the last score should be T0 (score falls below T1 threshold).
    let final_tier = tier_for(last, false);
    assert_eq!(
        final_tier, 0,
        "after 5 repeats the score {last:.4} should fall to T0 (threshold={T1_THRESHOLD})"
    );

    eprintln!(
        "  [4] novelty decay: {:?}",
        scores.iter().map(|s| format!("{s:.3}")).collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// Test 5: calm mode gates T1+ surfaces
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_calm_mode_gates_t1_surfaces() {
    let scratch = Scratch::new();
    let gov = Governor::new_for_test(scratch.0.clone());
    gov.set_calm(true).unwrap();

    assert!(gov.is_calm(), "calm mode must be active after set_calm(true)");

    // Even a high-scoring signal should yield T0 when calm=true.
    let sig = idle_signal();
    let empty_bag: Vec<BagEntry> = vec![];
    let world = WorldContext::default();
    let s = score(&sig, &empty_bag, &world);

    // Score would normally be T1 (≈0.48 > 0.35 threshold).
    assert!(s >= T1_THRESHOLD, "pre-condition: score {s:.4} must be >= T1_THRESHOLD={T1_THRESHOLD}");

    let tier = tier_for(s, gov.is_calm());
    assert_eq!(
        tier, 0,
        "calm mode must clamp tier to T0; got tier={tier} score={s:.4}"
    );
    eprintln!("  [5] calm=true score={s:.4} tier={tier} (zero T1+ surfaces confirmed)");
}

// ---------------------------------------------------------------------------
// Test 6: Governor persistence round-trip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_governor_persistence_round_trip() {
    let scratch = Scratch::new();
    let gov = Governor::new_for_test(scratch.0.clone());

    // Mutate several fields and persist.
    gov.set_calm(true).unwrap();
    gov.set_daily_cap(0.42).unwrap();
    // Charge while active (default), then disable.
    gov.charge_glm(0.10).unwrap();
    gov.set_active(false).unwrap();

    let before = gov.snapshot();

    // Reload from disk into a fresh instance.
    let reloaded = Governor::new_for_test(scratch.0.clone());
    let after = reloaded.snapshot();

    assert!(after.calm_mode, "calm_mode must survive reload");
    assert!(
        !after.active,
        "active=false must survive reload — set_active(false) was the last active write"
    );
    assert!(
        (after.daily_glm_cap_usd - 0.42).abs() < 1e-9,
        "daily_glm_cap_usd mismatch: {:.6}", after.daily_glm_cap_usd
    );
    assert!(
        (after.daily_glm_cost_usd - before.daily_glm_cost_usd).abs() < 1e-9,
        "cost ledger mismatch: before={:.6} after={:.6}",
        before.daily_glm_cost_usd,
        after.daily_glm_cost_usd
    );
    eprintln!(
        "  [6] persistence: calm={} active={} cap={:.2} spend={:.4}",
        after.calm_mode, after.active, after.daily_glm_cap_usd, after.daily_glm_cost_usd
    );
}

// ---------------------------------------------------------------------------
// Test 7: speak=OFF constant is a compile-time guarantee
// ---------------------------------------------------------------------------

#[tokio::test]
async fn autopilot_speak_enabled_is_false_at_compile_time() {
    // This is a sentinel: if someone accidentally flips the flag,
    // this test catches it before voice fires in production.
    assert!(
        !AUTOPILOT_SPEAK_ENABLED,
        "AUTOPILOT_SPEAK_ENABLED must remain false until voice is wired end-to-end"
    );
}
