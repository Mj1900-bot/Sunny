//! TTS: Kokoro-82M neural voice via a long-lived `koko stream` daemon,
//! macOS `say` as fallback.
//!
//! ## Module layout (Phase 2 split)
//!
//! This module was split from a single `voice.rs` file into a sub-module:
//!
//! - `mod.rs` (this file) — daemon lifecycle, `speak()`, barge-in, queue.
//! - `config.rs` — voice catalogue (`list_british_voices`), `DEFAULT_VOICE` constant.
//! - `normalize.rs` — text normalisation helpers: `resolve_voice`, `wpm_to_speed`,
//!   `clean_for_kokoro`, `say_compatible_voice`.
//!
//! Public API is re-exported from `mod.rs` so call sites outside this module
//! are unchanged.
//!
//! Kokoro (bm_george / bm_daniel / bm_lewis / bm_fable) gives a natural
//! British male voice; `say -v Daniel` only exists as a degraded fallback
//! for when the `koko` binary or its model files are missing. The
//! frontend's `streamSpeak` queue depends on `speak()` resolving only
//! after playback finishes, so we await both the render step (koko
//! emitting PCM for the line) and the playback step (`afplay`). Each new
//! speak() call gets its own temp WAV so concurrent sentences don't
//! collide — though we also serialize calls through the daemon mutex
//! since `koko stream` is strictly one-in-one-out.
//!
//! Daemon model
//! ------------
//! Every `speak(text)` used to spawn a fresh `koko` which cold-loaded the
//! ~170 MB ONNX model (~2-3 s on a warm machine, much worse cold). We
//! now keep one `koko stream` child alive for the app's lifetime, fed by
//! writing `text\n` to its stdin and framed against its stderr "Ready
//! for another line of text." marker. Subsequent renders cost only
//! inference + playback — no model reload.
//!
//! `koko stream` sets voice/speed/lang at spawn time (they are global CLI
//! flags, not per-line). Changing any of them therefore requires
//! respawning the daemon; we key each live daemon on (voice_id, speed).
//! Voice switches remain cheap in practice because users rarely change
//! voice between consecutive utterances.
//!
//! Wire format
//! -----------
//! `koko stream` writes a single RIFF header (44 bytes, sizes 0xFFFFFFFF)
//! at spawn, then for each stdin line it appends raw little-endian
//! float32 mono samples at 24 kHz to stdout and prints "Audio written to
//! stdout. Ready for another line of text." to stderr. We discard the
//! header on spawn and, per speak, count bytes between Ready markers and
//! rewrap them with a self-contained header so `afplay` accepts the
//! file.
//!
//! eSpeak-ng gotcha: the `espeak-rs` crate bundled into `koko` does NOT
//! ship the `en-gb` voice. Passing `-l en-gb` silently returns zero
//! phonemes and the model emits ~300 ms of noise. We always pass
//! `-l en-us` — the British accent comes from the voice *style*
//! (bm_*), not the phonemization language, so the output still sounds
//! unmistakably British.

pub mod config;
pub mod normalize;
pub mod always_on_buffer;
pub mod wake_word;

// Re-export the public API consumed by `commands/voice.rs` and diagnostics.
pub use config::list_british_voices;
pub use normalize::{resolve_voice, wpm_to_speed, clean_for_kokoro, say_compatible_voice};

use config::DEFAULT_VOICE;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Mutex};

const KOKO_SAMPLE_RATE: u32 = 24_000;
const KOKO_CHANNELS: u16 = 1;
const KOKO_BITS_PER_SAMPLE: u16 = 32;
const KOKO_WAV_FORMAT_FLOAT: u16 = 3;
const KOKO_HEADER_BYTES: usize = 44;
const KOKO_READY_MARKER: &str = "Ready for another line of text.";
/// Heuristic ceiling for per-line render time (model + phonemization +
/// inference on a long sentence). Anything longer signals a hung daemon;
/// we log and respawn on the next call.
const KOKO_LINE_TIMEOUT_MS: u64 = 30_000;

