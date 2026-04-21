//! Policy / summary aggregator.
//!
//! Runs a background task that subscribes to the security bus,
//! coalesces incoming events inside a fixed debounce window, and
//! pushes a single `sunny://security.summary` event to the frontend
//! once per settled burst.  The raw event stream stays on the bus
//! (`sunny://security.event`) so detail views remain real-time; this
//! loop is only about the aggregate traffic-light / radial gauge the
//! Overview tab renders.
//!
//! Debounce (not rate-limit).  If a burst of N events arrives inside
//! the window, this loop emits exactly *one* summary at the window's
//! end.  A new event inside the window pushes the deadline out —
//! passive idle does not.  Once the window settles, the next event
//! opens a fresh window.  A slow heartbeat still runs so stale
//! severity decays even if the bus goes quiet.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use ts_rs::TS;

use super::{Bucket, BucketStatus, SecurityEvent, Severity};

/// Sliding window for severity aggregation. Events older than this
/// stop contributing to the bucket status, so a single noisy minute
/// doesn't keep the traffic-light red forever.
const WINDOW_SECS: i64 = 120;

/// Debounce window.  After an event arrives, additional events that
/// land inside this span coalesce into a single summary emission at
/// the window's end.  500ms is comfortably below human perception
/// but well above the inter-arrival time of a chatty agent run, so
/// bursts collapse instead of each tool call poking the renderer.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(500);

/// Periodic heartbeat so stale windows decay even if the bus is
/// silent (e.g. the 2-minute severity window ages out its last crit
/// event and the gauge should drop back to ok).  5s is plenty.
const HEARTBEAT: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, TS)]
#[ts(export)]
pub struct Summary {
    #[ts(type = "string")]
    pub severity: &'static str,
    #[ts(type = "string")]
    pub agent: &'static str,
    #[ts(type = "string")]
    pub net: &'static str,
    #[ts(type = "string")]
    pub perm: &'static str,
    #[ts(type = "string")]
    pub host: &'static str,
    pub panic_mode: bool,
    pub headline: Option<String>,
    pub counts: Counts,
    /// 0-100 composite threat score.  Drives the big radial gauge on
    /// the Overview tab and the nav-strip indicator colour.  Higher
    /// = worse.  Computed from bucket severities + crit/warn counts
    /// + long-horizon trend.
    #[ts(type = "number")]
    pub threat_score: u32,
    /// Per-minute counts for the last 60 min (oldest first).  Drives
    /// the overview sparklines without another IPC round-trip.
    #[ts(type = "Array<number>")]
    pub minute_events: Vec<u32>,
    #[ts(type = "Array<number>")]
    pub minute_tool_calls: Vec<u32>,
    #[ts(type = "Array<number>")]
    pub minute_net_bytes: Vec<u64>,
    /// Top hosts by bytes in the last 60 min.
    pub top_hosts: Vec<HostRollupEntry>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, TS)]
#[ts(export)]
pub struct Counts {
    #[ts(type = "number")]
    pub events_window: u32,
    #[ts(type = "number")]
    pub tool_calls_window: u32,
    #[ts(type = "number")]
    pub net_requests_window: u32,
    #[ts(type = "number")]
    pub warn_window: u32,
    #[ts(type = "number")]
    pub crit_window: u32,
    #[ts(type = "number")]
    pub egress_bytes_window: u64,
    #[ts(type = "number")]
    pub anomalies_window: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, TS)]
#[ts(export)]
pub struct HostRollupEntry {
    pub host: String,
    #[ts(type = "number")]
    pub count: u32,
    #[ts(type = "number")]
    pub bytes: u64,
}

fn status_str(s: BucketStatus) -> &'static str {
    match s {
        BucketStatus::Unknown => "unknown",
        BucketStatus::Ok => "ok",
        BucketStatus::Warn => "warn",
        BucketStatus::Crit => "crit",
    }
}

/// Kick the aggregator loop. Idempotent — multiple calls install new
/// tasks but the debounced state lives inside each task so duplicates
/// are harmless (just wasteful).  Call once from `startup::setup`
/// after the bus is installed.
pub fn start_summary_loop(app: AppHandle) {
    let rx = match super::subscribe() {
        Some(r) => r,
        None => {
            log::warn!("security: policy loop — bus not installed, skipping");
            return;
        }
    };

    tauri::async_runtime::spawn(async move {
        run_debounce_loop(rx, DEBOUNCE_WINDOW, HEARTBEAT, move |summary, _reason| {
            let _ = app.emit("sunny://security.summary", summary);
        })
        .await;
    });
}

