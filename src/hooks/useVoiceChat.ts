import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, invokeSafe, isTauri } from '../lib/tauri';
import { useView } from '../store/view';
import { useVoiceChatStore } from '../store/voiceChat';
import { createStreamSpeaker, type StreamSpeaker } from '../lib/streamSpeak';
import { useVoiceActivity } from './useVoiceActivity';
import { voiceAgentRun } from '../lib/voiceAgent';
import { useEventBus, type SunnyEvent } from './useEventBus';
import { loadConstitution } from '../lib/constitution';
import { sanitizeVoiceAnswer } from '../lib/constitutionKicks';

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking';

export type VoiceChatApi = {
  state: VoiceState;
  transcript: string;
  response: string;
  continuous: boolean;
  toggleContinuous: () => void;
  pressTalk: () => Promise<void>;
  /** Silence SUNNY without opening the mic. Distinct from `pressTalk` in the
   *  speaking state, which interrupts AND starts recording — use this when
   *  the user just wants SUNNY to stop. No-op when idle or recording. */
  stop: () => void;
  error: string | null;
};

type RecordStatus = { recording: boolean; path: string | null; seconds: number };

// Once the user stops speaking, wait this long before we auto-end the utterance.
// Short enough to feel instant, long enough to survive mid-sentence breaths.
const SILENCE_HANG_MS = 900;

// Reject recordings shorter than this (accidental taps, premature auto-stop).
const MIN_UTTERANCE_MS = 350;

// Hard cap on recording duration. This is the backstop that fires if VAD
// silence detection fails — which on macOS WKWebView is common: if the
// microphone TCC prompt was dismissed or WKWebView media permissions
// didn't stick, `navigator.mediaDevices.getUserMedia` rejects and
// `useVoiceActivity` silently no-ops. When VAD is dead this cap is the
// ONLY thing that ends the turn, so every voice turn sits here the full
// duration. 6 s is long enough for any "hello"/"what's the weather"
// utterance but short enough to not be a 25 s wait if VAD fails. Healthy
// VAD paths terminate ~900 ms after the user stops speaking and never
// hit this cap.
const MAX_RECORDING_MS = 6_000;

// After the AI finishes speaking in continuous mode, wait briefly before
// re-opening the mic. Just long enough to let the speaker's tail trail off.
const CONTINUOUS_REOPEN_MS = 250;

// Barge-in: when the user speaks *through* the AI, wait this long past speech
// onset before we interrupt — filters out cough/keyboard clicks.
const BARGE_IN_ONSET_MS = 220;

// Conversation memory. Enough context for a natural back-and-forth without
// runaway prompt cost — each pair is one user turn plus one assistant turn.
const MAX_HISTORY_TURNS = 8;

// Optimistic acknowledgement (DISABLED).
//
// We used to fire a one-word "Right." / "On it." through Kokoro the moment
// whisper handed us a transcript, to cover the 4-20 s LLM cold-load. But
// the ack-then-reply pattern reads as two-voices-in-sequence even though
// both are Kokoro George — the ack is punctuated and short, the reply is
// flowing and long, and users hear them as separate speakers. The model
// is fast enough now (sub-second on warm Ollama, ~3 s on cold) that the
// cost of dead air is lower than the cost of the double-voice feel.
//
// Left in-place but unused so the historical pattern is documented; flip
// `ACK_ENABLED` to `true` to restore.
const ACK_ENABLED = false;
const ACK_VARIANTS: readonly string[] = ['Right.', 'Mm.', 'On it.', 'Okay.', 'Got it.'];
function pickAck(turnIdx: number): string {
  return ACK_VARIANTS[turnIdx % ACK_VARIANTS.length] ?? 'Right.';
}


// Stable session id for the voice conversation. Distinct from the Overview
// chat panel's session so voice and typed chat don't accidentally share
// context — you can be debugging one thing by voice and asking a totally
// unrelated typed question at the same time.
const VOICE_SESSION_KEY = 'sunny.voice.sessionId.v1';

