/** Frontend-facing WorldState — mirrors src-tauri/src/world/model.rs. */

export type Activity =
  | 'unknown' | 'coding' | 'writing' | 'meeting' | 'browsing'
  | 'communicating' | 'media' | 'terminal' | 'designing' | 'idle';

export type FocusSnapshot = {
  app_name: string;
  bundle_id: string | null;
  window_title: string;
  focused_since_secs: number;
};

export type AppSwitch = {
  from_app: string;
  to_app: string;
  at_secs: number;
};

export type CalendarEvent = {
  id: string;
  title: string;
  start_iso: string;
  end_iso: string;
  location?: string | null;
  calendar_name?: string | null;
  notes?: string | null;
};

export type WorldState = {
  schema_version: number;
  timestamp_ms: number;
  local_iso: string;
  host: string;
  os_version: string;
  focus: FocusSnapshot | null;
  focused_duration_secs: number;
  activity: Activity;
  recent_switches: ReadonlyArray<AppSwitch>;
  next_event: CalendarEvent | null;
  events_today: number;
  mail_unread: number | null;
  cpu_pct: number;
  temp_c: number;
  mem_pct: number;
  battery_pct: number | null;
  battery_charging: boolean | null;
  revision: number;
};

export const ACTIVITY_TONE: Record<Activity, 'cyan' | 'amber' | 'violet' | 'green' | 'red' | 'pink' | 'gold' | 'teal' | 'blue' | 'lime'> = {
  unknown: 'cyan',
  coding: 'green',
  writing: 'violet',
  meeting: 'amber',
  browsing: 'teal',
  communicating: 'pink',
  media: 'gold',
  terminal: 'lime',
  designing: 'cyan',
  idle: 'cyan',
};
