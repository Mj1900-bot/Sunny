//! Offline E2E scenario: wake-word detector + 30-second ring buffer.
//! Phase-2 Packet 5 — `WakeWordDetector` (MFCC+DTW) and `AlwaysOnBuffer`
//! (30 s ring at 16 kHz mono). No mic, no AppHandle, no external services.
//!
//! Run: cargo test --test live voice_wake_word -- --nocapture

use sunny_lib::always_on_buffer::AlwaysOnBuffer;
use sunny_lib::wake_word::{extract_mfcc, WakeWordConfig, WakeWordDetector};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// 16 kHz mono — matches `BUFFER_RATE_HZ`.
const RATE: usize = 16_000;
/// Chunk size simulating real audio callbacks (512 samples ≈ 32 ms).
const CHUNK: usize = 512;
/// Default detector threshold.
const THRESHOLD: f32 = 0.55;
/// Short burst length (2048 samples ≈ 128 ms → ~12 MFCC frames).
/// Kept small so the naive DFT in `extract_mfcc` stays well under 2 s.
const SHORT_BURST: usize = 2048;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Deterministic two-component sine burst. When used as both template and
/// query the DTW self-distance is ≈ 0 → confidence ≈ 1.0.
fn voiced_burst(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            0.4 * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
                + 0.1 * (2.0 * std::f32::consts::PI * 880.0 * t).sin()
        })
        .collect()
}

/// Deterministic LCG noise — low amplitude, flat cepstrum.
fn noise_signal(n: usize) -> Vec<f32> {
    let mut state: u64 = 0xDEAD_BEEF_1234_5678;
    (0..n)
        .map(|_| {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            ((state >> 33) as f32 / u32::MAX as f32 - 0.5) * 0.1
        })
        .collect()
}

/// Build a detector trained on `seed_audio`. The synthetic 30-frame stand-in
/// is replaced by `add_template_from_mfcc` so only the seed's MFCC is used.
fn seeded_detector(seed_audio: &[f32], config: WakeWordConfig) -> WakeWordDetector {
    let mfcc = extract_mfcc(seed_audio);
    assert!(!mfcc.is_empty(), "seed audio too short (need ≥512 samples)");
    let mut det = WakeWordDetector::new(config);
    det.add_template_from_mfcc(mfcc);
    det
}

/// Drive the detector in CHUNK-sized steps, returning the first confidence
/// that fires or `None` if the entire buffer is consumed without a match.
fn poll_chunked(det: &WakeWordDetector, audio: &[f32]) -> Option<f32> {
    let mut pos = 0;
    while pos + CHUNK <= audio.len() {
        let window = &audio[..pos + CHUNK];
        if let Some(c) = det.evaluate(window) {
            return Some(c);
        }
        pos += CHUNK;
    }
    None
}

// ---------------------------------------------------------------------------
// Test 1 — detector fires on a match, stays silent on noise
// ---------------------------------------------------------------------------

#[test]
fn detector_fires_on_match_not_on_noise() {
    let burst = voiced_burst(SHORT_BURST);
    let det = seeded_detector(
        &burst,
        WakeWordConfig { threshold: THRESHOLD, recording_active: false, focus_mode: false },
    );

    let conf_match = poll_chunked(&det, &burst)
        .expect("detector must fire on its own training audio");
    assert!(
        conf_match >= THRESHOLD,
        "match confidence {conf_match:.3} below threshold {THRESHOLD}"
    );

    let conf_noise = poll_chunked(&det, &noise_signal(SHORT_BURST));
    assert!(conf_noise.is_none(), "must not fire on noise; got {conf_noise:?}");

    println!("[voice_wake_word] match_confidence={conf_match:.3}  noise_fired=false");
}

// ---------------------------------------------------------------------------
// Test 2 — ring buffer snapshot returns exactly 32 000 samples after 2 s
// ---------------------------------------------------------------------------

#[test]
fn ring_buffer_snapshot_two_seconds() {
    let buf = AlwaysOnBuffer::new();
    for chunk in voiced_burst(2 * RATE).chunks(CHUNK) {
        buf.push(chunk);
    }
    let snap = buf.snapshot_last_n_seconds(2);
    assert_eq!(snap.len(), 2 * RATE,
        "snapshot_last_n_seconds(2) must return {} samples, got {}", 2 * RATE, snap.len());
}

// ---------------------------------------------------------------------------
// Test 3 — focus_mode gate suppresses firing on a perfect match
// ---------------------------------------------------------------------------

#[test]
fn focus_mode_suppresses_detection() {
    let burst = voiced_burst(SHORT_BURST);
    let det = seeded_detector(
        &burst,
        WakeWordConfig { threshold: THRESHOLD, recording_active: false, focus_mode: true },
    );
    assert!(det.evaluate(&burst).is_none(), "must not fire in focus_mode");
    println!("[voice_wake_word] focus_mode_suppression=ok");
}

// ---------------------------------------------------------------------------
// Test 4 — ring-buffer wraparound: 31 s of audio drops the oldest 1 s
// ---------------------------------------------------------------------------

#[test]
fn ring_buffer_wraparound_evicts_oldest() {
    const RING_SECS: u32 = 30;
    const RING_CAP: usize = RATE * RING_SECS as usize; // 480 000 samples

    let buf = AlwaysOnBuffer::new();
    buf.push(&vec![0.1_f32; RING_CAP]);
    assert_eq!(buf.snapshot_last_n_seconds(RING_SECS).len(), RING_CAP);

    // Overflow by 1 second of distinct samples.
    buf.push(&vec![0.9_f32; RATE]);

    let snap = buf.snapshot_last_n_seconds(RING_SECS);
    assert_eq!(snap.len(), RING_CAP,
        "ring must stay at capacity; got {}", snap.len());

    // Newest RATE samples must be 0.9 (just pushed).
    for (i, &s) in snap[snap.len() - RATE..].iter().enumerate() {
        assert!((s - 0.9).abs() < 1e-5, "tail[{i}] should be 0.9, got {s}");
    }
    // Oldest surviving RATE samples must be 0.1 (second second of old data).
    for (i, &s) in snap[..RATE].iter().enumerate() {
        assert!((s - 0.1).abs() < 1e-5, "head[{i}] should be 0.1, got {s}");
    }

    println!("[voice_wake_word] ring_wraparound=ok ring_capacity={RING_CAP}");
}

// ---------------------------------------------------------------------------
// Test 5 — recording_active gate suppresses firing (PTT path)
// ---------------------------------------------------------------------------

#[test]
fn recording_active_suppresses_detection() {
    let burst = voiced_burst(SHORT_BURST);
    let det = seeded_detector(
        &burst,
        WakeWordConfig { threshold: THRESHOLD, recording_active: true, focus_mode: false },
    );
    assert!(det.evaluate(&burst).is_none(), "must not fire when recording_active");
    println!("[voice_wake_word] recording_active_suppression=ok");
}
