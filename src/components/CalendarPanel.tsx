import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from './Panel';
import { invoke, invokeSafe, isTauri } from '../lib/tauri';
import { toast } from '../hooks/useToast';

type Tone = 'normal' | 'amber' | 'now';

type PanelEvent = Readonly<{
  time: string;
  title: string;
  sub: string;
  tone: Tone;
}>;

type StoredEvent = Readonly<{
  id: string;
  dayISO: string;
  time: string;
  title: string;
  sub: string;
  tone: Tone;
}>;

const STORAGE_KEY = 'sunny.events.v2';
const LEGACY_STORAGE_KEYS = ['sunny.events.v1'] as const;
const REFRESH_MS = 60_000;

const CALENDAR_SCRIPT = `set output to ""
tell application "Calendar"
  set today to (current date)
  set todayStart to today - (time of today)
  set todayEnd to todayStart + (1 * days)
  repeat with cal in calendars
    repeat with ev in (every event of cal whose start date ≥ todayStart and start date < todayEnd)
      set t to (time string of (start date of ev))
      set s to (summary of ev)
      set output to output & t & "|" & s & linefeed
    end repeat
  end repeat
end tell
return output`;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isTone(v: unknown): v is Tone {
  return v === 'normal' || v === 'amber' || v === 'now';
}

function sanitizeStored(raw: unknown): StoredEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  if (typeof r.dayISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.dayISO)) return null;
  if (typeof r.time !== 'string' || typeof r.title !== 'string') return null;
  const sub = typeof r.sub === 'string' ? r.sub : '';
  const tone: Tone = isTone(r.tone) ? r.tone : 'normal';
  return { id: r.id, dayISO: r.dayISO, time: r.time, title: r.title, sub, tone };
}

function loadLocalToday(): ReadonlyArray<StoredEvent> {
  try {
    if (typeof localStorage !== 'undefined') {
      for (const legacy of LEGACY_STORAGE_KEYS) {
        if (localStorage.getItem(legacy) !== null) localStorage.removeItem(legacy);
      }
    }
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const iso = todayISO();
    return parsed
      .map(sanitizeStored)
      .filter((e): e is StoredEvent => e !== null && e.dayISO === iso);
  } catch (error) {
    console.error('CalendarPanel: failed to read localStorage:', error);
    return [];
  }
}

function isPermissionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('not authorized') ||
    lower.includes('not allowed') ||
    lower.includes('-1743') ||
    lower.includes('permission') ||
    lower.includes('privacy')
  );
}

function normalizeTime(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const ampm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i.exec(trimmed);
  if (ampm) {
    const hRaw = Number.parseInt(ampm[1] ?? '0', 10);
    const m = ampm[2] ?? '00';
    const suffix = (ampm[3] ?? '').toUpperCase();
    const h = suffix === 'PM' ? (hRaw % 12) + 12 : hRaw % 12;
    return `${pad2(h)}:${m}`;
  }
  const h24 = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(trimmed);
  if (h24) {
    return `${pad2(Number.parseInt(h24[1] ?? '0', 10))}:${h24[2] ?? '00'}`;
  }
  return trimmed;
}

function parseAppleScriptEvents(raw: string): ReadonlyArray<PanelEvent> {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map<PanelEvent>(line => {
      const sep = line.indexOf('|');
      const timeRaw = sep === -1 ? line : line.slice(0, sep);
      const title = sep === -1 ? '' : line.slice(sep + 1).trim();
      return {
        time: normalizeTime(timeRaw),
        title,
        sub: '',
        tone: 'normal',
      };
    })
    .filter(ev => ev.title.length > 0);
}

const AMBER_KEYWORDS = ['demo', 'exec', 'board', 'exec prep'] as const;

function minutesFromHHMM(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number.parseInt(m[1] ?? '0', 10);
  const mm = Number.parseInt(m[2] ?? '0', 10);
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  return h * 60 + mm;
}

function computeTone(time: string, title: string, now: Date): Tone {
  const eventMin = minutesFromHHMM(time);
  if (eventMin !== null) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (Math.abs(eventMin - nowMin) <= 30) return 'now';
  }
  const lowerTitle = title.toLowerCase();
  if (AMBER_KEYWORDS.some(kw => lowerTitle.includes(kw))) return 'amber';
  return 'normal';
}

function timeSortKey(time: string): number {
  const min = minutesFromHHMM(time);
  if (min !== null) return min;
  if (time.toUpperCase() === 'NOW') return -1;
  return Number.POSITIVE_INFINITY;
}

function dedupKey(ev: { time: string; title: string }): string {
  return `${ev.time.toLowerCase()}|${ev.title.trim().toLowerCase()}`;
}

function mergeEvents(
  local: ReadonlyArray<StoredEvent>,
  remote: ReadonlyArray<PanelEvent>,
  now: Date,
): ReadonlyArray<PanelEvent> {
  const seen = new Set<string>();
  const merged: PanelEvent[] = [];

  for (const ev of local) {
    const key = dedupKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    const tone: Tone = ev.tone !== 'normal' ? ev.tone : computeTone(ev.time, ev.title, now);
    merged.push({ time: ev.time, title: ev.title, sub: ev.sub, tone });
  }

  for (const ev of remote) {
    const key = dedupKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      time: ev.time,
      title: ev.title,
      sub: 'CALENDAR.APP',
      tone: computeTone(ev.time, ev.title, now),
    });
  }

  return [...merged].sort((a, b) => timeSortKey(a.time) - timeSortKey(b.time));
}

