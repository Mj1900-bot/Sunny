import type { KindFilter, VaultKind } from './types';

export const REVEAL_SECONDS = 10;
export const CLIPBOARD_CLEAR_SECONDS = 10;

/** Idle time after which the vault re-seals itself. Activity = any keyboard/mouse input inside the app. */
export const IDLE_AUTOSEAL_SECONDS = 5 * 60;

/** Items older than this (and never rotated) get a gentle "review rotation" hint. */
export const ROTATION_HINT_DAYS = 90;

export const KIND_COLORS: Readonly<Record<VaultKind, string>> = {
  api_key: 'var(--cyan)',
  password: 'var(--red)',
  token: 'var(--amber)',
  ssh: 'var(--green)',
  note: 'var(--violet)',
};

export const KIND_LABELS: Readonly<Record<VaultKind, string>> = {
  api_key: 'API KEY',
  password: 'PASSWORD',
  token: 'TOKEN',
  ssh: 'SSH',
  note: 'NOTE',
};

/** Short glyphs for visual kind-anchoring. Kept monospace-compatible. */
export const KIND_GLYPHS: Readonly<Record<VaultKind, string>> = {
  api_key: '⌘',
  password: '✱',
  token: '◆',
  ssh: '⟆',
  note: '¶',
};

export const KIND_ORDER: ReadonlyArray<VaultKind> = [
  'api_key',
  'password',
  'token',
  'ssh',
  'note',
];

export const FILTER_ORDER: ReadonlyArray<KindFilter> = ['all', ...KIND_ORDER];

export const PIN_STORAGE_KEY = 'sunny.vault.pins.v1';
export const SORT_STORAGE_KEY = 'sunny.vault.sort.v1';
export const BLUR_SEAL_STORAGE_KEY = 'sunny.vault.blurSeal.v1';

/** Duration the value stays on-screen during a "copy-and-go" reveal. */
export const QUICK_COPY_VISIBLE_MS = 600;
