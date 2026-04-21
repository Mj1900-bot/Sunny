/**
 * BrainHealth — quick-glance health summary for the Brain page header.
 * Shows overall system health as a multi-dimensional gauge.
 */

import { ProgressRing, Chip } from '../_shared';

export type HealthInputs = {
  toolSuccessRate: number;  // 0..100
  cacheHitRate: number;     // 0..100
  memoryRows: number;
  modelActive: boolean;
  worldOnline: boolean;
};

function scoreHealth(inputs: HealthInputs): { score: number; issues: string[] } {
  const issues: string[] = [];
  let total = 0;
  let weight = 0;

  // Tool success (weight 3)
  if (inputs.toolSuccessRate >= 0) {
    total += (inputs.toolSuccessRate / 100) * 3;
    weight += 3;
    if (inputs.toolSuccessRate < 70) issues.push(`Tool success low (${inputs.toolSuccessRate.toFixed(0)}%)`);
  }

  // Cache efficiency (weight 2)
  if (inputs.cacheHitRate >= 0) {
    total += (inputs.cacheHitRate / 100) * 2;
    weight += 2;
    if (inputs.cacheHitRate < 30) issues.push(`Cache hit rate low (${inputs.cacheHitRate.toFixed(0)}%)`);
  }

  // Memory populated (weight 1)
  const memScore = Math.min(1, inputs.memoryRows / 100);
  total += memScore;
  weight += 1;
  if (inputs.memoryRows === 0) issues.push('No memories stored');

  // Model active (weight 2)
  total += inputs.modelActive ? 2 : 0;
  weight += 2;
  if (!inputs.modelActive) issues.push('No model selected');

  // World online (weight 1)
  total += inputs.worldOnline ? 1 : 0;
  weight += 1;
  if (!inputs.worldOnline) issues.push('World model offline');

  return { score: weight > 0 ? total / weight : 0, issues };
}

function healthLabel(score: number): string {
  if (score >= 0.9) return 'EXCELLENT';
  if (score >= 0.7) return 'HEALTHY';
  if (score >= 0.5) return 'FAIR';
  if (score >= 0.3) return 'DEGRADED';
  return 'CRITICAL';
}

function healthTone(score: number): 'green' | 'cyan' | 'amber' | 'red' {
  if (score >= 0.8) return 'green';
  if (score >= 0.6) return 'cyan';
  if (score >= 0.4) return 'amber';
  return 'red';
}

export function BrainHealth({ inputs }: { inputs: HealthInputs }) {
  const { score, issues } = scoreHealth(inputs);
  const tone = healthTone(score);
  const label = healthLabel(score);

  return (
    <div style={{
      display: 'flex', gap: 16, alignItems: 'center',
      padding: '12px 16px',
      border: '1px solid var(--line-soft)',
      borderLeft: `3px solid var(--${tone})`,
      background: `linear-gradient(135deg, var(--${tone})08, transparent 60%)`,
    }}>
      <ProgressRing progress={score} size={56} stroke={5} tone={tone}>
        <span style={{
          fontFamily: 'var(--display)', fontSize: 13, fontWeight: 800,
          color: `var(--${tone})`, letterSpacing: '0.04em',
        }}>
          {Math.round(score * 100)}
        </span>
      </ProgressRing>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Chip tone={tone}>{label}</Chip>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
          }}>brain health composite</span>
        </div>

        {issues.length > 0 ? (
          <div style={{
            display: 'flex', gap: 6, flexWrap: 'wrap',
          }}>
            {issues.map(issue => (
              <span
                key={issue}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 9,
                  color: 'var(--amber)', padding: '1px 6px',
                  border: '1px solid var(--amber)33',
                  background: 'rgba(255, 200, 0, 0.04)',
                }}
              >
                ⚠ {issue}
              </span>
            ))}
          </div>
        ) : (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)',
          }}>
            All systems nominal
          </span>
        )}

        {/* Mini dimension bars */}
        <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
          {[
            { label: 'TOOLS', pct: inputs.toolSuccessRate },
            { label: 'CACHE', pct: inputs.cacheHitRate },
            { label: 'MEM',   pct: Math.min(100, (inputs.memoryRows / 100) * 100) },
          ].map(d => (
            <div key={d.label} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 7, letterSpacing: '0.2em',
                color: 'var(--ink-dim)', fontWeight: 700,
              }}>{d.label}</span>
              <div style={{
                width: 44, height: 3,
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, d.pct))}%`,
                  background: `var(--${healthTone(d.pct / 100)})`,
                  transition: 'width 400ms ease',
                }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