function nextQuarterHour(): string {
  const d = new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toIsoAt(time: string, durationMin: number): { start: string; end: string } | null {
  const min = minutesFromHHMM(time);
  if (min === null) return null;
  const start = new Date();
  start.setHours(Math.floor(min / 60), min % 60, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function openCalendarApp(): Promise<void> {
  if (!isTauri) return;
  await invokeSafe<void>('open_app', { name: 'Calendar' });
}

export function CalendarPanel() {
  const [events, setEvents] = useState<ReadonlyArray<PanelEvent>>([]);
  const [tick, setTick] = useState(0);
  const [addingOpen, setAddingOpen] = useState(false);
  const [draftTime, setDraftTime] = useState<string>(() => nextQuarterHour());
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const now = new Date();
      const local = loadLocalToday();

      let remote: ReadonlyArray<PanelEvent> = [];
      if (isTauri) {
        try {
          const raw = await invoke<string>('applescript', { script: CALENDAR_SCRIPT });
          remote = parseAppleScriptEvents(raw);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isPermissionError(message)) {
            console.error('CalendarPanel: AppleScript failed:', error);
          }
        }
      }

      if (cancelled) return;
      setEvents(mergeEvents(local, remote, now));
    };

    void load();
    const handle = window.setInterval(() => {
      setTick(t => t + 1);
      void load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [refreshKey]);

  const badge = useMemo(() => `${events.length} EVENTS`, [events.length]);

  const toned = useMemo<ReadonlyArray<PanelEvent>>(() => {
    if (tick === 0) return events;
    const now = new Date();
    return events.map(ev => ({ ...ev, tone: computeTone(ev.time, ev.title, now) }));
  }, [events, tick]);

  const resetDraft = useCallback(() => {
    setDraftTime(nextQuarterHour());
    setDraftTitle('');
    setAddingOpen(false);
  }, []);

  const saveDraft = useCallback(async () => {
    const title = draftTitle.trim();
    const time = normalizeTime(draftTime);
    if (!title || !time) {
      toast.error('Need a time and a title.');
      return;
    }
    setSaving(true);
    try {
      const iso = toIsoAt(time, 60);
      if (isTauri && iso) {
        try {
          await invoke<unknown>('calendar_create_event', {
            title,
            startIso: iso.start,
            endIso: iso.end,
            calendarName: null,
            location: null,
            notes: null,
          });
          toast.success(`Added · ${time} ${title}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('CalendarPanel: create_event failed, falling back to local', error);
          saveLocal(title, time);
          toast.info(`Saved locally (Calendar: ${message.slice(0, 40)}…)`);
        }
      } else {
        saveLocal(title, time);
        toast.success(`Added · ${time} ${title}`);
      }
      resetDraft();
      setRefreshKey(k => k + 1);
    } finally {
      setSaving(false);
    }
  }, [draftTime, draftTitle, resetDraft]);

  const rightControls = useMemo(() => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        className="hdr-chip"
        onClick={() => setAddingOpen(o => !o)}
        title="Quick-add event"
      >
        {addingOpen ? '×' : '+ NEW'}
      </button>
      <span style={{ color: 'var(--ink-2)' }}>{badge}</span>
    </span>
  ), [addingOpen, badge]);

  return (
    <Panel id="p-cal" title="TODAY" right={rightControls}>
      <div className="cal">
        {addingOpen && (
          <div className="cal-add">
            <input
              type="time"
              value={draftTime}
              onChange={e => setDraftTime(e.target.value)}
              className="cal-add-time"
              aria-label="Event time"
            />
            <input
              type="text"
              value={draftTitle}
              onChange={e => setDraftTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void saveDraft(); if (e.key === 'Escape') resetDraft(); }}
              placeholder="Event title…"
              className="cal-add-title"
              autoFocus
              aria-label="Event title"
            />
            <button
              type="button"
              className="hdr-chip"
              onClick={() => void saveDraft()}
              disabled={saving}
            >
              {saving ? '…' : 'SAVE'}
            </button>
          </div>
        )}
        {toned.length === 0 ? (
          <div
            style={{
              margin: 'auto',
              fontFamily: 'var(--display)',
              letterSpacing: '0.3em',
              color: 'var(--ink-dim)',
              fontSize: 13,
              fontWeight: 700,
              textAlign: 'center',
              padding: '24px 0',
            }}
          >
            NO EVENTS TODAY
          </div>
        ) : (
          toned.map((e, i) => (
            <div
              key={`${e.time}-${e.title}-${i}`}
              className={`ev clickable ${e.tone === 'normal' ? '' : e.tone}`}
              onClick={() => { void openCalendarApp(); }}
              title="Open in Calendar.app"
            >
              <div className="time">{e.time}</div>
              <div className="tx">
                {e.title}
                <small
                  style={e.sub === 'CALENDAR.APP' ? { color: 'var(--ink-dim)' } : undefined}
                >
                  {e.sub}
                </small>
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

function saveLocal(title: string, time: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list: StoredEvent[] = Array.isArray(parsed)
      ? parsed
        .map(sanitizeStored)
        .filter((e): e is StoredEvent => e !== null)
      : [];
    const entry: StoredEvent = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      dayISO: todayISO(),
      time,
      title,
      sub: 'SUNNY',
      tone: 'normal',
    };
    list.push(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    console.error('CalendarPanel: failed to save local event', error);
  }
}
