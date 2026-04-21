//! Audio capture and transcription.
//!
//! Recording — native `cpal` capture (see `audio_capture.rs`). One in-process
//! input stream fans out into (a) a 16 kHz mono WAV file for whisper-cli and
//! (b) `sunny://voice.level` events the frontend uses for VAD. The old
//! `sox` / `ffmpeg` subprocess path was removed because it raced the
//! WKWebView `getUserMedia` capture for the same input device on macOS —
//! whichever opened the mic first starved the other, which is what caused
//! VAD to never fire `onSilence` and the 25 s backstop to trip every turn.
//!
//! Transcription — tries `whisper-cli` (whisper.cpp, Homebrew `whisper-cpp`)
//! first, then falls back to `whisper` (openai-whisper). On first run we
//! lazily fetch a whisper.cpp GGML model (preferring `large-v3-turbo`, with
//! `base.en` as a legacy fallback) from Hugging Face into the app cache dir,
//! because neither CLI ships a ready-to-use model by default.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::audio_capture::{self, CaptureHandle};

/// Known whisper.cpp hallucinations. Whisper was trained on YouTube captions
/// that often contain boilerplate like "thanks for watching", "you", "please
/// subscribe", so short or silent clips fall back to these priors. Any
/// transcript that matches one of these verbatim (after trim + lowercase) is
/// treated as no speech and returned as empty string.
const WHISPER_HALLUCINATIONS: &[&str] = &[
    "you", "you.", "thank you.", "thanks for watching.", "thanks for watching!",
    "thank you for watching.", "thank you for watching!", "please subscribe.",
    "like and subscribe.", "subscribe.", "the end.", "okay.", "bye.",
    "um.", "uh.", "hmm.", ".", "(silence)", "[silence]", "[blank_audio]",
    "[music]", "[applause]", "(upbeat music)",
    "subtitles by the amara.org community",
];

/// RMS threshold below which the captured WAV is treated as silence and
/// whisper is skipped entirely. 0.005 ≈ -46 dBFS — well below normal speech
/// (-20 to -10 dBFS) but above typical room tone (-60 dBFS and quieter).
/// Set via SUNNY_SILENCE_RMS env override for debugging.
const MIN_RMS_FOR_SPEECH: f32 = 0.005;

fn is_whisper_hallucination(text: &str) -> bool {
    let norm = text.trim().to_lowercase();
    if norm.is_empty() { return false; }
    WHISPER_HALLUCINATIONS.iter().any(|h| norm == *h)
}

/// Compute RMS of a 16-bit int or f32 WAV. Returns None on read error.
/// Used as a pre-whisper silence gate: if the mic captured noise-floor
/// only, don't hand a zero-energy clip to whisper — it'll hallucinate.
fn wav_rms(path: &str) -> Option<f32> {
    let mut reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    let mut sum_sq: f64 = 0.0;
    let mut count: u64 = 0;
    match spec.sample_format {
        hound::SampleFormat::Int => {
            let scale = 1.0_f64 / (i16::MAX as f64);
            for s in reader.samples::<i16>().flatten() {
                let f = s as f64 * scale;
                sum_sq += f * f;
                count += 1;
            }
        }
        hound::SampleFormat::Float => {
            for s in reader.samples::<f32>().flatten() {
                sum_sq += (s as f64) * (s as f64);
                count += 1;
            }
        }
    }
    if count == 0 { return None; }
    Some(((sum_sq / count as f64).sqrt()) as f32)
}

