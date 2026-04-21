//! Native audio capture with simultaneous WAV write + RMS level emission.
//!
//! Replaces the `sox` / `ffmpeg` subprocess path with in-process `cpal`
//! capture. Two sinks share a single input stream:
//!
//! 1. A 16 kHz mono 16-bit WAV file — what `whisper-cli` transcribes after
//!    the user stops recording.
//! 2. `sunny://voice.level` Tauri events (emitted at most every ~50 ms) with
//!    a 0..1 RMS value the frontend thresholds for voice-activity
//!    detection. Replaces the WebAudio / `getUserMedia` analyser that used
//!    to fight the Rust-side recorder for the same mic.
//!
//! One owner, one capture — no more macOS mic-contention stalls.
//!
//! Threading note: `cpal::Stream` is `!Send`, so the stream lives on a
//! dedicated OS thread that we spawn from `start`. The thread blocks on a
//! one-shot `stop` channel; `stop()` sends the signal and joins. The
//! `Recorder` wrapper in `audio.rs` holds the resulting handle behind a
//! `Mutex<Option<_>>` so it never crosses threads directly.

use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use tauri::{AppHandle, Emitter};

/// Ring buffer holding the last 500 ms of 16 kHz mono i16 audio (8000
/// samples). Populated by the permanent pre-roll stream started at app
/// launch and snapshotted at the start of every recording so the first
/// word spoken *before* the press-to-talk key lands in the WAV too.
///
/// `OnceLock` so `init_preroll` is idempotent — multiple calls during
/// startup or from tests are safe.
static PRE_ROLL: OnceLock<Arc<Mutex<VecDeque<i16>>>> = OnceLock::new();

/// 500 ms @ 16 kHz mono = 8000 samples. Chosen empirically: long enough
/// to catch a pre-press word ("hey sunny, …") but short enough that stale
/// background noise from minutes ago isn't smuggled into the transcript.
const PRE_ROLL_SAMPLES: usize = 8_000;

/// Audio sample rate the capture path resamples to. Whisper is trained
/// on 16 kHz; anything else would require a runtime resample in the
/// transcribe step.
const TARGET_RATE_HZ: u32 = 16_000;

// ---------------------------------------------------------------------------
// Central VAD config
// ---------------------------------------------------------------------------
//
// Before this block the three VAD knobs were scattered across audio.rs
// (silence RMS floor, via `MIN_RMS_FOR_SPEECH` + `SUNNY_SILENCE_RMS`
// override) and audio_capture.rs (pre-roll sample count as `PRE_ROLL_SAMPLES`
// minus the conversion-to-ms math) with `silence_hold_ms` living only on
// the frontend. Reading "what does SUNNY consider silence right now?"
// meant reading three files. This module is now the single source of
// truth — call `current_vad_config()` and get every knob.
//
// Behaviour is unchanged: `silence_rms` honours `SUNNY_SILENCE_RMS` if
// set (matching `audio.rs::transcribe`), `preroll_ms` is derived from
// `PRE_ROLL_SAMPLES`, and `silence_hold_ms` is the 900 ms default the
// frontend VAD has been reading as the contract all along (documented
// at `process_samples` where the 50 ms emit cadence references it).

/// VAD operating mode. `PushToTalk` is the current default — VAD gates
/// the tail of a push-to-talk utterance. `WakeWord` is reserved for a
/// future always-on path; `current_vad_config` does NOT switch on this
/// today, but threading it through the struct now means the accessor
/// surface is stable when that work lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadMode {
    PushToTalk,
    /// Reserved — not yet switched on by `current_vad_config`. Declared
    /// so the enum has a stable shape before the wake-word path lands.
    #[allow(dead_code)]
    WakeWord,
}

impl VadMode {
    /// Stable wire name surfaced to the Diagnostics page. Lower-case so
    /// the TS side can compare with `===` against a literal.
    pub fn as_str(self) -> &'static str {
        match self {
            VadMode::PushToTalk => "push_to_talk",
            VadMode::WakeWord => "wake_word",
        }
    }
}

/// Single-source-of-truth VAD configuration. Read via
/// [`current_vad_config`]; each field has a stable semantic:
///
/// * `silence_rms` — RMS floor below which the captured WAV is treated
///   as silence (whisper is skipped). Honours `SUNNY_SILENCE_RMS`.
/// * `silence_hold_ms` — duration of sub-threshold audio the frontend
///   VAD requires before firing `onSilence`. 900 ms matches the
///   product-default documented in `process_samples`.
/// * `preroll_ms` — span of continuously-captured audio retained in the
///   pre-roll ring and stitched onto the front of every new recording.
///   Derived from `PRE_ROLL_SAMPLES` at the `TARGET_RATE_HZ` sample rate.
/// * `mode` — operating mode; today always `PushToTalk`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VadConfig {
    pub silence_rms: f32,
    pub silence_hold_ms: u32,
    pub preroll_ms: u32,
    pub mode: VadMode,
}

