/**
 * NOTIFY — unified notification feed + composer.
 *
 * Depth additions (R12-F):
 *   • Scheduled notifications: natural-language phrase parser +
 *     localStorage-persisted schedules, fired via setInterval.
 *   • Preview card: macOS-style banner mockup before sending.
 *   • Templates: WATER / STAND / REFOCUS / BREAK one-click installs.
 *   • Stats block: sent today / this week / by tone.
 *
 * Keyboard: ⌘/Ctrl+Enter from either field sends the notification.
 */

import { useEffect, useMemo, useSyncExternalStore, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, Chip, ScrollList,
  Toolbar, ToolbarButton, relTime, KeyHint, useDebounced,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { copyToClipboard } from '../../lib/clipboard';
import {
  clearAll, clearNotify, sendMacNotification, useNotifyLog,
  NOTIFY_SOUNDS, type NotifySound,
} from './store';
import {
  addSchedule, getSchedules, parseSchedulePhrase, removeSchedule,
  startScheduler, subscribeSchedules, toggleSchedule,
} from './scheduler';
import { NotifyPreview } from './NotifyPreview';

const TEMPLATES = [
  { label: 'WATER',   title: 'Drink water',     body: 'Stay hydrated.',              intervalMs: 45 * 60_000, icon: '💧' },
  { label: 'STAND',   title: 'Stand up',        body: 'Time to stretch your legs.',  intervalMs: 60 * 60_000, icon: '⌂' },
  { label: 'REFOCUS', title: 'Refocus',         body: 'Clear distractions.',         intervalMs: 90 * 60_000, icon: '◎' },
  { label: 'BREAK',   title: 'Take a break',    body: '5-minute reset.',             intervalMs: 25 * 60_000, icon: '⎵' },
] as const;

function useSchedules(): ReturnType<typeof getSchedules> {
  return useSyncExternalStore(subscribeSchedules, getSchedules, getSchedules);
}

function nowDayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

function weekStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime() / 1000;
}

function fmtInterval(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `every ${m}m`;
  const h = Math.round(ms / 3_600_000);
  return `every ${h}h`;
}

