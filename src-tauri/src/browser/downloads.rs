//! Download manager.
//!
//! Wraps `yt-dlp` (preferred, supports 1000+ sites) and `ffmpeg` (fallback
//! for raw HLS/DASH manifests or direct media URLs). Both are located by
//! probing `PATH` + a small list of common install locations; if neither is
//! present we surface a helpful error rather than failing silently.
//!
//! Every job carries a `profile_id` so network traffic follows the same
//! posture as the tab that initiated it. For Tor/custom-proxy profiles we
//! pass `--proxy` to yt-dlp with a redacted form of the route URL; for
//! ffmpeg we set `http_proxy`/`https_proxy` env vars.
//!
//! Progress is streamed to the frontend through Tauri events:
//!   `browser:download:update` — full job record every update tick.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncBufReadExt;
use ts_rs::TS;

use crate::browser::dispatcher;
use crate::browser::profile::{ProfileId, Route};
use crate::browser::storage::downloads_conn;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DownloadState {
    Queued,
    Probing,
    Downloading,
    PostProcess,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DownloadJob {
    pub id: String,
    pub profile_id: String,
    pub source_url: String,
    pub title: Option<String>,
    pub state: DownloadState,
    pub progress: f32,
    pub file_path: Option<String>,
    pub mime: Option<String>,
    #[ts(type = "number | null")]
    pub bytes_total: Option<i64>,
    #[ts(type = "number")]
    pub bytes_done: i64,
    pub error: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProbeResult {
    pub has_yt_dlp: bool,
    pub yt_dlp_version: Option<String>,
    pub has_ffmpeg: bool,
    pub ffmpeg_version: Option<String>,
    pub yt_dlp_path: Option<String>,
    pub ffmpeg_path: Option<String>,
}

pub struct DownloadManager {
    jobs: Mutex<Vec<DownloadJob>>,
    cancel_flags: Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            cancel_flags: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<DownloadJob> {
        self.jobs.lock().expect("dl poisoned").clone()
    }

    fn upsert(&self, job: DownloadJob) {
        let mut g = self.jobs.lock().expect("dl poisoned");
        if let Some(slot) = g.iter_mut().find(|j| j.id == job.id) {
            *slot = job.clone();
        } else {
            g.push(job.clone());
        }
        let _ = persist_job(&job);
    }

    pub fn get(&self, id: &str) -> Option<DownloadJob> {
        self.jobs
            .lock()
            .expect("dl poisoned")
            .iter()
            .find(|j| j.id == id)
            .cloned()
    }

    pub fn cancel(&self, id: &str) -> bool {
        let g = self.cancel_flags.lock().expect("cf poisoned");
        if let Some(flag) = g.get(id) {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        } else {
            false
        }
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

pub fn global() -> &'static Arc<DownloadManager> {
    static CELL: OnceLock<Arc<DownloadManager>> = OnceLock::new();
    CELL.get_or_init(|| Arc::new(DownloadManager::new()))
}

/// Probe for yt-dlp and ffmpeg. Checks PATH plus a few canonical locations
/// Homebrew uses on Apple Silicon vs. Intel installs.
pub async fn probe_tools() -> ProbeResult {
    let yt_dlp_path = find_tool("yt-dlp").await;
    let ffmpeg_path = find_tool("ffmpeg").await;
    let yt_dlp_version = match &yt_dlp_path {
        Some(p) => version_of(p, &["--version"]).await,
        None => None,
    };
    let ffmpeg_version = match &ffmpeg_path {
        Some(p) => version_of(p, &["-version"]).await,
        None => None,
    };
    ProbeResult {
        has_yt_dlp: yt_dlp_path.is_some(),
        has_ffmpeg: ffmpeg_path.is_some(),
        yt_dlp_version,
        ffmpeg_version,
        yt_dlp_path: yt_dlp_path.map(|p| p.to_string_lossy().to_string()),
        ffmpeg_path: ffmpeg_path.map(|p| p.to_string_lossy().to_string()),
    }
}

async fn find_tool(name: &str) -> Option<PathBuf> {
    const FALLBACKS: &[&str] = &[
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
    ];
    // PATH probe via `which`.
    if let Ok(output) = tokio::process::Command::new("which")
        .arg(name)
        .output()
        .await
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !s.is_empty() {
                let p = PathBuf::from(s);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    for prefix in FALLBACKS {
        let p = PathBuf::from(prefix).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

async fn version_of(path: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = tokio::process::Command::new(path)
        .args(args)
        .output()
        .await
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        // ffmpeg dumps many lines; keep the first.
        s.lines().next().map(|l| l.to_string())
    }
}

pub fn downloads_dir() -> Result<PathBuf, String> {
    let base = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no download dir".to_string())?;
    let target = base.join("Sunny");
    std::fs::create_dir_all(&target).map_err(|e| format!("mkdir downloads: {e}"))?;
    Ok(target)
}

/// Enqueue a download. Returns immediately with the job record in
/// `Queued` state; the worker task drives it through to `Done`/`Failed`.
pub async fn enqueue(
    app: AppHandle,
    profile_id: ProfileId,
    url: String,
) -> Result<DownloadJob, String> {
    let probe = probe_tools().await;
    if !probe.has_yt_dlp && !probe.has_ffmpeg {
        return Err(
            "neither yt-dlp nor ffmpeg found on PATH. Install via `brew install yt-dlp ffmpeg`."
                .into(),
        );
    }
    let id = format!("dl_{}", new_id());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let job = DownloadJob {
        id: id.clone(),
        profile_id: profile_id.as_str().to_string(),
        source_url: url.clone(),
        title: None,
        state: DownloadState::Queued,
        progress: 0.0,
        file_path: None,
        mime: None,
        bytes_total: None,
        bytes_done: 0,
        error: None,
        created_at: now,
        updated_at: now,
    };
    let mgr = global();
    mgr.upsert(job.clone());

    let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    mgr.cancel_flags
        .lock()
        .expect("cf poisoned")
        .insert(id.clone(), cancel_flag.clone());

    let _ = app.emit("browser:download:update", &job);

    tokio::spawn(run_job(app, profile_id, id.clone(), url, probe, cancel_flag));

    Ok(job)
}

async fn run_job(
    app: AppHandle,
    profile_id: ProfileId,
    id: String,
    url: String,
    probe: ProbeResult,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
) {
    let mgr = global();
    let dir = match downloads_dir() {
        Ok(d) => d,
        Err(e) => {
            finalize(&app, &id, DownloadState::Failed, Some(e), &mgr);
            return;
        }
    };

    // Phase: probing (yt-dlp info pull).
    patch_state(&app, &id, DownloadState::Probing, &mgr);

    if probe.has_yt_dlp {
        let yt_dlp = probe.yt_dlp_path.as_deref().unwrap_or("yt-dlp");
        if let Err(e) = run_yt_dlp(
            &app,
            &id,
            yt_dlp,
            &url,
            &dir,
            &profile_id,
            cancel_flag.clone(),
        )
        .await
        {
            // Fall back to ffmpeg if we have it.
            if probe.has_ffmpeg {
                let ffmpeg = probe.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
                if let Err(e2) =
                    run_ffmpeg_direct(&app, &id, ffmpeg, &url, &dir, &profile_id, cancel_flag)
                        .await
                {
                    finalize(
                        &app,
                        &id,
                        DownloadState::Failed,
                        Some(format!("yt-dlp: {e} | ffmpeg: {e2}")),
                        &mgr,
                    );
                    return;
                }
            } else {
                finalize(&app, &id, DownloadState::Failed, Some(e), &mgr);
                return;
            }
        }
    } else if probe.has_ffmpeg {
        let ffmpeg = probe.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
        if let Err(e) =
            run_ffmpeg_direct(&app, &id, ffmpeg, &url, &dir, &profile_id, cancel_flag).await
        {
            finalize(&app, &id, DownloadState::Failed, Some(e), &mgr);
            return;
        }
    }

    finalize(&app, &id, DownloadState::Done, None, &mgr);
}

fn finalize(
    app: &AppHandle,
    id: &str,
    state: DownloadState,
    error: Option<String>,
    mgr: &DownloadManager,
) {
    let Some(mut job) = mgr.get(id) else { return };
    job.state = state;
    job.error = error;
    job.updated_at = now_secs();
    if state == DownloadState::Done {
        job.progress = 1.0;
        // macOS quarantine xattr so Gatekeeper treats this as a
        // browser-downloaded file. On first open the user sees the
        // standard "This file was downloaded from the internet" prompt.
        if let Some(ref path) = job.file_path {
            apply_quarantine_xattr(path, &job.source_url, &job.profile_id);
        }
    }
    mgr.upsert(job.clone());
    let _ = app.emit("browser:download:update", &job);
}

/// Set `com.apple.quarantine` on a file so Gatekeeper prompts on first
/// open. The value format is
/// `flags;timestamp_hex;agent_name;uuid` — widely-documented, and Safari
/// / Chrome / Firefox all set similar values. We set flag `0081`
/// (kLSQuarantineTypeWebDownload, user-approved-no) so macOS treats the
/// file exactly like a Safari download.
#[cfg(target_os = "macos")]
fn apply_quarantine_xattr(path: &str, source_url: &str, profile_id: &str) {
    use std::process::Command;
    let ts = now_secs();
    let uuid = format!("{:016x}-{:08x}-{:04x}-{:04x}-{:012x}",
        ts as u64, std::process::id(), 0u16, 0u16, (ts as u64).wrapping_mul(2654435761));
    // `0081` = LSQuarantineTypeWebDownload flag set. The agent name
    // identifies the originating process in the Gatekeeper prompt.
    let value = format!(
        "0081;{:x};Sunny ({});{}",
        ts,
        profile_id,
        uuid,
    );
    // Best-effort; we don't fail the download if xattr fails (e.g. on
    // APFS volumes that don't support extended attributes).
    let _ = Command::new("xattr")
        .arg("-w")
        .arg("com.apple.quarantine")
        .arg(&value)
        .arg(path)
        .status();
    // Also set `com.apple.metadata:kMDItemWhereFroms` so Finder's Get
    // Info shows "Where from: <url>" exactly like a Safari download.
    let plist = quarantine_where_from_plist(source_url);
    let _ = Command::new("xattr")
        .arg("-wx")
        .arg("com.apple.metadata:kMDItemWhereFroms")
        .arg(&plist)
        .arg(path)
        .status();
}

#[cfg(not(target_os = "macos"))]
fn apply_quarantine_xattr(_path: &str, _source_url: &str, _profile_id: &str) {}

/// Construct the binary plist (as a hex string for `xattr -wx`) that
/// Finder expects in `kMDItemWhereFroms`: an array of strings, the
/// canonical source URL(s) for the file.
#[cfg(target_os = "macos")]
fn quarantine_where_from_plist(source_url: &str) -> String {
    // Minimal CFPropertyList binary1 format: we build a one-string array.
    // This is easier to get right as bytes than to embed a plist crate.
    // Structure: magic header + object table + trailer. For a one-string
    // array we can hand-roll it.
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"bplist00");
    // Object 0: array of one ref (ref index 1)
    out.push(0xA1); // array marker with 1 element
    out.push(0x01);
    // Object 1: ASCII string; use 5-bit-count marker if short enough.
    let url_bytes = source_url.as_bytes();
    if url_bytes.len() < 15 {
        out.push(0x50 | url_bytes.len() as u8);
    } else {
        out.push(0x5F);
        // length marker: 0x10 | power-of-two size; we use 2-byte length.
        out.push(0x11);
        out.extend_from_slice(&(url_bytes.len() as u16).to_be_bytes());
    }
    out.extend_from_slice(url_bytes);
    // Offset table
    let offset_table_offset = out.len() as u64;
    out.push(0x00); // obj 0 @ offset 8 (header) — but we just append offsets
    let obj0_off = 8u8; // immediately after header
    let obj1_off = 10u8; // header + array(2 bytes)
    out[offset_table_offset as usize] = obj0_off;
    out.push(obj1_off);
    // Trailer (32 bytes)
    out.extend_from_slice(&[0u8; 6]); // unused
    out.push(1); // offset size
    out.push(1); // object ref size
    out.extend_from_slice(&(2u64).to_be_bytes()); // num objects
    out.extend_from_slice(&(0u64).to_be_bytes()); // top object
    out.extend_from_slice(&offset_table_offset.to_be_bytes());
    // Encode as hex
    let mut hex = String::with_capacity(out.len() * 2);
    for b in out {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

fn patch_state(app: &AppHandle, id: &str, state: DownloadState, mgr: &DownloadManager) {
    let Some(mut job) = mgr.get(id) else { return };
    job.state = state;
    job.updated_at = now_secs();
    mgr.upsert(job.clone());
    let _ = app.emit("browser:download:update", &job);
}

async fn run_yt_dlp(
    app: &AppHandle,
    id: &str,
    yt_dlp: &str,
    url: &str,
    dir: &std::path::Path,
    profile_id: &ProfileId,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let mgr = global();
    patch_state(app, id, DownloadState::Downloading, &mgr);

    let out_template = dir.join(format!("{id}_%(title).120s.%(ext)s"));
    let out_arg = out_template.to_string_lossy().to_string();

    let mut cmd = tokio::process::Command::new(yt_dlp);
    cmd.arg("--no-part")
        .arg("--newline")
        .arg("--no-progress-template")
        .arg("--progress-template")
        .arg("download:[%(progress._percent_str)s] %(progress._total_bytes_str)s")
        .arg("-o")
        .arg(&out_arg)
        .arg(url);

    apply_proxy_env_and_flag(&mut cmd, profile_id, true);

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn yt-dlp: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let id_out = id.to_string();
    let app_out = app.clone();
    let cf_out = cancel_flag.clone();
    let out_task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if cf_out.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if let Some(pct) = parse_yt_dlp_progress(&line) {
                let mgr = global();
                if let Some(mut job) = mgr.get(&id_out) {
                    job.progress = pct;
                    job.updated_at = now_secs();
                    mgr.upsert(job.clone());
                    let _ = app_out.emit("browser:download:update", &job);
                }
            }
        }
    });
    let err_task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        let mut last = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            last = line;
        }
        last
    });

    let status = tokio::select! {
        r = child.wait() => r.map_err(|e| format!("wait yt-dlp: {e}"))?,
        _ = wait_cancel(cancel_flag.clone()) => {
            let _ = child.kill().await;
            return Err("cancelled".into());
        }
    };
    out_task.abort();
    let last_err = err_task.await.unwrap_or_default();

    if !status.success() {
        return Err(if last_err.is_empty() {
            format!("yt-dlp exited {status}")
        } else {
            last_err
        });
    }
    Ok(())
}

