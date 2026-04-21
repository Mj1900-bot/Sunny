import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the tauri module BEFORE importing constitution.ts so that
// `isTauri` is true and `invokeSafe` returns whatever we set per-test.
const mockInvokeSafe = vi.fn();
vi.mock('./tauri', () => ({
  isTauri: true,
  invokeSafe: (...args: unknown[]) => mockInvokeSafe(...args),
}));

// Stub the insights store — gateToolCall pushes insights, but checkTool
// alone doesn't. We still import it so the module graph resolves cleanly.
vi.mock('../store/insights', () => ({
  pushInsight: vi.fn(),
}));

import {
  checkTool,
  invalidateConstitutionCache,
  verifyAnswer,
  parseConstitutionValues,
  CONSTITUTION_BLOCK_REPLY,
  type Constitution,
} from './constitution';

const baseConstitution: Constitution = {
  schema_version: 1,
  identity: { name: 'SUNNY', voice: 'british', operator: 'sunny' },
  values: [],
  prohibitions: [],
};

describe('checkTool — malformed prohibition guard', () => {
  beforeEach(() => {
    invalidateConstitutionCache();
    mockInvokeSafe.mockReset();
  });

  afterEach(() => {
    invalidateConstitutionCache();
  });

  it('does NOT block calendar_today when a rule has empty tools AND empty match_input_contains', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Malformed: both tools[] and match_input_contains[] are empty. The
    // hour window is wide-open (no bounds), so pre-fix this would block
    // every tool call at every hour.
    mockInvokeSafe.mockResolvedValueOnce({
      ...baseConstitution,
      prohibitions: [
        {
          description: 'user typo — forgot to fill in scope',
          tools: [],
          after_local_hour: null,
          before_local_hour: null,
          match_input_contains: [],
        },
      ],
    });

    const result = await checkTool('calendar_today', { when: 'today' });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring malformed prohibition'),
    );

    warnSpy.mockRestore();
  });

  it('still blocks when tools is empty but match_input_contains has a needle that matches (legitimate all-tools-by-input rule)', async () => {
    mockInvokeSafe.mockResolvedValueOnce({
      ...baseConstitution,
      prohibitions: [
        {
          description: 'never touch the payroll db',
          tools: [],
          after_local_hour: null,
          before_local_hour: null,
          match_input_contains: ['payroll'],
        },
      ],
    });

    const result = await checkTool('sql_exec', { query: 'select * from payroll' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('never touch the payroll db');
  });

  it('still blocks when a specific tool is named (the canonical case)', async () => {
    mockInvokeSafe.mockResolvedValueOnce({
      ...baseConstitution,
      prohibitions: [
        {
          description: 'no shell after hours',
          tools: ['shell_exec'],
          after_local_hour: null,
          before_local_hour: null,
          match_input_contains: [],
        },
      ],
    });

    const result = await checkTool('shell_exec', { cmd: 'ls' });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no shell after hours');
  });
});