/// RMS threshold below which the captured WAV is treated as silence.
/// 0.005 ≈ -46 dBFS — well below normal speech (-20 to -10 dBFS) but
/// above typical room tone (-60 dBFS and quieter). This mirrors the
/// constant in `audio.rs::MIN_RMS_FOR_SPEECH` — they remain in sync
/// because both resolve the same env override and pick the same
/// default. The duplicate constant here is intentional: it keeps
/// audio_capture.rs standalone (no upward crate dependency on audio.rs)
/// while the VadConfig accessor ensures operators read one value.
const DEFAULT_SILENCE_RMS: f32 = 0.005;

/// Frontend VAD hold window. 900 ms is the default that ships in
/// `useVoiceChat.ts`; exposing it here makes the Diagnostics page agree
/// with what the pipeline actually runs, rather than guessing.
const DEFAULT_SILENCE_HOLD_MS: u32 = 900;

/// Resolve the current VAD config by reading environment overrides and
/// constants. Cheap — no locks, no allocation beyond the env lookup.
/// Safe to call on every Diagnostics poll.
///
/// Behaviour preserved: the `SUNNY_SILENCE_RMS` override path matches
/// `audio.rs::transcribe`, so setting that env var still suppresses the
/// silence gate without touching any further config surface.
pub fn current_vad_config() -> VadConfig {
    let silence_rms = std::env::var("SUNNY_SILENCE_RMS")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(DEFAULT_SILENCE_RMS);
    // preroll_ms = PRE_ROLL_SAMPLES / TARGET_RATE_HZ * 1000. Done with
    // u32 math since the buffer is small enough that a u64 intermediate
    // doesn't buy anything.
    let preroll_ms = ((PRE_ROLL_SAMPLES as u64 * 1000) / TARGET_RATE_HZ as u64) as u32;
    VadConfig {
        silence_rms,
        silence_hold_ms: DEFAULT_SILENCE_HOLD_MS,
        preroll_ms,
        mode: VadMode::PushToTalk,
    }
}

/// Holds the permanent pre-roll stream alive for the lifetime of the app.
/// `cpal::Stream` is `!Send`, so the stream itself lives on the dedicated
/// OS thread spawned by `init_preroll`; this flag just ensures we never
/// spin up a second pre-roll thread. Dropping the thread/stream on app
/// exit lets CoreAudio release the mic gracefully.
static PRE_ROLL_STARTED: OnceLock<()> = OnceLock::new();

/// Shared WAV writer type — wrapped in an `Arc<Mutex<_>>` so the cpal
/// input callback (which runs on a high-priority audio thread) can append
/// samples while the stop path finalizes the header.
type SharedWriter = Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>;

/// Handle owned by the caller (`Recorder` in `audio.rs`). Keeping the
/// cpal stream inside a dedicated thread means this struct itself is
/// trivially `Send`.
pub struct CaptureHandle {
    /// Channel used to tell the capture thread to stop. Sending `()`
    /// triggers WAV finalization and stream shutdown on the audio thread.
    stop_tx: Sender<()>,
    /// Join handle for the capture thread. `stop()` joins it so we know
    /// the WAV file is fully flushed before whisper-cli is spawned.
    thread: Option<JoinHandle<Result<(), String>>>,
    /// Path to the finalized WAV file. Returned from `stop()`.
    wav_path: String,
    /// Timer for `RecordStatus::seconds` so the UI can show "recording
    /// for N seconds" without us maintaining a separate clock.
    pub started_at: Instant,
}

impl CaptureHandle {
    pub fn wav_path(&self) -> &str {
        &self.wav_path
    }
}

/// Lazy accessor for the shared pre-roll ring buffer. Allocates the
/// VecDeque the first time it's touched so the buffer exists even if
/// `init_preroll` never ran (e.g. mic denied) — `start()` can still
/// safely call `snapshot_preroll` and get back an empty Vec.
fn preroll_buffer() -> Arc<Mutex<VecDeque<i16>>> {
    PRE_ROLL
        .get_or_init(|| Arc::new(Mutex::new(VecDeque::with_capacity(PRE_ROLL_SAMPLES))))
        .clone()
}

