/**
 * Unit tests for sprint-9 δ additions to skillExecutor:
 *   • validateRecipe — static check against the in-process tool registry.
 *   • computeTrustClass — bucket a skill's telemetry.
 *
 * These helpers never touch Tauri or the network, so no mocks are needed.
 * We do register a small ad-hoc tool in the real registry because
 * `validateRecipe` resolves names against `TOOLS`; using a fresh test tool
 * keeps assertions decoupled from the built-in set (whose schemas may
 * evolve) but the registry is module-scoped, so built-ins loaded by
 * side-effect will also be present. That's fine — we only care about the
 * presence or absence of the specific names we reference.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tauri bridge stubs — registry.ts fires invokeSafe from inside `recordUsage`,
// but that path is never exercised by `validateRecipe` (we don't dispatch).
// Still, mocking keeps the module graph clean on import.
vi.mock('./tauri', () => ({
  isTauri: false,
  invoke: vi.fn(async () => null),
  invokeSafe: vi.fn(async () => null),
}));

import { registerTool } from './tools/registry';
import type { Tool } from './tools/types';
import {
  computeTrustClass,
  validateRecipe,
  __internal,
  __resetUnscopedWarnings,
  type SkillRecipe,
} from './skillExecutor';
import { __internal as synthInternal } from './skillSynthesis';

// ---------------------------------------------------------------------------
// A tiny tool registered once per test module so `validateRecipe` has a
// stable schema to check against.
// ---------------------------------------------------------------------------

const testTool: Tool = {
  schema: {
    name: 'test_echo',
    description: 'echo for validation tests',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        count: { type: 'number' },
        flag: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async () => ({ ok: true, content: 'echo', latency_ms: 0 }),
};

registerTool(testTool);

// ---------------------------------------------------------------------------
// validateRecipe
// ---------------------------------------------------------------------------

describe('validateRecipe', () => {
  it('returns valid=true when every tool resolves and args match', () => {
    const recipe: SkillRecipe = {
      steps: [
        { kind: 'tool', tool: 'test_echo', input: { text: 'hi', count: 3 } },
        { kind: 'answer', text: 'done' },
      ],
    };
    const v = validateRecipe(recipe);
    expect(v.valid).toBe(true);
    expect(v.issues).toHaveLength(0);
    expect(v.missingTools).toHaveLength(0);
  });

  it('flags missing tools in the missingTools list + issues', () => {
    const recipe: SkillRecipe = {
      steps: [
        { kind: 'tool', tool: 'ghost_tool', input: {} },
        { kind: 'tool', tool: 'another_phantom', input: {} },
        { kind: 'answer', text: 'x' },
      ],
    };
    const v = validateRecipe(recipe);
    expect(v.valid).toBe(false);
    expect([...v.missingTools].sort()).toEqual(['another_phantom', 'ghost_tool']);
    expect(v.issues.every(i => i.kind === 'missing_tool')).toBe(true);
  });

  it('flags missing required keys on tool input', () => {
    const recipe: SkillRecipe = {
      steps: [{ kind: 'tool', tool: 'test_echo', input: { count: 2 } }],
    };
    const v = validateRecipe(recipe);
    expect(v.valid).toBe(false);
    const missing = v.issues.find(i => i.kind === 'missing_required');
    expect(missing?.message).toMatch(/text/);
  });

  it('flags type mismatches on primitive-typed properties', () => {
    const recipe: SkillRecipe = {
      steps: [
        {
          kind: 'tool',
          tool: 'test_echo',
          // `count` declared as number but we pass a boolean
          input: { text: 'hi', count: true },
        },
      ],
    };
    const v = validateRecipe(recipe);
    expect(v.valid).toBe(false);
    const mismatch = v.issues.find(i => i.kind === 'type_mismatch');
    expect(mismatch?.message).toMatch(/count/);
    expect(mismatch?.message).toMatch(/number/);
  });

  it('treats template strings as valid even when type is not string', () => {
    // `count` is declared `number`, but a `{{...}}` template is runtime-only
    // — the validator should not reject it.
    const recipe: SkillRecipe = {
      steps: [
        {
          kind: 'tool',
          tool: 'test_echo',
          input: { text: '{{$goal}}', count: '{{$someSaved}}' },
        },
      ],
    };
    const v = validateRecipe(recipe);
    expect(v.valid).toBe(true);
  });

  it('returns a recipe_shape issue for malformed recipes', () => {
    const v = validateRecipe({ notSteps: [] });
    expect(v.valid).toBe(false);
    expect(v.issues[0].kind).toBe('recipe_shape');
  });

  it('ignores answer-only recipes (no tool refs to check)', () => {
    const recipe: SkillRecipe = {
      steps: [{ kind: 'answer', text: 'hello' }],
    };
    expect(validateRecipe(recipe).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeTrustClass
// ---------------------------------------------------------------------------

describe('computeTrustClass', () => {
  it('returns "fresh" when uses_count is 0', () => {
    expect(computeTrustClass({ uses_count: 0, success_count: 0 })).toBe('fresh');
  });

  it('returns "unknown" when uses_count < 3 (insufficient signal)', () => {
    expect(computeTrustClass({ uses_count: 1, success_count: 1 })).toBe('unknown');
    expect(computeTrustClass({ uses_count: 2, success_count: 2 })).toBe('unknown');
  });

  it('returns "trusted" at ≥ 3 uses AND ≥ 90% success rate', () => {
    expect(computeTrustClass({ uses_count: 3, success_count: 3 })).toBe('trusted');
    expect(computeTrustClass({ uses_count: 10, success_count: 9 })).toBe('trusted');
  });

  it('returns "flaky" at ≥ 3 uses AND < 50% success rate', () => {
    expect(computeTrustClass({ uses_count: 4, success_count: 1 })).toBe('flaky');
    expect(computeTrustClass({ uses_count: 10, success_count: 3 })).toBe('flaky');
  });

  it('returns "unknown" for middling success rate (50–89%)', () => {
    expect(computeTrustClass({ uses_count: 10, success_count: 7 })).toBe('unknown');
    expect(computeTrustClass({ uses_count: 4, success_count: 2 })).toBe('unknown');
  });

  it('handles undefined success_count as 0', () => {
    // Legacy rows without success_count land as "flaky" once they've got
    // enough uses — which is exactly what we want: "we don't know how well
    // this is doing, treat conservatively".
    expect(computeTrustClass({ uses_count: 5 })).toBe('flaky');
  });
});

// ---------------------------------------------------------------------------
// Capability scoping (sprint-10 δ / κ v9 #3)
// ---------------------------------------------------------------------------

const { checkCapability, parseRecipe } = __internal;

describe('checkCapability', () => {
  beforeEach(() => {
    __resetUnscopedWarnings();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows when the tool is in the capability list', () => {
    const result = checkCapability(
      'morning-brief',
      'skl_1',
      ['calc', 'weather_current'],
      'calc',
    );
    expect(result.allowed).toBe(true);
  });

  it('denies with a capability_denied reason when the tool is not listed', () => {
    const result = checkCapability(
      'morning-brief',
      'skl_1',
      ['calc', 'weather_current'],
      'mail_send',
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/capability_denied/);
      expect(result.reason).toMatch(/mail_send/);
      expect(result.reason).toMatch(/morning-brief/);
    }
  });

  it('denies everything when capabilities is an empty list', () => {
    // Empty list is not "absent" — it's the explicit "answer-only" scope.
    // No tool should be dispatchable.
    const result = checkCapability('answer-only', 'skl_2', [], 'calc');
    expect(result.allowed).toBe(false);
  });

  it('allows + warns once per session when capabilities is undefined', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    // First call for this skill id → warn.
    const r1 = checkCapability('legacy', 'skl_legacy', undefined, 'calc');
    expect(r1.allowed).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/full-access default/);

    // Repeat calls for the same skill → NO additional warnings.
    checkCapability('legacy', 'skl_legacy', undefined, 'web_fetch');
    checkCapability('legacy', 'skl_legacy', undefined, 'mail_send');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns independently for each distinct unscoped skill id', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    checkCapability('a', 'skl_a', undefined, 'calc');
    checkCapability('b', 'skl_b', undefined, 'calc');
    checkCapability('a', 'skl_a', undefined, 'calc'); // already-warned
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// parseRecipe — capabilities preservation
// ---------------------------------------------------------------------------

describe('parseRecipe — capabilities', () => {
  it('preserves a well-formed capabilities array', () => {
    const raw = {
      steps: [{ kind: 'tool', tool: 'test_echo', input: { text: 'hi' } }],
      capabilities: ['test_echo', 'calc'],
    };
    const parsed = parseRecipe(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.capabilities).toEqual(['test_echo', 'calc']);
  });

  it('de-duplicates capability names, preserving first-seen order', () => {
    const raw = {
      steps: [{ kind: 'answer', text: 'ok' }],
      capabilities: ['calc', 'calc', 'weather_current', 'calc'],
    };
    const parsed = parseRecipe(raw);
    expect(parsed!.capabilities).toEqual(['calc', 'weather_current']);
  });

  it('treats missing capabilities as undefined (legacy full access)', () => {
    const raw = { steps: [{ kind: 'answer', text: 'ok' }] };
    const parsed = parseRecipe(raw);
    expect(parsed!.capabilities).toBeUndefined();
  });

  it('treats malformed capabilities as absent (tolerance, not failure)', () => {
    // A single bad entry should not brick the whole recipe — it just
    // means "no enforced scope" which the executor will warn about.
    const raw = {
      steps: [{ kind: 'answer', text: 'ok' }],
      capabilities: ['calc', 42, 'weather_current'],
    };
    const parsed = parseRecipe(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.capabilities).toBeUndefined();
  });

  it('accepts an explicitly empty capabilities list', () => {
    // Empty = "answer-only" scope, distinct from undefined.
    const raw = {
      steps: [{ kind: 'answer', text: 'ok' }],
      capabilities: [],
    };
    const parsed = parseRecipe(raw);
    expect(parsed!.capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// skillSynthesis.inferCapabilities — auto-inference covers the recipe
// ---------------------------------------------------------------------------

describe('skillSynthesis.inferCapabilities', () => {
  it('returns the unique set of tool names in the sequence', () => {
    const caps = synthInternal.inferCapabilities([
      'calc',
      'weather_current',
      'calc',
      'memory_recall',
    ]);
    expect([...caps].sort()).toEqual(
      ['calc', 'memory_recall', 'weather_current'].sort(),
    );
  });

  it('preserves first-seen order for determinism', () => {
    const caps = synthInternal.inferCapabilities([
      'b',
      'a',
      'c',
      'a',
      'b',
    ]);
    expect(caps).toEqual(['b', 'a', 'c']);
  });

  it('skips empty and non-string entries safely', () => {
    const caps = synthInternal.inferCapabilities([
      'calc',
      '',
      'weather_current',
    ] as ReadonlyArray<string>);
    expect(caps).toEqual(['calc', 'weather_current']);
  });

  it('covers exactly the tools referenced in the compiled recipe', () => {
    // The contract we care about end-to-end: for every tool step the
    // synthesizer emits, the capability list must contain that tool.
    const sequence = ['mail_search', 'calendar_today', 'notes_create'];
    const caps = synthInternal.inferCapabilities(sequence);
    for (const tool of sequence) {
      expect(caps).toContain(tool);
    }
    // And it must not contain anything else.
    expect(caps).toHaveLength(sequence.length);
  });
});