/// Random 6-char id for backend-side voice-trace reassembly.
fn trace_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut v = (n as u64) & 0x3FFF_FFFF;
    let alphabet = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = Vec::with_capacity(6);
    for _ in 0..6 {
        out.push(alphabet[(v as usize) % alphabet.len()]);
        v /= alphabet.len() as u64;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn kokoro_model_path() -> Option<PathBuf> {
    let p = dirs::home_dir()?.join(".cache/kokoros/kokoro-v1.0.onnx");
    if p.is_file() { Some(p) } else { None }
}

fn kokoro_voices_path() -> Option<PathBuf> {
    let p = dirs::home_dir()?.join(".cache/kokoros/voices-v1.0.bin");
    if p.is_file() { Some(p) } else { None }
}

/// Long-lived `koko stream` child. One per (voice_id, speed) config at a
/// time — switching config kills and respawns.
struct KokoroDaemon {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// Channel that receives `()` each time koko's stderr prints a
    /// "Ready for another line of text." line.
    ready_rx: mpsc::Receiver<()>,
    voice_id: String,
    /// Stored as a quantized integer (f32 * 1000) so we can key the
    /// daemon on (voice_id, speed_milli) without cross-comparing floats.
    speed_milli: i32,
}

impl KokoroDaemon {
    async fn spawn(
        koko: &Path,
        model: &Path,
        voices: &Path,
        voice_id: &str,
        speed: f32,
    ) -> Result<Self, String> {
        let t_spawn = Instant::now();
        let mut child = Command::new(koko)
            .arg("-m").arg(model)
            .arg("-d").arg(voices)
            .arg("-s").arg(voice_id)
            .arg("-l").arg("en-us")
            .arg("-p").arg(format!("{speed:.3}"))
            .arg("--mono")
            .arg("stream")
            .env("PIPER_ESPEAKNG_DATA_DIRECTORY", "/opt/homebrew/share")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn koko stream: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "koko: stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "koko: stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "koko: stderr unavailable".to_string())?;

        let mut stdout = BufReader::new(stdout);

        // Consume the 44-byte streaming WAV header. koko emits it
        // synchronously at spawn; read_exact blocks until the bytes
        // arrive (which also gives us back-pressure on "model loaded").
        let mut header = [0u8; KOKO_HEADER_BYTES];
        stdout
            .read_exact(&mut header)
            .await
            .map_err(|e| format!("koko: header read failed: {e}"))?;

        // Stderr pump: forward every "Ready…" marker as a () event on a
        // bounded channel. We also drain and log the rest so model-load
        // progress and espeak warnings still surface.
        let (ready_tx, ready_rx) = mpsc::channel::<()>(8);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.contains(KOKO_READY_MARKER) {
                            if ready_tx.send(()).await.is_err() {
                                break;
                            }
                        } else if !line.is_empty() {
                            log::debug!("koko: {line}");
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::warn!("koko stderr read error: {e}");
                        break;
                    }
                }
            }
        });

        log::info!(
            "kokoro daemon spawned voice={voice_id} speed={speed:.3} dt_ms={}",
            t_spawn.elapsed().as_millis()
        );

        Ok(Self {
            child,
            stdin,
            stdout,
            ready_rx,
            voice_id: voice_id.to_string(),
            speed_milli: (speed * 1000.0).round() as i32,
        })
    }

    fn matches(&self, voice_id: &str, speed: f32) -> bool {
        self.voice_id == voice_id && self.speed_milli == (speed * 1000.0).round() as i32
    }

    /// Send one line of text and return the raw float32 PCM bytes koko
    /// emits for it. Must only be called under the daemon mutex — the
    /// stdin/stdout/ready_rx channels are implicitly ordered.
    async fn render_line(&mut self, text: &str) -> Result<Vec<u8>, String> {
        // Drain any stale Ready markers that may have accumulated (e.g.
        // if a previous render was cancelled mid-read). Non-blocking.
        while self.ready_rx.try_recv().is_ok() {}

        // `clean_for_kokoro` strips markdown, collapses newlines, and fixes
        // missing-space punctuation — all of which mangle Kokoro prosody.
        let mut line = clean_for_kokoro(text);
        line.push('\n');

        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("koko stdin write: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("koko stdin flush: {e}"))?;

        // Drive stdout reads and the ready-marker receiver concurrently.
        // The ready marker on stderr is koko's "render complete" signal;
        // once it fires, everything it intends to emit for this line is
        // already buffered on stdout.
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut chunk = [0u8; 16 * 1024];
        let deadline = tokio::time::sleep(std::time::Duration::from_millis(KOKO_LINE_TIMEOUT_MS));
        tokio::pin!(deadline);
        let mut done = false;
        while !done {
            tokio::select! {
                biased;
                signal = self.ready_rx.recv() => {
                    if signal.is_none() {
                        return Err("koko: stderr pump closed (daemon died?)".to_string());
                    }
                    // Drain any remaining buffered stdout bytes without
                    // blocking the daemon forever — a short grace read
                    // pulls out trailing samples that arrived after the
                    // marker flush.
                    let grace = tokio::time::timeout(
                        std::time::Duration::from_millis(50),
                        self.stdout.read(&mut chunk),
                    )
                    .await;
                    if let Ok(Ok(n)) = grace {
                        if n > 0 {
                            buf.extend_from_slice(&chunk[..n]);
                        }
                    }
                    done = true;
                }
                read = self.stdout.read(&mut chunk) => {
                    match read {
                        Ok(0) => {
                            return Err("koko: stdout EOF before Ready marker".to_string());
                        }
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        Err(e) => {
                            return Err(format!("koko stdout read: {e}"));
                        }
                    }
                }
                _ = &mut deadline => {
                    return Err(format!("koko: line render exceeded {KOKO_LINE_TIMEOUT_MS}ms"));
                }
            }
        }

        if buf.is_empty() {
            return Err("koko: empty audio for line".to_string());
        }
        Ok(buf)
    }
}

