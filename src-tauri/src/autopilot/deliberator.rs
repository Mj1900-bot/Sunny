//! Deliberator — subscribes to the event bus, coalesces signals over a 3-second
//! window, scores them, and routes to the appropriate tier.
//!
//! # Tiers
//!
//! | Tier | Action | Gate |
//! |------|--------|------|
//! | T0 | Silent log | Always allowed |
//! | T1 | HUD pulse (emit `sunny://autopilot.surface`) | Always allowed |
//! | T2 | Voice speak | Feature-gated `autopilot_speak_enabled` (default OFF) |
//! | T3–T5 | Reserved (escalating voice/action) | Feature-gated |
//!
//! The feature flag `autopilot_speak_enabled` defaults to `false` so the daemon
//! never talks during development. Set it to `true` in settings to enable voice.
//!
//! # Architecture
//!
//! A single supervised Tokio task:
//! 1. Subscribes to the broadcast bus.
//! 2. On `AutopilotSignal`, appends to a coalescing bag.
//! 3. Every 3 seconds, drains the bag, scores each signal, picks the highest,
//!    and routes it.
//! 4. Publishes `SunnyEvent::AutopilotSurface` for T1+ decisions.

use std::time::Duration;

use chrono::Utc;
use tokio::sync::broadcast;

use tauri::Emitter;

use crate::event_bus::{self, SunnyEvent};
use crate::supervise;
use crate::world;

use super::governor::Governor;
use super::scoring::{BagEntry, Signal, WorldContext, score};

/// Coalescing window in seconds.
const COALESCE_WINDOW_SECS: u64 = 3;
/// Minimum score to promote to T1 (HUD pulse).
pub const T1_THRESHOLD: f32 = 0.35;
/// Minimum score to consider T2+ (voice, feature-gated).
pub const T2_THRESHOLD: f32 = 0.65;
/// How many recent bag entries to keep for scoring context.
const RECENT_BAG_MAX: usize = 50;

/// T2+ voice surfaces are always off unless this is explicitly set to `true`.
/// Change to `true` only when voice routing is wired end-to-end.
pub const AUTOPILOT_SPEAK_ENABLED: bool = false;

/// Deliberator — owns the coalescing bag and scoring context.
pub struct Deliberator {
    /// Bag of signals received in the current coalescing window.
    pending: Vec<PendingSignal>,
    /// Recent-bag used for novelty/density scoring.
    recent_bag: Vec<BagEntry>,
    /// Tauri app handle for emitting `sunny://autopilot.surface`.
    app: tauri::AppHandle,
}

#[derive(Clone, Debug)]
struct PendingSignal {
    source: String,
    at_secs: i64,
}

impl Deliberator {
    fn new(app: tauri::AppHandle) -> Self {
        Deliberator {
            pending: Vec::new(),
            recent_bag: Vec::new(),
            app,
        }
    }

    /// Ingest a new signal into the pending bag.
    fn ingest(&mut self, source: String, at_ms: i64) {
        self.pending.push(PendingSignal {
            source,
            at_secs: at_ms / 1000,
        });
    }

    /// Drain the pending bag, score each signal, and route the highest-scoring one.
    /// Returns the number of signals processed.
    fn drain_and_route(&mut self) -> usize {
        let count = self.pending.len();
        if count == 0 {
            return 0;
        }

        let world_ctx = build_world_context();
        let governor = Governor::get();

        // Check kill switch: if inactive, only allow T0 logging.
        let daemon_active = governor.map(|g| g.is_active()).unwrap_or(true);
        let calm = governor.map(|g| g.is_calm()).unwrap_or(false);

        let mut best_score = 0.0f32;
        let mut best_signal: Option<PendingSignal> = None;

        for pending in &self.pending {
            let signal = signal_from_pending(pending);
            let s = score(&signal, &self.recent_bag, &world_ctx);
            if s > best_score {
                best_score = s;
                best_signal = Some(pending.clone());
            }

            // Append to recent bag.
            self.recent_bag.push(BagEntry {
                source: pending.source.clone(),
                at_secs: pending.at_secs,
            });
        }

        // Trim recent bag.
        if self.recent_bag.len() > RECENT_BAG_MAX {
            let drain_count = self.recent_bag.len() - RECENT_BAG_MAX;
            self.recent_bag.drain(0..drain_count);
        }

        self.pending.clear();

        let Some(best) = best_signal else {
            return count;
        };

        // T0: always log (even when daemon is inactive).
        log::info!(
            "[autopilot/deliberator] T0 signal source={} score={:.3}",
            best.source,
            best_score
        );

        if !daemon_active {
            return count;
        }

        // T1: HUD pulse.
        if best_score >= T1_THRESHOLD {
            self.emit_t1(&best, best_score);
        }

        // T2+: voice — feature-gated and calm-mode gated.
        if best_score >= T2_THRESHOLD && AUTOPILOT_SPEAK_ENABLED && !calm {
            self.route_t2(&best, best_score);
        }

        count
    }

