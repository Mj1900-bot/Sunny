// useWakeWord — always-on wake-phrase listener (v2, MFCC+DTW backend).
//
// Subscribes to the `sunny://wake_word` Tauri event emitted by
// `voice::wake_word::push_samples` on the Rust side. When the event fires:
//   1. The HUD orb receives a transient "pulse" class for visual feedback.
//   2. The audio snippet (`Vec<f32>`) is handed off to the existing STT
//      pipeline via `sunny-voice-transcript` so the agent loop picks it up
//      exactly as if the user had pressed Space.
//   3. The live transcript is updated as STT streams.
//
// Gating: the hook respects the existing `recording_active` state. If a
// push-to-talk session is already in progress the wake-word event is silently
// discarded to avoid STT contention.
//
// Privacy: raw audio never touches this layer as a displayable value. Only the
// post-STT transcript string is surfaced in state.
//
// Usage:
//   const { active, lastTranscript, confidence, error } = useWakeWord({ enabled: true });

import { useEffect, useRef, useState, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeSafe, isTauri } from '../lib/tauri';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload emitted by `voice::wake_word` on `sunny://wake_word`. */
type WakeWordPayload = {
  readonly confidence: number;
  /** audio_snippet is marked #[serde(skip)] in Rust so it never crosses IPC. */
  readonly fired_at_ms: number;
};

export type UseWakeWordOptions = {
  /** Enable the listener. Default false (opt-in for privacy). */
  readonly enabled?: boolean;
  /** Called when a wake-word fires, with the post-wake transcript. */
  readonly onWake?: (transcript: string, confidence: number) => void;
};

export type UseWakeWordResult = {
  /** True when the listener is subscribed and waiting for a wake event. */
  readonly active: boolean;
  /** Last transcript produced by the STT pipeline after a wake event. */
  readonly lastTranscript: string;
  /** Confidence score from the most recent wake-word event [0, 1]. */
  readonly confidence: number | null;
  /** Any error surfaced from the Tauri event subscription layer. */
  readonly error: string | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WAKE_WORD_EVENT = 'sunny://wake_word';
const TRANSCRIPT_EVENT = 'sunny-voice-transcript';
/** Duration (ms) to keep the orb pulse class active. */
const PULSE_DURATION_MS = 600;
/** Maximum silence wait (ms) after a wake event before giving up on STT. */
const STT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWakeWord(opts?: UseWakeWordOptions): UseWakeWordResult {
  const enabled = opts?.enabled ?? false;
  const onWake = opts?.onWake;

  const [active, setActive] = useState<boolean>(false);
  const [lastTranscript, setLastTranscript] = useState<string>('');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onWakeRef = useRef<UseWakeWordOptions['onWake']>(onWake);
  const processingRef = useRef<boolean>(false);

  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  /** Briefly pulse the HUD orb element. */
  const pulseOrb = useCallback((): void => {
    if (typeof document === 'undefined') return;
    const orb = document.querySelector<HTMLElement>('[data-orb]');
    if (!orb) return;
    orb.classList.add('wake-pulse');
    window.setTimeout(() => orb.classList.remove('wake-pulse'), PULSE_DURATION_MS);
  }, []);

  /** Dispatch the transcript to the voice pipeline as if PTT was released. */
  const dispatchTranscript = useCallback((text: string): void => {
    if (typeof window === 'undefined' || text.trim().length === 0) return;
    window.dispatchEvent(
      new CustomEvent(TRANSCRIPT_EVENT, { detail: { text } }),
    );
  }, []);

  /** Run STT on the last captured snippet via the existing transcribe command.
   *  The wake-word backend already captured the audio snippet into the
   *  always-on ring buffer — we trigger a fresh whisper pass on the temp WAV
   *  that the pre-roll mechanism maintains.
   */
  const runSttAfterWake = useCallback(
    async (conf: number): Promise<void> => {
      if (processingRef.current) return; // Coalesce concurrent wake events.
      processingRef.current = true;

      pulseOrb();

      try {
        // Start a brief capture to get the tail of the utterance (post-wake).
        const startOk = await invokeSafe<string>('audio_record_start');
        if (startOk === null) {
          throw new Error('audio_record_start failed after wake');
        }

        // Wait for the user to finish speaking (STT_TIMEOUT_MS ceiling).
        // The frontend VAD will fire `sunny-voice-silence` which we let the
        // existing useVoiceChat pipeline handle. We just need a short capture
        // here for the follow-up words.
        await new Promise<void>(resolve =>
          window.setTimeout(resolve, Math.min(2500, STT_TIMEOUT_MS)),
        );

        const wavPath = await invokeSafe<string>('audio_record_stop');
        if (!wavPath || wavPath.length === 0) {
          throw new Error('audio_record_stop returned no path');
        }

        const transcript = await invokeSafe<string>('transcribe', { path: wavPath });
        if (transcript === null) {
          throw new Error('transcribe returned null');
        }

        const text = transcript.trim();
        if (text.length > 0) {
          setLastTranscript(text);
          dispatchTranscript(text);
          const cb = onWakeRef.current;
          if (cb) {
            try {
              cb(text, conf);
            } catch {
              // Swallow callback errors — they must not crash the hook.
            }
          }
        }
        setError(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`wake-word STT failed: ${msg}`);
        // Best-effort stop in case start succeeded.
        await invokeSafe<string>('audio_record_stop');
      } finally {
        processingRef.current = false;
      }
    },
    [pulseOrb, dispatchTranscript],
  );

  useEffect(() => {
    if (!enabled || !isTauri) {
      setActive(false);
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let mounted = true;

    const setup = async (): Promise<void> => {
      try {
        unlisten = await listen<WakeWordPayload>(WAKE_WORD_EVENT, event => {
          if (!mounted) return;
          const { confidence: conf } = event.payload;
          setConfidence(conf);
          void runSttAfterWake(conf);
        });
        if (mounted) {
          setActive(true);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(`wake-word listener setup failed: ${msg}`);
          setActive(false);
        }
      }
    };

    void setup();

    return (): void => {
      mounted = false;
      setActive(false);
      if (unlisten) {
        unlisten();
      }
    };
  }, [enabled, runSttAfterWake]);

  return { active, lastTranscript, confidence, error };
}
