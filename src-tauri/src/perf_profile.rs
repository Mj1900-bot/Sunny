//! Latency profiler for the Sunny agent loop.
//!
//! A **pure observer**: subscribes to the existing [`SunnyEvent`] broadcast
//! bus and the [`crate::telemetry`] ring.  Never mutates any core state.
//!
//! ## How latency is derived from the event bus
//!
//! | Logical signal | Derived from                                   |
//! |----------------|------------------------------------------------|
//! | Turn start     | `AgentStep{iteration:0}` for a turn_id         |
//! | First token    | First `ChatChunk{delta: non-empty}` per turn   |
//! | Turn end       | `ChatChunk{done:true}` or `StreamEnd`          |
//! | Model name     | Most-recent `TelemetryEvent` at turn-end time  |
//!
//! Model attribution: the telemetry ring is read at turn-end using
//! [`crate::telemetry::telemetry_llm_recent_impl`].  We pick the record
//! whose `at` timestamp lies closest to the turn's start epoch and within a
//! 5-second window.  When no matching record exists the turn is attributed to
//! `"unknown"`.
//!
//! ## Percentile algorithm
//!
//! Per-model rolling windows of the last 100 samples.  Percentiles are
//! computed via the standard library's `slice::select_nth_unstable_by`
//! (introselect / quickselect, O(n) expected).  No extra crate is added:
//! `hdrhistogram` was considered but rejected because its sub-millisecond
//! accuracy is unnecessary for turn-level latencies (50 ms–30 s) and it
//! would add ~350 KB to the binary.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::event_bus::{SunnyEvent, sender};
use crate::telemetry::{telemetry_llm_recent_impl, TelemetryEvent};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum per-model sample window.
const WINDOW: usize = 100;

/// Maximum age (seconds) for a telemetry record to be eligible for model
/// attribution.
const MODEL_MATCH_WINDOW_SECS: i64 = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Immutable per-model latency snapshot.  All durations are in milliseconds.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LatencyProfile {
    /// Model slug, e.g. `"claude-sonnet-4-6"`, `"llama3"`, `"glm-4"`.
    pub model_id: String,
    /// Median time-to-first-token (ms).
    pub ttft_p50: f64,
    /// 95th-percentile time-to-first-token (ms).
    pub ttft_p95: f64,
    /// Median total turn latency (ms).
    pub total_p50: f64,
    /// 95th-percentile total turn latency (ms).
    pub total_p95: f64,
    /// Number of completed turns observed so far.
    pub turns_observed: usize,
}

impl LatencyProfile {
    /// Render as a single human-readable line suitable for CLI or HUD display.
    pub fn summary_line(&self) -> String {
        format!(
            "{model:<30}  turns={n:>4}  \
             ttft p50={tp50:>7.0}ms p95={tp95:>7.0}ms  \
             total p50={lp50:>7.0}ms p95={lp95:>7.0}ms",
            model = self.model_id,
            n     = self.turns_observed,
            tp50  = self.ttft_p50,
            tp95  = self.ttft_p95,
            lp50  = self.total_p50,
            lp95  = self.total_p95,
        )
    }
}

// ---------------------------------------------------------------------------
// Internal rolling window
// ---------------------------------------------------------------------------

/// Per-model rolling window of raw latency samples (ms).
#[derive(Debug, Default)]
struct ModelWindow {
    ttft:  Vec<f64>,
    total: Vec<f64>,
}

impl ModelWindow {
    fn push_ttft(&mut self, ms: f64) {
        if self.ttft.len() >= WINDOW {
            self.ttft.remove(0);
        }
        self.ttft.push(ms);
    }

    fn push_total(&mut self, ms: f64) {
        if self.total.len() >= WINDOW {
            self.total.remove(0);
        }
        self.total.push(ms);
    }

    /// Compute the `p`th percentile (0–100) of `samples` using quickselect.
    /// Returns `0.0` when the slice is empty.
    fn percentile(samples: &[f64], p: f64) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let mut v: Vec<f64> = samples.to_vec();
        let idx = ((p / 100.0) * (v.len() - 1) as f64).round() as usize;
        let clamped = idx.min(v.len() - 1);
        *v.select_nth_unstable_by(clamped, |a, b| {
            a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
        })
        .1
    }

    fn p50_ttft(&self)  -> f64 { Self::percentile(&self.ttft,  50.0) }
    fn p95_ttft(&self)  -> f64 { Self::percentile(&self.ttft,  95.0) }
    fn p50_total(&self) -> f64 { Self::percentile(&self.total, 50.0) }
    fn p95_total(&self) -> f64 { Self::percentile(&self.total, 95.0) }

    fn profile(&self, model_id: String) -> LatencyProfile {
        LatencyProfile {
            model_id,
            ttft_p50:       self.p50_ttft(),
            ttft_p95:       self.p95_ttft(),
            total_p50:      self.p50_total(),
            total_p95:      self.p95_total(),
            turns_observed: self.total.len(),
        }
    }
}