async fn wait_cancel(flag: Arc<std::sync::atomic::AtomicBool>) {
    while !flag.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

async fn run_ffmpeg_direct(
    app: &AppHandle,
    id: &str,
    ffmpeg: &str,
    url: &str,
    dir: &std::path::Path,
    profile_id: &ProfileId,
    _cancel_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let mgr = global();
    patch_state(app, id, DownloadState::Downloading, &mgr);
    let out_path = dir.join(format!("{id}.mp4"));
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.arg("-y")
        .arg("-i")
        .arg(url)
        .arg("-c")
        .arg("copy")
        .arg(&out_path);
    apply_proxy_env_and_flag(&mut cmd, profile_id, false);

    let status = cmd
        .status()
        .await
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exited {status}"));
    }
    if let Some(mut job) = mgr.get(id) {
        job.file_path = Some(out_path.to_string_lossy().to_string());
        job.progress = 1.0;
        job.updated_at = now_secs();
        mgr.upsert(job);
    }
    Ok(())
}

/// Apply the profile's proxy as env vars and, for yt-dlp, the `--proxy` flag.
/// `system-tor` and `custom` routes are honored; `bundled-tor` only works if
/// the feature provides a local SOCKS port. Clearnet is a no-op.
fn apply_proxy_env_and_flag(
    cmd: &mut tokio::process::Command,
    profile_id: &ProfileId,
    supports_flag: bool,
) {
    let disp = dispatcher::global();
    let Some(policy) = disp.get_profile(profile_id) else {
        return;
    };
    let proxy_url = match &policy.route {
        Route::Clearnet { .. } => return,
        Route::SystemTor { host, port } => format!("socks5h://{host}:{port}"),
        Route::Custom { url } => url.clone(),
        Route::BundledTor => {
            #[cfg(feature = "bundled-tor")]
            {
                if let Some(p) = crate::browser::tor::bundled_socks_port() {
                    format!("socks5h://127.0.0.1:{p}")
                } else {
                    return;
                }
            }
            #[cfg(not(feature = "bundled-tor"))]
            {
                return;
            }
        }
    };
    cmd.env("http_proxy", &proxy_url);
    cmd.env("https_proxy", &proxy_url);
    cmd.env("HTTP_PROXY", &proxy_url);
    cmd.env("HTTPS_PROXY", &proxy_url);
    if supports_flag {
        cmd.arg("--proxy").arg(&proxy_url);
    }
}

