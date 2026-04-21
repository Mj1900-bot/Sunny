// Voice turn shim over the TS-side agentic stack.
//
// Problem: before this file, voice turns bypassed the TS agent loop entirely.
// `useVoiceChat` invoked the Tauri `chat` command directly, which runs the
// Rust one-shot path (ai.rs). That skipped everything the chat pane gets:
// the introspector, HTN decomposer, System-1 skill router, society dispatcher,
// critic, and the full ReAct loop with tool access. Voice got a dumb LLM
// pass; chat got the full brain.
//
// This module routes voice turns through `runAgent` from `lib/agentLoop.ts`,
// which does run the whole stack. We keep the contract with useVoiceChat
// narrow and stable:
//
//   - Inputs: (text, history, sessionId) — the same tuple useVoiceChat
//     was sending to `invoke('chat')`. sessionId is preserved in logs only;
//     agentLoop manages continuity via its own episodic memory store, not a
//     per-session token. History is folded into the goal text as a short
//     transcript prefix so the agent has the last few turns in-context.
//
//   - Streaming contract: this shim does NOT publish to any streaming
//     transport. Earlier revisions twin-wrote a final `sunny://chat.chunk` +
//     `sunny://chat.done` pair through Tauri's frontend `emit()` bus so the
//     legacy chat-pane listener could see terminal frames. Sprint-9 moved
//     all chunk consumers (ChatPanel, useVoiceChat, OrbCore, AgentLogPanel)
//     onto the Rust `SunnyEvent::ChatChunk` event bus exclusively — the
//     frontend emits became reachable by no one and were removed in
//     sprint-10. The composed answer is returned directly to the caller;
//     `useVoiceChat` already has a safety-net branch
//     (`!hasSpoken && responseBufferRef.current.length === 0`) that folds
//     a returned `fullResponse` straight into the TTS speaker, which is
//     exactly the path voice turns take now.
//
//   - Streaming semantics: runAgent's internal chat calls still go through
//     the Rust `chat` command, which itself emits ChatChunk bus events for
//     each ReAct iteration (including raw JSON protocol deltas that look
//     ugly mid-stream). useVoiceChat's chunk-accumulator buffers those
//     silently and only feeds TTS on the terminal (`done: true`) frame, so
//     the composed answer we return here is what lands in the speaker via
//     the safety-net branch when no bus frames arrive for this turn.
//
//   - Failure mode: any thrown error or empty result bubbles back so the
//     caller can fall through to the legacy `invoke('chat')` path. Voice
//     reliability is non-negotiable; the new smarter path must never make
//     the mic feel broken.

import { runAgent } from './agentLoop';
import { invokeSafe } from './tauri';
import { useConfirmGate } from '../store/confirmGate';
import { useView } from '../store/view';

export type ChatTurn = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
};

export type VoiceAgentRunInput = {
  readonly text: string;
  readonly history: ReadonlyArray<ChatTurn>;
  readonly sessionId: string;
};

// How many prior turns to fold into the goal prefix. Voice already caps
// history at MAX_HISTORY_TURNS * 2 messages upstream; this is a second
// belt-and-suspenders cap so a misbehaving caller can't blow up the prompt.
const MAX_HISTORY_MESSAGES_IN_PROMPT = 12;

/**
 * Compose the user's new utterance plus recent conversation history into a
 * single goal string. We deliberately render this as a lightweight
 * transcript rather than as multi-turn chat messages, because runAgent's
 * goal field is a single string — the JSON ReAct protocol doesn't carry
 * role tags. This format is terse and LLM-legible:
 *
 *   Recent conversation:
 *   User: what's the weather
 *   SUNNY: Sunny, 18 degrees.
 *   User: and tomorrow?
 *
 *   Current request: and tomorrow?
 *
 * The agent treats the history as context for the current request, not as
 * instructions to replay.
 */
