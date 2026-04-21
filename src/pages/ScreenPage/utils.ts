import type { ScreenImage, ActivityKind, AutoCadence, DragRect, PermissionStatus } from './types';

export function makeId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowTime(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fileTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatAge(ms: number): string {
  if (ms < 1000) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function kindColor(kind: ActivityKind): string {
  switch (kind) {
    case 'SNAP':  return 'var(--green)';
    case 'OCR':   return 'var(--cyan-2)';
    case 'WIN':   return 'var(--cyan)';
    case 'FOCUS': return 'var(--amber)';
    case 'CLICK': return 'var(--violet)';
    case 'IDLE':  return 'var(--ink-dim)';
    case 'ERR':   return 'var(--red)';
    case 'SYS':
    default:      return 'var(--ink-2)';
  }
}

export function cadenceToMs(c: AutoCadence): number | null {
  switch (c) {
    case '5s':  return 5000;
    case '15s': return 15000;
    case '60s': return 60000;
    case 'OFF':
    default:    return null;
  }
}

export function dataUrl(img: ScreenImage): string {
  return `data:image/${img.format};base64,${img.base64}`;
}

export function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  return fallback;
}

/** Escape a string for safe inclusion inside an AppleScript double-quoted literal. */
export function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function downloadPng(img: ScreenImage, name: string): Promise<void> {
  const bin = atob(img.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: `image/${img.format}` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyImageToClipboard(img: ScreenImage): Promise<boolean> {
  try {
    if (!('clipboard' in navigator) || !('write' in navigator.clipboard)) return false;
    const bin = atob(img.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: `image/${img.format}` });
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!ClipboardItemCtor) return false;
    await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (!('clipboard' in navigator) || !('writeText' in navigator.clipboard)) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Normalize a drag rect so u0<=u1, v0<=v1, and clip to [0..1]. */
export function normalizeDrag(r: DragRect): DragRect {
  const u0 = clamp01(Math.min(r.u0, r.u1));
  const v0 = clamp01(Math.min(r.v0, r.v1));
  const u1 = clamp01(Math.max(r.u0, r.u1));
  const v1 = clamp01(Math.max(r.v0, r.v1));
  return { u0, v0, u1, v1 };
}

export function dragIsMeaningful(r: DragRect): boolean {
  const n = normalizeDrag(r);
  return n.u1 - n.u0 > 0.01 && n.v1 - n.v0 > 0.01;
}

/**
 * The Rust side surfaces a few distinct phrases when screencapture fails
 * because macOS's TCC system hasn't granted Screen Recording. We sniff
 * any of them so we can show a big, actionable banner instead of a
 * generic toast.
 */
export function isScreenRecordingPermissionError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes('screen recording permission') ||
    m.includes('screen recording may be missing') ||
    m.includes('no stderr — likely screen recording') ||
    m.includes('no stderr - likely screen recording') ||
    m.includes('produced an empty file') ||
    m.includes('zero dimensions') ||
    // \`screencapture\` itself returns this in some macOS versions
    m.includes('operation not permitted')
  );
}

export function statusColor(s: PermissionStatus): string {
  switch (s) {
    case 'granted': return 'var(--green)';
    case 'missing': return 'var(--red)';
    case 'checking': return 'var(--amber)';
    case 'unknown':
    default:        return 'var(--ink-dim)';
  }
}

export function statusText(s: PermissionStatus): string {
  switch (s) {
    case 'granted':  return 'GRANTED';
    case 'missing':  return 'MISSING';
    case 'checking': return 'CHECKING…';
    case 'unknown':
    default:         return 'UNKNOWN';
  }
}
