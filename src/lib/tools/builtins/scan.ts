// Virus scanner tool bindings for the agent loop. Lets SUNNY initiate a
// scan, poll its status, fetch findings, and inspect the quarantine vault
// on the user's voice/chat command.

import { invokeSafe } from '../../tauri';
import {
  abortedResult,
  isParseError,
  isRecord,
  optionalNumber,
  rejectUnknown,
  requireString,
  truncate,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

// ---------------------------------------------------------------------------
// Kick off a scan
// ---------------------------------------------------------------------------

type ScanProgress = {
  readonly phase: string;
  readonly filesDiscovered: number;
  readonly filesInspected: number;
  readonly clean: number;
  readonly info: number;
  readonly suspicious: number;
  readonly malicious: number;
};

/**
 * Starts a scan and polls until it finishes (with a wall-clock cap so the
 * agent never blocks indefinitely on a giant tree).
 */
export const scanStartTool: Tool = {
  schema: {
    name: 'scan_start',
    description:
      'Start an AI virus scan on a file or folder. Returns a live progress summary once the scan completes or the time cap elapses.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Absolute path to scan. Examples: ~/Downloads, /Applications/Suspicious.app.',
        },
        recursive: {
          type: 'boolean',
          description: 'Descend into subdirectories. Defaults to true.',
        },
        online_lookup: {
          type: 'boolean',
          description:
            'Cross-check each hash against MalwareBazaar. Defaults to true.',
        },
        deep: {
          type: 'boolean',
          description:
            'Hash every file instead of just those with risk signals. Slower but thorough.',
        },
        wait_seconds: {
          type: 'integer',
          description:
            'How long to wait for completion before returning a snapshot. Defaults to 45.',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, [
      'target',
      'recursive',
      'online_lookup',
      'deep',
      'wait_seconds',
    ]);
    if (unknown) return validationFailure(started, unknown.message);

    const target = requireString(input, 'target');
    if (isParseError(target)) return validationFailure(started, target.message);

    const waitSecs = optionalNumber(input, 'wait_seconds');
    if (isParseError(waitSecs)) return validationFailure(started, waitSecs.message);
    const waitCap = Math.max(1, Math.min(300, waitSecs ?? 45));

    // Build options via loose mapping — the invokeSafe layer already serializes
    // these into the Rust ScanOptions struct shape (camelCase).
    const options = {
      recursive: input['recursive'] ?? true,
      onlineLookup: input['online_lookup'] ?? true,
      virustotal: false,
      deep: input['deep'] ?? false,
      maxFileSize: 100 * 1024 * 1024,
    };

    if (signal.aborted) return abortedResult('scan_start', started, 'before');
    const scanId = await invokeSafe<string>('scan_start', { target, options });
    if (!scanId) {
      return {
        ok: false,
        content: `Failed to start scan on ${target}`,
        latency_ms: Date.now() - started,
      };
    }

    const deadline = Date.now() + waitCap * 1000;
    let last: ScanProgress | null = null;
    while (Date.now() < deadline) {
      if (signal.aborted) return abortedResult('scan_start', started, 'after');
      const p = await invokeSafe<ScanProgress>('scan_status', { scanId });
      if (p) {
        last = p;
        if (p.phase === 'done' || p.phase === 'aborted' || p.phase === 'errored') {
          break;
        }
      }
      await sleep(750);
    }

    if (!last) {
      return {
        ok: true,
        content: `scan_id=${scanId} — no progress yet, still running`,
        data: { scanId },
        latency_ms: Date.now() - started,
      };
    }

    const summary = `${last.phase.toUpperCase()} · ${last.filesInspected}/${last.filesDiscovered} inspected · ${last.malicious} malicious, ${last.suspicious} suspicious, ${last.info} info`;
    return {
      ok: true,
      content: truncate(summary),
      data: { scanId, progress: last },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// List findings for a scan
// ---------------------------------------------------------------------------

export const scanFindingsTool: Tool = {
  schema: {
    name: 'scan_findings',
    description: 'List findings for a scan id. Elides CLEAN files.',
    input_schema: {
      type: 'object',
      properties: {
        scan_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['scan_id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['scan_id', 'limit']);
    if (unknown) return validationFailure(started, unknown.message);
    const scanId = requireString(input, 'scan_id');
    if (isParseError(scanId)) return validationFailure(started, scanId.message);
    const limit = optionalNumber(input, 'limit');
    if (isParseError(limit)) return validationFailure(started, limit.message);
    const cap = Math.max(1, Math.min(500, limit ?? 50));

    if (signal.aborted) return abortedResult('scan_findings', started, 'before');
    const findings = await invokeSafe<ReadonlyArray<unknown>>('scan_findings', { scanId });
    if (!findings) {
      return {
        ok: false,
        content: `No scan ${scanId}`,
        latency_ms: Date.now() - started,
      };
    }
    const trimmed = findings.slice(0, cap);
    return {
      ok: true,
      content: truncate(
        `${findings.length} findings for ${scanId} (returning first ${trimmed.length})`,
      ),
      data: trimmed,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Quarantine a finding
// ---------------------------------------------------------------------------

export const scanQuarantineTool: Tool = {
  schema: {
    name: 'scan_quarantine',
    description:
      'Move a flagged finding into the virus vault (atomic move + chmod 000).',
    input_schema: {
      type: 'object',
      properties: {
        scan_id: { type: 'string' },
        finding_id: { type: 'string' },
      },
      required: ['scan_id', 'finding_id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['scan_id', 'finding_id']);
    if (unknown) return validationFailure(started, unknown.message);
    const scanId = requireString(input, 'scan_id');
    if (isParseError(scanId)) return validationFailure(started, scanId.message);
    const findingId = requireString(input, 'finding_id');
    if (isParseError(findingId)) return validationFailure(started, findingId.message);

    if (signal.aborted) return abortedResult('scan_quarantine', started, 'before');
    const item = await invokeSafe<{ readonly id: string; readonly originalPath: string }>(
      'scan_quarantine',
      { scanId, findingId },
    );
    if (!item) {
      return {
        ok: false,
        content: `Failed to quarantine ${findingId}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: truncate(`quarantined ${item.originalPath} → vault_id=${item.id}`),
      data: item,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Vault listing
// ---------------------------------------------------------------------------

export const scanVaultListTool: Tool = {
  schema: {
    name: 'scan_vault_list',
    description: 'List every file currently quarantined in the virus vault.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('scan_vault_list', started, 'before');
    const items = await invokeSafe<ReadonlyArray<unknown>>('scan_vault_list');
    const count = items?.length ?? 0;
    return {
      ok: true,
      content: truncate(`${count} item${count === 1 ? '' : 's'} in virus vault`),
      data: items ?? [],
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
