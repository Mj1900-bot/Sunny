import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the tauri bridge so we can assert IPC contract without needing a
// real backend. `vi.hoisted` is required because `vi.mock` is hoisted
// above imports — a plain top-level `const` would be in its temporal
// dead zone when the mock factory runs.
const { invokeSafe } = vi.hoisted(() => ({
  invokeSafe: vi.fn<(cmd: string, args?: Record<string, unknown>, fallback?: unknown) => Promise<unknown>>(
    async () => null,
  ),
}));
vi.mock('../../tauri', () => ({
  isTauri: false,
  invokeSafe,
}));

import {
  parseCadencePhrase,
  parseWhenPhrase,
  scheduleOnceTool,
  scheduleRecurringTool,
} from './daemon';

const noAbort = new AbortController().signal;

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseWhenPhrase — one-off time parsing for schedule_once
// ---------------------------------------------------------------------------

describe('parseWhenPhrase', () => {
  // A deterministic "now" — Mon 2026-04-20 15:00:00 local. All tests anchor
  // to this so "in N", "at X", "tomorrow" are reproducible across machines.
  const now = new Date(2026, 3, 20, 15, 0, 0);
  const nowUnix = Math.floor(now.getTime() / 1000);

  it('resolves "now" to the current unix second', () => {
    expect(parseWhenPhrase('now', now)).toBe(nowUnix);
  });

  it('resolves "in 15 minutes"', () => {
    expect(parseWhenPhrase('in 15 minutes', now)).toBe(nowUnix + 15 * 60);
  });

  it('resolves "in 2 hours"', () => {
    expect(parseWhenPhrase('in 2 hours', now)).toBe(nowUnix + 2 * 3600);
  });

  it('resolves "at 6pm" to later today when 6pm is still in the future', () => {
    const target = new Date(now);
    target.setHours(18, 0, 0, 0);
    expect(parseWhenPhrase('at 6pm', now)).toBe(Math.floor(target.getTime() / 1000));
  });

  it('rolls "at 9am" to tomorrow when the time has already passed today', () => {
    const tomorrow9 = new Date(now);
    tomorrow9.setDate(now.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);
    expect(parseWhenPhrase('at 9am', now)).toBe(Math.floor(tomorrow9.getTime() / 1000));
  });

  it('resolves "tomorrow at 9am" even if 9am today has not passed', () => {
    const morningNow = new Date(2026, 3, 20, 6, 0, 0);
    const tomorrow9 = new Date(morningNow);
    tomorrow9.setDate(morningNow.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);
    expect(parseWhenPhrase('tomorrow at 9am', morningNow)).toBe(Math.floor(tomorrow9.getTime() / 1000));
  });

  it('accepts ISO 8601 as a fallback', () => {
    const iso = '2027-01-01T12:00:00Z';
    expect(parseWhenPhrase(iso, now)).toBe(Math.floor(Date.parse(iso) / 1000));
  });

  it('returns null for unparseable phrases', () => {
    expect(parseWhenPhrase('whenever you feel like it', now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCadencePhrase — recurring cadence parsing for schedule_recurring
// ---------------------------------------------------------------------------

describe('parseCadencePhrase', () => {
  const now = new Date(2026, 3, 20, 15, 0, 0); // Mon 2026-04-20 3pm

  it('"every morning" defaults to 7am daily', () => {
    const out = parseCadencePhrase('every morning', now);
    expect(out?.every_sec).toBe(86400);
    // First fire is tomorrow 7am; at = firstFire - every_sec.
    const tomorrow7 = new Date(now);
    tomorrow7.setDate(now.getDate() + 1);
    tomorrow7.setHours(7, 0, 0, 0);
    const firstFire = Math.floor(tomorrow7.getTime() / 1000);
    expect(out?.at).toBe(firstFire - 86400);
  });

  it('"every morning at 9" honours the explicit hour', () => {
    const out = parseCadencePhrase('every morning at 9', now);
    expect(out?.every_sec).toBe(86400);
    const target = new Date(now);
    target.setDate(now.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    expect(out?.at).toBe(Math.floor(target.getTime() / 1000) - 86400);
  });

  it('"every day at 7am" parses to daily with anchor', () => {
    const out = parseCadencePhrase('every day at 7am', now);
    expect(out?.every_sec).toBe(86400);
    expect(out?.at).toBeDefined();
  });

  it('"every 30 minutes" parses to a 1800s interval with no anchor', () => {
    expect(parseCadencePhrase('every 30 minutes', now)).toEqual({ every_sec: 1800 });
  });

  it('"every hour" parses to 3600s', () => {
    expect(parseCadencePhrase('every hour', now)).toEqual({ every_sec: 3600 });
  });

  it('"hourly" is a shorthand for every hour', () => {
    expect(parseCadencePhrase('hourly', now)).toEqual({ every_sec: 3600 });
  });

  it('"daily" is a shorthand for every 86400s', () => {
    expect(parseCadencePhrase('daily', now)).toEqual({ every_sec: 86400 });
  });

  it('returns null for phrases it cannot parse', () => {
    expect(parseCadencePhrase('every third thursday', now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// schedule_once tool — IPC contract
// ---------------------------------------------------------------------------

describe('schedule_once tool', () => {
  it('schema name matches Rust agent tool `schedule_once`', () => {
    expect(scheduleOnceTool.schema.name).toBe('schedule_once');
  });

  it('is marked dangerous — creates a persistent daemon', () => {
    expect(scheduleOnceTool.dangerous).toBe(true);
  });

  it('parses `when` and calls daemons_add with kind=once', async () => {
    invokeSafe.mockImplementation(async () => ({ id: 'd-1', title: 't', kind: 'once' }));
    const result = await scheduleOnceTool.run(
      { goal: 'check email', when: 'in 15 minutes' },
      noAbort,
    );
    expect(result.ok).toBe(true);
    const call = invokeSafe.mock.calls.find(c => c[0] === 'daemons_add');
    expect(call).toBeDefined();
    const spec = (call![1] as { spec: Record<string, unknown> }).spec;
    expect(spec.kind).toBe('once');
    expect(spec.goal).toBe('check email');
    expect(typeof spec.at).toBe('number');
    expect(spec.every_sec).toBeNull();
  });

  it('accepts `at_unix` directly, skipping NL parsing', async () => {
    invokeSafe.mockImplementation(async () => ({ id: 'd-2' }));
    await scheduleOnceTool.run({ goal: 'ping server', at_unix: 2_000_000_000 }, noAbort);
    const call = invokeSafe.mock.calls.find(c => c[0] === 'daemons_add');
    const spec = (call![1] as { spec: Record<string, unknown> }).spec;
    expect(spec.at).toBe(2_000_000_000);
  });

  it('returns validation failure when neither at_unix nor when is supplied', async () => {
    const result = await scheduleOnceTool.run({ goal: 'x' }, noAbort);
    expect(result.ok).toBe(false);
    expect(invokeSafe).not.toHaveBeenCalled();
  });

  it('returns a clear error for unparseable `when` phrases', async () => {
    const result = await scheduleOnceTool.run(
      { goal: 'x', when: 'when mercury is in retrograde' },
      noAbort,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/could not parse/i);
    expect(invokeSafe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// schedule_recurring tool — IPC contract
// ---------------------------------------------------------------------------

describe('schedule_recurring tool', () => {
  it('schema name matches Rust agent tool `schedule_recurring`', () => {
    expect(scheduleRecurringTool.schema.name).toBe('schedule_recurring');
  });

  it('is marked dangerous — creates a persistent daemon', () => {
    expect(scheduleRecurringTool.dangerous).toBe(true);
  });

  it('parses `cadence` and calls daemons_add with kind=interval', async () => {
    invokeSafe.mockImplementation(async () => ({ id: 'd-3', kind: 'interval' }));
    const result = await scheduleRecurringTool.run(
      { goal: 'summarise calendar', cadence: 'every morning at 7' },
      noAbort,
    );
    expect(result.ok).toBe(true);
    const call = invokeSafe.mock.calls.find(c => c[0] === 'daemons_add');
    const spec = (call![1] as { spec: Record<string, unknown> }).spec;
    expect(spec.kind).toBe('interval');
    expect(spec.every_sec).toBe(86400);
    expect(typeof spec.at).toBe('number'); // anchor populated for time-of-day cadences
    expect(spec.goal).toBe('summarise calendar');
  });

  it('accepts `every_sec` directly for precise control', async () => {
    invokeSafe.mockImplementation(async () => ({ id: 'd-4' }));
    await scheduleRecurringTool.run(
      { goal: 'poll api', every_sec: 1800 },
      noAbort,
    );
    const call = invokeSafe.mock.calls.find(c => c[0] === 'daemons_add');
    const spec = (call![1] as { spec: Record<string, unknown> }).spec;
    expect(spec.every_sec).toBe(1800);
  });

  it('rejects non-positive every_sec', async () => {
    const result = await scheduleRecurringTool.run(
      { goal: 'x', every_sec: 0 },
      noAbort,
    );
    expect(result.ok).toBe(false);
    expect(invokeSafe).not.toHaveBeenCalled();
  });

  it('returns validation failure when neither every_sec nor cadence is supplied', async () => {
    const result = await scheduleRecurringTool.run({ goal: 'x' }, noAbort);
    expect(result.ok).toBe(false);
    expect(invokeSafe).not.toHaveBeenCalled();
  });

  it('propagates max_runs to DaemonSpec', async () => {
    invokeSafe.mockImplementation(async () => ({ id: 'd-5' }));
    await scheduleRecurringTool.run(
      { goal: 'poll api', every_sec: 60, max_runs: 10 },
      noAbort,
    );
    const call = invokeSafe.mock.calls.find(c => c[0] === 'daemons_add');
    const spec = (call![1] as { spec: Record<string, unknown> }).spec;
    expect(spec.max_runs).toBe(10);
  });
});
