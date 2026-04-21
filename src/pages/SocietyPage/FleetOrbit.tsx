/**
 * FleetOrbit — radial visualization of live sub-agents arranged in
 * concentric orbits around a central "SUNNY" core. Running agents pulse,
 * done agents are static, errored agents glow red. Depth is encoded by
 * ring distance (children orbit further from centre).
 */

import type { SubAgent } from '../../store/subAgentsLive';

const SIZE = 220;
const CX = SIZE / 2;
const CY = SIZE / 2;

const ROLE_HUE: Record<string, number> = {
  researcher: 200,   // cyan
  summarizer: 205,
  coder: 140,         // green
  browser_driver: 280, // violet
  writer: 320,        // pink
  planner: 45,        // gold
  critic: 35,         // amber
  unknown: 190,       // teal
};

function statusColor(s: SubAgent['status']): string {
  if (s === 'running') return 'var(--green)';
  if (s === 'error') return 'var(--red)';
  return 'var(--violet)';
}

export function FleetOrbit({ agents }: { agents: ReadonlyArray<SubAgent> }) {
  if (agents.length === 0) return null;

  // Sort: running first, then by start time
  const sorted = [...agents].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return a.startedAt - b.startedAt;
  });

  // Arrange around concentric rings
  const roots = sorted.filter(a => !a.parentId);
  const children = sorted.filter(a => a.parentId);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
      <svg
        width={SIZE} height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ display: 'block' }}
      >
        {/* Orbit rings */}
        {[50, 80].map(r => (
          <circle
            key={r}
            cx={CX} cy={CY} r={r}
            fill="none"
            stroke="rgba(57, 229, 255, 0.06)"
            strokeWidth={0.8}
            strokeDasharray="3,4"
          />
        ))}

        {/* Centre core */}
        <circle
          cx={CX} cy={CY} r={18}
          fill="rgba(57, 229, 255, 0.08)"
          stroke="var(--cyan)"
          strokeWidth={1.5}
          style={{ filter: 'drop-shadow(0 0 6px var(--cyan))' }}
        />
        <text
          x={CX} y={CY}
          textAnchor="middle" dominantBaseline="central"
          style={{
            fontFamily: 'var(--display)', fontSize: 7,
            fill: 'var(--cyan)', letterSpacing: '0.22em', fontWeight: 700,
          }}
        >
          SUNNY
        </text>

        {/* Root agents on inner ring */}
        {roots.map((a, i) => {
          const angle = (i / Math.max(1, roots.length)) * 2 * Math.PI - Math.PI / 2;
          const r = 50;
          const x = CX + r * Math.cos(angle);
          const y = CY + r * Math.sin(angle);
          const hue = ROLE_HUE[a.role] ?? 190;
          const color = statusColor(a.status);
          const dotR = a.status === 'running' ? 7 : 5;

          return (
            <g key={a.id}>
              {/* Connecting line to core */}
              <line
                x1={CX} y1={CY} x2={x} y2={y}
                stroke={`hsla(${hue}, 50%, 50%, 0.15)`}
                strokeWidth={0.6}
              />
              {/* Agent dot */}
              <circle
                cx={x} cy={y} r={dotR}
                fill={`hsla(${hue}, 60%, 50%, 0.3)`}
                stroke={color}
                strokeWidth={1.5}
                style={{
                  filter: a.status === 'running'
                    ? `drop-shadow(0 0 6px ${color})`
                    : 'none',
                  animation: a.status === 'running'
                    ? 'pulseDot 2s ease-in-out infinite'
                    : undefined,
                }}
              >
                <title>{`${a.role} · ${a.status} · ${a.task.slice(0, 80)}`}</title>
              </circle>
              {/* Role label */}
              <text
                x={x} y={y + dotR + 9}
                textAnchor="middle"
                style={{
                  fontFamily: 'var(--mono)', fontSize: 6.5,
                  fill: 'var(--ink-dim)',
                }}
              >
                {a.role.slice(0, 8)}
              </text>
            </g>
          );
        })}

        {/* Child agents on outer ring */}
        {children.map((a, i) => {
          const angle = (i / Math.max(1, children.length)) * 2 * Math.PI - Math.PI / 2 + 0.3;
          const r = 80;
          const x = CX + r * Math.cos(angle);
          const y = CY + r * Math.sin(angle);
          const hue = ROLE_HUE[a.role] ?? 190;
          const color = statusColor(a.status);

          // Find parent position for connector
          const parentIdx = roots.findIndex(p => p.id === a.parentId);
          const pAngle = parentIdx >= 0
            ? (parentIdx / Math.max(1, roots.length)) * 2 * Math.PI - Math.PI / 2
            : 0;
          const px = CX + 50 * Math.cos(pAngle);
          const py = CY + 50 * Math.sin(pAngle);

          return (
            <g key={a.id}>
              {parentIdx >= 0 && (
                <line
                  x1={px} y1={py} x2={x} y2={y}
                  stroke={`hsla(${hue}, 40%, 50%, 0.12)`}
                  strokeWidth={0.5}
                  strokeDasharray="2,3"
                />
              )}
              <circle
                cx={x} cy={y} r={4}
                fill={`hsla(${hue}, 60%, 50%, 0.25)`}
                stroke={color}
                strokeWidth={1}
                style={{
                  filter: a.status === 'running'
                    ? `drop-shadow(0 0 4px ${color})`
                    : 'none',
                  animation: a.status === 'running'
                    ? 'pulseDot 2s ease-in-out infinite'
                    : undefined,
                }}
              >
                <title>{`${a.role} (child) · ${a.status} · ${a.task.slice(0, 80)}`}</title>
              </circle>
            </g>
          );
        })}

        {/* Legend */}
        <text
          x={SIZE - 4} y={SIZE - 4}
          textAnchor="end"
          style={{
            fontFamily: 'var(--mono)', fontSize: 7,
            fill: 'var(--ink-dim)', opacity: 0.6,
          }}
        >
          {agents.length} agent{agents.length !== 1 ? 's' : ''}
        </text>
      </svg>
    </div>
  );
}