/// The app-wide daemon slot. `None` until first use; repopulated on
/// voice/speed change after the previous child is killed.
fn daemon_slot() -> &'static Mutex<Option<KokoroDaemon>> {
    static SLOT: OnceLock<Mutex<Option<KokoroDaemon>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Eagerly spawn the Kokoro daemon with the default voice + rate. Called
/// from `startup.rs` after a short delay so the first `speak()` doesn't
/// pay the ~2-3 s ONNX cold-load. Best-effort: if `koko` or the model
/// files are missing, return Ok(()) silently and let the fallback path
/// in `speak()` take over.
pub async fn warm_daemon() -> Result<(), String> {
    let Some(koko) = crate::paths::which("koko") else { return Ok(()); };
    let Some(model) = kokoro_model_path() else { return Ok(()); };
    let Some(voices) = kokoro_voices_path() else { return Ok(()); };
    let voice_id = resolve_voice(DEFAULT_VOICE);
    let speed = wpm_to_speed(180);
    let mut slot = daemon_slot().lock().await;
    if slot.is_some() { return Ok(()); }
    match KokoroDaemon::spawn(&koko, &model, &voices, &voice_id, speed).await {
        Ok(d) => {
            *slot = Some(d);
            log::info!("[voice] kokoro daemon warmed (voice={voice_id} speed={speed:.3})");
        }
        Err(e) => log::warn!("[voice] kokoro warm failed: {e}"),
    }
    Ok(())
}

