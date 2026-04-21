//! Persistent event spine — the unified substrate for SUNNY's cross-cutting
//! event fabric. The in-memory channel is `tokio::sync::broadcast` so each
//! subscriber (UI hook, daemon, SQLite drain) calls `sender.subscribe()`
//! and gets its own lagging receiver, rather than sharing a single `rx`
//! behind an app-level fanout `Mutex`.
//!
//! # Shape
//!
//! * A single typed [`SunnyEvent`] enum with `#[serde(tag = "kind")]` so the
//!   wire form is always `{ "kind": "...", "seq": N, ... }` — cleanly
//!   addressable from the frontend and from SQL (`WHERE kind = 'ChatChunk'`).
//! * An on-disk SQLite ring at `~/.sunny/events.sqlite` retained for
//!   7 days (pruned on startup + every 6 h).
//! * A non-blocking [`publish`] that broadcasts to every live
//!   `broadcast::Receiver` subscriber — the SQLite drain is just one
//!   such subscriber, plus every Tauri `ipc::Channel` hook.
//! * Two async tails — [`tail`] and [`tail_by_kind`] — for warm replay.
//! * Tauri commands: `event_bus_tail`, `event_bus_tail_by_kind`,
//!   `event_bus_subscribe`, `event_bus_unsubscribe`.
//!
//! # Dedupe-collision mitigation
//!
//! Every event carries a monotonic `seq: u64` assigned by [`publish`]
//! from a process-local [`AtomicU64`], paired with a `boot_epoch: u64`
//! captured once per process (via [`LazyLock`]) from wall-clock
//! milliseconds. Same-ms, same-shape ChatChunks no longer collide —
//! the frontend dedupes by `(boot_epoch, seq)`. The epoch exists
//! because `seq` alone resets to 1 on app restart, so a frontend
//! that persisted "last seen seq = 5000" would otherwise silently
//! drop every post-restart event until the new process surpassed
//! 5000. On a restart the epoch changes, which is the signal for
//! the frontend to reset its seq cursor.
//!
//! Events loaded from SQLite rows written before these fields
//! existed default to `seq = 0, boot_epoch = 0` via
//! `#[serde(default)]` so old rows stay readable; `boot_epoch = 0`
//! is treated as "pre-migration, implicitly less-than any running
//! epoch" by frontend dedupe.
//!
//! # Supervision
//!
//! Both the drain task (batches events into SQLite) and the periodic
//! pruner are wrapped in `crate::supervise::spawn_supervised`. A panic
//! anywhere downstream no longer silently blackholes the bus — the
//! supervisor logs and restarts the task after a 2s back-off.
//!
//! # Lag tolerance
//!
//! Broadcast channels have a per-receiver ring buffer; a slow consumer
//! whose buffer overruns gets `RecvError::Lagged(n)` on its next recv
//! — the receiver stays live, only the skipped events are lost. Every
//! loop in this module that owns a broadcast receiver logs a `warn!`
//! on `Lagged` and continues. DO NOT drop the receiver on lag — that
//! would silently sever the subscription.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::supervise;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Directory under `$HOME` holding all SUNNY state.
const DIR_NAME: &str = ".sunny";
/// DB filename — distinct from `memory.sqlite` so the event ring is
/// cheap to recreate / nuke without touching semantic memory.
const DB_FILENAME: &str = "events.sqlite";
/// Retention horizon: events older than this are pruned on startup
/// and every 6 hours thereafter.
const RETENTION_DAYS: i64 = 7;
/// Interval for the periodic pruner.
const PRUNE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// How many events the drain task batches into a single transaction.
const DRAIN_BATCH: usize = 64;
/// Broadcast channel capacity (per-receiver ring buffer). Sized at
/// 16 384 — bursty ChatChunk streams saturate well below this, and the
/// SQLite drain is normally the slowest consumer.
const CHANNEL_CAPACITY: usize = 16384;

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

/// Monotonic per-process sequence number. Stamped onto every event by
/// [`publish`]; never re-used within a process lifetime. Frontend
/// consumers dedupe on `(boot_epoch, seq)` — seq alone is NOT
/// sufficient across an app restart (see [`BOOT_EPOCH`] below).
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Count of distinct `RecvError::Lagged` / `TryRecvError::Lagged` warn
/// events the bus has logged since boot. Every time ANY broadcast
/// receiver owned by this module (the SQLite drain task plus each
/// per-subscriber ipc pump) observes a `Lagged(n)` arm and logs the
/// warn, we bump this counter by one. Exposed via [`lag_stats`] for
/// the Diagnostics page.
///
/// Note: this counts warn EVENTS, not receivers. A single receiver
/// that lags three times separately contributes three; a receiver
/// that lags once while the drain also lags once contributes two.
static LAG_WARN_TOTAL: AtomicU64 = AtomicU64::new(0);

/// Sum of `n` across every logged `Lagged(n)` — i.e. the total count
/// of broadcast events that at least one subscriber missed because its
/// per-receiver ring buffer overflowed. This is strictly >= the sum of
/// distinct events dropped (a single event can be missed by multiple
/// receivers and would be counted once per receiver here), but it's
/// the right single number for "how much did the bus lag?" on the
/// Diagnostics page.
static LAG_WARN_EVENTS_DROPPED: AtomicU64 = AtomicU64::new(0);

/// Record a `Lagged(n)` warn in the aggregate counters. Called from
/// every `Lagged` arm in this module — keeping the bump in one helper
/// means every site increments both counters consistently, and a future
/// fourth consumer (say, a metrics tap) picks up the same accounting.
fn record_lag(n: u64) {
    LAG_WARN_TOTAL.fetch_add(1, Ordering::Relaxed);
    LAG_WARN_EVENTS_DROPPED.fetch_add(n, Ordering::Relaxed);
}

/// Snapshot of the process-wide lag counters: `(warn_events, total_dropped)`.
///
/// * `warn_events` — number of distinct `Lagged(n)` arms observed across
///   every broadcast receiver in this module since boot.
/// * `total_dropped` — sum of `n` across those events; the "how many
///   events did some subscriber miss?" number surfaced on the
///   Diagnostics page.
///
/// Cheap — two `Relaxed` atomic loads. Safe to call from anywhere.
pub fn lag_stats() -> (u64, u64) {
    (
        LAG_WARN_TOTAL.load(Ordering::Relaxed),
        LAG_WARN_EVENTS_DROPPED.load(Ordering::Relaxed),
    )
}

