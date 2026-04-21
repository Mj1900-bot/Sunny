import type { Entry, KindFilter, KindColor } from './types';
import { CODE_EXTS, DOC_EXTS, IMG_EXTS, DATA_EXTS, ARCHIVE_EXTS } from './constants';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function getExt(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function kindLabel(entry: Entry): string {
  if (entry.is_dir) return 'DIR';
  const ext = getExt(entry.name);
  return ext ? `.${ext}` : 'FILE';
}

export function kindBucket(entry: Entry): KindFilter {
  if (entry.is_dir) return 'dir';
  const ext = getExt(entry.name);
  if (CODE_EXTS.has(ext)) return 'code';
  if (DOC_EXTS.has(ext)) return 'doc';
  if (IMG_EXTS.has(ext)) return 'img';
  if (DATA_EXTS.has(ext)) return 'data';
  return 'other';
}

export function kindColor(entry: Entry): KindColor {
  if (entry.is_dir) return 'cyan';
  const ext = getExt(entry.name);
  if (CODE_EXTS.has(ext)) return 'cyan';
  if (DOC_EXTS.has(ext)) return 'amber';
  if (IMG_EXTS.has(ext)) return 'green';
  if (DATA_EXTS.has(ext)) return 'violet';
  if (ARCHIVE_EXTS.has(ext)) return 'red';
  return 'dim';
}

export const KIND_STYLES: Record<KindColor, { color: string; border: string; bg: string }> = {
  cyan: { color: 'var(--cyan)', border: 'var(--line-soft)', bg: 'rgba(57, 229, 255, 0.08)' },
  amber: { color: 'var(--amber)', border: 'rgba(255, 179, 71, 0.3)', bg: 'rgba(255, 179, 71, 0.08)' },
  green: { color: 'var(--green)', border: 'rgba(125, 255, 154, 0.3)', bg: 'rgba(125, 255, 154, 0.08)' },
  violet: { color: 'var(--violet)', border: 'rgba(180, 140, 255, 0.3)', bg: 'rgba(180, 140, 255, 0.08)' },
  red: { color: 'var(--red)', border: 'rgba(255, 77, 94, 0.3)', bg: 'rgba(255, 77, 94, 0.08)' },
  dim: { color: 'var(--ink-dim)', border: 'var(--line-soft)', bg: 'rgba(111, 159, 178, 0.06)' },
};

export function fmtRelative(secs: number, nowSecs: number): string {
  if (!secs) return '—';
  const diff = Math.max(0, nowSecs - secs);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)}mo ago`;
  return `${Math.floor(diff / 86400 / 365)}y ago`;
}

export function splitSegments(path: string): ReadonlyArray<{ label: string; path: string }> {
  if (path === '~' || path === '') return [{ label: '~', path: '~' }];
  const startsWithHome = path.startsWith('~/');
  const startsWithRoot = path.startsWith('/');
  const body = startsWithHome ? path.slice(2) : startsWithRoot ? path.slice(1) : path;
  const parts = body.split('/').filter(Boolean);
  const prefix = startsWithHome ? '~' : startsWithRoot ? '' : '';
  const out: Array<{ label: string; path: string }> = [];
  out.push({ label: startsWithHome ? '~' : startsWithRoot ? '/' : '·', path: startsWithRoot ? '/' : '~' });
  let acc = prefix;
  for (const p of parts) {
    acc = acc === '' ? `/${p}` : `${acc}/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}

export function parentPath(path: string): string | null {
  if (path === '~' || path === '/' || path === '') return null;
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  if (parent === '' || parent === '~') return '~';
  return parent;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return trimmed;
  return trimmed.slice(idx + 1);
}

export function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir.endsWith('/')) return `${dir}${name}`;
  return `${dir}/${name}`;
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage full / disabled — ignore */
  }
}
