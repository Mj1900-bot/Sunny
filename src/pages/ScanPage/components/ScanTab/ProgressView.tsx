import { useMemo, useRef, type CSSProperties } from 'react';
import type { Finding, ScanPhase, ScanProgress } from '../../types';
import { FlaggedBreakdown } from './FlaggedBreakdown';
import {
  hintStyle,
  sectionStyle,
  sectionTitleStyle,
  statsRowStyle,
} from '../../styles';

const PROG_SEGMENTS = 48;

export function isRunning(phase: ScanPhase): boolean {
  return phase !== 'done' && phase !== 'aborted' && phase !== 'errored';
}

function phaseDisplay(phase: ScanPhase): string {
  switch (phase) {
    case 'queued': return 'QUEUED';
    case 'walking': return 'WALKING';
    case 'hashing': return 'HASHING';
    case 'analyzing': return 'ANALYZING';
    case 'done': return 'DONE';
    case 'aborted': return 'ABORTED';
    case 'errored': return 'ERROR';
  }
}

function phaseColor(phase: ScanPhase): string {
  if (phase === 'done') return 'rgb(120, 255, 170)';
  if (phase === 'aborted') return 'var(--amber)';
  if (phase === 'errored') return '#ff6a6a';
  return 'var(--cyan)';
}

function deriveProgressPct(p: ScanProgress): number {
  if (p.filesDiscovered === 0) return 0;
  if (p.phase === 'done' || p.phase === 'aborted') return 100;
  return Math.round((p.filesInspected / Math.max(1, p.filesDiscovered)) * 100);
}

