//! Persistent task scheduler.
//!
//! Jobs live in `~/.sunny/scheduler.json` (atomic write, 0600) so they survive
//! relaunches. A single tokio task ticks every 10s, picks up any jobs whose
//! `next_run` has elapsed, runs them with the inherited fat PATH, and
//! rewrites `next_run`/`last_run`/`last_output`/`last_error`.
//!
//! Four action types: shell (zsh -lc), notify (osascript display notification),
//! speak (macOS `say`), agent_goal (routes a goal string through the
//! tool-using ollama agent loop and optionally speaks / notes the answer).
//! Matches the existing voice::speak signature so the scheduler can reuse the
//! same British-voice defaults.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

use tauri::AppHandle;

const DIR_NAME: &str = ".sunny";
const FILE_NAME: &str = "scheduler.json";
const OUTPUT_TRUNCATE: usize = 512;
const TICK_SECS: u64 = 10;

// -------------------- data model --------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum JobKind {
    Once,
    Interval,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(tag = "type", content = "data")]
#[ts(export)]
pub enum JobAction {
    Shell { cmd: String },
    Notify { title: String, body: String },
    Speak {
        text: String,
        voice: Option<String>,
        rate: Option<u32>,
    },
    /// Route a goal through the tool-using ollama agent loop. When the loop
    /// returns, optionally speak the answer via `voice::speak` and/or write
    /// it to a new Apple Notes note titled `write_note`.
    AgentGoal {
        goal: String,
        #[serde(default)]
        speak_answer: bool,
        #[serde(default)]
        write_note: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct Job {
    pub id: String,
    pub title: String,
    pub kind: JobKind,
    #[ts(type = "number | null")]
    pub at: Option<i64>,
    #[ts(type = "number | null")]
    pub every_sec: Option<u64>,
    pub action: JobAction,
    pub enabled: bool,
    #[ts(type = "number | null")]
    pub last_run: Option<i64>,
    #[ts(type = "number | null")]
    pub next_run: Option<i64>,
    pub last_error: Option<String>,
    pub last_output: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

// -------------------- paths / persistence --------------------

fn scheduler_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve $HOME".to_string())?;
    Ok(home.join(DIR_NAME))
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn load_from(dir: &Path) -> Result<Vec<Job>, String> {
    let path = dir.join(FILE_NAME);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read scheduler: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Vec<Job>>(&raw) {
        Ok(jobs) => Ok(jobs),
        Err(e) => {
            // Self-heal instead of locking the user out of the scheduler
            // forever. Happens when the on-disk schema drifts from the
            // running binary (eg a newer dev build added a JobAction variant
            // that an older release build doesn't know about). Quarantine
            // the bad file so we preserve it for debugging, then continue
            // with an empty list — the caller will re-seed defaults.
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let quarantine = dir.join(format!("{FILE_NAME}.bad.{nanos}"));
            let quarantine_note = match fs::rename(&path, &quarantine) {
                Ok(()) => format!(" (quarantined to {})", quarantine.display()),
                Err(re) => format!(" (quarantine failed: {re})"),
            };
            log::warn!("scheduler: discarding unparseable {FILE_NAME}: {e}{quarantine_note}");
            Ok(Vec::new())
        }
    }
}

static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Atomic write mirroring settings.rs: unique tmp name, 0600, rename.
fn save_to(dir: &Path, jobs: &[Job]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create scheduler dir: {e}"))?;

    let final_path = dir.join(FILE_NAME);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = dir.join(format!("{FILE_NAME}.tmp.{pid}.{nanos}.{counter}"));

    let serialized =
        serde_json::to_string_pretty(jobs).map_err(|e| format!("serialize scheduler: {e}"))?;

    let write_result = (|| -> Result<(), String> {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync: {e}"))?;
        set_owner_only(&tmp_path)?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename scheduler: {e}")
    })?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let perms = fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms).map_err(|e| format!("chmod scheduler: {e}"))
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
}

// Coarse global lock for reads/writes; the scheduler is IO-light (mostly once
// per 10s tick) and this keeps concurrent command invocations from racing.
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn load_jobs() -> Result<Vec<Job>, String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    load_from(&scheduler_dir()?)
}

fn save_jobs(jobs: &[Job]) -> Result<(), String> {
    let _g = FILE_LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    save_to(&scheduler_dir()?, jobs)
}

// -------------------- default seeding --------------------

const DEFAULT_MORNING_BRIEF_ID: &str = "default-morning-brief";

/// Next 8:00:00 local time strictly after `now` (local). Falls back to
/// `now + 86400` if the chrono conversion fails (DST transition corner
/// cases, non-existent wall time, etc).
fn next_local_8am_unix() -> i64 {
    use chrono::{Datelike, Duration, Local, TimeZone, Timelike};
    let now_local = Local::now();
    // Candidate: today at 08:00 local.
    let today_8am = Local
        .with_ymd_and_hms(now_local.year(), now_local.month(), now_local.day(), 8, 0, 0)
        .single();
    match today_8am {
        Some(dt) => {
            let target = if now_local.hour() < 8 || (now_local.hour() == 8 && now_local.minute() == 0 && now_local.second() == 0) {
                // If we're before 8am today, fire today. If we're exactly at
                // 08:00:00 the interval job will reschedule to tomorrow on
                // its own after firing.
                if now_local < dt { dt } else { dt + Duration::days(1) }
            } else {
                dt + Duration::days(1)
            };
            target.timestamp()
        }
        None => now_unix() + 86_400,
    }
}

fn morning_brief_job(now: i64) -> Job {
    let goal = "It's morning. Call mail_unread_count, calendar_today, and \
                weather_current for Sunny's city (look up the location via \
                memory_recall if you don't have it, otherwise default to \
                Vancouver). Combine into a single spoken brief under 4 \
                sentences. Start with 'Morning, Sunny' and end with 'Have \
                a good day.'"
        .to_string();
    Job {
        id: DEFAULT_MORNING_BRIEF_ID.to_string(),
        title: "Morning brief".to_string(),
        kind: JobKind::Interval,
        at: None,
        every_sec: Some(86_400),
        action: JobAction::AgentGoal {
            goal,
            speak_answer: true,
            write_note: None,
        },
        enabled: false,
        last_run: None,
        next_run: Some(next_local_8am_unix()),
        last_error: None,
        last_output: None,
        created_at: now,
    }
}

/// Seed a default morning-brief job the first time the scheduler runs
/// against a fresh ~/.sunny. Only writes when the file is missing or the
/// stored list is empty — we never clobber user data.
fn seed_default_jobs_if_empty() -> Result<(), String> {
    let existing = load_jobs()?;
    if !existing.is_empty() {
        return Ok(());
    }
    let defaults = vec![morning_brief_job(now_unix())];
    save_jobs(&defaults)
}

// -------------------- id + scheduling --------------------

/// 16 lowercase hex chars sourced from nanos + a process counter. Not
/// cryptographic — jobs are local-only and ids just need to be unique within
/// one user's ~/.sunny.
fn new_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Mix nanos (high entropy) with pid+seq (uniqueness) into a single u64.
    let mixed = nanos ^ ((std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        ^ seq.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    format!("{mixed:016x}")
}

/// Compute the next fire time for a job given `now`. Returns None for Once
/// jobs that have already run (caller disables them), or Interval jobs without
/// an every_sec configured.
pub fn compute_next_run(job: &Job, now: i64) -> Option<i64> {
    match job.kind {
        JobKind::Once => {
            if job.last_run.is_some() {
                None
            } else {
                job.at.map(|t| t.max(now))
            }
        }
        JobKind::Interval => {
            let every = job.every_sec?;
            if every == 0 {
                return None;
            }
            let base = job.last_run.or(job.at).unwrap_or(now);
            let mut next = base + every as i64;
            // If we're way behind (eg laptop was asleep), skip forward rather
            // than replay every missed tick.
            if next < now {
                next = now;
            }
            Some(next)
        }
    }
}

// -------------------- execution --------------------

fn truncate_output(s: &str) -> String {
    if s.chars().count() <= OUTPUT_TRUNCATE {
        return s.to_string();
    }
    let cut: String = s.chars().take(OUTPUT_TRUNCATE).collect();
    format!("{cut}…")
}

fn escape_applescript_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Run an action and return (stdout_summary, error). On success error is None.
async fn run_action(action: &JobAction, app: &AppHandle) -> (Option<String>, Option<String>) {
    use tokio::process::Command;

    match action {
        JobAction::Shell { cmd } => {
            let mut c = Command::new("/bin/zsh");
            c.arg("-lc").arg(cmd);
            if let Some(p) = crate::paths::fat_path() {
                c.env("PATH", p);
            }
            match c.output().await {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                    let combined = if stderr.is_empty() {
                        stdout
                    } else {
                        format!("{stdout}\n[stderr]\n{stderr}")
                    };
                    if out.status.success() {
                        (Some(truncate_output(&combined)), None)
                    } else {
                        let code = out.status.code().unwrap_or(-1);
                        (
                            Some(truncate_output(&combined)),
                            Some(format!("exit {code}")),
                        )
                    }
                }
                Err(e) => (None, Some(format!("spawn: {e}"))),
            }
        }
        JobAction::Notify { title, body } => {
            let script = format!(
                "display notification \"{}\" with title \"{}\"",
                escape_applescript_string(body),
                escape_applescript_string(title),
            );
            let mut c = Command::new("osascript");
            c.arg("-e").arg(&script);
            if let Some(p) = crate::paths::fat_path() {
                c.env("PATH", p);
            }
            match c.output().await {
                Ok(out) if out.status.success() => (Some("notified".to_string()), None),
                Ok(out) => {
                    let err = String::from_utf8_lossy(&out.stderr).into_owned();
                    (None, Some(truncate_output(&err)))
                }
                Err(e) => (None, Some(format!("osascript: {e}"))),
            }
        }
        JobAction::Speak { text, voice, rate } => {
            // Acquire a spawn permit BEFORE launching `say`. Under runaway
            // daemon conditions this is the call that was leaking zombies —
            // the previous code dropped the Child without ever waiting on
            // it (tokio issue #2685), and on a loop that was enough to
            // saturate the uid process table.
            let _guard = match crate::process_budget::SpawnGuard::acquire().await {
                Ok(g) => g,
                Err(e) => return (None, Some(format!("say: {e}"))),
            };
            let v = voice.clone().unwrap_or_else(|| "Daniel".to_string());
            let r = rate.unwrap_or(180);
            let mut c = Command::new("say");
            c.arg("-v").arg(&v).arg("-r").arg(r.to_string()).arg(text);
            if let Some(p) = crate::paths::fat_path() {
                c.env("PATH", p);
            }
            // `kill_on_drop` closes the loophole if the future is cancelled
            // mid-flight: without it, a cancelled say call leaves an
            // orphan subprocess that counts against the process table
            // until launchd reaps it.
            c.kill_on_drop(true);
            match c.spawn() {
                Ok(mut child) => {
                    // Actually reap the child so its slot in the process
                    // table is returned. We don't block the scheduler on
                    // speech finishing — spawn a detached waiter that
                    // only exists to call `wait()`.
                    tokio::spawn(async move {
                        let _ = child.wait().await;
                    });
                    (Some(format!("speak ({v})")), None)
                }
                Err(e) => (None, Some(format!("say: {e}"))),
            }
        }
        JobAction::AgentGoal {
            goal,
            speak_answer,
            write_note,
        } => {
            // Build a one-shot ChatRequest pinned to the ollama provider so
            // the tool-using agent loop handles it (no streaming UI consumer
            // here — the answer comes back as the return value).
            let req = crate::ai::ChatRequest {
                message: goal.clone(),
                model: None,
                provider: Some("ollama".to_string()),
                history: Vec::new(),
                session_id: None,
                chat_mode: None,
            };

            match crate::agent_loop::agent_run(app.clone(), req).await {
                Ok(answer) => {
                    let mut side_effects: Vec<String> = Vec::new();

                    if *speak_answer {
                        if let Err(e) = crate::voice::speak(answer.clone(), None, None).await {
                            log::warn!("[scheduler] agent_goal speak failed: {e}");
                        } else {
                            side_effects.push("spoke".to_string());
                        }
                    }

                    if let Some(title) = write_note.as_ref().filter(|t| !t.trim().is_empty()) {
                        match crate::notes_app::create_note(
                            title.clone(),
                            answer.clone(),
                            None,
                        )
                        .await
                        {
                            Ok(_) => side_effects.push(format!("noted {title:?}")),
                            Err(e) => {
                                log::warn!("[scheduler] agent_goal write_note failed: {e}")
                            }
                        }
                    }

                    let tag = if side_effects.is_empty() {
                        "agent_goal".to_string()
                    } else {
                        format!("agent_goal [{}]", side_effects.join(", "))
                    };
                    log::info!("[scheduler] agent_goal ok: {tag}");
                    (Some(truncate_output(&format!("{tag}: {answer}"))), None)
                }
                Err(e) => {
                    log::info!("[scheduler] agent_goal err: {e}");
                    (None, Some(truncate_output(&format!("agent_goal: {e}"))))
                }
            }
        }
    }
}

// -------------------- public async API --------------------

pub async fn scheduler_list() -> Result<Vec<Job>, String> {
    tokio::task::spawn_blocking(load_jobs)
        .await
        .map_err(|e| format!("join: {e}"))?
}

pub async fn scheduler_add(
    title: String,
    kind: String,
    at: Option<i64>,
    every_sec: Option<u64>,
    action: Value,
) -> Result<Job, String> {
    let kind = parse_kind(&kind)?;
    let action: JobAction =
        serde_json::from_value(action).map_err(|e| format!("invalid action: {e}"))?;

    // Per-kind sanity checks.
    match kind {
        JobKind::Once => {
            if at.is_none() {
                return Err("once job requires `at` (unix seconds)".into());
            }
        }
        JobKind::Interval => {
            let e = every_sec.ok_or("interval job requires `every_sec`")?;
            if e == 0 {
                return Err("interval `every_sec` must be > 0".into());
            }
        }
    }

    let now = now_unix();
    let mut job = Job {
        id: new_id(),
        title,
        kind,
        at,
        every_sec,
        action,
        enabled: true,
        last_run: None,
        next_run: None,
        last_error: None,
        last_output: None,
        created_at: now,
    };
    job.next_run = compute_next_run(&job, now);

    tokio::task::spawn_blocking(move || -> Result<Job, String> {
        let mut jobs = load_jobs()?;
        jobs.push(job.clone());
        save_jobs(&jobs)?;
        Ok(job)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub async fn scheduler_update(id: String, patch: Value) -> Result<Job, String> {
    tokio::task::spawn_blocking(move || -> Result<Job, String> {
        let mut jobs = load_jobs()?;
        let idx = jobs
            .iter()
            .position(|j| j.id == id)
            .ok_or_else(|| format!("job {id} not found"))?;

        // Immutable merge: serialize existing -> merge patch object -> deserialize.
        // Fields reserved for internal / runner use are excluded so the UI
        // cannot forge run history, inject fake errors, or backdating last_run.
        // Trust boundary: only the runner tick and scheduler_backdate_last_run
        // (called by scheduler_install_template) may write these fields.
        const IMMUTABLE_FIELDS: &[&str] = &[
            "id",
            "created_at",
            "last_run",
            "last_error",
            "last_output",
        ];
        let current =
            serde_json::to_value(&jobs[idx]).map_err(|e| format!("serialize job: {e}"))?;
        let mut merged = current;
        let patch_obj = patch
            .as_object()
            .ok_or_else(|| "patch must be an object".to_string())?;
        if let Some(obj) = merged.as_object_mut() {
            for (k, v) in patch_obj {
                if IMMUTABLE_FIELDS.contains(&k.as_str()) {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
        let mut updated: Job =
            serde_json::from_value(merged).map_err(|e| format!("patch shape: {e}"))?;

        // Recompute next_run if scheduling inputs changed.
        updated.next_run = if updated.enabled {
            compute_next_run(&updated, now_unix())
        } else {
            None
        };

        jobs[idx] = updated.clone();
        save_jobs(&jobs)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Internal-only: set `last_run` for a newly-installed job so `compute_next_run`
/// yields the desired wall-clock first-fire.  Called exclusively by
/// `scheduler_install_template` — not exposed as a Tauri command.
///
/// This bypasses the UI-facing `scheduler_update` exclusion list intentionally;
/// that list exists to prevent *users* from forging run history.  Template
/// installation is a trusted, server-side code path.
pub async fn scheduler_backdate_last_run(id: String, last_run: i64) -> Result<Job, String> {
    tokio::task::spawn_blocking(move || -> Result<Job, String> {
        let mut jobs = load_jobs()?;
        let idx = jobs
            .iter()
            .position(|j| j.id == id)
            .ok_or_else(|| format!("job {id} not found"))?;
        let now = now_unix();
        let mut updated = jobs[idx].clone();
        updated.last_run = Some(last_run);
        updated.next_run = if updated.enabled {
            compute_next_run(&updated, now)
        } else {
            None
        };
        jobs[idx] = updated.clone();
        save_jobs(&jobs)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub async fn scheduler_delete(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let jobs = load_jobs()?;
        let before = jobs.len();
        let kept: Vec<Job> = jobs.into_iter().filter(|j| j.id != id).collect();
        if kept.len() == before {
            return Err(format!("job {id} not found"));
        }
        save_jobs(&kept)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub async fn scheduler_set_enabled(id: String, enabled: bool) -> Result<Job, String> {
    tokio::task::spawn_blocking(move || -> Result<Job, String> {
        let mut jobs = load_jobs()?;
        let idx = jobs
            .iter()
            .position(|j| j.id == id)
            .ok_or_else(|| format!("job {id} not found"))?;
        let updated = Job {
            enabled,
            next_run: if enabled {
                compute_next_run(&jobs[idx], now_unix())
            } else {
                None
            },
            ..jobs[idx].clone()
        };
        jobs[idx] = updated.clone();
        save_jobs(&jobs)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

pub async fn scheduler_run_once(app: AppHandle, id: String) -> Result<Job, String> {
    // Read, run, write. We intentionally do not hold the file lock across the
    // action (which may be slow) — the runtime loop shares the same lock and
    // we don't want to starve it.
    let snapshot = tokio::task::spawn_blocking({
        let id = id.clone();
        move || -> Result<Job, String> {
            let jobs = load_jobs()?;
            jobs.into_iter()
                .find(|j| j.id == id)
                .ok_or_else(|| format!("job {id} not found"))
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let (output, err) = run_action(&snapshot.action, &app).await;
    let now = now_unix();

    tokio::task::spawn_blocking(move || -> Result<Job, String> {
        let mut jobs = load_jobs()?;
        let idx = jobs
            .iter()
            .position(|j| j.id == id)
            .ok_or_else(|| format!("job {id} not found"))?;
        let updated = Job {
            last_run: Some(now),
            last_output: output,
            last_error: err,
            next_run: compute_next_run(&jobs[idx], now),
            ..jobs[idx].clone()
        };
        jobs[idx] = updated.clone();
        save_jobs(&jobs)?;
        Ok(updated)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

fn parse_kind(s: &str) -> Result<JobKind, String> {
    match s {
        "once" | "Once" => Ok(JobKind::Once),
        "interval" | "Interval" => Ok(JobKind::Interval),
        other => Err(format!("unknown kind {other:?}")),
    }
}

// -------------------- runtime loop --------------------

/// Spawn the ticker. Call once from setup(). Safe to call multiple times —
/// each call spawns an independent ticker (but the file lock serializes
/// writes), though there's no reason to do so.
///
/// Seeds the default morning-brief job on first load (when
/// `~/.sunny/scheduler.json` is missing or empty) before the first tick.
pub fn start_scheduler_loop(app: AppHandle) {
    // Best-effort seed; failure is non-fatal.
    if let Err(e) = seed_default_jobs_if_empty() {
        log::warn!("scheduler seed failed: {e}");
    }

    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(TICK_SECS));
        // First tick fires immediately; skip it so we don't pile up on launch.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = tick_once(&app).await {
                log::warn!("scheduler tick failed: {e}");
            }
        }
    });
}

async fn tick_once(app: &AppHandle) -> Result<(), String> {
    let now = now_unix();

    // Snapshot due jobs under the file lock, then drop the lock before running
    // actions so long-running shell commands don't block other scheduler API
    // calls.
    let due_ids: Vec<String> = {
        let jobs = load_jobs()?;
        jobs.iter()
            .filter(|j| j.enabled)
            .filter(|j| j.next_run.map(|t| t <= now).unwrap_or(false))
            .map(|j| j.id.clone())
            .collect()
    };

    for id in due_ids {
        // Re-load per job so we see any updates (eg user disabled it mid-tick).
        let jobs = load_jobs()?;
        let Some(job) = jobs.iter().find(|j| j.id == id).cloned() else {
            continue;
        };
        if !job.enabled {
            continue;
        }

        let (output, err) = run_action(&job.action, app).await;
        let fired_at = now_unix();

        // Re-load again before writing so concurrent updates aren't lost.
        let mut jobs = load_jobs()?;
        let Some(idx) = jobs.iter().position(|j| j.id == id) else {
            continue;
        };

        let still_enabled = match jobs[idx].kind {
            JobKind::Once => false, // once-jobs disable after firing
            JobKind::Interval => jobs[idx].enabled,
        };

        let updated = Job {
            last_run: Some(fired_at),
            last_output: output,
            last_error: err,
            enabled: still_enabled,
            next_run: if still_enabled {
                compute_next_run(&jobs[idx], fired_at)
            } else {
                None
            },
            ..jobs[idx].clone()
        };
        jobs[idx] = updated;
        save_jobs(&jobs)?;
    }
    Ok(())
}

// -------------------- tests --------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Scratch {
        path: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let seq = SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sunny-scheduler-test-{tag}-{pid}-{nanos}-{seq}",
                pid = std::process::id()
            ));
            fs::create_dir_all(&path).expect("create scratch");
            Self { path }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_job(kind: JobKind, at: Option<i64>, every: Option<u64>) -> Job {
        Job {
            id: new_id(),
            title: "test".into(),
            kind,
            at,
            every_sec: every,
            action: JobAction::Shell {
                cmd: "true".into(),
            },
            enabled: true,
            last_run: None,
            next_run: None,
            last_error: None,
            last_output: None,
            created_at: 0,
        }
    }

    #[test]
    fn add_then_list_roundtrip_preserves_job() {
        let scratch = Scratch::new("roundtrip");
        let original = vec![sample_job(JobKind::Once, Some(1_700_000_000), None)];
        save_to(&scratch.path, &original).expect("save");
        let loaded = load_from(&scratch.path).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, original[0].id);
        assert_eq!(loaded[0].title, "test");
        assert_eq!(loaded[0].kind, JobKind::Once);
        assert_eq!(loaded[0].at, Some(1_700_000_000));
        // JobAction tag+data round-trip via serde.
        match &loaded[0].action {
            JobAction::Shell { cmd } => assert_eq!(cmd, "true"),
            _ => panic!("wrong action type"),
        }
    }

    #[test]
    fn compute_next_run_for_once_and_interval() {
        let now = 1_000_000;

        // Once, scheduled in the future -> returns that time.
        let once_future = sample_job(JobKind::Once, Some(now + 60), None);
        assert_eq!(compute_next_run(&once_future, now), Some(now + 60));

        // Once, already in the past -> clamps to now (fires immediately).
        let once_past = sample_job(JobKind::Once, Some(now - 60), None);
        assert_eq!(compute_next_run(&once_past, now), Some(now));

        // Once, already ran -> None.
        let mut once_done = sample_job(JobKind::Once, Some(now - 60), None);
        once_done.last_run = Some(now - 30);
        assert_eq!(compute_next_run(&once_done, now), None);

        // Interval from anchor, no prior run -> anchor + every.
        let interval = sample_job(JobKind::Interval, Some(now), Some(300));
        assert_eq!(compute_next_run(&interval, now), Some(now + 300));

        // Interval with last_run -> last_run + every.
        let mut ran = sample_job(JobKind::Interval, Some(now - 600), Some(300));
        ran.last_run = Some(now - 100);
        assert_eq!(compute_next_run(&ran, now), Some(now + 200));

        // Interval far behind -> clamps to now so we don't flood.
        let mut behind = sample_job(JobKind::Interval, Some(now - 10_000), Some(60));
        behind.last_run = Some(now - 10_000);
        assert_eq!(compute_next_run(&behind, now), Some(now));

        // Interval with every_sec = 0 is invalid -> None.
        let bad = sample_job(JobKind::Interval, Some(now), Some(0));
        assert_eq!(compute_next_run(&bad, now), None);
    }

    #[test]
    fn delete_removes_job_from_persisted_file() {
        let scratch = Scratch::new("delete");
        let a = sample_job(JobKind::Once, Some(1), None);
        let b = sample_job(JobKind::Once, Some(2), None);
        let jobs = vec![a.clone(), b.clone()];
        save_to(&scratch.path, &jobs).expect("save");

        // Simulate delete of `a` directly against the scratch dir (the real
        // delete API uses $HOME/.sunny which we don't want to touch).
        let filtered: Vec<Job> = jobs.into_iter().filter(|j| j.id != a.id).collect();
        save_to(&scratch.path, &filtered).expect("save filtered");

        let loaded = load_from(&scratch.path).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, b.id);
    }

    #[cfg(unix)]
    #[test]
    fn persisted_file_has_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new("perms");
        let jobs = vec![sample_job(JobKind::Once, Some(1), None)];
        save_to(&scratch.path, &jobs).expect("save");
        let meta = fs::metadata(scratch.path.join(FILE_NAME)).expect("stat");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0o600, got {:o}", mode);
    }

    #[test]
    fn load_quarantines_unparseable_file_and_returns_empty() {
        // Schema-drift scenario: an older binary reading a newer JSON with
        // an unknown variant. We must not lock the scheduler out — we
        // quarantine the bad file and return an empty list so the caller
        // can re-seed defaults.
        let scratch = Scratch::new("quarantine");
        let bad_path = scratch.path.join(FILE_NAME);
        fs::write(
            &bad_path,
            r#"[{"id":"x","title":"t","kind":{"type":"Interval"},"at":null,
                "every_sec":60,"action":{"type":"FutureVariant","data":{}},
                "enabled":true,"last_run":null,"next_run":null,
                "last_error":null,"last_output":null,"created_at":0}]"#,
        )
        .expect("write bad json");

        let loaded = load_from(&scratch.path).expect("load should self-heal");
        assert!(loaded.is_empty(), "expected empty list after quarantine");
        assert!(
            !bad_path.exists(),
            "original file should be moved aside"
        );

        // Exactly one quarantine file should exist next to the (now gone) original.
        let quarantined: Vec<_> = fs::read_dir(&scratch.path)
            .expect("readdir")
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{FILE_NAME}.bad."))
            })
            .collect();
        assert_eq!(quarantined.len(), 1, "expected exactly one quarantine file");
    }

    // ---- scheduler_update exclusion list ----------------------------------------

    #[test]
    fn scheduler_update_does_not_change_id() {
        // Patching with {"id": "evil"} must be silently ignored — the job id
        // is an immutable field protected by the exclusion list.
        let scratch = Scratch::new("patch-id");
        let original = sample_job(JobKind::Once, Some(1_700_000_000), None);
        let original_id = original.id.clone();
        save_to(&scratch.path, &[original.clone()]).expect("save");

        let loaded = load_from(&scratch.path).expect("load");
        assert_eq!(loaded[0].id, original_id);

        // Manually apply the merge logic (same as scheduler_update) to verify
        // the exclusion list works without requiring an async runtime here.
        let current = serde_json::to_value(&loaded[0]).expect("serialize");
        let mut merged = current;
        let patch: serde_json::Value = serde_json::json!({ "id": "evil" });
        let patch_obj = patch.as_object().unwrap();
        const IMMUTABLE_FIELDS: &[&str] = &["id", "created_at", "last_run", "last_error", "last_output"];
        if let Some(obj) = merged.as_object_mut() {
            for (k, v) in patch_obj {
                if IMMUTABLE_FIELDS.contains(&k.as_str()) {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
        let patched: Job = serde_json::from_value(merged).expect("deser");
        assert_eq!(patched.id, original_id, "id must be unchanged after patch with id=evil");
    }

    #[test]
    fn scheduler_update_does_not_allow_last_run_override() {
        // A patch of {"last_run": 12345} must be silently ignored so the UI
        // cannot forge run history.
        let job = sample_job(JobKind::Interval, Some(1_000_000), Some(300));
        assert!(job.last_run.is_none(), "sample_job starts with no last_run");

        let current = serde_json::to_value(&job).expect("serialize");
        let mut merged = current;
        let patch: serde_json::Value = serde_json::json!({ "last_run": 99999 });
        let patch_obj = patch.as_object().unwrap();
        const IMMUTABLE_FIELDS: &[&str] = &["id", "created_at", "last_run", "last_error", "last_output"];
        if let Some(obj) = merged.as_object_mut() {
            for (k, v) in patch_obj {
                if IMMUTABLE_FIELDS.contains(&k.as_str()) {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
        let patched: Job = serde_json::from_value(merged).expect("deser");
        assert!(
            patched.last_run.is_none(),
            "last_run must remain None after patch — got {:?}",
            patched.last_run
        );
    }

    #[test]
    fn scheduler_update_does_not_allow_last_error_or_last_output_override() {
        // {"last_error": "fake", "last_output": "fake"} must be silently dropped.
        let job = sample_job(JobKind::Interval, Some(1_000_000), Some(300));

        let current = serde_json::to_value(&job).expect("serialize");
        let mut merged = current;
        let patch: serde_json::Value =
            serde_json::json!({ "last_error": "injected error", "last_output": "injected output" });
        let patch_obj = patch.as_object().unwrap();
        const IMMUTABLE_FIELDS: &[&str] = &["id", "created_at", "last_run", "last_error", "last_output"];
        if let Some(obj) = merged.as_object_mut() {
            for (k, v) in patch_obj {
                if IMMUTABLE_FIELDS.contains(&k.as_str()) {
                    continue;
                }
                obj.insert(k.clone(), v.clone());
            }
        }
        let patched: Job = serde_json::from_value(merged).expect("deser");
        assert!(patched.last_error.is_none(), "last_error must not be injectable");
        assert!(patched.last_output.is_none(), "last_output must not be injectable");
    }

    #[test]
    fn job_action_serializes_with_tag_and_data_fields() {
        // Round-trip via serde to lock the wire format the frontend expects.
        let shell = JobAction::Shell { cmd: "ls".into() };
        let v = serde_json::to_value(&shell).unwrap();
        assert_eq!(v, json!({"type": "Shell", "data": {"cmd": "ls"}}));

        let notify = JobAction::Notify {
            title: "hi".into(),
            body: "yo".into(),
        };
        let v = serde_json::to_value(&notify).unwrap();
        assert_eq!(
            v,
            json!({"type": "Notify", "data": {"title": "hi", "body": "yo"}})
        );
    }
}

// === REGISTER IN lib.rs ===
// mod scheduler; at top
// In setup(): crate::scheduler::start_scheduler_loop(app.handle().clone());
// #[tauri::command]s: scheduler_list, scheduler_add, scheduler_update, scheduler_delete, scheduler_set_enabled, scheduler_run_once
// Add to invoke_handler in this order.
// No new deps required.
// === END REGISTER ===