/// Random 6-char id printed on each backend trace line so we can reassemble
/// per-turn timelines in the log without coordinating with the frontend.
fn trace_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Base36-ish from the low 30 bits of the nanosecond timestamp.
    let mut v = (n as u64) & 0x3FFF_FFFF;
    let alphabet = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = Vec::with_capacity(6);
    for _ in 0..6 {
        out.push(alphabet[(v as usize) % alphabet.len()]);
        v /= alphabet.len() as u64;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Filename of the preferred SOTA model (Whisper large-v3-turbo).
/// ~5x faster than large-v3 with near-identical WER; multilingual-capable;
/// runs at ~10-20 tok/s on M-series Apple Silicon with `-ngl 99`.
const TURBO_MODEL: &str = "ggml-large-v3-turbo.bin";
/// Legacy default kept as a fallback when the turbo download fails.
const BASE_MODEL: &str = "ggml-base.en.bin";
/// Expected minimum byte size for the turbo model (~1.6 GB). Anything
/// substantially smaller is treated as a partial/corrupt download and re-
/// fetched. 100 MB is a conservative lower bound — the real file is ~1.62 GB.
const TURBO_MIN_SIZE: u64 = 100 * 1024 * 1024;

/// Log the resolved model path at most once per process.
static LOGGED_MODEL: AtomicBool = AtomicBool::new(false);
/// Guard so we only spawn the background turbo upgrade once per process.
static TURBO_UPGRADE_SPAWNED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct RecordStatus {
    pub recording: bool,
    pub path: Option<String>,
    #[ts(type = "number")]
    pub seconds: u64,
}

/// Tauri-managed recorder state. Holds at most one live `CaptureHandle`
/// at a time. All fields are behind `Mutex` because `tauri::State` hands
/// out `&self` — interior mutability is the only option.
pub struct Recorder {
    /// Live capture handle, present while recording. `stop()` drains this
    /// via `take()`, which both ends the session and hands the handle to
    /// `audio_capture::stop` for a clean WAV finalize.
    handle: Mutex<Option<CaptureHandle>>,
    /// Last recorded WAV path. Kept populated after `stop()` so the UI
    /// can poll `audio_record_status` and still see where the file
    /// landed (the frontend often transcribes on a separate tick).
    path: Mutex<Option<String>>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            path: Mutex::new(None),
        }
    }

    pub fn status(&self) -> RecordStatus {
        let handle_guard = self.handle.lock().unwrap();
        let recording = handle_guard.is_some();
        // Seconds counter lives on the handle; fall back to 0 once
        // recording stops so the UI reads "not recording".
        let seconds = handle_guard
            .as_ref()
            .map(|h| h.started_at.elapsed().as_secs())
            .unwrap_or(0);
        drop(handle_guard);
        let path = self.path.lock().unwrap().clone();
        RecordStatus { recording, path, seconds }
    }
}

pub async fn start(recorder: &Recorder, app: AppHandle) -> Result<String, String> {
    let tid = trace_id();
    let t_start = Instant::now();
    log::info!("[voice-trace] stage=rust_record_start_begin turn={tid}");
    {
        let already = recorder.handle.lock().unwrap().is_some();
        if already { return Err("already recording".into()); }
    }

    // cpal stream setup is synchronous and should be near-instant, but
    // we run it on a blocking worker to keep the tokio runtime free in
    // the pathological case where the audio driver stalls.
    let handle = tokio::task::spawn_blocking(move || audio_capture::start(app))
        .await
        .map_err(|e| format!("capture spawn_blocking join: {e}"))??;

    let path = handle.wav_path().to_string();
    *recorder.handle.lock().unwrap() = Some(handle);
    *recorder.path.lock().unwrap() = Some(path.clone());

    log::info!(
        "[voice-trace] stage=rust_record_start_ok turn={tid} dt_ms={}",
        t_start.elapsed().as_millis()
    );
    Ok(path)
}

pub async fn stop(recorder: &Recorder) -> Result<String, String> {
    let tid = trace_id();
    let t_start = Instant::now();
    log::info!("[voice-trace] stage=rust_record_stop_begin turn={tid}");
    let handle = {
        let mut guard = recorder.handle.lock().unwrap();
        guard.take().ok_or("not recording")?
    };

    // Joining the capture thread is synchronous too — same reasoning as
    // start: keep tokio free even if the WAV flush drags.
    let path = tokio::task::spawn_blocking(move || audio_capture::stop(handle))
        .await
        .map_err(|e| format!("capture stop join: {e}"))??;

    // Mirror the path back into the recorder so `status()` keeps
    // reporting a useful value until the next `start`.
    *recorder.path.lock().unwrap() = Some(path.clone());
    log::info!(
        "[voice-trace] stage=rust_record_stop_ok turn={tid} dt_ms={}",
        t_start.elapsed().as_millis()
    );
    Ok(path)
}