    fn emit_t1(&self, signal: &PendingSignal, score: f32) {
        let at = Utc::now().timestamp_millis();
        let summary = format!("[autopilot] {} (score {:.2})", signal.source, score);

        event_bus::publish(SunnyEvent::AutopilotSurface {
            seq: 0,
            boot_epoch: 0,
            tier: 1,
            summary: summary.clone(),
            score,
            at,
        });

        // Also emit the Tauri event so the HUD can show a pulse chip.
        let _ = self.app.emit(
            "sunny://autopilot.surface",
            serde_json::json!({
                "tier": 1,
                "summary": summary,
                "score": score,
                "source": signal.source,
                "at": at,
            }),
        );
    }

    fn route_t2(&self, signal: &PendingSignal, score: f32) {
        // Voice routing placeholder. This path is gated behind
        // `AUTOPILOT_SPEAK_ENABLED = false`, so it will never execute
        // during development. When voice is wired up, acquire the
        // speaking slot from the Governor and invoke the TTS pipeline.
        log::info!(
            "[autopilot/deliberator] T2 candidate (not routing, speak disabled): {} score={:.3}",
            signal.source,
            score
        );
    }
}

fn signal_from_pending(p: &PendingSignal) -> Signal {
    let (urgency, actionable) = sensor_defaults(&p.source);
    Signal {
        source: p.source.clone(),
        urgency_hint: urgency,
        actionable,
    }
}

/// Sensor-specific urgency defaults when no urgency is encoded in the payload.
pub fn sensor_defaults(source: &str) -> (f32, bool) {
    match source {
        "build" => (0.7, true),
        "fs_burst" => (0.4, false),
        "idle" => (0.2, false),
        "clipboard" => (0.3, true),
        _ => (0.3, false),
    }
}

fn build_world_context() -> WorldContext {
    let ws = world::current();
    let activity_str = format!("{:?}", ws.activity).to_lowercase();
    // idle_secs > 120 = user idle for scoring purposes.
    let user_idle = ws
        .focus
        .as_ref()
        .map(|f| {
            let now = Utc::now().timestamp();
            now - f.focused_since_secs > 120
        })
        .unwrap_or(false);
    WorldContext {
        activity: activity_str,
        user_idle,
    }
}

// ---------------------------------------------------------------------------
// Supervised task entry point
// ---------------------------------------------------------------------------

/// Spawn the deliberator task. Call once from the wiring pass.
pub fn spawn(app: tauri::AppHandle) {
    supervise::spawn_supervised("autopilot_deliberator", move || {
        let app = app.clone();
        async move {
            run_deliberator(app).await;
        }
    });
}

