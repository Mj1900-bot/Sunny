// Usage:
//   const speaker = createStreamSpeaker({ voice: 'Daniel', rate: 180 });
//   for await (const token of someStream()) speaker.feed(token);
//   await speaker.flush();

import { invoke, invokeSafe, isTauri } from './tauri';

export type StreamSpeakerOptions = {
  readonly voice?: string;         // default Daniel
  readonly rate?: number;          // default 180
  readonly onSpeakStart?: (text: string) => void;
  readonly onSpeakEnd?: (text: string) => void;
  readonly onError?: (err: string) => void;
};

export type StreamSpeaker = {
  /** Feed a partial text chunk. Auto-detects sentence boundaries and queues speech. */
  feed: (chunk: string) => void;
  /** Flush any pending buffer as one final utterance. */
  flush: () => Promise<void>;
  /** Interrupt and clear the queue immediately. Kills the current utterance. */
  stop: () => Promise<void>;
};

const DEFAULT_VOICE = 'George';
const DEFAULT_RATE = 180;
const MIN_UTTERANCE_LEN = 8;
const MAX_PENDING_LEN = 500;
const IDLE_FLUSH_MS = 800;

// Common abbreviations that end with a period but should NOT trigger a sentence split.
// Lowercased for case-insensitive match on the token immediately preceding the period.
const ABBREVIATIONS: ReadonlySet<string> = new Set<string>([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'v', 'cf', 'viz',
  'approx', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'u.s', 'u.k', 'u.n', 'a.m', 'p.m', 'no',
]);

type InternalState = {
  buffer: string;
  queueTail: Promise<void>;
  inCodeBlock: boolean;
  inThinkBlock: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /**
   * Bumped every time `stop()` is called. Each queued utterance captures
   * the generation at enqueue time; if a Tauri `speak` invocation returns
   * null AFTER the generation has moved on (meaning the user bargéd in or
   * manually cancelled while we were mid-utterance), we swallow the
   * error instead of surfacing a misleading "Speech failed" toast. Without
   * this, the race between `stop()` re-arming `state.stopped = false` and
   * the in-flight speak's promise resolving means the onError check
   * `!state.stopped` passes and the user sees a failure for audio they
   * literally just heard finish playing.
   */
  generation: number;
};

function isAbbreviation(buffer: string, periodIdx: number): boolean {
  // Walk backwards from the period to the previous whitespace to extract the token.
  let start = periodIdx - 1;
  while (start >= 0 && !/\s/.test(buffer[start]!)) {
    start = start - 1;
  }
  const token = buffer.slice(start + 1, periodIdx).toLowerCase();
  if (token.length === 0) return false;
  return ABBREVIATIONS.has(token);
}

// Minimum length (in chars) of a segment before we'll cut on a soft break
// (`:` / `;` / em-dash). Avoids speaking three-word fragments that sound
// clipped — full-stop breaks still fire regardless of length.
const SOFT_BREAK_MIN_LEN = 32;

function isSoftBreak(ch: string): boolean {
  return ch === ':' || ch === ';' || ch === '—';
}

function extractSentences(buffer: string): { sentences: ReadonlyArray<string>; remainder: string } {
  const sentences: string[] = [];
  let lastCut = 0;
  let i = 0;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === '\n') {
      const segment = buffer.slice(lastCut, i + 1);
      if (segment.trim().length > 0) sentences.push(segment);
      lastCut = i + 1;
      i = i + 1;
      continue;
    }
    if (ch === '.' || ch === '?' || ch === '!') {
      const next = i + 1 < buffer.length ? buffer[i + 1] : '';
      const atEnd = i + 1 >= buffer.length;
      const boundary = atEnd || next === ' ' || next === '\t' || next === '\n' || next === '\r';
      if (boundary && !atEnd) {
        if (ch === '.' && isAbbreviation(buffer, i)) {
          i = i + 1;
          continue;
        }
        const segment = buffer.slice(lastCut, i + 1);
        if (segment.trim().length > 0) sentences.push(segment);
        lastCut = i + 1;
      }
    } else if (isSoftBreak(ch)) {
      const next = i + 1 < buffer.length ? buffer[i + 1] : '';
      const atEnd = i + 1 >= buffer.length;
      const boundary = atEnd || next === ' ' || next === '\t' || next === '\n' || next === '\r';
      if (boundary && !atEnd) {
        const segment = buffer.slice(lastCut, i + 1);
        if (segment.trim().length >= SOFT_BREAK_MIN_LEN) {
          sentences.push(segment);
          lastCut = i + 1;
        }
      }
    }
    i = i + 1;
  }
  return {
    sentences,
    remainder: buffer.slice(lastCut),
  };
}