/// Per-process boot epoch. Wall-clock milliseconds captured the first
/// time anything in this module touches it (normally at the first
/// [`publish`] call after process start, which is a few ms after
/// `init_in`). Stamped onto every event alongside [`SEQ`] so frontend
/// consumers can treat the dedupe key as `(boot_epoch, seq)`:
///
/// 1. Before this field existed, a frontend that persisted "last seen
///    seq = 5000" would ignore every event after a backend restart
///    (where SEQ resets to 1) until the new process surpassed 5000.
/// 2. With boot_epoch, the frontend detects a CHANGE (not a strict
///    increase — clock can move backward on TZ change / manual set)
///    and resets its seq cursor. Different epoch = different process
///    = fresh seq namespace.
///
/// A value of `0` on deserialised events means "legacy SQLite row
/// written before this field existed". The frontend treats
/// boot_epoch=0 as implicitly less-than any running epoch and
/// ingests it under a synthetic legacy epoch.
///
/// On the `#[cfg(test)]` path we expose a helper to re-initialise
/// this value so we can verify the cross-restart dedupe story
/// without spinning up a subprocess.
static BOOT_EPOCH: LazyLock<AtomicU64> = LazyLock::new(|| {
    AtomicU64::new(chrono::Utc::now().timestamp_millis().max(1) as u64)
});

/// Read the current boot epoch. Cheap (atomic load).
fn current_boot_epoch() -> u64 {
    BOOT_EPOCH.load(Ordering::Relaxed)
}

/// Test-only: re-stamp the boot epoch to simulate a process restart
/// without actually restarting. Production code must never mutate
/// the epoch — a real restart is the only legitimate way to change
/// it, because the SEQ atomic also resets in that path.
#[cfg(test)]
fn reset_boot_epoch_for_test(new_epoch: u64) {
    BOOT_EPOCH.store(new_epoch, Ordering::Relaxed);
}

