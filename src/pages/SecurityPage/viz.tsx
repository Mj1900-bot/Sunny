/**
 * Reusable visualisations for the Security module.
 *
 * Everything here is an inline <svg> — no d3, no charting library —
 * so the Security page stays lazy-loadable and fully self-contained.
 *
 * Components:
 *   - <ThreatGauge /> — big radial 0-100 threat score with gradient
 *     fill, radar sweep, and animated tick ring.  Same visual vocab
 *     as the ScanPage gauge but tuned for continuous scores.
 *   - <Sparkline /> — minute-bucket line+area chart.
 *   - <TimelineBar /> — 60-minute severity banding strip.
 *   - <HostFlow /> — bar-style per-host rollup for Overview.
 */

import { useMemo, type CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// ThreatGauge
// ---------------------------------------------------------------------------

export function ThreatGauge({
  score,
  panicMode,
  size = 200,
}: {
  score: number;
  panicMode?: boolean;
  size?: number;
}) {
  const center = size / 2;
  const r = size * 0.38;
  const circ = 2 * Math.PI * r;
  // 270° visible arc (three-quarters).
  const visibleCirc = circ * 0.75;
  const clamped = Math.max(0, Math.min(100, score));
  const fill = visibleCirc * (clamped / 100);
  const gap = circ - fill;

  const color = panicMode
    ? 'var(--red)'
    : clamped >= 75 ? 'var(--red)'
    : clamped >= 45 ? 'var(--amber)'
    : clamped >= 20 ? 'var(--cyan)'
    : 'var(--green)';

  const resolvedColor = resolveVar(color);

  const ticks = useMemo(
    () =>
      Array.from({ length: 32 }, (_, i) => {
        const angle = (i / 32) * 2 * Math.PI;
        const inner = r + 6;
        const outer = r + (i % 4 === 0 ? 14 : 10);
        return {
          x1: center + inner * Math.cos(angle),
          y1: center + inner * Math.sin(angle),
          x2: center + outer * Math.cos(angle),
          y2: center + outer * Math.sin(angle),
          major: i % 4 === 0,
        };
      }),
    [center, r],
  );

  return (
    <div className={`scan-gauge ${panicMode ? '' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <radialGradient id="tg-bg" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor={`${resolvedColor}26`} />
            <stop offset="70%" stopColor={`${resolvedColor}0a`} />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
          <linearGradient id="tg-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={resolvedColor} stopOpacity={0} />
            <stop offset="100%" stopColor={resolvedColor} stopOpacity={0.55} />
          </linearGradient>
        </defs>

        <circle cx={center} cy={center} r={r - 6} fill="url(#tg-bg)" />

        <g className="scan-gauge-ring-sweep">
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.major ? resolvedColor : 'var(--line-soft)'}
              strokeWidth={t.major ? 1.4 : 1}
              opacity={t.major ? 0.85 : 0.45}
            />
          ))}
        </g>

        <circle
          cx={center}
          cy={center}
          r={r - 16}
          fill="none"
          stroke="var(--line-soft)"
          strokeWidth={1}
          strokeDasharray="2 4"
          opacity={0.6}
        />

        {/* background arc */}
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke="var(--line-soft)"
          strokeWidth={6}
          strokeDasharray={`${visibleCirc} ${circ}`}
          transform={`rotate(135 ${center} ${center})`}
          strokeLinecap="round"
        />
        {/* filled arc */}
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={resolvedColor}
          strokeWidth={6}
          strokeDasharray={`${fill} ${gap}`}
          transform={`rotate(135 ${center} ${center})`}
          strokeLinecap="round"
          style={{
            filter: `drop-shadow(0 0 10px ${resolvedColor})`,
            transition: 'stroke-dasharray 500ms ease, stroke 300ms ease',
          }}
        />

        {/* Radar sweep wedge */}
        <g className="scan-gauge-sweep" style={{ transformOrigin: `${center}px ${center}px` }}>
          <path
            d={`M ${center} ${center} L ${center + r} ${center} A ${r} ${r} 0 0 1 ${center} ${center + r} Z`}
            fill="url(#tg-sweep)"
          />
        </g>

        <circle cx={center} cy={center} r={2.2} fill={resolvedColor} />
      </svg>

      <div className="scan-gauge-center">
        <div
          className={`scan-gauge-count ${panicMode ? 'is-threat' : ''}`}
          style={{ color: resolvedColor, fontSize: panicMode ? 26 : 36 }}
        >
          {panicMode ? 'PANIC' : clamped}
        </div>
        <div className="scan-gauge-label" style={{ color: resolvedColor }}>
          {panicMode ? 'ARMED' : clamped >= 75 ? 'CRITICAL' : clamped >= 45 ? 'ELEVATED' : clamped >= 20 ? 'WATCH' : 'CALM'}
        </div>
        <div className="scan-gauge-caption">THREAT SCORE</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export function Sparkline({
  data,
  width = 240,
  height = 48,
  stroke = 'var(--cyan)',
  fill = 'rgba(57, 229, 255, 0.16)',
  baseline = true,
}: {
  data: ReadonlyArray<number>;
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  baseline?: boolean;
}) {
  const { path, area, max, latest } = useMemo(() => {
    const n = data.length || 1;
    const max = Math.max(1, ...data);
    const stepX = width / Math.max(1, n - 1);
    const toY = (v: number) => height - (v / max) * (height - 4) - 2;
    const pts = data.map((v, i) => `${(i * stepX).toFixed(2)},${toY(v).toFixed(2)}`);
    const path = pts.length ? `M ${pts.join(' L ')}` : '';
    const area =
      pts.length
        ? `M 0,${height} L ${pts.join(' L ')} L ${width},${height} Z`
        : '';
    const latest = data[data.length - 1] ?? 0;
    return { path, area, max, latest };
  }, [data, width, height]);

  const strokeColor = resolveVar(stroke);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {baseline && (
        <line
          x1="0"
          y1={height - 2}
          x2={width}
          y2={height - 2}
          stroke="var(--line-soft)"
          strokeDasharray="2 3"
          opacity="0.5"
        />
      )}
      {area && <path d={area} fill={fill} />}
      {path && <path d={path} fill="none" stroke={strokeColor} strokeWidth="1.4" />}
      {/* End-of-series dot */}
      {data.length > 0 && (
        <circle
          cx={width}
          cy={height - ((latest / max) * (height - 4) + 2)}
          r={2.2}
          fill={strokeColor}
          style={{ filter: `drop-shadow(0 0 4px ${strokeColor})` }}
        />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// TimelineBar — 60 minute activity map coloured by severity proxy.
// Each 1-minute cell is a short vertical bar; the intensity is scaled
// by event count and the tint is red/amber/green based on whether any
// warn/crit events landed in that minute (inferred by the caller).
// ---------------------------------------------------------------------------

export type TimelineCell = {
  readonly events: number;
  readonly warn: number;
  readonly crit: number;
};

export function TimelineBar({
  cells,
  width = 480,
  height = 36,
}: {
  cells: ReadonlyArray<TimelineCell>;
  width?: number;
  height?: number;
}) {
  const n = cells.length || 1;
  const colWidth = width / n;
  const max = Math.max(1, ...cells.map(c => c.events));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <line
        x1="0"
        y1={height - 1}
        x2={width}
        y2={height - 1}
        stroke="var(--line-soft)"
        opacity="0.5"
      />
      {cells.map((c, i) => {
        const tone =
          c.crit > 0 ? 'var(--red)'
          : c.warn > 0 ? 'var(--amber)'
          : c.events > 0 ? 'var(--cyan)'
          : 'var(--ink-dim)';
        const color = resolveVar(tone);
        const barH = c.events === 0 ? 2 : (c.events / max) * (height - 4) + 3;
        const x = i * colWidth;
        const y = height - barH - 1;
        return (
          <rect
            key={i}
            x={x + 0.2}
            y={y}
            width={Math.max(1, colWidth - 0.4)}
            height={barH}
            fill={color}
            opacity={c.events === 0 ? 0.15 : 0.85}
          />
        );
      })}
      {/* tick marks at 15/30/45 min */}
      {[0.25, 0.5, 0.75].map((f, i) => (
        <line
          key={i}
          x1={width * f}
          y1="0"
          x2={width * f}
          y2={height}
          stroke="var(--line-soft)"
          strokeDasharray="2 4"
          opacity="0.35"
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// PostureGrade — large letter grade with a small blurb.  A-F scale,
// independent of threat score.  Driven by: integrity rows + policy
// hardening + user's confirm participation + enforcement mode.
// ---------------------------------------------------------------------------

export function PostureGrade({
  score,
  breakdown,
}: {
  score: number;
  breakdown: ReadonlyArray<{ label: string; value: number; max: number }>;
}) {
  const s = Math.max(0, Math.min(100, score));
  const grade =
    s >= 92 ? 'A' :
    s >= 82 ? 'B' :
    s >= 70 ? 'C' :
    s >= 55 ? 'D' :
    s >= 40 ? 'E' : 'F';
  const color =
    grade === 'A' ? 'var(--green)' :
    grade === 'B' ? 'var(--green)' :
    grade === 'C' ? 'var(--cyan)' :
    grade === 'D' ? 'var(--amber)' :
    grade === 'E' ? 'var(--amber)' : 'var(--red)';
  const resolvedColor = resolveVar(color);
  return (
    <div
      style={{
        border: `1px solid ${resolvedColor}44`,
        background: `linear-gradient(135deg, ${resolvedColor}18, rgba(4, 10, 16, 0.5))`,
        padding: '12px 16px',
        display: 'grid',
        gridTemplateColumns: '90px 1fr',
        gap: 14,
        alignItems: 'center',
      }}
      title={`Posture score ${s}/100`}
    >
      <div
        style={{
          fontFamily: "'Orbitron', var(--mono)",
          fontSize: 64,
          lineHeight: 1,
          fontWeight: 800,
          color: resolvedColor,
          textShadow: `0 0 18px ${resolvedColor}55`,
          textAlign: 'center',
        }}
      >
        {grade}
      </div>
      <div>
        <div
          style={{
            fontFamily: "'Orbitron', var(--mono)",
            fontSize: 10,
            letterSpacing: '0.24em',
            color: resolvedColor,
            fontWeight: 700,
            marginBottom: 8,
          }}
        >
          POSTURE · {s}/100
        </div>
        <div style={{ display: 'grid', gap: 3 }}>
          {breakdown.map(b => (
            <div key={b.label} style={{
              display: 'grid',
              gridTemplateColumns: '130px 1fr 40px',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--mono)',
              fontSize: 10,
            }}>
              <span style={{ color: 'var(--ink-dim)', letterSpacing: '0.12em' }}>
                {b.label}
              </span>
              <div style={{
                height: 4,
                background: 'rgba(255,255,255,0.05)',
                position: 'relative',
                overflow: 'hidden',
              }}>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: `${Math.max(1, Math.round((b.value / b.max) * 100))}%`,
                    background: resolvedColor,
                    opacity: 0.8,
                  }}
                />
              </div>
              <span style={{ color: 'var(--ink)', textAlign: 'right', fontSize: 9.5 }}>
                {b.value}/{b.max}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FlowDiagram — mini sankey (initiator → host) rendered as inline SVG.
// Left column = initiators, right column = hosts; the ribbons between
// them have width proportional to bytes.  Pure SVG, no d3.
// ---------------------------------------------------------------------------

export type FlowEdge = {
  readonly from: string;
  readonly to: string;
  readonly bytes: number;
  readonly count: number;
};

export function FlowDiagram({
  edges,
  width = 920,
  height = 240,
}: {
  edges: ReadonlyArray<FlowEdge>;
  width?: number;
  height?: number;
}) {
  if (edges.length === 0) {
    return (
      <div style={{
        border: '1px dashed var(--line-soft)',
        padding: '40px 20px',
        textAlign: 'center',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-dim)',
      }}>
        No egress flow observed yet.
      </div>
    );
  }

  // Build two column tables (initiators, hosts) with total-byte
  // weights; we layout each column proportional to its weight.
  const initiators = aggregate(edges, e => e.from);
  const hosts = aggregate(edges, e => e.to);
  const leftTotal = initiators.reduce((n, a) => n + a.bytes, 0);
  const rightTotal = hosts.reduce((n, a) => n + a.bytes, 0);
  const scale = (n: number, tot: number) => (tot === 0 ? 0 : (n / tot) * (height - 20));

  const leftCol = layoutColumn(initiators, (n) => scale(n, leftTotal));
  const rightCol = layoutColumn(hosts, (n) => scale(n, rightTotal));
  const leftX = 160;
  const rightX = width - 160;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {edges.map((e, i) => {
        const src = leftCol.find(c => c.key === e.from);
        const dst = rightCol.find(c => c.key === e.to);
        if (!src || !dst) return null;
        const w1 = scale(e.bytes, leftTotal);
        const w2 = scale(e.bytes, rightTotal);
        // Midpoints for the bezier control points.
        const y1 = src.y + src.used + w1 / 2;
        const y2 = dst.y + dst.used + w2 / 2;
        src.used += w1;
        dst.used += w2;
        const midX = (leftX + rightX) / 2;
        const path = `M ${leftX + 4} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${rightX - 4} ${y2}`;
        const color = flowColor(e.from);
        const resolved = resolveVar(color);
        return (
          <path
            key={i}
            d={path}
            stroke={resolved}
            strokeOpacity={0.55}
            strokeWidth={Math.max(1.4, Math.min(w1, w2))}
            fill="none"
          />
        );
      })}
      {leftCol.map(c => (
        <g key={`l-${c.key}`}>
          <rect x={leftX - 4} y={c.y} width={4} height={c.height} fill={resolveVar(flowColor(c.key))} opacity={0.85} />
          <text
            x={leftX - 12}
            y={c.y + c.height / 2 + 3}
            fontFamily="var(--mono)"
            fontSize="10"
            fill="currentColor"
            textAnchor="end"
            style={{ color: 'var(--ink)' }}
          >
            {truncate(c.key, 22)}
          </text>
          <text
            x={leftX - 12}
            y={c.y + c.height / 2 + 14}
            fontFamily="var(--mono)"
            fontSize="8"
            fill="var(--ink-dim)"
            textAnchor="end"
          >
            {formatBytes(c.bytes)}
          </text>
        </g>
      ))}
      {rightCol.map(c => (
        <g key={`r-${c.key}`}>
          <rect x={rightX} y={c.y} width={4} height={c.height} fill="var(--cyan)" opacity={0.85} />
          <text
            x={rightX + 10}
            y={c.y + c.height / 2 + 3}
            fontFamily="var(--mono)"
            fontSize="10"
            fill="currentColor"
            textAnchor="start"
            style={{ color: 'var(--ink)' }}
          >
            {truncate(c.key || '(unknown)', 26)}
          </text>
          <text
            x={rightX + 10}
            y={c.y + c.height / 2 + 14}
            fontFamily="var(--mono)"
            fontSize="8"
            fill="var(--ink-dim)"
            textAnchor="start"
          >
            {formatBytes(c.bytes)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function aggregate(
  edges: ReadonlyArray<FlowEdge>,
  key: (e: FlowEdge) => string,
): Array<{ key: string; bytes: number; count: number }> {
  const m = new Map<string, { bytes: number; count: number }>();
  for (const e of edges) {
    const k = key(e);
    const cur = m.get(k) ?? { bytes: 0, count: 0 };
    cur.bytes += e.bytes;
    cur.count += e.count;
    m.set(k, cur);
  }
  return Array.from(m.entries())
    .map(([key, v]) => ({ key, bytes: v.bytes, count: v.count }))
    .sort((a, b) => b.bytes - a.bytes);
}

function layoutColumn<T extends { key: string; bytes: number }>(
  items: Array<T>,
  scale: (n: number) => number,
): Array<T & { y: number; height: number; used: number }> {
  const gap = 8;
  let y = 10;
  const out: Array<T & { y: number; height: number; used: number }> = [];
  for (const it of items) {
    const h = Math.max(10, scale(it.bytes));
    out.push({ ...it, y, height: h, used: 0 });
    y += h + gap;
  }
  return out;
}

function flowColor(initiator: string): string {
  if (initiator.startsWith('agent:sub:')) return 'var(--violet)';
  if (initiator.startsWith('agent:')) return 'var(--amber)';
  if (initiator === 'unknown') return 'var(--ink-dim)';
  return 'var(--green)';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// HostFlow — vertical bar list of top hosts by bytes/count.
// ---------------------------------------------------------------------------

export function HostFlow({
  hosts,
}: {
  hosts: ReadonlyArray<{ host: string; count: number; bytes: number }>;
}) {
  const maxBytes = Math.max(1, ...hosts.map(h => h.bytes));
  const style: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr 90px 100px',
    gap: 8,
    alignItems: 'center',
    padding: '5px 8px',
    border: '1px solid var(--line-soft)',
    background: 'rgba(4, 10, 16, 0.5)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    position: 'relative',
    overflow: 'hidden',
  };
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {hosts.length === 0 && (
        <div style={{ ...style, color: 'var(--ink-dim)' }}>No egress in the last hour.</div>
      )}
      {hosts.map(h => {
        const pct = (h.bytes / maxBytes) * 100;
        return (
          <div key={h.host} style={style}>
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                width: `${Math.max(2, pct)}%`,
                background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.18), transparent)',
                pointerEvents: 'none',
              }}
            />
            <span style={{ color: 'var(--ink)', position: 'relative', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {h.host || '(no host)'}
            </span>
            <span style={{ color: 'var(--ink-dim)', textAlign: 'right', position: 'relative' }}>
              {h.count} req
            </span>
            <span style={{ color: 'var(--cyan)', textAlign: 'right', position: 'relative', fontWeight: 600 }}>
              {formatBytes(h.bytes)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventBreakdown — horizontal bar chart of event counts by kind.
// ---------------------------------------------------------------------------

export function EventBreakdown({
  rows,
}: {
  rows: ReadonlyArray<{ kind: string; count: number; severity: 'info' | 'warn' | 'crit' }>;
}) {
  if (rows.length === 0) {
    return (
      <div style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-dim)',
        padding: '20px 10px',
      }}>
        No events in window yet.
      </div>
    );
  }
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      {rows.map(r => {
        const tone =
          r.severity === 'crit' ? 'var(--red)' :
          r.severity === 'warn' ? 'var(--amber)' :
          'var(--cyan)';
        const width = Math.max(1, Math.round((r.count / max) * 100));
        return (
          <div
            key={r.kind}
            style={{
              display: 'grid',
              gridTemplateColumns: '150px 1fr 40px',
              gap: 10,
              alignItems: 'center',
              fontFamily: 'var(--mono)',
              fontSize: 10,
            }}
          >
            <span style={{ color: 'var(--ink-dim)', letterSpacing: '0.12em' }}>
              {r.kind.replace(/_/g, ' ')}
            </span>
            <div style={{ height: 6, background: 'rgba(255,255,255,0.04)', position: 'relative' }}>
              <div style={{
                position: 'absolute',
                inset: 0,
                width: `${width}%`,
                background: tone,
                opacity: 0.85,
              }} />
            </div>
            <span style={{ color: 'var(--ink)', textAlign: 'right' }}>{r.count}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (!n) return '0';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/** Resolve a subset of CSS variables to canonical colors so inline
 *  SVG filters (drop-shadow) can reference them.  Keep in sync with
 *  the theme palette. */
function resolveVar(v: string): string {
  switch (v) {
    case 'var(--green)': return '#7dff9a';
    case 'var(--cyan)':  return '#39e5ff';
    case 'var(--amber)': return '#ffb347';
    case 'var(--red)':   return '#ff4d5e';
    case 'var(--violet)': return '#c69bff';
    case 'var(--ink-dim)': return '#6b7a8a';
    default:             return v;
  }
}