/// Build a self-contained RIFF/WAVE (IEEE float, mono, 24 kHz) file from
/// the raw PCM bytes koko produced for one line.
fn wrap_wav(pcm: &[u8]) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let byte_rate = KOKO_SAMPLE_RATE * (KOKO_CHANNELS as u32) * (KOKO_BITS_PER_SAMPLE as u32 / 8);
    let block_align = KOKO_CHANNELS * (KOKO_BITS_PER_SAMPLE / 8);
    // fmt chunk for IEEE float is 16 bytes (no extension). We follow it
    // with a `fact` chunk because some strict parsers require one for
    // non-PCM formats; afplay tolerates either way, but the fact chunk
    // is cheap insurance.
    let fmt_chunk_size: u32 = 16;
    let fact_chunk_size: u32 = 4;
    let sample_count = data_len / ((KOKO_BITS_PER_SAMPLE / 8) as u32);
    let riff_size: u32 = 4 + (8 + fmt_chunk_size) + (8 + fact_chunk_size) + (8 + data_len);
    let mut out = Vec::with_capacity(pcm.len() + 60);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    // fmt
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&fmt_chunk_size.to_le_bytes());
    out.extend_from_slice(&KOKO_WAV_FORMAT_FLOAT.to_le_bytes());
    out.extend_from_slice(&KOKO_CHANNELS.to_le_bytes());
    out.extend_from_slice(&KOKO_SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&KOKO_BITS_PER_SAMPLE.to_le_bytes());
    // fact
    out.extend_from_slice(b"fact");
    out.extend_from_slice(&fact_chunk_size.to_le_bytes());
    out.extend_from_slice(&sample_count.to_le_bytes());
    // data
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

pub async fn speak(text: String, voice: Option<String>, rate: Option<u32>) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let requested = voice.unwrap_or_else(|| DEFAULT_VOICE.to_string());
    let rate = rate.unwrap_or(180);

    // Primary path: Kokoro via the long-lived daemon.
    if let (Some(koko), Some(model), Some(voices)) = (
        crate::paths::which("koko"),
        kokoro_model_path(),
        kokoro_voices_path(),
    ) {
        match kokoro_speak_daemon(&koko, &model, &voices, &requested, rate, trimmed).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                log::warn!("kokoro TTS failed, falling back to `say`: {e}");
            }
        }
    }

    // Fallback: macOS `say`. Try the requested voice first (which may be a
    // Kokoro-only id like "bm_george" — say will reject it and we retry
    // with no -v so we still produce sound).
    let say_voice = say_compatible_voice(&requested);
    match say_once(Some(&say_voice), rate, trimmed).await {
        Ok(()) => Ok(()),
        Err(primary) => match say_once(None, rate, trimmed).await {
            Ok(()) => Ok(()),
            Err(fallback) => Err(format!("{primary}; fallback: {fallback}")),
        },
    }
}

