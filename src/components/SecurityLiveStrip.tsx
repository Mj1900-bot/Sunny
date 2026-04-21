/**
 * Compact live-security status strip that sits in the NavPanel header
 * in place of the old CORE/LIFE/COMMS/… jump-chip row.
 *
 * Shows, at a glance:
 *   - a traffic-light dot (green / amber / red) driven by the highest
 *     severity event in the last ~2 min,
 *   - four bucket indicators: AGENT / NET / PERM / HOST,
 *   - a PANIC micro-button that fires the backend kill-switch,
 *   - clicking anywhere on the strip jumps to the SECURITY module.
 *
 * Subscribes to `sunny://security.summary` (≤2 Hz). Falls back to a
 * neutral "unknown" state if the backend isn't ready yet or we're
 * running outside Tauri.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { invokeSafe, isTauri, listen } from '../lib/tauri';
import { useView } from '../store/view';

type Severity = 'ok' | 'warn' | 'crit' | 'unknown';
type BucketKey = 'agent' | 'net' | 'perm' | 'host';

type Summary = {
  readonly severity: Severity;
  readonly agent: Severity;
  readonly net: Severity;
  readonly perm: Severity;
  readonly host: Severity;
  readonly panic_mode: boolean;
  readonly headline?: string;
  readonly threat_score: number;
  readonly minute_events: ReadonlyArray<number>;
  readonly counts: {
    readonly anomalies_window: number;
    readonly crit_window: number;
    readonly warn_window: number;
  };
};

const DEFAULT_SUMMARY: Summary = {
  severity: 'unknown',
  agent: 'unknown',
  net: 'unknown',
  perm: 'unknown',
  host: 'unknown',
  panic_mode: false,
  threat_score: 0,
  minute_events: new Array(60).fill(0),
  counts: { anomalies_window: 0, crit_window: 0, warn_window: 0 },
};

const TONE: Record<Severity, string> = {
  ok:      'var(--green)',
  warn:    'var(--amber)',
  crit:    'var(--red)',
  unknown: 'var(--ink-dim)',
};

const BUCKET_LABEL: Record<BucketKey, string> = {
  agent: 'AGENT',
  net:   'NET',
  perm:  'PERM',
  host:  'HOST',
};

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px',
  border: '1px solid var(--line-soft)',
  background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.06), transparent 80%)',
  cursor: 'pointer',
  position: 'relative',
  overflow: 'hidden',
  transition: 'box-shadow 240ms ease, border-color 240ms ease',
};

const bucketChipStyle = (tone: Severity, active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '1px 5px',
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.18em',
  fontWeight: 800,
  color: TONE[tone],
  border: `1px solid ${TONE[tone]}55`,
  background: active ? `${TONE[tone]}18` : 'rgba(6, 14, 22, 0.35)',
});

const panicBtnStyle = (armed: boolean): CSSProperties => ({
  all: 'unset',
  cursor: 'pointer',
  padding: '1px 7px',
  fontFamily: 'var(--display)',
  fontSize: 9,
  letterSpacing: '0.22em',
  fontWeight: 800,
  color: armed ? '#fff' : 'var(--red)',
  border: `1px solid ${armed ? 'var(--red)' : 'rgba(255, 77, 94, 0.6)'}`,
  background: armed ? 'var(--red)' : 'rgba(255, 77, 94, 0.10)',
  marginLeft: 'auto',
  textShadow: armed ? '0 0 6px rgba(255, 77, 94, 0.9)' : 'none',
});

export function SecurityLiveStrip() {
  const setView = useView(s => s.setView);
  const [summary, setSummary] = useState<Summary>(DEFAULT_SUMMARY);
  const [pulse, setPulse] = useState(false);
  const [confirming, setConfirming] = useState<null | 'panic' | 'sending'>(null);
  const confirmTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let alive = true;

    void (async () => {
      const initial = await invokeSafe<Summary>('security_summary');
      if (!alive) return;
      if (initial) setSummary(initial);

      const un = await listen<Summary>('sunny://security.summary', payload => {
        if (!alive) return;
        setSummary(payload);
        // Flash the traffic-light on severity bumps so the user notices.
        if (payload.severity === 'crit' || payload.severity === 'warn') {
          setPulse(true);
          window.setTimeout(() => setPulse(false), 800);
        }
      });
      unlisten = un;
    })();

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const go = () => setView('security');

  const onPanic = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (summary.panic_mode) {
      // already panicked — clicking the button in that state navigates
      // to the Security page so the user can release via the Overview
      // tab (intentionally not a one-click release — re-enabling the
      // agent should be deliberate).
      go();
      return;
    }
    if (confirming === 'panic') {
      // Second click within the confirm window — actually fire.
      setConfirming('sending');
      void (async () => {
        await invokeSafe('security_panic', { reason: 'user_panic_button' });
        setConfirming(null);
      })();
      if (confirmTimer.current) {
        window.clearTimeout(confirmTimer.current);
        confirmTimer.current = null;
      }
      return;
    }
    setConfirming('panic');
    // 3s cool-down before the click needs to happen — clear it if the
    // user walks away.
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      setConfirming(null);
      confirmTimer.current = null;
    }, 3000);
  };

  const dotTone = summary.panic_mode ? 'crit' : summary.severity;
  const score = Math.max(0, Math.min(100, summary.threat_score || 0));

  // Score-driven color even when bucket severity is OK — a crit
  // threat score (> 75) shouldn't look green just because no
  // individual bucket has flipped yet.
  const scoreTone: Severity =
    summary.panic_mode ? 'crit'
    : score >= 75 ? 'crit'
    : score >= 45 ? 'warn'
    : dotTone;
  const scoreColor = TONE[scoreTone];

  return (
    <button
      type="button"
      onClick={go}
      aria-label="Open security module"
      title={
        summary.panic_mode
          ? 'PANIC MODE — agent + egress blocked. Click to review.'
          : summary.headline || 'Live security status — click for detail'
      }
      style={{
        ...wrapStyle,
        borderColor: summary.panic_mode ? 'var(--red)' : 'var(--line-soft)',
        boxShadow: summary.panic_mode ? '0 0 10px rgba(255, 77, 94, 0.35)' : 'none',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background =
          'linear-gradient(90deg, rgba(57, 229, 255, 0.12), transparent 70%)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background =
          'linear-gradient(90deg, rgba(57, 229, 255, 0.06), transparent 80%)';
      }}
    >
      {/* Traffic-light dot */}
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          background: scoreColor,
          boxShadow: `0 0 ${pulse || summary.panic_mode ? 10 : 6}px ${scoreColor}`,
          transition: 'box-shadow 220ms ease, background 220ms ease',
        }}
      />

      {/* Title + score */}
      <span
        style={{
          fontFamily: 'var(--display)',
          fontSize: 9,
          letterSpacing: '0.22em',
          fontWeight: 800,
          color: summary.panic_mode ? 'var(--red)' : scoreColor,
        }}
      >
        {summary.panic_mode ? 'PANIC' : 'SECURE'}
      </span>
      <span
        className={!summary.panic_mode && score === 0 ? 'secure-score--idle' : undefined}
        style={{
          fontFamily: 'var(--display)',
          fontSize: 11,
          fontWeight: 800,
          color: scoreColor,
          minWidth: 22,
          textAlign: 'right',
        }}
        title={`Threat score: ${score}/100`}
      >
        {summary.panic_mode ? '!' : score}
      </span>

      {/* Micro sparkline */}
      <MiniSparkline
        series={summary.minute_events}
        tone={scoreColor}
        idle={!summary.panic_mode && score === 0}
      />

      {/* Per-bucket indicators */}
      <div style={{ display: 'flex', gap: 3, alignItems: 'center', marginLeft: 2 }}>
        {(['agent', 'net', 'perm', 'host'] as const).map(b => (
          <span
            key={b}
            style={bucketChipStyle(summary[b], summary[b] !== 'ok' && summary[b] !== 'unknown')}
            title={`${BUCKET_LABEL[b]} · ${summary[b].toUpperCase()}`}
          >
            {BUCKET_LABEL[b]}
          </span>
        ))}
      </div>

      {/* Panic button */}
      <button
        onClick={onPanic}
        aria-label={summary.panic_mode ? 'Panic mode active — open Security' : 'Activate panic mode'}
        style={panicBtnStyle(confirming !== null || summary.panic_mode)}
        title={
          summary.panic_mode
            ? 'PANIC mode engaged — review & release from Security page'
            : confirming === 'panic'
              ? 'Click again within 3s to confirm. Will abort all agents + block egress.'
              : confirming === 'sending'
                ? 'Arming…'
                : 'PANIC — abort agents, block egress, stop daemons. Requires confirmation.'
        }
      >
        {summary.panic_mode ? '◼ ARMED' : confirming === 'panic' ? '? CONFIRM' : confirming === 'sending' ? '… ARM' : '◉ PANIC'}
      </button>
    </button>
  );
}

/**
 * Tiny inline sparkline — no viewbox padding, sized for the nav
 * strip (60 samples over ~54px).  We render without any deps so
 * the nav isn't lazy-loaded like the SecurityPage chunk.
 */
function MiniSparkline({
  series,
  tone,
  idle,
}: {
  series: ReadonlyArray<number>;
  tone: string;
  idle?: boolean;
}) {
  const w = 54;
  const h = 14;
  const max = Math.max(1, ...series);
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const pts = series
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      className={idle ? 'secure-sparkline--idle' : undefined}
      style={{ flexShrink: 0 }}
    >
      {pts && (
        <polyline
          points={pts}
          fill="none"
          stroke={tone}
          strokeWidth="1"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0.9"
        />
      )}
    </svg>
  );
}
