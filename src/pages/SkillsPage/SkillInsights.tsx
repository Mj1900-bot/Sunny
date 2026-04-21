/**
 * SkillInsights — analytics dashboard component for the Skills page.
 *
 * Shows:
 *  • Top 5 most-used skills (horizontal bar chart)
 *  • Stale skill warnings (not used in 30+ days)
 *  • Health distribution (green/amber/red breakdown)
 *  • Skill library growth indicator
 */

import { useMemo, type CSSProperties } from 'react';
import { Section, Chip, relTime } from '../_shared';
import type { ProceduralSkill } from './api';

type Props = {
  readonly skills: ReadonlyArray<ProceduralSkill>;
};

export function SkillInsights({ skills }: Props) {
  // Top 5 most-used
  const topUsed = useMemo(() => {
    return [...skills]
      .filter(s => s.uses_count > 0)
      .sort((a, b) => b.uses_count - a.uses_count)
      .slice(0, 5);
  }, [skills]);

  const maxUses = topUsed.length > 0 ? topUsed[0].uses_count : 1;

  // Stale skills (not used in 30+ days, or never used but created 7+ days ago)
  const staleSkills = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 2592000;
    return skills.filter(s => {
      if (s.last_used_at !== null && s.last_used_at < thirtyDaysAgo) return true;
      if (s.uses_count === 0) return true;
      return false;
    });
  }, [skills]);

  // Health distribution
  const healthDist = useMemo(() => {
    let green = 0;
    let amber = 0;
    let red = 0;
    let newCount = 0;
    for (const s of skills) {
      if (s.uses_count === 0) { newCount++; continue; }
      const rate = (s.success_count / s.uses_count) * 100;
      if (rate >= 80) green++;
      else if (rate >= 50) amber++;
      else red++;
    }
    return { green, amber, red, new: newCount };
  }, [skills]);

  const totalWithUses = healthDist.green + healthDist.amber + healthDist.red;

  if (skills.length === 0) return null;

  return (
    <Section title="INSIGHTS" right={`${skills.length} skills`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'fadeSlideIn 300ms ease-out' }}>
        {/* Health distribution bar */}
        <div>
          <div style={sectionLabel}>HEALTH DISTRIBUTION</div>
          <div style={{ display: 'flex', gap: 1, height: 8, borderRadius: 2, overflow: 'hidden', marginTop: 6 }}>
            {healthDist.green > 0 && (
              <div
                style={{
                  flex: healthDist.green,
                  background: 'var(--green)',
                  boxShadow: '0 0 6px var(--green)',
                }}
                title={`${healthDist.green} healthy (≥80%)`}
              />
            )}
            {healthDist.amber > 0 && (
              <div
                style={{
                  flex: healthDist.amber,
                  background: 'var(--amber)',
                  boxShadow: '0 0 6px var(--amber)',
                }}
                title={`${healthDist.amber} at risk (50-79%)`}
              />
            )}
            {healthDist.red > 0 && (
              <div
                style={{
                  flex: healthDist.red,
                  background: 'var(--red)',
                  boxShadow: '0 0 6px var(--red)',
                }}
                title={`${healthDist.red} failing (<50%)`}
              />
            )}
            {healthDist.new > 0 && (
              <div
                style={{
                  flex: healthDist.new,
                  background: 'var(--ink-dim)',
                }}
                title={`${healthDist.new} unused`}
              />
            )}
          </div>
          <div style={{
            display: 'flex', gap: 10, marginTop: 6,
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
          }}>
            <span><span style={{ color: 'var(--green)' }}>●</span> {healthDist.green} healthy</span>
            <span><span style={{ color: 'var(--amber)' }}>●</span> {healthDist.amber} at risk</span>
            <span><span style={{ color: 'var(--red)' }}>●</span> {healthDist.red} failing</span>
            <span><span style={{ color: 'var(--ink-dim)' }}>●</span> {healthDist.new} new</span>
          </div>
        </div>

        {/* Top 5 most-used */}
        {topUsed.length > 0 && (
          <div>
            <div style={sectionLabel}>MOST USED</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {topUsed.map((s, i) => {
                const pct = (s.uses_count / maxUses) * 100;
                const rate = s.uses_count > 0 ? (s.success_count / s.uses_count) * 100 : 0;
                const barColor = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--amber)' : 'var(--red)';
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={rankBadge}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: 'var(--ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {s.name}
                      </div>
                      {/* Bar */}
                      <div style={{ height: 4, background: 'rgba(57, 229, 255, 0.08)', borderRadius: 2, marginTop: 3 }}>
                        <div style={{
                          height: '100%',
                          width: `${pct}%`,
                          background: `linear-gradient(90deg, ${barColor}, ${barColor}99)`,
                          borderRadius: 2,
                          boxShadow: `0 0 4px ${barColor}`,
                          transition: 'width 500ms ease',
                        }} />
                      </div>
                    </div>
                    <span style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      fontWeight: 700,
                      color: barColor,
                      minWidth: 32,
                      textAlign: 'right',
                    }}>
                      {s.uses_count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Stale skill warnings */}
        {staleSkills.length > 0 && (
          <div>
            <div style={sectionLabel}>
              ATTENTION NEEDED
              <Chip tone="amber" style={{ marginLeft: 8 }}>{staleSkills.length}</Chip>
            </div>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginTop: 6,
              maxHeight: 120,
              overflow: 'auto',
            }}>
              {staleSkills.slice(0, 8).map(s => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '3px 8px',
                    borderLeft: '2px solid var(--amber)',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    color: 'var(--ink-dim)',
                  }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </span>
                  <span style={{ color: 'var(--amber)', flexShrink: 0 }}>
                    {s.uses_count === 0 ? 'never used' : s.last_used_at ? relTime(s.last_used_at) : 'stale'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Summary stats */}
        {totalWithUses > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 8,
          }}>
            <div style={summaryCell}>
              <span style={summaryLabel}>AVG SUCCESS</span>
              <span style={{
                ...summaryValue,
                color: skills.reduce((n, s) => n + s.success_count, 0) /
                  Math.max(1, skills.reduce((n, s) => n + s.uses_count, 0)) >= 0.7
                  ? 'var(--green)' : 'var(--amber)',
              }}>
                {(
                  (skills.reduce((n, s) => n + s.success_count, 0) /
                    Math.max(1, skills.reduce((n, s) => n + s.uses_count, 0))) * 100
                ).toFixed(0)}%
              </span>
            </div>
            <div style={summaryCell}>
              <span style={summaryLabel}>TOTAL INVOCATIONS</span>
              <span style={{ ...summaryValue, color: 'var(--cyan)' }}>
                {skills.reduce((n, s) => n + s.uses_count, 0)}
              </span>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const sectionLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 8,
  letterSpacing: '0.24em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
};

const rankBadge: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--cyan)',
  border: '1px solid var(--line-soft)',
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'rgba(57, 229, 255, 0.06)',
};

const summaryCell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(6, 14, 22, 0.5)',
};

const summaryLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 7,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  fontWeight: 700,
};

const summaryValue: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 18,
  fontWeight: 700,
};
