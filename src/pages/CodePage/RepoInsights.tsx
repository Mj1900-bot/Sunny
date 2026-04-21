/**
 * RepoInsights — analytics dashboard for the Code page.
 *
 * Shows:
 *  · Language breakdown (horizontal bar chart by file extension)
 *  · Activity heatmap from commit timestamps
 *  · Top 5 largest directories by file count
 */

import { useMemo, type CSSProperties } from 'react';
import { Section } from '../_shared';
import type { CommitEntry } from './api';

// ---------------------------------------------------------------------------
// Language breakdown
// ---------------------------------------------------------------------------

const LANG_MAP: Record<string, { label: string; color: string }> = {
  ts: { label: 'TypeScript', color: 'var(--cyan)' },
  tsx: { label: 'TSX', color: 'var(--cyan)' },
  js: { label: 'JavaScript', color: 'var(--amber)' },
  jsx: { label: 'JSX', color: 'var(--amber)' },
  rs: { label: 'Rust', color: 'var(--gold)' },
  py: { label: 'Python', color: 'var(--amber)' },
  css: { label: 'CSS', color: 'var(--teal)' },
  html: { label: 'HTML', color: 'var(--lime)' },
  json: { label: 'JSON', color: 'var(--green)' },
  toml: { label: 'TOML', color: 'var(--violet)' },
  yaml: { label: 'YAML', color: 'var(--violet)' },
  yml: { label: 'YAML', color: 'var(--violet)' },
  md: { label: 'Markdown', color: 'var(--ink-2)' },
  sh: { label: 'Shell', color: 'var(--green)' },
  sql: { label: 'SQL', color: 'var(--blue)' },
  swift: { label: 'Swift', color: 'var(--pink)' },
  lock: { label: 'Lock', color: 'var(--ink-dim)' },
  svg: { label: 'SVG', color: 'var(--pink)' },
};

function getExt(path: string): string {
  const i = path.lastIndexOf('.');
  return i > 0 ? path.slice(i + 1).toLowerCase() : '';
}

type LangStat = { label: string; ext: string; count: number; color: string; pct: number };

function buildLangBreakdown(files: ReadonlyArray<string>): ReadonlyArray<LangStat> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const e = getExt(f);
    if (!e) continue;
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }

  const total = files.length || 1;
  const entries: LangStat[] = [];
  for (const [ext, count] of counts.entries()) {
    const info = LANG_MAP[ext] ?? { label: ext.toUpperCase(), color: 'var(--ink-dim)' };
    entries.push({ label: info.label, ext, count, color: info.color, pct: (count / total) * 100 });
  }

  entries.sort((a, b) => b.count - a.count);
  return entries.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Top directories
// ---------------------------------------------------------------------------

type DirStat = { name: string; count: number; pct: number };

