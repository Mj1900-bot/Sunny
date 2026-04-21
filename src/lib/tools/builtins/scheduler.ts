// Scheduler.

import { invokeSafe } from '../../tauri';
import {
  abortedResult,
  enumOf,
  isParseError,
  isRecord,
  optionalNumber,
  rejectUnknown,
  requireBoolean,
  requireObject,
  requireString,
  truncate,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

type SchedulerJob = {
  id: string;
  title: string;
  kind: 'Once' | 'Interval';
  at?: number | null;
  every_sec?: number | null;
  action: Record<string, unknown>;
  enabled: boolean;
  last_run?: number | null;
  next_run?: number | null;
  last_error?: string | null;
};

const SCHEDULER_KINDS = ['Once', 'Interval'] as const;

export const schedulerListTool: Tool = {
  schema: {
    name: 'scheduler_list',
    description: 'List all scheduled jobs.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (input !== undefined && input !== null && !isRecord(input)) {
      return validationFailure(started, 'expected an object or no input');
    }
    if (isRecord(input)) {
      const unknown = rejectUnknown(input, []);
      if (unknown) return validationFailure(started, unknown.message);
    }
    if (signal.aborted) return abortedResult('scheduler_list', started, 'before');
    const jobs = await invokeSafe<ReadonlyArray<SchedulerJob>>('scheduler_list', {}, []);
    if (signal.aborted) return abortedResult('scheduler_list', started, 'after');
    const list = jobs ?? [];
    const summary = list.length === 0
      ? 'no scheduled jobs'
      : `${list.length} jobs\n` +
        list.map(j => `• ${j.id.slice(0, 8)} [${j.kind}] ${j.enabled ? 'ON' : 'off'} — ${j.title}`).join('\n');
    return {
      ok: true,
      content: truncate(summary),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

export const schedulerAddTool: Tool = {
  schema: {
    name: 'scheduler_add',
    description: 'Create a new scheduled job. `kind` is Once or Interval.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string', enum: [...SCHEDULER_KINDS] },
        at: { type: 'number', description: 'Unix seconds for Once jobs' },
        every_sec: { type: 'number', minimum: 1, description: 'Interval seconds for Interval jobs' },
        action: { type: 'object', description: 'Action payload (tool invocation spec)' },
      },
      required: ['title', 'kind', 'action'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['title', 'kind', 'at', 'every_sec', 'action']);
    if (unknown) return validationFailure(started, unknown.message);
    const title = requireString(input, 'title');
    if (isParseError(title)) return validationFailure(started, title.message);
    const kind = enumOf(input, 'kind', SCHEDULER_KINDS);
    if (isParseError(kind)) return validationFailure(started, kind.message);
    const at = optionalNumber(input, 'at');
    if (isParseError(at)) return validationFailure(started, at.message);
    const everySec = optionalNumber(input, 'every_sec');
    if (isParseError(everySec)) return validationFailure(started, everySec.message);
    const action = requireObject(input, 'action');
    if (isParseError(action)) return validationFailure(started, action.message);
    if (kind === 'Once' && at === undefined) {
      return validationFailure(started, 'Once jobs require "at" (unix seconds)');
    }
    if (kind === 'Interval' && everySec === undefined) {
      return validationFailure(started, 'Interval jobs require "every_sec"');
    }
    if (signal.aborted) return abortedResult('scheduler_add', started, 'before');
    const job = await invokeSafe<SchedulerJob>('scheduler_add', {
      title,
      kind,
      at,
      everySec,
      action,
    });
    if (signal.aborted) return abortedResult('scheduler_add', started, 'after');
    if (!job) {
      return {
        ok: false,
        content: 'Failed to create scheduled job.',
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `scheduled ${kind} job ${job.id} — ${title}`,
      data: job,
      latency_ms: Date.now() - started,
    };
  },
};

export const schedulerDeleteTool: Tool = {
  schema: {
    name: 'scheduler_delete',
    description: 'Delete a scheduled job by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    if (signal.aborted) return abortedResult('scheduler_delete', started, 'before');
    await invokeSafe<void>('scheduler_delete', { id });
    if (signal.aborted) return abortedResult('scheduler_delete', started, 'after');
    return {
      ok: true,
      content: `deleted scheduled job ${id}`,
      data: { id },
      latency_ms: Date.now() - started,
    };
  },
};

export const schedulerSetEnabledTool: Tool = {
  schema: {
    name: 'scheduler_set_enabled',
    description: 'Enable or disable a scheduled job.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id', 'enabled']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    const enabled = requireBoolean(input, 'enabled');
    if (isParseError(enabled)) return validationFailure(started, enabled.message);
    if (signal.aborted) return abortedResult('scheduler_set_enabled', started, 'before');
    const job = await invokeSafe<SchedulerJob>('scheduler_set_enabled', { id, enabled });
    if (signal.aborted) return abortedResult('scheduler_set_enabled', started, 'after');
    if (!job) {
      return {
        ok: false,
        content: `Failed to toggle job ${id}.`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `job ${id} ${enabled ? 'enabled' : 'disabled'}`,
      data: job,
      latency_ms: Date.now() - started,
    };
  },
};

export const schedulerRunOnceTool: Tool = {
  schema: {
    name: 'scheduler_run_once',
    description: 'Execute a scheduled job immediately, regardless of schedule.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);
    const id = requireString(input, 'id');
    if (isParseError(id)) return validationFailure(started, id.message);
    if (signal.aborted) return abortedResult('scheduler_run_once', started, 'before');
    const job = await invokeSafe<SchedulerJob>('scheduler_run_once', { id });
    if (signal.aborted) return abortedResult('scheduler_run_once', started, 'after');
    if (!job) {
      return {
        ok: false,
        content: `Failed to run job ${id}.`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `ran job ${id} (${job.title})`,
      data: job,
      latency_ms: Date.now() - started,
    };
  },
};