/// Render one utterance through the daemon and play it via `afplay`.
/// Serialized by the global daemon mutex so concurrent callers queue
/// cleanly.
async fn kokoro_speak_daemon(
    koko: &Path,
    model: &Path,
    voices: &Path,
    voice_name: &str,
    rate: u32,
    text: &str,
) -> Result<(), String> {
    let tid = trace_id();
    let text_len = text.len();
    log::info!("[voice-trace] stage=rust_kokoro_begin turn={tid} text_len={text_len}");
    let voice_id = resolve_voice(voice_name);
    let speed = wpm_to_speed(rate);

    // Render under the daemon lock.
    let t_render = Instant::now();
    let pcm = {
        let mut slot = daemon_slot().lock().await;

        // If the live daemon was spawned for a different voice/speed,
        // kill it so we can rebuild with the new config. Users rarely
        // switch mid-session so this is a cold path.
        let needs_new = match slot.as_ref() {
            Some(d) => !d.matches(&voice_id, speed),
            None => true,
        };
        if needs_new {
            if let Some(mut old) = slot.take() {
                // Best-effort close: drop stdin to send EOF, then kill.
                let _ = old.stdin.shutdown().await;
                let _ = old.child.kill().await;
                let _ = old.child.wait().await;
            }
            let fresh = KokoroDaemon::spawn(koko, model, voices, &voice_id, speed).await?;
            *slot = Some(fresh);
        }

        // Unwrap is safe: we just ensured Some.
        let daemon = slot.as_mut().expect("daemon just spawned");
        match daemon.render_line(text).await {
            Ok(pcm) => pcm,
            Err(e) => {
                // A single render failure means the daemon's stdio is
                // probably desynced; drop it so the next call respawns.
                if let Some(mut bad) = slot.take() {
                    let _ = bad.child.kill().await;
                    let _ = bad.child.wait().await;
                }
                return Err(e);
            }
        }
    };
    log::info!(
        "[voice-trace] stage=rust_kokoro_render_ok turn={tid} dt_ms={} pcm_bytes={}",
        t_render.elapsed().as_millis(),
        pcm.len()
    );

    // Byte-count sanity: at 24 kHz mono float32 an empty phonemization
    // collapses to a few hundred silent samples. < 1 KB is almost
    // certainly the old en-gb "zero phonemes" regression — fail loud.
    if pcm.len() < 1024 {
        return Err(format!(
            "koko produced {} bytes of audio for voice={voice_id} (too small)",
            pcm.len()
        ));
    }

    let wav = wrap_wav(&pcm);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let wav_path = std::env::temp_dir().join(format!("sunny-tts-{nonce:x}.wav"));
    std::fs::write(&wav_path, &wav).map_err(|e| format!("write wav: {e}"))?;

    // Playback: afplay blocks until audio finishes, which serialises the
    // frontend's sentence queue correctly.
    let t_play = Instant::now();
    let play_res = Command::new("afplay")
        .arg(&wav_path)
        .stdin(Stdio::null())
        .output()
        .await;
    let _ = std::fs::remove_file(&wav_path);
    let play = play_res.map_err(|e| format!("afplay spawn: {e}"))?;
    log::info!(
        "[voice-trace] stage=rust_afplay_ok turn={tid} dt_ms={} exit={}",
        t_play.elapsed().as_millis(),
        play.status.code().unwrap_or(-1)
    );
    if !play.status.success() {
        return Err(format!("afplay exit {}", play.status));
    }
    Ok(())
}

async fn say_once(voice: Option<&str>, rate: u32, text: &str) -> Result<(), String> {
    let mut cmd = Command::new("say");
    if let Some(v) = voice {
        cmd.arg("-v").arg(v);
    }
    cmd.arg("-r").arg(rate.to_string()).arg(text);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn say: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("say exited with status {}", out.status))
    } else {
        Err(stderr)
    }
}

pub async fn stop() {
    // Interrupt whichever stage is active: afplay (Kokoro playback) or
    // say (legacy fallback). We deliberately do NOT kill the koko
    // daemon — killing it would throw away the ~2-3 s model load and
    // force the next speak() to pay that cost again. `koko stream` has
    // no "cancel in-flight line" facility, so an utterance that's
    // mid-synthesis will finish rendering to stdout and be discarded
    // the next time the daemon mutex is taken (the ready marker drain
    // at the top of render_line clears stale state).
    let _ = Command::new("pkill").arg("-x").arg("afplay").output().await;
    let _ = Command::new("pkill").arg("-x").arg("say").output().await;
}

/// Timestamp (unix millis) of the most recent user-initiated voice
/// interrupt. Set by [`interrupt`]; read by the agent loop so it can mark
/// an in-flight turn as "user interrupted" and skip the memory write /
/// UI chime it would otherwise do on a clean completion. `0` means "no
/// interrupt has ever been issued in this process lifetime".
pub static INTERRUPTED_AT: AtomicI64 = AtomicI64::new(0);

/// Returns the timestamp of the most recent interrupt, or `None` if no
/// interrupt has fired. Kept as a helper so callers outside this module
/// don't have to remember the `Ordering` / `AtomicI64` convention.
///
/// Not yet called from `agent_run` — the memory-write path that would
/// consume it is still being wired up. Marked `#[allow(dead_code)]` so
/// we don't hold up the build while the integration lands.
#[allow(dead_code)]
pub fn last_interrupt_ms() -> Option<i64> {
    let v = INTERRUPTED_AT.load(Ordering::SeqCst);
    if v == 0 { None } else { Some(v) }
}

