import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock tauri so `invokeSafe` doesn't try to reach a real backend during the
// verifier path's fire-and-forget log append.
vi.mock('./tauri', () => ({
  isTauri: false,
  invokeSafe: vi.fn(async () => null),
}));

vi.mock('../store/insights', () => ({
  pushInsight: vi.fn(),
}));

import {
  sanitizeVoiceAnswer,
  getSessionKickCount,
  subscribeKickCount,
  AMBER_PULSE_EVENT_NAME,
} from './constitutionKicks';
import type { Constitution } from './constitution';

const baseConstitution = (values: string[]): Constitution => ({
  schema_version: 1,
  identity: { name: 'SUNNY', voice: 'british', operator: 'sunny' },
  values,
  prohibitions: [],
});

describe('sanitizeVoiceAnswer — voice path verifier', () => {
  beforeEach(() => {
    // Session count bleeds across tests unless we reset; we do it by
    // running one sanitize-op and reading the delta rather than mutating
    // internal state — cleaner and doesn't require exporting a reset.
    // Each test asserts on the kick-count DELTA it produced.
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes an empty / null constitution through unchanged', () => {
    const before = getSessionKickCount();
    const r = sanitizeVoiceAnswer('any reply at all', null);
    expect(r.text).toBe('any reply at all');
    expect(r.violations).toHaveLength(0);
    expect(r.rewritten).toBe(false);
    expect(getSessionKickCount()).toBe(before);
  });

  it('truncates + appends ellipsis when max_words is exceeded', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const r = sanitizeVoiceAnswer(
      long,
      baseConstitution(['max_words:10']),
    );
    expect(r.rewritten).toBe(true);
    const words = r.text.replace(/\u2026$/, '').trim().split(/\s+/);
    expect(words).toHaveLength(10);
    expect(r.text.endsWith('\u2026')).toBe(true);
  });

  it('strips emoji when no_emoji is declared', () => {
    const r = sanitizeVoiceAnswer(
      'nice work 🎉 all done ✨',
      baseConstitution(['no_emoji']),
    );
    expect(r.rewritten).toBe(true);
    expect(r.text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('does NOT rewrite when no rules fire', () => {
    const r = sanitizeVoiceAnswer(
      'short clean reply',
      baseConstitution(['max_words:20', 'no_emoji']),
    );
    expect(r.rewritten).toBe(false);
    expect(r.text).toBe('short clean reply');
  });

  it('fails open on a thrown verifier (pass-through + log)', () => {
    // Force a verifier throw by shoving a non-iterable into values.
    // Easiest path: monkeypatch parse result by using a malformed constitution
    // that the parser can cope with but whose values trigger an edge case.
    // Instead we test the documented fail-open explicitly with a spy.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Casting a malformed shape in: non-array values would throw inside
    // parseConstitutionValues.
    const bad = { ...baseConstitution([]), values: 42 as unknown as string[] };
    const r = sanitizeVoiceAnswer('unchanged output', bad as Constitution);
    expect(r.text).toBe('unchanged output');
    expect(r.rewritten).toBe(false);
    // The error path logs but never throws.
    errSpy.mockRestore();
  });

  it('raises the amber pulse on confirm_destructive_ran violations', () => {
    // Node vitest env doesn't ship a `window` global, so stub a minimal
    // event target just for this assertion. We verify the dispatch via the
    // returned `needsAmberPulse` boolean; the DOM listener path is smoke-
    // tested here with a cheap addEventListener stub.
    const listener = vi.fn();
    const addEventListener = vi.fn((_name: string, _cb: () => void) => undefined);
    const dispatched: string[] = [];
    const dispatchEvent = vi.fn((e: { type: string }) => {
      dispatched.push(e.type);
      if (e.type === AMBER_PULSE_EVENT_NAME()) listener();
      return true;
    });
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      addEventListener,
      dispatchEvent,
    };
    try {
      const r = sanitizeVoiceAnswer(
        'done',
        baseConstitution(['confirm_destructive_ran']),
        {
          source: 'voice',
          toolCalls: [{ name: 'fs_trash', dangerous: true, confirmed: false }],
        },
      );
      expect(r.needsAmberPulse).toBe(true);
      expect(dispatched).toContain(AMBER_PULSE_EVENT_NAME());
      // Text must NOT be mutated — audit only, tool already ran.
      expect(r.text).toBe('done');
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('bumps the session kick count once per violation and notifies subscribers', () => {
    const before = getSessionKickCount();
    const changed = vi.fn();
    const unsub = subscribeKickCount(changed);
    sanitizeVoiceAnswer(
      Array.from({ length: 40 }, () => 'word').join(' ') + ' 🎉',
      baseConstitution(['max_words:5', 'no_emoji']),
    );
    // Two rules fired → two bumps.
    expect(getSessionKickCount() - before).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
    unsub();
  });

  // ---------------------------------------------------------------------
  // Sprint-13 ζ: channel-tag semantics
  //
  // Rule-parser semantics (from constitution.ts):
  //   tag           | applies on voice | applies on chat
  //   ------------- | ---------------- | ---------------
  //   (no tag)      |        Y         |        Y
  //   :voice        |        Y         |        N
  //   :chat         |        N         |        Y
  //   voice-inherent|        Y (default) | N
  //
  // Voice turns now tell the verifier they're voice via
  // `source: 'voice'`; voice-inherent rules (like `no_markdown_in_voice`)
  // fire even without the user manually adding `:voice` to the rule.
  // ---------------------------------------------------------------------

  it('voice turn auto-strips markdown even when the rule lacks a :voice suffix', () => {
    // User wrote `no_markdown_in_voice` with no channel tag. Pre-fix:
    // this was a no-op on voice turns because the old code required the
    // constraint string to be literally 'voice'. Post-fix: voice-inherent
    // rule + source='voice' fires regardless of whether the user
    // appended the tag.
    const reply = 'Sure — here is **bold** content and a `code span`.';
    const r = sanitizeVoiceAnswer(
      reply,
      baseConstitution(['no_markdown_in_voice']),
      { source: 'voice' },
    );
    // The rule fires (violation emitted) — even though the voice path
    // doesn't currently apply a rewrite for this rule, the block-
    // severity violation causes the belt-and-suspenders re-verify to
    // swap the text for CONSTITUTION_BLOCK_REPLY. We assert on
    // violations (the audit signal) rather than the final text to keep
    // this test robust to rewrite policy changes.
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
    expect(r.violations.some(v => v.kind === 'no_markdown_in_voice')).toBe(true);
  });

  it('chat turn with markdown is preserved (no tag → both channels; but no_markdown_in_voice is voice-inherent)', () => {
    // A chat turn should leave markdown untouched — markdown renders
    // fine in the chat pane and the user asked for it. The
    // voice-inherent default only kicks in when source==='voice'.
    const reply = 'Sure — here is **bold** content.';
    const r = sanitizeVoiceAnswer(
      reply,
      baseConstitution(['no_markdown_in_voice']),
      { source: 'chat' },
    );
    expect(r.text).toBe(reply);
    expect(r.rewritten).toBe(false);
    expect(r.violations).toHaveLength(0);
  });

  it('rule tagged :chat fires on chat turns, not on voice turns', () => {
    // Long reply that exceeds a :chat-scoped max_words. On a voice turn
    // the rule must NOT fire (tag says chat-only); on a chat turn it
    // must fire.
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const onVoice = sanitizeVoiceAnswer(
      long,
      baseConstitution(['max_words:5:chat']),
      { source: 'voice' },
    );
    expect(onVoice.violations).toHaveLength(0);
    expect(onVoice.rewritten).toBe(false);

    const onChat = sanitizeVoiceAnswer(
      long,
      baseConstitution(['max_words:5:chat']),
      { source: 'chat' },
    );
    expect(onChat.violations.some(v => v.kind === 'max_words')).toBe(true);
  });

  it('rule tagged :voice fires on voice turns, not on chat turns', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const onVoice = sanitizeVoiceAnswer(
      long,
      baseConstitution(['max_words:5:voice']),
      { source: 'voice' },
    );
    expect(onVoice.violations.some(v => v.kind === 'max_words')).toBe(true);
    expect(onVoice.rewritten).toBe(true);

    const onChat = sanitizeVoiceAnswer(
      long,
      baseConstitution(['max_words:5:voice']),
      { source: 'chat' },
    );
    expect(onChat.violations).toHaveLength(0);
    expect(onChat.rewritten).toBe(false);
  });

  it('runs in under 50 ms on a realistic 200-word reply (perf budget)', () => {
    const twoHundred = Array.from({ length: 200 }, (_, i) => `tok${i}`).join(' ');
    const values = [
      'max_words:150',
      'max_sentences:20',
      'no_emoji',
      'no_markdown_in_voice:voice',
      'require_british_english',
      'confirm_destructive_ran',
    ];
    const start = performance.now();
    sanitizeVoiceAnswer(twoHundred, baseConstitution(values));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
