/**
 * WORLD — Sunny's situational awareness dashboard.
 *
 * Renders the live `WorldState` that Sunny's updater maintains at 15s
 * cadence. Every agent context pack pulls from this same snapshot, so
 * this page is effectively "what Sunny knows about your current reality
 * when it answers a prompt". Making it visible is the single biggest
 * trust lever for the whole agent stack.
 *
 * Layout (top → bottom):
 *  1. PageLead + DayProgress + WorldStatusStrip (span 12)
 *  2. BeliefCard — upgraded with glow + sparkline (span 12)
 *  3. Quick Actions toolbar (span 12)
 *  4. Context Cards 2×2 (span 8) | Machine Gauges (span 4)
 *  5. Activity Timeline (span 6) | Focus Heatmap (span 6)
 *  6. Focus Switches Timeline (span 8) | Feedback + Meta (span 4)
 */

import { useEffect, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { useView } from '../../store/view';
import {
  PageGrid, PageCell, Section, StatBlock, EmptyState,
  PageLead, Toolbar, ToolbarButton, DayProgress, useFlashMessage, usePoll,
} from '../_shared';
import { downloadTextFile, worldSnapshotJson, worldSnapshotText } from '../_shared/snapshots';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import { BeliefCard } from './BeliefCard';
import { SwitchesList } from './SwitchesList';
import { WorldStatusStrip } from './WorldStatusStrip';
import { ContextCards } from './ContextCards';
import { MachineGauges, pushMetricHistory } from './MachineGauges';
import { ActivityTimeline, pushActivityHistory } from './ActivityTimeline';
import { FocusHeatmap } from './FocusHeatmap';
import { loadWorld } from './api';

// ---------------------------------------------------------------------------
// Quick-action prompt builders
// ---------------------------------------------------------------------------

function dayPrompt(text: string): string {
  return `Here's my current world snapshot:\n\n${text}\n\nGive me a concise summary of my day so far — what have I been doing, how productive was it, and what patterns do you notice?`;
}

function focusPrompt(text: string): string {
  return `Here's my current world snapshot:\n\n${text}\n\nBased on my calendar, current activity, and focus patterns — what should I focus on next? Give me a prioritised recommendation.`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorldPage() {
  const liveRefresh = useView(s => s.settings.liveRefresh);
  const { data: world, loading, error, reload } = usePoll(loadWorld, 4000);
  const { message: copyHint, flash } = useFlashMessage();
  const [dayNow, setDayNow] = useState(() => Date.now());
  const [correction, setCorrection] = useState('');

  // Day progress ticker
  useEffect(() => {
    const h = window.setInterval(() => setDayNow(Date.now()), 30_000);
    return () => window.clearInterval(h);
  }, []);

  // Push to client-side history rings on each new revision
  const prevRevRef = useRef<number | null>(null);
  const [metricHistory, setMetricHistory] = useState(() =>
    world ? pushMetricHistory(world) : [],
  );
  const [activityHistory, setActivityHistory] = useState(() =>
    world ? pushActivityHistory(world) : [],
  );

  if (world && prevRevRef.current !== world.revision) {
    prevRevRef.current = world.revision;
    setMetricHistory(pushMetricHistory(world));
    setActivityHistory(pushActivityHistory(world));
  }

  return (
    <ModuleView title="WORLD · SITUATION">
      {!world && loading && (
        <EmptyState title="Connecting to world model" hint="Sampling focus, calendar, mail, and machine state…" />
      )}
      {error && !world && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <EmptyState title="World model unavailable" hint={error} />
          <Toolbar>
            <ToolbarButton tone="cyan" onClick={() => void reload()}>
              RETRY
            </ToolbarButton>
          </Toolbar>
        </div>
      )}

      {world && (
        <PageGrid>
          {/* Row 1: Header + DayProgress + StatusStrip */}
          <PageCell span={12}>
            <PageLead>
              Live snapshot of what Sunny attaches to every reply: focus, calendar, mail, and machine vitals. Refreshes every few seconds.
            </PageLead>
            <DayProgress nowMs={dayNow} tone="cyan" height={2} />
            <WorldStatusStrip
              worldRevision={world.revision}
              worldTimestampMs={world.timestamp_ms}
              liveRefresh={liveRefresh}
            />
          </PageCell>

          {/* Row 2: Belief Card */}
          <PageCell span={12}>
            <BeliefCard world={world} revision={world.revision} />
          </PageCell>

          {/* Row 3: Quick Actions */}
          <PageCell span={12}>
            <Toolbar style={{ flexWrap: 'wrap', gap: 8 }}>
              <ToolbarButton
                tone="cyan"
                title="Ask Sunny to summarize your day"
                onClick={() => askSunny(
                  dayPrompt(worldSnapshotText(world)), 'world',
                )}
              >
                ✦ SUMMARIZE MY DAY
              </ToolbarButton>
              <ToolbarButton
                tone="green"
                title="Get a prioritised focus recommendation"
                onClick={() => askSunny(
                  focusPrompt(worldSnapshotText(world)), 'world',
                )}
              >
                ◎ WHAT SHOULD I FOCUS ON?
              </ToolbarButton>
              <ToolbarButton
                tone="violet"
                title="Copy a plain-text summary for notes or bug reports"
                onClick={async () => {
                  const ok = await copyToClipboard(worldSnapshotText(world));
                  flash(ok ? 'Snapshot copied to clipboard' : 'Copy failed');
                }}
              >
                COPY SNAPSHOT
              </ToolbarButton>
              <ToolbarButton
                tone="violet"
                title="Download full world_get JSON"
                onClick={() => {
                  downloadTextFile(
                    `sunny-world-rev${world.revision}-${Date.now()}.json`,
                    worldSnapshotJson(world),
                    'application/json',
                  );
                  flash('JSON download started');
                }}
              >
                DOWNLOAD JSON
              </ToolbarButton>
              <ToolbarButton
                tone="amber"
                onClick={() => askSunny(
                  `Here's my current world snapshot:\n\n${worldSnapshotText(world)}\n\nDoes this match what I'm actually doing? If not, what should we correct?`,
                  'world',
                )}
              >
                RECONCILE IN CHAT
              </ToolbarButton>
              {copyHint && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
              )}
            </Toolbar>
          </PageCell>

          {/* Row 4: Context Cards (8) | Machine Gauges (4) */}
          <PageCell span={8}>
            <ContextCards world={world} />
          </PageCell>

          <PageCell span={4}>
            <Section title="MACHINE VITALS" right="sampled each tick">
              <MachineGauges world={world} metricHistory={metricHistory} />
            </Section>
          </PageCell>

          {/* Row 5: Activity Timeline (6) | Focus Heatmap (6) */}
          <PageCell span={6}>
            <Section title="ACTIVITY TIMELINE" right="24hr ring">
              <ActivityTimeline world={world} history={activityHistory} />
            </Section>
          </PageCell>

          <PageCell span={6}>
            <Section title="APP USAGE HEATMAP" right="from switches">
              <FocusHeatmap switches={world.recent_switches} />
            </Section>
          </PageCell>

          {/* Row 6: Focus Switches (8) | Feedback + Meta (4) */}
          <PageCell span={8}>
            <SwitchesList items={world.recent_switches} />
          </PageCell>

          <PageCell span={4}>
            <Section title="CORRECTIONS" right="teach Sunny">
              <div style={{ fontSize: 11, color: 'var(--ink-dim)', padding: '4px 2px', lineHeight: 1.6 }}>
                If Sunny has this wrong, type a correction below or tell it directly in chat.
                Corrections are written to episodic memory with
                <code style={{ color: 'var(--gold)' }}> kind=correction</code>.
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={correction}
                  onChange={e => setCorrection(e.target.value)}
                  placeholder="e.g. I'm reviewing a PR, not coding"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && correction.trim()) {
                      askSunny(
                        `Correction: ${correction.trim()}. Please update your understanding of what I'm doing.`,
                        'world',
                      );
                      setCorrection('');
                    }
                  }}
                  style={{
                    all: 'unset', boxSizing: 'border-box',
                    flex: 1, minWidth: 0,
                    padding: '7px 10px',
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                    border: '1px solid var(--line-soft)',
                    background: 'rgba(0, 0, 0, 0.35)',
                    transition: 'border-color 140ms ease',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--cyan)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--line-soft)'; }}
                />
                <ToolbarButton
                  tone="cyan"
                  disabled={!correction.trim()}
                  onClick={() => {
                    if (correction.trim()) {
                      askSunny(
                        `Correction: ${correction.trim()}. Please update your understanding of what I'm doing.`,
                        'world',
                      );
                      setCorrection('');
                    }
                  }}
                >
                  SEND
                </ToolbarButton>
              </div>
            </Section>

            <Section title="METADATA" right="internals">
              <div style={{ display: 'flex', gap: 6 }}>
                <StatBlock label="REV" value={String(world.revision)} tone="cyan" />
                <StatBlock label="SCHEMA" value={`v${world.schema_version}`} tone="green" />
              </div>
            </Section>

            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
              <ToolbarButton tone="cyan" onClick={() => void reload()} title="Fetch the latest world snapshot immediately">
                REFRESH NOW
              </ToolbarButton>
            </div>
          </PageCell>
        </PageGrid>
      )}
    </ModuleView>
  );
}