function composeGoal(text: string, history: ReadonlyArray<ChatTurn>): string {
  const trimmed = text.trim();
  if (history.length === 0) return trimmed;

  const recent = history.slice(-MAX_HISTORY_MESSAGES_IN_PROMPT);
  const transcript = recent
    .map(t => {
      const label = t.role === 'user' ? 'User' : 'SUNNY';
      return `${label}: ${t.content}`;
    })
    .join('\n');

  return [
    'Recent conversation:',
    transcript,
    '',
    `Current request: ${trimmed}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ConfirmGate wiring for voice turns
// ---------------------------------------------------------------------------
//
// Before this file wired `confirmDangerous`, `runAgent({ goal })` was called
// bare — meaning the TS-side dangerous-tool check at agentLoop.ts:1078
// silently no-oped, because the `opts.confirmDangerous` branch is gated on
// the callback being present. Any tool that survived the constitution and
// critic then fired without a gate. Voice saying "delete foo.txt" ran
// unattended.
//
// Here we route voice-driven requests through `useConfirmGate.askConfirm`,
// which queues a prompt in the same UI the Rust handshake uses. On denial
// the agent loop pushes a `User declined dangerous tool` step and carries
// on — the final answer reflects that the action didn't happen, which is
// the desired UX.
//
// Voice-only TTS: when a confirm is pending and the user is in a voice-
// driven turn, speak a brief prompt through Kokoro so a hands-free user
// hears what's waiting for their Enter/Escape. We gate this on the DOM
// `data-voice-state` attribute (same signal ConfirmGateModal uses) so
// chat-pane users never hear phantom voice — the modal itself does its
// own speak when it mounts, but that runs regardless of who originated
// the request; this voice-local speak is additive context for hands-free
// continuous sessions ("SUNNY wants to delete a file...") and short
// enough that double-speaking with the modal's own prompt is acceptable.
// We speak once per request, then let the modal's own speak take over.
//
// Voice states where speaking a prompt is appropriate: `speaking` (SUNNY
// is mid-reply, continuous flow) and `thinking` (user just finished,
// reply inbound). Skip `recording` / `transcribing` so we don't talk
// over an open mic; skip `idle` for voice-local speak since the modal's
// own prompt is sufficient when the user is at rest.
// ---------------------------------------------------------------------------

const VOICE_DRIVEN_STATES: ReadonlySet<string> = new Set([
  'speaking',
  'thinking',
]);

function currentVoiceState(): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLElement>('[data-voice-state]');
  return el?.getAttribute('data-voice-state') ?? null;
}

function isVoiceDriven(): boolean {
  const vs = currentVoiceState();
  return vs !== null && VOICE_DRIVEN_STATES.has(vs);
}

// Short spoken hint for voice-driven sessions. Kept terse — the modal
// fires its own, richer prompt when it renders; this is the low-latency
// heads-up while the modal mounts. Use the tool name as the verb hint
// since we don't have the full TOOL_DESCRIPTIONS map in this module.
function buildVoicePrompt(toolName: string): string {
  const verb = toolName.replace(/_/g, ' ');
  return `SUNNY wants to ${verb}. Enter to approve, escape to deny.`;
}

async function speakVoicePrompt(toolName: string): Promise<void> {
  try {
    const settings = useView.getState().settings;
    await invokeSafe<void>('speak', {
      text: buildVoicePrompt(toolName),
      voice: settings.voiceName || 'George',
      rate: settings.voiceRate,
    });
  } catch (err) {
    // TTS failure must not block the confirm flow — the modal still
    // shows on screen and keyboard input still works.
    console.warn('[voiceAgent] confirm prompt speak failed:', err);
  }
}

async function voiceConfirmDangerous(
  toolName: string,
  toolInput: unknown,
): Promise<boolean> {
  const { askConfirm } = useConfirmGate.getState();
  // Fire the voice-local prompt only for voice-driven turns. Don't await
  // the speak — we want the modal and the Promise to settle on the user's
  // keypress, not on TTS completion. Kokoro can keep talking while the
  // user hits Enter; that's expected.
  if (isVoiceDriven()) {
    void speakVoicePrompt(toolName);
  }
  return askConfirm({
    tool: toolName,
    input: toolInput,
    source: 'voice',
  });
}

/**
 * Run a voice turn through the TS agent loop. Returns the composed final
 * answer. Throws on unrecoverable failure so the caller can fall through
 * to the legacy Tauri invoke path.
 */
export async function voiceAgentRun(
  input: VoiceAgentRunInput,
): Promise<string> {
  const goal = composeGoal(input.text, input.history);
  if (goal.length === 0) {
    throw new Error('voiceAgentRun: empty goal');
  }

  const result = await runAgent({
    goal,
    confirmDangerous: voiceConfirmDangerous,
  });

  if (result.status === 'error') {
    throw new Error(`agentLoop error: ${result.finalAnswer}`);
  }

  const answer = result.finalAnswer.trim();
  if (answer.length === 0) {
    throw new Error('agentLoop returned empty answer');
  }

  // Return the composed answer directly. useVoiceChat's safety-net
  // (no-chunks-fed branch) folds this into the TTS speaker when the
  // Rust event bus hasn't produced a terminal ChatChunk for this turn —
  // which is the norm for the TS agent path, since runAgent's inner
  // Rust `chat` calls emit intermediate bus frames that useVoiceChat
  // silently buffers without speaking. No twin-write to the frontend
  // emit bus is needed or wanted.
  return answer;
}