/// Append resampled 16 kHz mono i16 samples into the ring, dropping the
/// oldest samples when the buffer is full. Called from the pre-roll
/// stream's audio callback — kept tiny (no allocation in the steady
/// state) because cpal forbids blocking the audio thread.
fn push_preroll(samples: &[i16]) {
    if samples.is_empty() {
        return;
    }
    let buf = preroll_buffer();
    let Ok(mut guard) = buf.lock() else {
        return;
    };
    // Fast-path for the common case where the incoming chunk is larger
    // than a full ring: just replace with the tail of `samples`.
    if samples.len() >= PRE_ROLL_SAMPLES {
        guard.clear();
        let start = samples.len() - PRE_ROLL_SAMPLES;
        guard.extend(&samples[start..]);
        return;
    }
    let overflow = (guard.len() + samples.len()).saturating_sub(PRE_ROLL_SAMPLES);
    for _ in 0..overflow {
        guard.pop_front();
    }
    guard.extend(samples.iter().copied());
}

/// Take a snapshot of the ring buffer contents in chronological order
/// (oldest first). Returns an empty Vec when the pre-roll stream never
/// started or the buffer happens to be empty.
fn snapshot_preroll() -> Vec<i16> {
    let buf = preroll_buffer();
    let guard = match buf.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    guard.iter().copied().collect()
}

/// Public init — spin up a permanent background cpal input stream that
/// continuously feeds the pre-roll ring buffer. Idempotent: safe to
/// call multiple times (subsequent calls are no-ops). Never returns an
/// error — a missing mic or TCC denial logs a warning and leaves the
/// ring buffer empty, which is harmless (snapshots just come back
/// empty and `start()` behaves exactly as before).
pub fn init_preroll(_app: AppHandle) {
    if PRE_ROLL_STARTED.set(()).is_err() {
        return;
    }
    // Materialize the buffer so the first recording can snapshot even
    // if the stream fails to open.
    let _ = preroll_buffer();

    let spawn_result = std::thread::Builder::new()
        .name("sunny-audio-preroll".into())
        .spawn(move || {
            if let Err(e) = run_preroll_stream() {
                log::warn!("[audio] pre-roll stream unavailable: {e}");
            }
        });
    if let Err(e) = spawn_result {
        log::warn!("[audio] pre-roll thread spawn failed: {e}");
    }
}

/// Body of the pre-roll thread. Opens a cpal input stream on the
/// default device, resamples each callback chunk to 16 kHz mono i16,
/// and pushes into the ring buffer. Blocks forever — the thread exits
/// only when the process does, at which point dropping the stream
/// releases the mic cleanly.
fn run_preroll_stream() -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("default_input_config: {e}"))?;
    let native_rate = supported.sample_rate().0;
    let native_channels = supported.channels();
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    const TARGET_RATE: u32 = 16_000;

    let err_cb = |err: cpal::StreamError| {
        log::warn!("[audio] pre-roll stream error: {err}");
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mono = downmix_f32(data, native_channels);
                    let resampled = if native_rate == TARGET_RATE {
                        mono
                    } else {
                        linear_resample(&mono, native_rate, TARGET_RATE)
                    };
                    let i16s: Vec<i16> = resampled
                        .iter()
                        .map(|&s| {
                            (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16
                        })
                        .collect();
                    push_preroll(&i16s);
                    // Hook 2: wake-word + always-on-buffer sample feeds.
                    // Guard: no-op when wake-word listener is not initialised or
                    // settings.wake_word.enabled is false (default).
                    if crate::voice::wake_word::is_enabled() {
                        crate::voice::wake_word::push_samples(&resampled);
                        crate::voice::always_on_buffer::push_samples(&resampled);
                    }
                },
                err_cb,
                None,
            )
            .map_err(|e| format!("build pre-roll stream (f32): {e}"))?,
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let scale = 1.0 / i16::MAX as f32;
                    let floats: Vec<f32> = data.iter().map(|&s| s as f32 * scale).collect();
                    let mono = downmix_f32(&floats, native_channels);
                    let resampled = if native_rate == TARGET_RATE {
                        mono
                    } else {
                        linear_resample(&mono, native_rate, TARGET_RATE)
                    };
                    let i16s: Vec<i16> = resampled
                        .iter()
                        .map(|&s| {
                            (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16
                        })
                        .collect();
                    push_preroll(&i16s);
                    // Hook 2: wake-word + always-on-buffer sample feeds.
                    // Guard: no-op when wake-word listener is not initialised or
                    // settings.wake_word.enabled is false (default).
                    if crate::voice::wake_word::is_enabled() {
                        crate::voice::wake_word::push_samples(&resampled);
                        crate::voice::always_on_buffer::push_samples(&resampled);
                    }
                },
                err_cb,
                None,
            )
            .map_err(|e| format!("build pre-roll stream (i16): {e}"))?,
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                &config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let scale = 1.0 / i16::MAX as f32;
                    let floats: Vec<f32> = data
                        .iter()
                        .map(|&s| ((s as i32 - 32768) as f32) * scale)
                        .collect();
                    let mono = downmix_f32(&floats, native_channels);
                    let resampled = if native_rate == TARGET_RATE {
                        mono
                    } else {
                        linear_resample(&mono, native_rate, TARGET_RATE)
                    };
                    let i16s: Vec<i16> = resampled
                        .iter()
                        .map(|&s| {
                            (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16
                        })
                        .collect();
                    push_preroll(&i16s);
                    // Hook 2: wake-word + always-on-buffer sample feeds.
                    // Guard: no-op when wake-word listener is not initialised or
                    // settings.wake_word.enabled is false (default).
                    if crate::voice::wake_word::is_enabled() {
                        crate::voice::wake_word::push_samples(&resampled);
                        crate::voice::always_on_buffer::push_samples(&resampled);
                    }
                },
                err_cb,
                None,
            )
            .map_err(|e| format!("build pre-roll stream (u16): {e}"))?,
        other => return Err(format!("unsupported sample format: {other:?}")),
    };

    stream.play().map_err(|e| format!("pre-roll play: {e}"))?;
    log::info!("[audio] pre-roll ring buffer online (500 ms @ 16 kHz)");

    // Park the thread forever. Dropping `stream` on process exit stops
    // the IOProc cleanly; there's no explicit kill_on_drop flag in cpal
    // — the Stream's Drop impl calls AudioOutputUnitStop on macOS.
    loop {
        std::thread::park();
    }
}

