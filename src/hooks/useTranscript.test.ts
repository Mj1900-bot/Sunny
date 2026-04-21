/**
 * Unit tests for sprint-13 θ `useTranscript` pure helpers.
 *
 * We target the testable primitives (`mergeRows`, `liveToRows`,
 * `turnRoleToTranscript`, `rowKey`) rather than the React hook itself —
 * the repo doesn't carry `@testing-library/react`, and the merge logic is
 * where the non-obvious behaviour lives (dedupe precedence, empty-row
 * filtering, FIFO cap, oldest-first ordering).
 */

import { describe, expect, it } from 'vitest';

// Inert Tauri bridge — useTranscript imports `invokeSafe` at module load,
// which would otherwise pull in the real @tauri-apps/api. The helper
// functions we test never dispatch, so returning null is enough.
import { vi } from 'vitest';
vi.mock('../lib/tauri', () => ({
  isTauri: false,
  invoke: vi.fn(async () => null),
  invokeSafe: vi.fn(async () => null),
  listen: vi.fn(async () => () => undefined),
}));

import { __testing, MAX_ROWS } from './useTranscript';
import type { LiveMessage, TranscriptRow } from './useTranscript';

const { mergeRows, liveToRows, turnRoleToTranscript, rowKey } = __testing;

// ---------------------------------------------------------------------------
// turnRoleToTranscript
// ---------------------------------------------------------------------------

describe('turnRoleToTranscript', () => {
  it('maps assistant → sunny', () => {
    expect(turnRoleToTranscript('assistant')).toBe('sunny');
  });
  it('maps user → user', () => {
    expect(turnRoleToTranscript('user')).toBe('user');
  });
  it('maps tool → system (surfaces activity without a fake SUNNY voice)', () => {
    expect(turnRoleToTranscript('tool')).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// rowKey
// ---------------------------------------------------------------------------

describe('rowKey', () => {
  it('combines at + role + text so equal-timestamp turns dedupe by content', () => {
    const a = rowKey('user', 'hello', 1000);
    const b = rowKey('user', 'hello', 1000);
    const c = rowKey('sunny', 'hello', 1000);
    const d = rowKey('user', 'world', 1000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('prefixes text at 64 chars so very long turns still produce a bounded key', () => {
    const long = 'x'.repeat(500);
    const key = rowKey('sunny', long, 42);
    // key = `${at}|${role}|${prefix}` — the prefix section is at most 64.
    const prefix = key.split('|').slice(2).join('|');
    expect(prefix.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// liveToRows
// ---------------------------------------------------------------------------

describe('liveToRows', () => {
  it('filters empty-text placeholder bubbles so transient streaming seeds do not leak', () => {
    const live: LiveMessage[] = [
      { role: 'user', text: 'hi', ts: 1 },
      { role: 'sunny', text: '', ts: 2 }, // streaming placeholder
      { role: 'sunny', text: 'hello', ts: 3 },
    ];
    const rows = liveToRows(live);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('hi');
    expect(rows[1].text).toBe('hello');
  });

  it('assigns stable keys via rowKey so dedupe + React keys agree', () => {
    const live: LiveMessage[] = [{ role: 'user', text: 'hi', ts: 1 }];
    const rows = liveToRows(live);
    expect(rows[0].key).toBe(rowKey('user', 'hi', 1));
  });
});

// ---------------------------------------------------------------------------
// mergeRows
// ---------------------------------------------------------------------------

function make(role: 'user' | 'sunny' | 'system', text: string, at: number): TranscriptRow {
  return { key: rowKey(role, text, at), role, text, at };
}

describe('mergeRows', () => {
  it('returns [] when both inputs empty', () => {
    expect(mergeRows([], [])).toEqual([]);
  });

  it('sorts merged rows oldest-first', () => {
    const warm = [make('user', 'early', 100), make('sunny', 'mid', 300)];
    const live = [make('user', 'late', 500)];
    const merged = mergeRows(warm, live);
    expect(merged.map(r => r.text)).toEqual(['early', 'mid', 'late']);
  });

  it('dedupes by key, preferring the live copy when keys collide', () => {
    // Warm replay and live state both carry the same turn — the agent
    // loop persists after emitting the chat.chunk events, so during the
    // hand-off window both streams see it. Live wins.
    const at = 1000;
    const warmRow = make('sunny', 'hello', at);
    // Mutate text slightly to prove live took precedence (keys match
    // because key is prefix-limited — but rowKey above is short enough
    // that "hello" and "hello" would always collide; force that).
    const liveRow: TranscriptRow = {
      key: warmRow.key,
      role: 'sunny',
      text: 'LIVE WINS',
      at,
    };
    const merged = mergeRows([warmRow], [liveRow]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('LIVE WINS');
  });

  it('returns a new array reference each call so React diffs detect a change', () => {
    const warm = [make('user', 'a', 1)];
    const a = mergeRows(warm, []);
    const b = mergeRows(warm, []);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('caps output at MAX_ROWS with FIFO drop of the oldest', () => {
    const warm: TranscriptRow[] = [];
    for (let i = 0; i < MAX_ROWS + 5; i += 1) {
      warm.push(make('user', `turn-${i}`, i + 1));
    }
    const merged = mergeRows(warm, []);
    expect(merged).toHaveLength(MAX_ROWS);
    // Oldest (`turn-0`..`turn-4`) dropped; newest (`turn-5+`) kept.
    expect(merged[0].text).toBe('turn-5');
    expect(merged[merged.length - 1].text).toBe(`turn-${MAX_ROWS + 4}`);
  });

  it('interleaves warm + live by timestamp — not by source bucket', () => {
    const warm = [make('user', 'w1', 100), make('user', 'w2', 300)];
    const live = [make('sunny', 'l1', 200), make('sunny', 'l2', 400)];
    const merged = mergeRows(warm, live);
    expect(merged.map(r => r.text)).toEqual(['w1', 'l1', 'w2', 'l2']);
  });
});