function stripNonSpoken(chunk: string, state: InternalState): string {
  let out = '';
  let i = 0;
  while (i < chunk.length) {
    if (chunk.startsWith('```', i)) {
      state.inCodeBlock = !state.inCodeBlock;
      i = i + 3;
      continue;
    }
    if (chunk.startsWith('<think>', i)) {
      state.inThinkBlock = true;
      i = i + 7;
      continue;
    }
    if (chunk.startsWith('</think>', i)) {
      state.inThinkBlock = false;
      i = i + 8;
      continue;
    }
    if (!state.inCodeBlock && !state.inThinkBlock) {
      out = out + chunk[i];
    }
    i = i + 1;
  }
  return out;
}

export function createStreamSpeaker(opts?: StreamSpeakerOptions): StreamSpeaker {
  const voice = opts?.voice ?? DEFAULT_VOICE;
  const rate = opts?.rate ?? DEFAULT_RATE;
  const onSpeakStart = opts?.onSpeakStart;
  const onSpeakEnd = opts?.onSpeakEnd;
  const onError = opts?.onError;

  const state: InternalState = {
    buffer: '',
    queueTail: Promise.resolve(),
    inCodeBlock: false,
    inThinkBlock: false,
    idleTimer: null,
    stopped: false,
    generation: 0,
  };

  const clearIdleTimer = (): void => {
    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  };

  const enqueueSpeak = (text: string): void => {
    const cleaned = text.trim();
    if (cleaned.length === 0) return;
    // Capture generation at enqueue time. If a stop() happens while we're
    // mid-utterance, the generation bumps and we know not to surface the
    // subsequent null from invokeSafe as a real error — the null is
    // expected because we deliberately killed afplay.
    const myGeneration = state.generation;
    state.queueTail = state.queueTail.then(async () => {
      if (state.stopped) return;
      // Outside Tauri there's no Rust speak — drop silently rather than
      // pretending to fail. The legacy invokeSafe path used to quietly
      // return null here; preserve that behavior explicitly.
      if (!isTauri) { if (onSpeakEnd) onSpeakEnd(cleaned); return; }
      if (onSpeakStart) onSpeakStart(cleaned);
      try {
        // Using raw `invoke` (not `invokeSafe`) so Rust's real error
        // string propagates — "koko exit 1: <stderr tail>" is actionable,
        // the previous "speak command failed for: <text>" was not.
        await invoke<void>('speak', { text: cleaned, voice, rate });
        if (onSpeakEnd) onSpeakEnd(cleaned);
      } catch (e) {
        const cancelled = myGeneration !== state.generation || state.stopped;
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (onError) onError(msg);
      }
    });
  };

  const drainReadySentences = (): void => {
    const { sentences, remainder } = extractSentences(state.buffer);
    state.buffer = remainder;
    if (sentences.length === 0) return;

    // Merge consecutive sentences that are shorter than MIN_UTTERANCE_LEN.
    const merged: string[] = [];
    let pending = '';
    for (const s of sentences) {
      const candidate = pending.length > 0 ? `${pending} ${s.trim()}` : s.trim();
      if (candidate.length < MIN_UTTERANCE_LEN) {
        pending = candidate;
        continue;
      }
      merged.push(candidate);
      pending = '';
    }
    if (pending.length > 0) {
      // Push back onto buffer so the next chunk can grow it to length.
      state.buffer = pending + (state.buffer.length > 0 ? ` ${state.buffer}` : '');
    }
    for (const utterance of merged) {
      enqueueSpeak(utterance);
    }
  };

  const scheduleIdleFlush = (): void => {
    clearIdleTimer();
    if (state.buffer.length === 0) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (state.buffer.length >= MAX_PENDING_LEN) {
        const utterance = state.buffer.trim();
        state.buffer = '';
        if (utterance.length > 0) enqueueSpeak(utterance);
      }
    }, IDLE_FLUSH_MS);
  };

  const feed = (chunk: string): void => {
    if (state.stopped) return;
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    if (chunk.trim().length === 0 && state.buffer.length === 0) return;

    const visible = stripNonSpoken(chunk, state);
    if (visible.length === 0) {
      scheduleIdleFlush();
      return;
    }
    state.buffer = state.buffer + visible;
    drainReadySentences();
    scheduleIdleFlush();
  };

  const flush = async (): Promise<void> => {
    clearIdleTimer();
    drainReadySentences();
    const remaining = state.buffer.trim();
    state.buffer = '';
    if (remaining.length > 0) {
      enqueueSpeak(remaining);
    }
    await state.queueTail;
  };

  const stop = async (): Promise<void> => {
    state.stopped = true;
    // Bump generation FIRST so any in-flight utterance sees the change the
    // moment its invokeSafe resolves (post-pkill), before we re-arm below.
    state.generation += 1;
    clearIdleTimer();
    state.buffer = '';
    // Replace the queue tail so any pending utterances do not run.
    state.queueTail = Promise.resolve();
    const result = await invokeSafe<void>('speak_stop');
    if (result === null) {
      if (onError) onError('speak_stop command failed');
    }
    // Re-arm for future use. Safe because the generation counter now
    // shields any still-pending speak() promise from firing onError.
    state.stopped = false;
  };

  return { feed, flush, stop };
}
