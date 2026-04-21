/**
 * PERMISSIONS tab — live TCC grid.
 */

import { useEffect, useState } from 'react';
import { invokeSafe } from '../../lib/tauri';
import {
  emptyStateStyle,
  hintStyle,
  mutedBtnStyle,
  permStateColor,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import { fetchPermGrid } from './api';
import type { PermGrid, PermState } from './types';

const DEFAULT_GRID: PermGrid = {
  screen_recording: 'unknown',
  accessibility: 'unknown',
  full_disk_access: 'unknown',
  automation: 'unknown',
  microphone: 'unknown',
  camera: 'unknown',
  contacts: 'unknown',
  calendar: 'unknown',
  reminders: 'unknown',
  photos: 'unknown',
  input_monitoring: 'unknown',
  updated_at: 0,
};

type Row = {
  readonly key: keyof Omit<PermGrid, 'updated_at'>;
  readonly label: string;
  readonly blurb: string;
  /** Deep-link URL to the matching System Settings pane (macOS). */
  readonly settingsUrl: string;
};

const ROWS: ReadonlyArray<Row> = [
  {
    key: 'full_disk_access',
    label: 'Full Disk Access',
    blurb: 'Read protected user files (Messages, Mail, Calendar, Contacts DBs).',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  },
  {
    key: 'accessibility',
    label: 'Accessibility',
    blurb: 'Send key events / mouse clicks to other apps. Required for ax.rs window poke.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  },
  {
    key: 'automation',
    label: 'Automation (System Events)',
    blurb: 'Drive other apps via AppleScript. Required for messaging / notes / reminders.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  },
  {
    key: 'screen_recording',
    label: 'Screen Recording',
    blurb: 'Capture the screen for OCR + remember_screen.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  },
  {
    key: 'microphone',
    label: 'Microphone',
    blurb: 'Voice capture for wake word + transcription.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  },
  {
    key: 'camera',
    label: 'Camera',
    blurb: 'Not used by Sunny yet. Should remain denied unless you add a tool.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  },
  {
    key: 'contacts',
    label: 'Contacts',
    blurb: 'Address-book lookups for messaging + mail tools.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
  },
  {
    key: 'calendar',
    label: 'Calendar',
    blurb: 'Read + create calendar events.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  },
  {
    key: 'reminders',
    label: 'Reminders',
    blurb: 'Read + create reminders.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
  },
  {
    key: 'photos',
    label: 'Photos',
    blurb: 'Index the user Photos library (PhotosPage).',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Photos',
  },
  {
    key: 'input_monitoring',
    label: 'Input Monitoring',
    blurb: 'Needed only for keylogger-style tools. Should remain denied.',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  },
];

export function PermissionsTab() {
  const [grid, setGrid] = useState<PermGrid>(DEFAULT_GRID);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    setBusy(true);
    const g = await fetchPermGrid();
    if (g) setGrid(g);
    setBusy(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  const onOpenSettings = (url: string) => {
    void invokeSafe('open_url', { url });
  };

  const onTccReset = async () => {
    // Sunny's bundle id is fixed in tauri.conf.json — we surface it on
    // the button press so the user doesn't need to type it.
    const bundleId = 'ai.kinglystudio.sunny';
    setBusy(true);
    await invokeSafe('tcc_reset_sunny', { bundleId });
    await reload();
    setBusy(false);
  };

  return (
    <>
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>PERMISSIONS (TCC)</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Last probed {grid.updated_at ? new Date(grid.updated_at * 1000).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
          </span>
          <button style={mutedBtnStyle} onClick={() => void reload()} disabled={busy}>
            {busy ? 'PROBING…' : 'RE-CHECK'}
          </button>
          <button style={mutedBtnStyle} onClick={() => void onTccReset()} disabled={busy}>
            RESET (tccutil)
          </button>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          {ROWS.map(row => (
            <PermRow
              key={row.key}
              row={row}
              state={grid[row.key] as PermState}
              onOpenSettings={() => onOpenSettings(row.settingsUrl)}
            />
          ))}
        </div>
      </section>

      <section style={{ ...sectionStyle, borderStyle: 'dashed' }}>
        <div style={sectionTitleStyle}>NOTES</div>
        <ul style={{ ...hintStyle, margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>
            <strong>Unknown</strong> means the probe can't answer without triggering a
            user prompt (Mic / Camera / Input Monitoring). Check System Settings for
            the authoritative answer.
          </li>
          <li>
            <strong>Reset (tccutil)</strong> clears Sunny's grants. Use after an
            unsigned-rebuild if permissions misbehave — macOS will re-prompt on next use.
          </li>
          <li>
            Permission flips emit a live event on the Overview feed. If you didn't
            grant or revoke something, investigate immediately.
          </li>
        </ul>
      </section>

      {!grid.updated_at && (
        <div style={emptyStateStyle}>
          Live probe hasn't completed yet. Give it a few seconds — the background
          watcher polls every 10 s.
        </div>
      )}
    </>
  );
}

function PermRow({
  row,
  state,
  onOpenSettings,
}: {
  row: Row;
  state: PermState;
  onOpenSettings: () => void;
}) {
  const color = permStateColor(state);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '200px 90px 1fr auto',
        gap: 10,
        alignItems: 'center',
        padding: '7px 10px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.45)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <span style={{ color: 'var(--ink)' }}>{row.label}</span>
      <span
        style={{
          color,
          padding: '1px 7px',
          border: `1px solid ${color}88`,
          background: `${color}14`,
          fontSize: 9,
          letterSpacing: '0.22em',
          fontWeight: 700,
          textAlign: 'center',
          textTransform: 'uppercase',
        }}
      >
        {state}
      </span>
      <span style={{ color: 'var(--ink-dim)', fontSize: 10.5 }}>{row.blurb}</span>
      <button style={mutedBtnStyle} onClick={onOpenSettings}>
        OPEN SETTINGS
      </button>
    </div>
  );
}
