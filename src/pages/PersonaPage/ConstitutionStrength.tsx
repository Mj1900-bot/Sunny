/**
 * ConstitutionStrength — visual gauge showing how "complete" the
 * constitution is, based on identity fields filled, values count,
 * and prohibitions. Gives the user a sense of progress.
 */

import { ProgressRing, Chip } from '../_shared';
import type { Constitution } from './api';

type Metric = {
  label: string;
  score: number;     // 0..1
  detail: string;
  tone: 'cyan' | 'gold' | 'red' | 'green' | 'amber';
};

function getMetrics(c: Constitution): Metric[] {
  const identity = c.identity;
  const idScore = [
    identity.name.trim() ? 0.4 : 0,
    identity.operator.trim() ? 0.3 : 0,
    identity.voice.trim() ? 0.3 : 0,
  ].reduce((a, b) => a + b, 0);

  const valScore = Math.min(1, c.values.length / 5);
  const prohScore = Math.min(1, c.prohibitions.length / 3);

  return [
    {
      label: 'IDENTITY',
      score: idScore,
      detail: `${[identity.name, identity.operator, identity.voice].filter(s => s.trim()).length}/3 fields`,
      tone: 'cyan',
    },
    {
      label: 'VALUES',
      score: valScore,
      detail: `${c.values.length} defined`,
      tone: 'gold',
    },
    {
      label: 'GUARDRAILS',
      score: prohScore,
      detail: `${c.prohibitions.length} rules`,
      tone: 'red',
    },
  ];
}

function overallScore(metrics: Metric[]): number {
  return metrics.reduce((sum, m) => sum + m.score, 0) / metrics.length;
}

function strengthLabel(score: number): string {
  if (score >= 0.9) return 'FULLY CONFIGURED';
  if (score >= 0.7) return 'WELL DEFINED';
  if (score >= 0.4) return 'PARTIALLY SET';
  return 'NEEDS ATTENTION';
}

function strengthTone(score: number): 'green' | 'amber' | 'red' | 'cyan' {
  if (score >= 0.9) return 'green';
  if (score >= 0.7) return 'cyan';
  if (score >= 0.4) return 'amber';
  return 'red';
}

export function ConstitutionStrength({ constitution }: { constitution: Constitution }) {
  const metrics = getMetrics(constitution);
  const overall = overallScore(metrics);
  const tone = strengthTone(overall);
  const label = strengthLabel(overall);

  return (
    <div style={{
      display: 'flex', gap: 20, alignItems: 'center',
      padding: '12px 16px',
      border: '1px solid var(--line-soft)',
      borderLeft: `3px solid var(--${tone})`,
      background: `linear-gradient(135deg, var(--${tone})08, transparent 60%)`,
    }}>
      {/* Overall ring */}
      <ProgressRing
        progress={overall}
        size={64}
        stroke={5}
        tone={tone}
      >
        <span style={{
          fontFamily: 'var(--display)', fontSize: 14, fontWeight: 800,
          color: `var(--${tone})`, letterSpacing: '0.04em',
        }}>
          {Math.round(overall * 100)}%
        </span>
      </ProgressRing>

      {/* Breakdown */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Chip tone={tone}>{label}</Chip>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
          }}>
            constitution strength
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {metrics.map(m => (
            <div key={m.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{
                fontFamily: 'var(--display)', fontSize: 7, letterSpacing: '0.22em',
                color: `var(--${m.tone})`, fontWeight: 700,
              }}>{m.label}</span>
              {/* Mini bar */}
              <div style={{
                width: 60, height: 4,
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${Math.round(m.score * 100)}%`,
                  background: `var(--${m.tone})`,
                  boxShadow: `0 0 4px var(--${m.tone})`,
                  transition: 'width 400ms ease',
                }} />
              </div>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--ink-dim)',
              }}>{m.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
