/**
 * RoleDistribution — a horizontal stacked bar + legend showing the
 * distribution of fleet agents across roles. Also shows a mini pie
 * breakdown of status (running/done/error).
 */

import { useMemo } from 'react';
import { Chip } from '../_shared';
import type { SubAgent, SubAgentRole } from '../../store/subAgentsLive';

const ROLE_COLORS: Record<SubAgentRole, string> = {
  researcher: 'var(--cyan)',
  summarizer: 'var(--teal)',
  coder: 'var(--green)',
  browser_driver: 'var(--violet)',
  writer: 'var(--pink)',
  planner: 'var(--gold)',
  critic: 'var(--amber)',
  unknown: 'var(--ink-dim)',
};

type RoleStat = { role: SubAgentRole; count: number; pct: number };

export function RoleDistribution({ agents }: { agents: ReadonlyArray<SubAgent> }) {
  const roleStats = useMemo<RoleStat[]>(() => {
    const map = new Map<SubAgentRole, number>();
    for (const a of agents) {
      map.set(a.role, (map.get(a.role) ?? 0) + 1);
    }
    const total = Math.max(1, agents.length);
    return Array.from(map.entries())
      .map(([role, count]) => ({ role, count, pct: (count / total) * 100 }))
      .sort((a, b) => b.count - a.count);
  }, [agents]);

  const statusCounts = useMemo(() => {
    let running = 0, done = 0, errored = 0;
    for (const a of agents) {
      if (a.status === 'running') running++;
      else if (a.status === 'done') done++;
      else errored++;
    }
    return { running, done, errored };
  }, [agents]);

  if (agents.length === 0) {
    return (
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
        padding: '8px 0', textAlign: 'center',
      }}>
        No agents spawned yet
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Stacked bar */}
      <div style={{
        height: 10, display: 'flex', overflow: 'hidden',
        border: '1px solid var(--line-soft)',
        background: 'rgba(0,0,0,0.3)',
      }}>
        {roleStats.map(s => (
          <div
            key={s.role}
            title={`${s.role}: ${s.count} (${s.pct.toFixed(0)}%)`}
            style={{
              width: `${s.pct}%`,
              background: ROLE_COLORS[s.role],
              transition: 'width 400ms ease',
              opacity: 0.7,
            }}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 6,
      }}>
        {roleStats.map(s => (
          <div key={s.role} style={{
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <div style={{
              width: 8, height: 8,
              background: ROLE_COLORS[s.role],
              opacity: 0.8,
              flexShrink: 0,
            }} />
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
            }}>
              {s.role} ({s.count})
            </span>
          </div>
        ))}
      </div>

      {/* Status pills */}
      <div style={{
        display: 'flex', gap: 6, flexWrap: 'wrap',
      }}>
        {statusCounts.running > 0 && (
          <Chip tone="green">
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--green)',
              boxShadow: '0 0 4px var(--green)',
              animation: 'pulseDot 2s ease-in-out infinite',
            }} />
            {statusCounts.running} running
          </Chip>
        )}
        {statusCounts.done > 0 && (
          <Chip tone="violet">{statusCounts.done} done</Chip>
        )}
        {statusCounts.errored > 0 && (
          <Chip tone="red">{statusCounts.errored} errors</Chip>
        )}
      </div>
    </div>
  );
}