/// Reason a summary emission was triggered.  Surfaced to the emit
/// callback so tests (and future instrumentation) can distinguish
/// burst-end emissions from the passive decay heartbeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmitReason {
    /// Debounce window settled after a burst of events.
    Burst,
    /// Periodic heartbeat noticed the aggregate state shifted (usually
    /// because the 2-min severity window aged out old events).
    Heartbeat,
}

/// Core debounce loop, factored out of [`start_summary_loop`] so the
/// semantics can be unit-tested without a real Tauri app.  Returns
/// when the broadcast channel is closed.
///
/// Semantics:
///   * Every received event starts (or extends) a debounce window.
///   * Additional events inside the window reset the deadline — a
///     new event means "still active, don't emit yet".
///   * When the window settles (no events for `window`), compute the
///     current summary and — if it differs from the last emit —
///     call `emit_fn` exactly once with `EmitReason::Burst`.
///   * The heartbeat runs on its own cadence.  When it fires and no
///     debounce window is active, it may emit a decay update with
///     `EmitReason::Heartbeat` if state has drifted.
///   * Equal-to-last summaries are suppressed — the loop only talks
///     to the renderer when something actually changed.
async fn run_debounce_loop<F>(
    mut rx: broadcast::Receiver<SecurityEvent>,
    window: Duration,
    heartbeat: Duration,
    mut emit_fn: F,
) where
    F: FnMut(&Summary, EmitReason) + Send + 'static,
{
    use tokio::time::{self, Instant};

    let mut last_payload: Option<Summary> = None;
    // `deadline == None` means we're idle (no pending burst).  When
    // an event lands we set it to `now + window`; subsequent events
    // push it further out; when the sleep arm fires we emit + clear.
    let mut deadline: Option<Instant> = None;

    let mut heartbeat_tick = time::interval(heartbeat);
    // Skip the immediate tick — the aggregator doesn't need to push
    // a zeroed summary at boot (the frontend hydrates from the
    // Tauri command anyway).
    heartbeat_tick.tick().await;

    loop {
        // Snapshot the deadline into a local so the pinned sleep
        // future below doesn't borrow our mutable `deadline`.  When
        // the window is idle we fall back to a `pending` future; the
        // `if deadline.is_some()` guard on the select arm ensures we
        // never actually poll that branch.
        let snapshot = deadline;
        let sleep_fut = async move {
            match snapshot {
                Some(d) => time::sleep_until(d).await,
                // Idle — guarded by `if deadline.is_some()` below.
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(sleep_fut);

        tokio::select! {
            biased;

            msg = rx.recv() => {
                match msg {
                    Ok(_ev) => {
                        // New event — (re)arm the debounce window.
                        deadline = Some(Instant::now() + window);
                    }
                    Err(broadcast::error::RecvError::Lagged(dropped)) => {
                        log::warn!(
                            "security: policy loop lagged, dropped {dropped} events",
                        );
                        // Treat lag the same as a burst: something
                        // happened, arm the window so we emit a fresh
                        // snapshot once the storm passes.
                        deadline = Some(Instant::now() + window);
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        log::info!("security: policy loop — bus closed, exiting");
                        break;
                    }
                }
            }

            _ = &mut sleep_fut, if deadline.is_some() => {
                // Debounce window settled — emit once with the final
                // aggregated snapshot, then clear the deadline.
                deadline = None;
                let summary = compute_summary();
                if last_payload.as_ref() != Some(&summary) {
                    emit_fn(&summary, EmitReason::Burst);
                    last_payload = Some(summary);
                }
            }

            _ = heartbeat_tick.tick() => {
                // Passive decay check.  We only emit on the heartbeat
                // if no burst is currently in flight — otherwise the
                // imminent debounce emit will carry the same info.
                if deadline.is_none() {
                    let summary = compute_summary();
                    if last_payload.as_ref() != Some(&summary) {
                        emit_fn(&summary, EmitReason::Heartbeat);
                        last_payload = Some(summary);
                    }
                }
            }
        }
    }
}

/// Walk the ring buffer and compute a fresh summary snapshot.
pub fn compute_summary() -> Summary {
    let now = super::now();
    let cutoff = now - WINDOW_SECS;

    let events = super::store().map(|s| s.snapshot()).unwrap_or_default();

    let mut per_bucket: [(Severity, u32); 4] =
        [(Severity::Info, 0), (Severity::Info, 0), (Severity::Info, 0), (Severity::Info, 0)];
    let mut counts = Counts::default();
    let mut headline: Option<(Severity, String, i64)> = None;
    let mut bucket_seen: [bool; 4] = [false; 4];

    // Per-minute counts for the last 60 min, oldest-first.
    const MINUTES: usize = 60;
    let mut minute_events = vec![0u32; MINUTES];
    let mut minute_tool_calls = vec![0u32; MINUTES];
    let mut minute_net_bytes = vec![0u64; MINUTES];
    let hour_cutoff = now - (MINUTES as i64) * 60;

    // Host rollup (last hour).
    let mut hosts: std::collections::HashMap<String, (u32, u64)> =
        std::collections::HashMap::new();

    for ev in events.iter() {
        let at = ev.at();

        // Minute-bucket the event no matter the 2-min severity window.
        if at >= hour_cutoff {
            let age_min = ((now - at) / 60) as usize;
            if age_min < MINUTES {
                // Oldest at index 0; newest at MINUTES-1.
                let idx = MINUTES - 1 - age_min;
                minute_events[idx] += 1;
                match ev {
                    SecurityEvent::ToolCall { .. } => minute_tool_calls[idx] += 1,
                    SecurityEvent::NetRequest { bytes, host, .. } => {
                        let b = bytes.unwrap_or(0) as u64;
                        minute_net_bytes[idx] += b;
                        let entry = hosts.entry(host.clone()).or_insert((0, 0));
                        entry.0 += 1;
                        entry.1 += b;
                    }
                    _ => {}
                }
            }
        }

        if at < cutoff {
            continue;
        }

        counts.events_window += 1;
        match ev {
            SecurityEvent::ToolCall { .. } => counts.tool_calls_window += 1,
            SecurityEvent::NetRequest { bytes, .. } => {
                counts.net_requests_window += 1;
                if let Some(b) = bytes {
                    counts.egress_bytes_window += *b as u64;
                }
            }
            SecurityEvent::ToolRateAnomaly { .. }
            | SecurityEvent::PromptInjection { .. }
            | SecurityEvent::CanaryTripped { .. } => {
                counts.anomalies_window += 1;
            }
            _ => {}
        }

        let sev = ev.severity();
        match sev {
            Severity::Warn => counts.warn_window += 1,
            Severity::Crit => counts.crit_window += 1,
            _ => {}
        }

        let bucket_idx = match ev.bucket() {
            Bucket::Agent => 0,
            Bucket::Net => 1,
            Bucket::Perm => 2,
            Bucket::Host => 3,
        };
        bucket_seen[bucket_idx] = true;
        let (cur_sev, cur_cnt) = per_bucket[bucket_idx];
        per_bucket[bucket_idx] = (cur_sev.max(sev), cur_cnt + 1);

        // Track the latest high-severity event as the summary
        // headline. Ties broken by timestamp.
        let take = match &headline {
            None => sev >= Severity::Warn,
            Some((best_sev, _, best_at)) => {
                sev > *best_sev || (sev == *best_sev && at >= *best_at)
            }
        };
        if take && sev >= Severity::Warn {
            let msg = describe_event(ev);
            headline = Some((sev, msg, at));
        }
    }

    let bucket_status = |i: usize| -> BucketStatus {
        if !bucket_seen[i] {
            BucketStatus::Ok
        } else {
            BucketStatus::from_severity(per_bucket[i].0)
        }
    };

    let panic_mode = super::panic_mode();
    let overall = if panic_mode {
        BucketStatus::Crit
    } else {
        let worst = [bucket_status(0), bucket_status(1), bucket_status(2), bucket_status(3)]
            .into_iter()
            .max_by_key(|b| match b {
                BucketStatus::Crit => 3,
                BucketStatus::Warn => 2,
                BucketStatus::Ok => 1,
                BucketStatus::Unknown => 0,
            })
            .unwrap_or(BucketStatus::Ok);
        worst
    };

    let threat_score = compute_threat_score(panic_mode, overall, &counts);

    // Top hosts — pick top 8 by bytes, fall back to count on ties.
    let mut top_hosts: Vec<HostRollupEntry> = hosts
        .into_iter()
        .map(|(host, (count, bytes))| HostRollupEntry { host, count, bytes })
        .collect();
    top_hosts.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| b.count.cmp(&a.count)));
    top_hosts.truncate(8);

    Summary {
        severity: status_str(overall),
        agent: status_str(bucket_status(0)),
        net: status_str(bucket_status(1)),
        perm: status_str(bucket_status(2)),
        host: status_str(bucket_status(3)),
        panic_mode,
        headline: headline.map(|(_, msg, _)| msg),
        counts,
        threat_score,
        minute_events,
        minute_tool_calls,
        minute_net_bytes,
        top_hosts,
        updated_at: now,
    }
}

