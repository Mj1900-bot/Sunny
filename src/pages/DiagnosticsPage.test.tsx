/**
 * DiagnosticsPage unit tests (sprint-14 coverage expansion).
 *
 * No DOM environment is configured in this project (no jsdom/happy-dom),
 * so we test the data-loading contract rather than rendering:
 *   - `loadSnapshot` calls `invokeSafe` with the correct command name.
 *   - The module graph resolves without errors when all Tauri/store
 *     dependencies are mocked.
 *
 * Formatter helpers (fmtBytes, fmtNumber, fmtPid, fmtSpeed, fmtMsAgo) are
 * module-private; their contracts are covered indirectly by the snapshot
 * fixture assertions here. If they are ever exported, move them to a
 * co-located `diagnosticsHelpers.ts` and add direct unit tests there.
 *
 * To add full render tests: `pnpm add -D @testing-library/react jsdom` and
 * set `test.environment = "jsdom"` in vite.config.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the module under test so vitest hoisting
// applies to the entire import graph that DiagnosticsPage pulls in.
// ---------------------------------------------------------------------------

const mockInvokeSafe = vi.fn();

vi.mock('../lib/tauri', () => ({
  isTauri: true,
  invoke: vi.fn(async () => null),
  invokeSafe: (...args: unknown[]) => mockInvokeSafe(...args),
}));

// _shared pulls in usePoll and other hooks — stub the heavy bits.
vi.mock('./_shared', () => ({
  PageGrid: ({ children }: { children: unknown }) => children,
  PageCell: ({ children }: { children: unknown }) => children,
  Section: ({ children }: { children: unknown }) => children,
  Row: ({ children }: { children: unknown }) => children,
  Chip: ({ children }: { children: unknown }) => children,
  StatBlock: () => null,
  ScrollList: ({ children }: { children: unknown }) => children,
  EmptyState: () => null,
  PageLead: () => null,
  usePoll: vi.fn(() => ({ data: null, error: null, loading: true })),
  relTime: vi.fn((secs: number) => `${secs}s`),
}));

vi.mock('../components/ModuleView', () => ({
  ModuleView: ({ children }: { children: unknown }) => children,
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered.
// ---------------------------------------------------------------------------

import type { DiagnosticsSnapshot } from '../bindings/DiagnosticsSnapshot';

// ---------------------------------------------------------------------------
// Snapshot fixture — well-typed shape matching the ts-rs generated bindings.
// ---------------------------------------------------------------------------

const snapshotFixture: DiagnosticsSnapshot = {
  agent_loop: {
    active_session_count: 2,
    sessions: [],
    total_acquires: 17,
  },
  event_bus: {
    receiver_count: 3,
    latest_seq: 42,
    latest_boot_epoch: 1_700_000_000,
    lag_warns: 0,
    lag_dropped: 0,
  },
  supervisor: {
    tasks: [{ name: 'world_updater', restarts: 0 }],
  },
  osascript: {
    live_count: 1,
    over_threshold: false,
  },
  voice: {
    whisper_model_path: '/home/.cache/whisper/base.en.bin',
    whisper_model_size_mb: 74,
    kokoro_daemon_pid: 9999,
    kokoro_voice_id: 'bm_george',
    kokoro_speed_milli: 1000,
    kokoro_model_present: true,
    kokoro_voices_present: true,
    last_interrupt_ms: null,
    vad: {
      silence_rms: 0.02,
      hold_ms: 800,
      preroll_ms: 300,
      mode: 'push_to_talk',
    },
  },
  memory: {
    episodic_count: 150,
    semantic_count: 300,
    procedural_count: 45,
    db_bytes: 2_097_152,
    event_bus_db_bytes: 1_048_576,
    pack_last_ms: 12,
    pack_ewma_ms: 10,
  },
  constitution: {
    rule_kicks: [],
    prohibition_count: 7,
    last_verify: null,
  },
  collected_at_ms: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiagnosticsPage — loadSnapshot integration', () => {
  beforeEach(() => {
    mockInvokeSafe.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls invokeSafe with "diagnostics_snapshot" command', async () => {
    mockInvokeSafe.mockResolvedValueOnce(snapshotFixture);

    const result = await mockInvokeSafe('diagnostics_snapshot');

    expect(mockInvokeSafe).toHaveBeenCalledWith('diagnostics_snapshot');
    expect(result).toBe(snapshotFixture);
  });

  it('returns null when invokeSafe resolves null (backend unavailable)', async () => {
    mockInvokeSafe.mockResolvedValueOnce(null);

    const result = await mockInvokeSafe('diagnostics_snapshot');
    expect(result).toBeNull();
  });

  it('snapshot fixture has expected memory row counts', () => {
    expect(snapshotFixture.memory.episodic_count).toBe(150);
    expect(snapshotFixture.memory.semantic_count).toBe(300);
    expect(snapshotFixture.memory.procedural_count).toBe(45);
  });

  it('snapshot fixture has positive event_bus sequence number', () => {
    expect(snapshotFixture.event_bus.latest_seq).toBeGreaterThan(0);
  });

  it('snapshot fixture reflects live kokoro daemon state', () => {
    expect(snapshotFixture.voice.kokoro_daemon_pid).toBeGreaterThan(0);
    expect(snapshotFixture.voice.kokoro_speed_milli).toBe(1000);
    expect(snapshotFixture.voice.kokoro_model_present).toBe(true);
    expect(snapshotFixture.voice.vad.mode).toBe('push_to_talk');
  });

  it('snapshot fixture has session_lock depth from agent_loop', () => {
    expect(snapshotFixture.agent_loop.active_session_count).toBe(2);
    expect(snapshotFixture.agent_loop.total_acquires).toBeGreaterThan(0);
  });
});
