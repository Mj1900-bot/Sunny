import { useEffect } from 'react';
import { invokeSafe, listen } from '../lib/tauri';
import { useView, type ViewKey } from '../store/view';

type NavActionPayload = {
  readonly view: string;
  readonly action: string;
  readonly args?: Record<string, unknown>;
};

/**
 * Human-readable labels for each ViewKey, written into Tauri-managed
 * state so the backend's `page_peek` command (→ the agent's
 * `current_page_state` tool) can say "you're on the Calendar page"
 * instead of just "calendar". The labels mirror the navigation panel's
 * copy exactly.
 */
const VIEW_TITLES: Readonly<Record<ViewKey, string>> = Object.freeze({
  overview: 'Overview',
  today: 'Today',
  timeline: 'Timeline',
  security: 'Security',
  tasks: 'Tasks',
  journal: 'Journal',
  focus: 'Focus',
  calendar: 'Calendar',
  inbox: 'Inbox',
  people: 'People',
  contacts: 'Contacts',
  voice: 'Voice',
  notify: 'Notifications',
  notes: 'Notes',
  reading: 'Reading',
  memory: 'Memory',
  photos: 'Photos',
  files: 'Files',
  auto: 'Auto',
  skills: 'Skills',
  apps: 'Apps',
  web: 'Web',
  code: 'Code',
  console: 'Console',
  screen: 'Screen',
  scan: 'Scan',
  world: 'World',
  society: 'Society',
  brain: 'Brain',
  persona: 'Persona',
  inspector: 'Inspector',
  audit: 'Audit',
  devices: 'Devices',
  diagnostics: 'Diagnostics',
  vault: 'Vault',
  settings: 'Settings',
  brainstorm: 'Brainstorm',
  cost: 'Cost',
});

const VALID_VIEW_KEYS = new Set<string>(Object.keys(VIEW_TITLES));

function isViewKey(v: string): v is ViewKey {
  return VALID_VIEW_KEYS.has(v);
}

/**
 * Wire the agent-side `navigate_to_page` / `page_action` tools into the
 * HUD:
 *
 *   1. Listen for `sunny://nav.goto` from the Rust `navigate_to_page`
 *      dispatch arm; call `setView` with the requested ViewKey.
 *   2. Re-broadcast `sunny://nav.action` as a `window` CustomEvent
 *      (`sunny:nav.action`) so per-page effects can pick up actions
 *      scoped to their own view.
 *   3. Mirror every `view` change into the backend via
 *      `nav_set_current` so the `current_page_state` tool can tell the
 *      agent what's on screen.
 *
 * Mount from `Dashboard` exactly once (rules-of-hooks compliant).
 */
export function useNavBridge(): void {
  const view = useView(s => s.view);
  const setView = useView(s => s.setView);

  // 1 · `sunny://nav.goto` → setView
  useEffect(() => {
    let cancelled = false;
    const pending = listen<string>('sunny://nav.goto', v => {
      if (cancelled) return;
      if (typeof v !== 'string' || !isViewKey(v)) {
        console.warn('[useNavBridge] ignoring invalid nav.goto payload', v);
        return;
      }
      setView(v);
    });
    return () => {
      cancelled = true;
      void pending.then(fn => fn && fn());
    };
  }, [setView]);

  // 2 · `sunny://nav.action` → rebroadcast as window CustomEvent
  //     Pages subscribe with `window.addEventListener('sunny:nav.action', …)`
  //     so they don't each pay the Tauri event listener setup cost.
  useEffect(() => {
    let cancelled = false;
    const pending = listen<NavActionPayload>('sunny://nav.action', payload => {
      if (cancelled) return;
      if (!payload || typeof payload !== 'object') return;
      if (typeof payload.view !== 'string' || typeof payload.action !== 'string') return;
      window.dispatchEvent(
        new CustomEvent<NavActionPayload>('sunny:nav.action', { detail: payload }),
      );
    });
    return () => {
      cancelled = true;
      void pending.then(fn => fn && fn());
    };
  }, []);

  // 3 · Mirror current view into backend state for `page_peek`.
  useEffect(() => {
    const title = VIEW_TITLES[view] ?? view;
    void invokeSafe<void>('nav_set_current', {
      view,
      title,
    });
  }, [view]);
}

/** Payload shape for the rebroadcast `sunny:nav.action` CustomEvent. */
export type SunnyNavAction = NavActionPayload;