// ---------------------------------------------------------------------------
// In-flight turn tracking
// ---------------------------------------------------------------------------

/// State for a single in-progress turn.
#[derive(Debug)]
struct InFlight {
    started_at:       Instant,
    first_token_at:   Option<Instant>,
    /// UNIX epoch seconds of the turn-start event (for telemetry matching).
    started_epoch_s:  i64,
}

// ---------------------------------------------------------------------------
// Shared profiler state
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct ProfilerState {
    in_flight: HashMap<String, InFlight>,
    windows:   HashMap<String, ModelWindow>,
}

impl ProfilerState {
    fn on_turn_start(&mut self, turn_id: &str, now: Instant, epoch_ms: i64) {
        self.in_flight.entry(turn_id.to_string()).or_insert_with(|| InFlight {
            started_at:      now,
            first_token_at:  None,
            started_epoch_s: epoch_ms / 1_000,
        });
    }

    fn on_first_token(&mut self, turn_id: &str, now: Instant) {
        if let Some(inf) = self.in_flight.get_mut(turn_id) {
            if inf.first_token_at.is_none() {
                inf.first_token_at = Some(now);
            }
        }
    }

    /// Finalise a turn, recording latency samples under the attributed model.
    fn on_turn_end(
        &mut self,
        turn_id: &str,
        now: Instant,
        recent_telemetry: &[TelemetryEvent],
    ) {
        let Some(inf) = self.in_flight.remove(turn_id) else { return };

        let total_ms = now
            .duration_since(inf.started_at)
            .as_secs_f64()
            * 1_000.0;

        let ttft_ms = inf
            .first_token_at
            .map(|t| t.duration_since(inf.started_at).as_secs_f64() * 1_000.0)
            .unwrap_or(total_ms);

        let model = best_model_match(recent_telemetry, inf.started_epoch_s)
            .unwrap_or_else(|| "unknown".to_string());

        let win = self.windows.entry(model).or_default();
        win.push_ttft(ttft_ms);
        win.push_total(total_ms);
    }

    fn snapshot(&self) -> HashMap<String, LatencyProfile> {
        self.windows
            .iter()
            .map(|(k, w)| (k.clone(), w.profile(k.clone())))
            .collect()
    }
}

/// Select the telemetry record whose `at` (epoch seconds) is closest to
/// `started_epoch_s` and lies within [`MODEL_MATCH_WINDOW_SECS`].
fn best_model_match(records: &[TelemetryEvent], started_epoch_s: i64) -> Option<String> {
    records
        .iter()
        .filter(|r| (r.at - started_epoch_s).abs() <= MODEL_MATCH_WINDOW_SECS)
        .min_by_key(|r| (r.at - started_epoch_s).abs())
        .map(|r| r.model.clone())
}

// ---------------------------------------------------------------------------
// PerfProfiler — public handle
// ---------------------------------------------------------------------------

/// Thread-safe latency profiler for Sunny's agent loop.
///
/// Construct once (after the event bus is initialised) with [`PerfProfiler::new`].
/// Share it freely — `Clone` is cheap (it only clones the `Arc`).
#[derive(Clone, Debug)]
pub struct PerfProfiler {
    state: Arc<Mutex<ProfilerState>>,
}