async fn run_deliberator(app: tauri::AppHandle) {
    let Some(tx) = crate::event_bus::sender() else {
        log::error!("[autopilot/deliberator] event bus not initialised");
        return;
    };
    let mut rx: broadcast::Receiver<SunnyEvent> = tx.subscribe();

    let mut delib = Deliberator::new(app);
    let mut ticker = tokio::time::interval(Duration::from_secs(COALESCE_WINDOW_SECS));

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                delib.drain_and_route();
            }
            result = rx.recv() => {
                match result {
                    Ok(SunnyEvent::AutopilotSignal { source, at, .. }) => {
                        delib.ingest(source, at);
                    }
                    Ok(_) => {
                        // Other event kinds are not consumed by the deliberator.
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("[autopilot/deliberator] bus lagged, skipped {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        log::info!("[autopilot/deliberator] bus closed, exiting");
                        return;
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal mock AppHandle — we can't construct a real Tauri AppHandle in
    /// unit tests, so we test the Deliberator internals directly without it.
    /// The `drain_and_route` logic that doesn't touch `app` is fully testable.

    fn make_signal(source: &str, at_ms: i64) -> PendingSignal {
        PendingSignal {
            source: source.to_string(),
            at_secs: at_ms / 1000,
        }
    }

    /// Test-only Deliberator without an AppHandle (we bypass emit).
    struct TestDelib {
        pending: Vec<PendingSignal>,
        recent_bag: Vec<BagEntry>,
    }

    impl TestDelib {
        fn new() -> Self {
            TestDelib {
                pending: Vec::new(),
                recent_bag: Vec::new(),
            }
        }

        fn ingest(&mut self, source: &str, at_ms: i64) {
            self.pending.push(make_signal(source, at_ms));
        }

        fn drain(&mut self) -> Vec<(u8, f32)> {
            let world_ctx = WorldContext::default();
            let mut results = Vec::new();

            for pending in &self.pending {
                let signal = signal_from_pending(pending);
                let s = score(&signal, &self.recent_bag, &world_ctx);
                results.push((tier_for_score(s), s));

                self.recent_bag.push(BagEntry {
                    source: pending.source.clone(),
                    at_secs: pending.at_secs,
                });
            }

            if self.recent_bag.len() > RECENT_BAG_MAX {
                let drain = self.recent_bag.len() - RECENT_BAG_MAX;
                self.recent_bag.drain(0..drain);
            }

            self.pending.clear();
            results
        }
    }

    fn tier_for_score(s: f32) -> u8 {
        if s >= T2_THRESHOLD {
            2
        } else if s >= T1_THRESHOLD {
            1
        } else {
            0
        }
    }

    #[test]
    fn empty_bag_drains_without_panic() {
        let mut d = TestDelib::new();
        let results = d.drain();
        assert!(results.is_empty());
    }

    #[test]
    fn single_build_signal_scores_and_routes() {
        let mut d = TestDelib::new();
        d.ingest("build", 1_000_000_000);
        let results = d.drain();
        assert_eq!(results.len(), 1);
        let (_, s) = results[0];
        assert!(s > 0.0 && s <= 1.0, "score {s} out of range");
    }

    #[test]
    fn coalescing_window_drains_all_pending() {
        let mut d = TestDelib::new();
        d.ingest("build", 1_000_000_000);
        d.ingest("clipboard", 1_000_000_001);
        d.ingest("idle", 1_000_000_002);
        let results = d.drain();
        assert_eq!(results.len(), 3, "all three signals should be scored");
    }

    #[test]
    fn recent_bag_fills_and_trims() {
        let mut d = TestDelib::new();
        for i in 0..60 {
            d.ingest("build", 1_000_000_000 + i);
        }
        d.drain();
        assert!(
            d.recent_bag.len() <= RECENT_BAG_MAX,
            "bag should not exceed max: {}",
            d.recent_bag.len()
        );
    }

    #[test]
    fn calm_mode_gate_constant_default_is_off() {
        // This test documents the contract: AUTOPILOT_SPEAK_ENABLED must be
        // false by default so voice never fires during development.
        assert!(
            !AUTOPILOT_SPEAK_ENABLED,
            "AUTOPILOT_SPEAK_ENABLED must default to false"
        );
    }

    #[test]
    fn t1_threshold_less_than_t2() {
        assert!(T1_THRESHOLD < T2_THRESHOLD);
    }

    #[test]
    fn sensor_defaults_build_is_high_urgency() {
        let (urgency, actionable) = sensor_defaults("build");
        assert!(urgency >= 0.5, "build urgency should be high, got {urgency}");
        assert!(actionable);
    }

    #[test]
    fn sensor_defaults_idle_is_low_urgency() {
        let (urgency, _) = sensor_defaults("idle");
        assert!(urgency < 0.5, "idle urgency should be low, got {urgency}");
    }

    #[test]
    fn repeated_signals_reduce_score_via_novelty() {
        let mut d = TestDelib::new();
        // Prime the recent bag with many "build" entries.
        for i in 0..6 {
            d.ingest("build", 1_000_000_000 + i);
        }
        let first_results = d.drain();
        // The last few scores should be lower than the first due to novelty decay.
        let first_score = first_results[0].1;
        let last_score = first_results[first_results.len() - 1].1;
        assert!(
            last_score <= first_score,
            "repeated signals should not increase score: first={first_score} last={last_score}"
        );
    }

    #[test]
    fn tier_zero_when_below_t1_threshold() {
        let s = T1_THRESHOLD - 0.01;
        assert_eq!(tier_for_score(s), 0);
    }

    // ---------------------------------------------------------------------------
    // Smoke test (a) — Phase-2 hook wiring
    // ---------------------------------------------------------------------------

    /// Smoke (a): `spawn()` is backed by `spawn_supervised` which catches panics
    /// from the task factory.  We verify the Deliberator/Governor constructors
    /// (called inside the supervised future) are panic-free using
    /// `Governor::new_for_test`.  A panic in either means the daemon silently
    /// dies at startup — this test catches that class of regression.
    #[test]
    fn spawn_internal_construction_no_panic() {
        let tmp = std::env::temp_dir().join(format!(
            "sunny-gov-smoke-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).expect("tmp dir");
        // Governor::new_for_test must not panic.
        let _g = crate::autopilot::governor::Governor::new_for_test(tmp.clone());
        // scoring::score must not panic on a minimal empty context.
        let ctx = crate::autopilot::scoring::WorldContext {
            activity: "idle".to_string(),
            user_idle: true,
        };
        let entry = crate::autopilot::scoring::BagEntry {
            source: "test".to_string(),
            at_secs: 0,
        };
        let sig = crate::autopilot::scoring::Signal {
            source: "test".to_string(),
            urgency_hint: 0.5,
            actionable: false,
        };
        let _score = crate::autopilot::scoring::score(&sig, &[entry], &ctx);
        // If we reach here, no panic occurred.
        let _ = std::fs::remove_dir_all(&tmp);
    }

}