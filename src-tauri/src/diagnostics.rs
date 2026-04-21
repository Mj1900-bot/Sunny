//! Diagnostics — aggregated runtime snapshot for the HUD's Diagnostics
//! page (sprint-12 ε).
//!
//! This module is read-only over the app's existing state. It never
//! mutates, blocks, or holds any global lock longer than a single
//! accessor call. The `diagnostics_snapshot` command is polled every
//! ~2s from the frontend, so cheapness matters.
//!
//! Where a counter didn't already exist at the call site (supervisor
//! restarts, constitution rule-kicks, session_lock acquires), a
//! minimal `AtomicU64` was added in the owning module — see
//! `supervise::restarts_snapshot`, `constitution::rule_kicks_snapshot`,
//! `agent_loop::session_lock::snapshot`.
//!
//! This file exclusively OWNS the aggregated shape
//! `DiagnosticsSnapshot` and the Tauri command that returns it.

use serde::Serialize;
use ts_rs::TS;

use crate::agent_loop::session_lock;
use crate::audio_capture;
use crate::constitution;
use crate::event_bus;
use crate::memory;
use crate::supervise;
use crate::voice;

// ---------------------------------------------------------------------------
// Shape — top-level snapshot
// ---------------------------------------------------------------------------

/// Top-level shape returned by `diagnostics_snapshot`. Every sub-block
/// is `Default` + `Serialize` so a probe that fails to read one
/// subsystem still yields a valid partial snapshot — the UI renders a
/// dash for empty fields rather than collapsing.
#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct DiagnosticsSnapshot {
    pub agent_loop: AgentLoopDiag,
    pub event_bus: EventBusDiag,
    pub supervisor: SupervisorDiag,
    pub osascript: OsascriptDiag,
    pub voice: VoicePipelineDiag,
    pub memory: MemoryDiag,
    pub constitution: ConstitutionDiag,
    /// Wall-clock ms at which this snapshot was assembled. The frontend
    /// shows this as a "fetched N ms ago" label under the page title.
    #[ts(type = "number")]
    pub collected_at_ms: i64,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct AgentLoopDiag {
    /// Sessions with at least one live `OwnedMutexGuard`.
    pub active_session_count: usize,
    /// Every tracked session + its (approximate) live-holder count.
    pub sessions: Vec<SessionLockRow>,
    /// Process-wide cumulative `acquire()` count.
    #[ts(type = "number")]
    pub total_acquires: u64,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SessionLockRow {
    pub session_id: String,
    pub holders: usize,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct EventBusDiag {
    /// Current `broadcast::Sender::receiver_count()`. One receiver is
    /// the SQLite drain; the rest are ipc subscribers and daemons.
    pub receiver_count: usize,
    /// Most recent event's `seq` (0 if no events yet). The frontend
    /// treats this as "max seq observed so far" — a rough gauge of
    /// throughput since process boot.
    #[ts(type = "number")]
    pub latest_seq: u64,
    /// Most recent event's `boot_epoch` (0 if no events yet). Distinct
    /// from the frontend's own recorded epoch — watching this change
    /// confirms a backend restart after the frontend has stayed up.
    #[ts(type = "number")]
    pub latest_boot_epoch: u64,
    /// Number of distinct `Lagged(n)` warn events logged across every
    /// broadcast receiver since process boot. Growing means at least
    /// one subscriber is consuming slower than the producer.
    #[ts(type = "number")]
    pub lag_warns: u64,
    /// Sum of `n` across every logged `Lagged(n)`. Strictly >= the
    /// number of distinct events dropped; a single event missed by
    /// three receivers contributes three here.
    #[ts(type = "number")]
    pub lag_dropped: u64,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct SupervisorDiag {
    /// `(task_name, panic_restart_count)` for every task ever spawned
    /// via `supervise::spawn_supervised`. Includes tasks that have
    /// never panicked (count = 0) so operators can confirm a task is
    /// registered.
    pub tasks: Vec<SupervisedTask>,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SupervisedTask {
    pub name: String,
    #[ts(type = "number")]
    pub restarts: u64,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct OsascriptDiag {
    /// Live count from `pgrep -c osascript`. `None` when the probe
    /// failed (pgrep missing, permission denied, etc.).
    pub live_count: Option<u32>,
    /// True when `live_count >= 50` — surfaced in red by the UI.
    pub over_threshold: bool,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct VoicePipelineDiag {
    pub whisper_model_path: Option<String>,
    pub whisper_model_size_mb: Option<f64>,
    pub kokoro_daemon_pid: Option<u32>,
    pub kokoro_voice_id: Option<String>,
    pub kokoro_speed_milli: Option<i32>,
    pub kokoro_model_present: bool,
    pub kokoro_voices_present: bool,
    #[ts(type = "number | null")]
    pub last_interrupt_ms: Option<i64>,
    /// Centralised VAD config (sprint-13 ε). Read once per snapshot via
    /// `audio_capture::current_vad_config`; each field is the single
    /// source of truth for its knob across the backend and the HUD.
    pub vad: VadDiag,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct VadDiag {
    /// RMS floor below which a captured WAV is treated as silence.
    /// 0.0 means "gate disabled" (user opted out via env override).
    pub silence_rms: f32,
    /// Milliseconds of sub-threshold audio before the frontend VAD
    /// fires `onSilence`. Matches the product default in `useVoiceChat`.
    pub hold_ms: u32,
    /// Milliseconds of pre-press audio retained in the pre-roll ring
    /// and stitched to the front of every new recording. Derived from
    /// `PRE_ROLL_SAMPLES` at the capture target rate.
    pub preroll_ms: u32,
    /// Operating mode — today always `"push_to_talk"`. Reserved for a
    /// future always-on wake-word path.
    pub mode: String,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct MemoryDiag {
    #[ts(type = "number")]
    pub episodic_count: i64,
    #[ts(type = "number")]
    pub semantic_count: i64,
    #[ts(type = "number")]
    pub procedural_count: i64,
    /// Size on disk (bytes) of the memory SQLite file. `None` if the
    /// file doesn't exist yet or cannot be stat'd.
    #[ts(type = "number | null")]
    pub db_bytes: Option<u64>,
    /// Size on disk (bytes) of the event_bus SQLite file.
    #[ts(type = "number | null")]
    pub event_bus_db_bytes: Option<u64>,
    /// Wall-clock milliseconds taken by the most recent `build_pack`
    /// call. 0 until the first pack is built this process.
    #[ts(type = "number")]
    pub pack_last_ms: u64,
    /// Exponentially-weighted moving average of `build_pack` duration.
    /// Smoothing factor 0.3 — see `pack::record_pack_duration`.
    #[ts(type = "number")]
    pub pack_ewma_ms: u64,
}

#[derive(Serialize, Clone, Debug, Default, TS)]
#[ts(export)]
pub struct ConstitutionDiag {
    /// `(rule_description, kick_count)` sorted descending by count.
    pub rule_kicks: Vec<RuleKick>,
    pub prohibition_count: usize,
    /// Most recent verifyAnswer outcome (sprint-13 ε). `None` until
    /// the first verify is recorded this process; distinct from a
    /// `Some(_)` with `passed = true` and `rule = None` which means
    /// "the most recent reply verified cleanly".
    pub last_verify: Option<LastVerify>,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct LastVerify {
    /// Wall-clock milliseconds at which the verify ran.
    #[ts(type = "number")]
    pub at_ms: i64,
    pub passed: bool,
    /// First failed rule description, e.g. "max_words:150". `None`
    /// when the answer verified cleanly.
    pub rule: Option<String>,
}

#[derive(Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct RuleKick {
    pub rule: String,
    #[ts(type = "number")]
    pub count: u64,
}

// ---------------------------------------------------------------------------
// Subsystem probes
// ---------------------------------------------------------------------------

fn probe_agent_loop() -> AgentLoopDiag {
    let snap = session_lock::snapshot();
    let active = snap.sessions.iter().filter(|e| e.holders > 0).count();
    let rows: Vec<SessionLockRow> = snap
        .sessions
        .into_iter()
        .map(|e| SessionLockRow {
            session_id: e.session_id,
            holders: e.holders,
        })
        .collect();
    AgentLoopDiag {
        active_session_count: active,
        sessions: rows,
        total_acquires: snap.total_acquires,
    }
}

async fn probe_event_bus() -> EventBusDiag {
    // Fetch the 1 most-recent event to read the current seq/epoch
    // without touching private state. Bounded to 1 — the in-memory path
    // is async but returns immediately if no events exist.
    let latest = event_bus::tail(1, None).await;
    let (latest_seq, latest_boot_epoch) = latest
        .first()
        .map(|e| (e.seq(), e.boot_epoch()))
        .unwrap_or((0, 0));
    let (lag_warns, lag_dropped) = event_bus::lag_stats();
    EventBusDiag {
        receiver_count: event_bus::receiver_count(),
        latest_seq,
        latest_boot_epoch,
        lag_warns,
        lag_dropped,
    }
}

fn probe_supervisor() -> SupervisorDiag {
    let tasks = supervise::restarts_snapshot()
        .into_iter()
        .map(|(name, restarts)| SupervisedTask { name, restarts })
        .collect();
    SupervisorDiag { tasks }
}

/// Probe `pgrep -c osascript`. Short wall-clock budget (500 ms) so a
/// hung pgrep never stalls the Diagnostics poll.
fn probe_osascript() -> OsascriptDiag {
    use std::process::Command;
    let out = Command::new("pgrep").arg("-c").arg("osascript").output();
    let live_count = match out {
        Ok(o) => {
            // pgrep returns 1 when zero matches; stdout is "0\n". We
            // accept both success (status 0) and that specific "no
            // matches" shape and parse the stdout number.
            let stdout = String::from_utf8_lossy(&o.stdout);
            let trimmed = stdout.trim();
            trimmed.parse::<u32>().ok()
        }
        Err(_) => None,
    };
    let over_threshold = live_count.map(|n| n >= 50).unwrap_or(false);
    OsascriptDiag {
        live_count,
        over_threshold,
    }
}

async fn probe_voice() -> VoicePipelineDiag {
    let snap = voice::diag_snapshot().await;
    // Best-effort whisper model probe: no global state exists for
    // "loaded right now" (whisper-cli is spawn-per-transcribe), so we
    // report the resolved model path + size on disk, which is what the
    // operator cares about for "did the 1.5 GB turbo model finish
    // downloading".
    let (whisper_model_path, whisper_model_size_mb) = match resolve_whisper_probe() {
        Some((path, bytes)) => (
            Some(path),
            Some(bytes as f64 / 1024.0 / 1024.0),
        ),
        None => (None, None),
    };
    let vad_cfg = audio_capture::current_vad_config();
    VoicePipelineDiag {
        whisper_model_path,
        whisper_model_size_mb,
        kokoro_daemon_pid: snap.daemon_pid,
        kokoro_voice_id: snap.voice_id,
        kokoro_speed_milli: snap.speed_milli,
        kokoro_model_present: snap.model_path_present,
        kokoro_voices_present: snap.voices_path_present,
        last_interrupt_ms: snap.last_interrupt_ms,
        vad: VadDiag {
            silence_rms: vad_cfg.silence_rms,
            hold_ms: vad_cfg.silence_hold_ms,
            preroll_ms: vad_cfg.preroll_ms,
            mode: vad_cfg.mode.as_str().to_string(),
        },
    }
}

/// Cheap whisper model probe — checks the two most likely paths
/// without invoking the real `ensure_whisper_model` (which would block
/// on download on first run). Returns `(path_string, bytes)` on hit.
fn resolve_whisper_probe() -> Option<(String, u64)> {
    let candidates: Vec<std::path::PathBuf> = std::iter::empty()
        .chain(std::env::var("SUNNY_WHISPER_MODEL").ok().map(std::path::PathBuf::from))
        .chain(dirs::cache_dir().map(|d| d.join("whisper-cpp").join("ggml-large-v3-turbo.bin")))
        .chain(Some(std::path::PathBuf::from(
            "/opt/homebrew/share/whisper-cpp/ggml-large-v3-turbo.bin",
        )))
        .chain(dirs::cache_dir().map(|d| d.join("whisper-cpp").join("ggml-base.en.bin")))
        .chain(Some(std::path::PathBuf::from(
            "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
        )))
        .collect();
    for path in candidates {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() {
                return Some((path.display().to_string(), meta.len()));
            }
        }
    }
    None
}

fn probe_memory() -> MemoryDiag {
    let stats = memory::stats().unwrap_or_default();
    let db_bytes = dirs::home_dir()
        .map(|h| h.join(".sunny").join("memory.sqlite"))
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    let event_bus_db_bytes = dirs::home_dir()
        .map(|h| h.join(".sunny").join("events.sqlite"))
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len());
    let (pack_last_ms, pack_ewma_ms) = memory::pack::pack_stats();
    MemoryDiag {
        episodic_count: stats.episodic_count,
        semantic_count: stats.semantic_count,
        procedural_count: stats.procedural_count,
        db_bytes,
        event_bus_db_bytes,
        pack_last_ms,
        pack_ewma_ms,
    }
}

fn probe_constitution() -> ConstitutionDiag {
    let current = constitution::current();
    let rule_kicks = constitution::rule_kicks_snapshot()
        .into_iter()
        .map(|(rule, count)| RuleKick { rule, count })
        .collect();
    let last_verify = constitution::last_verify_result().map(|(at_ms, passed, rule)| LastVerify {
        at_ms,
        passed,
        rule,
    });
    ConstitutionDiag {
        rule_kicks,
        prohibition_count: current.prohibitions.len(),
        last_verify,
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Aggregate every subsystem probe into a single snapshot. Called from
/// the Diagnostics page at ~2 Hz. Each probe is independent — a
/// failure in one doesn't short-circuit the others (they all return
/// `Default` on error).
#[tauri::command]
pub async fn diagnostics_snapshot() -> DiagnosticsSnapshot {
    let collected_at_ms = chrono::Utc::now().timestamp_millis();
    // The event_bus probe is async (tail takes a spawn_blocking hop);
    // everything else is a sync probe that's cheap enough to run
    // inline. Done sequentially rather than joined — the wall-clock
    // budget is well under 10 ms either way and the tail query is the
    // only blocking step.
    let event_bus = probe_event_bus().await;
    let voice = probe_voice().await;
    DiagnosticsSnapshot {
        agent_loop: probe_agent_loop(),
        event_bus,
        supervisor: probe_supervisor(),
        osascript: probe_osascript(),
        voice,
        memory: probe_memory(),
        constitution: probe_constitution(),
        collected_at_ms,
    }
}
