//! Always-on 30-second rolling PCM ring buffer at 16 kHz mono.
//!
//! Audio samples are pushed in by the wake-word listener (which taps the
//! existing pre-roll stream from `audio_capture`). When the wake word fires,
//! callers call `snapshot_last_n_seconds` to extract the trailing audio that
//! preceded the trigger — the last 2 seconds land in the emitted snippet so
//! the STT pipeline doesn't lose the words spoken just before "hey sunny".
//!
//! Privacy: the buffer lives entirely in RAM. Raw PCM is never written to
//! disk; only confidence scores are logged.
//!
//! Threading: the inner `VecDeque` is protected by `std::sync::Mutex` so the
//! audio callback (which runs on a dedicated OS thread) and the wake-word
//! evaluator (which runs on a std thread) never race.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Target capture rate — must match `audio_capture::TARGET_RATE_HZ`.
pub const BUFFER_RATE_HZ: u32 = 16_000;

/// Full ring span: 30 seconds × 16 000 samples/s = 480 000 samples (≈ 960 KB).
const RING_SECONDS: u32 = 30;
const RING_CAPACITY: usize = (BUFFER_RATE_HZ * RING_SECONDS) as usize;

/// How many seconds of audio to include in the "pre-wake" snippet handed to
/// the STT pipeline. 2 s × 16 000 = 32 000 samples.
pub const SNIPPET_SECONDS: u32 = 2;
const SNIPPET_SAMPLES: usize = (BUFFER_RATE_HZ * SNIPPET_SECONDS) as usize;


use std::sync::OnceLock;

/// Module-level singleton buffer, fed from the pre-roll audio callback
/// (Hook 2 in `audio_capture::run_preroll_stream`).  Lazily initialised
/// on first push so the module can be imported unconditionally.
static MODULE_BUF: OnceLock<AlwaysOnBuffer> = OnceLock::new();

fn module_buf() -> &'static AlwaysOnBuffer {
    MODULE_BUF.get_or_init(AlwaysOnBuffer::new)
}

/// Feed the module-level always-on ring from the pre-roll audio thread.
/// Safe to call before any explicit init — the buffer is created lazily.
/// No-op on empty slice or lock poison.
pub fn push_samples(samples: &[f32]) {
    module_buf().push(samples);
}

/// Shared handle to the rolling PCM ring. Clone-cheap — it's just an
/// `Arc` counter increment.
#[derive(Clone)]
pub struct AlwaysOnBuffer {
    inner: Arc<Mutex<VecDeque<f32>>>,
}