/// Start capture. Returns immediately with a handle; the actual audio
/// stream lives on a dedicated thread.
pub fn start(app: AppHandle) -> Result<CaptureHandle, String> {
    // Build the output WAV path up front so both threads see the same one.
    let wav_path = std::env::temp_dir()
        .join(format!("sunny-mic-{}.wav", chrono::Utc::now().timestamp()))
        .to_string_lossy()
        .into_owned();

    // One-shot stop channel. Unbounded because the audio thread only
    // checks it once per callback tick; we never send more than once.
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    // Ready channel — the capture thread signals success (or a startup
    // error) so `start()` can return `Err` without the caller ever
    // seeing a zombie handle.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let wav_path_thread = wav_path.clone();
    let thread = std::thread::Builder::new()
        .name("sunny-audio-capture".into())
        .spawn(move || capture_thread(app, wav_path_thread, stop_rx, ready_tx))
        .map_err(|e| format!("spawn capture thread: {e}"))?;

    // Wait for the thread to either finish its cpal setup or bail out.
    // 3 seconds is a generous ceiling — cpal setup is normally
    // near-instant; any longer means the default device is wedged.
    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = thread.join();
            return Err(e);
        }
        Err(e) => {
            // Capture thread never reported back. Leave it to exit on its
            // own — we can't synchronously kill it — but fail the call.
            return Err(format!("capture thread timed out: {e}"));
        }
    }

    Ok(CaptureHandle {
        stop_tx,
        thread: Some(thread),
        wav_path,
        started_at: Instant::now(),
    })
}

/// Stop capture and finalize the WAV file. Returns the WAV path on
/// success. Safe to call exactly once per `CaptureHandle`.
pub fn stop(mut handle: CaptureHandle) -> Result<String, String> {
    // Best-effort: the receiver may already be gone if the stream errored.
    let _ = handle.stop_tx.send(());
    if let Some(t) = handle.thread.take() {
        match t.join() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("capture thread panicked".into()),
        }
    }
    Ok(handle.wav_path)
}

