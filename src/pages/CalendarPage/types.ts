export type Tone = 'normal' | 'amber' | 'now';
export type ViewMode = 'MONTH' | 'WEEK' | 'AGENDA';

/**
 * Unified event shape rendered in every view. `source` is either `"LOCAL"`
 * (a localStorage draft that never left the machine) or the name of a macOS
 * calendar ("Home", "Work", …) — the latter implies a round-trip through
 * AppleScript.
 */
export type CalEvent = {
  readonly id: string;
  readonly dayISO: string;    // YYYY-MM-DD
  readonly time: string;      // HH:MM or "NOW" / "ALL-DAY"
  readonly title: string;
  readonly sub: string;
  readonly tone: Tone;
  readonly source: string;    // "LOCAL" or calendar name
  readonly location?: string;
  readonly notes?: string;
  readonly startISO?: string; // raw start for duration calc
  readonly endISO?: string;
  readonly attendees?: ReadonlyArray<string>;
};

// Backend event shape from calendar_list_events.
export type TauriEvent = {
  readonly id: string;
  readonly title: string;
  readonly start: string;     // "YYYY-MM-DDTHH:MM:SS"
  readonly end: string;
  readonly location: string;
  readonly notes: string;
  readonly calendar: string;
  readonly all_day: boolean;
};

// Per-calendar metadata returned by calendar_list_calendars (extended form).
export type CalendarMeta = {
  readonly name: string;
  readonly color: string; // hex or CSS color from macOS
};

// Drag-create state for inline quick-create.
export type DragCreate = {
  readonly dayISO: string;
  readonly startHour: number; // 0-23
  readonly endHour: number;   // 0-23
};