impl AlwaysOnBuffer {
    /// Create a new empty buffer. The underlying VecDeque is pre-allocated to
    /// `RING_CAPACITY` so steady-state pushes never reallocate.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAPACITY))),
        }
    }

    /// Push a batch of normalised f32 mono samples (expected range −1..+1).
    /// Drops the oldest samples when capacity is full. Designed to be called
    /// from the audio callback — holds the lock for the minimum duration
    /// (no allocation in the steady state once the ring is full).
    ///
    /// Silently returns on lock poison (the ring just stops updating; the
    /// wake-word path degrades gracefully rather than panicking).
    pub fn push(&self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        // Fast path: if the incoming batch is larger than the whole ring,
        // keep only the newest RING_CAPACITY samples from the tail.
        if samples.len() >= RING_CAPACITY {
            guard.clear();
            let start = samples.len() - RING_CAPACITY;
            guard.extend(samples[start..].iter().copied());
            return;
        }
        // Evict oldest samples to make room.
        let overflow = (guard.len() + samples.len()).saturating_sub(RING_CAPACITY);
        for _ in 0..overflow {
            guard.pop_front();
        }
        guard.extend(samples.iter().copied());
    }

    /// Return the last `n_seconds` of buffered audio in chronological order
    /// (oldest → newest). Returns fewer samples if the buffer hasn't filled
    /// yet or n_seconds is larger than `RING_SECONDS`.
    pub fn snapshot_last_n_seconds(&self, n_seconds: u32) -> Vec<f32> {
        let want = (BUFFER_RATE_HZ * n_seconds.min(RING_SECONDS)) as usize;
        let Ok(guard) = self.inner.lock() else {
            return Vec::new();
        };
        let len = guard.len();
        let start = len.saturating_sub(want);
        guard.range(start..).copied().collect()
    }

    /// Snapshot the pre-configured 2-second "pre-wake" snippet.
    pub fn snippet(&self) -> Vec<f32> {
        self.snapshot_last_n_seconds(SNIPPET_SECONDS)
    }

    /// Current fill level, in samples.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// True when no samples have been pushed yet.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for AlwaysOnBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fill_ramp(buf: &AlwaysOnBuffer, count: usize, offset: f32) {
        let samples: Vec<f32> = (0..count).map(|i| offset + i as f32 * 0.0001).collect();
        buf.push(&samples);
    }

    /// Empty buffer: snapshot returns empty Vec.
    #[test]
    fn snapshot_empty_buffer() {
        let buf = AlwaysOnBuffer::new();
        assert!(buf.snippet().is_empty());
    }

    /// Buffer fills correctly up to RING_CAPACITY without overflow panic.
    #[test]
    fn fills_to_capacity() {
        let buf = AlwaysOnBuffer::new();
        fill_ramp(&buf, RING_CAPACITY, 0.0);
        assert_eq!(buf.len(), RING_CAPACITY);
    }

    /// Oldest samples are evicted when capacity is exceeded.
    #[test]
    fn ring_overwrites_old_samples() {
        let buf = AlwaysOnBuffer::new();
        // Fill with 0.1 — these will be the "old" samples.
        let old = vec![0.1_f32; RING_CAPACITY];
        buf.push(&old);

        // Now push one extra batch of 0.9 — these are "new".
        let new_count = RING_CAPACITY / 2;
        let new = vec![0.9_f32; new_count];
        buf.push(&new);

        let snap = buf.snapshot_last_n_seconds(RING_SECONDS);
        assert_eq!(snap.len(), RING_CAPACITY);

        // The last `new_count` samples should all be 0.9.
        let tail = &snap[snap.len() - new_count..];
        for &s in tail {
            assert!((s - 0.9).abs() < 1e-5, "expected 0.9, got {s}");
        }
    }

    /// snippet() returns exactly SNIPPET_SAMPLES or fewer when buffer is short.
    #[test]
    fn snippet_size_bounded_by_content() {
        let buf = AlwaysOnBuffer::new();
        // Push fewer samples than a full snippet.
        let half = SNIPPET_SAMPLES / 2;
        fill_ramp(&buf, half, 0.0);
        let snap = buf.snippet();
        assert_eq!(snap.len(), half);
    }

    /// snippet() returns SNIPPET_SAMPLES when buffer is full.
    #[test]
    fn snippet_returns_correct_window() {
        let buf = AlwaysOnBuffer::new();
        fill_ramp(&buf, RING_CAPACITY, 0.0);
        let snap = buf.snippet();
        assert_eq!(snap.len(), SNIPPET_SAMPLES);
    }

    /// Pushing a batch larger than RING_CAPACITY retains only the tail.
    #[test]
    fn push_larger_than_capacity_keeps_tail() {
        let buf = AlwaysOnBuffer::new();
        let huge = RING_CAPACITY + 1000;
        let samples: Vec<f32> = (0..huge).map(|i| i as f32).collect();
        buf.push(&samples);
        assert_eq!(buf.len(), RING_CAPACITY);
        let snap = buf.snapshot_last_n_seconds(RING_SECONDS);
        // The first sample in the snapshot should be samples[1000] ≈ 1000.0
        assert!((snap[0] - 1000.0_f32).abs() < 1.0, "tail not preserved: {}", snap[0]);
    }

    /// snapshot_last_n_seconds clamps to available data when n_seconds
    /// exceeds RING_SECONDS.
    #[test]
    fn snapshot_clamps_to_ring_seconds() {
        let buf = AlwaysOnBuffer::new();
        fill_ramp(&buf, RING_CAPACITY, 0.0);
        let snap = buf.snapshot_last_n_seconds(RING_SECONDS + 100);
        assert_eq!(snap.len(), RING_CAPACITY);
    }

    // ---------------------------------------------------------------------------
    // Smoke test (b) — Phase-2 hook wiring
    // ---------------------------------------------------------------------------

    /// Smoke (b): `always_on_buffer::push_samples` (the module-level function
    /// wired into the pre-roll callback) is callable after module init and does
    /// not panic.  Verifies the `OnceLock`-backed global is lazily initialised
    /// and that a non-empty sample batch lands in the buffer.
    #[test]
    fn module_push_samples_callable_and_non_empty() {
        let samples: Vec<f32> = (0..64).map(|i| i as f32 * 0.001).collect();
        // Must not panic — the global is initialised lazily on first push.
        super::push_samples(&samples);
        // The module buffer should now be non-empty.
        let snap = super::module_buf().snapshot_last_n_seconds(1);
        assert!(!snap.is_empty(), "module buffer should contain samples after push");
    }

}