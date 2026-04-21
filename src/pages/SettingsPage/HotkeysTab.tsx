/**
 * HotkeysTab — canonical reference for every global shortcut SUNNY owns,
 * plus the only bit the user can actually remap today: the push-to-talk
 * key. The rest are hard-coded in `useGlobalHotkeys.ts` / menu builders,
 * and this tab keeps them in one place so the user doesn't have to dig
 * through Help overlay + menu bar + source to find them.
 *
 * Keeping it read-mostly is intentional — rebinding every hotkey opens a
 * long tail of conflict-resolution UI that doesn't pay off for a personal
 * HUD. We surface everything, we bind the two that matter.
 */

import { type JSX, type CSSProperties } from 'react';
import { useView } from '../../store/view';
import {
  chipStyle,
  codeStyle,
  hintStyle,
  labelStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';

type Hotkey = Readonly<{
  combo: string;
  description: string;
}>;

type HotkeyGroup = Readonly<{
  label: string;
  rows: ReadonlyArray<Hotkey>;
}>;

const GROUPS: ReadonlyArray<HotkeyGroup> = [
  {
    label: 'NAVIGATION',
    rows: [
      { combo: '⌘ 1', description: 'Jump to OVERVIEW' },
      { combo: '⌘ 2', description: 'Jump to FILES' },
      { combo: '⌘ 3', description: 'Jump to APPS' },
      { combo: '⌘ 4', description: 'Jump to AUTO (todos + scheduled daemons)' },
      { combo: '⌘ 5', description: 'Jump to CALENDAR' },
      { combo: '⌘ 6', description: 'Jump to SCREEN' },
      { combo: '⌘ 7', description: 'Jump to CONTACTS' },
      { combo: '⌘ 8', description: 'Jump to MEMORY' },
      { combo: '⌘ 9', description: 'Jump to WEB' },
      { combo: '⌘ J', description: 'Toggle the bottom dock (terminals + chat)' },
      { combo: 'Esc', description: 'Close overlays · return to OVERVIEW' },
    ],
  },
  {
    label: 'VOICE',
    rows: [
      { combo: 'Space *', description: 'Push-to-talk · hold to record, release to send' },
      { combo: 'F19',     description: 'Alternate push-to-talk (no conflict with text inputs)' },
      { combo: '— hint —', description: 'Releases < 250 ms are debounced and ignored' },
    ],
  },
  {
    label: 'OVERLAYS',
    rows: [
      { combo: '?',  description: 'Toggle the help overlay' },
      { combo: '⌘ K', description: 'Open the QuickLauncher (apps + files + shortcuts)' },
    ],
  },
  {
    label: 'SETTINGS TABS',
    rows: [
      { combo: '1 – 8', description: 'Within Settings: switch tabs by index' },
      { combo: '⌘ /',   description: 'Focus the cross-tab search' },
    ],
  },
];

/** Shared with `GeneralTab`; exported so both surfaces stay in sync. */
export const PTT_KEYS = ['Space', 'F19'] as const;

export function HotkeysTab(): JSX.Element {
  const pushToTalkKey = useView(s => s.settings.pushToTalkKey);
  const patchSettings = useView(s => s.patchSettings);

  return (
    <>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>PUSH-TO-TALK</h3>
        <label style={labelStyle}>HOLD-TO-SPEAK KEY</label>
        <div style={{ ...rowStyle, marginBottom: 6 }}>
          {PTT_KEYS.map(k => (
            <button
              key={k}
              style={chipStyle(pushToTalkKey === k)}
              onClick={() => patchSettings({ pushToTalkKey: k })}
            >
              {k}
            </button>
          ))}
        </div>
        <div style={hintStyle}>
          Space is intuitive but has an important catch — it's ignored while
          you're typing in an input. F19 is the standard "dedicated macro"
          key on full keyboards and never collides with text entry, so it
          works everywhere (including inside text fields).
        </div>
      </section>

      {GROUPS.map(group => (
        <section key={group.label} style={sectionStyle}>
          <h3 style={sectionTitleStyle}>{group.label}</h3>
          <div style={tableStyle}>
            {group.rows.map(row => (
              <div key={row.combo} style={hotkeyRowStyle}>
                <span style={comboStyle}>{renderCombo(row.combo)}</span>
                <span style={descStyle}>{row.description}</span>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>TEXT-INPUT AWARENESS</h3>
        <div style={hintStyle}>
          The global hotkey listener checks the event target before acting — a
          key press inside an <code style={codeStyle}>&lt;input&gt;</code>,{' '}
          <code style={codeStyle}>&lt;textarea&gt;</code>, or any{' '}
          <code style={codeStyle}>contenteditable</code> element is treated as
          text. This means you never accidentally jump modules while typing in
          the chat box, and Space never starts a recording while you're
          filling out a form.
        </div>
      </section>
    </>
  );
}

function renderCombo(combo: string): JSX.Element {
  // Split on spaces so each key renders as its own chip. The "— hint —"
  // pseudo-combo is rendered whole with muted styling.
  if (combo.startsWith('—')) {
    return <span style={{ color: 'var(--ink-dim)', letterSpacing: '0.18em' }}>{combo}</span>;
  }
  const parts = combo.split(' ').filter(Boolean);
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} style={keyCapStyle}>{p}</span>
      ))}
    </span>
  );
}

const tableStyle: CSSProperties = {
  display: 'grid',
  gap: 2,
};

const hotkeyRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(120px, max-content) 1fr',
  alignItems: 'center',
  gap: 14,
  padding: '6px 0',
  borderBottom: '1px dashed rgba(120, 170, 200, 0.08)',
};

const comboStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--cyan)',
  letterSpacing: '0.1em',
};

const descStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
};

const keyCapStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(57, 229, 255, 0.08)',
  color: 'var(--cyan)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  minWidth: 18,
  textAlign: 'center',
};