function loadVoiceSessionId(): string {
  try {
    const existing = localStorage.getItem(VOICE_SESSION_KEY);
    if (existing && existing.length > 0) return existing;
  } catch { /* private mode */ }
  const sid = `sunny-voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try { localStorage.setItem(VOICE_SESSION_KEY, sid); } catch { /* ignore */ }
  return sid;
}

type ChatTurn = { role: 'user' | 'assistant'; content: string };


// Per-turn timing trace. Each voice turn gets a random 6-char `turn_id`
// suffix so frontend and backend traces can be reassembled post-hoc with
// `grep voice-trace`. `t_ms` is absolute ms since the user pressed space
// (recordStartRef); `dt_ms` is the delta from the previous trace point in
// the same turn. Emission shape is identical to the backend:
//   [voice-trace] stage=<name> t_ms=<abs> dt_ms=<delta> turn=<id> ...
function makeTurnId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function useVoiceChat(): VoiceChatApi {
  const voiceName = useView(s => s.settings.voiceName);
  const voiceRate = useView(s => s.settings.voiceRate);
  const provider = useView(s => s.settings.provider);
  const model = useView(s => s.settings.model);
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [response, setResponse] = useState<string>('');
  const [continuous, setContinuous] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const responseBufferRef = useRef<string>('');
  const speakerRef = useRef<StreamSpeaker | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  const continuousRef = useRef<boolean>(false);
  const stateRef = useRef<VoiceState>('idle');
  const runningRef = useRef<boolean>(false);
  const recordStartRef = useRef<number>(0);
  const voiceRef = useRef<string>(voiceName ?? 'George');
  const rateRef = useRef<number>(voiceRate ?? 180);
  const historyRef = useRef<ChatTurn[]>([]);
  const turnIdRef = useRef<number>(0);
  const sessionIdRef = useRef<string>(loadVoiceSessionId());

  // Constitution snapshot for the in-flight turn. Loaded once per voice
  // turn (at transcribe-time) so both the streaming `done: true` branch
  // and the non-streaming safety-net can run the verifier synchronously
  // without awaiting the Tauri round-trip on the hot path. `null` means
  // the loader hasn't resolved yet for this turn (first-ever turn, or
  // backend unreachable) — `sanitizeVoiceAnswer` handles null as
  // pass-through, which preserves fail-open semantics.
  const constitutionRef = useRef<Awaited<ReturnType<typeof loadConstitution>>>(null);

  // Guard against double-sanitizing the same turn's response. The chat-
  // chunk effect fires on `done: true` AND the safety-net in `runPipeline`
  // may re-feed `fullResponse` if no chunks landed; if both paths fire we
  // only want to log ONE kick per violation. Reset at turn boundaries.
  const sanitizedThisTurnRef = useRef<boolean>(false);

  // Per-turn tracing: stable random id + last trace timestamp so each line
  // can report dt_ms from the prior stage in the same turn.
  const traceTurnIdRef = useRef<string>('');
  const lastTraceRef = useRef<number>(0);

  const trace = useCallback((stage: string, extra?: Record<string, string | number>) => {
    const t0 = recordStartRef.current;
    const now = typeof performance !== 'undefined' ? performance.now() + performance.timeOrigin : Date.now();
    const abs = t0 > 0 ? Math.max(0, Math.round(now - t0)) : 0;
    const dt = lastTraceRef.current > 0 ? Math.max(0, Math.round(now - lastTraceRef.current)) : 0;
    lastTraceRef.current = now;
    const turn = traceTurnIdRef.current || '------';
    const extras = extra
      ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')
      : '';
    // eslint-disable-next-line no-console
    console.info(`[voice-trace] stage=${stage} t_ms=${abs} dt_ms=${dt} turn=${turn} state=${stateRef.current}${extras}`);
  }, []);

  useEffect(() => { continuousRef.current = continuous; }, [continuous]);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { voiceRef.current = voiceName ?? 'George'; }, [voiceName]);
  useEffect(() => { rateRef.current = voiceRate ?? 180; }, [voiceRate]);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  // Forward declaration — the VAD hook needs `runPipeline`/`startRecording`,
  // but those close over the voice-activity state. We resolve the cycle with
  // refs so each side sees a stable callable.
  const runPipelineRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const startRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Push-to-talk hold flag. While the user is physically holding Space,
  // we disable VAD's auto-stop — the key release is the ONLY signal that
  // ends the turn. Without this, a mid-sentence pause > 900 ms gets
  // classified as silence and the turn processes prematurely, chopping
  // the user off. Flipped by the PTT event listeners below.
  const pttHoldingRef = useRef<boolean>(false);

  // Voice activity: silence-based auto-stop while recording, barge-in while
  // speaking. The analyser stream is shared — one getUserMedia, reused.
  const vadEnabled = state === 'recording' || state === 'speaking';
  const vadMode = state === 'speaking' ? 'barge-in' : 'listen';
  useVoiceActivity({
    enabled: vadEnabled,
    mode: vadMode,
    onSilence: () => {
      if (stateRef.current !== 'recording') return;
      if (pttHoldingRef.current) {
        // User is still holding Space — pauses are intentional (thinking
        // mid-sentence). Only the key release should end the turn.
        return;
      }
      const held = Date.now() - recordStartRef.current;
      if (held < MIN_UTTERANCE_MS) return;
      trace('vad_silence', { held_ms: held });
      void runPipelineRef.current();
    },
    onSpeechStart: () => {
      if (stateRef.current !== 'speaking') return;
      // Barge-in: cut the AI off and start listening.
      const speaker = speakerRef.current;
      if (speaker) { void speaker.stop(); }
      setState('idle');
      resumeTimerRef.current = window.setTimeout(() => {
        resumeTimerRef.current = null;
        void startRecordingRef.current();
      }, 40);
    },
    silenceMs: SILENCE_HANG_MS,
    onsetMs: BARGE_IN_ONSET_MS,
  });

  // --- Chat streaming → TTS pipeline --------------------------------------
  //
  // Sprint-9 migration: the streaming transport moved from Tauri
  // `sunny://chat.chunk` / `chat.done` listeners to the Rust event bus's
  // `SunnyEvent::ChatChunk` variant. `useEventBus` is push-mode and
  // returns events newest-first — we walk the tail of new events since
  // our last-seen key so streaming accumulation still progresses in
  // order. The terminal chunk (`done: true`) folds `finalText` into the
  // speaker exactly the way the legacy `chat.done` handler did; any
  // trailing delta on the terminal frame is merged into the
  // accumulator before TTS feed so a provider that puts the tail on the
  // done frame doesn't lose bytes.
  //
  // Note: providers outside the event-bus publish contract (notably the
  // `voiceAgent.ts` frontend shim and the buffered non-streaming
  // fallback in `core.rs`) don't land on the bus. Voice turns survive
  // that because `runPipeline` already has a "no chunks fed the
  // speaker" safety net that feeds `fullResponse` directly (see the
  // block gated on `!hasSpoken && responseBufferRef.current.length === 0`
  // further down). Chat UI lands the legacy emit as a single terminal
  // chunk via that same fallback.
  const chatChunkEvents = useEventBus({ kind: 'ChatChunk', limit: 500 });
  const lastSeenChunkKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (chatChunkEvents.length === 0) return;

    type ChatChunkEvent = Extract<SunnyEvent, { kind: 'ChatChunk' }>;
    const keyOf = (e: ChatChunkEvent): string =>
      typeof e.seq === 'number'
        ? `seq|${e.seq}`
        : `at|${e.at}|${e.turn_id}|${e.delta.length}|${e.done ? 1 : 0}`;

    const lastSeen = lastSeenChunkKeyRef.current;
    const freshOldestFirst: ChatChunkEvent[] = [];
    for (const e of chatChunkEvents) {
      if (e.kind !== 'ChatChunk') continue;
      const key = keyOf(e);
      if (key === lastSeen) break;
      freshOldestFirst.unshift(e);
    }
    if (freshOldestFirst.length === 0) return;
    lastSeenChunkKeyRef.current = keyOf(
      freshOldestFirst[freshOldestFirst.length - 1],
    );

    for (const evt of freshOldestFirst) {
      const delta = typeof evt.delta === 'string' ? evt.delta : '';
      const done = evt.done === true;

      if (delta.length > 0) {
        responseBufferRef.current = responseBufferRef.current + delta;
        setResponse(responseBufferRef.current);
        // Chat UI streams live; TTS does NOT feed on deltas.
        // Multi-iteration ReAct turns emit intermediate narrative
        // ("Let me check the calendar…" → tool call → "You have 3
        // events"). Speaking each intermediate line read like two
        // voices talking over each other — narrator then presenter.
        // We buffer silently here and let the terminal (`done: true`)
        // frame feed the FINAL answer into the speaker as one clean
        // utterance. Trade-off: ~1-2 s later first-spoken-word, no
        // more "she's saying two different things".
      }

      if (done) {
        // Run the shared constitution `verifyAnswer` on the fully-composed
        // reply before it hits TTS. The chat path does the same thing in
        // `agentLoop.ts`, but voice historically bypassed it (J v4
        // friction #5 — George rambling for 2 min on a short question).
        //
        // `sanitizeVoiceAnswer` is fail-open: a thrown verifier returns
        // the original text unchanged and logs the error. Any rewrite
        // (truncate, emoji strip) is applied to the buffer ref so the
        // non-streaming safety-net below sees the sanitized text too;
        // the `sanitizedThisTurnRef` latch prevents double-logging the
        // same violation if both paths run.
        const rawFinal = responseBufferRef.current;
        let finalText = rawFinal;
        if (!sanitizedThisTurnRef.current && rawFinal.trim().length > 0) {
          const sanitized = sanitizeVoiceAnswer(rawFinal, constitutionRef.current, {
            source: 'voice',
          });
          finalText = sanitized.text;
          sanitizedThisTurnRef.current = true;
          if (sanitized.rewritten) {
            responseBufferRef.current = finalText;
          }
        }
        setResponse(finalText);
        useVoiceChatStore.getState().setResponse(finalText);
        const speaker = speakerRef.current;
        if (speaker && finalText.trim().length > 0) {
          speaker.feed(finalText);
        }
      }
    }
  }, [chatChunkEvents]);

  useEffect(() => {
    return () => { clearResumeTimer(); };
  }, [clearResumeTimer]);

  // Backstop timer: auto-ends a recording that runs past MAX_RECORDING_MS
  // without VAD ever firing silence. Without this, a WKWebView getUserMedia
  // denial leaves the user sitting on LIVE · 0:40 with no way to progress
  // except the mic button — and they don't always know to tap it.
  const maxRecTimerRef = useRef<number | null>(null);
  const clearMaxRecTimer = useCallback(() => {
    if (maxRecTimerRef.current !== null) {
      window.clearTimeout(maxRecTimerRef.current);
      maxRecTimerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    if (!isTauri) {
      setError('voice chat needs macOS runtime');
      return;
    }
    try {
      // Fresh turn id + zeroed baseline so timings reflect THIS press-to-talk,
      // not the previous turn. recordStartRef is reassigned below before any
      // trace() call that cares about it.
      traceTurnIdRef.current = makeTurnId();
      recordStartRef.current = Date.now();
      lastTraceRef.current = 0;
      trace('startRecording');
      const status = await invokeSafe<RecordStatus>('audio_record_status', undefined, {
        recording: false,
        path: null,
        seconds: 0,
      });
      if (status && status.recording) {
        recordStartRef.current = Date.now();
        lastTraceRef.current = 0;
        setState('recording');
        trace('already_recording');
        return;
      }
      trace('record_start_invoke');
      await invoke<string>('audio_record_start');
      trace('record_start_ok');
      setError(null);
      recordStartRef.current = Date.now();
      lastTraceRef.current = 0;
      setState('recording');
      // Backstop timer — only meaningful when VAD is the turn-ender.
      // While PTT is held, the release is the authoritative end, so a
      // hold > 6 s should keep rolling. The handler re-arms itself if
      // still holding rather than running the pipeline.
      clearMaxRecTimer();
      const armBackstop = () => {
        maxRecTimerRef.current = window.setTimeout(() => {
          maxRecTimerRef.current = null;
          if (stateRef.current !== 'recording') return;
          if (pttHoldingRef.current) {
            // User still holding Space — re-arm and let them keep going.
            trace('max_rec_backstop_extended');
            armBackstop();
            return;
          }
          trace('max_rec_backstop');
          void runPipelineRef.current();
        }, MAX_RECORDING_MS);
      };
      armBackstop();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not start recording: ${msg}`);
      setState('idle');
    }
  }, [clearMaxRecTimer, trace]);

  const runPipeline = useCallback(async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    clearMaxRecTimer();
    try {
      trace('record_stop_invoke');
      let recordedPath: string;
      try {
        recordedPath = await invoke<string>('audio_record_stop');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`Recording failed: ${msg}`);
        setState('idle');
        return;
      }
      trace('record_stop_ok');

      setState('transcribing');
      trace('transcribe_invoke');
      let userText: string;
      try {
        userText = await invoke<string>('transcribe', { path: recordedPath });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`Transcription failed: ${msg}`);
        setState('idle');
        setContinuous(false);
        return;
      }

      const cleaned = userText.trim();
      trace('transcribe_ok', { text_len: cleaned.length });
      if (cleaned.length === 0) {
        setState('idle');
        if (continuousRef.current) {
          resumeTimerRef.current = window.setTimeout(() => {
            resumeTimerRef.current = null;
            void startRecording();
          }, CONTINUOUS_REOPEN_MS);
        }
        return;
      }

      setTranscript(cleaned);
      useVoiceChatStore.getState().setTranscript(cleaned);

      setState('thinking');
      responseBufferRef.current = '';
      setResponse('');

      // Reset the per-turn sanitize latch and preload the constitution
      // snapshot. The loader is cached in-process for 60 s so repeat
      // turns don't hit the Tauri side; the `void` is deliberate — a
      // failed load resolves to `null` which `sanitizeVoiceAnswer`
      // treats as pass-through, preserving fail-open. We fire the load
      // BEFORE chat_invoke so by the time the first streaming chunk
      // arrives (or the safety-net fires) the snapshot is ready.
      sanitizedThisTurnRef.current = false;
      void loadConstitution().then(c => { constitutionRef.current = c; });

      // Ack deliberately disabled — see ACK_ENABLED at the top of the file.
      // The historical call was here; the `pickAck` call below stays wired
      // in case we re-enable.
      if (ACK_ENABLED) {
        const ackIdx = turnIdRef.current;
        trace('think_start_ack_fired');
        void invokeSafe<void>('speak', {
          text: pickAck(ackIdx),
          voice: voiceRef.current,
          rate: rateRef.current,
        });
      }

      // Build a fresh streaming speaker for this turn. It flips us into
      // `speaking` the moment the first sentence actually goes out to `say`,
      // and flush() resolves only after the final utterance finishes — so we
      // no longer need the old WPM duration estimate.
      let hasSpoken = false;
      const speaker = createStreamSpeaker({
        voice: voiceRef.current,
        rate: rateRef.current,
        onSpeakStart: () => {
          if (!hasSpoken) {
            hasSpoken = true;
            setState('speaking');
          }
        },
        onError: (msg) => {
          setError(`Speech failed: ${msg}`);
        },
      });
      speakerRef.current = speaker;

      let fullResponse = '';
      const turnId = ++turnIdRef.current;
      trace('chat_invoke');
      // Primary path: route voice turns through the TS agent loop so they
      // get the same introspector / HTN / skill router / society / critic
      // treatment as the chat pane. Falls through to the legacy Tauri
      // `chat` command if the shim throws or hands back an empty reply —
      // voice reliability is higher priority than the new agentic path,
      // and the Rust path is what voice had before this sprint anyway.
      try {
        fullResponse = await voiceAgentRun({
          text: cleaned,
          history: historyRef.current,
          sessionId: sessionIdRef.current,
        });
      } catch (agentErr) {
        const amsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
        trace('voice_agent_fallback', { reason: amsg });
        fullResponse = '';
      }
      if (!fullResponse || fullResponse.trim().length === 0) {
        try {
          fullResponse = await invoke<string>('chat', {
            req: {
              message: cleaned,
              provider: provider,
              model: model,
              session_id: sessionIdRef.current,
              history: historyRef.current,
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(`Chat failed: ${msg}`);
          await speaker.stop();
          speakerRef.current = null;
          setState('idle');
          return;
        }
      }

      trace('chat_ok', { resp_len: fullResponse.length });

      // If another turn started while this one was in flight (barge-in,
      // manual stop, etc.), discard this reply — don't pollute history or
      // keep speaking over the new turn.
      if (turnId !== turnIdRef.current) {
        await speaker.stop();
        speakerRef.current = null;
        // This path previously fell through without `setState('idle')`.
        // A barge-in that bumped turnIdRef usually resets state itself,
        // but pressTalk-from-other-states can skip it, wedging the UI
        // at 'thinking'. Belt-and-suspenders reset.
        if (stateRef.current !== 'recording') setState('idle');
        trace('stale_turn_bail');
        return;
      }

      // Safety net: some providers emit the whole reply as a single final
      // delta (openclaw --json), and the Rust→JS event delivery can lose
      // the race against the invoke promise resolving. If no chunks fed the
      // speaker, feed the full reply to TTS *and* populate the React state
      // that OrbCore reads for the `SUNNY:` transcript — otherwise audio
      // plays but the footer stays stuck on `YOU:`, which is exactly the
      // symptom Sunny saw.
      if (!hasSpoken && responseBufferRef.current.length === 0 && fullResponse.trim().length > 0) {
        // Non-streaming turn — the done-chunk branch above never fired
        // because this provider returned everything at once. Run the
        // constitution verifier here too so voice never bypasses it.
        let safetyNetText = fullResponse;
        if (!sanitizedThisTurnRef.current) {
          const sanitized = sanitizeVoiceAnswer(fullResponse, constitutionRef.current, {
            source: 'voice',
          });
          safetyNetText = sanitized.text;
          sanitizedThisTurnRef.current = true;
        }
        responseBufferRef.current = safetyNetText;
        fullResponse = safetyNetText;
        setResponse(safetyNetText);
        useVoiceChatStore.getState().setResponse(safetyNetText);
        speaker.feed(safetyNetText);
      }

      // Commit this turn to rolling history FIRST (independent of TTS).
      const reply = (fullResponse && fullResponse.trim().length > 0)
        ? fullResponse.trim()
        : responseBufferRef.current.trim();
      if (reply.length > 0) {
        const next: ChatTurn[] = [
          ...historyRef.current,
          { role: 'user', content: cleaned },
          { role: 'assistant', content: reply },
        ];
        const maxMessages = MAX_HISTORY_TURNS * 2;
        historyRef.current = next.length > maxMessages
          ? next.slice(next.length - maxMessages)
          : next;
      }

      // Flip the UI to idle BEFORE awaiting the TTS flush. Two reasons:
      // (a) if Kokoro wedges on a single utterance, the flush can hang
      //     forever — the old ordering meant 'thinking' stayed visible
      //     while the response was already rendered in ChatPanel + Orb.
      // (b) perceptually, once audio starts playing, onSpeakStart will
      //     flip state to 'speaking' anyway, and the intermediate 'idle'
      //     never paints because React batches.
      setState('idle');
      trace('idle');

      // Race the flush against a per-turn ceiling. An individual stuck
      // utterance (bad WAV, afplay signal, koko cold-load hang) can't
      // freeze continuous mode or leak runningRef=true anymore.
      trace('speaker_flush_start');
      await Promise.race([
        speaker.flush(),
        new Promise<void>(resolve => setTimeout(resolve, 12_000)),
      ]);
      trace('speaker_flush_ok');
      speakerRef.current = null;

      if (continuousRef.current) {
        resumeTimerRef.current = window.setTimeout(() => {
          resumeTimerRef.current = null;
          void startRecording();
        }, CONTINUOUS_REOPEN_MS);
      }
    } catch (e) {
      // Previously any synchronous throw in the try left state frozen at
      // 'thinking' because `finally` only reset runningRef. Surface the
      // crash as an error toast and always guarantee the UI can recover.
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Voice pipeline crashed: ${msg}`);
      trace('pipeline_crash', { msg: msg.slice(0, 80) });
    } finally {
      runningRef.current = false;
      // Belt-and-suspenders: if no path reached idle, force it unless the
      // turn is deliberately still in an active listening phase.
      const s = stateRef.current;
      if (s !== 'idle' && s !== 'recording' && s !== 'speaking') {
        setState('idle');
      }
    }
  }, [provider, model, startRecording, clearMaxRecTimer, trace]);

  // Keep the refs for the VAD callbacks pointing at the latest closures.
  useEffect(() => { runPipelineRef.current = runPipeline; }, [runPipeline]);
  useEffect(() => { startRecordingRef.current = startRecording; }, [startRecording]);

  const pressTalk = useCallback(async (): Promise<void> => {
    if (!isTauri) {
      setError('voice chat needs macOS runtime');
      return;
    }
    clearResumeTimer();
    const current = stateRef.current;
    // `press_talk` always traces — but note that in the `idle` case the
    // trace() call below fires BEFORE startRecording mints a new turn id,
    // so this line lands on the previous turn's id (or `------` on first
    // press). That's deliberate: we want to know when the button was hit
    // regardless of which turn the hook considers active.
    trace('press_talk', { entry_state: current });
    if (current === 'idle') {
      await startRecording();
      return;
    }
    if (current === 'recording') {
      await runPipeline();
      return;
    }
    if (current === 'speaking') {
      // User pressed push-to-talk while Sunny is speaking — this is an
      // interrupt + immediate mic open. The previous implementation
      // called `speak_stop` and left the user at `idle` waiting for
      // another press; that felt laggy because a natural conversational
      // interrupt is ONE gesture, not two. Flow now:
      //   1. Silence the frontend speaker (stops feeding more sentences
      //      to Kokoro).
      //   2. Fire `speak_interrupt` on the backend — kills afplay,
      //      respawns the daemon, stamps INTERRUPTED_AT. Don't await
      //      the daemon respawn; it runs in parallel with mic open.
      //   3. Bump the turn id so any late chat reply is discarded.
      //   4. Immediately start recording the user's utterance.
      // The interrupt call is fire-and-forget for responsiveness —
      // `invokeSafe` swallows errors, and the audio kill inside the
      // backend is synchronous with the pkill, so by the time the Rust
      // future yields back the user already hears silence.
      trace('interrupt_speaking');
      const speaker = speakerRef.current;
      if (speaker) { void speaker.stop(); }
      speakerRef.current = null;
      void invokeSafe<void>('speak_interrupt');
      turnIdRef.current += 1;
      // Don't setState('idle') — startRecording will flip us straight
      // into 'recording', and an intermediate 'idle' frame would make
      // the orb flicker.
      await startRecording();
      return;
    }
    if (current === 'transcribing' || current === 'thinking') {
      // Abort the current turn: invalidate it, silence any speaker that
      // already started, and drop straight back to idle. The frontend
      // ignores any late reply because `turnId !== turnIdRef.current`.
      turnIdRef.current += 1;
      const speaker = speakerRef.current;
      if (speaker) { await speaker.stop(); }
      speakerRef.current = null;
      responseBufferRef.current = '';
      setResponse('');
      setState('idle');
    }
  }, [clearResumeTimer, runPipeline, startRecording, trace]);

  // -------------------------------------------------------------------------
  // Push-To-Talk (Hold Spacebar) integration
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handlePttStart = () => {
      const current = stateRef.current;
      trace('ptt_start', { entry_state: current });
      // Flag the hold — VAD's onSilence ignores while this is true, so
      // mid-sentence pauses don't chop the turn off.
      pttHoldingRef.current = true;
      if (current === 'idle') {
        void startRecording();
      } else if (current === 'speaking') {
        // Interrupt speaking and immediately start recording
        const speaker = speakerRef.current;
        if (speaker) { void speaker.stop(); }
        speakerRef.current = null;
        void invokeSafe<void>('speak_interrupt');
        turnIdRef.current += 1;
        void startRecording();
      } else if (current === 'transcribing' || current === 'thinking') {
        // Abort thought and drop to idle (they might want to re-record)
        turnIdRef.current += 1;
        const speaker = speakerRef.current;
        if (speaker) { void speaker.stop(); }
        speakerRef.current = null;
        responseBufferRef.current = '';
        setResponse('');
        setState('idle');
      }
    };

    const handlePttStop = () => {
      trace('ptt_stop', { entry_state: stateRef.current });
      pttHoldingRef.current = false;
      if (stateRef.current === 'recording') {
        void runPipeline();
      }
    };

    const handlePttCancel = () => {
      trace('ptt_cancel', { entry_state: stateRef.current });
      pttHoldingRef.current = false;
      if (stateRef.current === 'recording') {
        void invokeSafe<string>('audio_record_stop');
        setState('idle');
      }
    };

    window.addEventListener('sunny-ptt-start', handlePttStart);
    window.addEventListener('sunny-ptt-stop', handlePttStop);
    window.addEventListener('sunny-ptt-cancel', handlePttCancel);

    return () => {
      window.removeEventListener('sunny-ptt-start', handlePttStart);
      window.removeEventListener('sunny-ptt-stop', handlePttStop);
      window.removeEventListener('sunny-ptt-cancel', handlePttCancel);
    };
  }, [runPipeline, startRecording, trace]);

  const stop = useCallback((): void => {
    clearResumeTimer();
    const current = stateRef.current;
    if (current === 'idle' || current === 'recording') return;
    trace('stop_pressed', { entry_state: current });
    // Invalidate any in-flight turn so a late chat reply can't resurrect
    // the speaker.
    turnIdRef.current += 1;
    const speaker = speakerRef.current;
    if (speaker) { void speaker.stop(); }
    speakerRef.current = null;
    responseBufferRef.current = '';
    setResponse('');
    if (current === 'speaking') {
      // Kill afplay + stamp INTERRUPTED_AT so the agent-loop memory write
      // marks the turn as user-cancelled rather than cleanly completed.
      void invokeSafe<void>('speak_interrupt');
    }
    // Disable continuous so the pipeline doesn't auto-reopen the mic on
    // the pending resume timer. User can re-enable by tapping ∞.
    setContinuous(false);
    setState('idle');
  }, [clearResumeTimer, trace]);

  const toggleContinuous = useCallback((): void => {
    setContinuous(prev => {
      const next = !prev;
      if (!next) {
        clearResumeTimer();
      }
      return next;
    });
  }, [clearResumeTimer]);

  return {
    state,
    transcript,
    response,
    continuous,
    toggleContinuous,
    pressTalk,
    stop,
    error,
  };
}
