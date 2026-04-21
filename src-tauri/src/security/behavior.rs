//! Per-tool rolling baseline + anomaly detection.
//!
//! Every [`crate::agent_loop::dispatch::dispatch_tool`] call flows
//! through `record_tool_call` here.  We keep, per tool name, a
//! rolling circular buffer of call timestamps (last `HISTORY` seconds)
//! and derive two metrics every time a new call lands:
//!
//! * **Rate** — calls per minute in the last 60 s.
//! * **Baseline** — simple moving average of calls per minute across
//!   the full 15-minute window.
//!
//! An event is anomalous when:
//!   - Current rate ≥ 5 × baseline AND current rate > 8 calls/min, OR
//!   - Burst: ≥ 10 calls in the last 10 s, OR
//!   - Z-score (rate / baseline SD) ≥ 3.0.
//!
//! Anomalies are rate-limited to one emit per tool per 30 s so a
//! run-away model can't spam the audit log.
//!
//! Adapted from Agent-Aegis' `AnomalyDetector` pattern + the
//! openclaw-agentic-security egress anomaly approach — we're solving
//! the same problem, just in-process.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::{SecurityEvent, Severity};

/// How far back the rolling history keeps samples (seconds).  15 min
/// is long enough to establish a stable baseline for tools called a
/// handful of times in a normal session.
const HISTORY_SECS: i64 = 900;

/// Minimum samples before anomaly logic engages.  Without this we'd
/// flag every single "first web_fetch call of the session" as a
/// spike from zero baseline.
const MIN_SAMPLES: usize = 5;

/// Rate-limit for anomaly emits per tool.
const EMIT_COOLDOWN_SECS: i64 = 30;

#[derive(Default)]
struct ToolWindow {
    /// Unix-second timestamps of each call, newest last.
    calls: VecDeque<i64>,
    last_anomaly_at: i64,
}

fn tools() -> &'static Mutex<HashMap<String, ToolWindow>> {
    static CELL: OnceLock<Mutex<HashMap<String, ToolWindow>>> = OnceLock::new();
    CELL.get_or_init(|| {
        let map = load_baseline().unwrap_or_default();
        Mutex::new(map)
    })
}