pub async fn transcribe(path: String) -> Result<String, String> {
    let tid = trace_id();
    let t_total = Instant::now();
    log::info!("[voice-trace] stage=rust_transcribe_begin turn={tid}");

    // Silence gate. If the mic captured near-silence (wrong input device,
    // muted at hardware level, TCC denial falling back to a null stream),
    // whisper reliably hallucinates "you" / "thanks for watching". Short-
    // circuit here so the user sees an empty transcript and can retry,
    // rather than chatting with a ghost. Override via SUNNY_SILENCE_RMS=0
    // when debugging.
    let rms_floor = std::env::var("SUNNY_SILENCE_RMS")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(MIN_RMS_FOR_SPEECH);
    if let Some(rms) = wav_rms(&path) {
        log::info!("[voice-trace] stage=rust_wav_rms turn={tid} rms={rms:.5} floor={rms_floor:.5}");
        if rms < rms_floor {
            log::info!("[voice-trace] stage=rust_silence_gate_drop turn={tid} rms={rms:.5}");
            return Ok(String::new());
        }
    }

    // 1) whisper.cpp — `whisper-cli` from `brew install whisper-cpp`.
    //    Needs a GGML model file; we resolve one (bundled, cached, or
    //    downloaded on demand) and write output to a known txt file so we
    //    don't have to parse stdout timestamps.
    if let Some(bin) = crate::paths::which("whisper-cli") {
        let t_model = Instant::now();
        let model = match ensure_whisper_model().await {
            Ok(m) => m,
            Err(e) => return Err(format!("whisper-cli: {e}")),
        };
        log::info!(
            "[voice-trace] stage=rust_whisper_model_resolved turn={tid} dt_ms={}",
            t_model.elapsed().as_millis()
        );
        let out_prefix = std::env::temp_dir().join(format!(
            "sunny-mic-{}-out",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let out_prefix_str = out_prefix.to_string_lossy().into_owned();

        // Speed-tuned flags. Short voice utterances don't need beam search
        // — greedy decoding (`-bs 1 -bo 1`) is several times faster and the
        // accuracy cost is negligible below ~15 s of audio. `-fa` (flash
        // attention) is on by default on Apple Silicon and is where most of
        // the win comes from.
        // Thread count: whisper.cpp's Metal path doesn't benefit much past
        // 8 threads (encoder parallelism is GPU-bound, decoder is tiny),
        // but capping at 4 was leaving performance cores idle. Use up to 8.
        let threads = std::cmp::min(8, std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(8));
        let mut cmd = Command::new(&bin);
        cmd.arg("-m").arg(&model)
            .arg("-f").arg(&path)
            .arg("-l").arg("en")
            .arg("-t").arg(threads.to_string())
            .arg("-bs").arg("1")
            .arg("-bo").arg("1")
            // Metal offload note: whisper.cpp (the `whisper-cli` from the
            // Homebrew `whisper-cpp` formula) has Metal enabled by default
            // on Apple Silicon — there is no `-ngl` flag. An earlier
            // attempt to pass `-ngl 99` caused whisper-cli to dump help
            // and exit before transcribing anything, which is far worse
            // than the original slowness. Metal is implicit; `-fa`
            // (flash-attention) is a bare flag in recent builds and
            // ignored safely in older ones.
            .arg("-fa")
            .arg("-nt")                // no timestamps
            .arg("-np")                // no extra prints
            // Anti-hallucination: suppress non-speech tokens (music/applause
            // annotations) and require a minimum no-speech probability before
            // emitting. 0.6 is whisper.cpp's default — we set it explicitly
            // so a future default shift doesn't silently regress behavior.
            .arg("-sns")
            .arg("-nth").arg("0.6")
            .arg("-tp").arg("0.0")     // greedy / deterministic
            .arg("-otxt")
            .arg("-of").arg(&out_prefix_str)
            .stderr(std::process::Stdio::null());
        if let Some(p) = crate::paths::fat_path() {
            cmd.env("PATH", p);
        }
        let t_exec = Instant::now();
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("whisper-cli: {e}"))?;
        log::info!(
            "[voice-trace] stage=rust_whisper_exec_ok turn={tid} dt_ms={} exit={}",
            t_exec.elapsed().as_millis(),
            out.status.code().unwrap_or(-1)
        );
        if out.status.success() {
            let txt_path = format!("{out_prefix_str}.txt");
            let t_read = Instant::now();
            let txt = tokio::fs::read_to_string(&txt_path).await.ok();
            let _ = tokio::fs::remove_file(&txt_path).await;
            log::info!(
                "[voice-trace] stage=rust_whisper_read_ok turn={tid} dt_ms={}",
                t_read.elapsed().as_millis()
            );
            let text = match txt {
                Some(s) => s,
                None => String::from_utf8_lossy(&out.stdout).into_owned(),
            };
            let trimmed = text.trim().to_string();
            if is_whisper_hallucination(&trimmed) {
                log::info!(
                    "[voice-trace] stage=rust_whisper_hallucination_filtered turn={tid} text={trimmed:?}"
                );
                return Ok(String::new());
            }
            log::info!(
                "[voice-trace] stage=rust_transcribe_ok turn={tid} dt_ms={} text_len={}",
                t_total.elapsed().as_millis(),
                trimmed.len()
            );
            return Ok(trimmed);
        }
        let err = String::from_utf8_lossy(&out.stderr);
        if !err.trim().is_empty() {
            return Err(format!("whisper-cli failed: {}", err.trim()));
        }
    }

    // 2) openai-whisper — slower Python CLI, but reliable if installed.
    if let Some(whisper) = crate::paths::which("whisper") {
        let out_dir = std::env::temp_dir();
        let mut cmd = Command::new(&whisper);
        cmd.arg(&path)
            .arg("--model").arg("base.en")
            .arg("--language").arg("en")
            .arg("--output_format").arg("txt")
            .arg("--output_dir").arg(&out_dir)
            .arg("--fp16").arg("False")
            .stderr(std::process::Stdio::null());
        if let Some(p) = crate::paths::fat_path() {
            cmd.env("PATH", p);
        }
        let out = cmd
            .output()
            .await
            .map_err(|e| format!("whisper: {e}"))?;
        if out.status.success() {
            // openai-whisper writes <basename>.txt next to --output_dir.
            if let Some(stem) = std::path::Path::new(&path).file_stem() {
                let txt_path = out_dir.join(format!("{}.txt", stem.to_string_lossy()));
                if let Ok(s) = tokio::fs::read_to_string(&txt_path).await {
                    let _ = tokio::fs::remove_file(&txt_path).await;
                    let trimmed = s.trim().to_string();
                    if is_whisper_hallucination(&trimmed) { return Ok(String::new()); }
                    return Ok(trimmed);
                }
            }
            let trimmed = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if is_whisper_hallucination(&trimmed) { return Ok(String::new()); }
            return Ok(trimmed);
        }
    }

    Err("no transcriber available — run `brew install whisper-cpp` (preferred) or `brew install openai-whisper`".into())
}

/// Find or fetch a whisper.cpp GGML model, returning a usable path.
///
/// Search order (first match wins):
///   1. `$SUNNY_WHISPER_MODEL` env override, if set and exists.
///   2. Cached turbo model at `<cache>/ggml-large-v3-turbo.bin`.
///   3. Homebrew turbo at `/opt/homebrew/share/whisper-cpp/ggml-large-v3-turbo.bin`.
///   4. Cached legacy `ggml-base.en.bin`. If present, also kicks off a
///      background turbo download so subsequent runs get the upgrade.
///   5. Homebrew legacy `ggml-base.en.bin`. Same background-upgrade hook.
///   6. Block and download turbo to the cache dir (first-run path).
pub async fn ensure_whisper_model() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("SUNNY_WHISPER_MODEL") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            log_selected_model(&pb, "SUNNY_WHISPER_MODEL override");
            return Ok(pb);
        }
    }

    let cache_dir = whisper_cache_dir()?;

    // 2. Preferred: cached turbo model (sanity-check size to catch partial
    //    downloads from a prior crash).
    let cached_turbo = cache_dir.join(TURBO_MODEL);
    if is_valid_turbo(&cached_turbo) {
        log_selected_model(&cached_turbo, "cached turbo");
        return Ok(cached_turbo);
    }
    // If there's a suspiciously-small turbo file sitting there, delete it so
    // the download path below can try again cleanly.
    if cached_turbo.is_file() && !is_valid_turbo(&cached_turbo) {
        let _ = std::fs::remove_file(&cached_turbo);
    }

    // 3. Homebrew-installed turbo.
    let brew_turbo = PathBuf::from(format!("/opt/homebrew/share/whisper-cpp/{TURBO_MODEL}"));
    if brew_turbo.is_file() {
        log_selected_model(&brew_turbo, "homebrew turbo");
        return Ok(brew_turbo);
    }
    let brew_turbo_usr = PathBuf::from(format!("/usr/local/share/whisper-cpp/{TURBO_MODEL}"));
    if brew_turbo_usr.is_file() {
        log_selected_model(&brew_turbo_usr, "homebrew turbo");
        return Ok(brew_turbo_usr);
    }

    // 4. Cached legacy base.en — good enough, schedule a turbo upgrade for
    //    next run and return immediately so first-run UX isn't blocked on a
    //    1.6 GB download.
    let cached_base = cache_dir.join(BASE_MODEL);
    if cached_base.is_file() {
        spawn_turbo_upgrade(cache_dir.clone());
        log_selected_model(&cached_base, "cached base.en (turbo upgrade scheduled)");
        return Ok(cached_base);
    }

    // 5. Homebrew-installed legacy base.en.
    // Note: we deliberately skip `for-tests-ggml-tiny.bin` that Homebrew
    // ships — it's a dummy, untrained model that returns empty transcripts.
    let brew_base: [PathBuf; 2] = [
        PathBuf::from(format!("/opt/homebrew/share/whisper-cpp/{BASE_MODEL}")),
        PathBuf::from(format!("/usr/local/share/whisper-cpp/{BASE_MODEL}")),
    ];
    for p in brew_base.iter() {
        if p.is_file() {
            spawn_turbo_upgrade(cache_dir.clone());
            log_selected_model(p, "homebrew base.en (turbo upgrade scheduled)");
            return Ok(p.clone());
        }
    }

    // 6. First run with nothing on disk — block and download the turbo model.
    //    If that fails (offline / HF unreachable), fall back to downloading
    //    the tiny base.en so the user still gets working transcription.
    log::info!("whisper: no model cached, downloading {TURBO_MODEL} (~1.6 GB)");
    match download_model_streaming(TURBO_MODEL, &cache_dir, TURBO_MIN_SIZE).await {
        Ok(path) => {
            log_selected_model(&path, "downloaded turbo");
            Ok(path)
        }
        Err(e) => {
            log::warn!("whisper: turbo download failed ({e}); falling back to {BASE_MODEL}");
            let path = download_model_streaming(BASE_MODEL, &cache_dir, 0).await?;
            log_selected_model(&path, "downloaded base.en (turbo fallback)");
            Ok(path)
        }
    }
}

