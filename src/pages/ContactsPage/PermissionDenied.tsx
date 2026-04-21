import { AMBER, AMBER_GLOW, AMBER_SOFT } from './constants';
import type { PermissionDeniedProps } from './types';

export function PermissionDenied({ onOpenSettings, onRetry }: PermissionDeniedProps) {
  return (
    <div
      style={{
        margin: 'auto',
        maxWidth: 520,
        textAlign: 'center',
        color: 'var(--ink-2)',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        lineHeight: 1.7,
        display: 'flex',
        flexDirection: 'column',
        gap: 22,
        alignItems: 'center',
        padding: '28px 24px',
        border: `1px solid ${AMBER}`,
        background: `linear-gradient(180deg, ${AMBER_SOFT}, rgba(6, 14, 22, 0.5))`,
        boxShadow: `0 0 22px ${AMBER_GLOW}`,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--display)',
          letterSpacing: '0.32em',
          fontSize: 16,
          fontWeight: 700,
          color: AMBER,
          textShadow: `0 0 18px ${AMBER_GLOW}`,
        }}
      >
        — FULL DISK ACCESS REQUIRED —
      </div>
      <div style={{ color: 'var(--ink-2)', maxWidth: 440 }}>
        SUNNY needs Full Disk Access to read{' '}
        <code
          style={{
            fontFamily: 'var(--mono)',
            color: AMBER,
            fontSize: 11.5,
            letterSpacing: '0.05em',
          }}
        >
          ~/Library/Messages/chat.db
        </code>
        .
      </div>
      <div style={{ color: 'var(--ink-dim)', maxWidth: 480, fontSize: 11, lineHeight: 1.65 }}>
        If access is already enabled in System Settings, a recent app rebuild can leave a stale
        privacy grant (macOS ties permissions to the code signature). Open{' '}
        <b style={{ color: 'var(--ink-2)' }}>SETTINGS → PERMISSIONS</b> in SUNNY, use{' '}
        <b style={{ color: 'var(--ink-2)' }}>RESET TCC FOR BUNDLE</b>, relaunch, then enable Full Disk
        Access for Sunny again — or run{' '}
        <code style={{ fontFamily: 'var(--mono)', color: AMBER, fontSize: 10.5 }}>
          tccutil reset SystemPolicyAllFiles ai.kinglystudio.sunny
        </code>{' '}
        in Terminal and retry.
      </div>
      <div style={{ color: 'var(--ink-dim)', maxWidth: 480, fontSize: 10.5, lineHeight: 1.6 }}>
        Sending iMessages additionally requires{' '}
        <b style={{ color: 'var(--ink-2)' }}>AUTOMATION</b> access for{' '}
        <code style={{ fontFamily: 'var(--mono)', color: AMBER, fontSize: 10.5 }}>Messages.app</code>
        . macOS will prompt on the first send; approve it there or toggle it under Privacy →
        Automation.
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={onOpenSettings}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '9px 20px',
            border: `1px solid ${AMBER}`,
            color: AMBER,
            fontFamily: 'var(--display)',
            fontSize: 11,
            letterSpacing: '0.28em',
            fontWeight: 700,
            background: `linear-gradient(90deg, ${AMBER_SOFT}, transparent)`,
            boxShadow: `0 0 14px ${AMBER_GLOW}`,
          }}
        >
          OPEN SYSTEM SETTINGS
        </button>
        <button
          type="button"
          onClick={onRetry}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '9px 20px',
            border: '1px solid var(--line)',
            color: 'var(--ink-2)',
            fontFamily: 'var(--display)',
            fontSize: 11,
            letterSpacing: '0.28em',
            fontWeight: 700,
            background: 'rgba(6, 14, 22, 0.5)',
          }}
        >
          RETRY
        </button>
      </div>
    </div>
  );
}
