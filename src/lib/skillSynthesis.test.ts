import { describe, expect, it } from 'vitest';

// The module invokes `isTauri` at import time for gating, but we only
// need the pure helpers exposed via `__internal`; no Tauri mock needed
// because those helpers never touch `invokeSafe`.
import { __internal } from './skillSynthesis';

const { buildInputTemplate, deriveSkillName, shortHash, CONSTANT_THRESHOLD } =
  __internal;

// ---------------------------------------------------------------------------
// buildInputTemplate — constant extraction (phase 1)
// ---------------------------------------------------------------------------

describe('buildInputTemplate — constant extraction', () => {
  it('lifts a key whose value is identical across all runs', () => {
    const inputs = [
      { provider: 'weatherkit', limit: 5 },
      { provider: 'weatherkit', limit: 5 },
      { provider: 'weatherkit', limit: 5 },
      { provider: 'weatherkit', limit: 5 },
      { provider: 'weatherkit', limit: 5 },
    ];
    const goals = inputs.map(() => 'what is the weather');
    const t = buildInputTemplate(inputs, goals);
    expect(t.provider).toBe('weatherkit');
    expect(t.limit).toBe(5);
  });

  it('lifts when ≥80% agree (4 of 5) but not 3 of 5', () => {
    const mostly = [
      { tz: 'UTC' },
      { tz: 'UTC' },
      { tz: 'UTC' },
      { tz: 'UTC' },
      { tz: 'PST' },
    ];
    expect(buildInputTemplate(mostly, mostly.map(() => 'x')).tz).toBe('UTC');

    const tied = [
      { tz: 'UTC' },
      { tz: 'UTC' },
      { tz: 'UTC' },
      { tz: 'PST' },
      { tz: 'PST' },
    ];
    // 3/5 = 0.6 < 0.8 → not constant. Falls through. Goals don't include
    // these values, so the fallback is the keyname placeholder.
    expect(buildInputTemplate(tied, tied.map(() => 'x')).tz).toBe('{{$tz}}');
  });

  it('handles nested object constants via structural equality', () => {
    const inputs = [
      { opts: { deep: true, n: 1 } },
      { opts: { deep: true, n: 1 } },
      { opts: { deep: true, n: 1 } },
      { opts: { deep: true, n: 1 } },
      { opts: { deep: true, n: 1 } },
    ];
    const t = buildInputTemplate(inputs, inputs.map(() => 'x'));
    expect(t.opts).toEqual({ deep: true, n: 1 });
  });

  it('matches the documented ≥80% ratio', () => {
    // Self-check: tests above depend on this exact value.
    expect(CONSTANT_THRESHOLD).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// buildInputTemplate — goal-variable extraction (phase 2)
// ---------------------------------------------------------------------------

describe('buildInputTemplate — goal-derived values', () => {
  it('replaces with {{$goal}} when every value is a substring of its goal', () => {
    const inputs = [
      { query: 'ai research dashboard' },
      { query: 'founderlink investors' },
      { query: 'virgin lawsuit ceiling panel' },
      { query: 'govgrants post-award' },
      { query: 'aitok app' },
    ];
    const goals = [
      'find the ai research dashboard project',
      'how is founderlink investors progressing',
      'summarise virgin lawsuit ceiling panel notes',
      'open govgrants post-award brief',
      'latest on aitok app status',
    ];
    const t = buildInputTemplate(inputs, goals);
    expect(t.query).toBe('{{$goal}}');
  });

  it('does NOT use {{$goal}} when one value fails the substring check', () => {
    const inputs = [
      { q: 'alpha' },
      { q: 'beta' },
      { q: 'gamma' },
      { q: 'delta' },
      { q: 'unrelated' },
    ];
    const goals = [
      'about alpha',
      'about beta',
      'about gamma',
      'about delta',
      'about something else entirely',
    ];
    // String falls back to the keyname placeholder, not {{$goal}}.
    expect(buildInputTemplate(inputs, goals).q).toBe('{{$q}}');
  });

  it('is case-insensitive when checking goal substring', () => {
    const inputs = [{ topic: 'React' }, { topic: 'Vite' }, { topic: 'Zustand' }];
    const goals = [
      'tell me about react',
      'what is vite doing',
      'explain ZUSTAND store',
    ];
    expect(buildInputTemplate(inputs, goals).topic).toBe('{{$goal}}');
  });
});

// ---------------------------------------------------------------------------
// buildInputTemplate — arbitrary variable extraction (phase 3)
// ---------------------------------------------------------------------------

describe('buildInputTemplate — arbitrary variables', () => {
  it('emits {{$key}} placeholder for arbitrary strings', () => {
    const inputs = [
      { id: 'x1' },
      { id: 'x2' },
      { id: 'x3' },
      { id: 'x4' },
      { id: 'x5' },
    ];
    const goals = inputs.map(() => 'unrelated goal text');
    expect(buildInputTemplate(inputs, goals).id).toBe('{{$id}}');
  });

  it('type-safety guard: non-string arbitrary values fall back to first cluster value', () => {
    // Different numeric values per run — no majority, no goal derivation
    // possible (numbers). Template MUST keep the first value rather than
    // emit a placeholder string, or the tool's input_schema (expects
    // number) will reject on first run. This is the κ-3 friction #1 fix.
    const inputs = [
      { port: 3000 },
      { port: 3001 },
      { port: 3002 },
      { port: 3003 },
      { port: 3004 },
    ];
    const goals = inputs.map(() => 'unrelated');
    const t = buildInputTemplate(inputs, goals);
    expect(t.port).toBe(3000);
    expect(typeof t.port).toBe('number');
  });

  it('returns {} when no inputs are provided', () => {
    expect(buildInputTemplate([], [])).toEqual({});
  });

  it('preserves first-seen key ordering for stability across ticks', () => {
    const inputs = [
      { a: 1, b: 2 },
      { b: 2, a: 1, c: 3 },
    ];
    const goals = ['x', 'x'];
    const keys = Object.keys(buildInputTemplate(inputs, goals));
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate inputs (immutability guarantee)', () => {
    const run1 = { shared: 'yes', uniq: 'a' };
    const run2 = { shared: 'yes', uniq: 'b' };
    const snapshot1 = JSON.stringify(run1);
    const snapshot2 = JSON.stringify(run2);
    buildInputTemplate([run1, run2, run1, run2, run1], [
      'g', 'g', 'g', 'g', 'g',
    ]);
    expect(JSON.stringify(run1)).toBe(snapshot1);
    expect(JSON.stringify(run2)).toBe(snapshot2);
  });
});

// ---------------------------------------------------------------------------
// shortHash / deriveSkillName — collision resistance of the widened hash
// ---------------------------------------------------------------------------

describe('shortHash — 32-bit widening', () => {
  it('emits 8 hex chars (not 4)', () => {
    expect(shortHash('foo|bar').length).toBe(8);
    expect(shortHash('a')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('zero-pads small hash values to 8 chars', () => {
    // Deterministic FNV output — whatever string produces a small hash,
    // the result must still be exactly 8 chars wide so name length is
    // consistent in the UI. We don't know in advance which string hashes
    // small, so probe a handful and assert the width invariant.
    for (const s of ['', 'a', 'ab', 'abc', 'x|y', 'tool_a|tool_b']) {
      expect(shortHash(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('keeps birthday collisions negligible across 10k distinct sequences', () => {
    // With the prior 16-bit slice, 10k inputs into 65536 buckets gives
    // ~53% birthday collision. With 32-bit, the expected collision count
    // is <0.02 — practically always 0.
    const seen = new Map<string, string>();
    let collisions = 0;
    for (let i = 0; i < 10_000; i += 1) {
      // A few permutations per i to spread the input distribution.
      const key = `tool_${i % 37}|web_${i}|mem_${(i * 7) % 97}|answer_${i >> 3}`;
      const h = shortHash(key);
      const prev = seen.get(h);
      if (prev !== undefined && prev !== key) collisions += 1;
      else seen.set(h, key);
    }
    // Allow up to 2 collisions as a very loose ceiling; in practice it's
    // nearly always 0. Regression guard: if someone re-narrows the hash
    // this count explodes immediately.
    expect(collisions).toBeLessThanOrEqual(2);
  });

  it('deterministic — same input yields same hash', () => {
    expect(shortHash('calendar|mail|answer')).toBe(shortHash('calendar|mail|answer'));
  });
});

describe('deriveSkillName — uses widened hash', () => {
  it('produces names ending in 8-hex suffix', () => {
    const name = deriveSkillName('what is the weather', ['weather_get', 'answer']);
    expect(name).toMatch(/-[0-9a-f]{8}$/);
  });

  it('stable across calls for identical goal+sequence', () => {
    const a = deriveSkillName('check email inbox', ['mail_unread', 'answer']);
    const b = deriveSkillName('check email inbox', ['mail_unread', 'answer']);
    expect(a).toBe(b);
  });

  it('differs for different tool sequences (same goal)', () => {
    const a = deriveSkillName('summarise', ['web_fetch', 'answer']);
    const b = deriveSkillName('summarise', ['mail_unread', 'answer']);
    expect(a).not.toBe(b);
  });
});