/// Size-check a cached turbo file. A zero-byte or truncated partial download
/// from a prior crash is rejected so we re-fetch cleanly.
fn is_valid_turbo(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() >= TURBO_MIN_SIZE)
        .unwrap_or(false)
}

/// Log which model was selected and where, exactly once per process.
fn log_selected_model(path: &Path, reason: &str) {
    if LOGGED_MODEL.swap(true, Ordering::Relaxed) {
        return;
    }
    log::info!("whisper model: {} ({reason})", path.display());
}

/// Stream-download a whisper.cpp GGML model into `cache_dir` and atomically
/// install it. Logs progress every 10 MB via `log::info!`. `min_size_hint`
/// is the smallest acceptable final size (0 to skip the check); a result
/// smaller than this is treated as a truncated download and deleted.
async fn download_model_streaming(
    name: &str,
    cache_dir: &Path,
    min_size_hint: u64,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|e| format!("create cache dir: {e}"))?;
    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{name}"
    );
    let req = crate::http::client().get(&url);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("download {name}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "download {name}: HTTP {} (set SUNNY_WHISPER_MODEL to a local ggml-*.bin)",
            resp.status()
        ));
    }
    let total = resp.content_length();

    let final_path = cache_dir.join(name);
    let tmp = cache_dir.join(format!("{name}.part"));
    // Best-effort cleanup of any stale partial from a prior crash.
    let _ = tokio::fs::remove_file(&tmp).await;
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("create {name}.part: {e}"))?;

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut next_log: u64 = 10 * 1024 * 1024; // first log at 10 MB

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download {name}: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write {name}.part: {e}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded >= next_log {
            let mb = downloaded / (1024 * 1024);
            match total {
                Some(t) if t > 0 => {
                    let pct = (downloaded as f64 / t as f64) * 100.0;
                    let total_mb = t / (1024 * 1024);
                    log::info!(
                        "whisper: downloading {name} — {mb} / {total_mb} MB ({pct:.1}%)"
                    );
                }
                _ => log::info!("whisper: downloading {name} — {mb} MB"),
            }
            next_log = next_log.saturating_add(10 * 1024 * 1024);
        }
    }

    file.flush().await.map_err(|e| format!("flush {name}.part: {e}"))?;
    drop(file);

    if min_size_hint > 0 && downloaded < min_size_hint {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!(
            "download {name} truncated: got {} bytes, expected >= {}",
            downloaded, min_size_hint
        ));
    }

    tokio::fs::rename(&tmp, &final_path)
        .await
        .map_err(|e| format!("finalize {name}: {e}"))?;
    log::info!("whisper: downloaded {name} ({downloaded} bytes) to {}", final_path.display());
    Ok(final_path)
}