impl PerfProfiler {
    /// Create a new profiler and spawn a background subscriber on the Tokio
    /// runtime.  The subscriber feeds all future `SunnyEvent`s into this
    /// profiler's state.
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(ProfilerState::default()));
        let state2 = Arc::clone(&state);
        tauri::async_runtime::spawn(subscriber_loop(state2));
        Self { state }
    }

    /// Return a point-in-time snapshot of per-model latency statistics.
    /// Keyed by model slug.
    pub fn snapshot(&self) -> HashMap<String, LatencyProfile> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .snapshot()
    }

    /// Render the snapshot as human-readable lines, one per model, sorted
    /// alphabetically by model id.  Suitable for `perf-profile` CLI output.
    pub fn to_summary_lines(&self) -> Vec<String> {
        let mut profiles: Vec<LatencyProfile> = self.snapshot().into_values().collect();
        profiles.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        profiles.iter().map(LatencyProfile::summary_line).collect()
    }

    /// Directly inject a latency sample.  Used by tests and the CLI harness.
    /// Only compiled in `#[cfg(test)]` builds.
    #[cfg(test)]
    pub fn inject(&self, model_id: &str, ttft_ms: f64, total_ms: f64) {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let win = st.windows.entry(model_id.to_string()).or_default();
        win.push_ttft(ttft_ms);
        win.push_total(total_ms);
    }
}

