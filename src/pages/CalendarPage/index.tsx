import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ModuleView } from '../../components/ModuleView';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';
import { askSunny } from '../../lib/askSunny';
import { useCalendarStateSync, type CalendarViewMode } from '../../hooks/usePageStateSync';
import type { SunnyNavAction } from '../../hooks/useNavBridge';

import type { CalEvent, TauriEvent, Tone, ViewMode } from './types';
import { MONTH_NAMES } from './constants';
import {
  toISO, fromISO, toLocalDateTimeISO, loadLocalEvents, saveLocalEvents,
  loadHiddenCalendars, saveHiddenCalendars, makeLocalId, mondayIndex,
  addDays, buildMonthGrid, buildWeekDays, normalizeTauriEvent, calendarColor,
} from './utils';
import { navBtnStyle } from './styles';

import { CalendarSidebar } from './components/CalendarSidebar';
import { CalendarMonthGrid } from './components/CalendarMonthGrid';
import { CalendarWeekView } from './components/CalendarWeekView';
import { CalendarRightPane } from './components/CalendarRightPane';
import { CalendarAgenda } from './components/CalendarAgenda';
import { CalendarForm } from './components/CalendarForm';
import { JumpToDateModal } from './components/JumpToDateModal';

export function CalendarPage() {
  const [today, setToday] = useState<Date>(() => new Date());
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [selectedISO, setSelectedISO] = useState<string>(() => toISO(new Date()));
  const [viewMode, setViewMode] = useState<ViewMode>('MONTH');

  const [localEvents, setLocalEvents] = useState<ReadonlyArray<CalEvent>>(() => loadLocalEvents());
  const [remoteEvents, setRemoteEvents] = useState<ReadonlyArray<CalEvent>>([]);
  const [calendars, setCalendars] = useState<ReadonlyArray<string>>([]);
  const [hiddenCalendars, setHiddenCalendars] = useState<ReadonlySet<string>>(() => loadHiddenCalendars());
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [draftDay, setDraftDay] = useState<string>(() => toISO(new Date()));
  const [draftTime, setDraftTime] = useState('');
  const [draftDuration, setDraftDuration] = useState('60');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftSub, setDraftSub] = useState('');
  const [draftTone, setDraftTone] = useState<Tone>('normal');
  const [draftTarget, setDraftTarget] = useState<string>('LOCAL');

  const [jumpOpen, setJumpOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(null);
  const reloadTokenRef = useRef(0);

  useEffect(() => { saveHiddenCalendars(hiddenCalendars); }, [hiddenCalendars]);

  // Push the Calendar page's visible state to the Rust backend so the
  // agent's `page_state_calendar` tool can answer "what am I looking at".
  const calendarViewMode: CalendarViewMode = viewMode === 'WEEK'
    ? 'week'
    : viewMode === 'AGENDA' ? 'day' : 'month';
  const hiddenCalendarList = useMemo(
    () => Array.from(hiddenCalendars).slice(0, 32),
    [hiddenCalendars],
  );
  const calendarSnapshot = useMemo(() => ({
    active_date: selectedISO,
    view_mode: calendarViewMode,
    hidden_calendars: hiddenCalendarList,
  }), [selectedISO, calendarViewMode, hiddenCalendarList]);
  useCalendarStateSync(calendarSnapshot);

  useEffect(() => {
    const t = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const showToast = useCallback((tone: 'ok' | 'err', msg: string) => {
    setToast({ tone, msg });
    window.setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 2200);
  }, []);

  // ---- macOS calendar list ---------------------------------------------------

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    (async () => {
      const list = await invokeSafe<string[]>('calendar_list_calendars');
      if (cancelled) return;
      if (list && list.length > 0) {
        setCalendars(list);
        setDraftTarget(prev => (prev === 'LOCAL' ? list[0] : prev));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- macOS events for visible range ----------------------------------------

  const visibleRange = useMemo(() => {
    const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = addDays(monthStart, -mondayIndex(monthStart));
    const gridEnd = addDays(gridStart, 42);
    return {
      startISO: toLocalDateTimeISO(gridStart),
      endISO: toLocalDateTimeISO(addDays(gridEnd, 7)),
    };
  }, [anchor]);

  const refreshRemote = useCallback(async () => {
    await Promise.resolve();
    if (!isTauri) return;
    reloadTokenRef.current += 1;
    const token = reloadTokenRef.current;
    setRemoteBusy(true);
    setRemoteErr(null);
    try {
      const result = await invoke<TauriEvent[]>('calendar_list_events', {
        startIso: visibleRange.startISO,
        endIso: visibleRange.endISO,
        calendarName: null,
        limit: 500,
      });
      if (token !== reloadTokenRef.current) return;
      setRemoteBusy(false);
      const now = new Date();
      setRemoteEvents(result.map(e => normalizeTauriEvent(e, now)));
    } catch (e) {
      if (token !== reloadTokenRef.current) return;
      setRemoteBusy(false);
      const raw = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
      const looksLikePermission = /calendar access required|not authorized|-1743|privacy/i.test(raw);
      setRemoteErr(
        looksLikePermission
          ? 'Calendar access required — System Settings → Privacy & Security → Automation → Sunny → enable Calendar'
          : `Calendar load failed — ${raw}`
      );
      setRemoteEvents([]);
    }
  }, [visibleRange]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refreshRemote(); }, [refreshRemote]);

  // ---- derived data ----------------------------------------------------------

  const allEvents = useMemo<ReadonlyArray<CalEvent>>(() => {
    const visibleRemote = remoteEvents.filter(e => !hiddenCalendars.has(e.source));
    return [...localEvents, ...visibleRemote];
  }, [localEvents, remoteEvents, hiddenCalendars]);

  const grid = useMemo(() => buildMonthGrid(anchor), [anchor]);
  const todayISO = toISO(today);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const ev of allEvents) {
      const list = map.get(ev.dayISO);
      if (list) list.push(ev); else map.set(ev.dayISO, [ev]);
    }
    for (const [, list] of map) {
      list.sort((a, b) => {
        if (a.time === 'ALL-DAY' && b.time !== 'ALL-DAY') return -1;
        if (b.time === 'ALL-DAY' && a.time !== 'ALL-DAY') return 1;
        if (a.time === 'NOW') return -1;
        if (b.time === 'NOW') return 1;
        return a.time.localeCompare(b.time);
      });
    }
    return map;
  }, [allEvents]);

  const selectedEvents = useMemo(
    () => eventsByDay.get(selectedISO) ?? [],
    [eventsByDay, selectedISO],
  );

  const weekStats = useMemo(() => {
    const weekStart = addDays(today, -mondayIndex(today));
    let total = 0, amber = 0, now = 0;
    for (let i = 0; i < 7; i++) {
      const iso = toISO(addDays(weekStart, i));
      const list = eventsByDay.get(iso) ?? [];
      total += list.length;
      for (const ev of list) {
        if (ev.tone === 'amber') amber++;
        if (ev.tone === 'now') now++;
      }
    }
    return { total, amber, now };
  }, [eventsByDay, today]);

  const agendaGroups = useMemo(() => {
    const groups: Array<{ iso: string; date: Date; events: ReadonlyArray<CalEvent> }> = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i);
      const iso = toISO(d);
      const list = eventsByDay.get(iso) ?? [];
      if (list.length > 0) groups.push({ iso, date: d, events: list });
    }
    return groups;
  }, [eventsByDay, today]);

  const weekDays = useMemo(() => buildWeekDays(anchor), [anchor]);

  // ---- navigation ------------------------------------------------------------

  const handlePrevMonth = useCallback(() => {
    setAnchor(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }, []);

  const handleNextMonth = useCallback(() => {
    setAnchor(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }, []);

  const handlePrevYear = useCallback(() => {
    setAnchor(prev => new Date(prev.getFullYear() - 1, prev.getMonth(), 1));
  }, []);

  const handleNextYear = useCallback(() => {
    setAnchor(prev => new Date(prev.getFullYear() + 1, prev.getMonth(), 1));
  }, []);

  const handleJumpToday = useCallback(() => {
    const now = new Date();
    setAnchor(viewMode === 'WEEK' ? now : new Date(now.getFullYear(), now.getMonth(), 1));
    const iso = toISO(now);
    setSelectedISO(iso);
    setDraftDay(iso);
  }, [viewMode]);

  const handleSelectISO = useCallback((iso: string) => {
    setSelectedISO(iso);
    setDraftDay(iso);
    setAnchor(prev => {
      const next = fromISO(iso);
      if (viewMode === 'WEEK') return next;
      if (prev.getFullYear() === next.getFullYear() && prev.getMonth() === next.getMonth()) return prev;
      return new Date(next.getFullYear(), next.getMonth(), 1);
    });
  }, [viewMode]);

  const handleJumpToDate = useCallback((iso: string) => {
    handleSelectISO(iso);
  }, [handleSelectISO]);

  const handleOpenForm = useCallback(() => {
    setDraftDay(selectedISO);
    setDraftTime('');
    setDraftTitle('');
    setDraftSub('');
    setDraftTone('normal');
    setDraftDuration('60');
    setFormOpen(true);
  }, [selectedISO]);

  const handleCancelForm = useCallback(() => {
    setFormOpen(false);
  }, []);

  // ---- quick-create (drag) ---------------------------------------------------

  const handleQuickCreate = useCallback((dayISO: string, startHour: number, endHour: number) => {
    const hh = String(startHour).padStart(2, '0');
    const dur = String((endHour - startHour) * 60);
    setDraftDay(dayISO);
    setDraftTime(`${hh}:00`);
    setDraftDuration(dur);
    setDraftTitle('');
    setDraftSub('');
    setDraftTone('normal');
    setFormOpen(true);
  }, []);

  // ---- AI ask brief ----------------------------------------------------------

  const handleAskBriefToday = useCallback(() => {
    const todayEvents = eventsByDay.get(todayISO) ?? [];
    const lines = todayEvents.map(e => `- ${e.time} ${e.title}${e.location ? ` @ ${e.location}` : ''}`);
    const prompt = lines.length > 0
      ? `Summarize my day for ${todayISO}:\n${lines.join('\n')}`
      : `I have no events today (${todayISO}). Give me a brief heads-up and suggest how to use the time.`;
    askSunny(prompt, 'CalendarPage:today-brief');
  }, [eventsByDay, todayISO]);

  const handleAskBriefWeek = useCallback(() => {
    const weekStart = addDays(today, -mondayIndex(today));
    const lines: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const iso = toISO(d);
      const evs = eventsByDay.get(iso) ?? [];
      if (evs.length > 0) {
        lines.push(`${iso}: ${evs.map(e => e.title).join(', ')}`);
      }
    }
    const prompt = lines.length > 0
      ? `Give me a brief for this week's calendar:\n${lines.join('\n')}`
      : `I have no events this week. Suggest how to plan the week.`;
    askSunny(prompt, 'CalendarPage:week-brief');
  }, [eventsByDay, today]);

  // ---- keyboard shortcuts ---------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        if (e.key === 'Escape' && formOpen) {
          e.preventDefault();
          setFormOpen(false);
        }
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1);
        const next = toISO(addDays(fromISO(selectedISO), delta));
        handleSelectISO(next);
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); handleOpenForm(); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); handleOpenForm(); return; }
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); handleJumpToday(); return; }
      if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setJumpOpen(true); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (jumpOpen) { setJumpOpen(false); return; }
        if (formOpen) setFormOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedISO, formOpen, jumpOpen, handleSelectISO, handleOpenForm, handleJumpToday]);

  // ---- create ----------------------------------------------------------------

  const handleSave = useCallback(async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const title = draftTitle.trim();
    const time = draftTime.trim();
    const day = draftDay.trim();
    if (title.length === 0 || time.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;

    if (draftTarget === 'LOCAL') {
      const next: CalEvent = {
        id: makeLocalId(),
        dayISO: day,
        time,
        title,
        sub: draftSub.trim(),
        tone: draftTone,
        source: 'LOCAL',
      };
      setLocalEvents(prev => {
        const merged = [...prev, next];
        saveLocalEvents(merged);
        return merged;
      });
      handleSelectISO(day);
      setFormOpen(false);
      showToast('ok', 'SAVED · LOCAL DRAFT');
      return;
    }

    const [hh, mm] = time.split(':').map(n => Number.parseInt(n, 10));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
      showToast('err', 'INVALID TIME');
      return;
    }
    const startDate = fromISO(day);
    startDate.setHours(hh, mm, 0, 0);
    const dur = Math.max(5, Math.min(24 * 60, Number.parseInt(draftDuration, 10) || 60));
    const endDate = new Date(startDate.getTime() + dur * 60_000);

    const r = await invokeSafe<TauriEvent>('calendar_create_event', {
      title,
      startIso: toLocalDateTimeISO(startDate),
      endIso: toLocalDateTimeISO(endDate),
      calendarName: draftTarget,
      location: draftSub.trim() || null,
      notes: null,
    });
    if (r === null) { showToast('err', 'CREATE FAILED'); return; }
    showToast('ok', `SAVED · ${draftTarget.toUpperCase()}`);
    handleSelectISO(day);
    setFormOpen(false);
    void refreshRemote();
  }, [draftDay, draftTime, draftTitle, draftSub, draftTone, draftDuration, draftTarget, showToast, refreshRemote, handleSelectISO]);

  // ---- delete ----------------------------------------------------------------

  const handleDelete = useCallback(async (ev: CalEvent) => {
    const ok = window.confirm(`Delete "${ev.title}"?`);
    if (!ok) return;
    if (ev.source === 'LOCAL') {
      setLocalEvents(prev => {
        const next = prev.filter(x => x.id !== ev.id);
        saveLocalEvents(next);
        return next;
      });
      showToast('ok', 'DELETED · LOCAL');
      return;
    }
    const r = await invokeSafe<void>('calendar_delete_event', {
      id: ev.id,
      calendarName: ev.source,
    });
    if (r === null) showToast('err', 'DELETE FAILED');
    else {
      showToast('ok', `DELETED · ${ev.source.toUpperCase()}`);
      void refreshRemote();
    }
  }, [showToast, refreshRemote]);

  const toggleHidden = useCallback((name: string) => {
    setHiddenCalendars(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  // ── agent page_action listener ──────────────────────────────────────────
  // Handles `sunny://nav.action` events scoped to this page. Actions:
  //   jump_to_date        {iso}                         → handleJumpToDate()
  //   create_event        {title,start?,end?,...}       → pre-populate form
  //   filter_by_calendar  {name, hidden?:boolean}       → toggleHidden()
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<SunnyNavAction>;
      const { view, action, args } = ce.detail ?? ({} as SunnyNavAction);
      if (view !== 'calendar') return;
      switch (action) {
        case 'jump_to_date': {
          const iso = typeof args?.iso === 'string' ? args.iso : '';
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
            handleJumpToDate(iso);
          }
          break;
        }
        case 'create_event': {
          const title = typeof args?.title === 'string' ? args.title : '';
          const start = typeof args?.start === 'string' ? args.start : '';
          // Pre-fill + open the form so the user still confirms via Save.
          // We intentionally do NOT call `calendar_create_event` here —
          // that tool is already separately gated through ConfirmGate.
          setDraftDay(/^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : selectedISO);
          setDraftTime(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start) ? start.slice(11, 16) : '');
          setDraftTitle(title);
          setDraftSub('');
          setDraftTone('normal');
          setDraftDuration('60');
          setFormOpen(true);
          break;
        }
        case 'filter_by_calendar': {
          const name = typeof args?.name === 'string' ? args.name : '';
          if (!name) return;
          setHiddenCalendars(prev => {
            const next = new Set(prev);
            const wantHidden = typeof args?.hidden === 'boolean' ? args.hidden : !prev.has(name);
            if (wantHidden) next.add(name);
            else next.delete(name);
            return next;
          });
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('sunny:nav.action', handler);
    return () => window.removeEventListener('sunny:nav.action', handler);
  }, [handleJumpToDate, selectedISO]);

  const header = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;
  const badge = `${allEvents.length} EVENTS · ${viewMode}${remoteBusy ? ' · SYNC…' : ''}`;

  const formElement = (
    <CalendarForm
      draftDay={draftDay} setDraftDay={setDraftDay}
      draftTime={draftTime} setDraftTime={setDraftTime}
      draftDuration={draftDuration} setDraftDuration={setDraftDuration}
      draftTitle={draftTitle} setDraftTitle={setDraftTitle}
      draftSub={draftSub} setDraftSub={setDraftSub}
      draftTarget={draftTarget} setDraftTarget={setDraftTarget}
      draftTone={draftTone} setDraftTone={setDraftTone}
      calendars={calendars}
      onSave={handleSave}
      onCancel={handleCancelForm}
    />
  );

  return (
    <ModuleView title="CALENDAR" badge={badge}>

      {/* Top header row with title, calendar color legend, and action buttons */}
      <div
        className="section"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          flexShrink: 0,
          borderLeft: '2px solid var(--cyan)',
          background: 'linear-gradient(90deg, rgba(57, 229, 255, 0.04), transparent 70%)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
          <div style={{
            fontFamily: 'var(--display)', letterSpacing: '0.22em',
            color: 'var(--cyan)', fontSize: 14, fontWeight: 800,
          }}>
            {header}
          </div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em',
            color: 'var(--ink-dim)',
          }}>
            {viewMode === 'AGENDA'
              ? 'AGENDA · NEXT 14 DAYS'
              : viewMode === 'WEEK'
                ? `WEEK · ${fromISO(selectedISO).toDateString().toUpperCase()}`
                : `SELECTED · ${fromISO(selectedISO).toDateString().toUpperCase()}`}
          </div>
        </div>

        {/* Calendar color legend chip strip */}
        {calendars.length > 0 && (
          <div style={{
            display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center',
            flex: 1, minWidth: 0,
            paddingLeft: 12, borderLeft: '1px solid var(--line-soft)',
          }}>
            {calendars.map(name => {
              const hidden = hiddenCalendars.has(name);
              const color = calendarColor(name);
              return (
                <button
                  key={name}
                  onClick={() => toggleHidden(name)}
                  aria-pressed={!hidden}
                  title={hidden ? `Show ${name}` : `Hide ${name}`}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 8px',
                    border: `1px solid ${hidden ? 'var(--line-soft)' : color}`,
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    letterSpacing: '0.1em',
                    color: hidden ? 'var(--ink-dim)' : color,
                    opacity: hidden ? 0.45 : 1,
                    background: hidden ? 'transparent' : `${color}1a`,
                    transition: 'opacity 140ms ease, background 140ms ease, border-color 140ms ease',
                  }}
                  onMouseEnter={e => {
                    if (hidden) return;
                    e.currentTarget.style.background = `${color}33`;
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = hidden ? 'transparent' : `${color}1a`;
                  }}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: 2,
                    background: hidden ? 'transparent' : color,
                    border: `1px solid ${color}`,
                  }} />
                  {name.toUpperCase()}
                </button>
              );
            })}
          </div>
        )}

        {/* AI brief buttons */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => void refreshRemote()}
            disabled={remoteBusy}
            style={{
              ...navBtnStyle, padding: '5px 10px',
              opacity: remoteBusy ? 0.5 : 1, cursor: remoteBusy ? 'wait' : 'pointer',
            }}
            title="Reload events from Calendar"
            onMouseEnter={e => { if (!remoteBusy) e.currentTarget.style.background = 'rgba(57, 229, 255, 0.1)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            ↻ SYNC
          </button>
          <button
            type="button"
            onClick={handleAskBriefToday}
            style={{ ...navBtnStyle, color: 'var(--violet)', borderColor: 'var(--violet)', padding: '5px 10px' }}
            title="Ask Sunny to summarize today"
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180, 140, 255, 0.12)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            ⬡ TODAY
          </button>
          <button
            type="button"
            onClick={handleAskBriefWeek}
            style={{ ...navBtnStyle, color: 'var(--violet)', borderColor: 'var(--violet)', padding: '5px 10px' }}
            title="Ask Sunny to summarize the week"
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180, 140, 255, 0.12)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            ⬡ WEEK
          </button>
        </div>
      </div>

      {/* Permission banner */}
      {isTauri && remoteErr && (
        <div
          className="section"
          role="alert"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderColor: 'var(--amber)',
            borderLeft: '3px solid var(--amber)',
            background: 'rgba(255, 179, 71, 0.08)',
            color: 'var(--amber)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.1em',
            flexShrink: 0,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13 }}>⚠</span>
            <span>{remoteErr}</span>
          </span>
          <button
            type="button"
            onClick={() => void refreshRemote()}
            style={{ ...navBtnStyle, color: 'var(--amber)', borderColor: 'var(--amber)', padding: '5px 12px' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255, 179, 71, 0.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            RETRY
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', minHeight: 0, flex: 1 }}>
        <CalendarSidebar
          anchor={anchor}
          viewMode={viewMode}
          calendars={calendars}
          hiddenCalendars={hiddenCalendars}
          remoteErr={remoteErr}
          eventsByDay={eventsByDay}
          todayISO={todayISO}
          selectedISO={selectedISO}
          onPrevYear={handlePrevYear}
          onNextYear={handleNextYear}
          onPrevMonth={handlePrevMonth}
          onNextMonth={handleNextMonth}
          onJumpToday={handleJumpToday}
          onSetViewMode={setViewMode}
          onRefreshRemote={refreshRemote}
          onToggleHidden={toggleHidden}
          onSelectISO={handleSelectISO}
        />
        {viewMode === 'AGENDA' ? (
          <CalendarAgenda
            agendaGroups={agendaGroups}
            todayISO={todayISO}
            weekStats={weekStats}
            formOpen={formOpen}
            onOpenForm={handleOpenForm}
            onDeleteEvent={handleDelete}
            formElement={formElement}
          />
        ) : viewMode === 'WEEK' ? (
          <>
            <CalendarWeekView
              weekDays={weekDays}
              todayISO={todayISO}
              selectedISO={selectedISO}
              eventsByDay={eventsByDay}
              onSelect={handleSelectISO}
              onSetAnchor={setAnchor}
              onQuickCreate={handleQuickCreate}
            />
            <CalendarRightPane
              selectedISO={selectedISO}
              selectedEvents={selectedEvents}
              weekStats={weekStats}
              formOpen={formOpen}
              onOpenForm={handleOpenForm}
              onDeleteEvent={handleDelete}
              formElement={formElement}
            />
          </>
        ) : (
          <>
            <CalendarMonthGrid
              grid={grid}
              anchor={anchor}
              todayISO={todayISO}
              selectedISO={selectedISO}
              eventsByDay={eventsByDay}
              onSelect={handleSelectISO}
              onQuickCreate={handleQuickCreate}
            />
            <CalendarRightPane
              selectedISO={selectedISO}
              selectedEvents={selectedEvents}
              weekStats={weekStats}
              formOpen={formOpen}
              onOpenForm={handleOpenForm}
              onDeleteEvent={handleDelete}
              formElement={formElement}
            />
          </>
        )}
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            right: 16,
            bottom: 14,
            padding: '9px 16px',
            border: `1px solid ${toast.tone === 'err' ? 'var(--red)' : 'var(--cyan)'}`,
            borderLeft: `3px solid ${toast.tone === 'err' ? 'var(--red)' : 'var(--cyan)'}`,
            background: toast.tone === 'err'
              ? 'rgba(255, 77, 94, 0.12)'
              : 'rgba(6, 14, 22, 0.96)',
            color: toast.tone === 'err' ? 'var(--red)' : 'var(--cyan)',
            fontFamily: 'var(--display)',
            fontSize: 10,
            letterSpacing: '0.22em',
            fontWeight: 700,
            pointerEvents: 'none',
            boxShadow: toast.tone === 'err'
              ? '0 4px 24px rgba(255, 77, 94, 0.25)'
              : '0 4px 24px rgba(57, 229, 255, 0.22)',
            animation: 'sunnyToastIn 220ms ease-out',
          }}
        >
          {toast.tone === 'err' ? '✕ ' : '◉ '}{toast.msg}
          <style>{`@keyframes sunnyToastIn {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
          }`}</style>
        </div>
      )}

      {jumpOpen && (
        <JumpToDateModal
          onJump={handleJumpToDate}
          onClose={() => setJumpOpen(false)}
        />
      )}
    </ModuleView>
  );
}
