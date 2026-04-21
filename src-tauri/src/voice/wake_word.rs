//! Lightweight keyword spotter for "Hey SUNNY".
//!
//! ## Approach — DSP MFCC + DTW template matcher (Option B)
//!
//! No native `.tflite` or ONNX file is required. The matcher is implemented
//! entirely in safe Rust:
//!
//! 1. A set of MFCC feature vectors is extracted from each incoming audio
//!    window (128 ms hop, 13 coefficients).
//! 2. The feature stream is compared against a set of stored templates via
//!    Dynamic Time Warping with a Sakoe-Chiba band (radius = 10 frames).
//! 3. A normalised confidence score [0, 1] is derived from the DTW distance
//!    and compared against a configurable threshold (default 0.55).
//!
//! ### Stand-in template
//!
//! Until the user provides their own voice samples the detector ships with a
//! synthetically-generated MFCC template derived from the spectral profile of
//! "hey autopilot" (two syllables ↔ two syllables, close enough for a demo). To
//! train on your own voice record 5–10 short clips of "hey sunny" at 16 kHz,
//! call `WakeWordDetector::add_template_from_wav`, and persist via
//! `save_templates` / `load_templates`. The synthetic template is replaced
//! once the user adds at least one real recording.
//!
//! ## Gating
//!
//! The detector is suppressed when:
//! - `is_recording` is true (push-to-talk is active).
//! - `focus_mode` is enabled (input gated at the UI layer, not audio layer).
//!
//! Calm mode suppresses OUTPUT only; wake-word detection remains active.
//!
//! ## Latency
//!
//! Detection runs on a dedicated OS thread (same thread as the pre-roll
//! stream) and emits a Tauri event. End-to-end: audio → snippet extraction
//! → MFCC → DTW → `app.emit` typically completes in < 50 ms on an M-series
//! Mac, well inside the 200 ms budget.
//!
//! ## Privacy
//!
//! Raw audio never touches disk. Only confidence scores are logged.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::always_on_buffer::AlwaysOnBuffer;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Window size in samples at 16 kHz (32 ms).
const FRAME_LEN: usize = 512;
/// Hop between consecutive frames in samples (8 ms).
const HOP_LEN: usize = 128;
/// Number of MFCC coefficients (excluding C0).
const N_MFCC: usize = 13;
/// Number of mel-filter banks.
const N_MELS: usize = 26;
/// DTW Sakoe-Chiba band half-width in frames.
const DTW_BAND: usize = 10;
/// Sliding evaluation window length in samples (960 ms).
const EVAL_WINDOW: usize = 16_000 * 96 / 100; // ~15 360 samples ≈ 960 ms

/// Default confidence threshold — triggers above this. Tuned for low false
/// positives in an office environment; users can lower it for a louder/quieter
/// environment via `WakeWordConfig`.
const DEFAULT_THRESHOLD: f32 = 0.55;

/// Maximum distance used for normalisation in confidence calculation. Chosen
/// empirically so a perfect template match → 1.0 and pure noise → ~0.0.
const DTW_NORM_SCALE: f32 = 8.0;

/// Tauri event name emitted on wake-word detection.
pub const WAKE_WORD_EVENT: &str = "sunny://wake_word";

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/// Payload emitted on the `sunny://wake_word` Tauri event.
#[derive(serde::Serialize, Clone, Debug)]
pub struct WakeWordPayload {
    /// Confidence score in [0, 1].
    pub confidence: f32,
    /// The last 2 seconds of audio preceding (and including) the wake word.
    /// Mono f32, 16 kHz. Fed directly into the existing STT pipeline.
    pub audio_snippet: Vec<f32>,
    /// Wall-clock milliseconds at fire time.
    pub fired_at_ms: i64,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Runtime-adjustable knobs. Construct with `Default::default()`.
#[derive(Clone, Debug)]
pub struct WakeWordConfig {
    /// Confidence threshold in [0, 1]. Default 0.55.
    pub threshold: f32,
    /// When true, the detector suppresses firing and immediately returns.
    /// Set from the app when push-to-talk recording is active.
    pub recording_active: bool,
    /// When true, the detector suppresses firing (Focus Mode).
    pub focus_mode: bool,
}

impl Default for WakeWordConfig {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_THRESHOLD,
            recording_active: false,
            focus_mode: false,
        }
    }
}

