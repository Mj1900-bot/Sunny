/**
 * FOCUS — deep-work session tracker + activity read-out from world model.
 *
 * Features added:
 *   • Session heatmap: 7 days × 24h grid (opacity = focused minutes)
 *   • Distraction log: when world_get detects an unproductive app, log it
 *   • Streak badge: consecutive weekday sessions ≥ 25 min
 *   • Deep/Sprint/Flow presets with different default durations
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModuleView } from '../../components/ModuleView';
import {
  PageGrid, PageCell, Section, EmptyState, StatBlock, ScrollList,
  Chip, Row, MetricBar, usePoll, relTime, Toolbar, ToolbarButton,
} from '../_shared';
import { askSunny } from '../../lib/askSunny';
import { useFocusStateSync, type FocusMode } from '../../hooks/usePageStateSync';
import { SessionTimer } from './SessionTimer';
import { SessionHeatmap } from './SessionHeatmap';
import {
  buildHeatmap, computeFocusStreak,
  getWorld, isDistraction, loadDistractions, loadSessions,
  saveDistractions, saveSessions, focusedSecs, isPaused,
  type DistractionEntry, type SessionRecord,
} from './api';
import { buildLedgerJson, buildLedgerPlainText, downloadTextFile } from './ledgerExport';

const CHECKIN_EVERY_SECS = 20 * 60;

export function FocusPage() {
  const [sessions, setSessions] = useState<ReadonlyArray<SessionRecord>>(() => loadSessions());
  const [distractions, setDistractions] = useState<ReadonlyArray<DistractionEntry>>(() => loadDistractions());
  const { data: world, error: worldError } = usePoll(getWorld, 4000);
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  const [ledgerHint, setLedgerHint] = useState<string | null>(null);
  const lastAppRef = useRef<string | null>(null);
  const ledgerHintTimer = useRef<number | null>(null);

  const flashLedgerHint = useCallback((msg: string) => {
    if (ledgerHintTimer.current != null) window.clearTimeout(ledgerHintTimer.current);
    setLedgerHint(msg);
    ledgerHintTimer.current = window.setTimeout(() => {
      setLedgerHint(null);
      ledgerHintTimer.current = null;
    }, 2200);
  }, []);

  useEffect(() => () => {
    if (ledgerHintTimer.current != null) window.clearTimeout(ledgerHintTimer.current);
  }, []);

  const copyLedger = useCallback(async () => {
    const body = buildLedgerPlainText(sessions, distractions, nowSecs);
    try {
      await navigator.clipboard.writeText(body);
      flashLedgerHint('Copied ledger to clipboard');
    } catch {
      flashLedgerHint('Copy failed — use export');
    }
  }, [sessions, distractions, nowSecs, flashLedgerHint]);

  const exportLedgerJson = useCallback(() => {
    const body = buildLedgerJson(sessions, distractions);
    const day = new Date().toISOString().slice(0, 10);
    downloadTextFile(`sunny-focus-ledger-${day}.json`, body, 'application/json;charset=utf-8');
    flashLedgerHint('Downloaded JSON');
  }, [sessions, distractions, flashLedgerHint]);

  useEffect(() => { saveSessions(sessions); }, [sessions]);
  useEffect(() => { saveDistractions(distractions); }, [distractions]);

  useEffect(() => {
    let handle: number | null = null;
    const start = () => {
      if (handle != null) return;
      handle = window.setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1000);
    };
    const stop = () => { if (handle != null) { clearInterval(handle); handle = null; } };
    const onVis = () => { if (document.hidden) stop(); else { setNowSecs(Math.floor(Date.now() / 1000)); start(); } };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const active = sessions.find(s => s.end == null) ?? null;
  const activePaused = active != null && isPaused(active);

  // Push the Focus page's visible state to the Rust backend so the
  // agent's `page_state_focus` tool can answer "am I in a session".
  const focusMode: FocusMode = useMemo(() => {
    if (!active?.targetSecs) return null;
    const mins = Math.round(active.targetSecs / 60);
    if (mins <= 30) return 'sprint';
    if (mins <= 60) return 'flow';
    return 'deep';
  }, [active]);
  const elapsedForSnapshot = active
    ? Math.max(0, focusedSecs(active, nowSecs))
    : 0;
  const focusSnapshot = useMemo(() => ({
    running: active != null && !activePaused,
    elapsed_secs: elapsedForSnapshot,
    target_secs: active?.targetSecs ?? 0,
    mode: focusMode,
  }), [active, activePaused, elapsedForSnapshot, focusMode]);
  useFocusStateSync(focusSnapshot);

  // Distraction detection from world model
  useEffect(() => {
    if (!active || activePaused || !world?.focus?.app_name) return;
    const appName = world.focus.app_name;
    if (appName === lastAppRef.current) return;
    lastAppRef.current = appName;
    if (isDistraction(appName)) {
      const entry: DistractionEntry = {
        ts: Math.floor(Date.now() / 1000),
        appName,
        windowTitle: world.focus.window_title ?? '',
      };
      setDistractions(prev => [entry, ...prev]);
      askSunny(
        `You noticed I switched to "${appName}" during my focus session on "${active.goal}". Gently call me back in one sentence.`,
        'focus-distraction',
      );
    }
  }, [world, active, activePaused]);

  const start = useCallback((goal: string, targetSecs?: number) => {
    const rec: SessionRecord = {
      id: `f-${Date.now().toString(36)}`,
      start: Math.floor(Date.now() / 1000),
      end: null,
      goal,
      targetSecs,
      pausedSecs: 0,
      pausedAt: null,
    };
    setSessions(prev => [rec, ...prev]);
    askSunny(
      `I'm starting a focus session: "${goal}". Protect me — if you see me drift into an unrelated app for more than 5 minutes, gently remind me.`,
      'focus',
    );
  }, []);

  const pause = useCallback(() => {
    const t = Math.floor(Date.now() / 1000);
    setSessions(prev => prev.map(s =>
      s.end == null && s.pausedAt == null ? { ...s, pausedAt: t } : s,
    ));
  }, []);

  const resume = useCallback(() => {
    const t = Math.floor(Date.now() / 1000);
    setSessions(prev => prev.map(s => {
      if (s.end != null || s.pausedAt == null) return s;
      const added = Math.max(0, t - s.pausedAt);
      return { ...s, pausedAt: null, pausedSecs: (s.pausedSecs ?? 0) + added };
    }));
  }, []);

  const stop = useCallback(() => {
    const t = Math.floor(Date.now() / 1000);
    setSessions(prev => prev.map(s => {
      if (s.end != null) return s;
      const extraPaused = s.pausedAt != null ? Math.max(0, t - s.pausedAt) : 0;
      return { ...s, end: t, pausedAt: null, pausedSecs: (s.pausedSecs ?? 0) + extraPaused };
    }));
  }, []);

  // Auto check-in
  const lastCheckinBucket = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!active || activePaused) return;
    const focused = focusedSecs(active, nowSecs);
    const bucket = Math.floor(focused / CHECKIN_EVERY_SECS);
    const prev = lastCheckinBucket.current[active.id] ?? 0;
    if (bucket > prev && bucket >= 1) {
      lastCheckinBucket.current = { ...lastCheckinBucket.current, [active.id]: bucket };
      const minutes = bucket * (CHECKIN_EVERY_SECS / 60);
      askSunny(
        `It's been about ${minutes} minutes of focus on "${active.goal}". Check in — am I still on track? One short observation or question, please.`,
        'focus-auto',
      );
    }
  }, [active, activePaused, nowSecs]);

  const today = useMemo(() => {
    const ds = new Date(); ds.setHours(0, 0, 0, 0);
    const startOfDay = Math.floor(ds.getTime() / 1000);
    return sessions.filter(s => s.start >= startOfDay);
  }, [sessions]);

  const totalTodaySecs = useMemo(
    () => today.reduce((n, s) => n + focusedSecs(s, nowSecs), 0),
    [today, nowSecs],
  );

  const streak = useMemo(() => computeFocusStreak(sessions), [sessions]);
  const heatmap = useMemo(() => buildHeatmap(sessions, nowSecs), [sessions, nowSecs]);

  // Today's distractions only
  const todayDistStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }, []);
  const todayDistractions = distractions.filter(d => d.ts >= todayDistStart);

  return (
    <ModuleView title="FOCUS · FLOW">
      <PageGrid>
        <PageCell span={7}>
          <SessionTimer
            active={active}
            onStart={start}
            onPause={pause}
            onResume={resume}
            onStop={stop}
          />
        </PageCell>

        <PageCell span={5}>
          <Section title="LIVE ACTIVITY" right={<Chip tone="dim" style={{ fontSize: 8 }}>WORLD · 4s</Chip>}>
            {worldError ? (
              <EmptyState title="World model unavailable" hint={worldError} />
            ) : world ? (
              <>
                <Row label="activity" value={<Chip tone="cyan">{world.activity}</Chip>} />
                <Row
                  label="app"
                  value={world.focus?.app_name ?? '(none)'}
                  right={world.focus ? `${world.focused_duration_secs}s` : undefined}
                />
                <Row label="window" value={world.focus?.window_title ?? '(none)'} />
                <MetricBar label="CPU" value={`${world.cpu_pct.toFixed(0)}%`} pct={world.cpu_pct} tone="cyan" />
                {world.focus?.app_name && isDistraction(world.focus.app_name) && (
                  <div
                    role="alert"
                    style={{
                      padding: '6px 10px',
                      border: '1px solid var(--amber)',
                      borderLeft: '3px solid var(--amber)',
                      background: 'rgba(255, 193, 94, 0.09)',
                      fontFamily: 'var(--display)', fontSize: 9, color: 'var(--amber)',
                      letterSpacing: '0.24em', fontWeight: 700,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 12 }}>⚠</span>
                    <span>DISTRACTION DETECTED</span>
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="Reading world…" hint="world_get polling every 4s" />
            )}
          </Section>
        </PageCell>

        {/* Stats */}
        <PageCell span={12}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <StatBlock
              label="TODAY"
              value={`${Math.floor(totalTodaySecs / 60)}m`}
              sub={`${today.length} session${today.length === 1 ? '' : 's'}`}
              tone="green"
            />
            <StatBlock label="TOTAL" value={String(sessions.length)} sub="sessions logged" tone="cyan" />
            <StatBlock
              label="LAST"
              value={active ? (activePaused ? 'paused' : 'active') : sessions[0] ? relTime(sessions[0].start) : '—'}
              tone="amber"
            />
            <StatBlock
              label="STREAK"
              value={streak > 0 ? `${streak}d` : '—'}
              sub={streak >= 5 ? 'weekday streak' : streak > 0 ? 'keep going' : '≥25m/day to build'}
              tone={streak >= 5 ? 'green' : streak >= 2 ? 'amber' : 'teal'}
            />
          </div>
          <Toolbar style={{ marginTop: 10 }}>
            <ToolbarButton onClick={() => void copyLedger()}>COPY LEDGER</ToolbarButton>
            <ToolbarButton onClick={exportLedgerJson}>EXPORT JSON</ToolbarButton>
            {ledgerHint && <Chip tone="green" style={{ fontSize: 8 }}>{ledgerHint}</Chip>}
          </Toolbar>
        </PageCell>

        {/* Heatmap */}
        <PageCell span={12}>
          <Section title="SESSION HEATMAP" right={<Chip tone="dim" style={{ fontSize: 8 }}>7D · 24H</Chip>}>
            <SessionHeatmap matrix={heatmap} />
          </Section>
        </PageCell>

        {/* Distraction log */}
        <PageCell span={5}>
          <Section title="DISTRACTIONS TODAY" right={<Chip tone={todayDistractions.length > 0 ? 'amber' : 'dim'} style={{ fontSize: 8 }}>{todayDistractions.length}</Chip>}>
            {todayDistractions.length === 0 ? (
              <EmptyState title="Clean session" hint="No distractions detected today." />
            ) : (
              <ScrollList maxHeight={200}>
                {todayDistractions.map((d, i) => (
                  <Row
                    key={i}
                    label={<Chip tone="amber" style={{ fontSize: 8 }}>DIST</Chip>}
                    value={<b>{d.appName}</b>}
                    right={new Date(d.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    tone="amber"
                  />
                ))}
              </ScrollList>
            )}
          </Section>
        </PageCell>

        {/* Session history */}
        <PageCell span={7}>
          <Section title="HISTORY" right={<Chip tone="dim" style={{ fontSize: 8 }}>{sessions.length}</Chip>}>
            {sessions.length === 0 ? (
              <EmptyState title="No sessions yet" hint="Start one above to build your focus ledger." />
            ) : (
              <ScrollList maxHeight={200}>
                {sessions.slice(0, 40).map(s => {
                  const dur = focusedSecs(s, nowSecs);
                  const running = s.end == null;
                  const paused = running && isPaused(s);
                  const rightNode = running
                    ? <Chip tone={paused ? 'amber' : 'green'}>{paused ? 'paused' : 'active'}</Chip>
                    : `${Math.floor(dur / 60)}m`;
                  return (
                    <Row
                      key={s.id}
                      label={new Date(s.start * 1000).toLocaleString(undefined, {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                      value={<b>{s.goal || '(no goal set)'}</b>}
                      right={rightNode}
                    />
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
