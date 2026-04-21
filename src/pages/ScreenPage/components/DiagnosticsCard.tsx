import type { PermissionProbe, PaneKey } from '../types';
import { ghostBtn, actionBtn, tinyBtn, labelSmall } from '../styles';
import { statusColor, statusText, formatAge } from '../utils';

export type DiagnosticsCardProps = {
  probe: PermissionProbe;
  onProbe: () => void;
  onOpenPane: (pane: PaneKey) => void;
  onRelaunch: () => void;
  onResetTcc: () => void;
  relaunching: boolean;
  now: number;
};

type RowSpec = {
  key: keyof Pick<PermissionProbe, 'screenRecording' | 'automation' | 'accessibility' | 'tesseract'>;
  label: string;
  need: string;
  pane: PaneKey | null;
};

const PROBE_ROWS: ReadonlyArray<RowSpec> = [
  {
    key: 'screenRecording',
    label: 'SCREEN RECORDING',
    need: 'Required for every screen capture (FULL / WINDOW / REGION).',
    pane: 'screenRecording',
  },
  {
    key: 'automation',
    label: 'AUTOMATION · SYSTEM EVENTS',
    need: 'Required to list open windows, read focused app, and activate apps.',
    pane: 'automation',
  },
  {
    key: 'accessibility',
    label: 'ACCESSIBILITY',
    need: 'Required to move the mouse and click on OCR boxes via the real cursor.',
    pane: 'accessibility',
  },
  {
    key: 'tesseract',
    label: 'TESSERACT OCR',
    need: '`brew install tesseract` — needed for text extraction and box overlays.',
    pane: null,
  },
];

export function DiagnosticsCard({
  probe, onProbe, onOpenPane, onRelaunch, onResetTcc, relaunching, now,
}: DiagnosticsCardProps) {
  const anyMissing =
    probe.screenRecording.status === 'missing' ||
    probe.automation.status === 'missing' ||
    probe.accessibility.status === 'missing' ||
    probe.tesseract.status === 'missing';

  const headerColor = anyMissing ? 'var(--amber)' : 'var(--cyan)';
  const bg = anyMissing
    ? 'linear-gradient(90deg, rgba(255,179,71,0.12), rgba(255,179,71,0.02))'
    : 'rgba(6,14,22,0.45)';
  const border = anyMissing ? '1px solid rgba(255,179,71,0.55)' : '1px solid var(--line-soft)';

  const checkedAgo = probe.checkedAt === 0 ? 'never' : formatAge(now - probe.checkedAt);

  return (
    <div
      role={anyMissing ? 'alert' : 'region'}
      aria-label="permissions diagnostics"
      style={{
        border,
        background: bg,
        padding: '10px 12px',
        boxShadow: anyMissing ? '0 0 14px rgba(255,179,71,0.15)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10 }}>
        <span
          style={{
            fontFamily: 'var(--display)',
            fontSize: 11,
            letterSpacing: '0.22em',
            color: headerColor,
            fontWeight: 700,
          }}
        >
          PERMISSIONS
          <span style={{ color: 'var(--ink-dim)', marginLeft: 10 }}>
            · checked {checkedAgo}
          </span>
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onProbe} style={{ ...ghostBtn, padding: '4px 10px', fontSize: 9.5 }}>
            RUN DIAGNOSTICS
          </button>
          {anyMissing && (
            <>
              <button
                onClick={onResetTcc}
                style={{
                  ...actionBtn,
                  padding: '4px 10px',
                  fontSize: 9.5,
                  color: 'var(--amber)',
                  borderColor: 'rgba(255,179,71,0.6)',
                  background: 'rgba(255,179,71,0.1)',
                }}
                title="Run tccutil reset on Sunny's bundle id so macOS re-prompts fresh"
              >
                RESET TCC GRANTS
              </button>
              <button
                onClick={onRelaunch}
                disabled={relaunching}
                style={{
                  ...actionBtn,
                  padding: '4px 10px',
                  fontSize: 9.5,
                  color: 'var(--red)',
                  borderColor: 'rgba(255,77,94,0.55)',
                  background: 'rgba(255,77,94,0.08)',
                }}
              >
                {relaunching ? 'RELAUNCHING…' : 'RELAUNCH SUNNY'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Per-permission rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {PROBE_ROWS.map(row => {
          const state = probe[row.key];
          return (
            <div
              key={row.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '220px 100px 1fr auto',
                gap: 12,
                alignItems: 'center',
                padding: '6px 8px',
                border: '1px solid rgba(57,229,255,0.08)',
                background: 'rgba(2,6,10,0.35)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  letterSpacing: '0.12em',
                  color: 'var(--ink)',
                  fontWeight: 600,
                }}
              >
                {row.label}
              </span>
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.15em',
                  color: statusColor(state.status),
                  fontWeight: 700,
                }}
              >
                {statusText(state.status)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  color: state.status === 'missing' ? 'var(--red)' : 'var(--ink-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={state.message ?? row.need}
              >
                {state.status === 'missing' && state.message ? state.message : row.need}
              </span>
              {row.pane ? (
                <button
                  onClick={() => onOpenPane(row.pane as PaneKey)}
                  style={{ ...tinyBtn, padding: '4px 9px' }}
                >
                  OPEN PANE
                </button>
              ) : (
                <span style={{ ...labelSmall, fontSize: 9.5 }}>BREW</span>
              )}
            </div>
          );
        })}
      </div>

      {anyMissing && (
        <div
          style={{
            marginTop: 8,
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            color: 'var(--ink-dim)',
            lineHeight: 1.6,
          }}
        >
          <b style={{ color: 'var(--amber)' }}>Why is it MISSING when I already toggled it on?</b>
          {' '}macOS TCC keys each grant to the app&rsquo;s <i>code signature</i>,
          not just its bundle id. A dev rebuild gets a fresh ad-hoc signature,
          so the old &quot;Sunny&quot; row in Settings is treated as a different app.
          <br />
          <b style={{ color: 'var(--cyan)' }}>Fix:</b> click
          {' '}<b>RESET TCC GRANTS</b> to run
          {' '}<code>tccutil reset</code> for Sunny&rsquo;s bundle id on ScreenCapture /
          Accessibility / AppleEvents / Full Disk Access, then <b>RELAUNCH SUNNY</b>. Turn Full Disk Access
          back ON for Sunny if the toggle cleared. macOS will prompt fresh on
          the next capture / click / window query — click Allow each time.
        </div>
      )}
    </div>
  );
}