function buildDirBreakdown(files: ReadonlyArray<string>): ReadonlyArray<DirStat> {
  const counts = new Map<string, number>();
  for (const f of files) {
    const slash = f.indexOf('/');
    const dir = slash > 0 ? f.slice(0, slash) : '(root)';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const total = files.length || 1;
  const entries: DirStat[] = [];
  for (const [name, count] of counts.entries()) {
    entries.push({ name, count, pct: (count / total) * 100 });
  }
  entries.sort((a, b) => b.count - a.count);
  return entries.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Activity heatmap (last 7 days from commit dates)
// ---------------------------------------------------------------------------

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function buildActivityGrid(commits: ReadonlyArray<CommitEntry>): number[] {
  // 7 slots for each day of the week
  const grid = new Array<number>(7).fill(0);
  for (const c of commits) {
    // relDate is like "2 days ago", "3 hours ago", etc.
    // We'll parse a rough day-of-week from "X days ago"
    const match = c.relDate.match(/(\d+)\s+day/);
    if (match) {
      const daysAgo = parseInt(match[1], 10);
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      grid[date.getDay()]++;
    } else if (c.relDate.includes('hour') || c.relDate.includes('minute') || c.relDate.includes('second')) {
      // Today
      grid[new Date().getDay()]++;
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RepoInsights({
  files, commits,
}: {
  files: ReadonlyArray<string>;
  commits: ReadonlyArray<CommitEntry>;
}) {
  const langs = useMemo(() => buildLangBreakdown(files), [files]);
  const dirs = useMemo(() => buildDirBreakdown(files), [files]);
  const activity = useMemo(() => buildActivityGrid(commits), [commits]);
  const maxActivity = Math.max(...activity, 1);

  if (files.length === 0) return null;

  return (
    <Section title="REPO INSIGHTS" right={`${files.length} files`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'fadeSlideIn 300ms ease-out' }}>
        {/* Language composition bar */}
        <div>
          <div style={sectionLabel}>LANGUAGE COMPOSITION</div>
          {/* Stacked bar */}
          <div style={{ display: 'flex', height: 10, borderRadius: 2, overflow: 'hidden', marginTop: 6, gap: 1 }}>
            {langs.map(l => (
              <div
                key={l.ext}
                title={`${l.label}: ${l.count} files (${l.pct.toFixed(1)}%)`}
                style={{
                  flex: l.count,
                  background: l.color,
                  boxShadow: `0 0 4px ${l.color}55`,
                  transition: 'flex 300ms ease',
                }}
              />
            ))}
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            {langs.slice(0, 8).map(l => (
              <div key={l.ext} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-dim)',
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 1,
                  background: l.color,
                  flexShrink: 0,
                }} />
                {l.label}
                <span style={{ color: l.color, fontWeight: 700 }}>{l.count}</span>
              </div>
            ))}
          </div>

          {/* Individual bars */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {langs.map(l => (
              <div key={l.ext} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: l.color,
                  minWidth: 70, textAlign: 'right', fontWeight: 600,
                }}>{l.label}</span>
                <div style={{ flex: 1, height: 4, background: 'rgba(57, 229, 255, 0.06)', borderRadius: 2 }}>
                  <div style={{
                    height: '100%', width: `${l.pct}%`,
                    background: `linear-gradient(90deg, ${l.color}, ${l.color}88)`,
                    borderRadius: 2,
                    boxShadow: `0 0 4px ${l.color}55`,
                    transition: 'width 400ms ease',
                  }} />
                </div>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                  minWidth: 30, textAlign: 'right',
                }}>{l.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Activity heatmap */}
        {commits.length > 0 && (
          <div>
            <div style={sectionLabel}>COMMIT ACTIVITY (THIS WEEK)</div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 1fr)',
              gap: 4,
              marginTop: 6,
            }}>
              {activity.map((count, i) => {
                const intensity = count / maxActivity;
                return (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                    <div
                      title={`${DAYS[i]}: ${count} commits`}
                      style={{
                        width: '100%',
                        height: 24,
                        background: count > 0
                          ? `rgba(57, 229, 255, ${0.1 + intensity * 0.6})`
                          : 'rgba(57, 229, 255, 0.04)',
                        border: '1px solid var(--line-soft)',
                        borderRadius: 2,
                        boxShadow: count > 0 ? `0 0 ${4 + intensity * 8}px rgba(57, 229, 255, ${intensity * 0.3})` : 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontFamily: 'var(--mono)', fontSize: 11,
                        color: count > 0 ? 'var(--cyan)' : 'var(--ink-dim)',
                        fontWeight: count > 0 ? 700 : 400,
                        transition: 'all 300ms ease',
                      }}
                    >
                      {count > 0 ? count : '·'}
                    </div>
                    <span style={{
                      fontFamily: 'var(--display)', fontSize: 7,
                      letterSpacing: '0.14em', color: 'var(--ink-dim)', fontWeight: 600,
                    }}>{DAYS[i]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Top directories */}
        <div>
          <div style={sectionLabel}>TOP DIRECTORIES</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {dirs.map((d, i) => (
              <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={rankBadge}>{i + 1}</span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--violet)',
                  fontWeight: 600, minWidth: 80,
                }}>{d.name}/</span>
                <div style={{ flex: 1, height: 4, background: 'rgba(57, 229, 255, 0.06)', borderRadius: 2 }}>
                  <div style={{
                    height: '100%',
                    width: `${d.pct}%`,
                    background: 'linear-gradient(90deg, var(--violet), var(--violet)88)',
                    borderRadius: 2,
                    boxShadow: '0 0 4px rgba(139, 92, 246, 0.3)',
                    transition: 'width 400ms ease',
                  }} />
                </div>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                  minWidth: 40, textAlign: 'right',
                }}>{d.count} files</span>
              </div>
            ))}
          </div>
        </div>
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
