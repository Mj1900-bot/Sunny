/**
 * Today page aggregates from five different backends. Each call is
 * safe-wrapped so the page renders useful partials even if one source is
 * unavailable (mail permission denied, reminders list empty, etc).
 */

import { invokeSafe } from '../../lib/tauri';
import type { WorldState } from '../WorldPage/types';

export type MailMessage = {
  id: string; from: string; subject: string; snippet: string;
  received: string; unread: boolean; account: string; mailbox: string;
};

export type MessageContact = {
  handle: string; display: string; last_message: string; last_ts: number;
  message_count: number; is_imessage: boolean; unread_count: number;
};

export type Reminder = {
  id: string; title: string; notes: string; list: string;
  completed: boolean; due: string | null; created: string | null;
};

export type CalendarEvent = {
  id: string; title: string; start_iso: string; end_iso: string;
  location?: string | null; calendar_name?: string | null;
};

export type MemoryEntry = {
  id: string; text: string; tags: string[]; created_at: string;
};

export type WeatherSnapshot = {
  city: string;
  temp_c: number;
  condition: string;
  humidity?: number;
  wind_kph?: number;
};

export type TodayBrief = {
  world: WorldState | null;
  events: ReadonlyArray<CalendarEvent>;
  unreadMail: number;
  recentMail: ReadonlyArray<MailMessage>;
  messages: ReadonlyArray<MessageContact>;
  reminders: ReadonlyArray<Reminder>;
  priorities: ReadonlyArray<MemoryEntry>;
  weather: WeatherSnapshot | null;
};

/** URGENT keyword scan — subjects that contain any of these strings are flagged. */
const URGENT_KEYWORDS = ['urgent', 'asap', 'deadline', 'overdue', 'today', 'action required', 'by eod'];

export function isUrgentMail(m: MailMessage): boolean {
  const haystack = (m.subject + ' ' + m.from).toLowerCase();
  return URGENT_KEYWORDS.some(kw => haystack.includes(kw));
}

export async function loadTodayBrief(): Promise<TodayBrief> {
  // Run everything in parallel. Any one returning null collapses to an
  // empty value — the page keeps rendering.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const [world, events, unreadMail, recentMail, messages, reminders, priorities, weather] =
    await Promise.all([
      invokeSafe<WorldState>('world_get'),
      invokeSafe<CalendarEvent[]>('calendar_list_events', {
        startIso: start.toISOString(), endIso: end.toISOString(), limit: 12,
      }),
      invokeSafe<number>('mail_unread_count'),
      invokeSafe<MailMessage[]>('mail_list_recent', { limit: 10, unreadOnly: true }),
      invokeSafe<MessageContact[]>('messages_recent', { limit: 8 }),
      invokeSafe<Reminder[]>('reminders_list', { includeCompleted: false, limit: 8 }),
      invokeSafe<MemoryEntry[]>('memory_search', { query: 'priority', limit: 3 }),
      invokeSafe<WeatherSnapshot>('tool_weather_current', { city: 'Vancouver' }),
    ]);

  return {
    world,
    events: events ?? [],
    unreadMail: unreadMail ?? 0,
    recentMail: recentMail ?? [],
    messages: messages ?? [],
    reminders: reminders ?? [],
    priorities: priorities ?? [],
    weather,
  };
}