/// Body of the capture thread. Builds the cpal stream, pumps samples
/// into both the WAV writer and the RMS-emit path, and blocks on
/// `stop_rx` until told to shut down. Returns once the WAV header is
/// finalized.
fn capture_thread(
    app: AppHandle,
    wav_path: String,
    stop_rx: Receiver<()>,
    ready_tx: Sender<Result<(), String>>,
) -> Result<(), String> {
    // --- Device + config ---------------------------------------------------
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let err = "no default input device (check macOS System Settings → Privacy → Microphone)".to_string();
            let _ = ready_tx.send(Err(err.clone()));
            return Err(err);
        }
    };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let err = format!("default_input_config: {e}");
            let _ = ready_tx.send(Err(err.clone()));
            return Err(err);
        }
    };
    let native_rate = supported.sample_rate().0;
    let native_channels = supported.channels();
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    // --- WAV writer --------------------------------------------------------
    const TARGET_RATE: u32 = 16_000;
    let spec = WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = match WavWriter::create(&wav_path, spec) {
        Ok(w) => w,
        Err(e) => {
            let err = format!("wav create: {e}");
            let _ = ready_tx.send(Err(err.clone()));
            return Err(err);
        }
    };

    // --- Pre-roll injection -----------------------------------------------
    // Snapshot the last ~500 ms of continuously captured mic audio and
    // write it as the first samples of this recording. This is what
    // kills the "first word eaten" bug — the user can start speaking
    // a fraction of a second before pressing Space and still have the
    // whole utterance land in the WAV. Empty when pre-roll never
    // started (mic denied / no device), in which case we degrade to
    // the old behaviour without an error.
    let preroll = snapshot_preroll();
    if !preroll.is_empty() {
        for &s in &preroll {
            // Swallow write errors — matching the policy of the live
            // callback below. A disk-full pre-roll just means a short
            // file, never a crash.
            let _ = writer.write_sample(s);
        }
        log::debug!(
            "[audio] pre-roll injected {} samples ({} ms)",
            preroll.len(),
            preroll.len() * 1000 / TARGET_RATE as usize
        );
    }

    let writer: SharedWriter = Arc::new(Mutex::new(Some(writer)));

    // --- Emit state --------------------------------------------------------
    // Timestamp of the last RMS event we emitted. Wrapped in a Mutex so
    // the audio callback (which captures this by move into a closure) can
    // mutate it without unsafe. `Arc` because we need a second handle for
    // the error branch below if we ever add one.
    let last_emit = Arc::new(Mutex::new(Instant::now()));
    let rms_accum = Arc::new(Mutex::new(0.0f32));
    let rms_count = Arc::new(Mutex::new(0u32));
    // Best-effort error flag — lets the main thread observe a stream
    // error from the audio callback without panicking the audio thread
    // (cpal forbids panics in the data callback).
    let stream_errored = Arc::new(AtomicBool::new(false));

    // Set by the input callback the first time it actually delivers
    // samples. `capture_thread` blocks (bounded 300 ms) on this flip
    // before signalling ready — otherwise `stream.play()` returns the
    // moment CoreAudio accepts the start, but the IOProc lags 20-200 ms
    // on macOS and the head of the utterance is lost. Classic head-
    // eating bug; this gate removes it without a ring buffer.
    let first_sample_seen = Arc::new(AtomicBool::new(false));

    // --- Build the stream --------------------------------------------------
    // cpal dispatches on sample format. Most macOS inputs report f32;
    // we handle i16 and u16 too for safety.
    let stream_result = match sample_format {
        cpal::SampleFormat::F32 => build_input_stream_f32(
            &device,
            &config,
            native_rate,
            native_channels,
            TARGET_RATE,
            writer.clone(),
            app.clone(),
            last_emit.clone(),
            rms_accum.clone(),
            rms_count.clone(),
            stream_errored.clone(),
            first_sample_seen.clone(),
        ),
        cpal::SampleFormat::I16 => build_input_stream_i16(
            &device,
            &config,
            native_rate,
            native_channels,
            TARGET_RATE,
            writer.clone(),
            app.clone(),
            last_emit.clone(),
            rms_accum.clone(),
            rms_count.clone(),
            stream_errored.clone(),
            first_sample_seen.clone(),
        ),
        cpal::SampleFormat::U16 => build_input_stream_u16(
            &device,
            &config,
            native_rate,
            native_channels,
            TARGET_RATE,
            writer.clone(),
            app.clone(),
            last_emit.clone(),
            rms_accum.clone(),
            rms_count.clone(),
            stream_errored.clone(),
            first_sample_seen.clone(),
        ),
        other => Err(format!("unsupported sample format: {other:?}")),
    };

    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            // Best-effort: finalize the empty WAV so we don't leave a
            // zero-byte file around.
            if let Ok(mut guard) = writer.lock() {
                if let Some(w) = guard.take() {
                    let _ = w.finalize();
                }
            }
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    if let Err(e) = stream.play() {
        if let Ok(mut guard) = writer.lock() {
            if let Some(w) = guard.take() {
                let _ = w.finalize();
            }
        }
        let err = format!("stream play: {e}");
        let _ = ready_tx.send(Err(err.clone()));
        return Err(err);
    }

    // Wait for the IOProc to fire at least once before signalling ready.
    // CoreAudio needs 20-200 ms to start delivering sample buffers after
    // `stream.play()`; without this gate the first ~100 ms of every
    // utterance is dropped and short words ("hello") transcribe as
    // silence, which whisper hallucinates into "you". 300 ms ceiling is
    // generous — typical warm-start is 5-30 ms.
    let ready_deadline = Instant::now() + Duration::from_millis(300);
    while !first_sample_seen.load(Ordering::Acquire) && Instant::now() < ready_deadline {
        std::thread::sleep(Duration::from_millis(5));
    }

    // All good — let `start()` return.
    let _ = ready_tx.send(Ok(()));

    // --- Run loop ----------------------------------------------------------
    // Block until told to stop. We poll on a short timeout so the thread
    // can notice stream errors without the caller explicitly stopping.
    loop {
        match stop_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(()) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if stream_errored.load(Ordering::Relaxed) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // --- Shutdown ----------------------------------------------------------
    // Grace window — the tail-ring counterpart to the pre-roll head-ring.
    //
    // Why: when the user releases Space, `audio_record_stop` fires
    // synchronously and we break out of the run loop above — but CoreAudio
    // typically has 20-80 ms of audio still sitting in its IOProc buffer
    // that hasn't been handed to our input callback yet. If we dropped the
    // stream immediately, that tail would be discarded and short trailing
    // words ("...today.", "...yeah.") would clip mid-phoneme, which
    // whisper then either drops or hallucinates past.
    //
    // How: leave the stream running for a short grace period so any
    // in-flight callback chunks land in the WAV via the normal
    // process_samples path. We watch `stream_errored` as a short-circuit
    // and cap the total wait at `GRACE_MAX_MS` (200 ms) so a wedged
    // IOProc can't stall finalize — the transcribe step downstream
    // cares about latency, so this ceiling is tight by design.
    wait_tail_grace(&stream_errored);

    // Dropping the stream stops the callback from firing; THEN finalize
    // the WAV header so any samples written during the grace window
    // above are included in the file.
    drop(stream);
    if let Ok(mut guard) = writer.lock() {
        if let Some(w) = guard.take() {
            w.finalize().map_err(|e| format!("wav finalize: {e}"))?;
        }
    }
    Ok(())
}

