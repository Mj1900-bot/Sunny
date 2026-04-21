// Race/regression test for κ latent bug B1 (Agent D, sprint-4):
//
// Before the fix, `handleIncoming` advanced the persistent rowid watermark
// *before* awaiting `draftAndMaybeSend`. If the draft pipeline then threw
// (e.g. the inbox's `addDraft` path blew up), the watermark had already
// moved past the failed message, so the NEXT real message from the same
// contact was silently dropped by the `evt.rowid <= cfg.lastSeenRowid`
// guard. After the fix the watermark only advances when the pipeline
// actually completes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri bridge so modelRouter.chatFor + invokeSafe calls are
// inert in the node test environment. Without this, any accidental IPC
// import path would throw and mask the real assertion.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { __testing } from './proxyEngine';
import { useProxy, type ProxyConfig } from '../store/proxy';
import { useProxyInbox } from '../store/proxyInbox';

const { handleIncoming } = __testing;

type NewMessageEvent = Readonly<{
  chat_identifier: string;
  rowid: number;
  text: string;
  ts: number;
  sender: string | null;
  has_attachment: boolean;
}>;

const HANDLE = 'test:+15550001111';

function seedConfig(overrides: Partial<ProxyConfig> = {}): void {
  useProxy.setState({
    globalEnabled: true,
    configs: [
      {
        handle: HANDLE,
        display: 'Test Contact',
        enabled: true,
        persona: 'casual',
        autoSend: false,
        // Turned on well in the past so the `enabledAt` floor is not the
        // thing blocking the event.
        enabledAt: 1,
        ...overrides,
      },
    ],
  });
}

function makeEvent(rowid: number, text = 'hello'): NewMessageEvent {
  return {
    chat_identifier: HANDLE,
    rowid,
    text,
    // `ts` is in seconds-since-epoch; use "now" so the `enabledAt` floor
    // (1ms) never rejects the event.
    ts: Math.floor(Date.now() / 1000),
    sender: null,
    has_attachment: false,
  };
}

describe('handleIncoming — watermark race (κ B1)', () => {
  beforeEach(() => {
    // Reset both zustand stores between cases so rowids + drafts don't
    // leak across tests.
    useProxy.setState({ configs: [], globalEnabled: true });
    useProxyInbox.setState({ drafts: [] });
  });

  it('does NOT advance the watermark when draftAndMaybeSend throws', async () => {
    seedConfig();

    // Force the draft pipeline to throw by replacing `addDraft` with a
    // function that blows up. This is the exact catch-path the bug
    // description identifies — `addDraft`'s internal catch firing mid
    // pipeline.
    const originalAddDraft = useProxyInbox.getState().addDraft;
    useProxyInbox.setState({
      addDraft: () => {
        throw new Error('simulated addDraft failure');
      },
    });

    const failingRowid = 100;

    // The engine should swallow the error cleanly; we don't want this
    // test to fail on the throw itself — we want to observe the
    // watermark state after.
    await handleIncoming(makeEvent(failingRowid)).catch(() => undefined);

    const cfgAfterFail = useProxy
      .getState()
      .configs.find(c => c.handle === HANDLE);

    // Core assertion: the persistent watermark must NOT have advanced
    // past the failed rowid. Before the fix this was === failingRowid.
    expect(cfgAfterFail?.lastSeenRowid ?? 0).toBeLessThan(failingRowid);

    // Restore the inbox so the next message can proceed normally.
    useProxyInbox.setState({ addDraft: originalAddDraft });

    // A subsequent real message from the SAME contact with a rowid just
    // past the failed one must NOT be dropped by the watermark guard.
    // We observe this by counting drafts produced — with the bug
    // present, this message would be silently filtered upstream of
    // `addDraft` and the inbox would stay empty.
    const nextEvent = makeEvent(failingRowid + 1, 'follow-up');
    await handleIncoming(nextEvent);

    const drafts = useProxyInbox.getState().drafts;
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0].triggerRowid).toBe(failingRowid + 1);
  });

  it('DOES advance the watermark when draftAndMaybeSend completes normally', async () => {
    seedConfig();

    const rowid = 200;
    await handleIncoming(makeEvent(rowid));

    const cfg = useProxy
      .getState()
      .configs.find(c => c.handle === HANDLE);
    expect(cfg?.lastSeenRowid).toBe(rowid);
  });
});
