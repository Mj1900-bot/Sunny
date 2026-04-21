import { PERMISSION_PATTERN } from './constants';
import type { MessageContact } from './types';

export { normaliseHandle } from '../../lib/handles';

export function firstLetter(value: string): string {
  const ch = value.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : '#';
}

export function avatarLetter(value: string): string {
  const ch = value.trim().charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(ch) ? ch : '#';
}

export function contactKey(c: MessageContact): string {
  return `${c.handle}-${c.last_ts}`;
}

export function isPermissionError(message: string): boolean {
  return PERMISSION_PATTERN.test(message);
}

export function relativeTime(unixSeconds: number): string {
  if (unixSeconds <= 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