/// Fire-and-forget: once a legacy base.en model is resolved, grab the turbo
/// model in the background so the next run auto-upgrades. Idempotent — a
/// second call in the same process is a cheap no-op.
fn spawn_turbo_upgrade(cache_dir: PathBuf) {
    if TURBO_UPGRADE_SPAWNED.swap(true, Ordering::Relaxed) {
        return;
    }
    tokio::spawn(async move {
        let target = cache_dir.join(TURBO_MODEL);
        if is_valid_turbo(&target) {
            return;
        }
        // Remove a stale partial so the download starts fresh.
        if target.is_file() && !is_valid_turbo(&target) {
            let _ = tokio::fs::remove_file(&target).await;
        }
        log::info!("whisper: background turbo upgrade starting");
        match download_model_streaming(TURBO_MODEL, &cache_dir, TURBO_MIN_SIZE).await {
            Ok(p) => log::info!("whisper: turbo upgrade complete at {}", p.display()),
            Err(e) => log::warn!("whisper: turbo upgrade failed: {e}"),
        }
    });
}

fn whisper_cache_dir() -> Result<PathBuf, String> {
    let base = dirs::cache_dir().ok_or("no user cache dir")?;
    Ok(base.join("sunny").join("whisper"))
}

pub async fn openclaw_ping() -> Result<bool, String> {
    let bin = match crate::paths::which("openclaw") {
        Some(p) => p,
        None => return Ok(false),
    };
    let mut cmd = Command::new(&bin);
    cmd.arg("--version");
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("openclaw: {e}"))?;
    Ok(out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{SampleFormat, WavSpec, WavWriter};

    #[test]
    fn hallucination_filter_catches_known_tokens() {
        assert!(is_whisper_hallucination("you"));
        assert!(is_whisper_hallucination("You"));
        assert!(is_whisper_hallucination("  You.  "));
        assert!(is_whisper_hallucination("Thank you for watching."));
        assert!(is_whisper_hallucination("[music]"));
        assert!(is_whisper_hallucination("."));
    }

    #[test]
    fn hallucination_filter_allows_real_speech() {
        assert!(!is_whisper_hallucination(""));
        assert!(!is_whisper_hallucination("hello sunny"));
        assert!(!is_whisper_hallucination("what's on my calendar"));
        // "you" as a substring inside a real sentence must pass through.
        assert!(!is_whisper_hallucination("thank you for the update"));
        assert!(!is_whisper_hallucination("you were right about that"));
    }

    fn write_silent_wav(path: &std::path::Path, samples: usize) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut w = WavWriter::create(path, spec).unwrap();
        for _ in 0..samples {
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
    }

    fn write_tone_wav(path: &std::path::Path, samples: usize, amplitude: f32) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut w = WavWriter::create(path, spec).unwrap();
        for i in 0..samples {
            let s = (amplitude * (2.0 * std::f32::consts::PI * 440.0 * (i as f32) / 16_000.0).sin()
                * i16::MAX as f32) as i16;
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn wav_rms_silent_file_below_floor() {
        let dir = std::env::temp_dir();
        let path = dir.join("sunny-audio-test-silence.wav");
        write_silent_wav(&path, 16_000);
        let rms = wav_rms(path.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(rms < MIN_RMS_FOR_SPEECH, "silent WAV should be below speech floor; got {rms}");
    }

    #[test]
    fn wav_rms_loud_tone_above_floor() {
        let dir = std::env::temp_dir();
        let path = dir.join("sunny-audio-test-tone.wav");
        write_tone_wav(&path, 16_000, 0.3);
        let rms = wav_rms(path.to_str().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(rms > MIN_RMS_FOR_SPEECH, "loud tone should exceed speech floor; got {rms}");
    }
}
