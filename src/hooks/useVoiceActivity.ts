import { useEffect, useRef } from 'react';
import { listen } from '../lib/tauri';

// Voice Activity Detection — Rust-side consumer.
//
// The Rust `audio_capture` module owns the microphone (via `cpal`) while a
// recording is live and emits `sunny://voice.level` events with a 0..1 RMS
// value every ~50 ms. This hook thresholds those levels into the same
// `onSilence` / `onSpeechStart` callbacks the old WebAudio implementation
// provided — but without ever touching `navigator.mediaDevices.getUserMedia`.
//
// Why the rewrite: on macOS, a WKWebView `getUserMedia` stream and a
// sibling Rust-side recorder (sox / ffmpeg / cpal) serialise on the input
// device. Whichever opens the mic first starves the other. The old hook
// always lost to the Rust recorder, so its analyser never saw any audio,
// `onSilence` never fired, and every voice turn hit the 25 s backstop
// before recording could stop. One owner, one capture, no contention.
//
// Two modes, same API:
//   - `listen`  — fire `onSilence` after the user has spoken (RMS crossed
//     the threshold at least once) and then gone quiet for `silenceMs`.
//     Used during an active recording to auto-end the utterance.
//   - `barge-in` — fire `onSpeechStart` once RMS stays above threshold for
//     `onsetMs`. Used while the AI is talking so the user can cut in.

export type VoiceActivityMode = 'listen' | 'barge-in';

export type VoiceActivityOptions = {
  readonly enabled: boolean;
  readonly mode?: VoiceActivityMode;
  readonly onSilence?: () => void;
  readonly onSpeechStart?: () => void;
  /** RMS threshold in [0,1] above which we consider the user speaking. */
  readonly threshold?: number;
  /** Silence duration before `onSilence` fires, in ms. */
  readonly silenceMs?: number;
  /** Speech duration before `onSpeechStart` fires, in ms. */
  readonly onsetMs?: number;
};

// Defaults tuned against the native cpal level stream: the old WebAudio
// threshold of 0.025 was calibrated to a ScriptProcessorNode, which
// normalised differently. Native RMS of clean speech sits around 0.05–0.2;
// 0.012 is well above room tone in a quiet office and picks up soft-spoken
// "hello" / "yeah" reliably. Lowered from 0.015 after captures showed short
// utterances near the old threshold were being classified as noise.
const DEFAULT_THRESHOLD = 0.012;
const DEFAULT_SILENCE_MS = 900;
const DEFAULT_ONSET_MS = 220;

// If no speech has crossed the threshold for this long after the session
// starts, log a diagnostic — almost always means the mic is on a silent
// device (wrong default input, hardware mute, TCC-degraded path). The
// user still has to tap the button to stop, but now they have a clue.
const NO_SPEECH_WATCHDOG_MS = 2500;

// During AI playback we still want a conservative barge-in threshold — the
// AI's voice can leak through the speakers past echo-cancellation. The old
// WebAudio hook used a 1.8x multiplier; we preserve that here so the UX
// feel is unchanged even though the underlying numbers differ.
const BARGE_IN_BOOST = 1.8;

