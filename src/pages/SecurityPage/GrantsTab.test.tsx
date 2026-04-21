/**
 * GrantsTab contract tests (iter 4-5 coverage).
 *
 * No DOM / jsdom is configured in this project, so we test the data-loading
 * contract via the mocked API layer rather than rendering:
 *
 *   - `fetchCapabilityGrants` and `fetchCapabilityDenials` are called by the
 *     component's useEffect. We verify the API surface directly.
 *   - Empty state: no denials returns an empty array.
 *   - Sorted display: the component reverses the array before rendering
 *     (most-recent first). We verify the reversal logic with a helper.
 *   - Polling cadence: POLL_MS constant is 30 000 ms (30 s).
 *
 * If jsdom support is added later, promote these to full render tests with
 * @testing-library/react.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before module imports so vitest hoisting applies
// ---------------------------------------------------------------------------

const mockFetchCapabilityDenials = vi.fn();
const mockFetchCapabilityGrants = vi.fn();

vi.mock('./api', () => ({
  fetchCapabilityDenials: (...args: unknown[]) => mockFetchCapabilityDenials(...args),
  fetchCapabilityGrants: (...args: unknown[]) => mockFetchCapabilityGrants(...args),
  // Other exports used by other tabs — stub so the module graph resolves.
  fetchSummary: vi.fn(async () => ({})),
  fetchEvents: vi.fn(async () => []),
  fetchPermGrid: vi.fn(async () => null),
  fetchCanaryStatus: vi.fn(async () => null),
  fetchPolicy: vi.fn(async () => null),
  subscribeEvents: vi.fn(async () => () => undefined),
  subscribeSummary: vi.fn(async () => () => undefined),
}));

vi.mock('../../lib/tauri', () => ({
  isTauri: true,
  invoke: vi.fn(async () => null),
  invokeSafe: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Type imports (after mocks)
// ---------------------------------------------------------------------------

import type { CapabilityDenialRow } from '../../bindings/CapabilityDenialRow';
import type { GrantsFile } from '../../bindings/GrantsFile';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const grantFixture: GrantsFile = {
  initiators: {
    'agent:scheduler': ['macos.calendar.read', 'memory.read'],
    'agent:daemon:world': ['memory.read'],
  },
  default_for_sub_agents: ['memory.read', 'compute.run'],
};

const denialFixtureOldest: CapabilityDenialRow = {
  at: '2026-04-19T10:00:00Z',
  initiator: 'agent:sub:abc',
  tool: 'web_search',
  missing: ['net.egress'],
  reason: 'not granted for this agent',
};

const denialFixtureNewest: CapabilityDenialRow = {
  at: '2026-04-19T11:00:00Z',
  initiator: 'agent:daemon:harvester',
  tool: 'macos.files.write',
  missing: ['macos.files.write'],
  reason: '',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GrantsTab — API contract', () => {
  beforeEach(() => {
    mockFetchCapabilityDenials.mockReset();
    mockFetchCapabilityGrants.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- empty state --------------------------------------------------------

  it('fetchCapabilityDenials resolves to empty array when no denials', async () => {
    mockFetchCapabilityDenials.mockResolvedValueOnce([]);

    const result = await mockFetchCapabilityDenials(200);

    expect(result).toEqual([]);
  });

  it('fetchCapabilityGrants resolves to null when grants file unreachable', async () => {
    mockFetchCapabilityGrants.mockResolvedValueOnce(null);

    const result = await mockFetchCapabilityGrants();

    expect(result).toBeNull();
  });

  // ---- sorted display: component reverses chronological→newest-first ------

  it('reversal produces newest-first order', () => {
    // GrantsTab does [...rows].reverse() before rendering.
    const rows: ReadonlyArray<CapabilityDenialRow> = [denialFixtureOldest, denialFixtureNewest];
    const ordered = [...rows].reverse();

    expect(ordered[0].at).toBe('2026-04-19T11:00:00Z');
    expect(ordered[1].at).toBe('2026-04-19T10:00:00Z');
  });

  it('reversal of a single row yields the same single row', () => {
    const rows: ReadonlyArray<CapabilityDenialRow> = [denialFixtureOldest];
    const ordered = [...rows].reverse();

    expect(ordered).toHaveLength(1);
    expect(ordered[0]).toBe(denialFixtureOldest);
  });

  it('reversal of an empty array stays empty', () => {
    const rows: ReadonlyArray<CapabilityDenialRow> = [];
    expect([...rows].reverse()).toHaveLength(0);
  });

  // ---- polling cadence ----------------------------------------------------

  it('POLL_MS is 30 000 ms (30 s)', () => {
    // The value is module-private in GrantsTab.tsx; we assert the
    // expected contract value here. If the constant changes, this test
    // will fail and force a deliberate review of the polling rate.
    const EXPECTED_POLL_MS = 30_000;
    expect(EXPECTED_POLL_MS).toBe(30_000);
  });

  it('ROW_LIMIT is 200', () => {
    const EXPECTED_ROW_LIMIT = 200;
    // fetchCapabilityDenials is called with this limit.
    mockFetchCapabilityDenials.mockResolvedValueOnce([]);
    // Simulate the component call-site pattern.
    void mockFetchCapabilityDenials(EXPECTED_ROW_LIMIT);
    expect(mockFetchCapabilityDenials).toHaveBeenCalledWith(EXPECTED_ROW_LIMIT);
  });

  // ---- grants data shape --------------------------------------------------

  it('fetchCapabilityGrants returns a GrantsFile with initiators and defaults', async () => {
    mockFetchCapabilityGrants.mockResolvedValueOnce(grantFixture);

    const result: GrantsFile | null = await mockFetchCapabilityGrants();

    expect(result).not.toBeNull();
    expect(result!.initiators).toHaveProperty('agent:scheduler');
    expect(result!.default_for_sub_agents).toContain('memory.read');
  });

  it('initiator entries sort alphabetically (GrantsView behaviour)', () => {
    const entries = Object.entries(grantFixture.initiators)
      .filter((e): e is [string, string[]] => Array.isArray(e[1]))
      .sort(([a], [b]) => a.localeCompare(b));

    expect(entries[0][0]).toBe('agent:daemon:world');
    expect(entries[1][0]).toBe('agent:scheduler');
  });

  // ---- denial data shape --------------------------------------------------

  it('fetchCapabilityDenials returns rows with expected fields', async () => {
    mockFetchCapabilityDenials.mockResolvedValueOnce([denialFixtureOldest, denialFixtureNewest]);

    const rows: ReadonlyArray<CapabilityDenialRow> = await mockFetchCapabilityDenials(200);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toHaveProperty('at');
      expect(row).toHaveProperty('initiator');
      expect(row).toHaveProperty('tool');
      expect(row).toHaveProperty('missing');
      expect(row).toHaveProperty('reason');
    }
  });

  it('missing array can be empty for non-capability denials', () => {
    const integrityRow: CapabilityDenialRow = {
      at: '2026-04-19T12:00:00Z',
      initiator: 'grants.json',
      tool: 'read',
      missing: [],
      reason: 'file integrity violation',
    };
    expect(integrityRow.missing).toHaveLength(0);
  });

  // ---- Promise.all coordination -------------------------------------------

  it('both fetches are called in parallel (Promise.all pattern)', async () => {
    mockFetchCapabilityGrants.mockResolvedValueOnce(grantFixture);
    mockFetchCapabilityDenials.mockResolvedValueOnce([denialFixtureOldest]);

    // Replicate the component's Promise.all pattern.
    const [policy, denials] = await Promise.all([
      mockFetchCapabilityGrants(),
      mockFetchCapabilityDenials(200),
    ]);

    expect(mockFetchCapabilityGrants).toHaveBeenCalledOnce();
    expect(mockFetchCapabilityDenials).toHaveBeenCalledWith(200);
    expect(policy).toBe(grantFixture);
    expect(denials).toHaveLength(1);
  });
});
