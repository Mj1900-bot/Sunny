import { KIND_ORDER } from './constants';
import type { VaultItem, VaultKind } from './types';

export function isVaultKind(k: string): k is VaultKind {
  return (KIND_ORDER as ReadonlyArray<string>).includes(k);
}

export function kindOf(item: VaultItem): VaultKind {
  return isVaultKind(item.kind) ? item.kind : 'note';
}

export function formatRelative(tsSeconds: number): string {
  const diff = Date.now() - tsSeconds * 1000;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function maskLabelLength(label: string): string {
  const approx = Math.max(8, Math.min(label.length, 24));
  return '•'.repeat(approx);
}

export function makeLocalId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Cryptographically random secret generator. Uses `crypto.getRandomValues`
 * with modulo-bias rejection sampling so every character is uniform over
 * the chosen alphabet.
 */
export function generateSecret(
  length: number,
  opts: { lower: boolean; upper: boolean; digits: boolean; symbols: boolean }
): string {
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIGITS = '0123456789';
  const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/';
  let alphabet = '';
  if (opts.lower) alphabet += LOWER;
  if (opts.upper) alphabet += UPPER;
  if (opts.digits) alphabet += DIGITS;
  if (opts.symbols) alphabet += SYMBOLS;
  if (alphabet.length === 0) alphabet = LOWER + DIGITS;
  const n = alphabet.length;
  const out: string[] = [];
  const buf = new Uint32Array(1);
  const cap = Math.floor(0xffffffff / n) * n; // reject bucket cutoff
  while (out.length < length) {
    crypto.getRandomValues(buf);
    const v = buf[0];
    if (v >= cap) continue;
    out.push(alphabet[v % n]);
  }
  return out.join('');
}

/** Entropy estimate in bits for a generated secret; ignores any pasted text. */
export function estimateEntropyBits(
  length: number,
  opts: { lower: boolean; upper: boolean; digits: boolean; symbols: boolean }
): number {
  let n = 0;
  if (opts.lower) n += 26;
  if (opts.upper) n += 26;
  if (opts.digits) n += 10;
  if (opts.symbols) n += 24;
  if (n === 0) return 0;
  return Math.round(length * Math.log2(n));
}

export function secondsUntil(epochMs: number, now: number): number {
  return Math.max(0, Math.ceil((epochMs - now) / 1000));
}

/**
 * Shannon-style entropy estimate for a pasted or typed secret. Infers the
 * effective alphabet from which character classes appear, then scores as
 * length * log2(alphabet). This is a floor — repeated or predictable
 * structure pushes true entropy lower, never higher.
 */
export function analyzeSecretEntropy(value: string): number {
  if (value.length === 0) return 0;
  let alphabet = 0;
  if (/[a-z]/.test(value)) alphabet += 26;
  if (/[A-Z]/.test(value)) alphabet += 26;
  if (/[0-9]/.test(value)) alphabet += 10;
  // Anything non-alphanumeric counts as the "symbols" class. 24 is the
  // size of the generator's symbol set and a reasonable proxy.
  if (/[^a-zA-Z0-9]/.test(value)) alphabet += 24;
  if (alphabet === 0) return 0;
  return Math.round(value.length * Math.log2(alphabet));
}

export function strengthTier(bits: number): { readonly label: string; readonly color: string } {
  if (bits === 0) return { label: 'EMPTY', color: 'var(--ink-dim)' };
  if (bits < 40) return { label: 'WEAK', color: 'var(--red)' };
  if (bits < 60) return { label: 'FAIR', color: 'var(--amber)' };
  if (bits < 90) return { label: 'GOOD', color: 'var(--cyan)' };
  if (bits < 128) return { label: 'STRONG', color: 'var(--cyan-2)' };
  return { label: 'EXCELLENT', color: 'var(--green)' };
}

export function parseRetryAfter(msg: string): number | null {
  const m = /retry=(\d+)s/.exec(msg);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function readPinSet(key: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const arr = JSON.parse(raw) as ReadonlyArray<string>;
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function writePinSet(key: string, pins: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(pins)));
  } catch {
    /* best effort */
  }
}
export function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