export function useVoiceActivity(opts: VoiceActivityOptions): void {
  const enabledRef = useRef(opts.enabled);
  const modeRef = useRef<VoiceActivityMode>(opts.mode ?? 'listen');
  const onSilenceRef = useRef<(() => void) | undefined>(opts.onSilence);
  const onSpeechStartRef = useRef<(() => void) | undefined>(opts.onSpeechStart);
  const thresholdRef = useRef<number>(opts.threshold ?? DEFAULT_THRESHOLD);
  const silenceMsRef = useRef<number>(opts.silenceMs ?? DEFAULT_SILENCE_MS);
  const onsetMsRef = useRef<number>(opts.onsetMs ?? DEFAULT_ONSET_MS);

  // Mirror every opt into a ref so callers can pass inline closures / fresh
  // objects without retriggering the listener subscription.
  useEffect(() => { enabledRef.current = opts.enabled; }, [opts.enabled]);
  useEffect(() => { modeRef.current = opts.mode ?? 'listen'; }, [opts.mode]);
  useEffect(() => { onSilenceRef.current = opts.onSilence; }, [opts.onSilence]);
  useEffect(() => { onSpeechStartRef.current = opts.onSpeechStart; }, [opts.onSpeechStart]);
  useEffect(() => { thresholdRef.current = opts.threshold ?? DEFAULT_THRESHOLD; }, [opts.threshold]);
  useEffect(() => { silenceMsRef.current = opts.silenceMs ?? DEFAULT_SILENCE_MS; }, [opts.silenceMs]);
  useEffect(() => { onsetMsRef.current = opts.onsetMs ?? DEFAULT_ONSET_MS; }, [opts.onsetMs]);

  useEffect(() => {
    // `enabled` is read live from the ref; the listener stays subscribed
    // for the lifetime of the component so we don't thrash Tauri IPC as
    // the recording state flips on and off.
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // Per-session VAD state. Reset every time `enabled` transitions from
    // false to true so a stale "sawSpeech" from a prior turn can't trigger
    // an immediate silence callback on the next one.
    let sawSpeech = false;
    let silentSince: number | null = null;
    let loudSince: number | null = null;

    // Track the last enabled value we saw — when it flips true we reset
    // the state above. Using a scoped local instead of a ref because this
    // effect already owns all the mutable state.
    let prevEnabled = false;

    // Session start + one-shot watchdog flag. On a session where the mic
    // is actually broken (wrong device, muted), the user sits at LIVE
    // forever — this makes that case observable in the console at least.
    let sessionStart: number | null = null;
    let watchdogFired = false;

    void (async () => {
      try {
        const stop = await listen<number>('sunny://voice.level', rms => {
          if (cancelled) return;

          const enabled = enabledRef.current;
          if (enabled && !prevEnabled) {
            // Rising edge — clear per-session state so the new turn
            // starts from a clean slate.
            sawSpeech = false;
            silentSince = null;
            loudSince = null;
            sessionStart = performance.now();
            watchdogFired = false;
          }
          prevEnabled = enabled;
          if (!enabled) return;

          if (
            !watchdogFired &&
            !sawSpeech &&
            sessionStart !== null &&
            performance.now() - sessionStart > NO_SPEECH_WATCHDOG_MS &&
            modeRef.current === 'listen'
          ) {
            watchdogFired = true;
            console.warn(
              '[vad] no speech detected after %dms — mic may be muted, on wrong input device, or RMS events stalled',
              NO_SPEECH_WATCHDOG_MS
            );
          }

          // Tauri's unwrapped listen returns the payload directly; guard
          // against any shape mismatch (e.g. a hot-reload stashing an
          // envelope) so a bad event can't crash the turn.
          const level =
            typeof rms === 'number'
              ? rms
              : (rms as unknown as { payload?: number })?.payload ?? 0;

          const now = performance.now();
          const boost = modeRef.current === 'barge-in' ? BARGE_IN_BOOST : 1;
          const effective = thresholdRef.current * boost;
          const loud = level > effective;

          if (modeRef.current === 'listen') {
            if (loud) {
              sawSpeech = true;
              silentSince = null;
            } else if (sawSpeech) {
              if (silentSince === null) silentSince = now;
              else if (now - silentSince >= silenceMsRef.current) {
                const cb = onSilenceRef.current;
                sawSpeech = false;
                silentSince = null;
                if (cb) cb();
              }
            }
          } else {
            // barge-in
            if (loud) {
              if (loudSince === null) loudSince = now;
              else if (now - loudSince >= onsetMsRef.current) {
                const cb = onSpeechStartRef.current;
                loudSince = null;
                if (cb) cb();
              }
            } else {
              loudSince = null;
            }
          }
        });
        if (cancelled) { stop(); return; }
        unlisten = stop;
      } catch (err) {
        // Outside a Tauri runtime `listen` is a no-op. The catch is here
        // for future-proofing only — the pure-web fallback quietly does
        // nothing, which matches the old hook's behaviour when mic
        // access was denied.
        console.warn('useVoiceActivity: level listener unavailable', err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