/// Parameters shared by the three `build_input_stream_*` helpers. A
/// newtype-ish struct would be cleaner, but the cpal closures borrow
/// each piece independently, so we just pass them by value.
#[allow(clippy::too_many_arguments)]
fn build_input_stream_f32(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    native_rate: u32,
    native_channels: u16,
    target_rate: u32,
    writer: SharedWriter,
    app: AppHandle,
    last_emit: Arc<Mutex<Instant>>,
    rms_accum: Arc<Mutex<f32>>,
    rms_count: Arc<Mutex<u32>>,
    stream_errored: Arc<AtomicBool>,
    first_sample_seen: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let err_flag = stream_errored.clone();
    let first_seen = first_sample_seen.clone();
    device
        .build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !data.is_empty() {
                    first_seen.store(true, Ordering::Release);
                }
                let mono = downmix_f32(data, native_channels);
                let resampled = if native_rate == target_rate {
                    mono
                } else {
                    linear_resample(&mono, native_rate, target_rate)
                };
                process_samples(
                    &resampled,
                    &writer,
                    &app,
                    &last_emit,
                    &rms_accum,
                    &rms_count,
                );
            },
            move |err| {
                log::warn!("audio_capture input stream error: {err}");
                err_flag.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| format!("build input stream (f32): {e}"))
}

#[allow(clippy::too_many_arguments)]
fn build_input_stream_i16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    native_rate: u32,
    native_channels: u16,
    target_rate: u32,
    writer: SharedWriter,
    app: AppHandle,
    last_emit: Arc<Mutex<Instant>>,
    rms_accum: Arc<Mutex<f32>>,
    rms_count: Arc<Mutex<u32>>,
    stream_errored: Arc<AtomicBool>,
    first_sample_seen: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let err_flag = stream_errored.clone();
    let first_seen = first_sample_seen.clone();
    device
        .build_input_stream(
            config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                if !data.is_empty() {
                    first_seen.store(true, Ordering::Release);
                }
                // Convert to f32 in [-1, 1] first, then downmix + resample.
                let scale = 1.0 / i16::MAX as f32;
                let floats: Vec<f32> = data.iter().map(|&s| s as f32 * scale).collect();
                let mono = downmix_f32(&floats, native_channels);
                let resampled = if native_rate == target_rate {
                    mono
                } else {
                    linear_resample(&mono, native_rate, target_rate)
                };
                process_samples(
                    &resampled,
                    &writer,
                    &app,
                    &last_emit,
                    &rms_accum,
                    &rms_count,
                );
            },
            move |err| {
                log::warn!("audio_capture input stream error: {err}");
                err_flag.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| format!("build input stream (i16): {e}"))
}

