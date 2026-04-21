import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the tauri bridge so we can spy on which Tauri commands the voice
// tools call. Regression we're guarding against: an earlier refactor
// retired `memory_add` / `memory_list` / `memory_search` / `memory_delete`
// but the TS tool implementations kept calling those names via
// `invokeSafe`. Voice turns silently failed. These tests lock the TS
// tools to the current typed IPC surface (`memory_episodic_*`,
// `memory_fact_*`) so any future rename fails a test instead of
// breaking speech at runtime.
//
// `vi.hoisted` is required because `vi.mock` is hoisted above imports —
// a normal `const invokeSafe = vi.fn()` would be a temporal-dead-zone
// reference inside the mock factory.
const { invokeSafe } = vi.hoisted(() => ({
  invokeSafe: vi.fn<(cmd: string, args?: Record<string, unknown>, fallback?: unknown) => Promise<unknown>>(
    async () => null,
  ),
}));
vi.mock('../../tauri', () => ({
  isTauri: false,
  invokeSafe,
}));

// Import after vi.mock so the tool implementations resolve to the
// mocked `invokeSafe`.
import {
  memoryAddTool,
  memoryListTool,
  memorySearchTool,
} from './memory';

const noAbort = new AbortController().signal;

afterEach(() => {
  vi.clearAllMocks();
});

describe('voice-path memory tools — schema name contract', () => {
  // The TS agent catalog is handed to the LLM as part of every voice
  // turn's system prompt. The agent's tool-selection decisions rely on
  // these exact names. Matching the Rust `inventory::submit!` names
  // (`memory_remember`, `memory_recall`) also lets the two paths share
  // the same training/eval prompts.
  it('memoryAddTool schema name is memory_remember', () => {
    expect(memoryAddTool.schema.name).toBe('memory_remember');
  });

  it('memorySearchTool schema name is memory_recall', () => {
    expect(memorySearchTool.schema.name).toBe('memory_recall');
  });

  it('memoryListTool schema name is memory_list', () => {
    expect(memoryListTool.schema.name).toBe('memory_list');
  });
});

describe('voice-path memory tools — Tauri IPC contract', () => {
  // `invokeSafe` is mocked to return null; we assert on the CALL shape
  // rather than the result. A null return means the tool's `ok: false`
  // branch triggers, which is fine — we only care it called the right
  // Tauri command with the right args.
  it('memory_remember writes to episodic store via memory_episodic_add', async () => {
    invokeSafe.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_episodic_add') return { id: 'ep-123', text: 't', tags: [], created_at: 0 };
      return null;
    });
    await memoryAddTool.run({ text: 'I prefer espresso', tags: ['coffee'] }, noAbort);
    const episodicCall = invokeSafe.mock.calls.find(c => c[0] === 'memory_episodic_add');
    expect(episodicCall, 'memory_episodic_add must be invoked').toBeDefined();
    expect(episodicCall![1]).toMatchObject({
      kind: 'note',
      text: 'I prefer espresso',
      tags: ['coffee'],
    });
  });

  it('memory_remember mirrors to semantic store for 3-store write', async () => {
    invokeSafe.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_episodic_add') return { id: 'ep-123', text: 't', tags: [], created_at: 0 };
      return null;
    });
    await memoryAddTool.run({ text: 'I live in Vancouver', tags: ['location'] }, noAbort);
    // The semantic mirror is fire-and-forget (`void invokeSafe(...)`), so
    // it may resolve after the tool returns. Yield once so the
    // microtask flushes before we inspect the spy.
    await Promise.resolve();
    await Promise.resolve();
    const semanticCall = invokeSafe.mock.calls.find(c => c[0] === 'memory_fact_add');
    expect(semanticCall, 'memory_fact_add must be invoked as semantic mirror').toBeDefined();
    expect(semanticCall![1]).toMatchObject({
      subject: 'location',
      text: 'I live in Vancouver',
      confidence: 1.0,
      source: 'tool-remember',
    });
  });

  it('memory_remember defaults subject to user.note when no tags supplied', async () => {
    invokeSafe.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_episodic_add') return { id: 'ep-0', text: 't', tags: [], created_at: 0 };
      return null;
    });
    await memoryAddTool.run({ text: 'one-off observation' }, noAbort);
    await Promise.resolve();
    await Promise.resolve();
    const semanticCall = invokeSafe.mock.calls.find(c => c[0] === 'memory_fact_add');
    expect(semanticCall![1]).toMatchObject({ subject: 'user.note' });
  });

  it('memory_recall searches episodic via memory_episodic_search', async () => {
    invokeSafe.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_episodic_search') return [];
      return null;
    });
    await memorySearchTool.run({ query: 'coffee preferences' }, noAbort);
    const searchCall = invokeSafe.mock.calls.find(c => c[0] === 'memory_episodic_search');
    expect(searchCall, 'memory_episodic_search must be invoked').toBeDefined();
    expect(searchCall![1]).toMatchObject({ query: 'coffee preferences' });
  });

  it('memory_list reads episodic via memory_episodic_list', async () => {
    invokeSafe.mockImplementation(async (cmd: string) => {
      if (cmd === 'memory_episodic_list') return [];
      return null;
    });
    await memoryListTool.run({ limit: 20 }, noAbort);
    const listCall = invokeSafe.mock.calls.find(c => c[0] === 'memory_episodic_list');
    expect(listCall, 'memory_episodic_list must be invoked').toBeDefined();
    expect(listCall![1]).toMatchObject({ limit: 20 });
  });

  it('no memory tool calls a retired IPC (memory_add, memory_list, memory_search, memory_delete)', async () => {
    invokeSafe.mockImplementation(async () => null);
    await memoryAddTool.run({ text: 'x' }, noAbort);
    await memoryListTool.run({}, noAbort);
    await memorySearchTool.run({ query: 'x' }, noAbort);
    await Promise.resolve();
    const retiredNames = new Set(['memory_add', 'memory_list', 'memory_search', 'memory_delete']);
    const retiredCalls = invokeSafe.mock.calls
      .map(c => c[0] as string)
      .filter(name => retiredNames.has(name));
    expect(retiredCalls, 'no tool may call a retired IPC').toEqual([]);
  });
});
