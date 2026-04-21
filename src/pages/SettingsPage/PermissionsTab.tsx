/**
 * PermissionsTab — macOS TCC (Transparency, Consent, Control) dashboard.
 *
 * SUNNY's most capable tools (screen_capture, mouse_click, keyboard_type,
 * applescript, calendar_*, mail_*, …) all sit behind TCC. When they silently
 * fail the agent log just shows "operation not permitted" and the user is
 * left guessing which pane of System Settings to open.
 *
 * This tab:
 *  - Surfaces each permission with its live status (OK / MISSING / UNKNOWN).
 *  - Opens the relevant Privacy pane on one click (no more "hunt for
 *    Accessibility across three System Settings redesigns").
 *  - Nukes the TCC allow-list for a given bundle id via `tccutil reset`
 *    so a stale grant can be re-prompted cleanly.
 */

import { useCallback, useEffect, useState, type JSX } from 'react';
import { invokeSafe, isTauri } from '../../lib/tauri';
import {
  chipBase,
  codeStyle,
  dangerBtnStyle,
  hintStyle,
  primaryBtnStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  statusPillStyle,
} from './styles';

type PermKey = 'screen' | 'accessibility' | 'automation' | 'fullDisk';

type PermRow = Readonly<{
  key: PermKey;
  label: string;
  description: string;
  what: string;
  prefpane: string;
  tccServices: ReadonlyArray<string>;
}>;

const ROWS: ReadonlyArray<PermRow> = [
  {
    key: 'screen',
    label: 'Screen Recording',
    description:
      'Needed by screen_capture_*, OCR, vision-action tools, and the SCREEN module.',
    what: 'Capture the screen · read window contents · OCR.',
    prefpane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    tccServices: ['kTCCServiceScreenCapture'],
  },
  {
    key: 'accessibility',
    label: 'Accessibility',
    description:
      'Needed by mouse_*, keyboard_*, window_list, AX tree inspection, and every automation tool.',
    what: 'Move the cursor · type · read window focus · inspect UI trees.',
    prefpane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    tccServices: ['kTCCServiceAccessibility'],
  },
  {
    key: 'automation',
    label: 'Automation (System Events)',
    description:
      'Needed by applescript, calendar_*, mail_*, notes_*, reminders_*, messaging_*, media_*.',
    what: 'Drive other apps via AppleScript / JXA.',
    prefpane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    tccServices: ['kTCCServiceAppleEvents'],
  },
  {
    key: 'fullDisk',
    label: 'Full Disk Access',
    description:
      'Needed by messages_recent, list_chats, fetch_conversation, the SUNNY proxy, and AddressBook name resolution.',
    what: 'Read ~/Library/Messages/chat.db and AddressBook databases.',
    prefpane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    tccServices: ['kTCCServiceSystemPolicyAllFiles'],
  },
];

const DEFAULT_BUNDLE_ID = 'ai.kinglystudio.sunny';

type Statuses = Readonly<Record<PermKey, boolean | null>>;