function fmtNextFire(s: { intervalMs: number; lastFired: number; enabled: boolean }): string {
  if (!s.enabled) return 'paused';
  const next = s.lastFired + s.intervalMs;
  const remaining = next - Date.now();
  if (remaining <= 0) return 'any moment';
  const m = Math.round(remaining / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(remaining / 3_600_000);
  return `in ${h}h`;
}

export function NotifyPage() {
  const items = useNotifyLog();
  const schedules = useSchedules();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sound, setSound] = useState<NotifySound | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schedulePhrase, setSchedulePhrase] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [logSearch, setLogSearch] = useState('');
  const [logTone, setLogTone] = useState<'all' | 'info' | 'ok' | 'warn' | 'error' | 'sunny'>('all');
  const [exportFlash, setExportFlash] = useState(false);

  const logDebounced = useDebounced(logSearch, 200);

  useEffect(() => { startScheduler(); }, []);

  const fromSunny = items.filter(i => i.from_sunny).length;
  const todayStart = nowDayStart();
  const weekStartTs = weekStart();
  const sentToday = items.filter(i => i.at >= todayStart).length;
  const sentWeek  = items.filter(i => i.at >= weekStartTs).length;
  const warnCount = items.filter(i => i.tone === 'warn').length;
  const errorCount = items.filter(i => i.tone === 'error').length;

  const logFiltered = useMemo(() => {
    let list = [...items];
    const q = logDebounced.trim().toLowerCase();
    if (q) {
      list = list.filter(i =>
        i.title.toLowerCase().includes(q)
        || (i.body && i.body.toLowerCase().includes(q)),
      );
    }
    if (logTone === 'sunny') list = list.filter(i => i.from_sunny);
    else if (logTone !== 'all') list = list.filter(i => i.tone === logTone);
    return list;
  }, [items, logDebounced, logTone]);

  const handleExportLog = async () => {
    const ok = await copyToClipboard(JSON.stringify(logFiltered, null, 2));
    if (ok) {
      setExportFlash(true);
      window.setTimeout(() => setExportFlash(false), 1_000);
    }
  };

  const canSend = !busy && title.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setBusy(true); setError(null);
    try {
      await sendMacNotification(title.trim(), body.trim(), sound ? (sound as NotifySound) : null);
      setTitle(''); setBody('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  };

  const handleAddSchedule = () => {
    setScheduleError(null);
    const parsed = parseSchedulePhrase(schedulePhrase);
    if (!parsed) {
      setScheduleError('Could not parse phrase — try "drink water every 45 min"');
      return;
    }
    addSchedule({ label: schedulePhrase, ...parsed });
    setSchedulePhrase('');
  };

  const handleTemplate = (tpl: typeof TEMPLATES[number]) => {
    addSchedule({
      label: tpl.label,
      title: tpl.title,
      body: tpl.body,
      intervalMs: tpl.intervalMs,
    });
  };

  return (
    <ModuleView title="NOTIFY · FEED">
      <PageGrid>
        {/* ── Stats (4 blocks + inline week/warn/error chips) ── */}
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <StatBlock label="TOTAL" value={String(items.length)} sub={`${sentWeek} this wk`} tone="cyan" />
            <StatBlock label="TODAY" value={String(sentToday)} sub={sentToday > 0 ? 'sent' : 'quiet'} tone="green" />
            <StatBlock label="FROM SUNNY" value={String(fromSunny)} sub="proactive" tone="violet" />
            <StatBlock
              label="ALERTS"
              value={`${warnCount} · ${errorCount}`}
              sub="warn · error"
              tone={errorCount > 0 ? 'red' : warnCount > 0 ? 'amber' : 'cyan'}
            />
          </div>
        </PageCell>

        {/* ── Left: composer + schedules + Sunny ── */}
        <PageCell span={5}>
          <Section title="SEND NOTIFICATION">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={onKey}
                placeholder="title"
                aria-label="Notification title"
                style={inputStyle}
              />
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                onKeyDown={onKey}
                placeholder="body (optional)"
                aria-label="Notification body"
                rows={2}
                style={{ ...inputStyle, minHeight: 48, resize: 'vertical' }}
              />
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)',
                  letterSpacing: '0.16em',
                }}>SOUND</span>
                <select
                  value={sound}
                  onChange={e => setSound(e.target.value as NotifySound | '')}
                  aria-label="Notification sound"
                  style={{
                    ...inputStyle,
                    width: 'auto', flex: '0 0 auto',
                    padding: '4px 10px',
                    fontFamily: 'var(--mono)', fontSize: 11,
                  }}
                >
                  <option value="">(none)</option>
                  {NOTIFY_SOUNDS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                <span style={{
                  display: 'inline-flex', gap: 4, alignItems: 'center',
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                  letterSpacing: '0.12em',
                }}>
                  <KeyHint>⌘</KeyHint>
                  <KeyHint>↵</KeyHint>
                  <span>SEND</span>
                </span>
              </div>
              {error && (
                <div style={{
                  padding: '6px 10px',
                  border: '1px solid var(--red)', borderLeft: '2px solid var(--red)',
                  background: 'rgba(255,77,94,0.08)',
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)',
                }}>{error}</div>
              )}
              <Toolbar>
                <ToolbarButton tone="cyan" onClick={send} disabled={!canSend}>
                  {busy ? 'SENDING…' : 'SEND'}
                </ToolbarButton>
                <ToolbarButton tone="red" onClick={clearAll} disabled={items.length === 0}>CLEAR LOG</ToolbarButton>
              </Toolbar>
              {/* Live preview */}
              {title.trim() && (
                <div style={{ paddingTop: 4 }}>
                  <div style={{
                    fontFamily: 'var(--display)', fontSize: 8,
                    letterSpacing: '0.24em', color: 'var(--ink-dim)',
                    marginBottom: 6,
                  }}>PREVIEW</div>
                  <NotifyPreview title={title} body={body} />
                </div>
              )}
            </div>
          </Section>

          <Section title="SCHEDULED" right={`${schedules.filter(s => s.enabled).length} active`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={schedulePhrase}
                  onChange={e => setSchedulePhrase(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddSchedule(); }}
                  placeholder={'e.g. "drink water every 45 min"'}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <ToolbarButton tone="cyan" onClick={handleAddSchedule} disabled={!schedulePhrase.trim()}>
                  ADD
                </ToolbarButton>
              </div>
              {scheduleError && (
                <div style={{
                  padding: '5px 8px', border: '1px dashed var(--amber)',
                  fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--amber)',
                }}>{scheduleError}</div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                  letterSpacing: '0.16em',
                }}>TEMPLATES</span>
                {TEMPLATES.map(tpl => (
                  <ToolbarButton key={tpl.label} tone="violet" onClick={() => handleTemplate(tpl)}>
                    {tpl.icon} {tpl.label}
                  </ToolbarButton>
                ))}
              </div>
              {schedules.length > 0 ? (
                <ScrollList maxHeight={200}>
                  {schedules.map(s => (
                    <div key={s.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px',
                      border: '1px solid var(--line-soft)',
                      borderLeft: `2px solid ${s.enabled ? 'var(--green)' : 'var(--line-soft)'}`,
                      background: s.enabled ? 'rgba(125, 255, 154, 0.04)' : 'rgba(6,14,22,0.55)',
                      opacity: s.enabled ? 1 : 0.7,
                    }}>
                      <Chip tone={s.enabled ? 'green' : 'dim'}>{s.enabled ? 'ON' : 'OFF'}</Chip>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontFamily: 'var(--label)', fontSize: 12.5, fontWeight: 600,
                          color: 'var(--ink)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{s.title}</div>
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-dim)',
                          display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2,
                        }}>
                          <span>{fmtInterval(s.intervalMs)}</span>
                          <span>·</span>
                          <span style={{ color: s.enabled ? 'var(--cyan)' : 'var(--ink-dim)' }}>
                            next {fmtNextFire(s)}
                          </span>
                        </div>
                      </div>
                      <ToolbarButton tone={s.enabled ? 'amber' : 'green'} onClick={() => toggleSchedule(s.id)}>
                        {s.enabled ? 'PAUSE' : 'RESUME'}
                      </ToolbarButton>
                      <button
                        onClick={() => removeSchedule(s.id)}
                        aria-label="Remove schedule"
                        style={{
                          all: 'unset', cursor: 'pointer',
                          padding: '2px 8px',
                          fontFamily: 'var(--display)', fontSize: 11, fontWeight: 700,
                          color: 'var(--red)',
                          border: '1px solid var(--red)',
                          opacity: 0.8,
                        }}
                      >×</button>
                    </div>
                  ))}
                </ScrollList>
              ) : (
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-dim)',
                  padding: '8px 10px',
                  border: '1px dashed var(--line-soft)',
                  textAlign: 'center',
                }}>
                  No schedules yet. Type a phrase or tap a template.
                </div>
              )}
            </div>
          </Section>

          <Section title="SUNNY-DRIVEN" right="nudges">
            <ToolbarButton
              tone="gold"
              onClick={() => askSunny(`Decide if there's anything worth notifying me about right now (a missed deadline, an overdue task, a meeting soon). If yes, write it as a single notify_send call.`, 'notify')}
            >◎ ASK: IS THERE ANYTHING WORTH NOTIFYING?</ToolbarButton>
          </Section>
        </PageCell>

        {/* ── Right: log ── */}
        <PageCell span={7}>
          <Section title="LOG" right={items.length > 0 ? `${logFiltered.length} shown · ${items.length} total` : undefined}>
            {items.length === 0 ? (
              <EmptyState title="No notifications yet" hint="Sent or recorded notifications land here, newest first." />
            ) : (
              <>
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
                  marginBottom: 8,
                  padding: '6px 8px',
                  border: '1px solid var(--line-soft)',
                  background: 'rgba(6, 14, 22, 0.45)',
                }}>
                  <input
                    value={logSearch}
                    onChange={e => setLogSearch(e.target.value)}
                    placeholder="search title / body…"
                    aria-label="Search notification log"
                    style={{
                      all: 'unset', flex: 1, minWidth: 140,
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink)',
                      padding: '4px 6px',
                    }}
                  />
                  <ToolbarButton tone="cyan" active={logTone === 'all'} onClick={() => setLogTone('all')}>ALL</ToolbarButton>
                  <ToolbarButton tone="cyan" active={logTone === 'info'} onClick={() => setLogTone('info')}>INFO</ToolbarButton>
                  <ToolbarButton tone="green" active={logTone === 'ok'} onClick={() => setLogTone('ok')}>OK</ToolbarButton>
                  <ToolbarButton tone="amber" active={logTone === 'warn'} onClick={() => setLogTone('warn')}>WARN</ToolbarButton>
                  <ToolbarButton tone="red" active={logTone === 'error'} onClick={() => setLogTone('error')}>ERR</ToolbarButton>
                  <ToolbarButton tone="violet" active={logTone === 'sunny'} onClick={() => setLogTone('sunny')}>SUNNY</ToolbarButton>
                  <ToolbarButton
                    tone="teal"
                    disabled={logFiltered.length === 0}
                    onClick={() => void handleExportLog()}
                  >{exportFlash ? 'COPIED JSON' : 'EXPORT JSON'}</ToolbarButton>
                </div>
              <ScrollList maxHeight={560}>
                {logFiltered.length === 0 ? (
                  <EmptyState title="No matches" hint="Adjust search or tone filters." />
                ) : logFiltered.map(n => {
                  const tc = toneColor(n.tone);
                  return (
                    <div key={n.id} style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: '10px 12px',
                      border: '1px solid var(--line-soft)',
                      borderLeft: `2px solid var(--${tc})`,
                      background: n.from_sunny ? 'rgba(180, 140, 255, 0.04)' : 'rgba(6, 14, 22, 0.55)',
                    }}>
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: 4,
                        alignItems: 'flex-start', flexShrink: 0,
                      }}>
                        <Chip tone={tc}>{n.tone}</Chip>
                        {n.from_sunny && <Chip tone="violet">SUNNY</Chip>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{
                          fontFamily: 'var(--label)', fontSize: 13, fontWeight: 600, color: 'var(--ink)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{n.title}</div>
                        {n.body && (
                          <div style={{
                            fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
                            lineHeight: 1.4,
                          }}>{n.body}</div>
                        )}
                        {n.sound && (
                          <div style={{
                            fontFamily: 'var(--mono)', fontSize: 9.5,
                            color: 'var(--ink-dim)', letterSpacing: '0.08em',
                          }}>♪ {n.sound}</div>
                        )}
                      </div>
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: 4,
                        alignItems: 'flex-end', flexShrink: 0,
                      }}>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)',
                        }}>{relTime(n.at)}</span>
                        <button
                          type="button"
                          onClick={() => void copyToClipboard([n.title, n.body].filter(Boolean).join('\n'))}
                          style={{
                            all: 'unset', cursor: 'pointer',
                            color: 'var(--cyan)',
                            padding: '2px 7px',
                            fontFamily: 'var(--display)', fontSize: 9, fontWeight: 700,
                            letterSpacing: '0.12em',
                            border: '1px solid var(--line-soft)',
                          }}
                        >COPY</button>
                        <button
                          onClick={() => clearNotify(n.id)}
                          aria-label="Dismiss notification"
                          style={{
                            all: 'unset', cursor: 'pointer',
                            color: 'var(--ink-dim)',
                            padding: '2px 7px',
                            fontFamily: 'var(--display)', fontSize: 11, fontWeight: 700,
                            border: '1px solid var(--line-soft)',
                          }}
                        >×</button>
                      </div>
                    </div>
                  );
                })}
              </ScrollList>
              </>
            )}
          </Section>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}

function toneColor(t: 'info' | 'ok' | 'warn' | 'error'): 'cyan' | 'green' | 'amber' | 'red' {
  if (t === 'ok') return 'green';
  if (t === 'warn') return 'amber';
  if (t === 'error') return 'red';
  return 'cyan';
}

const inputStyle: React.CSSProperties = {
  all: 'unset', boxSizing: 'border-box',
  padding: '6px 10px', width: '100%',
  fontFamily: 'var(--label)', fontSize: 13, color: 'var(--ink)',
  border: '1px solid var(--line-soft)', background: 'rgba(0, 0, 0, 0.3)',
};