fn parse_yt_dlp_progress(line: &str) -> Option<f32> {
    // Lines look like: "download:[  42.1%]   12.3MiB"
    let start = line.find('[')?;
    let end = line[start..].find(']')?;
    let inner = &line[start + 1..start + end];
    let pct_str = inner.trim().trim_end_matches('%').trim();
    let n: f32 = pct_str.parse().ok()?;
    Some((n / 100.0).clamp(0.0, 1.0))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = now_secs();
    let c = CTR.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", n, c)
}

fn persist_job(job: &DownloadJob) -> Result<(), String> {
    let g = downloads_conn().lock().map_err(|_| "poisoned")?;
    let state_str = match job.state {
        DownloadState::Queued => "queued",
        DownloadState::Probing => "probing",
        DownloadState::Downloading => "downloading",
        DownloadState::PostProcess => "post_process",
        DownloadState::Done => "done",
        DownloadState::Failed => "failed",
        DownloadState::Cancelled => "cancelled",
    };
    g.execute(
        "INSERT INTO downloads (id, profile_id, source_url, title, state, progress, file_path, mime, bytes_total, bytes_done, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            state = excluded.state,
            progress = excluded.progress,
            file_path = excluded.file_path,
            mime = excluded.mime,
            bytes_total = excluded.bytes_total,
            bytes_done = excluded.bytes_done,
            error = excluded.error,
            updated_at = excluded.updated_at",
        rusqlite::params![
            job.id,
            job.profile_id,
            job.source_url,
            job.title,
            state_str,
            job.progress as f64,
            job.file_path,
            job.mime,
            job.bytes_total,
            job.bytes_done,
            job.error,
            job.created_at,
            job.updated_at,
        ],
    )
    .map_err(|e| format!("persist download: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yt_dlp_progress() {
        let pct = parse_yt_dlp_progress("download:[ 42.1%]   12.3MiB");
        assert!(pct.is_some());
        assert!((pct.unwrap() - 0.421).abs() < 0.001);
    }

    #[test]
    fn rejects_garbage_progress() {
        assert!(parse_yt_dlp_progress("no brackets here").is_none());
    }
}