export function PermissionsTab(): JSX.Element {
  const [statuses, setStatuses] = useState<Statuses>({
    screen: null, accessibility: null, automation: null, fullDisk: null,
  });
  const [busy, setBusy] = useState(false);
  const [bundleId, setBundleId] = useState(DEFAULT_BUNDLE_ID);
  const [resetOutput, setResetOutput] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    const [scr, acc, aut, fda] = await Promise.all([
      invokeSafe<boolean>('permission_check_screen_recording'),
      invokeSafe<boolean>('permission_check_accessibility'),
      invokeSafe<boolean>('permission_check_automation'),
      invokeSafe<boolean>('permission_check_full_disk_access'),
    ]);
    setStatuses({
      screen: scr ?? null,
      accessibility: acc ?? null,
      automation: aut ?? null,
      fullDisk: fda ?? null,
    });
    setBusy(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openPane = useCallback((url: string) => {
    // Uses `open_url` rather than `open_path` because the latter routes
    // through the filesystem safety pipeline, which canonicalizes
    // `x-apple.systempreferences:…` into nonsense and rejects it.
    void invokeSafe('open_url', { url });
  }, []);

  const doResetTcc = useCallback(async () => {
    const trimmed = bundleId.trim();
    if (!trimmed) return;
    const confirmed = window.confirm(
      `Reset TCC for bundle\n\n  ${trimmed}\n\nEvery macOS privacy permission granted to SUNNY will be revoked. You'll be re-prompted on the next tool call.`,
    );
    if (!confirmed) return;

    setResetBusy(true);
    setResetOutput(null);
    type TccResult = Readonly<{
      bundle_id: string;
      ok: ReadonlyArray<string>;
      failed: ReadonlyArray<string>;
    }>;
    const res = await invokeSafe<TccResult>('tcc_reset_sunny', { bundleId: trimmed });
    if (!res) {
      setResetOutput('tcc_reset_sunny returned no result — are you on macOS with tccutil?');
    } else if (res.failed.length > 0) {
      setResetOutput(
        `Partial · cleared ${res.ok.join(', ')} · failed:\n${res.failed.join('\n')}`,
      );
    } else {
      setResetOutput(
        res.ok.length > 0
          ? `OK · cleared ${res.ok.join(', ')} for ${res.bundle_id}`
          : `OK · no TCC rows cleared for ${res.bundle_id}`,
      );
    }
    setResetBusy(false);
    await refresh();
  }, [bundleId, refresh]);

  const allOk = Object.values(statuses).every(v => v === true);
  const badgeColor = allOk ? 'var(--cyan)' : 'var(--amber)';

  return (
    <>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>OVERVIEW</h3>
        <div style={{ ...rowStyle, marginBottom: 10 }}>
          <span style={statusPillStyle(badgeColor)}>
            {allOk ? 'ALL GREEN' : 'GRANTS NEEDED'}
          </span>
          <button
            type="button"
            style={primaryBtnStyle}
            onClick={() => void refresh()}
            disabled={busy || !isTauri}
          >
            {busy ? 'PROBING…' : 'REFRESH'}
          </button>
          {!isTauri && (
            <span style={{ ...hintStyle, marginTop: 0 }}>
              Permissions only report inside the Tauri app.
            </span>
          )}
        </div>
        <div style={hintStyle}>
          macOS gates these via TCC. A missing permission shows up in the Auto
          log as "operation not permitted" or silent failure — when in doubt,
          check this dashboard first.
        </div>
      </section>

      {ROWS.map(row => (
        <PermissionCard
          key={row.key}
          row={row}
          status={statuses[row.key]}
          onOpen={() => openPane(row.prefpane)}
        />
      ))}

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>RESET TCC</h3>
        <div style={hintStyle}>
          Nukes every TCC entry for a given bundle id (equivalent to
          <code style={codeStyle}>tccutil reset All &lt;bundle-id&gt;</code>).
          Use this when a grant got stuck or you want a clean re-prompt flow.
          Requires a restart of the Sunny app to take full effect.
        </div>
        <div style={{ ...rowStyle, marginTop: 10 }}>
          <input
            type="text"
            value={bundleId}
            onChange={e => setBundleId(e.target.value)}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              padding: '6px 10px',
              border: '1px solid var(--line-soft)',
              background: 'rgba(2, 6, 10, 0.6)',
              color: 'var(--ink)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              minWidth: 280,
            }}
            aria-label="Bundle ID for TCC reset"
            placeholder={DEFAULT_BUNDLE_ID}
          />
          <button
            type="button"
            style={dangerBtnStyle}
            onClick={() => void doResetTcc()}
            disabled={resetBusy || !isTauri || bundleId.trim().length === 0}
          >
            {resetBusy ? 'RESETTING…' : 'RESET TCC FOR BUNDLE'}
          </button>
        </div>
        {resetOutput && (
          <pre
            style={{
              marginTop: 10,
              padding: '8px 10px',
              background: 'rgba(0, 0, 0, 0.35)',
              border: '1px solid var(--line-soft)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {resetOutput}
          </pre>
        )}
      </section>
    </>
  );
}

type CardProps = {
  readonly row: PermRow;
  readonly status: boolean | null;
  readonly onOpen: () => void;
};

function PermissionCard({ row, status, onOpen }: CardProps): JSX.Element {
  const color =
    status === null ? 'var(--ink-dim)' : status ? 'var(--cyan)' : 'var(--amber)';
  const label =
    status === null ? 'UNKNOWN' : status ? 'GRANTED' : 'MISSING';

  return (
    <section style={sectionStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <h3 style={{ ...sectionTitleStyle, marginBottom: 0 }}>{row.label}</h3>
        <span style={statusPillStyle(color)}>{label}</span>
      </div>
      <div style={{ ...hintStyle, marginTop: 0 }}>{row.description}</div>
      <div style={{ ...hintStyle, marginTop: 4 }}>
        What it grants: <span style={{ color: 'var(--ink-2)' }}>{row.what}</span>
      </div>
      <div style={{ ...hintStyle, marginTop: 4 }}>
        TCC service:{' '}
        {row.tccServices.map((s, i) => (
          <span key={s}>
            <code style={codeStyle}>{s}</code>
            {i < row.tccServices.length - 1 ? ', ' : ''}
          </span>
        ))}
      </div>
      <div style={{ ...rowStyle, marginTop: 10 }}>
        <button type="button" style={chipBase} onClick={onOpen}>
          OPEN PRIVACY PANE
        </button>
      </div>
    </section>
  );
}
