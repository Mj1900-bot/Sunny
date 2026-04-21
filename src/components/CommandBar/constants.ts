import type { ViewKey } from '../../store/view';

export const RECENT_KEY = 'sunny.cmdk.recent.v1';
export const RECENT_MAX = 5;
export const THEME_ORDER = ['cyan', 'amber', 'green', 'violet', 'magenta'] as const;

export const NAV_TARGETS: ReadonlyArray<{ view: ViewKey; label: string }> = [
  { view: 'overview', label: 'Overview' },
  { view: 'files', label: 'Files' },
  { view: 'apps', label: 'Apps' },
  { view: 'memory', label: 'Memory' },
  { view: 'calendar', label: 'Calendar' },
  { view: 'contacts', label: 'Contacts' },
  { view: 'web', label: 'Web' },
  { view: 'scan', label: 'Scan' },
  { view: 'vault', label: 'Vault' },
  { view: 'auto', label: 'Auto' },
  { view: 'screen', label: 'Screen' },
];
