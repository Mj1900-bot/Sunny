import type { Category, ChipKey, App } from './types';

export const RECENT_KEY = 'sunny.apps.recent.v1';
export const FAV_KEY = 'sunny.apps.fav.v1';
export const LAUNCHES_KEY = 'sunny.apps.launches.v1';
export const VIEW_KEY = 'sunny.apps.view.v1';
export const SORT_KEY = 'sunny.apps.sort.v1';
export const RECENT_MAX = 8;

export const RUNNING_POLL_MS = 10_000;

export const CATEGORY_ORDER: readonly ChipKey[] = [
  'ALL',
  'FAVORITES',
  'RUNNING',
  'SYSTEM',
  'DEVELOPER',
  'DESIGN',
  'PRODUCTIVITY',
  'MEDIA',
  'GAMES',
  'UTILITIES',
] as const;

export const CATEGORY_TAG: Readonly<Record<Category, string>> = {
  FAVORITES: 'FAV',
  SYSTEM: 'SYS',
  DEVELOPER: 'DEV',
  DESIGN: 'DSN',
  PRODUCTIVITY: 'PRD',
  MEDIA: 'MED',
  GAMES: 'GMS',
  UTILITIES: 'UTL',
  OTHER: 'OTH',
};

export const FAKE_APPS: readonly App[] = [
  { name: 'Finder', path: '/System/Library/CoreServices/Finder.app' },
  { name: 'Safari', path: '/Applications/Safari.app' },
  { name: 'Terminal', path: '/Applications/Utilities/Terminal.app' },
  { name: 'Xcode', path: '/Applications/Xcode.app' },
  { name: 'VS Code', path: '/Applications/Visual Studio Code.app' },
  { name: 'iTerm', path: '/Applications/iTerm.app' },
  { name: 'Calendar', path: '/Applications/Calendar.app' },
  { name: 'Notes', path: '/Applications/Notes.app' },
  { name: 'Mail', path: '/Applications/Mail.app' },
  { name: 'Photos', path: '/System/Applications/Photos.app' },
  { name: 'Music', path: '/System/Applications/Music.app' },
  { name: 'QuickTime Player', path: '/System/Applications/QuickTime Player.app' },
  { name: 'Figma', path: '/Applications/Figma.app' },
  { name: 'Sketch', path: '/Applications/Sketch.app' },
  { name: 'System Settings', path: '/System/Applications/System Settings.app' },
  { name: 'Activity Monitor', path: '/System/Applications/Utilities/Activity Monitor.app' },
] as const;

export const DEV_PAT = /(xcode|vs ?code|visual studio|terminal|iterm|warp|docker|postman|insomnia|sublime|atom|intellij|pycharm|webstorm|android studio|github|sourcetree|tower|fork|ghostty|kitty|alacritty|cursor|zed)/i;
export const DESIGN_PAT = /(figma|sketch|photoshop|illustrator|affinity|blender|cinema 4d|principle|framer|pixelmator|procreate|lightroom|indesign|xd)/i;
export const MEDIA_PAT = /(photos|music|quicktime|vlc|spotify|itunes|tv|podcasts|garageband|logic|final cut|imovie|premiere|audacity|obs|plex)/i;
export const PROD_PAT = /(notes|mail|calendar|reminders|pages|numbers|keynote|word|excel|powerpoint|outlook|slack|notion|obsidian|things|todoist|fantastical|zoom|teams|linear|trello|asana)/i;
export const SYS_PAT = /(finder|system settings|system preferences|activity monitor|console|launchpad|mission control|time machine|migration assistant|keychain|network utility|dashboard|siri)/i;
export const GAMES_PAT = /(steam|game|minecraft|epic games|battle\.net|roblox|chess|solitaire)/i;
export const UTIL_PAT = /(calculator|clock|weather|stickies|preview|screenshot|voice memos|maps|contacts|facetime|messages|safari|chrome|firefox|brave|edge|arc|1password|bitwarden|the unarchiver|keka|cleanmymac|bartender|alfred|raycast|rectangle|magnet)/i;

export const ICON_FETCH_SIZE = 64;
export const ICON_FETCH_CONCURRENCY = 6;

// ── New depth features ──────────────────────────────────────────────────────

/** localStorage key for per-app timed launch events (heatmap + weekly chip). */
export const LAUNCH_EVENTS_KEY = 'sunny.apps.launch_events.v1';

/** Maximum timed-event entries kept per-app (caps storage). */
export const LAUNCH_EVENTS_MAX = 500;

/** How many days to look back for the "weekly" chip count. */
export const WEEKLY_WINDOW_DAYS = 7;

/** Bundle-ID prefix clusters for the group-detection feature. */
export const BUNDLE_GROUPS: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: 'com.adobe', label: 'Adobe' },
  { prefix: 'com.apple', label: 'Apple' },
  { prefix: 'com.jetbrains', label: 'JetBrains' },
  { prefix: 'com.microsoft', label: 'Microsoft' },
  { prefix: 'com.google', label: 'Google' },
  { prefix: 'io.github', label: 'GitHub' },
  { prefix: 'com.panic', label: 'Panic' },
  { prefix: 'com.sublimetext', label: 'Sublime' },
];