fn baseline_path() -> PathBuf {
    super::resolve_data_dir().join("behavior_baseline.json")
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedBaseline {
    per_tool: HashMap<String, PersistedToolWindow>,
    saved_at: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct PersistedToolWindow {
    /// Last HISTORY_SECS of call timestamps.  On load we drop
    /// anything older than the window so a week-old baseline
    /// doesn't poison the z-score immediately after a restart.
    calls: Vec<i64>,
}

fn load_baseline() -> Option<HashMap<String, ToolWindow>> {
    let body = fs::read_to_string(baseline_path()).ok()?;
    let parsed: PersistedBaseline = serde_json::from_str(&body).ok()?;
    let now = super::now();
    let mut out: HashMap<String, ToolWindow> = HashMap::new();
    for (tool, p) in parsed.per_tool {
        let mut window = ToolWindow::default();
        for t in p.calls {
            if now - t <= HISTORY_SECS {
                window.calls.push_back(t);
            }
        }
        if !window.calls.is_empty() {
            out.insert(tool, window);
        }
    }
    Some(out)
}

/// Persist the current per-tool windows to disk.  Called from a
/// background ticker in `start_persistence_loop`; safe to invoke
/// whenever.
pub fn persist_now() {
    let Ok(guard) = tools().lock() else { return };
    let snap: PersistedBaseline = PersistedBaseline {
        per_tool: guard
            .iter()
            .map(|(k, w)| {
                (k.clone(), PersistedToolWindow { calls: w.calls.iter().copied().collect() })
            })
            .collect(),
        saved_at: super::now(),
    };
    drop(guard);
    let path = baseline_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(body) = serde_json::to_string(&snap) {
        let _ = fs::write(&path, body);
    }
}

/// Kick a low-frequency persistence ticker (every 2 min) so a crash
/// or quit doesn't lose the last hour of baseline samples.
pub fn start_persistence_loop() {
    static ONCE: OnceLock<()> = OnceLock::new();
    if ONCE.set(()).is_err() { return; }
    tauri::async_runtime::spawn(async {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(120));
        ticker.tick().await; // first tick immediate, skip
        loop {
            ticker.tick().await;
            persist_now();
        }
    });
}

/// Record one tool-call and, if anomalous, emit a
/// `SecurityEvent::ToolRateAnomaly`.  Safe to call on every dispatch.
pub fn record_tool_call(tool_name: &str) {
    let now = super::now();
    let metrics_opt: Option<(f64, f64, f64, usize)> = {
        let mut guard = match tools().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let window = guard.entry(tool_name.to_string()).or_default();
        window.calls.push_back(now);
        // Drop anything older than HISTORY_SECS.
        while let Some(&front) = window.calls.front() {
            if now - front > HISTORY_SECS {
                window.calls.pop_front();
            } else {
                break;
            }
        }

        let total = window.calls.len();
        if total < MIN_SAMPLES {
            return;
        }
        if now - window.last_anomaly_at < EMIT_COOLDOWN_SECS {
            return;
        }

        let metrics = compute_metrics(&window.calls, now);
        // Copy out and drop the lock before emitting.
        Some((metrics.rate_per_min, metrics.baseline_per_min, metrics.z_score, total))
    };

    let Some((rate_per_min, baseline_per_min, z_score, _total)) = metrics_opt else {
        return;
    };

    let now_burst = burst_count(tool_name, now);

    let (is_anomaly, severity, label) = classify(rate_per_min, baseline_per_min, z_score, now_burst);
    if !is_anomaly {
        return;
    }

    // Mark the anomaly timestamp under the lock so future calls
    // within the cool-down window don't re-fire.
    if let Ok(mut guard) = tools().lock() {
        if let Some(w) = guard.get_mut(tool_name) {
            w.last_anomaly_at = now;
        }
    }

    log::info!(
        "security: tool-rate anomaly tool={tool_name} rate={rate_per_min:.1}/min base={baseline_per_min:.1}/min z={z_score:.1} burst={now_burst} reason={label}"
    );
    super::emit(SecurityEvent::ToolRateAnomaly {
        at: now,
        tool: tool_name.to_string(),
        rate_per_min,
        baseline_per_min,
        z_score,
        severity,
    });
}

struct Metrics {
    rate_per_min: f64,
    baseline_per_min: f64,
    z_score: f64,
}

fn compute_metrics(calls: &VecDeque<i64>, now: i64) -> Metrics {
    // Last-60-s rate (calls/min).
    let recent_count = calls.iter().rev().take_while(|t| now - **t <= 60).count();
    let rate_per_min = recent_count as f64;

    // Baseline = per-minute rate across the full window, counted in
    // 60-second bins.  Bins with zero calls still contribute to the
    // mean + variance so a burst after a long idle shows up as
    // anomalous even with modest absolute rate.
    let window = HISTORY_SECS.max(60);
    let bin_count = (window / 60) as usize;
    let mut bins = vec![0u32; bin_count];
    for t in calls.iter() {
        let age = now - *t;
        if age < 0 || age >= window {
            continue;
        }
        let idx = (age / 60) as usize;
        if idx < bin_count {
            bins[idx] += 1;
        }
    }
    let n = bins.len().max(1) as f64;
    let mean = bins.iter().map(|&v| v as f64).sum::<f64>() / n;
    let variance =
        bins.iter().map(|&v| (v as f64 - mean).powi(2)).sum::<f64>() / n;
    let sd = variance.sqrt();
    let z_score = if sd > 0.0 { (rate_per_min - mean) / sd } else { 0.0 };

    Metrics {
        rate_per_min,
        baseline_per_min: mean,
        z_score,
    }
}

fn burst_count(tool: &str, now: i64) -> usize {
    let Ok(guard) = tools().lock() else { return 0 };
    let Some(w) = guard.get(tool) else { return 0 };
    w.calls.iter().rev().take_while(|t| now - **t <= 10).count()
}

fn classify(
    rate: f64,
    baseline: f64,
    z_score: f64,
    burst: usize,
) -> (bool, Severity, &'static str) {
    // Order matters — highest-severity rule first.
    if burst >= 20 {
        return (true, Severity::Crit, "extreme_burst");
    }
    if rate >= 5.0 * baseline.max(1.0) && rate > 8.0 {
        return (true, Severity::Warn, "rate_over_5x_baseline");
    }
    if burst >= 10 {
        return (true, Severity::Warn, "burst_ten_in_ten");
    }
    if z_score >= 3.0 && rate > 3.0 {
        return (true, Severity::Warn, "z_score_over_3");
    }
    (false, Severity::Info, "none")
}

/// Public snapshot of per-tool rates.  Used by the Security page's
/// SYSTEM + Agent Audit tabs to render sparklines.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, ts_rs::TS)]
#[ts(export)]
pub struct ToolRateSnapshot {
    pub tool: String,
    #[ts(type = "number")]
    pub total_calls: usize,
    pub rate_per_min: f64,
    pub baseline_per_min: f64,
    pub z_score: f64,
}

pub fn snapshot() -> Vec<ToolRateSnapshot> {
    let Ok(guard) = tools().lock() else { return Vec::new() };
    let now = super::now();
    let mut out = Vec::with_capacity(guard.len());
    for (tool, w) in guard.iter() {
        if w.calls.is_empty() {
            continue;
        }
        let m = compute_metrics(&w.calls, now);
        out.push(ToolRateSnapshot {
            tool: tool.clone(),
            total_calls: w.calls.len(),
            rate_per_min: m.rate_per_min,
            baseline_per_min: m.baseline_per_min,
            z_score: m.z_score,
        });
    }
    // Hottest first.
    out.sort_by(|a, b| b.rate_per_min.partial_cmp(&a.rate_per_min).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_burst_crit() {
        let (hit, sev, _) = classify(30.0, 0.5, 4.0, 25);
        assert!(hit);
        assert_eq!(sev, Severity::Crit);
    }

    #[test]
    fn classify_over_5x_baseline() {
        let (hit, sev, reason) = classify(15.0, 2.0, 1.2, 3);
        assert!(hit);
        assert_eq!(sev, Severity::Warn);
        assert_eq!(reason, "rate_over_5x_baseline");
    }

    #[test]
    fn classify_quiet_run_not_anomalous() {
        let (hit, _, _) = classify(1.0, 0.8, 0.3, 1);
        assert!(!hit);
    }

    #[test]
    fn compute_metrics_flat_window() {
        // Two calls per minute for 15 minutes, in real chronological
        // order (oldest first, newest last) to match how
        // `record_tool_call` actually populates the deque.  Rate in
        // the last minute should be ≈2 with low z-score.
        let mut calls = VecDeque::new();
        let now = 1_700_000_000;
        for m in (0..15).rev() {
            for k in (0..2).rev() {
                // Bigger (m,k) = older, so we push in descending
                // distance from `now`.  k=1 at 40 s in, k=0 at 10 s in.
                calls.push_back(now - (m * 60 + 10 + k * 30));
            }
        }
        let m = compute_metrics(&calls, now);
        assert!((m.rate_per_min - 2.0).abs() < 0.001, "rate={}", m.rate_per_min);
        assert!(
            m.baseline_per_min > 1.8 && m.baseline_per_min < 2.2,
            "baseline={}",
            m.baseline_per_min,
        );
        assert!(m.z_score.abs() < 1.0);
    }
}