describe('verifyAnswer — runtime answer verification', () => {
  it('returns no violations for an empty value list (fast path)', () => {
    const v = verifyAnswer('any answer at all, freely written', []);
    expect(v).toEqual([]);
  });

  it('returns no violations for an empty answer', () => {
    const v = verifyAnswer('', [{ key: 'max_words', constraint: '10' }]);
    expect(v).toEqual([]);
  });

  it('blocks when max_words cap is exceeded', () => {
    const longAnswer = 'one two three four five six seven eight nine ten eleven';
    const v = verifyAnswer(longAnswer, [{ key: 'max_words', constraint: '10' }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('max_words');
    expect(v[0].severity).toBe('block');
    expect(v[0].detail).toContain('11 words');
    expect(v[0].detail).toContain('cap is 10');
  });

  it('does NOT fire max_words on a compliant answer (no false positives)', () => {
    const v = verifyAnswer('short reply', [{ key: 'max_words', constraint: '10' }]);
    expect(v).toEqual([]);
  });

  it('blocks when max_sentences cap is exceeded', () => {
    const answer = 'First. Second. Third. Fourth.';
    const v = verifyAnswer(answer, [{ key: 'max_sentences', constraint: '2' }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('max_sentences');
    expect(v[0].severity).toBe('block');
  });

  it('does NOT fire max_sentences when under the cap', () => {
    const v = verifyAnswer('One. Two.', [{ key: 'max_sentences', constraint: '3' }]);
    expect(v).toEqual([]);
  });

  it('blocks on emoji when no_emoji is set', () => {
    const v = verifyAnswer('nice work 🎉', [{ key: 'no_emoji', constraint: '' }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('no_emoji');
    expect(v[0].severity).toBe('block');
  });

  it('does NOT fire no_emoji on plain ASCII', () => {
    const v = verifyAnswer('nice work, all done.', [{ key: 'no_emoji', constraint: '' }]);
    expect(v).toEqual([]);
  });

  it('fires no_markdown_in_voice only when constraint=voice and markdown is present', () => {
    const withMd = 'Here is **bold** text.';
    const v = verifyAnswer(withMd, [{ key: 'no_markdown_in_voice', constraint: 'voice' }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('no_markdown_in_voice');
    expect(v[0].severity).toBe('block');
  });

  it('does NOT fire no_markdown_in_voice on chat-only turns (constraint not "voice")', () => {
    const withMd = 'Here is **bold** text.';
    const v = verifyAnswer(withMd, [{ key: 'no_markdown_in_voice', constraint: '' }]);
    expect(v).toEqual([]);
  });

  it('does NOT fire no_markdown_in_voice when no markdown is present', () => {
    const plain = 'Plain prose with no markdown at all.';
    const v = verifyAnswer(plain, [{ key: 'no_markdown_in_voice', constraint: 'voice' }]);
    expect(v).toEqual([]);
  });

  it('warns (does not block) on US spellings when require_british_english is set', () => {
    const v = verifyAnswer('what color is it', [{ key: 'require_british_english', constraint: '' }]);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('require_british_english');
    expect(v[0].severity).toBe('warn');
  });

  it('does NOT fire require_british_english on UK spelling', () => {
    const v = verifyAnswer('what colour is it', [{ key: 'require_british_english', constraint: '' }]);
    expect(v).toEqual([]);
  });

  it('warns when a dangerous tool fired without ConfirmGate approval', () => {
    const v = verifyAnswer('done', [{ key: 'confirm_destructive_ran', constraint: '' }], {
      toolCalls: [{ name: 'shell_exec', dangerous: true, confirmed: false }],
    });
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('confirm_destructive_ran');
    expect(v[0].severity).toBe('warn');
    expect(v[0].detail).toContain('shell_exec');
  });

  it('does NOT fire confirm_destructive_ran when all dangerous tools were confirmed', () => {
    const v = verifyAnswer('done', [{ key: 'confirm_destructive_ran', constraint: '' }], {
      toolCalls: [{ name: 'shell_exec', dangerous: true, confirmed: true }],
    });
    expect(v).toEqual([]);
  });

  it('silently ignores unknown/freeform values (no false positives on "Be concise")', () => {
    const v = verifyAnswer('a very long answer indeed, far longer than concise', [
      { key: 'Be concise', constraint: '' },
      { key: 'Ask before destructive action', constraint: '' },
    ]);
    expect(v).toEqual([]);
  });

  it('aggregates multiple violations in a single pass', () => {
    const answer = 'lots of text here with emoji 🎉 and many extra words right now';
    const v = verifyAnswer(answer, [
      { key: 'max_words', constraint: '5' },
      { key: 'no_emoji', constraint: '' },
    ]);
    expect(v).toHaveLength(2);
    const kinds = v.map(x => x.kind).sort();
    expect(kinds).toEqual(['max_words', 'no_emoji']);
  });

  it('ignores invalid/unparseable integer constraints safely', () => {
    const v = verifyAnswer('anything at all here', [
      { key: 'max_words', constraint: 'not a number' },
      { key: 'max_sentences', constraint: '-5' },
    ]);
    expect(v).toEqual([]);
  });

  it('runs in under 5 ms on a realistic answer (perf budget)', () => {
    const answer = 'A paragraph of normal assistant prose, roughly twenty words in total here for testing.';
    const values = [
      { key: 'max_words', constraint: '100' },
      { key: 'max_sentences', constraint: '10' },
      { key: 'no_emoji', constraint: '' },
      { key: 'no_markdown_in_voice', constraint: 'voice' },
      { key: 'require_british_english', constraint: '' },
    ];
    const start = performance.now();
    verifyAnswer(answer, values);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
  });
});

describe('parseConstitutionValues — string → {key, constraint} parser', () => {
  it('parses "key:value" pairs', () => {
    const out = parseConstitutionValues(['max_words:50']);
    expect(out).toEqual([{ key: 'max_words', constraint: '50' }]);
  });

  it('parses "key=value" pairs', () => {
    const out = parseConstitutionValues(['max_sentences=3']);
    expect(out).toEqual([{ key: 'max_sentences', constraint: '3' }]);
  });

  it('parses bare tokens as key with empty constraint', () => {
    const out = parseConstitutionValues(['no_emoji']);
    expect(out).toEqual([{ key: 'no_emoji', constraint: '' }]);
  });

  it('passes freeform text through as a no-op key', () => {
    const out = parseConstitutionValues(['Be concise.', 'Ask before destructive action.']);
    // Freeform phrases go through as-is; the verifier will ignore them.
    expect(out).toHaveLength(2);
    expect(out[0].constraint).toBe('');
    expect(out[1].constraint).toBe('');
  });

  it('is lowercase-canonicalising on key names', () => {
    const out = parseConstitutionValues(['MAX_WORDS:20', 'No_Emoji']);
    expect(out[0].key).toBe('max_words');
    expect(out[1].key).toBe('no_emoji');
  });
});

describe('CONSTITUTION_BLOCK_REPLY — user-visible replacement string', () => {
  it('is a stable, non-empty sentence', () => {
    expect(CONSTITUTION_BLOCK_REPLY.length).toBeGreaterThan(0);
    expect(CONSTITUTION_BLOCK_REPLY).toContain('ground rule');
  });
});
