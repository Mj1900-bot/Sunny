/**
 * useEventBus — shared singleton subscription tests (iter-16 coverage).
 *
 * We test the `subscribeShared` helper and the `SHARED` singleton directly,
 * with NO React rendering required. The hook's React-bound lifecycle
 * (useEffect, useState) is intentionally out of scope here; the interesting
 * invariants live in the singleton manager:
 *
 *   1. First subscriber bootstraps the upstream Tauri Channel.
 *   2. Second subscriber reuses the existing channel (no second invoke).
 *   3. Last unsubscribe tears down the upstream channel.
 *   4. Unknown-command error caches the `unsupported` flag so subsequent
 *      calls skip the failing invoke immediately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @tauri-apps/api/core (Channel) BEFORE importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@tauri-apps/api/core', () => {
  class ChannelMock<T> {
    onmessage: ((v: T) => void) | null = null;
  }
  return { Channel: ChannelMock };
});

// ---------------------------------------------------------------------------
// Mock ../lib/tauri so we control `invoke` and `isTauri`
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();

vi.mock('../lib/tauri', () => ({
  isTauri: true,
  invoke: (...args: unknown[]) => mockInvoke(...args),
  invokeSafe: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered
// ---------------------------------------------------------------------------

import { subscribeShared, SHARED } from './useEventBus';

// ---------------------------------------------------------------------------
// Reset the SHARED singleton before every test so state doesn't bleed
// across test cases. We mutate directly because it's the simplest way to
// guarantee a clean slate without reloading the module.
// ---------------------------------------------------------------------------

function resetShared(): void {
  SHARED.callbacks.clear();
  // callbackArr may exist if the linter/optimizer added it to the interface.
  if ('callbackArr' in SHARED) {
    (SHARED as { callbackArr: readonly unknown[] }).callbackArr = [];
  }
  SHARED.subscriptionId = null;
  SHARED.pending = null;
  SHARED.unsupported = false;
}

beforeEach(() => {
  resetShared();
  // Default implementation: return a resolved Promise so .catch() calls on
  // fire-and-forget paths (e.g. event_bus_unsubscribe) don't throw when no
  // specific stub has been registered. mockResolvedValueOnce overrides this
  // for the specific call being tested.
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async () => undefined);
  vi.clearAllTimers();
});

afterEach(() => {
  resetShared();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subscribeShared — first subscriber bootstraps', () => {
  it('calls event_bus_subscribe once when first subscriber registers', async () => {
    // First call: event_bus_subscribe. Second (if cleanup fires): event_bus_unsubscribe.
    mockInvoke
      .mockResolvedValueOnce(42)        // event_bus_subscribe
      .mockResolvedValueOnce(undefined); // event_bus_unsubscribe (cleanup)

    const cb = vi.fn();
    const handle = await subscribeShared(cb);

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(mockInvoke).toHaveBeenCalledWith(
      'event_bus_subscribe',
      expect.objectContaining({ channel: expect.objectContaining({ onmessage: expect.anything() }) }),
    );
    expect(handle.ok).toBe(true);
    expect(SHARED.subscriptionId).toBe(42);
    expect(SHARED.callbacks.has(cb)).toBe(true);

    handle.unsubscribe();
    await Promise.resolve(); // let fire-and-forget unsubscribe settle
  });
});

describe('subscribeShared — second subscriber reuses channel', () => {
  it('does NOT call event_bus_subscribe again for the second subscriber', async () => {
    mockInvoke
      .mockResolvedValueOnce(7)          // event_bus_subscribe
      .mockResolvedValueOnce(undefined); // event_bus_unsubscribe (when last leaves)

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const h1 = await subscribeShared(cb1);
    const h2 = await subscribeShared(cb2);

    // Only one upstream subscribe call should have been made.
    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(h1.ok).toBe(true);
    expect(h2.ok).toBe(true);
    expect(SHARED.callbacks.has(cb1)).toBe(true);
    expect(SHARED.callbacks.has(cb2)).toBe(true);

    // Unsubscribe both to allow cleanup.
    h1.unsubscribe();
    h2.unsubscribe();
    await Promise.resolve();
  });

  it('both callbacks receive events when the channel fires', async () => {
    mockInvoke.mockResolvedValueOnce(99);

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    await subscribeShared(cb1);
    await subscribeShared(cb2);

    // Simulate the channel pushing an event by invoking all registered callbacks.
    const fakeEvent = { kind: 'WorldTick', revision: 1, activity: 'idle', at: Date.now(), seq: 1, boot_epoch: 1 };
    for (const cb of [...SHARED.callbacks]) {
      (cb as (e: unknown) => void)(fakeEvent);
    }

    expect(cb1).toHaveBeenCalledWith(fakeEvent);
    expect(cb2).toHaveBeenCalledWith(fakeEvent);

    // Cleanup.
    for (const cb of [...SHARED.callbacks]) {
      SHARED.callbacks.delete(cb);
    }
    SHARED.subscriptionId = null;
    SHARED.pending = null;
  });
});

describe('subscribeShared — last unsubscribe tears down', () => {
  it('calls event_bus_unsubscribe when the last subscriber leaves', async () => {
    mockInvoke
      .mockResolvedValueOnce(55)        // event_bus_subscribe → id = 55
      .mockResolvedValueOnce(undefined); // event_bus_unsubscribe → void

    const cb = vi.fn();
    const handle = await subscribeShared(cb);

    expect(SHARED.subscriptionId).toBe(55);
    expect(SHARED.callbacks.size).toBe(1);

    handle.unsubscribe();

    // After unsubscribe: callbacks cleared, id nulled.
    expect(SHARED.callbacks.size).toBe(0);
    expect(SHARED.subscriptionId).toBeNull();

    // Allow the fire-and-forget unsubscribe to resolve.
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledWith('event_bus_unsubscribe', { id: 55 });
  });

  it('does NOT call event_bus_unsubscribe when a non-last subscriber leaves', async () => {
    mockInvoke.mockResolvedValueOnce(10);

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const h1 = await subscribeShared(cb1);
    await subscribeShared(cb2);

    h1.unsubscribe(); // Only cb1 leaves; cb2 is still registered.

    await Promise.resolve();

    // Still only the original subscribe call; no unsubscribe yet.
    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(SHARED.callbacks.size).toBe(1);
    expect(SHARED.subscriptionId).toBe(10); // still alive

    // Cleanup cb2.
    SHARED.callbacks.clear();
    SHARED.subscriptionId = null;
    SHARED.pending = null;
  });
});

describe('subscribeShared — unsupported flag cached after unknown-command', () => {
  it('returns ok=false immediately if already marked unsupported', async () => {
    SHARED.unsupported = true;

    const cb = vi.fn();
    const handle = await subscribeShared(cb);

    expect(handle.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    // Callback should NOT be in the set after an unsupported skip.
    expect(SHARED.callbacks.has(cb)).toBe(false);
  });

  it('sets unsupported=true when invoke throws an unknown-command error', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('unknown command: event_bus_subscribe'));

    const cb = vi.fn();
    const handle = await subscribeShared(cb);

    expect(handle.ok).toBe(false);
    expect(SHARED.unsupported).toBe(true);
    // Callback removed after failed subscribe.
    expect(SHARED.callbacks.has(cb)).toBe(false);
  });

  it('subsequent subscriber skips invoke after unsupported is cached', async () => {
    // First call sets unsupported.
    mockInvoke.mockRejectedValueOnce(new Error('command_not_found'));
    const cb1 = vi.fn();
    await subscribeShared(cb1);
    expect(SHARED.unsupported).toBe(true);

    mockInvoke.mockReset(); // reset call count

    // Second subscriber should short-circuit immediately.
    const cb2 = vi.fn();
    const handle2 = await subscribeShared(cb2);

    expect(handle2.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('subscribeShared — idempotent unsubscribe', () => {
  it('double unsubscribe does not throw or call unsubscribe twice', async () => {
    mockInvoke
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(undefined);

    const cb = vi.fn();
    const handle = await subscribeShared(cb);

    handle.unsubscribe();
    await Promise.resolve();
    // Second call should be a no-op.
    expect(() => handle.unsubscribe()).not.toThrow();
  });
});
