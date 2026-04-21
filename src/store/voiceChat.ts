/**
 * voiceChat store — shared voice transcript / response state.
 *
 * useVoiceChat writes here after each pipeline turn; ChatPanel reads here
 * instead of subscribing to window CustomEvents. This removes the time-window
 * race in ChatPanel's duplicate-detection logic (fix sprint-14/item-4) and
 * gives both consumers a single, strongly-typed source of truth.
 *
 * Only transcript and response are stored — everything else (VoiceState,
 * continuous, error) remains local to useVoiceChat because ChatPanel doesn't
 * need it.
 */
import { create } from 'zustand';

type VoiceChatState = {
  /** Latest whisper transcript for the current turn. Empty string between turns. */
  transcript: string;
  /** Accumulated SUNNY reply for the current turn. Empty string between turns. */
  response: string;
  /** Monotonically incrementing counter — bumped on every new transcript so
   *  ChatPanel can detect a new turn even when the text is identical to the
   *  previous one (e.g. the user says the same thing twice). */
  turnSeq: number;
  setTranscript: (text: string) => void;
  setResponse: (text: string) => void;
};

export const useVoiceChatStore = create<VoiceChatState>(set => ({
  transcript: '',
  response: '',
  turnSeq: 0,
  setTranscript: (text: string) =>
    set(s => ({ transcript: text, turnSeq: s.turnSeq + 1 })),
  setResponse: (text: string) => set({ response: text }),
}));
