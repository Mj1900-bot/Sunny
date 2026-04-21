/**
 * Unit tests for ChatPanel/session.ts pure helpers.
 *
 * localStorage is shimmed with a minimal in-memory implementation so
 * no DOM environment dependency (jsdom/happy-dom) is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_KEY,
  SESSION_KEY,
  MAX_HISTORY,
  MAX_LLM_TURNS,
  loadHistory,
  loadSessionId,
  makeId,
  persistSessionId,
  rotateSessionId,
  saveHistory,
  turnsToMessages,
} from './session';
import type { Message, Turn } from './session';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal localStorage shim — replaces the global for all tests in this file.
// ─────────────────────────────────────────────────────────────────────────────

function makeLocalStorageShim() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

let lsShim: ReturnType<typeof makeLocalStorageShim>;

beforeEach(() => {
  lsShim = makeLocalStorageShim();
  vi.stubGlobal('localStorage', lsShim);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// makeId
// ─────────────────────────────────────────────────────────────────────────────

describe('makeId', () => {
  it('returns a non-empty string', () => {
    expect(makeId().length).toBeGreaterThan(0);
  });

  it('generates unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => makeId()));
    expect(ids.size).toBe(20);
  });

  it('contains a dash separator between timestamp and random parts', () => {
    const id = makeId();
    expect(id).toContain('-');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('STORAGE_KEY is the versioned history key', () => {
    expect(STORAGE_KEY).toBe('sunny.chat.history.v1');
  });

  it('SESSION_KEY is the versioned session key', () => {
    expect(SESSION_KEY).toBe('sunny.chat.sessionId.v1');
  });

  it('MAX_HISTORY is 100', () => {
    expect(MAX_HISTORY).toBe(100);
  });

  it('MAX_LLM_TURNS is 8', () => {
    expect(MAX_LLM_TURNS).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadSessionId
// ─────────────────────────────────────────────────────────────────────────────

describe('loadSessionId', () => {
  it('returns existing session id from localStorage', () => {
    lsShim.setItem(SESSION_KEY, 'sunny-chat-existing');
    const sid = loadSessionId();
    expect(sid).toBe('sunny-chat-existing');
  });

  it('generates a new session id when localStorage is empty', () => {
    const sid = loadSessionId();
    expect(sid.length).toBeGreaterThan(0);
    expect(sid).toMatch(/^sunny-chat-/);
  });

  it('persists the generated session id to localStorage', () => {
    const sid = loadSessionId();
    expect(lsShim.getItem(SESSION_KEY)).toBe(sid);
  });

  it('returns and stores a fresh id when stored value is empty string', () => {
    lsShim.setItem(SESSION_KEY, '');
    const sid = loadSessionId();
    expect(sid).toMatch(/^sunny-chat-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rotateSessionId
// ─────────────────────────────────────────────────────────────────────────────

describe('rotateSessionId', () => {
  it('returns a new sunny-chat-* prefixed id', () => {
    const sid = rotateSessionId();
    expect(sid).toMatch(/^sunny-chat-/);
  });

  it('overwrites any existing session id in localStorage', () => {
    lsShim.setItem(SESSION_KEY, 'old-session');
    const sid = rotateSessionId();
    expect(lsShim.getItem(SESSION_KEY)).toBe(sid);
    expect(lsShim.getItem(SESSION_KEY)).not.toBe('old-session');
  });

  it('two successive rotations produce different ids', () => {
    const a = rotateSessionId();
    const b = rotateSessionId();
    // timestamp + random — practically impossible to collide
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// persistSessionId
// ─────────────────────────────────────────────────────────────────────────────

describe('persistSessionId', () => {
  it('writes the given sid to localStorage under SESSION_KEY', () => {
    persistSessionId('custom-session-abc');
    expect(lsShim.getItem(SESSION_KEY)).toBe('custom-session-abc');
  });

  it('overwrites a prior value', () => {
    lsShim.setItem(SESSION_KEY, 'old');
    persistSessionId('new-session');
    expect(lsShim.getItem(SESSION_KEY)).toBe('new-session');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// turnsToMessages
// ─────────────────────────────────────────────────────────────────────────────

describe('turnsToMessages', () => {
  it('maps user turns to role=user', () => {
    const turns: Turn[] = [{ role: 'user', content: 'hello', at: 1000 }];
    const msgs = turnsToMessages(turns);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].text).toBe('hello');
  });

  it('maps assistant turns to role=sunny', () => {
    const turns: Turn[] = [{ role: 'assistant', content: 'hi there', at: 2000 }];
    const msgs = turnsToMessages(turns);
    expect(msgs[0].role).toBe('sunny');
    expect(msgs[0].text).toBe('hi there');
  });

  it('maps tool turns to role=system', () => {
    const turns: Turn[] = [{ role: 'tool', content: 'tool output', at: 3000 }];
    const msgs = turnsToMessages(turns);
    expect(msgs[0].role).toBe('system');
  });

  it('preserves the timestamp from the turn', () => {
    const turns: Turn[] = [{ role: 'user', content: 'x', at: 9999 }];
    const msgs = turnsToMessages(turns);
    expect(msgs[0].ts).toBe(9999);
  });

  it('returns empty array for empty input', () => {
    expect(turnsToMessages([])).toEqual([]);
  });

  it('assigns a unique id to every message', () => {
    const turns: Turn[] = [
      { role: 'user', content: 'a', at: 1 },
      { role: 'assistant', content: 'b', at: 2 },
    ];
    const msgs = turnsToMessages(turns);
    expect(msgs[0].id).not.toBe(msgs[1].id);
  });

  it('handles non-string content gracefully (returns empty string)', () => {
    // Defensive path: content must be a string; malformed rows get empty text
    const badTurn = { role: 'user' as const, content: 42 as unknown as string, at: 1 };
    const msgs = turnsToMessages([badTurn]);
    expect(msgs[0].text).toBe('');
  });

  it('handles non-number at gracefully (falls back to Date.now approx)', () => {
    const badTurn = { role: 'user' as const, content: 'hi', at: 'notanumber' as unknown as number };
    const msgs = turnsToMessages([badTurn]);
    // Fallback is Date.now() — just check it's a reasonable number
    expect(msgs[0].ts).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadHistory
// ─────────────────────────────────────────────────────────────────────────────

describe('loadHistory', () => {
  it('returns empty array when nothing is stored', () => {
    expect(loadHistory()).toEqual([]);
  });

  it('returns empty array when stored value is invalid JSON', () => {
    lsShim.setItem(STORAGE_KEY, '{not-json');
    expect(loadHistory()).toEqual([]);
  });

  it('returns empty array when stored value is not an array', () => {
    lsShim.setItem(STORAGE_KEY, JSON.stringify({ id: '1' }));
    expect(loadHistory()).toEqual([]);
  });

  it('filters out malformed entries missing required fields', () => {
    const raw = JSON.stringify([
      { id: '1', role: 'user', text: 'ok', ts: 100 },
      { id: '2', role: 'user', ts: 200 }, // missing text
      { role: 'sunny', text: 'hi', ts: 300 }, // missing id
    ]);
    lsShim.setItem(STORAGE_KEY, raw);
    const msgs = loadHistory();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('1');
  });

  it('strips streaming flag from stored messages', () => {
    const stored = [{ id: 'a', role: 'sunny', text: 'hello', ts: 1 }];
    lsShim.setItem(STORAGE_KEY, JSON.stringify(stored));
    const msgs = loadHistory();
    expect(msgs[0]).not.toHaveProperty('streaming');
  });

  it('loads a valid round-tripped history correctly', () => {
    const msgs: Message[] = [
      { id: 'x1', role: 'user', text: 'Hi', ts: 111 },
      { id: 'x2', role: 'sunny', text: 'Hey', ts: 222 },
    ];
    lsShim.setItem(STORAGE_KEY, JSON.stringify(msgs));
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe('Hi');
    expect(loaded[1].text).toBe('Hey');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveHistory
// ─────────────────────────────────────────────────────────────────────────────

describe('saveHistory', () => {
  it('writes messages to localStorage', () => {
    const msgs: Message[] = [{ id: 'y1', role: 'user', text: 'test', ts: 500 }];
    saveHistory(msgs);
    const raw = lsShim.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[0].id).toBe('y1');
  });

  it('trims to the last MAX_HISTORY entries', () => {
    const msgs: Message[] = Array.from({ length: 150 }, (_, i) => ({
      id: `id-${i}`,
      role: 'user' as const,
      text: `msg ${i}`,
      ts: i,
    }));
    saveHistory(msgs);
    const raw = lsShim.getItem(STORAGE_KEY);
    const parsed: Message[] = JSON.parse(raw!);
    expect(parsed).toHaveLength(MAX_HISTORY);
    // Should be the LAST 100, not the first 100
    expect(parsed[0].id).toBe('id-50');
    expect(parsed[99].id).toBe('id-149');
  });

  it('only persists id, role, text, ts — drops streaming', () => {
    const msgs: Message[] = [
      { id: 'z1', role: 'sunny', text: 'streaming response', ts: 1, streaming: true },
    ];
    saveHistory(msgs);
    const raw = lsShim.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw!);
    expect(parsed[0]).not.toHaveProperty('streaming');
    expect(Object.keys(parsed[0]).sort()).toEqual(['id', 'role', 'text', 'ts'].sort());
  });

  it('writes empty array when messages is empty', () => {
    saveHistory([]);
    const raw = lsShim.getItem(STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual([]);
  });
});
