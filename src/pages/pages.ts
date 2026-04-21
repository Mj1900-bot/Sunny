import { lazy, type ComponentType } from 'react';
import type { ViewKey } from '../store/view';
// Side-effect import: installs the useAgentStore subscription that records
// terminal agent runs into history. Must happen at app boot, not lazily.
import '../store/agentHistory';

/**
 * Module pages are lazy-loaded so they are not part of the initial HUD bundle.
 * Each page ships as its own chunk and only fetches when the user navigates to it.
 *
 * Note: React.lazy requires a default export shape, so we adapt each named
 * export into a `{ default: ... }` module on the fly. The original files stay
 * untouched (they keep their named exports).
 */
const lazyPage = (
  loader: () => Promise<Record<string, ComponentType>>,
  exportName: string,
): ComponentType =>
  lazy(async () => {
    const mod = await loader();
    return { default: mod[exportName] };
  });

export const PAGES: Partial<Record<ViewKey, ComponentType>> = {
  // ── CORE ─────────────────────────────────────────────────────────────
  today:     lazyPage(() => import('./TodayPage'),     'TodayPage'),
  timeline:  lazyPage(() => import('./TimelinePage'),  'TimelinePage'),
  security:  lazyPage(() => import('./SecurityPage'),  'SecurityPage'),

  // ── LIFE ─────────────────────────────────────────────────────────────
  tasks:     lazyPage(() => import('./TasksPage'),     'TasksPage'),
  journal:   lazyPage(() => import('./JournalPage'),   'JournalPage'),
  focus:     lazyPage(() => import('./FocusPage'),     'FocusPage'),
  calendar:  lazyPage(() => import('./CalendarPage'),  'CalendarPage'),

  // ── COMMS ────────────────────────────────────────────────────────────
  inbox:     lazyPage(() => import('./InboxPage'),     'InboxPage'),
  people:    lazyPage(() => import('./PeoplePage'),    'PeoplePage'),
  contacts:  lazyPage(() => import('./ContactsPage'),  'ContactsPage'),
  voice:     lazyPage(() => import('./VoicePage'),     'VoicePage'),
  notify:    lazyPage(() => import('./NotifyPage'),    'NotifyPage'),

  // ── KNOWLEDGE ────────────────────────────────────────────────────────
  notes:     lazyPage(() => import('./NotesPage'),     'NotesPage'),
  reading:   lazyPage(() => import('./ReadingPage'),   'ReadingPage'),
  memory:    lazyPage(() => import('./MemoryPage'),    'MemoryPage'),
  photos:    lazyPage(() => import('./PhotosPage'),    'PhotosPage'),
  files:     lazyPage(() => import('./FilesPage'),     'FilesPage'),

  // ── DO ───────────────────────────────────────────────────────────────
  auto:      lazyPage(() => import('./AutoPage'),      'AutoPage'),
  skills:    lazyPage(() => import('./SkillsPage'),    'SkillsPage'),
  apps:      lazyPage(() => import('./AppsPage'),      'AppsPage'),
  web:       lazyPage(() => import('./WebPage'),       'WebPage'),
  code:      lazyPage(() => import('./CodePage'),      'CodePage'),
  console:   lazyPage(() => import('./ConsolePage'),   'ConsolePage'),
  screen:    lazyPage(() => import('./ScreenPage'),    'ScreenPage'),
  scan:      lazyPage(() => import('./ScanPage'),      'ScanPage'),

  // ── AI · SYS ─────────────────────────────────────────────────────────
  brainstorm: lazyPage(() => import('./BrainstormPage'), 'BrainstormPage'),
  world:     lazyPage(() => import('./WorldPage'),     'WorldPage'),
  society:   lazyPage(() => import('./SocietyPage'),   'SocietyPage'),
  brain:     lazyPage(() => import('./BrainPage'),     'BrainPage'),
  persona:   lazyPage(() => import('./PersonaPage'),   'PersonaPage'),
  inspector: lazyPage(() => import('./InspectorPage'), 'InspectorPage'),
  audit:     lazyPage(() => import('./AuditPage'),     'AuditPage'),
  cost:      lazyPage(() => import('./CostPage'),      'CostPage'),
  devices:     lazyPage(() => import('./DevicesPage'),     'DevicesPage'),
  diagnostics: lazyPage(() => import('./DiagnosticsPage'), 'DiagnosticsPage'),
  vault:       lazyPage(() => import('./VaultPage'),       'VaultPage'),
  settings:    lazyPage(() => import('./SettingsPage'),    'SettingsPage'),
};