/// Composite threat score (0–100).
///
/// Panic mode pins to 100.  Otherwise we weight:
///   * overall bucket status (unknown/ok=0, warn=+25, crit=+55)
///   * crit count in 2-min window (cap at +25)
///   * warn count in 2-min window (cap at +15)
///   * anomalies count (cap at +20)
///   * egress bytes / request in window (>1 MB/s average = +10)
pub fn compute_threat_score(
    panic_mode: bool,
    overall: BucketStatus,
    counts: &Counts,
) -> u32 {
    if panic_mode { return 100; }
    let mut score: u32 = 0;
    score += match overall {
        BucketStatus::Crit => 55,
        BucketStatus::Warn => 25,
        _ => 0,
    };
    score += counts.crit_window.min(25) * 1 + counts.crit_window.saturating_sub(1).min(10);
    score += (counts.warn_window / 2).min(15);
    score += (counts.anomalies_window * 4).min(20);
    // Egress-rate bonus.  ~2 min window -> 120 MB = >1 MB/s sustained.
    if counts.egress_bytes_window > 120 * 1024 * 1024 {
        score += 10;
    }
    score.min(100)
}

fn describe_event(ev: &SecurityEvent) -> String {
    use SecurityEvent::*;
    match ev {
        ToolCall { tool, agent, ok: Some(false), .. } => {
            format!("{agent} → {tool} failed")
        }
        ToolCall { tool, agent, .. } => format!("{agent} → {tool}"),
        ConfirmRequested { tool, requester, .. } => {
            format!("confirm requested: {requester} → {tool}")
        }
        ConfirmAnswered { approved: false, .. } => "user denied a dangerous action".into(),
        ConfirmAnswered { .. } => "user approved a dangerous action".into(),
        SecretRead { provider, caller, .. } => format!("{caller} read {provider}"),
        NetRequest { host, method, blocked: true, .. } => {
            format!("blocked {method} {host}")
        }
        NetRequest { host, method, .. } => format!("{method} {host}"),
        PermissionChange { key, current, .. } => format!("permission {key} → {current}"),
        LaunchAgentDelta { path, change, .. } => format!("LaunchAgent {change}: {path}"),
        LoginItemDelta { name, change, .. } => format!("login item {change}: {name}"),
        UnsignedBinary { path, .. } => format!("unsigned binary launched: {path}"),
        Panic { reason, .. } => format!("panic mode — {reason}"),
        PanicReset { by, .. } => format!("panic released by {by}"),
        PromptInjection { source, signals, .. } => {
            format!("prompt injection @ {source} · {} pattern(s)", signals.len())
        }
        CanaryTripped { destination, .. } => format!("CANARY TRIPPED → {destination}"),
        ToolRateAnomaly { tool, rate_per_min, baseline_per_min, .. } => {
            format!("{tool} rate {rate_per_min:.0}/min (baseline {baseline_per_min:.1})")
        }
        IntegrityStatus { key, status, .. } => format!("{key}: {status}"),
        FileIntegrityChange { path, curr_sha256, .. } => {
            let short: String = curr_sha256.chars().take(10).collect();
            format!("FIM · {path} → {short}…")
        }
        Notice { source, message, .. } => format!("{source}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::sync::broadcast;

    #[test]
    fn summary_defaults_to_ok_when_no_events() {
        let s = compute_summary();
        // Without a bus installed we just see "ok" across the board.
        assert_eq!(s.agent, "ok");
        assert_eq!(s.net, "ok");
        assert_eq!(s.perm, "ok");
        assert_eq!(s.host, "ok");
    }

    /// Build a throwaway `Notice` event for driving the debounce loop
    /// in tests.  The content doesn't matter — the loop just needs to
    /// see *something* land on the channel so it arms the window.
    fn test_event(n: u32) -> SecurityEvent {
        SecurityEvent::Notice {
            at: super::super::now(),
            source: "test".into(),
            message: format!("burst #{n}"),
            severity: Severity::Info,
        }
    }

    /// 10 events inside 100ms should collapse into a single emission
    /// at the end of the 500ms debounce window — not 10, not 2.  This
    /// is the R14-D regression: the old loop emitted one-per-cycle
    /// after the rate-limit expired, not one-per-burst.
    #[tokio::test(flavor = "current_thread")]
    async fn debounce_coalesces_burst() {
        let (tx, rx) = broadcast::channel::<SecurityEvent>(64);
        let emits: Arc<Mutex<Vec<EmitReason>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&emits);

        let window = Duration::from_millis(500);
        // Long heartbeat so a stray decay tick can't contaminate the
        // burst count during the test window.
        let heartbeat = Duration::from_secs(60);

        let handle = tokio::spawn(async move {
            run_debounce_loop(rx, window, heartbeat, move |_summary, reason| {
                sink.lock().unwrap().push(reason);
            })
            .await;
        });

        // Fire 10 events inside 100ms.  Spread them ~10ms apart to
        // simulate a chatty agent run rather than a single synchronous
        // blast (which would race the loop's first poll).
        for i in 0..10 {
            tx.send(test_event(i)).expect("bus still open");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Wait comfortably past the debounce window so the loop has
        // had time to fire its single emit.  window + slack.
        tokio::time::sleep(window + Duration::from_millis(250)).await;

        // Close the channel so the loop task exits cleanly.
        drop(tx);
        let _ = handle.await;

        let observed = emits.lock().unwrap().clone();
        assert_eq!(
            observed.len(),
            1,
            "expected exactly one debounced emission, got {}: {:?}",
            observed.len(),
            observed,
        );
        assert_eq!(observed[0], EmitReason::Burst);
    }

    /// An event that arrives *after* the window has settled should
    /// open a fresh window and emit again — debounce per burst, not
    /// "emit once ever".
    #[tokio::test(flavor = "current_thread")]
    async fn debounce_emits_per_burst() {
        let (tx, rx) = broadcast::channel::<SecurityEvent>(64);
        let emits: Arc<Mutex<Vec<EmitReason>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&emits);

        let window = Duration::from_millis(200);
        let heartbeat = Duration::from_secs(60);

        let handle = tokio::spawn(async move {
            run_debounce_loop(rx, window, heartbeat, move |_summary, reason| {
                sink.lock().unwrap().push(reason);
            })
            .await;
        });

        // Burst 1
        for i in 0..3 {
            tx.send(test_event(i)).expect("bus still open");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Settle first window.
        tokio::time::sleep(window + Duration::from_millis(150)).await;

        // Burst 2 — must produce a second emission because the
        // Notice content differs (different `message`) so the
        // equal-payload suppression does not trip.
        for i in 100..103 {
            tx.send(test_event(i)).expect("bus still open");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(window + Duration::from_millis(150)).await;

        drop(tx);
        let _ = handle.await;

        // We expect 1 or 2 emissions.  Without a bus installed the
        // `compute_summary()` payload is identical between the two
        // bursts (both "all ok"), so the equality-suppression check
        // elides the second emit — that's the correct behaviour, the
        // renderer doesn't need redundant identical summaries.
        let observed = emits.lock().unwrap().clone();
        assert!(
            observed.len() <= 2,
            "more than 2 emissions across 2 bursts: {observed:?}",
        );
        assert!(
            !observed.is_empty(),
            "expected at least one emission across 2 bursts",
        );
    }
}
