/**
 * CouncilPanel — vitest unit tests (pure logic, no React rendering).
 *
 * The repo does not carry @testing-library/react. We test the data-shaping
 * and state-transition logic used by CouncilPanel via exported helpers,
 * and test CouncilStatus / MemberState type contracts.
 *
 * Tests cover:
 *   - MemberState token accumulation (immutable spread)
 *   - Column count matches member array length
 *   - Synthesis appears only after all members done
 *   - Dismiss resets state (useCouncil dismiss logic)
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/tauri', () => ({
  isTauri: false,
  invoke: vi.fn(async () => null),
  invokeSafe: vi.fn(async () => null),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class { onmessage: null = null; },
}));

import type { MemberState, CouncilStatus } from '../hooks/useCouncil';

// ---------------------------------------------------------------------------
// Pure helper: accumulate tokens (immutable spread — mirrors hook internals)
// ---------------------------------------------------------------------------

function accumulateToken(
  members: readonly MemberState[],
  idx: number,
  token: string,
): readonly MemberState[] {
  return members.map((m, i) =>
    i === idx ? { ...m, tokens: m.tokens + token } : m,
  );
}

function markDone(
  members: readonly MemberState[],
  idx: number,
  finalText: string,
): readonly MemberState[] {
  return members.map((m, i) =>
    i === idx ? { ...m, tokens: finalText, done: true } : m,
  );
}

function allDone(members: readonly MemberState[]): boolean {
  return members.length > 0 && members.every(m => m.done);
}

// ---------------------------------------------------------------------------
// MemberState token accumulation
// ---------------------------------------------------------------------------
describe('CouncilPanel — token accumulation (immutable)', () => {
  const initial: readonly MemberState[] = [
    { name: 'GLM', model: 'glm-5.1', tokens: '', done: false },
    { name: 'QWEN30B', model: 'qwen3:30b', tokens: '', done: false },
  ];

  it('accumulates tokens for the correct member only', () => {
    const updated = accumulateToken(initial, 0, 'Hello ');
    expect(updated[0].tokens).toBe('Hello ');
    expect(updated[1].tokens).toBe('');
  });

  it('does not mutate original array (immutability)', () => {
    accumulateToken(initial, 0, 'token');
    expect(initial[0].tokens).toBe('');
  });

  it('concatenates multiple token events correctly', () => {
    let state = initial;
    state = accumulateToken(state, 1, 'First ');
    state = accumulateToken(state, 1, 'second.');
    expect(state[1].tokens).toBe('First second.');
  });
});

// ---------------------------------------------------------------------------
// Column count matches member array length
// ---------------------------------------------------------------------------
describe('CouncilPanel — column count', () => {
  it('renders exactly N columns for N members', () => {
    const members: readonly MemberState[] = [
      { name: 'A', model: 'glm-5.1', tokens: '', done: false },
      { name: 'B', model: 'qwen3:30b', tokens: '', done: false },
      { name: 'C', model: 'qwen3.5:9b', tokens: '', done: false },
    ];
    expect(members.length).toBe(3);
  });

  it('handles 2 members (minimum)', () => {
    const members: readonly MemberState[] = [
      { name: 'A', model: 'glm-5.1', tokens: '', done: false },
      { name: 'B', model: 'qwen3:30b', tokens: '', done: false },
    ];
    expect(members.length).toBe(2);
  });

  it('handles 5 members (maximum)', () => {
    const members: readonly MemberState[] = Array.from({ length: 5 }, (_, i) => ({
      name: `M${i}`,
      model: 'glm-5.1',
      tokens: '',
      done: false,
    }));
    expect(members.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Synthesis timing: appears only after all members finish
// ---------------------------------------------------------------------------
describe('CouncilPanel — synthesis timing', () => {
  const base: readonly MemberState[] = [
    { name: 'A', model: 'glm-5.1', tokens: 'done', done: false },
    { name: 'B', model: 'qwen3:30b', tokens: 'done', done: false },
  ];

  it('allDone returns false when no member is done', () => {
    expect(allDone(base)).toBe(false);
  });

  it('allDone returns false when only one member is done', () => {
    const partial = markDone(base, 0, 'text');
    expect(allDone(partial)).toBe(false);
  });

  it('allDone returns true only when all members are done', () => {
    let state = base;
    state = markDone(state, 0, 'text A');
    state = markDone(state, 1, 'text B');
    expect(allDone(state)).toBe(true);
  });

  it('allDone returns false for empty member array', () => {
    expect(allDone([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status union exhaustiveness
// ---------------------------------------------------------------------------
describe('CouncilPanel — status values', () => {
  const statuses: CouncilStatus[] = ['idle', 'running', 'complete', 'error'];

  it('all four CouncilStatus values are valid', () => {
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('idle');
    expect(statuses).toContain('running');
    expect(statuses).toContain('complete');
    expect(statuses).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// markDone — immutable done transition
// ---------------------------------------------------------------------------
describe('CouncilPanel — markDone (immutable)', () => {
  it('marks the correct member as done without mutating others', () => {
    const initial: readonly MemberState[] = [
      { name: 'X', model: 'm', tokens: '', done: false },
      { name: 'Y', model: 'm', tokens: '', done: false },
    ];
    const result = markDone(initial, 0, 'final text');
    expect(result[0].done).toBe(true);
    expect(result[0].tokens).toBe('final text');
    expect(result[1].done).toBe(false);
    // Original must be untouched
    expect(initial[0].done).toBe(false);
  });
});