impl Default for PerfProfiler {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Background event subscriber
// ---------------------------------------------------------------------------

async fn subscriber_loop(state: Arc<Mutex<ProfilerState>>) {
    // Poll until the bus sender is up.  In normal operation the sender is
    // initialised before any agent turn fires, so this loop runs at most once.
    let mut rx = loop {
        if let Some(tx) = sender() {
            break tx.subscribe();
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    };

    loop {
        match rx.recv().await {
            Ok(event) => handle_event(&state, &event),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                // Missed some events; keep running.
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
}

fn handle_event(state: &Mutex<ProfilerState>, event: &SunnyEvent) {
    let now = Instant::now();
    let mut st = state.lock().unwrap_or_else(|p| p.into_inner());

    match event {
        // AgentStep{iteration:0} is the canonical turn-start signal from
        // the full agent loop path.
        SunnyEvent::AgentStep { turn_id, iteration, at, .. } if *iteration == 0 => {
            st.on_turn_start(turn_id, now, *at);
        }

        SunnyEvent::ChatChunk { turn_id, delta, done, at, .. } => {
            // Seed the in-flight record if this turn arrived without a prior
            // AgentStep (e.g. the lightweight `ai::llm_oneshot` path).
            st.in_flight.entry(turn_id.clone()).or_insert_with(|| InFlight {
                started_at:      now,
                first_token_at:  None,
                started_epoch_s: at / 1_000,
            });

            if !delta.is_empty() {
                st.on_first_token(turn_id, now);
            }

            if *done {
                let telemetry = telemetry_llm_recent_impl(20);
                st.on_turn_end(turn_id, now, &telemetry);
            }
        }

        SunnyEvent::StreamEnd { turn_id, at, .. } => {
            // Ensure the turn is tracked even when no prior events arrived.
            st.in_flight.entry(turn_id.clone()).or_insert_with(|| InFlight {
                started_at:      now,
                first_token_at:  None,
                started_epoch_s: at / 1_000,
            });
            let telemetry = telemetry_llm_recent_impl(20);
            st.on_turn_end(turn_id, now, &telemetry);
        }

        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Tauri command + module-level singleton
// ---------------------------------------------------------------------------

/// Return the current latency snapshot as a JSON array of [`LatencyProfile`]
/// records sorted by model id.  Called by the Cost Dashboard UI (P10).
#[tauri::command]
pub fn perf_profile_snapshot() -> Result<String, String> {
    let mut profiles: Vec<LatencyProfile> =
        global_profiler().snapshot().into_values().collect();
    profiles.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    serde_json::to_string(&profiles).map_err(|e| format!("serialize: {e}"))
}

/// Module-level singleton so the Tauri command can access the profiler
/// without threading a new handle through `AppState`.
fn global_profiler() -> &'static PerfProfiler {
    static PROFILER: std::sync::OnceLock<PerfProfiler> = std::sync::OnceLock::new();
    PROFILER.get_or_init(PerfProfiler::new)
}

/// Initialise the global profiler.  Call once from `startup.rs` after
/// `event_bus::init`.  Safe to call multiple times — only the first call
/// has any effect.
pub fn init() {
    let _ = global_profiler();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn make_profiler() -> PerfProfiler {
        PerfProfiler {
            state: Arc::new(Mutex::new(ProfilerState::default())),
        }
    }

    fn seed_window(p: &PerfProfiler, model: &str, ttft: &[f64], total: &[f64]) {
        let mut st = p.state.lock().unwrap();
        let win = st.windows.entry(model.to_string()).or_default();
        for &v in ttft  { win.push_ttft(v);  }
        for &v in total { win.push_total(v); }
    }

    fn make_telemetry(model: &str, at: i64) -> TelemetryEvent {
        TelemetryEvent {
            provider:    "test".into(),
            model:       model.into(),
            input:       0,
            cache_read:  0,
            cache_create: 0,
            output:      0,
            duration_ms: 100,
            at,
            cost_usd:    0.0,
            tier:        None,
        }
    }

    // -----------------------------------------------------------------------
    // 1. p50 of [1..=100] falls in the expected range
    // -----------------------------------------------------------------------

    #[test]
    fn percentile_p50_known_100_values() {
        let samples: Vec<f64> = (1..=100).map(|x| x as f64).collect();
        let p = ModelWindow::percentile(&samples, 50.0);
        // idx = round(0.5 * 99) = round(49.5). Rust rounds 49.5 → 50 (round half up).
        // Element at index 50 in sorted [1..=100] is 51.
        assert!(
            (50.0..=52.0).contains(&p),
            "p50 of [1..100] expected ~51, got {p}"
        );
    }

    // -----------------------------------------------------------------------
    // 2. p95 of [1..=100] falls in the expected range
    // -----------------------------------------------------------------------

    #[test]
    fn percentile_p95_known_100_values() {
        let samples: Vec<f64> = (1..=100).map(|x| x as f64).collect();
        let p = ModelWindow::percentile(&samples, 95.0);
        // idx = round(0.95 * 99) = round(94.05) = 94 → element 95 (1-indexed).
        assert!(
            (94.0..=96.0).contains(&p),
            "p95 of [1..100] expected ~95, got {p}"
        );
    }

    // -----------------------------------------------------------------------
    // 3. Edge: single-element slice
    // -----------------------------------------------------------------------

    #[test]
    fn percentile_single_element() {
        assert_eq!(ModelWindow::percentile(&[42.0], 50.0), 42.0);
        assert_eq!(ModelWindow::percentile(&[42.0], 95.0), 42.0);
    }

    // -----------------------------------------------------------------------
    // 4. Edge: two-element slice
    // -----------------------------------------------------------------------

    #[test]
    fn percentile_two_elements() {
        let samples = [10.0f64, 20.0];
        let p95 = ModelWindow::percentile(&samples, 95.0);
        assert_eq!(p95, 20.0, "p95 of [10,20] should be 20, got {p95}");
    }

    // -----------------------------------------------------------------------
    // 5. Edge: empty slice returns 0.0
    // -----------------------------------------------------------------------

    #[test]
    fn percentile_empty_returns_zero() {
        assert_eq!(ModelWindow::percentile(&[], 50.0), 0.0);
        assert_eq!(ModelWindow::percentile(&[], 95.0), 0.0);
    }

    // -----------------------------------------------------------------------
    // 6. Rolling window evicts oldest after 100 entries
    // -----------------------------------------------------------------------

    #[test]
    fn rolling_window_evicts_after_100() {
        let mut w = ModelWindow::default();
        for i in 0..120u64 {
            w.push_ttft(i as f64);
            w.push_total(i as f64);
        }
        assert_eq!(w.ttft.len(),  WINDOW);
        assert_eq!(w.total.len(), WINDOW);
        let min_ttft = w.ttft.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(min_ttft >= 20.0, "oldest values must be evicted; min={min_ttft}");
    }

    // -----------------------------------------------------------------------
    // 7. Rolling window retains latest value
    // -----------------------------------------------------------------------

    #[test]
    fn rolling_window_retains_latest() {
        let mut w = ModelWindow::default();
        for i in 0..110u64 { w.push_total(i as f64); }
        assert!(w.total.contains(&109.0), "latest sample must be retained");
        assert!(!w.total.contains(&9.0),  "sample 9 should be evicted");
    }

    // -----------------------------------------------------------------------
    // 8. Multi-model profiles are independent
    // -----------------------------------------------------------------------

    #[test]
    fn multi_model_profiles_are_independent() {
        let p = make_profiler();
        seed_window(&p, "ollama/llama3", &[100.0, 200.0, 300.0], &[200.0, 400.0, 600.0]);
        seed_window(&p, "glm-4",         &[10.0, 20.0, 30.0],    &[20.0, 40.0, 60.0]);

        let snap = p.snapshot();
        let ollama = snap.get("ollama/llama3").expect("ollama missing");
        let glm    = snap.get("glm-4").expect("glm missing");

        assert!(ollama.ttft_p50 > glm.ttft_p50, "ollama p50 should exceed glm p50");
        assert_eq!(ollama.turns_observed, 3);
        assert_eq!(glm.turns_observed,    3);
    }

    // -----------------------------------------------------------------------
    // 9. Empty snapshot
    // -----------------------------------------------------------------------

    #[test]
    fn empty_snapshot_returns_empty_map() {
        assert!(make_profiler().snapshot().is_empty());
    }

    // -----------------------------------------------------------------------
    // 10. summary_line contains key fields
    // -----------------------------------------------------------------------

    #[test]
    fn summary_line_contains_model_and_counts() {
        let profile = LatencyProfile {
            model_id:       "claude-sonnet-4-6".into(),
            ttft_p50:       123.4,
            ttft_p95:       456.7,
            total_p50:      789.0,
            total_p95:      1234.5,
            turns_observed: 42,
        };
        let line = profile.summary_line();
        assert!(line.contains("claude-sonnet-4-6"), "model id missing");
        assert!(line.contains("42"),                "turn count missing");
        assert!(line.contains("123"),               "ttft p50 missing");
    }

    // -----------------------------------------------------------------------
    // 11. Concurrent pushes do not corrupt windows
    // -----------------------------------------------------------------------

    #[test]
    fn concurrent_pushes_no_corruption() {
        use std::thread;

        let state = Arc::new(Mutex::new(ProfilerState::default()));
        let handles: Vec<_> = (0..8)
            .map(|tid| {
                let st = Arc::clone(&state);
                thread::spawn(move || {
                    for i in 0..50u64 {
                        let mut guard = st.lock().unwrap();
                        let win = guard
                            .windows
                            .entry(format!("model-{}", tid % 2))
                            .or_default();
                        win.push_ttft(i as f64);
                        win.push_total((i * 2) as f64);
                    }
                })
            })
            .collect();

        for h in handles { h.join().expect("thread panicked"); }

        let guard = state.lock().unwrap();
        for win in guard.windows.values() {
            assert!(win.ttft.len()  <= WINDOW);
            assert!(win.total.len() <= WINDOW);
        }
    }

    // -----------------------------------------------------------------------
    // 12. profile() struct fields are correct
    // -----------------------------------------------------------------------

    #[test]
    fn window_profile_struct_fields() {
        let mut w = ModelWindow::default();
        for v in [50.0f64, 100.0, 150.0, 200.0, 250.0] {
            w.push_ttft(v);
            w.push_total(v + 500.0);
        }
        let p = w.profile("mymodel".into());
        assert_eq!(p.model_id,       "mymodel");
        assert_eq!(p.turns_observed, 5);
        assert!(p.ttft_p50  > 0.0);
        assert!(p.total_p50 > 500.0);
        assert!(p.ttft_p95  >= p.ttft_p50);
        assert!(p.total_p95 >= p.total_p50);
    }

    // -----------------------------------------------------------------------
    // 13. best_model_match selects nearest record
    // -----------------------------------------------------------------------

    #[test]
    fn best_model_match_selects_nearest() {
        let now_s = chrono::Utc::now().timestamp();
        let records = vec![
            make_telemetry("llama3",  now_s - 4),
            make_telemetry("glm-4",   now_s - 1),
        ];
        let result = best_model_match(&records, now_s - 1);
        assert_eq!(result.as_deref(), Some("glm-4"));
    }

    // -----------------------------------------------------------------------
    // 14. best_model_match rejects records outside window
    // -----------------------------------------------------------------------

    #[test]
    fn best_model_match_rejects_stale_records() {
        let now_s = chrono::Utc::now().timestamp();
        let records = vec![make_telemetry("claude-sonnet-4-6", now_s - 120)];
        let result = best_model_match(&records, now_s);
        assert!(result.is_none(), "stale record should not match");
    }

    // -----------------------------------------------------------------------
    // 15. to_summary_lines returns sorted, non-empty output
    // -----------------------------------------------------------------------

    #[test]
    fn summary_lines_sorted_alphabetically() {
        let p = make_profiler();
        seed_window(&p, "z-model", &[300.0], &[900.0]);
        seed_window(&p, "a-model", &[100.0], &[300.0]);
        seed_window(&p, "m-model", &[200.0], &[600.0]);

        let lines = p.to_summary_lines();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("a-model"), "first line should be a-model");
        assert!(lines[2].contains("z-model"), "last line should be z-model");
    }
}