#[allow(clippy::too_many_arguments)]
fn build_input_stream_u16(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    native_rate: u32,
    native_channels: u16,
    target_rate: u32,
    writer: SharedWriter,
    app: AppHandle,
    last_emit: Arc<Mutex<Instant>>,
    rms_accum: Arc<Mutex<f32>>,
    rms_count: Arc<Mutex<u32>>,
    stream_errored: Arc<AtomicBool>,
    first_sample_seen: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let err_flag = stream_errored.clone();
    let first_seen = first_sample_seen.clone();
    device
        .build_input_stream(
            config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                if !data.is_empty() {
                    first_seen.store(true, Ordering::Release);
                }
                // Re-center u16 around 0 and normalize to [-1, 1].
                let scale = 1.0 / i16::MAX as f32;
                let floats: Vec<f32> =
                    data.iter().map(|&s| ((s as i32 - 32768) as f32) * scale).collect();
                let mono = downmix_f32(&floats, native_channels);
                let resampled = if native_rate == target_rate {
                    mono
                } else {
                    linear_resample(&mono, native_rate, target_rate)
                };
                process_samples(
                    &resampled,
                    &writer,
                    &app,
                    &last_emit,
                    &rms_accum,
                    &rms_count,
                );
            },
            move |err| {
                log::warn!("audio_capture input stream error: {err}");
                err_flag.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| format!("build input stream (u16): {e}"))
}

