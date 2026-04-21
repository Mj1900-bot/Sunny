import { invoke, invokeSafe } from '../../lib/tauri';
import type {
  Finding,
  ProbeHit,
  ScanOptions,
  ScanProgress,
  ScanRecord,
  SignatureCatalog,
  VaultItem,
} from './types';

/**
 * Kick off a scan. Returns a `scanId` used by every subsequent poll.
 * The real work happens asynchronously on the Rust side.
 */
export function scanStart(target: string, options?: Partial<ScanOptions>): Promise<string> {
  return invoke<string>('scan_start', { target, options: options ?? null });
}

export function scanStatus(scanId: string): Promise<ScanProgress | null> {
  return invokeSafe<ScanProgress>('scan_status', { scanId });
}

export function scanFindings(scanId: string): Promise<ReadonlyArray<Finding> | null> {
  return invokeSafe<ReadonlyArray<Finding>>('scan_findings', { scanId });
}

export function scanRecord(scanId: string): Promise<ScanRecord | null> {
  return invokeSafe<ScanRecord>('scan_record', { scanId });
}

export function scanAbort(scanId: string): Promise<void> {
  return invoke<void>('scan_abort', { scanId });
}

export async function scanList(): Promise<ReadonlyArray<ScanRecord>> {
  const out = await invokeSafe<ReadonlyArray<ScanRecord>>('scan_list');
  return out ?? [];
}

export function scanQuarantine(scanId: string, findingId: string): Promise<VaultItem> {
  return invoke<VaultItem>('scan_quarantine', { scanId, findingId });
}

export async function scanVaultList(): Promise<ReadonlyArray<VaultItem>> {
  const out = await invokeSafe<ReadonlyArray<VaultItem>>('scan_vault_list');
  return out ?? [];
}

export function scanVaultRestore(id: string, overwrite = false): Promise<string> {
  return invoke<string>('scan_vault_restore', { id, overwrite });
}

export function scanVaultDelete(id: string): Promise<void> {
  return invoke<void>('scan_vault_delete', { id });
}

// ---------------------------------------------------------------------------
// Native helpers
// ---------------------------------------------------------------------------

/** Show the macOS folder picker. Returns null when the user cancels. */
export function scanPickFolder(prompt?: string): Promise<string | null> {
  return invoke<string | null>('scan_pick_folder', { prompt: prompt ?? null });
}

export function scanRevealInFinder(path: string): Promise<void> {
  return invoke<void>('scan_reveal_in_finder', { path });
}

/** Enumerate the full executable paths of every running process. */
export async function scanRunningExecutables(): Promise<ReadonlyArray<string>> {
  const out = await invokeSafe<ReadonlyArray<string>>('scan_running_executables');
  return out ?? [];
}

export function scanStartMany(
  label: string,
  targets: ReadonlyArray<string>,
  options?: Partial<ScanOptions>,
): Promise<string> {
  return invoke<string>('scan_start_many', {
    label,
    targets,
    options: options ?? null,
  });
}

/**
 * Walk multiple directory roots in a single scan (used by the AGENT CONFIGS
 * preset so every known agent-rule directory on the machine is inspected
 * in one pass). Missing roots are silently skipped on the Rust side.
 */
export function scanStartRoots(
  label: string,
  roots: ReadonlyArray<string>,
  options?: Partial<ScanOptions>,
): Promise<string> {
  return invoke<string>('scan_start_roots', {
    label,
    roots,
    options: options ?? null,
  });
}

/**
 * Fetch the curated 2024-2026 threat database — malware families, malicious
 * script patterns, and prompt-injection signatures the scanner matches
 * against in addition to online MalwareBazaar / VirusTotal hash lookups.
 * Safe to call frequently — the Rust side builds this from a static table.
 */
export function scanSignatureCatalog(): Promise<SignatureCatalog | null> {
  return invokeSafe<SignatureCatalog>('scan_signature_catalog');
}

/**
 * Run an ad-hoc signature probe against the threat DB without starting a
 * full scan. Any subset of (filename, text, sha256) may be supplied.
 * Returns the list of signature entries that matched.
 */
export function scanSignatureProbe(args: {
  filename?: string;
  text?: string;
  sha256?: string;
}): Promise<ReadonlyArray<ProbeHit>> {
  return invoke<ReadonlyArray<ProbeHit>>('scan_signature_probe', {
    filename: args.filename ?? null,
    text: args.text ?? null,
    sha256: args.sha256 ?? null,
  });
}
