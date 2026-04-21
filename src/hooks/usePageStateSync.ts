/**
 * usePageStateSync — push per-page visible state to the Rust backend.
 *
 * Each stateful HUD page (Calendar, Tasks, Inbox, Focus, Notes, Voice)
 * calls one of these hooks with its current visible state. The hook
 * debounces rapid changes (200 ms) and `invoke`s the matching
 * `page_state_<name>_set` command so the agent can peek at what the
 * user is actually looking at without needing screen recording.
 *
 * Snapshots are <500 bytes apiece — arrays are truncated at the call
 * site (e.g. selected_ids is limited to 32 ids) so the mutex on the
 * Rust side never balloons. Writes are fire-and-forget with
 * `invokeSafe` so a transient error never blocks the UI.
 */
import { useEffect, useRef } from 'react';
import { invokeSafe } from '../lib/tauri';

// ---------------------------------------------------------------------------
// Shared snapshot types. These mirror the structs in `page_state.rs`.
// ---------------------------------------------------------------------------

export type CalendarViewMode = 'day' | 'week' | 'month';

export interface CalendarSnapshot {
  active_date: string;
  view_mode: CalendarViewMode;
  selected_event_id?: string;
  hidden_calendars: ReadonlyArray<string>;
}

export interface TasksSnapshot {
  active_tab: string;
  selected_ids: ReadonlyArray<string>;
  filter_query: string;
  total_count: number;
  completed_count: number;
}

export interface InboxSnapshot {
  selected_item_id?: string;
  filter: string;
  triage_labels_summary: string;
}

export type FocusMode = 'sprint' | 'deep' | 'flow' | null;

export interface FocusSnapshot {
  running: boolean;
  elapsed_secs: number;
  target_secs: number;
  mode: FocusMode;
}

export interface NotesSnapshot {
  selected_note_id?: string;
  folder: string;
  search_query: string;
}

export interface VoiceSnapshot {
  recording: boolean;
  last_transcript?: string;
  clip_count: number;
}

// ---------------------------------------------------------------------------
// Generic debounced sync. Each page-specific hook is a one-line wrapper
// that pins the Tauri command name and snapshot type.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 200;

function usePageStateSyncInternal<T>(command: string, snapshot: T): void {
  const last = useRef<string | null>(null);
  // Serialize once per render so the effect dep array uses the stable string
  // rather than the object reference. Callers that pass inline object literals
  // (e.g. `{ active_tab: tab, ... }`) would otherwise cause the effect to
  // re-run on every render — the serialised dep catches only real value changes.
  const serialisedForDep = JSON.stringify(snapshot);

  useEffect(() => {
    if (last.current === serialisedForDep) return;
    const timer = window.setTimeout(() => {
      last.current = serialisedForDep;
      void invokeSafe(command, { snapshot: JSON.parse(serialisedForDep) as T });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, serialisedForDep]);
}

// ---------------------------------------------------------------------------
// Per-page hooks
// ---------------------------------------------------------------------------

export function useCalendarStateSync(snapshot: CalendarSnapshot): void {
  usePageStateSyncInternal('page_state_calendar_set', snapshot);
}

export function useTasksStateSync(snapshot: TasksSnapshot): void {
  usePageStateSyncInternal('page_state_tasks_set', snapshot);
}

export function useInboxStateSync(snapshot: InboxSnapshot): void {
  usePageStateSyncInternal('page_state_inbox_set', snapshot);
}

export function useFocusStateSync(snapshot: FocusSnapshot): void {
  usePageStateSyncInternal('page_state_focus_set', snapshot);
}

export function useNotesStateSync(snapshot: NotesSnapshot): void {
  usePageStateSyncInternal('page_state_notes_set', snapshot);
}

export function useVoiceStateSync(snapshot: VoiceSnapshot): void {
  usePageStateSyncInternal('page_state_voice_set', snapshot);
}