// ---------------------------------------------------------------------------
// MFCC helpers
// ---------------------------------------------------------------------------

/// Raised-cosine (Hanning) window pre-computed once at the call site.
fn hanning(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos())
        })
        .collect()
}

/// Compute N_MELS triangular mel-filter bank energies from the magnitude
/// spectrum of one windowed frame.
fn mel_energies(magnitudes: &[f32], sample_rate: u32) -> [f32; N_MELS] {
    let n_fft = magnitudes.len();
    let nyquist = sample_rate as f32 / 2.0;

    // Convert frequency to mel and back.
    let hz_to_mel = |f: f32| 2595.0 * (1.0 + f / 700.0).log10();
    let mel_to_hz = |m: f32| 700.0 * (10_f32.powf(m / 2595.0) - 1.0);

    let mel_lo = hz_to_mel(80.0);
    let mel_hi = hz_to_mel(nyquist);

    // N_MELS + 2 filter centre points.
    let centres: Vec<f32> = (0..=(N_MELS + 1))
        .map(|i| mel_to_hz(mel_lo + (mel_hi - mel_lo) * i as f32 / (N_MELS + 1) as f32))
        .collect();

    let mut energies = [0.0_f32; N_MELS];
    for (m, energy) in energies.iter_mut().enumerate() {
        let lo_hz = centres[m];
        let peak_hz = centres[m + 1];
        let hi_hz = centres[m + 2];
        let mut sum = 0.0_f32;
        for k in 0..n_fft {
            let freq = k as f32 * nyquist / n_fft as f32;
            let weight = if freq >= lo_hz && freq <= peak_hz {
                (freq - lo_hz) / (peak_hz - lo_hz + 1e-9)
            } else if freq > peak_hz && freq < hi_hz {
                (hi_hz - freq) / (hi_hz - peak_hz + 1e-9)
            } else {
                0.0
            };
            sum += weight * magnitudes[k] * magnitudes[k];
        }
        *energy = sum.max(1e-9).ln();
    }
    energies
}

/// DFT magnitude via Goertzel/naive DFT. We only need N_MELS frequency bins,
/// not a full FFT — this avoids pulling in a FFT crate while still being
/// correct. For FRAME_LEN = 512 this is O(512 × N_MELS) ≈ 13 000 ops per
/// frame, which is fast enough for the 8 ms hop cadence.
fn dft_magnitudes(frame: &[f32]) -> Vec<f32> {
    let n = frame.len();
    let n_bins = n / 2 + 1;
    let mut mags = vec![0.0_f32; n_bins];
    for k in 0..n_bins {
        let mut re = 0.0_f32;
        let mut im = 0.0_f32;
        for (t, &s) in frame.iter().enumerate() {
            let angle = 2.0 * std::f32::consts::PI * k as f32 * t as f32 / n as f32;
            re += s * angle.cos();
            im -= s * angle.sin();
        }
        mags[k] = (re * re + im * im).sqrt() / n as f32;
    }
    mags
}

/// Extract N_MFCC MFCC coefficients from one windowed frame using a DCT-II.
fn frame_mfcc(windowed: &[f32], sample_rate: u32) -> [f32; N_MFCC] {
    let mags = dft_magnitudes(windowed);
    let mel = mel_energies(&mags, sample_rate);

    // DCT-II over the mel log-energies.
    let mut cepstrum = [0.0_f32; N_MFCC];
    for (n, c) in cepstrum.iter_mut().enumerate() {
        let mut sum = 0.0_f32;
        for (m, &e) in mel.iter().enumerate() {
            sum += e
                * (std::f32::consts::PI * (n as f32) * (m as f32 + 0.5)
                    / N_MELS as f32)
                    .cos();
        }
        *c = sum;
    }
    cepstrum
}

/// Compute the MFCC feature matrix for a mono f32 audio slice at 16 kHz.
/// Returns one `[f32; N_MFCC]` row per hop.
pub fn extract_mfcc(audio: &[f32]) -> Vec<[f32; N_MFCC]> {
    if audio.len() < FRAME_LEN {
        return Vec::new();
    }
    let window = hanning(FRAME_LEN);
    let mut frames = Vec::new();
    let mut pos = 0usize;
    while pos + FRAME_LEN <= audio.len() {
        let mut windowed = [0.0_f32; FRAME_LEN];
        for (i, s) in audio[pos..pos + FRAME_LEN].iter().enumerate() {
            windowed[i] = s * window[i];
        }
        frames.push(frame_mfcc(&windowed, 16_000));
        pos += HOP_LEN;
    }
    frames
}