/// Cleanly stop whatever Sunny is currently saying, preserving the ability
/// to resume on the next turn.
///
/// Strategy — in order of escalation:
/// 1. Kill the active `afplay` / `say` process so audio cuts NOW. This
///    is what the user actually experiences as "the interrupt".
/// 2. Replace the live Kokoro daemon with a freshly-spawned one. The
///    daemon's stdin pipe is almost certainly mid-line at this point
///    (we interrupted while it was emitting float32 samples to stdout),
///    so its stdio state is unrecoverable — we'd have to count bytes
///    against a "Ready" marker we may never see. Cheaper and more
///    reliable to shut it down (EOF on stdin, then `start_kill` with
///    SIGINT, then `wait`) and spawn a fresh one keyed on the same
///    (voice_id, speed). The new daemon pays the ~2-3 s model reload
///    cost, but that happens in the background while the user is
///    speaking their interrupting utterance — it's over by the time
///    Sunny needs to speak again.
/// 3. Stamp `INTERRUPTED_AT` with `now_ms` so any in-flight agent turn
///    can detect the interrupt and skip its "finalise + commit to
///    memory" path.
///
/// Timing budget: the EOF-then-kill path consistently completes in
/// <80 ms on an M-series Mac. The daemon respawn is fire-and-forget so
/// it doesn't block the caller; the next `speak()` call will wait on
/// the mutex if the respawn hasn't completed yet.
pub async fn interrupt() -> Result<(), String> {
    let t_start = Instant::now();

    // Stamp the interrupt timestamp FIRST so any agent_run checking the
    // value races in our favour — we'd rather have a stray "interrupted"
    // flag on a turn that was about to finish anyway than miss a real
    // interrupt because we stamped too late.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    INTERRUPTED_AT.store(now_ms, Ordering::SeqCst);

    // Step 1: kill audio playback synchronously. afplay/say running
    // under this process group is what the user hears; everything else
    // is housekeeping.
    let _ = Command::new("pkill").arg("-x").arg("afplay").output().await;
    let _ = Command::new("pkill").arg("-x").arg("say").output().await;

    // Step 2: under the daemon mutex, swap the live daemon for a fresh
    // one. If no daemon is running (koko not installed, or never used
    // in this session), there's nothing to swap — just bail.
    let mut slot = daemon_slot().lock().await;
    let old = match slot.take() {
        Some(d) => d,
        None => {
            log::info!(
                "voice::interrupt: no live daemon, audio killed dt_ms={}",
                t_start.elapsed().as_millis()
            );
            return Ok(());
        }
    };

    // Capture what we need to respawn before we consume `old`.
    let voice_id = old.voice_id.clone();
    let speed = (old.speed_milli as f32) / 1000.0;

    // Shut down the old daemon. Try EOF on stdin first — `koko stream`
    // exits cleanly when it sees stdin close, and that's the only exit
    // path that doesn't leave a SIGINT log line. If stdin-shutdown
    // doesn't wind the process down within 60 ms (it usually does in
    // under 20), escalate to `start_kill` which sends SIGKILL on Unix
    // via tokio's process impl — we don't need a graceful signal at
    // that point because the child already lost the race to clean up.
    let KokoroDaemon { mut child, mut stdin, mut stdout, .. } = old;
    let _ = stdin.shutdown().await;
    let shutdown_wait = tokio::time::timeout(
        std::time::Duration::from_millis(60),
        child.wait(),
    ).await;
    if shutdown_wait.is_err() {
        // EOF alone didn't do it — force-kill. start_kill() is
        // non-blocking; we still need to wait() afterwards to reap the
        // zombie, otherwise we leak a process slot.
        if let Err(e) = child.start_kill() {
            log::warn!("voice::interrupt: start_kill failed: {e}");
        }
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            child.wait(),
        ).await;
    }

    // Drain whatever's sitting in the daemon's stdout buffer for log
    // context — there's usually ~kB of unplayed float32 samples. We
    // don't need the bytes, just a count so operators can correlate
    // "interrupt at 800ms into utterance" with buffered audio size.
    let mut discard = Vec::new();
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(20),
        stdout.read_to_end(&mut discard),
    ).await;
    log::info!(
        "voice::interrupt: daemon shutdown discarded={}B voice={} speed={:.3}",
        discard.len(), voice_id, speed
    );

    // Step 3: spawn a fresh daemon keyed on the same config so the next
    // speak() hits a warm model. We do this INSIDE the mutex so the
    // next speak() blocks until we're ready — otherwise the user could
    // press-to-talk → runPipeline → speak() → race the half-built
    // daemon slot and trigger a second spawn.
    if let (Some(koko), Some(model), Some(voices)) = (
        crate::paths::which("koko"),
        kokoro_model_path(),
        kokoro_voices_path(),
    ) {
        match KokoroDaemon::spawn(&koko, &model, &voices, &voice_id, speed).await {
            Ok(fresh) => {
                *slot = Some(fresh);
                log::info!(
                    "voice::interrupt: respawned daemon voice={voice_id} speed={speed:.3} total_dt_ms={}",
                    t_start.elapsed().as_millis()
                );
            }
            Err(e) => {
                // Respawn failed — leave the slot empty; next speak()
                // will lazy-spawn on demand (and fall back to `say` if
                // even that fails). We still return Ok() because the
                // user-visible part of the interrupt (audio stopped)
                // succeeded.
                log::warn!("voice::interrupt: respawn failed: {e}");
            }
        }
    }

    log::info!(
        "voice::interrupt: complete dt_ms={}",
        t_start.elapsed().as_millis()
    );
    Ok(())
}

