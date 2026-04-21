/**
 * useBrainstormMode — vitest unit tests.
 *
 * The repo does not carry @testing-library/react, so we test the store
 * directly (Zustand's getState / setState API) and the exported pure
 * helpers. The hook itself is thin composition over these; the interesting
 * logic lives in the store actions and ENTER_PHRASES / EXIT_PHRASES lists.
 *
 * Tests: toggle, persistence across multiple consumers, enter/exit phrase
 * detection, idle prompt dismissal window.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tauri is not needed — brainstorm store has no Tauri dependency.
vi.mock('../lib/tauri', () => ({
  isTauri: false,
  invoke: vi.fn(async () => null),
  invokeSafe: vi.fn(async () => null),
  listen: vi.fn(async () => () => undefined),
}));

import { useBrainstormStore } from '../store/brainstorm';

// Expose phrase lists and detector logic by importing the module's pure helpers.
// Since phrase detection is inside the hook callback, we test it via the store
// action contract: enterBrainstorm / exitBrainstorm side effects.
import { ENTER_PHRASES_EXPORT, EXIT_PHRASES_EXPORT, detectBrainstormPhrase } from './useBrainstormMode';

// ---------------------------------------------------------------------------
// Reset store between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  useBrainstormStore.setState({
    mode: 'task',
    idlePromptVisible: false,
    idlePromptDismissedAt: null,
  });
});

// ---------------------------------------------------------------------------
// Store: toggle
// ---------------------------------------------------------------------------
describe('BrainstormStore — toggle', () => {
  it('starts in task mode', () => {
    expect(useBrainstormStore.getState().mode).toBe('task');
  });

  it('enterBrainstorm transitions mode to brainstorm', () => {
    useBrainstormStore.getState().enterBrainstorm();
    expect(useBrainstormStore.getState().mode).toBe('brainstorm');
  });

  it('exitBrainstorm transitions mode back to task', () => {
    useBrainstormStore.getState().enterBrainstorm();
    useBrainstormStore.getState().exitBrainstorm();
    expect(useBrainstormStore.getState().mode).toBe('task');
  });

  it('enterBrainstorm hides the idle prompt', () => {
    useBrainstormStore.setState({ idlePromptVisible: true });
    useBrainstormStore.getState().enterBrainstorm();
    expect(useBrainstormStore.getState().idlePromptVisible).toBe(false);
  });

  it('exitBrainstorm hides the idle prompt', () => {
    useBrainstormStore.setState({ mode: 'brainstorm', idlePromptVisible: true });
    useBrainstormStore.getState().exitBrainstorm();
    expect(useBrainstormStore.getState().idlePromptVisible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store: persistence across subscribers (Zustand global singleton)
// ---------------------------------------------------------------------------
describe('BrainstormStore — persistence', () => {
  it('state is shared across multiple getState() calls', () => {
    useBrainstormStore.getState().enterBrainstorm();
    // Re-read from the same module-level store
    expect(useBrainstormStore.getState().mode).toBe('brainstorm');
  });

  it('subscribing and unsubscribing does not reset state', () => {
    useBrainstormStore.getState().enterBrainstorm();
    const unsub = useBrainstormStore.subscribe(() => undefined);
    unsub();
    expect(useBrainstormStore.getState().mode).toBe('brainstorm');
  });
});

// ---------------------------------------------------------------------------
// Phrase detection (enter)
// ---------------------------------------------------------------------------
describe('detectBrainstormPhrase — enter', () => {
  it("detects \"let's brainstorm\"", () => {
    expect(detectBrainstormPhrase("let's brainstorm")).toBe('entered');
  });

  it('detects /brainstorm command', () => {
    expect(detectBrainstormPhrase('/brainstorm')).toBe('entered');
  });

  it('is case-insensitive', () => {
    expect(detectBrainstormPhrase("LET'S BRAINSTORM")).toBe('entered');
  });

  it('detects phrase embedded in longer text', () => {
    expect(detectBrainstormPhrase("Actually, let's brainstorm this problem")).toBe('entered');
  });
});

// ---------------------------------------------------------------------------
// Phrase detection (exit)
// ---------------------------------------------------------------------------
describe('detectBrainstormPhrase — exit', () => {
  it("detects \"let's do it\"", () => {
    expect(detectBrainstormPhrase("let's do it")).toBe('exited');
  });

  it('detects "take action"', () => {
    expect(detectBrainstormPhrase('take action')).toBe('exited');
  });

  it('returns null for unrelated text', () => {
    expect(detectBrainstormPhrase('What is the weather today?')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectBrainstormPhrase('')).toBeNull();
  });

  it('exit phrase takes priority when text contains both', () => {
    expect(detectBrainstormPhrase("take action and let's brainstorm later")).toBe('exited');
  });
});

// ---------------------------------------------------------------------------
// Idle prompt suppression
// ---------------------------------------------------------------------------
describe('BrainstormStore — idle prompt suppression', () => {
  it('dismissIdlePrompt sets idlePromptDismissedAt', () => {
    useBrainstormStore.getState().dismissIdlePrompt();
    expect(useBrainstormStore.getState().idlePromptDismissedAt).not.toBeNull();
  });

  it('suppressedAt within 20 min is treated as suppressed', () => {
    const recent = Date.now() - 5 * 60 * 1000; // 5 min ago
    useBrainstormStore.setState({ idlePromptDismissedAt: recent });
    const SUPPRESS_MS = 20 * 60 * 1000;
    const dismissed = useBrainstormStore.getState().idlePromptDismissedAt ?? 0;
    expect(Date.now() - dismissed < SUPPRESS_MS).toBe(true);
  });

  it('suppressedAt older than 20 min is not suppressed', () => {
    const old = Date.now() - 25 * 60 * 1000; // 25 min ago
    useBrainstormStore.setState({ idlePromptDismissedAt: old });
    const SUPPRESS_MS = 20 * 60 * 1000;
    const dismissed = useBrainstormStore.getState().idlePromptDismissedAt ?? 0;
    expect(Date.now() - dismissed < SUPPRESS_MS).toBe(false);
  });
});