/// Write resampled mono samples to the WAV and throttle-emit an RMS
/// level event. Shared across the sample-format-specific builders.
fn process_samples(
    samples: &[f32],
    writer: &SharedWriter,
    app: &AppHandle,
    last_emit: &Arc<Mutex<Instant>>,
    rms_accum: &Arc<Mutex<f32>>,
    rms_count: &Arc<Mutex<u32>>,
) {
    if samples.is_empty() {
        return;
    }

    // --- WAV write -------------------------------------------------------
    // We hold the writer lock only while copying the chunk — the
    // callback runs on the audio thread so contention is rare, but
    // keeping the critical section tight avoids blocking `stop()`.
    if let Ok(mut guard) = writer.lock() {
        if let Some(w) = guard.as_mut() {
            for &s in samples {
                let clamped =
                    (s * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                // Swallowing write errors keeps the audio callback
                // panic-free; a disk-full scenario will show up as a
                // short recording rather than a crash.
                let _ = w.write_sample(clamped);
            }
        }
    }

    // --- RMS accumulation + throttled emit ------------------------------
    let mut sum_sq = 0.0f32;
    for &s in samples {
        sum_sq += s * s;
    }
    let len = samples.len() as u32;

    // Keep lock scopes minimal and ordered to avoid deadlocks: always
    // accum → count → last_emit.
    let accumulated;
    let counted;
    {
        let mut acc = match rms_accum.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        *acc += sum_sq;
        accumulated = *acc;
    }
    {
        let mut c = match rms_count.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        *c = c.saturating_add(len);
        counted = *c;
    }

    // Decide whether to emit. 50 ms is fast enough that the frontend
    // VAD silence window (default 900 ms) sees ~18 samples — plenty to
    // threshold against — while keeping the Tauri IPC load trivial.
    let should_emit = match last_emit.lock() {
        Ok(t) => t.elapsed() >= Duration::from_millis(50),
        Err(_) => false,
    };
    if !should_emit || counted == 0 {
        return;
    }

    let mean_sq = accumulated / counted as f32;
    let rms = mean_sq.sqrt().min(1.0);

    // Reset the accumulators before emitting so a slow IPC can't back
    // them up. Events are best-effort — if no listener is attached,
    // Tauri drops them quietly.
    if let Ok(mut acc) = rms_accum.lock() {
        *acc = 0.0;
    }
    if let Ok(mut c) = rms_count.lock() {
        *c = 0;
    }
    if let Ok(mut t) = last_emit.lock() {
        *t = Instant::now();
    }

    let _ = app.emit("sunny://voice.level", rms);
}

/// Downmix an interleaved multi-channel f32 buffer to mono by averaging
/// the channels of each frame. Returns the input unchanged when already
/// mono.
fn downmix_f32(data: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    let ch = channels as usize;
    data.chunks_exact(ch)
        .map(|c| c.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Target grace duration — how long we *aim* to leave the cpal stream
/// running after `stop_tx` fires so CoreAudio's IOProc can flush its
/// tail buffer (typically 20-80 ms). 120 ms gives comfortable headroom
/// over the typical CoreAudio tail without a user-noticeable delay.
const TAIL_GRACE_TARGET_MS: u64 = 120;

/// Absolute ceiling on the grace wait. If the IOProc is wedged or the
/// stream errored out silently, we must not block the transcribe step
/// forever. 200 ms is tight enough to stay well under the perceptible
/// ~300 ms "this app feels sluggish" threshold on the stop path.
const TAIL_GRACE_MAX_MS: u64 = 200;

/// Block for the tail grace window so in-flight audio callbacks can
/// finish writing into the WAV before we drop the stream.
///
/// Invariant: this function sleeps for at least `TAIL_GRACE_TARGET_MS`
/// (modulo early exit on `stream_errored`) and never longer than
/// `TAIL_GRACE_MAX_MS`. Extracted from `capture_thread` so it can be
/// unit-tested without spinning up cpal.
fn wait_tail_grace(stream_errored: &AtomicBool) -> Duration {
    let started = Instant::now();
    let target = Duration::from_millis(TAIL_GRACE_TARGET_MS);
    let ceiling = Duration::from_millis(TAIL_GRACE_MAX_MS);

    while started.elapsed() < target {
        if stream_errored.load(Ordering::Relaxed) {
            break;
        }
        // Slice the wait into ~10 ms chunks so the ceiling check
        // (and the error short-circuit) stays responsive and we never
        // overshoot `ceiling` by more than one slice.
        let remaining = target.saturating_sub(started.elapsed());
        let slice = remaining.min(Duration::from_millis(10));
        std::thread::sleep(slice);
        if started.elapsed() >= ceiling {
            break;
        }
    }
    started.elapsed()
}

/// Naive linear-interpolation resampler. Good enough for voice at the
/// cost of minor high-frequency roll-off — whisper is trained on 16 kHz
/// and is robust to modest artifacts. A real SRC (e.g. `rubato`) would
/// be strictly better but pulls in ~5x the code and startup cost.
fn linear_resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    // round() gives a slightly more accurate length than floor() when
    // `input.len() / ratio` falls near a half-sample boundary.
    let out_len = ((input.len() as f64) / ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Happy-path: no error flag — the grace wait should sleep for at
    /// least the target (120 ms) and never exceed the hard ceiling
    /// (200 ms + a small slice of scheduling slop).
    #[test]
    fn tail_grace_respects_target_and_ceiling() {
        let err_flag = AtomicBool::new(false);
        let elapsed = wait_tail_grace(&err_flag);

        let target = Duration::from_millis(TAIL_GRACE_TARGET_MS);
        // Allow 30 ms of OS scheduling slop above the 200 ms ceiling —
        // some CI runners (Linux containers, loaded macOS hosts) can
        // oversleep a 10 ms slice by a few ms.
        let ceiling_with_slop =
            Duration::from_millis(TAIL_GRACE_MAX_MS) + Duration::from_millis(30);

        assert!(
            elapsed >= target,
            "grace wait {elapsed:?} shorter than target {target:?}"
        );
        assert!(
            elapsed <= ceiling_with_slop,
            "grace wait {elapsed:?} exceeded ceiling {ceiling_with_slop:?}"
        );
    }

    /// If the stream errored mid-grace, we should short-circuit fast
    /// rather than waste the full 120 ms finalizing a dead stream.
    #[test]
    fn tail_grace_short_circuits_on_error() {
        let err_flag = AtomicBool::new(true);
        let elapsed = wait_tail_grace(&err_flag);

        // Pre-set error flag → loop should exit on the first check
        // without any sleep. Keep this lenient (50 ms) to tolerate
        // heavily loaded test runners.
        assert!(
            elapsed < Duration::from_millis(50),
            "error short-circuit took too long: {elapsed:?}"
        );
    }

    /// Sanity: the target must stay strictly below the ceiling,
    /// otherwise the ceiling check would be unreachable and a wedged
    /// IOProc could stall finalization.
    #[test]
    fn tail_grace_constants_are_sane() {
        assert!(TAIL_GRACE_TARGET_MS < TAIL_GRACE_MAX_MS);
        assert!(TAIL_GRACE_MAX_MS <= 200, "grace ceiling must stay tight");
    }
}