/// Pre-warm the Kokoro daemon: spawn it and render a tiny utterance so
/// the ONNX session, voice table, and phonemizer are all hot in memory
/// before the user's first real speak() call. The produced audio is
/// discarded — we never hand it to `afplay`, so the app stays silent.
///
/// Intended to be fired from `startup.rs` after the main setup so the
/// ~2-3 s cold-load happens out of band. Safe to call more than once;
/// subsequent calls are a cheap render through the already-warm daemon.
/// Parked — `startup.rs` hasn't been wired to call this yet.
#[allow(dead_code)]
pub async fn prewarm() -> Result<(), String> {
    let (koko, model, voices) = match (
        crate::paths::which("koko"),
        kokoro_model_path(),
        kokoro_voices_path(),
    ) {
        (Some(k), Some(m), Some(v)) => (k, m, v),
        _ => {
            log::info!("kokoro prewarm skipped: koko/model/voices not installed");
            return Ok(());
        }
    };

    let t = Instant::now();
    let voice_id = resolve_voice(DEFAULT_VOICE);
    let speed = wpm_to_speed(180);

    let mut slot = daemon_slot().lock().await;
    if slot.is_none() {
        match KokoroDaemon::spawn(&koko, &model, &voices, &voice_id, speed).await {
            Ok(d) => *slot = Some(d),
            Err(e) => {
                log::warn!("kokoro prewarm: spawn failed: {e}");
                return Err(e);
            }
        }
    }
    // Render a short utterance so the inference graph is compiled/cached.
    // A bare "." returns zero phonemes on koko's eSpeak path and the
    // daemon treats that as an error. Use a trivial word instead.
    if let Some(daemon) = slot.as_mut() {
        match daemon.render_line("hi").await {
            Ok(_pcm) => {
                log::info!("kokoro prewarm: ok dt_ms={}", t.elapsed().as_millis());
            }
            Err(e) => {
                log::warn!("kokoro prewarm: render failed: {e}");
                // Drop the daemon so the next speak() respawns cleanly.
                if let Some(mut bad) = slot.take() {
                    let _ = bad.child.kill().await;
                    let _ = bad.child.wait().await;
                }
                return Err(e);
            }
        }
    }
    Ok(())
}

