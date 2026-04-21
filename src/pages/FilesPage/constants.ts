// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QUICK_PATHS: ReadonlyArray<{ label: string; path: string }> = [
  { label: '~', path: '~' },
  { label: 'DOCUMENTS', path: '~/Documents' },
  { label: 'DOWNLOADS', path: '~/Downloads' },
  { label: 'DESKTOP', path: '~/Desktop' },
  { label: 'PROJECTS', path: '~/Projects' },
  { label: 'SUNNY', path: '~/Sunny Ai' },
];

export const CODE_EXTS: ReadonlySet<string> = new Set([
  'ts', 'js', 'tsx', 'jsx', 'py', 'rs', 'go', 'c', 'cpp', 'h', 'hpp',
  'java', 'kt', 'swift', 'rb', 'php', 'sh', 'zsh', 'bash', 'lua', 'sql',
]);
export const DOC_EXTS: ReadonlySet<string> = new Set(['md', 'txt', 'pdf', 'rtf', 'doc', 'docx']);
export const IMG_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic', 'tiff',
]);
export const DATA_EXTS: ReadonlySet<string> = new Set([
  'json', 'yaml', 'yml', 'csv', 'toml', 'ini', 'xml', 'plist', 'lock',
]);
export const ARCHIVE_EXTS: ReadonlySet<string> = new Set([
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso',
]);

export const LS_PINNED = 'sunny.files.pinned.v1';
export const LS_RECENTS = 'sunny.files.recents.v1';
export const LS_VIEW = 'sunny.files.view.v1';
export const LS_HIDDEN = 'sunny.files.hidden.v1';