function formatElapsed(p: ScanProgress): string {
  const end = p.finishedAt ?? Math.floor(Date.now() / 1000);
  const secs = Math.max(0, end - p.startedAt);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

// Rolling files-per-second estimate. Recomputed every render from the
// running progress snapshot — no effect, no stale state.
function useRate(p: ScanProgress): number | null {
  const history = useRef<Array<{ at: number; inspected: number }>>([]);
  const now = Date.now();
  history.current.push({ at: now, inspected: p.filesInspected });
  // Keep last 10 samples.
  if (history.current.length > 10) {
    history.current = history.current.slice(-10);
  }
  if (history.current.length < 2) return null;
  const first = history.current[0];
  const last = history.current[history.current.length - 1];
  const dt = (last.at - first.at) / 1000;
  if (dt <= 0) return null;
  return (last.inspected - first.inspected) / dt;
}

export function ProgressView({
  progress,
  findings,
  onJumpToFindings,
}: {
  progress: ScanProgress;
  findings: ReadonlyArray<Finding>;
  onJumpToFindings?: () => void;
}) {
  const phaseLabel = phaseDisplay(progress.phase);
  const rate = useRate(progress);
  const elapsedStr = formatElapsed(progress);
  const totalThreats = progress.suspicious + progress.malicious;
  const threatLevel = deriveThreatLevel(progress);

  // Aggregate signature-DB hits across all findings so the HUD can tell
  // the user how much of the curated threat database has actually fired
  // during this scan. We count malware-family and prompt-injection
  // signals separately since they map to different DB categories.
  const signatureStats = useMemo(() => {
    let family = 0;
    let prompt = 0;
    for (const f of findings) {
      for (const s of f.signals) {
        if (s.kind === 'known_malware_family') family += 1;
        else if (s.kind === 'prompt_injection') prompt += 1;
      }
    }
    return { family, prompt, total: family + prompt };
  }, [findings]);

  const isFinalized =
    progress.phase === 'done' || progress.phase === 'aborted' || progress.phase === 'errored';
  const severity: 'ok' | 'warn' | 'crit' =
    progress.malicious > 0 ? 'crit' : progress.suspicious > 0 ? 'warn' : 'ok';

  return (
    <section
      style={sectionStyle}
      className={`scan-card ${isFinalized ? 'is-done' : 'is-live'}`}
    >
      <div style={sectionTitleStyle}>
        <span>{isFinalized ? 'SUMMARY' : 'LIVE'}</span>
        <span
          className={`scan-phase ${isFinalized ? '' : 'is-live'}`}
          style={{
            marginLeft: 'auto',
            color: phaseColor(progress.phase),
            borderColor: phaseColor(progress.phase),
          }}
        >
          {phaseLabel}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '190px 1fr',
          gap: 18,
          alignItems: 'center',
        }}
      >
        <ThreatGauge level={threatLevel} total={totalThreats} isDone={isFinalized} />
        <div>
          <SegmentedProgress progress={progress} severity={severity} isDone={isFinalized} />

          {/* Continuous progress bar — shows exact % while segmented bar gives visual drama */}
          {!isFinalized && (
            <div
              style={{
                marginTop: 6,
                height: 3,
                background: 'rgba(57, 229, 255, 0.1)',
                border: '1px solid rgba(57, 229, 255, 0.18)',
                overflow: 'hidden',
              }}
              aria-hidden="true"
            >
              <div
                style={{
                  height: '100%',
                  width: `${deriveProgressPct(progress)}%`,
                  background: severity === 'crit'
                    ? 'linear-gradient(90deg, var(--amber), var(--red))'
                    : severity === 'warn'
                    ? 'linear-gradient(90deg, var(--cyan), var(--amber))'
                    : 'linear-gradient(90deg, var(--cyan), var(--cyan-2))',
                  boxShadow: severity === 'crit' ? '0 0 8px var(--red)' : '0 0 6px var(--cyan)',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
          )}

          <div
            style={{
              ...hintStyle,
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span>
              <strong style={{ color: 'var(--cyan)' }}>
                {progress.filesInspected}
              </strong>
              <span style={{ color: 'var(--ink-dim)' }}> / </span>
              <strong>{progress.filesDiscovered}</strong> inspected
            </span>
            {progress.filesSkipped > 0 && (
              <span>· {progress.filesSkipped} skipped</span>
            )}
            {rate !== null && !isFinalized && (
              <span>· {rate.toFixed(1)} files/s</span>
            )}
            {isFinalized && <span>· completed in {elapsedStr}</span>}

            {/* Live signature-DB match counter — collapses to nothing when
                zero so it doesn't crowd the HUD on clean runs. */}
            {signatureStats.total > 0 && (
              <span
                style={{
                  padding: '1px 8px',
                  border: '1px solid rgba(57, 229, 255, 0.55)',
                  background: 'rgba(57, 229, 255, 0.08)',
                  color: 'var(--cyan)',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.14em',
                }}
                title="Hits from the curated 2024-2026 threat database"
              >
                DB ·{' '}
                {signatureStats.family > 0 && (
                  <span style={{ color: '#ff9a9a' }}>
                    {signatureStats.family} malware
                  </span>
                )}
                {signatureStats.family > 0 && signatureStats.prompt > 0 && ' · '}
                {signatureStats.prompt > 0 && (
                  <span style={{ color: '#d76bff' }}>
                    {signatureStats.prompt} prompt-inj
                  </span>
                )}
              </span>
            )}

            {/* Live EQ — mini activity meter */}
            {!isFinalized && (
              <span
                className="scan-eq"
                aria-hidden="true"
                style={{ marginLeft: 'auto' }}
              >
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            )}
          </div>

          {/* Verdict counters */}
          <div style={{ ...statsRowStyle, marginTop: 14 }}>
            <VerdictCard label="CLEAN" value={progress.clean} tone="ok" />
            <VerdictCard label="INFO" value={progress.info} tone="info" />
            <VerdictCard label="SUSPICIOUS" value={progress.suspicious} tone="warn" />
            <VerdictCard label="MALICIOUS" value={progress.malicious} tone="crit" />
          </div>
        </div>
      </div>

      {/* Current file ticker — only while active */}
      {!isFinalized && progress.currentPath && (
        <div className="scan-ticker" title={progress.currentPath}>
          <span className="scan-ticker-caret">▸</span>
          <span className="scan-ticker-path">{progress.currentPath}</span>
        </div>
      )}

      {progress.lastError && (
        <div style={{ ...hintStyle, color: 'var(--amber)', marginTop: 6 }}>
          {progress.lastError}
        </div>
      )}

      {/* Detailed breakdown of what's been flagged so far — visible both
          live (as hits land) and after the scan wraps up. */}
      <FlaggedBreakdown
        findings={findings}
        isLive={!isFinalized}
        onJumpToFindings={onJumpToFindings}
      />

      {/* Post-scan banner */}
      {isFinalized && totalThreats === 0 && progress.filesInspected > 0 && (
        <div className="scan-banner ok">
          <strong>✓ ALL CLEAR</strong> — nothing malicious or suspicious. {progress.info}{' '}
          informational finding{progress.info === 1 ? '' : 's'} to review if curious.
        </div>
      )}
      {isFinalized && totalThreats > 0 && progress.malicious === 0 && (
        <div className="scan-banner warn">
          <strong>{totalThreats}</strong> file{totalThreats === 1 ? '' : 's'} flagged.
          Switch to <strong style={{ color: 'var(--cyan)' }}>FINDINGS</strong> to triage —
          anything you don't recognize can be quarantined in one click.
        </div>
      )}
      {isFinalized && progress.malicious > 0 && (
        <div className="scan-banner crit">
          <strong>⚠ {progress.malicious}</strong> MALICIOUS file
          {progress.malicious === 1 ? '' : 's'} confirmed by MalwareBazaar.
          Open <strong style={{ color: 'var(--cyan)' }}>FINDINGS</strong> and move them to
          the vault immediately.
        </div>
      )}
    </section>
  );
}

function SegmentedProgress({
  progress,
  severity,
  isDone,
}: {
  progress: ScanProgress;
  severity: 'ok' | 'warn' | 'crit';
  isDone: boolean;
}) {
  const pct = deriveProgressPct(progress);
  const on = Math.round((pct / 100) * PROG_SEGMENTS);
  const sevClass = severity === 'crit' ? 'crit' : severity === 'warn' ? 'warn' : '';
  return (
    <div
      className={`scan-prog ${isDone ? 'is-done' : ''}`}
      style={{ ['--segments' as unknown as string]: PROG_SEGMENTS } as CSSProperties}
      aria-label={`Scan progress ${pct}%`}
    >
      {Array.from({ length: PROG_SEGMENTS }, (_, i) => (
        <span
          key={i}
          className={`scan-prog-seg ${i < on ? `on ${sevClass}` : ''}`}
        />
      ))}
    </div>
  );
}

function VerdictCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'info' | 'warn' | 'crit';
}) {
  const active = value > 0;
  const color =
    tone === 'ok' ? 'var(--green)' :
    tone === 'info' ? 'var(--cyan)' :
    tone === 'warn' ? 'var(--amber)' :
    'var(--red)';
  const modifier = tone === 'warn' ? 'warn' : tone === 'crit' ? 'crit' : '';
  return (
    <div
      className={`scan-vstat ${active ? 'is-active' : ''} ${modifier}`}
      style={{ color }}
    >
      <span className="scan-vstat-label" style={{ color: 'var(--ink-dim)' }}>
        {label}
      </span>
      <span className="scan-vstat-value" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

type ThreatLevel = 'calm' | 'watch' | 'elevated' | 'critical';

function deriveThreatLevel(p: ScanProgress): ThreatLevel {
  if (p.malicious > 0) return 'critical';
  if (p.suspicious >= 3) return 'critical';
  if (p.suspicious > 0) return 'elevated';
  if (p.info >= 8) return 'watch';
  return 'calm';
}

function ThreatGauge({
  level,
  total,
  isDone,
}: {
  level: ThreatLevel;
  total: number;
  isDone: boolean;
}) {
  // Geometry: a 3/4 arc (270°) that fills proportionally to the threat
  // level. Sits inside a slowly-rotating tick ring and a sweeping radar
  // cone for "live scan" energy. All rotation is CSS-driven.
  const SIZE = 170;
  const CENTER = SIZE / 2;
  const R = 68;
  const CIRC = 2 * Math.PI * R;
  // Fill fraction maps level to arc length on the visible 3/4 arc.
  const fill =
    level === 'calm' ? 0.15 :
    level === 'watch' ? 0.40 :
    level === 'elevated' ? 0.72 :
    1.0;
  const visibleCirc = CIRC * 0.75;
  const dash = visibleCirc * fill;
  const gap = CIRC - dash;

  const color =
    level === 'calm' ? 'var(--green)' :
    level === 'watch' ? 'var(--cyan)' :
    level === 'elevated' ? 'var(--amber)' :
    'var(--red)';

  const label = level.toUpperCase();
  const threatActive = total > 0;

  // 16 tick marks around the outer rim.
  const ticks = Array.from({ length: 32 }, (_, i) => {
    const angle = (i / 32) * 2 * Math.PI;
    const inner = R + 6;
    const outer = R + (i % 4 === 0 ? 14 : 10);
    return {
      x1: CENTER + inner * Math.cos(angle),
      y1: CENTER + inner * Math.sin(angle),
      x2: CENTER + outer * Math.cos(angle),
      y2: CENTER + outer * Math.sin(angle),
      major: i % 4 === 0,
    };
  });

  return (
    <div className={`scan-gauge ${isDone ? 'is-done' : ''}`}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <defs>
          <radialGradient id="gauge-bg" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="rgba(57, 229, 255, 0.10)" />
            <stop offset="70%" stopColor="rgba(57, 229, 255, 0.03)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
          {/* Radar sweep — a gradient cone from a transparent tail to the
              active color head. Rotated via CSS. */}
          <linearGradient id="gauge-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={resolveVar(color)} stopOpacity={0} />
            <stop offset="100%" stopColor={resolveVar(color)} stopOpacity={0.55} />
          </linearGradient>
        </defs>

        {/* Inner radial glow */}
        <circle cx={CENTER} cy={CENTER} r={R - 6} fill="url(#gauge-bg)" />

        {/* Tick ring that spins slowly */}
        <g className="scan-gauge-ring-sweep">
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.major ? color : 'var(--line-soft)'}
              strokeWidth={t.major ? 1.4 : 1}
              opacity={t.major ? 0.85 : 0.45}
            />
          ))}
        </g>

        {/* Dashed inner reference ring */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R - 16}
          fill="none"
          stroke="var(--line-soft)"
          strokeWidth={1}
          strokeDasharray="2 4"
          opacity={0.6}
        />

        {/* Background arc (270°) */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R}
          fill="none"
          stroke="var(--line-soft)"
          strokeWidth={5}
          strokeDasharray={`${visibleCirc} ${CIRC}`}
          transform={`rotate(135 ${CENTER} ${CENTER})`}
          strokeLinecap="round"
        />
        {/* Filled arc */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={R}
          fill="none"
          stroke={color}
          strokeWidth={5}
          strokeDasharray={`${dash} ${gap}`}
          transform={`rotate(135 ${CENTER} ${CENTER})`}
          strokeLinecap="round"
          style={{
            filter: `drop-shadow(0 0 8px ${color})`,
            transition: 'stroke-dasharray 420ms ease, stroke 240ms ease',
          }}
        />

        {/* Radar sweep cone — only visible while scan is live (CSS hides it
            when the parent has .is-done). 90° wedge. */}
        <g className="scan-gauge-sweep" style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}>
          <path
            d={`M ${CENTER} ${CENTER} L ${CENTER + R} ${CENTER} A ${R} ${R} 0 0 1 ${CENTER} ${CENTER + R} Z`}
            fill={`url(#gauge-sweep)`}
          />
        </g>

        {/* Crosshair dot */}
        <circle cx={CENTER} cy={CENTER} r={1.8} fill={color} />
      </svg>

      <div className="scan-gauge-center">
        <div
          className={`scan-gauge-count ${threatActive ? 'is-threat' : ''}`}
          style={{ color }}
        >
          {total}
        </div>
        <div className="scan-gauge-label" style={{ color }}>
          {label}
        </div>
        <div className="scan-gauge-caption">THREAT LEVEL</div>
      </div>
    </div>
  );
}

// Map a CSS variable string to a canonical color. `drop-shadow(url(...))`
// can't reference CSS variables directly through an SVG `stop-color`, so we
// do one controlled alias here. Keep in sync with the theme palette in
// sunny.css.
function resolveVar(v: string): string {
  switch (v) {
    case 'var(--green)': return '#7dff9a';
    case 'var(--cyan)':  return '#39e5ff';
    case 'var(--amber)': return '#ffb347';
    case 'var(--red)':   return '#ff4d5e';
    default:             return v;
  }
}
