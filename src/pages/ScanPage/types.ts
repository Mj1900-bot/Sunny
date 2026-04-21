// Wire-compatible with src-tauri/src/scan/types.rs.
//
// The core wire types — Verdict, SignalKind, Signal, Finding, ScanPhase,
// ScanProgress, ScanOptions, ScanRecord, VaultItem — are re-exported
// from the auto-generated ts-rs bindings (`src/bindings/*.ts`).
// Regenerate with `cd src-tauri && cargo test --lib export_bindings_`.
//
// The signature-catalog types + UI presentation helpers below are
// frontend-only shapes that don't cross the Rust boundary directly
// (they're returned by dedicated catalog / probe commands whose
// Rust-side structs live outside the ts-rs export set).

import type { Verdict } from '../../bindings/Verdict';
import type { SignalKind } from '../../bindings/SignalKind';
import type { Signal } from '../../bindings/Signal';
import type { Finding } from '../../bindings/Finding';
import type { ScanPhase } from '../../bindings/ScanPhase';
import type { ScanProgress } from '../../bindings/ScanProgress';
import type { ScanOptions } from '../../bindings/ScanOptions';
import type { ScanRecord } from '../../bindings/ScanRecord';
import type { VaultItem } from '../../bindings/VaultItem';

export type {
  Verdict,
  SignalKind,
  Signal,
  Finding,
  ScanPhase,
  ScanProgress,
  ScanOptions,
  ScanRecord,
  VaultItem,
};

// ---------------------------------------------------------------------------
// Signature catalog (exposed via scan_signature_catalog)
// ---------------------------------------------------------------------------

export type SignatureCategory =
  | 'malware_family'
  | 'malicious_script'
  | 'prompt_injection'
  | 'agent_exfil';

export type SignatureEntry = Readonly<{
  id: string;
  name: string;
  category: SignatureCategory;
  yearSeen: number;
  platforms: ReadonlyArray<string>;
  description: string;
  references: ReadonlyArray<string>;
  weight: Verdict;
}>;

export type CategoryCount = Readonly<{
  category: SignatureCategory;
  count: number;
}>;

export type SignatureCatalog = Readonly<{
  version: string;
  updated: string;
  total: number;
  /** Count of offline SHA-256 prefixes — known-bad hashes we recognise without the network. */
  offlineHashPrefixes: number;
  byCategory: ReadonlyArray<CategoryCount>;
  entries: ReadonlyArray<SignatureEntry>;
}>;

export type ProbeHit = Readonly<{
  id: string;
  name: string;
  category: SignatureCategory;
  weight: Verdict;
  excerpt: string;
  offset: number | null;
}>;

export const CATEGORY_META: Record<SignatureCategory, { label: string; blurb: string; color: string }> = {
  malware_family: {
    label: 'MALWARE FAMILY',
    blurb: 'Known 2020-2026 macOS malware families — Atomic Stealer, Banshee, XCSSET, Lazarus, NotLockBit, and more.',
    color: '#ff6a6a',
  },
  malicious_script: {
    label: 'MALICIOUS SCRIPT',
    blurb: 'Language-agnostic attacker behaviours: keychain dumps, curl|sh loaders, base64 decode-and-exec.',
    color: 'var(--amber)',
  },
  prompt_injection: {
    label: 'PROMPT INJECTION',
    blurb: 'LLM attacks from the OWASP LLM01 family — DAN/STAN/AIM jailbreaks, fake system roles, invisible Unicode smuggling.',
    color: 'var(--cyan)',
  },
  agent_exfil: {
    label: 'AGENT EXFIL',
    blurb: 'Indirect prompt injection that tricks AI agents into leaking data via tool calls or rendered images.',
    color: '#d76bff',
  },
};

// ---------------------------------------------------------------------------
// UI presentation helpers
// ---------------------------------------------------------------------------

export const VERDICT_META: Record<Verdict, { label: string; color: string; bg: string; border: string }> = {
  clean: {
    label: 'CLEAN',
    color: 'rgb(120, 255, 170)',
    bg: 'rgba(120, 255, 170, 0.08)',
    border: 'rgba(120, 255, 170, 0.45)',
  },
  info: {
    label: 'INFO',
    color: 'var(--cyan)',
    bg: 'rgba(57, 229, 255, 0.08)',
    border: 'rgba(57, 229, 255, 0.45)',
  },
  suspicious: {
    label: 'SUSPICIOUS',
    color: 'var(--amber)',
    bg: 'rgba(255, 179, 71, 0.10)',
    border: 'rgba(255, 179, 71, 0.55)',
  },
  malicious: {
    label: 'MALICIOUS',
    color: '#ff6a6a',
    bg: 'rgba(255, 106, 106, 0.12)',
    border: 'rgba(255, 106, 106, 0.65)',
  },
  unknown: {
    label: 'UNKNOWN',
    color: 'var(--ink-dim)',
    bg: 'rgba(120, 170, 200, 0.06)',
    border: 'var(--line-soft)',
  },
};

export const SIGNAL_LABEL: Record<SignalKind, string> = {
  malware_bazaar_hit: 'MalwareBazaar',
  virustotal_hit: 'VirusTotal',
  quarantined: 'Quarantined',
  unsigned: 'Unsigned',
  risky_path: 'Risky path',
  recently_modified: 'Recent',
  executable: 'Executable',
  unusual_script: 'Unusual script',
  size_anomaly: 'Size anomaly',
  hidden_in_user_dir: 'Hidden',
  known_malware_family: 'Known family',
  prompt_injection: 'Prompt injection',
};

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRelativeSecs(secs: number): string {
  const diff = Date.now() / 1000 - secs;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function shortPath(path: string, max = 60): string {
  if (path.length <= max) return path;
  const parts = path.split('/');
  if (parts.length <= 3) return path.slice(0, max - 1) + '…';
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}
