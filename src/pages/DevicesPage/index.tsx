/**
 * DEVICES — network, media, daemons.
 *
 * R12-J additions:
 *  - Daemon "RUN NOW" button: fires scheduler_run_once for instant trigger.
 *  - Media controller: larger layout with album art placeholder, track name
 *    more prominent, position rendered as MM:SS / MM:SS.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, Chip, Row, ScrollList,
  Toolbar, ToolbarButton, MetricBar, PageLead, FilterInput, NavLink, useFlashMessage, usePoll, useDebounced, relTime,
} from '../_shared';
import { devicesEnvironmentJson, downloadTextFile, netStatsText, nowPlayingText } from '../_shared/snapshots';
import { copyToClipboard } from '../../lib/clipboard';
import { askSunny } from '../../lib/askSunny';
import {
  getNet, listDaemons, mediaNext, mediaPrev, nowPlaying,
  runDaemonNow, setDaemonEnabled, togglePlayPause,
} from './api';

export function DevicesPage() {
  const { message: copyHint, flash } = useFlashMessage();

  const { data: net,     loading: netLoading,     error: netError,     reload: reloadNet     } = usePoll(getNet, 4000);
  const { data: np,      loading: npLoading,      error: npError,      reload: reloadNp      } = usePoll(nowPlaying, 4000);
  const { data: daemons, loading: daemonsLoading, error: daemonsError, reload: reloadDaemons } = usePoll(listDaemons, 10_000);

  const refreshAll = () => {
    reloadNet();
    reloadNp();
    reloadDaemons();
    flash('Environment refreshed');
  };

  const [pending,    setPending]    = useState<ReadonlyMap<string, boolean>>(new Map());
  const [runningNow, setRunningNow] = useState<ReadonlySet<string>>(new Set());

  const toggleDaemon = useCallback(async (id: string, nextEnabled: boolean) => {
    setPending(prev => { const c = new Map(prev); c.set(id, nextEnabled); return c; });
    try {
      await setDaemonEnabled(id, nextEnabled);
      reloadDaemons();
    } finally {
      setPending(prev => { if (!prev.has(id)) return prev; const c = new Map(prev); c.delete(id); return c; });
    }
  }, [reloadDaemons]);

  const triggerRunNow = useCallback(async (id: string) => {
    setRunningNow(prev => new Set([...prev, id]));
    try {
      await runDaemonNow(id);
      reloadDaemons();
    } finally {
      setRunningNow(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [reloadDaemons]);

  const [daemonQuery, setDaemonQuery] = useState('');
  const dq = useDebounced(daemonQuery, 150);
  const [outputOpen, setOutputOpen] = useState<ReadonlySet<string>>(() => new Set());

  const toggleOutput = (id: string) => {
    setOutputOpen(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const filteredDaemons = useMemo(() => {
    const q = dq.trim().toLowerCase();
    if (!q) return daemons ?? [];
    return (daemons ?? []).filter(d =>
      d.title.toLowerCase().includes(q) ||
      d.kind.toLowerCase().includes(q) ||
      d.goal.toLowerCase().includes(q),
    );
  }, [daemons, dq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const editing = !!tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
      if (editing) return;
      if ((e.key === ' ' || e.key === 'k') && np && np.source !== 'none') {
        e.preventDefault(); void togglePlayPause();
      } else if (e.key === 'j' && np && np.source !== 'none') {
        e.preventDefault(); void mediaPrev();
      } else if (e.key === 'l' && np && np.source !== 'none') {
        e.preventDefault(); void mediaNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [np]);

  const totalDaemons  = (daemons ?? []).length;
  const activeDaemons = (daemons ?? []).filter(d => d.enabled).length;

  return (
    <ModuleView title="DEVICES · ENVIRONMENT">
      <PageGrid>
        <PageCell span={12}>
          <PageLead>
            Network health, now-playing media (with keyboard shortcuts), and scheduler daemons you can run or toggle on demand.
          </PageLead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <StatBlock label="NETWORK" value={net?.iface ?? '—'} sub={net?.ssid ?? '(no SSID)'} tone="cyan" />
            <StatBlock label="PING"    value={net?.ping_ms != null ? `${net.ping_ms}ms` : '—'} tone="amber" />
            <StatBlock label="PLAYING" value={np?.playing ? 'YES' : 'NO'} sub={np?.source ?? 'none'} tone="violet" />
            <StatBlock label="DAEMONS" value={`${activeDaemons}/${totalDaemons}`} sub="enabled" tone="green" />
          </div>
          <Toolbar style={{ flexWrap: 'wrap', marginTop: 4 }}>
            <ToolbarButton tone="cyan" title="Re-fetch network, media, and daemon list" onClick={refreshAll}>
              REFRESH
            </ToolbarButton>
            {np && np.source !== 'none' && (
              <ToolbarButton
                tone="violet"
                title="Copy title, artist, album, source, playback state"
                onClick={async () => {
                  const ok = await copyToClipboard(nowPlayingText(np));
                  flash(ok ? 'Now playing copied' : 'Copy failed');
                }}
              >
                COPY NOW PLAYING
              </ToolbarButton>
            )}
            <ToolbarButton
              tone="amber"
              title="Download network, media, and daemons as JSON"
              onClick={() => {
                downloadTextFile(
                  `sunny-devices-${Date.now()}.json`,
                  devicesEnvironmentJson({ net: net ?? null, nowPlaying: np ?? null, daemons: daemons ?? [] }),
                  'application/json;charset=utf-8',
                );
                flash('Devices JSON export started');
              }}
            >
              DOWNLOAD JSON
            </ToolbarButton>
            {copyHint && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)' }}>{copyHint}</span>
            )}
          </Toolbar>
        </PageCell>

        <PageCell span={6}>
          <Section
            title="NETWORK"
            right={net && !netError ? (
              <ToolbarButton
                tone="violet"
                title="Copy interface, IP, ping, throughput"
                onClick={async () => {
                  const ok = await copyToClipboard(netStatsText(net));
                  flash(ok ? 'Network stats copied' : 'Copy failed');
                }}
              >
                COPY
              </ToolbarButton>
            ) : undefined}
          >
            {netError ? (
              <EmptyState title="Network unavailable" hint={netError} />
            ) : netLoading && !net ? (
              <EmptyState title="Loading…" hint="Probing local interface." />
            ) : !net ? (
              <EmptyState title="Network unavailable" />
            ) : (
              <>
                <Row label="interface" value={net.iface ?? '—'} right={net.ssid ?? undefined} />
                <Row label="public ip" value={net.public_ip ?? '—'} />
                <MetricBar label="DOWN" value={`${net.down_kbps ?? 0} KB/s`} pct={Math.min(100, (net.down_kbps ?? 0) / 40)} tone="cyan" />
                <MetricBar label="UP"   value={`${net.up_kbps ?? 0} KB/s`}   pct={Math.min(100, (net.up_kbps ?? 0) / 20)}  tone="violet" />
              </>
            )}
          </Section>
        </PageCell>

        <PageCell span={6}>
          <Section title="NOW PLAYING" right={np?.source ?? 'none'}>
            {npError ? (
              <EmptyState title="Media unavailable" hint={npError} />
            ) : npLoading && !np ? (
              <EmptyState title="Loading…" />
            ) : !np || np.source === 'none' ? (
              <EmptyState title="Nothing playing" hint="Spotify / Music / system audio — we'll show it here." />
            ) : (
              <>
                {/* Large track display */}
                <div style={{
                  display: 'flex', gap: 14, alignItems: 'center',
                  padding: '12px 14px',
                  border: '1px solid var(--line-soft)',
                  borderLeft: '2px solid var(--violet)',
                  background: 'rgba(0,0,0,0.3)',
                }}>
                  {/* Album art placeholder */}
                  <div style={{
                    width: 52, height: 52, flexShrink: 0,
                    background: 'rgba(57,229,255,0.08)',
                    border: '1px solid var(--line-soft)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 22,
                  }}>
                    {np.playing ? '▶' : '⏸'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{
                      fontFamily: 'var(--label)', fontSize: 15, fontWeight: 700,
                      color: 'var(--ink)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {np.title || '(unknown track)'}
                    </div>
                    <div style={{
                      fontFamily: 'var(--label)', fontSize: 12, color: 'var(--ink-2)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {np.artist || '—'}
                      {np.album ? ` · ${np.album}` : ''}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Chip tone={np.playing ? 'green' : 'amber'} style={{ fontSize: 8 }}>
                        {np.playing ? 'PLAYING' : 'PAUSED'}
                      </Chip>
                      <Chip tone="dim" style={{ fontSize: 8 }}>{np.source}</Chip>
                    </div>
                  </div>
                </div>

                {np.duration_sec && (
                  <MetricBar
                    label={formatMediaTime(np.position_sec, np.duration_sec)}
                    pct={(np.position_sec ?? 0) / np.duration_sec * 100}
                    tone="violet"
                  />
                )}

                <Toolbar>
                  <ToolbarButton onClick={() => void mediaPrev()}>◀ PREV (J)</ToolbarButton>
                  <ToolbarButton tone="cyan" onClick={() => void togglePlayPause()}>
                    {np.playing ? '⏸ PAUSE (K)' : '▶ PLAY (K)'}
                  </ToolbarButton>
                  <ToolbarButton onClick={() => void mediaNext()}>NEXT ▶ (L)</ToolbarButton>
                </Toolbar>
              </>
            )}
          </Section>
        </PageCell>

        <PageCell span={12}>
          <Section
            title="DAEMONS"
            right={
              <NavLink
                tone="cyan"
                onClick={() => askSunny(
                  `List my daemons and flag any whose last_status is 'error'. Suggest fixes.`,
                  'devices',
                )}
              >
                Ask Sunny to audit
              </NavLink>
            }
          >
            <Toolbar>
              <FilterInput
                value={daemonQuery}
                onChange={e => setDaemonQuery(e.target.value)}
                placeholder="Filter by name, kind, or goal…"
                aria-label="Filter daemons"
                spellCheck={false}
              />
              <ToolbarButton onClick={reloadDaemons} title="Reload daemon list from scheduler">
                REFRESH
              </ToolbarButton>
            </Toolbar>

            {daemonsError ? (
              <EmptyState title="Couldn't load daemons" hint={daemonsError} />
            ) : daemonsLoading && totalDaemons === 0 ? (
              <EmptyState title="Loading…" hint="Reading scheduler daemon list." />
            ) : totalDaemons === 0 ? (
              <EmptyState title="No daemons" hint="Create one from AUTO's Scheduled tab." />
            ) : filteredDaemons.length === 0 ? (
              <EmptyState title="Nothing matches" hint={`No daemons match "${dq}".`} />
            ) : (
              <ScrollList maxHeight={420}>
                {filteredDaemons.map(d => {
                  const effectiveEnabled = pending.get(d.id) ?? d.enabled;
                  const isPending = pending.has(d.id);
                  const isRunning = runningNow.has(d.id);
                  const showOut = outputOpen.has(d.id);
                  return (
                    <div
                      key={d.id}
                      style={{
                        display: 'flex', flexDirection: 'column',
                        border: '1px solid var(--line-soft)',
                        borderLeft: `2px solid var(--${effectiveEnabled ? 'green' : 'amber'})`,
                        opacity: isPending ? 0.65 : 1,
                        transition: 'opacity 120ms ease, border-color 120ms ease',
                      }}
                    >
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px', flexWrap: 'wrap',
                      }}
                      >
                        <Chip tone={effectiveEnabled ? 'green' : 'amber'}>
                          {effectiveEnabled ? 'ON' : 'OFF'}
                        </Chip>
                        <Chip tone="dim">{d.kind}</Chip>
                        <div
                          title={d.goal || d.title}
                          style={{
                            flex: 1, minWidth: 0,
                            fontFamily: 'var(--label)', fontSize: 12.5, color: 'var(--ink)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >{d.title}</div>
                        {d.last_status && (
                          <Chip tone={d.last_status === 'ok' ? 'green' : 'red'}>
                            {d.last_status}
                          </Chip>
                        )}
                        {d.last_run && (
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)' }}>
                            {relTime(d.last_run)}
                          </span>
                        )}
                        <ToolbarButton
                          tone="amber"
                          disabled={isRunning || !effectiveEnabled}
                          onClick={() => void triggerRunNow(d.id)}
                        >
                          {isRunning ? 'RUNNING…' : 'RUN NOW'}
                        </ToolbarButton>
                        <ToolbarButton
                          disabled={isPending}
                          onClick={() => void toggleDaemon(d.id, !effectiveEnabled)}
                        >
                          {effectiveEnabled ? 'DISABLE' : 'ENABLE'}
                        </ToolbarButton>
                      </div>
                      {d.last_output && (
                        <>
                          <div style={{ padding: '0 12px 6px' }}>
                            <ToolbarButton
                              tone="cyan"
                              onClick={() => toggleOutput(d.id)}
                            >
                              {showOut ? '▼ HIDE OUTPUT' : '▶ LAST OUTPUT'}
                            </ToolbarButton>
                          </div>
                          {showOut && (
                            <pre
                              style={{
                                margin: 0,
                                padding: '8px 12px 10px',
                                fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.45,
                                color: 'var(--ink-2)',
                                background: 'rgba(0,0,0,0.35)',
                                borderTop: '1px solid var(--line-soft)',
                                whiteSpace: 'pre-wrap',
                                maxHeight: 200,
                                overflow: 'auto',
                              }}
                            >
                              {d.last_output}
                            </pre>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </ScrollList>
            )}
          </Section>
        </PageCell>
      </PageGrid>
    </ModuleView>
  );
}

function formatMediaTime(posSec: number | null | undefined, durSec: number): string {
  const pos = posSec ?? 0;
  const mm = (n: number) => String(Math.floor(n / 60));
  const ss = (n: number) => String(Math.floor(n % 60)).padStart(2, '0');
  return `${mm(pos)}:${ss(pos)} / ${mm(durSec)}:${ss(durSec)}`;
}