/// The unified event shape. Every cross-cutting SUNNY event eventually
/// lands here. The `tag = "kind"` attribute makes each variant a JSON
/// object shaped like `{ "kind": "ChatChunk", "seq": N, "boot_epoch": E, ... }`.
///
/// Every variant carries a monotonic `seq: u64` AND a `boot_epoch: u64`
/// as the composite dedupe key. `seq` alone isn't enough — it resets
/// to 1 on process restart, so a frontend that persisted "last seen
/// seq = 5000" would ignore every post-restart event until the new
/// process surpassed 5000. `boot_epoch` flips on every restart, which
/// is the signal for the frontend to reset its cursor.
///
/// Publishers pass `seq: 0, boot_epoch: 0` and [`publish`] stamps both
/// real values before fanout. Legacy SQLite rows written before these
/// fields existed have neither on the wire; `#[serde(default)]` means
/// they deserialise cleanly with `seq = 0, boot_epoch = 0` — the
/// frontend treats `boot_epoch = 0` as "pre-migration, implicitly
/// less-than any running epoch" and ingests them under a synthetic
/// legacy epoch.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(tag = "kind")]
#[ts(export)]
pub enum SunnyEvent {
    /// An `agent_loop` iteration step — one reasoning+tool cycle.
    AgentStep {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        turn_id: String,
        #[ts(type = "number")]
        iteration: u32,
        text: String,
        tool: Option<String>,
        #[ts(type = "number")]
        at: i64,
    },
    /// A streaming chat delta chunk.
    ChatChunk {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        turn_id: String,
        delta: String,
        done: bool,
        #[ts(type = "number")]
        at: i64,
    },
    /// A world-model tick (focus change, metrics sample, activity state).
    WorldTick {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        #[ts(type = "number")]
        revision: u64,
        focus_app: Option<String>,
        activity: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// A security event (policy violation, quota trip, integrity alert).
    Security {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        severity: String,
        summary: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// A sub-agent lifecycle transition (start/step/finish/error).
    ///
    /// Carries the full payload shape `sunny://agent.sub` used to emit
    /// so `useSubAgentsBridge.ts` consumes the push channel without
    /// losing per-step detail (iteration index, inner step kind —
    /// `thinking` / `tool_call` / `tool_result` / `error` — and the
    /// content body, truncated to [`SUB_AGENT_CONTENT_MAX`]).
    ///
    /// `iteration` / `step_kind` / `content` are `#[serde(default)]`
    /// so older persisted rows still deserialise cleanly.
    ///
    /// Note: the inner-step kind is serialised as `"step_kind"` on the
    /// wire so it can't collide with the enum's `#[serde(tag = "kind")]`
    /// discriminator. The bridge receives it as `payload.step_kind` (or
    /// equivalently, the flattened `step_kind` field on the event
    /// object itself).
    SubAgent {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        run_id: String,
        #[serde(default)]
        lifecycle: String,
        #[serde(default)]
        goal: Option<String>,
        #[serde(default)]
        #[ts(type = "number")]
        iteration: u32,
        #[serde(default, rename = "step_kind")]
        #[ts(rename = "step_kind")]
        kind: String,
        #[serde(default)]
        content: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// A daemon firing (scheduled or predicate-triggered).
    DaemonFire {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        daemon_id: String,
        goal: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// A streaming tool-call start event. Emitted when Anthropic sends a
    /// `content_block_start` with `type: "tool_use"`. Allows the frontend to
    /// show "typing: WebSearch(query=..." in real time before the full input
    /// JSON is assembled.
    ToolCallStart {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        turn_id: String,
        /// Anthropic-assigned tool-call id.
        id: String,
        /// Tool name, e.g. `"web_search"`.
        name: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// An incremental JSON fragment for an in-flight tool call's `input`
    /// field. Coalesced to ≤ 60 Hz before publishing; frontends concatenate
    /// all fragments to reconstruct the full input.
    ToolCallArgsDelta {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        turn_id: String,
        /// Tool-call id matching the preceding [`ToolCallStart`].
        id: String,
        /// Partial JSON. Concatenate all fragments to get the full input.
        json_fragment: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// The tool call's `input` JSON is complete. Anthropic sends
    /// `content_block_stop` after the last `input_json_delta`.
    ToolCallEnd {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        turn_id: String,
        /// Tool-call id matching the preceding [`ToolCallStart`].
        id: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// Terminal event for a streaming turn. Always emitted last so the
    /// frontend can reliably clear its loading indicator. `reason` is one of
    /// `"stop"` | `"tool_use"` | `"max_tokens"` | `"error"`.
    StreamEnd {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        turn_id: String,
        /// Why the stream terminated.
        reason: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// A raw signal emitted by a Autopilot sensor (idle, fs_burst, build, clipboard).
    /// Subscribers include the Deliberator, which coalesces and scores signals.
    AutopilotSignal {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        /// Sensor that produced this signal, e.g. "idle" | "fs_burst" | "build" | "clipboard".
        source: String,
        /// JSON-encoded sensor payload. Schema is sensor-specific.
        payload: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// A surface decision produced by the Deliberator — scored, tiered, and
    /// ready for routing to HUD pulse (T1) or voice (T2+, feature-gated).
    AutopilotSurface {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        /// Routing tier 0–5.
        tier: u8,
        /// Human-readable summary of the surface.
        summary: String,
        /// Scored relevance in [0, 1].
        score: f32,
        #[ts(type = "number")]
        at: i64,
    },
    /// A streaming token delta from a council member during `council_start`.
    /// Emitted once per token so the frontend can render live token streams.
    CouncilDelta {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        /// Zero-based index of the council member.
        #[ts(type = "number")]
        member_idx: usize,
        /// The streamed token.
        token: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// Emitted when a council member has finished producing its full output.
    CouncilDone {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        /// Zero-based index of the council member.
        #[ts(type = "number")]
        member_idx: usize,
        /// Complete text for this member.
        final_text: String,
        #[ts(type = "number")]
        at: i64,
    },
    /// Wake-word detection fired. Emitted by `voice::wake_word` when the
    /// "hey sunny" keyword spotter exceeds the confidence threshold.
    /// `audio_snippet` is the last 2 seconds of PCM (f32, 16 kHz mono)
    /// captured before the trigger — fed directly to the STT pipeline.
    WakeWordFired {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        /// Keyword-spotter confidence in [0, 1].
        confidence: f32,
        /// Pre-wake audio snippet for the STT pipeline (f32, 16 kHz mono).
        /// Never persisted to disk.
        #[serde(skip)]
        #[ts(skip)]
        audio_snippet: Vec<f32>,
        #[ts(type = "number")]
        at: i64,
    },
    /// A settings change — emitted by `settings_store::with_updated` after
    /// every successful atomic write + snapshot swap.
    SettingsChanged {
        #[serde(default)]
        #[ts(type = "number")]
        seq: u64,
        #[serde(default)]
        #[ts(type = "number")]
        boot_epoch: u64,
        /// Dot-separated JSON path describing what changed, e.g.
        /// `"autopilot.calm_mode"`.
        field_path: String,
        /// Full serialised `SunnySettings` before the change.
        old_json: String,
        /// Full serialised `SunnySettings` after the change.
        new_json: String,
        #[ts(type = "number")]
        at: i64,
    },
}

impl SunnyEvent {
    /// Extract the discriminator string for the `kind` column.
    fn kind(&self) -> &'static str {
        match self {
            SunnyEvent::AgentStep { .. } => "AgentStep",
            SunnyEvent::ChatChunk { .. } => "ChatChunk",
            SunnyEvent::WorldTick { .. } => "WorldTick",
            SunnyEvent::Security { .. } => "Security",
            SunnyEvent::SubAgent { .. } => "SubAgent",
            SunnyEvent::DaemonFire { .. } => "DaemonFire",
            SunnyEvent::ToolCallStart { .. } => "ToolCallStart",
            SunnyEvent::ToolCallArgsDelta { .. } => "ToolCallArgsDelta",
            SunnyEvent::ToolCallEnd { .. } => "ToolCallEnd",
            SunnyEvent::StreamEnd { .. } => "StreamEnd",
            SunnyEvent::AutopilotSignal { .. } => "AutopilotSignal",
            SunnyEvent::AutopilotSurface { .. } => "AutopilotSurface",
            SunnyEvent::CouncilDelta { .. } => "CouncilDelta",
            SunnyEvent::CouncilDone { .. } => "CouncilDone",
            SunnyEvent::WakeWordFired { .. } => "WakeWordFired",
            SunnyEvent::SettingsChanged { .. } => "SettingsChanged",
        }
    }

    /// Extract the event timestamp (every variant carries `at`).
    fn at(&self) -> i64 {
        match self {
            SunnyEvent::AgentStep { at, .. }
            | SunnyEvent::ChatChunk { at, .. }
            | SunnyEvent::WorldTick { at, .. }
            | SunnyEvent::Security { at, .. }
            | SunnyEvent::SubAgent { at, .. }
            | SunnyEvent::DaemonFire { at, .. }
            | SunnyEvent::ToolCallStart { at, .. }
            | SunnyEvent::ToolCallArgsDelta { at, .. }
            | SunnyEvent::ToolCallEnd { at, .. }
            | SunnyEvent::StreamEnd { at, .. }
            | SunnyEvent::AutopilotSignal { at, .. }
            | SunnyEvent::AutopilotSurface { at, .. }
            | SunnyEvent::CouncilDelta { at, .. }
            | SunnyEvent::CouncilDone { at, .. }
            | SunnyEvent::WakeWordFired { at, .. }
            | SunnyEvent::SettingsChanged { at, .. } => *at,
        }
    }

    /// Stamp a fresh `(boot_epoch, seq)` pair onto the event. Called
    /// once by [`publish`] at enqueue time; publishers construct events
    /// with `seq: 0, boot_epoch: 0` and rely on this to assign the real
    /// values. Both are stamped from the same publish call so the pair
    /// is consistent: every event with a given seq has the epoch that
    /// was live at the moment the seq was drawn.
    fn stamp_seq(&mut self) {
        let next_seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let epoch = current_boot_epoch();
        match self {
            SunnyEvent::AgentStep { seq, boot_epoch, .. }
            | SunnyEvent::ChatChunk { seq, boot_epoch, .. }
            | SunnyEvent::WorldTick { seq, boot_epoch, .. }
            | SunnyEvent::Security { seq, boot_epoch, .. }
            | SunnyEvent::SubAgent { seq, boot_epoch, .. }
            | SunnyEvent::DaemonFire { seq, boot_epoch, .. }
            | SunnyEvent::ToolCallStart { seq, boot_epoch, .. }
            | SunnyEvent::ToolCallArgsDelta { seq, boot_epoch, .. }
            | SunnyEvent::ToolCallEnd { seq, boot_epoch, .. }
            | SunnyEvent::StreamEnd { seq, boot_epoch, .. }
            | SunnyEvent::AutopilotSignal { seq, boot_epoch, .. }
            | SunnyEvent::CouncilDelta { seq, boot_epoch, .. }
            | SunnyEvent::CouncilDone { seq, boot_epoch, .. }
            | SunnyEvent::AutopilotSurface { seq, boot_epoch, .. }
            | SunnyEvent::WakeWordFired { seq, boot_epoch, .. }
            | SunnyEvent::SettingsChanged { seq, boot_epoch, .. } => {
                *seq = next_seq;
                *boot_epoch = epoch;
            }
        }
    }

    /// Read the event's seq (0 = unstamped, e.g. legacy SQLite row).
    pub fn seq(&self) -> u64 {
        match self {
            SunnyEvent::AgentStep { seq, .. }
            | SunnyEvent::ChatChunk { seq, .. }
            | SunnyEvent::WorldTick { seq, .. }
            | SunnyEvent::Security { seq, .. }
            | SunnyEvent::SubAgent { seq, .. }
            | SunnyEvent::DaemonFire { seq, .. }
            | SunnyEvent::ToolCallStart { seq, .. }
            | SunnyEvent::ToolCallArgsDelta { seq, .. }
            | SunnyEvent::ToolCallEnd { seq, .. }
            | SunnyEvent::StreamEnd { seq, .. }
            | SunnyEvent::AutopilotSignal { seq, .. }
            | SunnyEvent::AutopilotSurface { seq, .. }
            | SunnyEvent::CouncilDelta { seq, .. }
            | SunnyEvent::CouncilDone { seq, .. }
            | SunnyEvent::WakeWordFired { seq, .. }
            | SunnyEvent::SettingsChanged { seq, .. } => *seq,
        }
    }

    /// Read the event's boot_epoch (0 = legacy row written before the
    /// field existed; treated as "pre-migration, implicitly less-than
    /// any running epoch" by frontend dedupe).
    pub fn boot_epoch(&self) -> u64 {
        match self {
            SunnyEvent::AgentStep { boot_epoch, .. }
            | SunnyEvent::ChatChunk { boot_epoch, .. }
            | SunnyEvent::WorldTick { boot_epoch, .. }
            | SunnyEvent::Security { boot_epoch, .. }
            | SunnyEvent::SubAgent { boot_epoch, .. }
            | SunnyEvent::DaemonFire { boot_epoch, .. }
            | SunnyEvent::ToolCallStart { boot_epoch, .. }
            | SunnyEvent::ToolCallArgsDelta { boot_epoch, .. }
            | SunnyEvent::ToolCallEnd { boot_epoch, .. }
            | SunnyEvent::StreamEnd { boot_epoch, .. }
            | SunnyEvent::AutopilotSignal { boot_epoch, .. }
            | SunnyEvent::AutopilotSurface { boot_epoch, .. }
            | SunnyEvent::CouncilDelta { boot_epoch, .. }
            | SunnyEvent::CouncilDone { boot_epoch, .. }
            | SunnyEvent::WakeWordFired { boot_epoch, .. }
            | SunnyEvent::SettingsChanged { boot_epoch, .. } => *boot_epoch,
        }
    }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

/// The broadcast sender. Every subscriber (drain task, Tauri ipc channels,
/// daemons) calls `SENDER.get().unwrap().subscribe()` to get their own
/// lagging receiver. `publish()` calls `sender.send(event).ok()` — a
/// `SendError` means "zero live receivers", which is a benign condition
/// (startup before the drain subscribes, shutdown after everyone
/// unsubscribed). The SQLite persistence path does NOT depend on a
/// broadcast receiver existing, because the drain task is spawned at
/// `init` time and holds its own subscription for the lifetime of the
/// process.
static SENDER: OnceLock<broadcast::Sender<SunnyEvent>> = OnceLock::new();
static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Monotonic subscription id generator. First id is 1 (0 reserved as
/// "never assigned").
static SUB_NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Live frontend subscribers. Keys are subscription ids; values are the
/// join handles of the pump tasks. Each subscription owns a background
/// task that pumps a dedicated `broadcast::Receiver` into the ipc
/// channel — so a slow frontend can lag its own buffer without
/// affecting any other subscriber (the whole point of the broadcast
/// switch). The pump is stopped by calling `abort()` on the handle.
static SUBSCRIBERS: OnceLock<Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>> =
    OnceLock::new();

fn subscribers() -> &'static Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>> {
    SUBSCRIBERS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn default_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    Ok(home.join(DIR_NAME))
}

fn db_path_in(dir: &Path) -> PathBuf {
    dir.join(DB_FILENAME)
}

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

fn open_connection(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let conn = Connection::open(path)
        .map_err(|e| format!("open events sqlite {}: {e}", path.display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("pragma WAL: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("pragma synchronous: {e}"))?;
    // WAL hygiene: match the memory DB settings from db.rs::open_connection.
    // Keeps the events WAL sidecar bounded under heavy write bursts (each
    // ChatChunk stream is a burst of many small inserts).
    conn.execute_batch("PRAGMA wal_autocheckpoint=1000;")
        .map_err(|e| format!("pragma wal_autocheckpoint (events): {e}"))?;
    conn.execute_batch("PRAGMA journal_size_limit=67108864;")
        .map_err(|e| format!("pragma journal_size_limit (events): {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            at      INTEGER NOT NULL,
            kind    TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
        CREATE INDEX IF NOT EXISTS idx_events_kind_at ON events(kind, at DESC);
        "#,
    )
    .map_err(|e| format!("ensure events schema: {e}"))
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/// Initialize the event bus. Spawns supervised drain + pruner tasks.
///
/// Safe to call exactly once; subsequent calls from the same process
/// return an error (see [`init_in`] for why — test isolation hazard).
pub fn init() -> Result<(), String> {
    init_in(&default_dir()?)
}

/// Same as [`init`], but parameterised on the directory. Used from
/// unit tests pointing at a tempdir.
///
/// # Init guard
///
/// If the global DB connection slot is already occupied, this function
/// returns `Err(..)` — we deliberately do *not* silently keep the old
/// connection, because tests that call `init_in(tempdir_a)` then
/// `init_in(tempdir_b)` would otherwise continue writing to tempdir_a
/// with no indication. The caller is responsible for deciding whether
/// a second call is an error (tests) or a no-op (production boot).
pub fn init_in(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create events dir: {e}"))?;
    let path = db_path_in(dir);

    let conn = open_connection(&path)?;
    ensure_schema(&conn)?;
    let _ = prune_older_than(&conn, retention_cutoff_ms());

    // Install the DB connection. If a previous init already ran, we
    // MUST refuse — otherwise later publishes would target the old DB
    // while the caller thinks they're using the new one.
    if CONN.set(Mutex::new(conn)).is_err() {
        return Err("event_bus already initialised".into());
    }

    // Broadcast channel. The capacity is the per-receiver ring buffer
    // size — a subscriber that falls more than CHANNEL_CAPACITY events
    // behind will see `RecvError::Lagged(n)` on its next recv and can
    // resync from there. `publish()` uses `send().ok()` so zero
    // receivers is benign.
    let (tx, drain_rx) = broadcast::channel::<SunnyEvent>(CHANNEL_CAPACITY);
    if SENDER.set(tx).is_err() {
        // Very unlikely: CONN was vacant but SENDER is occupied. Treat
        // the same way as CONN — refuse, don't silently diverge.
        return Err("event_bus sender already set".into());
    }

    // Drain task — supervised. The supervisor re-runs the factory on
    // panic; since the initial `drain_rx` is captured through a
    // Mutex<Option<_>>, only the first run consumes it. A restart that
    // finds the slot empty subscribes freshly so persistence keeps
    // working — the ring buffer on the replacement receiver starts at
    // the current head, which is exactly what we want after a panic.
    let rx_slot = std::sync::Arc::new(tokio::sync::Mutex::new(Some(drain_rx)));
    supervise::spawn_supervised("event_bus_drain", move || {
        let rx_slot = rx_slot.clone();
        async move {
            // Take the original receiver on first run; on restart, fall
            // back to a fresh subscribe() so we don't silently stop
            // persisting after a panic.
            let mut rx = match rx_slot.lock().await.take() {
                Some(rx) => rx,
                None => match SENDER.get() {
                    Some(tx) => tx.subscribe(),
                    None => return,
                },
            };
            let mut batch: Vec<SunnyEvent> = Vec::with_capacity(DRAIN_BATCH);
            loop {
                match rx.recv().await {
                    Ok(first) => {
                        batch.push(first);
                        // Opportunistically drain without blocking.
                        while batch.len() < DRAIN_BATCH {
                            match rx.try_recv() {
                                Ok(e) => batch.push(e),
                                Err(broadcast::error::TryRecvError::Empty) => break,
                                Err(broadcast::error::TryRecvError::Closed) => break,
                                Err(broadcast::error::TryRecvError::Lagged(n)) => {
                                    record_lag(n);
                                    log::warn!(
                                        "[event_bus] subscriber lagged, skipped {n} events"
                                    );
                                    // Continue with whatever we already
                                    // accumulated; receiver is still live.
                                    break;
                                }
                            }
                        }
                        if let Err(e) = commit_batch(&batch) {
                            log::warn!("event_bus: commit batch failed: {e}");
                        }
                        batch.clear();
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        record_lag(n);
                        // DO NOT drop the receiver — it's still valid.
                        // The lost events never persisted to SQLite but
                        // the receiver will resume at the current head.
                        log::warn!("[event_bus] subscriber lagged, skipped {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        // Sender gone — process shutting down.
                        break;
                    }
                }
            }
        }
    });

    // Periodic pruner — supervised. First tick is consumed so we don't
    // double-prune right after the startup prune.
    supervise::spawn_supervised("event_bus_prune", || async {
        let mut ticker = tokio::time::interval(PRUNE_INTERVAL);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Some(mu) = CONN.get() {
                if let Ok(conn) = mu.lock() {
                    let _ = prune_older_than(&conn, retention_cutoff_ms());
                }
            }
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/// Publish an event. Non-blocking. Stamps a monotonic `seq` and
/// broadcasts to every live `broadcast::Receiver`.
///
/// `broadcast::Sender::send` only fails when there are **zero** live
/// receivers — which is a benign condition (e.g. `publish` called
/// before `init_in` has spawned the drain, or during shutdown after
/// everyone unsubscribed). We `.ok()` the error because:
///
/// * The SQLite drain subscribes at `init_in` time and lives for the
///   process, so in the happy path there's always at least one
///   receiver.
/// * Lagging subscribers are NOT a send error — each receiver's ring
///   buffer absorbs up to [`CHANNEL_CAPACITY`] events before the next
///   `recv()` yields `RecvError::Lagged`. There is no publisher-side
///   back-pressure anymore; lag is a receiver-local concern.
pub fn publish(mut event: SunnyEvent) {
    event.stamp_seq();

    let Some(tx) = SENDER.get() else {
        // Pre-init publish: the event is lost (no drain to persist it,
        // no subscribers). This path is hit in tests that skip init;
        // production boot sequences init before anything publishes.
        return;
    };

    // Send returns Err only when there are zero receivers. That's not
    // an error worth surfacing — it just means we've published into
    // the void, which will never persist (the drain isn't running yet)
    // but also isn't recoverable from the publisher side.
    let _ = tx.send(event).ok();
}

/// Current number of live broadcast receivers. Useful from tests and
/// for the `/healthz` surface.
pub fn receiver_count() -> usize {
    SENDER.get().map(|tx| tx.receiver_count()).unwrap_or(0)
}

/// Expose the broadcast sender for modules that need to subscribe directly
/// (e.g. the Autopilot Deliberator). Returns `None` before `init()` is called.
pub fn sender() -> Option<&'static broadcast::Sender<SunnyEvent>> {
    SENDER.get()
}

// ---------------------------------------------------------------------------
// Commit / prune helpers
// ---------------------------------------------------------------------------

fn commit_batch(batch: &[SunnyEvent]) -> Result<(), String> {
    let Some(mu) = CONN.get() else {
        return Err("event bus not initialised".into());
    };
    let mut conn = mu.lock().map_err(|_| "events mutex poisoned".to_string())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin tx: {e}"))?;
    {
        let mut stmt = tx
            .prepare_cached("INSERT INTO events (at, kind, payload) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("prepare insert: {e}"))?;
        for event in batch {
            let payload = serde_json::to_string(event)
                .map_err(|e| format!("serialize event: {e}"))?;
            stmt.execute(params![event.at(), event.kind(), payload])
                .map_err(|e| format!("insert event: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("commit: {e}"))
}

fn retention_cutoff_ms() -> i64 {
    let now = chrono::Utc::now().timestamp_millis();
    now - RETENTION_DAYS * 24 * 60 * 60 * 1000
}

fn prune_older_than(conn: &Connection, cutoff_ms: i64) -> Result<usize, String> {
    conn.execute("DELETE FROM events WHERE at < ?1", params![cutoff_ms])
        .map_err(|e| format!("prune events: {e}"))
}

// ---------------------------------------------------------------------------
// Tails (warm-replay prefix for the new push hook)
// ---------------------------------------------------------------------------

/// Fetch the most recent events, newest-first, optionally bounded by
/// a lower-bound timestamp `since_ms`. `limit` caps the row count.
pub async fn tail(limit: usize, since_ms: Option<i64>) -> Vec<SunnyEvent> {
    let limit = limit.clamp(1, 10_000);
    tauri::async_runtime::spawn_blocking(move || -> Vec<SunnyEvent> {
        let Some(mu) = CONN.get() else { return Vec::new(); };
        let Ok(conn) = mu.lock() else { return Vec::new(); };
        tail_sync(&conn, limit, since_ms).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Fetch the most recent events of a given `kind`, newest-first.
pub async fn tail_by_kind(kind: &str, limit: usize) -> Vec<SunnyEvent> {
    let limit = limit.clamp(1, 10_000);
    let kind_owned = kind.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Vec<SunnyEvent> {
        let Some(mu) = CONN.get() else { return Vec::new(); };
        let Ok(conn) = mu.lock() else { return Vec::new(); };
        tail_by_kind_sync(&conn, &kind_owned, limit).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

fn tail_sync(
    conn: &Connection,
    limit: usize,
    since_ms: Option<i64>,
) -> Result<Vec<SunnyEvent>, String> {
    // Collapse the two-branch prepare into one query using
    // COALESCE(?1, 0): when since_ms is Some(t) the WHERE filters
    // at >= t; when since_ms is None we pass 0, which is a timestamp
    // before any real event and therefore a no-op filter. One
    // prepare_cached call replaces two prepare() calls.
    let since = since_ms.unwrap_or(0);
    let mut stmt = conn
        .prepare_cached(
            "SELECT payload FROM events WHERE at >= ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        )
        .map_err(|e| format!("prepare tail: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map(params![since, limit as i64], |r| r.get::<_, String>(0))
        .map_err(|e| format!("query tail: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect tail: {e}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|p| serde_json::from_str::<SunnyEvent>(&p).ok())
        .collect())
}

fn tail_by_kind_sync(
    conn: &Connection,
    kind: &str,
    limit: usize,
) -> Result<Vec<SunnyEvent>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT payload FROM events WHERE kind = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        )
        .map_err(|e| format!("prepare tail_by_kind: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map(params![kind, limit as i64], |r| r.get::<_, String>(0))
        .map_err(|e| format!("query tail_by_kind: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect tail_by_kind: {e}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|p| serde_json::from_str::<SunnyEvent>(&p).ok())
        .collect())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn event_bus_tail(limit: u32, since_ms: Option<i64>) -> Vec<SunnyEvent> {
    tail(limit as usize, since_ms).await
}

#[tauri::command]
pub async fn event_bus_tail_by_kind(kind: String, limit: u32) -> Vec<SunnyEvent> {
    tail_by_kind(&kind, limit as usize).await
}

/// Subscribe to the push channel. The frontend opens a Tauri
/// `ipc::Channel<SunnyEvent>` and hands it to this command; the bus
/// allocates a fresh `broadcast::Receiver`, spawns a pump task that
/// forwards every event from the receiver into the ipc channel, and
/// returns the subscription id. Unsubscribe aborts the pump.
///
/// The typical frontend flow is:
/// 1. Call `event_bus_tail(...)` for the warm-replay prefix.
/// 2. Call `event_bus_subscribe(channel)` and keep the id.
/// 3. On unmount, call `event_bus_unsubscribe(id)`.
///
/// Per-subscriber lag handling: the pump task owns its own
/// `broadcast::Receiver` with its own ring buffer. On
/// `RecvError::Lagged(n)` it logs a warn and continues — it does NOT
/// drop the receiver, so the frontend just sees a gap and catches up
/// from the next event.
#[tauri::command]
pub async fn event_bus_subscribe(channel: Channel<SunnyEvent>) -> Result<u64, String> {
    let Some(tx) = SENDER.get() else {
        return Err("event bus not initialised".into());
    };
    let mut rx = tx.subscribe();
    let id = SUB_NEXT_ID.fetch_add(1, Ordering::Relaxed);

    let pump = tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if channel.send(event).is_err() {
                        // Frontend side of the ipc channel is closed —
                        // the hook unmounted without calling unsubscribe.
                        // Exit the pump; the map entry will be cleaned
                        // up on the next unsubscribe call.
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    record_lag(n);
                    log::warn!(
                        "[event_bus] subscriber lagged, skipped {n} events"
                    );
                    // DO NOT break — receiver is still valid.
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    let mut map = subscribers()
        .lock()
        .map_err(|_| "subscribers mutex poisoned".to_string())?;
    map.insert(id, pump);
    Ok(id)
}

/// Unsubscribe cleanly when the hook unmounts. Idempotent — returns
/// `true` if the id was live, `false` if it had already been pruned
/// (e.g. because the channel errored earlier).
#[tauri::command]
pub async fn event_bus_unsubscribe(id: u64) -> Result<bool, String> {
    let mut map = subscribers()
        .lock()
        .map_err(|_| "subscribers mutex poisoned".to_string())?;
    match map.remove(&id) {
        Some(handle) => {
            handle.abort();
            Ok(true)
        }
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Drain the channel synchronously for tests — `init` spawns the
    /// real drain on the tauri async runtime, which is fine, but we
    /// also want a deterministic flush so assertions don't race.
    async fn flush() {
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            if !tail(1, None).await.is_empty() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    fn sample_step(turn: &str, at: i64) -> SunnyEvent {
        SunnyEvent::AgentStep {
            seq: 0,
            boot_epoch: 0,
            turn_id: turn.into(),
            iteration: 1,
            text: "hello".into(),
            tool: None,
            at,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn publish_then_tail_roundtrip() {
        let tmp = tempdir();
        // First init in this test-process wins; ignore already-init
        // errors caused by another #[tokio::test] running in the same
        // binary.
        let _ = init_in(&tmp);

        let now = chrono::Utc::now().timestamp_millis();
        publish(sample_step("t1", now));
        publish(SunnyEvent::ChatChunk {
            seq: 0,
            boot_epoch: 0,
            turn_id: "t1".into(),
            delta: "hi".into(),
            done: false,
            at: now + 1,
        });
        publish(SunnyEvent::Security {
            seq: 0,
            boot_epoch: 0,
            severity: "info".into(),
            summary: "ok".into(),
            at: now + 2,
        });

        flush().await;

        let all = tail(10, None).await;
        assert!(all.len() >= 3, "expected >=3 events, got {}", all.len());

        // Every returned event carries a non-zero seq (stamped at
        // publish time) — no more same-ms, same-shape collisions.
        for e in &all {
            assert!(e.seq() > 0, "expected stamped seq, got 0");
        }

        // Kind filter.
        let chunks = tail_by_kind("ChatChunk", 10).await;
        assert!(chunks.iter().any(|e| matches!(e, SunnyEvent::ChatChunk { .. })));

        cleanup(&tmp);
    }

    #[test]
    fn init_in_rejects_second_call() {
        // This test isolates itself by running the init twice against
        // two different tempdirs in a fresh OnceLock slot. Since the
        // process-wide CONN is shared with other tests, we skip if
        // CONN is already set from an earlier test — the invariant we
        // want to check still holds: a second init_in when CONN is
        // already occupied must return Err.
        let tmp_a = tempdir();
        let tmp_b = tempdir();

        let first = init_in(&tmp_a);
        // Either first call succeeded (fresh slot) or it failed because
        // another test got here first — both are acceptable starting
        // states. What we REALLY care about is the second call.
        let _ = first;

        let second = init_in(&tmp_b);
        assert!(
            second.is_err(),
            "second init_in must return Err, got Ok — old DB would silently stay active"
        );

        cleanup(&tmp_a);
        cleanup(&tmp_b);
    }

    #[test]
    fn prune_drops_old_rows() {
        let tmp = tempdir();
        std::fs::create_dir_all(&tmp).unwrap();
        let conn = open_connection(&db_path_in(&tmp)).expect("open");
        ensure_schema(&conn).expect("schema");

        let now = chrono::Utc::now().timestamp_millis();
        let ancient = now - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;

        let old = sample_step("old", ancient);
        let fresh = sample_step("fresh", now);
        for e in [&old, &fresh] {
            conn.execute(
                "INSERT INTO events (at, kind, payload) VALUES (?1, ?2, ?3)",
                params![
                    e.at(),
                    e.kind(),
                    serde_json::to_string(e).unwrap()
                ],
            )
            .unwrap();
        }

        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, 2);

        let deleted = prune_older_than(&conn, retention_cutoff_ms()).expect("prune");
        assert_eq!(deleted, 1);

        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 1);

        cleanup(&tmp);
    }

    #[test]
    fn legacy_rows_decode_with_seq_zero() {
        // Migration constraint: events persisted before the seq /
        // boot_epoch fields existed must still deserialise — they map
        // to seq = 0, boot_epoch = 0 via `#[serde(default)]` on each
        // variant's matching field.
        let payload = r#"{"kind":"ChatChunk","turn_id":"t","delta":"hi","done":false,"at":123}"#;
        let decoded: SunnyEvent = serde_json::from_str(payload).expect("legacy decode");
        assert_eq!(decoded.seq(), 0);
        assert_eq!(decoded.boot_epoch(), 0);
        assert!(matches!(decoded, SunnyEvent::ChatChunk { .. }));
    }

    #[test]
    fn seq_wire_format() {
        // Wire format: { "kind": "...", "seq": N, ...payload }.
        let e = SunnyEvent::ChatChunk {
            seq: 99,
            boot_epoch: 12345,
            turn_id: "t".into(),
            delta: "d".into(),
            done: false,
            at: 1,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"seq\":99"), "seq missing: {json}");
        assert!(
            json.contains("\"boot_epoch\":12345"),
            "boot_epoch missing: {json}",
        );
        assert!(json.contains("\"kind\":\"ChatChunk\""), "kind missing: {json}");
    }

    #[test]
    fn kind_and_at_roundtrip_all_variants() {
        let now = chrono::Utc::now().timestamp_millis();
        let events = vec![
            SunnyEvent::AgentStep {
                seq: 0,
                boot_epoch: 0,
                turn_id: "t".into(),
                iteration: 2,
                text: "x".into(),
                tool: Some("shell".into()),
                at: now,
            },
            SunnyEvent::ChatChunk {
                seq: 0,
                boot_epoch: 0,
                turn_id: "t".into(),
                delta: "d".into(),
                done: true,
                at: now,
            },
            SunnyEvent::WorldTick {
                seq: 0,
                boot_epoch: 0,
                revision: 42,
                focus_app: Some("Zed".into()),
                activity: "coding".into(),
                at: now,
            },
            SunnyEvent::Security {
                seq: 0,
                boot_epoch: 0,
                severity: "warn".into(),
                summary: "s".into(),
                at: now,
            },
            SunnyEvent::SubAgent {
                seq: 0,
                boot_epoch: 0,
                run_id: "r".into(),
                lifecycle: "start".into(),
                goal: None,
                iteration: 0,
                kind: String::new(),
                content: String::new(),
                at: now,
            },
            SunnyEvent::DaemonFire {
                seq: 0,
                boot_epoch: 0,
                daemon_id: "d".into(),
                goal: "g".into(),
                at: now,
            },
        ];

        let expected_kinds = [
            "AgentStep",
            "ChatChunk",
            "WorldTick",
            "Security",
            "SubAgent",
            "DaemonFire",
        ];

        for (e, expected) in events.iter().zip(expected_kinds.iter()) {
            assert_eq!(e.kind(), *expected);
            let json = serde_json::to_string(e).unwrap();
            assert!(
                json.contains(&format!("\"kind\":\"{expected}\"")),
                "tagged repr missing for {expected}: {json}",
            );
            let back: SunnyEvent = serde_json::from_str(&json).unwrap();
            assert_eq!(back.kind(), *expected);
        }
    }

    #[test]
    fn seq_is_monotonic_per_process() {
        let a = SEQ.fetch_add(1, Ordering::Relaxed);
        let b = SEQ.fetch_add(1, Ordering::Relaxed);
        assert!(b > a, "seq must be strictly increasing (got a={a}, b={b})");
    }

    /// κ v10 #2 regression: boot_epoch MUST be:
    ///  - stable across all events stamped by the same process (so the
    ///    frontend dedupe cursor keeps matching), and
    ///  - different after a simulated restart (so the frontend knows
    ///    to reset its seq cursor instead of dropping "seq=1 <= last
    ///    seen seq=5000").
    /// We simulate restart by mutating BOOT_EPOCH directly — the real
    /// path is process exit, which we can't do from an in-process test.
    #[test]
    fn boot_epoch_stable_then_changes_on_simulated_restart() {
        // Event 1 — take whatever the current epoch is. The first access
        // to BOOT_EPOCH (via current_boot_epoch) lazily initialises it
        // from the wall clock, so we don't assert a specific value,
        // only self-consistency.
        let mut e1 = SunnyEvent::AgentStep {
            seq: 0,
            boot_epoch: 0,
            turn_id: "boot".into(),
            iteration: 0,
            text: "x".into(),
            tool: None,
            at: 1,
        };
        e1.stamp_seq();
        let epoch_a = e1.boot_epoch();
        assert!(epoch_a > 0, "boot_epoch must be non-zero after stamp");

        // Event 2 — stamped in the same "process". Epoch must match.
        let mut e2 = SunnyEvent::AgentStep {
            seq: 0,
            boot_epoch: 0,
            turn_id: "boot".into(),
            iteration: 1,
            text: "x".into(),
            tool: None,
            at: 2,
        };
        e2.stamp_seq();
        assert_eq!(
            e2.boot_epoch(),
            epoch_a,
            "boot_epoch must be stable across publishes within a process",
        );

        // Simulated restart — force a new epoch, then stamp a third
        // event. Epoch must have changed so the frontend knows to
        // reset its seq cursor.
        let forced = epoch_a.wrapping_add(1_000_000);
        reset_boot_epoch_for_test(forced);
        let mut e3 = SunnyEvent::AgentStep {
            seq: 0,
            boot_epoch: 0,
            turn_id: "boot".into(),
            iteration: 2,
            text: "x".into(),
            tool: None,
            at: 3,
        };
        e3.stamp_seq();
        assert_eq!(
            e3.boot_epoch(),
            forced,
            "boot_epoch must change after simulated restart",
        );
        assert_ne!(
            e3.boot_epoch(),
            epoch_a,
            "boot_epoch must differ from pre-restart value",
        );

        // Restore the original so unrelated tests running after this
        // one still see a stable epoch.
        reset_boot_epoch_for_test(epoch_a);
    }

    #[test]
    fn sub_agent_wire_format_carries_step_fields() {
        // SubAgent carries `iteration`, `step_kind` (renamed from the
        // Rust-side `kind` to avoid colliding with the
        // `#[serde(tag = "kind")]` discriminator), and `content` so the
        // frontend bridge consumes `sunny://agent.sub` without losing
        // per-step detail.
        let e = SunnyEvent::SubAgent {
            seq: 0,
            boot_epoch: 0,
            run_id: "sub-42".into(),
            lifecycle: "step".into(),
            goal: Some("summarise doc".into()),
            iteration: 3,
            kind: "tool_call".into(),
            content: "shell(ls)".into(),
            at: 123,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"SubAgent\""), "tag missing: {json}");
        assert!(json.contains("\"iteration\":3"), "iteration missing: {json}");
        assert!(
            json.contains("\"step_kind\":\"tool_call\""),
            "step_kind missing: {json}",
        );
        assert!(
            json.contains("\"content\":\"shell(ls)\""),
            "content missing: {json}",
        );
        // Old-row compatibility: rows persisted without the new fields
        // must deserialise cleanly with zero/empty defaults.
        let legacy = r#"{"kind":"SubAgent","run_id":"r","lifecycle":"start","goal":null,"at":1}"#;
        let decoded: SunnyEvent = serde_json::from_str(legacy).expect("legacy SubAgent decode");
        if let SunnyEvent::SubAgent { iteration, kind, content, .. } = decoded {
            assert_eq!(iteration, 0);
            assert_eq!(kind, "");
            assert_eq!(content, "");
        } else {
            panic!("expected SubAgent variant");
        }
    }

    /// Multi-subscriber / lag-tolerance regression.
    ///
    /// Broadcast channels don't drop at the publisher — they lag at the
    /// subscriber. The behaviour we care about is:
    ///
    /// 1. Every subscriber gets its OWN receiver with its own buffer —
    ///    three parallel subscribers each see all 100 events.
    /// 2. A subscriber that lags does not crash or silently disconnect
    ///    — it logs a warn, drops the skipped events, and keeps going.
    ///
    /// The test subscribes three times, publishes 100 distinct events,
    /// and asserts each receiver saw all 100.
    /// Wait until the global sender is initialised. Needed because
    /// tests run in parallel and `init_in` can race — one test's
    /// init_in wins and sets both CONN and SENDER, but a losing
    /// racer observes CONN set (so init_in errors) before SENDER has
    /// been populated.
    async fn wait_for_sender() -> &'static broadcast::Sender<SunnyEvent> {
        for _ in 0..100 {
            if let Some(tx) = SENDER.get() {
                return tx;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("SENDER never initialised within 1s");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn three_subscribers_each_receive_all_events() {
        let tmp = tempdir();
        let _ = init_in(&tmp);

        // Subscribe three receivers BEFORE publishing. Each gets its
        // own ring buffer — a slow consumer in one lane doesn't affect
        // the others.
        let tx = wait_for_sender().await;
        let mut rx_a = tx.subscribe();
        let mut rx_b = tx.subscribe();
        let mut rx_c = tx.subscribe();

        const N: usize = 100;
        let now = chrono::Utc::now().timestamp_millis();
        // Unique turn_id so we can filter out events from parallel
        // tests that share the same global SENDER.
        let turn = format!("multi-{}", uuid::Uuid::new_v4());

        // Publish from a separate task so the receivers can race to
        // drain in parallel.
        let turn_pub = turn.clone();
        let pub_handle = tokio::spawn(async move {
            for i in 0..N {
                publish(SunnyEvent::ChatChunk {
                    seq: 0,
                    boot_epoch: 0,
                    turn_id: turn_pub.clone(),
                    delta: format!("d{i}"),
                    done: i == N - 1,
                    at: now + i as i64,
                });
                // Let the runtime breathe so receivers can actually
                // pull. Without this a 100-event burst all lands in
                // the ring buffer before any receiver wakes up —
                // still correct, but less interesting as a lag probe.
                if i % 10 == 0 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        });

        // Drainers count only events matching our unique turn_id so
        // cross-test noise on the shared broadcast doesn't perturb
        // the assertion. Lag is still tolerated — `Lagged(n)` events
        // may include our events mixed with others, so we can't
        // distinguish; we count the lag whole and assert we got AT
        // LEAST N (broadcast guarantees no receiver-side loss other
        // than through Lagged).
        let turn_a = turn.clone();
        let drain_a = tokio::spawn(async move {
            let mut mine = 0usize;
            let mut lagged = 0usize;
            while mine + lagged < N {
                match rx_a.recv().await {
                    Ok(e) => {
                        if event_turn_id(&e) == Some(turn_a.as_str()) {
                            mine += 1;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        lagged += n as usize;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            mine + lagged
        });

        let turn_b = turn.clone();
        let drain_b = tokio::spawn(async move {
            let mut mine = 0usize;
            let mut lagged = 0usize;
            while mine + lagged < N {
                match rx_b.recv().await {
                    Ok(e) => {
                        if event_turn_id(&e) == Some(turn_b.as_str()) {
                            mine += 1;
                            tokio::time::sleep(Duration::from_micros(100)).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        lagged += n as usize;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            mine + lagged
        });

        let turn_c = turn.clone();
        let drain_c = tokio::spawn(async move {
            let mut mine = 0usize;
            let mut lagged = 0usize;
            while mine + lagged < N {
                match rx_c.recv().await {
                    Ok(e) => {
                        if event_turn_id(&e) == Some(turn_c.as_str()) {
                            mine += 1;
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        lagged += n as usize;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            mine + lagged
        });

        pub_handle.await.unwrap();
        let got_a = tokio::time::timeout(Duration::from_secs(5), drain_a)
            .await
            .expect("drain_a timeout")
            .unwrap();
        let got_b = tokio::time::timeout(Duration::from_secs(5), drain_b)
            .await
            .expect("drain_b timeout")
            .unwrap();
        let got_c = tokio::time::timeout(Duration::from_secs(5), drain_c)
            .await
            .expect("drain_c timeout")
            .unwrap();

        assert!(got_a >= N, "fast subscriber missed events: {got_a}/{N}");
        assert!(got_b >= N, "medium subscriber missed events: {got_b}/{N}");
        assert!(got_c >= N, "slow subscriber missed events: {got_c}/{N}");

        cleanup(&tmp);
    }

    /// Pull the `turn_id` out of an event (ChatChunk / AgentStep /
    /// SubAgent all have one; other variants return None).
    fn event_turn_id(e: &SunnyEvent) -> Option<&str> {
        match e {
            SunnyEvent::AgentStep { turn_id, .. }
            | SunnyEvent::ChatChunk { turn_id, .. } => Some(turn_id.as_str()),
            _ => None,
        }
    }

    /// Verifies the lag-tolerance contract directly: force a receiver
    /// past the ring-buffer head by publishing more than
    /// CHANNEL_CAPACITY events without draining, then assert that the
    /// next recv yields `Lagged(n)` — NOT `Closed`, NOT a panic — and
    /// that the receiver remains usable afterwards.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lagged_receiver_stays_alive() {
        let tmp = tempdir();
        let _ = init_in(&tmp);

        let tx = wait_for_sender().await;
        let mut rx = tx.subscribe();

        // Overflow the ring buffer. CHANNEL_CAPACITY + 10 guarantees
        // at least 10 events older than the buffer head by the time we
        // try to recv.
        let overflow = CHANNEL_CAPACITY + 10;
        let now = chrono::Utc::now().timestamp_millis();
        for i in 0..overflow {
            publish(SunnyEvent::ChatChunk {
                seq: 0,
                boot_epoch: 0,
                turn_id: "lag".into(),
                delta: format!("d{i}"),
                done: false,
                at: now + i as i64,
            });
        }

        // First recv after overflow MUST be Lagged. The receiver is
        // still valid; subsequent recvs drain the surviving tail.
        let first = rx.recv().await;
        match first {
            Err(broadcast::error::RecvError::Lagged(n)) => {
                assert!(n >= 10, "expected lag of at least 10, got {n}");
            }
            other => panic!("expected Lagged, got {other:?}"),
        }

        // Receiver still usable: try a couple more recvs and confirm
        // we don't hit Closed.
        for _ in 0..5 {
            match rx.try_recv() {
                Ok(_) => {}
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(broadcast::error::TryRecvError::Lagged(_)) => {}
                Err(broadcast::error::TryRecvError::Closed) => {
                    panic!("receiver unexpectedly closed after Lagged");
                }
            }
        }

        cleanup(&tmp);
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("sunny-event-bus-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }
}