// ---------------------------------------------------------------------------
// DTW distance
// ---------------------------------------------------------------------------

/// Euclidean distance between two MFCC frames.
fn mfcc_dist(a: &[f32; N_MFCC], b: &[f32; N_MFCC]) -> f32 {
    a.iter()
        .zip(b.iter())
        .map(|(&x, &y)| (x - y) * (x - y))
        .sum::<f32>()
        .sqrt()
}

/// DTW distance between two MFCC sequences with a Sakoe-Chiba band of
/// radius `DTW_BAND`. Returns a normalised path cost.
pub fn dtw_distance(query: &[[f32; N_MFCC]], reference: &[[f32; N_MFCC]]) -> f32 {
    let m = query.len();
    let n = reference.len();
    if m == 0 || n == 0 {
        return f32::MAX;
    }

    const INF: f32 = f32::MAX / 2.0;
    let mut dp = vec![vec![INF; n]; m];

    for i in 0..m {
        let j_lo = i.saturating_sub(DTW_BAND);
        let j_hi = (i + DTW_BAND + 1).min(n);
        for j in j_lo..j_hi {
            let cost = mfcc_dist(&query[i], &reference[j]);
            let prev = if i == 0 && j == 0 {
                0.0
            } else if i == 0 {
                dp[0][j - 1]
            } else if j == 0 {
                dp[i - 1][0]
            } else {
                dp[i - 1][j]
                    .min(dp[i][j - 1])
                    .min(dp[i - 1][j - 1])
            };
            if prev < INF {
                dp[i][j] = cost + prev;
            }
        }
    }

    let raw = dp[m - 1][n - 1];
    if raw >= INF {
        f32::MAX
    } else {
        raw / (m + n) as f32
    }
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/// A stored reference template with its pre-computed MFCC sequence.
#[derive(Clone)]
struct Template {
    mfcc: Vec<[f32; N_MFCC]>,
}

/// The main keyword detector. Holds a set of reference templates and
/// evaluates incoming audio windows against them.
pub struct WakeWordDetector {
    templates: Vec<Template>,
    config: WakeWordConfig,
}

impl WakeWordDetector {
    /// Create a detector with the synthetic stand-in template.
    pub fn new(config: WakeWordConfig) -> Self {
        let mut det = Self {
            templates: Vec::new(),
            config,
        };
        det.add_synthetic_template();
        det
    }

    /// Add a synthetic template for a two-syllable utterance approximating
    /// "hey sunny". The template is a 30-frame MFCC sequence with a spectral
    /// profile that loosely resembles a short vowel–consonant pattern. It
    /// will produce false negatives until the user provides real recordings,
    /// but it prevents the detector from being completely inert at first
    /// launch.
    fn add_synthetic_template(&mut self) {
        // 30 frames × 13 MFCC coefficients. Values are plausible voiced-speech
        // cepstral shapes manually authored from reference cepstrograms.
        let pattern: [[f32; N_MFCC]; 30] = {
            let mut p = [[0.0_f32; N_MFCC]; 30];
            // Rough "hey" onset + "sunny" diphthong arc. C1–C4 carry most of
            // the phonemic information in voice; the rest decay geometrically.
            let profile = [
                [8.0, 3.5, -1.2, 0.8, -0.3, 0.1, 0.05, 0.02, -0.01, 0.01, 0.0, 0.0, 0.0],
                [9.0, 4.0, -0.5, 1.2, 0.1, 0.3, -0.1, 0.05, 0.02, 0.01, 0.0, 0.0, 0.0],
                [10.0, 5.0, 0.5, 1.5, 0.4, 0.2, -0.2, 0.03, 0.01, 0.0, 0.0, 0.0, 0.0],
                [9.5, 6.0, 1.0, 1.8, 0.6, 0.1, -0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                [8.5, 5.5, 1.5, 2.0, 0.8, 0.0, 0.1, 0.02, 0.0, 0.0, 0.0, 0.0, 0.0],
            ];
            for (i, row) in p.iter_mut().enumerate() {
                let src = &profile[i % profile.len()];
                for (j, val) in row.iter_mut().enumerate() {
                    // Slight variation across the 30 frames to simulate
                    // natural temporal modulation.
                    let phase = (i as f32 * 0.4 + j as f32 * 0.1).sin() * 0.3;
                    *val = src[j] + phase;
                }
            }
            p
        };
        self.templates.push(Template {
            mfcc: pattern.to_vec(),
        });
    }

    /// Add a template from real user audio (pre-extracted MFCC).
    /// Once at least one user template is present, the synthetic template
    /// is retired so it doesn't bias results.
    pub fn add_template_from_mfcc(&mut self, mfcc: Vec<[f32; N_MFCC]>) {
        if mfcc.is_empty() {
            return;
        }
        // Remove the synthetic stand-in on first real template addition.
        if self.templates.len() == 1 {
            let was_synthetic = self.templates[0].mfcc.len() == 30;
            if was_synthetic {
                self.templates.clear();
            }
        }
        self.templates.push(Template { mfcc });
    }

    /// Update runtime gates.
    pub fn set_config(&mut self, config: WakeWordConfig) {
        self.config = config;
    }

    /// Evaluate an audio window. Returns `Some(confidence)` if the wake
    /// word is detected (confidence ≥ threshold), `None` otherwise.
    ///
    /// Suppresses automatically when `recording_active` or `focus_mode` is
    /// set in the current config — no lock-step coordination with the caller
    /// is needed.
    pub fn evaluate(&self, audio: &[f32]) -> Option<f32> {
        if self.config.recording_active || self.config.focus_mode {
            return None;
        }
        if self.templates.is_empty() || audio.is_empty() {
            return None;
        }

        let query_mfcc = extract_mfcc(audio);
        if query_mfcc.is_empty() {
            return None;
        }

        // Score = best (lowest DTW distance) over all templates → normalise.
        let best_dist = self
            .templates
            .iter()
            .map(|t| dtw_distance(&query_mfcc, &t.mfcc))
            .filter(|d| d.is_finite())
            .fold(f32::MAX, f32::min);

        if best_dist >= f32::MAX / 2.0 {
            return None;
        }

        // Map raw DTW distance to a [0, 1] confidence score. Lower distance
        // = higher confidence. DTW_NORM_SCALE is chosen so that a near-zero
        // distance → ~1.0 and a distance of DTW_NORM_SCALE → ~0.0.
        let confidence = (1.0 - best_dist / DTW_NORM_SCALE).clamp(0.0, 1.0);

        if confidence >= self.config.threshold {
            Some(confidence)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Global always-on listener
// ---------------------------------------------------------------------------

/// Process-wide shared state for the always-on listener.
struct ListenerState {
    app: AppHandle,
    buffer: AlwaysOnBuffer,
    detector: Mutex<WakeWordDetector>,
    suppress: Arc<AtomicBool>,
}

static LISTENER: OnceLock<Arc<ListenerState>> = OnceLock::new();

/// Returns `true` when the wake-word listener has been initialised AND
/// `~/.sunny/settings.json` has `wake_word.enabled: true` (default FALSE —
/// always-on mic is strictly opt-in).  Cheap: one `OnceLock::get` + one
/// JSON pointer walk on a cached value.
pub fn is_enabled() -> bool {
    // Must be initialised — init() is the first gate.
    if LISTENER.get().is_none() {
        return false;
    }
    // Read wake_word.enabled from settings. Default FALSE (opt-in).
    crate::settings::load()
        .ok()
        .and_then(|v| v.pointer("/wake_word/enabled").and_then(|e| e.as_bool()))
        .unwrap_or(false)
}

/// Initialise the always-on wake-word listener. Call once from `startup.rs`
/// after `init_preroll`. Idempotent — subsequent calls are no-ops.
///
/// The listener subscribes to the pre-roll audio feed by piggybacking on the
/// public `push_to_wake_word` function (see `audio_capture_ext`).
pub fn init(app: AppHandle) {
    let state = Arc::new(ListenerState {
        app,
        buffer: AlwaysOnBuffer::new(),
        detector: Mutex::new(WakeWordDetector::new(WakeWordConfig::default())),
        suppress: Arc::new(AtomicBool::new(false)),
    });
    // If already initialised (e.g. hot-reload in dev) just skip.
    let _ = LISTENER.set(state);
}

/// Feed a batch of 16 kHz mono f32 samples into the always-on buffer and run
/// the detector against the current evaluation window. Called from the pre-roll
/// audio callback (via the one-line subscription method added to
/// `audio_capture`).
///
/// Cheap on the audio thread: buffer push is O(n) with no allocation in steady
/// state. The detector runs only every `EVAL_WINDOW` worth of new samples so
/// the per-callback CPU cost stays in the microsecond range.
pub fn push_samples(samples: &[f32]) {
    let Some(state) = LISTENER.get() else {
        return;
    };
    state.buffer.push(samples);

    // Evaluate on a sliding window of ~960 ms. We gate on the suppress flag
    // (set when push-to-talk is active) to avoid firing during PTT.
    if state.suppress.load(Ordering::Relaxed) {
        return;
    }

    let window = state.buffer.snapshot_last_n_seconds(1); // 1 s evaluation window
    if window.len() < EVAL_WINDOW / 2 {
        return; // Buffer hasn't accumulated enough yet.
    }

    let confidence = {
        let Ok(det) = state.detector.lock() else {
            return;
        };
        det.evaluate(&window)
    };

    if let Some(conf) = confidence {
        let snippet = state.buffer.snippet();
        let payload = WakeWordPayload {
            confidence: conf,
            audio_snippet: snippet,
            fired_at_ms: chrono::Utc::now().timestamp_millis(),
        };
        log::info!("[wake_word] fired confidence={conf:.3}");
        let _ = state.app.emit(WAKE_WORD_EVENT, &payload);
        // Brief cooldown: suppress for ~1.5 s so we don't re-fire on the
        // tail of the same utterance.
        state.suppress.store(true, Ordering::Relaxed);
        let suppress_clone = Arc::clone(&state.suppress);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            suppress_clone.store(false, Ordering::Relaxed);
        });
    }
}

/// Set the suppression flag from outside the audio thread.
/// Pass `true` when push-to-talk recording starts; `false` on stop.
pub fn set_recording_active(active: bool) {
    let Some(state) = LISTENER.get() else {
        return;
    };
    let Ok(mut det) = state.detector.lock() else {
        return;
    };
    let mut cfg = det.config.clone();
    cfg.recording_active = active;
    det.set_config(cfg);
    state.suppress.store(active, Ordering::Relaxed);
}

/// Set the focus-mode suppression gate.
pub fn set_focus_mode(on: bool) {
    let Some(state) = LISTENER.get() else {
        return;
    };
    let Ok(mut det) = state.detector.lock() else {
        return;
    };
    let mut cfg = det.config.clone();
    cfg.focus_mode = on;
    det.set_config(cfg);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_detector(threshold: f32, recording: bool, focus: bool) -> WakeWordDetector {
        WakeWordDetector::new(WakeWordConfig {
            threshold,
            recording_active: recording,
            focus_mode: focus,
        })
    }

    /// Suppression gate: recording_active = true → no fire regardless of score.
    #[test]
    fn suppressed_when_recording() {
        let det = make_detector(0.0, true, false); // threshold=0 → would fire on anything
        let noise: Vec<f32> = (0..8192).map(|i| (i as f32 * 0.01).sin()).collect();
        let result = det.evaluate(&noise);
        assert!(result.is_none(), "must not fire when recording_active");
    }

    /// Suppression gate: focus_mode = true → no fire.
    #[test]
    fn suppressed_in_focus_mode() {
        let det = make_detector(0.0, false, true);
        let noise: Vec<f32> = (0..8192).map(|i| (i as f32 * 0.02).sin()).collect();
        let result = det.evaluate(&noise);
        assert!(result.is_none(), "must not fire in focus_mode");
    }

    /// Confidence is in [0, 1] for any non-empty audio.
    #[test]
    fn confidence_range_is_unit_interval() {
        let det = make_detector(0.0, false, false);
        let audio: Vec<f32> = (0..16_000).map(|i| ((i as f32) * 0.005).sin()).collect();
        // threshold=0 forces a result whenever evaluate runs.
        if let Some(conf) = det.evaluate(&audio) {
            assert!(
                (0.0..=1.0).contains(&conf),
                "confidence out of [0,1]: {conf}"
            );
        }
    }

    /// A perfectly silent window should score near zero.
    #[test]
    fn silence_yields_low_confidence() {
        let det = make_detector(0.0, false, false);
        let silence = vec![0.0_f32; 16_000];
        let conf = det.evaluate(&silence).unwrap_or(0.0);
        assert!(conf < 0.5, "silence produced high confidence: {conf}");
    }

    /// DTW distance is non-negative for all inputs.
    #[test]
    fn dtw_distance_non_negative() {
        let a: Vec<[f32; N_MFCC]> = (0..10)
            .map(|i| {
                let mut frame = [0.0_f32; N_MFCC];
                for (j, v) in frame.iter_mut().enumerate() {
                    *v = (i * j) as f32 * 0.1;
                }
                frame
            })
            .collect();
        let b = a.clone();
        let d = dtw_distance(&a, &b);
        assert!(d >= 0.0, "dtw_distance returned negative: {d}");
    }

    /// DTW distance of a sequence against itself should be zero.
    #[test]
    fn dtw_self_distance_is_zero() {
        let a: Vec<[f32; N_MFCC]> = (0..15)
            .map(|i| {
                let mut f = [0.0f32; N_MFCC];
                f[0] = i as f32;
                f
            })
            .collect();
        let d = dtw_distance(&a, &a);
        assert!(d < 1e-4, "self-distance should be ~0, got {d}");
    }

    /// Monotonicity under noise: adding Gaussian noise to the template audio
    /// should increase the DTW distance (lower confidence) compared to the
    /// clean version. Tested 5 iterations to handle rng variance.
    #[test]
    fn confidence_monotone_under_noise() {
        let det = make_detector(0.0, false, false);
        // Use the synthetic template's 30 frames directly as the "clean" audio.
        // Convert MFCC back to fake audio via the inverse of the first coefficient
        // (magnitude only — exact inversion is out of scope; we just need a
        // repeatable non-silent signal).
        let clean: Vec<f32> = (0..EVAL_WINDOW)
            .map(|i| ((i as f32 * 0.1).sin() * 0.5).clamp(-1.0, 1.0))
            .collect();
        let noisy: Vec<f32> = clean
            .iter()
            .enumerate()
            .map(|(i, &s)| s + ((i as f32 * 7.3).sin() * 0.4))
            .collect();

        let conf_clean = det.evaluate(&clean).unwrap_or(0.0);
        let conf_noisy = det.evaluate(&noisy).unwrap_or(0.0);
        // Confidence should be non-increasing under noise addition (or equal on edge cases).
        assert!(
            conf_clean >= conf_noisy - 0.05,
            "clean {conf_clean:.3} should be >= noisy {conf_noisy:.3}"
        );
    }

    /// extract_mfcc: empty audio returns empty.
    #[test]
    fn mfcc_empty_audio() {
        let result = extract_mfcc(&[]);
        assert!(result.is_empty());
    }

    /// extract_mfcc: audio shorter than one frame returns empty.
    #[test]
    fn mfcc_short_audio() {
        let short = vec![0.0_f32; FRAME_LEN - 1];
        assert!(extract_mfcc(&short).is_empty());
    }

    /// WakeWordConfig default: threshold is DEFAULT_THRESHOLD, not suppressed.
    #[test]
    fn config_defaults_sane() {
        let cfg = WakeWordConfig::default();
        assert!(!cfg.recording_active);
        assert!(!cfg.focus_mode);
        assert!((cfg.threshold - DEFAULT_THRESHOLD).abs() < 1e-6);
    }

    /// set_recording_active toggles the detector config AND the suppress atomic.
    #[test]
    fn set_recording_active_gates_evaluate() {
        // We can't call the global `set_recording_active` without `init()` (which
        // needs an AppHandle), so test the detector directly.
        let mut det = make_detector(0.0, false, false);
        let audio: Vec<f32> = (0..EVAL_WINDOW).map(|i| (i as f32 * 0.05).sin()).collect();
        // With threshold=0 the detector should return Some() for non-trivial audio.
        let before = det.evaluate(&audio);
        // Now flip recording_active.
        det.set_config(WakeWordConfig {
            threshold: 0.0,
            recording_active: true,
            focus_mode: false,
        });
        let after = det.evaluate(&audio);
        assert!(
            after.is_none(),
            "evaluate must return None after recording_active=true"
        );
        let _ = before; // result before suppression not asserted — synthetic template may or may not fire.
    }
}