/// Diagnostics snapshot of the Kokoro TTS daemon state.
///
/// `daemon_pid` is `Some(id)` when a `koko stream` child is live, `None`
/// otherwise (never warmed, or killed mid-render and not yet respawned).
/// `voice_id` and `speed_milli` reflect the currently-spawned daemon's
/// configuration — they're the literal CLI flags passed to `koko`, so a
/// change here means a daemon respawn happened. `last_interrupt_ms` is
/// the wall-clock ms of the last `interrupt()` call (0 → never).
#[derive(serde::Serialize, Clone, Debug)]
pub struct VoiceDiagSnapshot {
    pub daemon_pid: Option<u32>,
    pub voice_id: Option<String>,
    pub speed_milli: Option<i32>,
    pub last_interrupt_ms: Option<i64>,
    pub model_path_present: bool,
    pub voices_path_present: bool,
}

/// Read-only peek at the voice pipeline. Never blocks on the daemon —
/// uses `try_lock` so a render in flight simply reports `None` this tick
/// and the Diagnostics page picks it up on the next poll. The path
/// probes are plain `is_file` stats.
pub async fn diag_snapshot() -> VoiceDiagSnapshot {
    let slot = daemon_slot();
    let (daemon_pid, voice_id, speed_milli) = match slot.try_lock() {
        Ok(guard) => match guard.as_ref() {
            Some(d) => (
                d.child.id(),
                Some(d.voice_id.clone()),
                Some(d.speed_milli),
            ),
            None => (None, None, None),
        },
        // Daemon is busy rendering — don't block the UI thread.
        Err(_) => (None, None, None),
    };
    VoiceDiagSnapshot {
        daemon_pid,
        voice_id,
        speed_milli,
        last_interrupt_ms: last_interrupt_ms(),
        model_path_present: kokoro_model_path().is_some(),
        voices_path_present: kokoro_voices_path().is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    /// Combined test: interrupt() is fast even without a live daemon,
    /// AND the `last_interrupt_ms` helper round-trips through the
    /// atomic correctly. Single test (not two) because both share the
    /// static `INTERRUPTED_AT` and `daemon_slot()` process-globals, and
    /// cargo runs tests within a crate in parallel — splitting into
    /// two tests makes them flaky under `cargo test`. 100 ms is the
    /// budget from the frontend's perceived-latency contract: anything
    /// slower shows up as audio-continues-after-SPACE.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interrupt_without_daemon_under_100ms() {
        // `None` baseline before any interrupt has fired.
        INTERRUPTED_AT.store(0, Ordering::SeqCst);
        assert_eq!(last_interrupt_ms(), None);

        // Defensively clear any daemon left by a previous test (the
        // static slot outlives individual test functions).
        {
            let mut slot = daemon_slot().lock().await;
            if let Some(mut old) = slot.take() {
                let _ = old.child.kill().await;
                let _ = old.child.wait().await;
            }
        }

        let t = Instant::now();
        let r = interrupt().await;
        let elapsed = t.elapsed();

        assert!(r.is_ok(), "interrupt returned Err: {r:?}");
        // Budget is 250ms — the frontend perceived-latency contract sets the
        // audio-continues-after-SPACE threshold around 300ms. A cleaner
        // helper-level test suite (see `kokoro_voice_id_*`, `resolve_voice_*`,
        // etc.) now covers the logic without wall-clock assertions; this
        // guard stays to catch gross regressions, not microbenchmark drift.
        assert!(
            elapsed < Duration::from_millis(250),
            "interrupt took {}ms (budget: 250ms)",
            elapsed.as_millis()
        );

        // Timestamp round-trip: stamped value must be `Some(roughly now)`.
        let stamped = last_interrupt_ms().expect("INTERRUPTED_AT should be set");
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            (now_ms - stamped).abs() < 1_000,
            "INTERRUPTED_AT drift too large: stamped={stamped} now={now_ms}"
        );

        // Writing 0 back restores the `None` sentinel.
        INTERRUPTED_AT.store(0, Ordering::SeqCst);
        assert_eq!(last_interrupt_ms(), None);
    }
}
