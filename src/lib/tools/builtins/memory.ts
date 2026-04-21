// Memory store.
//
// These TS tools mirror the Rust agent-loop tools `memory_remember` and
// `memory_recall` (see src-tauri/src/agent_loop/tools/memory/) so the voice
// path — which runs through the TS agent loop — gets the same three-store
// write behaviour (episodic + semantic mirror) that the Rust path does.
// The IPC targets are the typed `memory_episodic_*` / `memory_fact_*`
// commands registered in src-tauri/src/lib.rs; the flat `memory_add` /
// `memory_list` / `memory_search` commands were retired in 2026-04.

import { invokeSafe } from '../../tauri';
import {
  abortedResult,
  isParseError,
  isRecord,
  optionalNumber,
  optionalStringArray,
  rejectUnknown,
  requireString,
  truncate,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

type EpisodicItem = {
  id: string;
  kind: string;
  text: string;
  tags: ReadonlyArray<string>;
  meta: unknown;
  created_at: number;
};

export const memoryAddTool: Tool = {
  schema: {
    name: 'memory_remember',
    description:
      "Persist a durable fact about the user to long-term memory. Call this IMMEDIATELY whenever the user tells you something about themselves they'll expect you to recall later: their name, location, preferences, relationships, routines, projects, pets, schedule. Examples that should trigger this tool: \"my name is Sunny\", \"I live in Vancouver\", \"I prefer espresso\", \"remember that I have a meeting Thursday\". Writes to both the episodic timeline and the semantic fact store so the next turn's memory pack surfaces it.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['text', 'tags']);
    if (unknown) return validationFailure(started, unknown.message);
    const text = requireString(input, 'text');
    if (isParseError(text)) return validationFailure(started, text.message);
    const tags = optionalStringArray(input, 'tags');
    if (isParseError(tags)) return validationFailure(started, tags.message);
    const tagList: ReadonlyArray<string> = tags ?? [];
    if (signal.aborted) return abortedResult('memory_remember', started, 'before');
    const item = await invokeSafe<EpisodicItem>('memory_episodic_add', {
      kind: 'note',
      text,
      tags: tagList,
      meta: null,
    });
    if (signal.aborted) return abortedResult('memory_remember', started, 'after');
    if (!item) {
      return {
        ok: false,
        content: 'Failed to remember — episodic write rejected.',
        latency_ms: Date.now() - started,
      };
    }
    // Mirror into semantic so the next turn's memory pack surfaces it —
    // matches the Rust `memory_remember` tool behaviour. Fire-and-forget;
    // a failed semantic write is a soft loss (episodic still has the row).
    const subject = tagList[0] ?? 'user.note';
    void invokeSafe<unknown>('memory_fact_add', {
      subject,
      text,
      tags: tagList,
      confidence: 1.0,
      source: 'tool-remember',
    });
    return {
      ok: true,
      content: truncate(
        `Remembered: ${item.id.slice(0, 8)} (${text.length} chars, ${tagList.length} tags)`,
      ),
      data: item,
      latency_ms: Date.now() - started,
    };
  },
};

export const memoryListTool: Tool = {
  schema: {
    name: 'memory_list',
    description: 'List recent memories with pagination.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        offset: { type: 'integer', minimum: 0 },
      },
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
    let limit: number | undefined;
    let offset: number | undefined;
    if (isRecord(input)) {
      const unknown = rejectUnknown(input, ['limit', 'offset']);
      if (unknown) return validationFailure(started, unknown.message);
      const l = optionalNumber(input, 'limit');
      if (isParseError(l)) return validationFailure(started, l.message);
      limit = l;
      const o = optionalNumber(input, 'offset');
      if (isParseError(o)) return validationFailure(started, o.message);
      offset = o;
    }
    if (signal.aborted) return abortedResult('memory_list', started, 'before');
    const items = await invokeSafe<ReadonlyArray<EpisodicItem>>(
      'memory_episodic_list',
      { limit, offset },
      [],
    );
    if (signal.aborted) return abortedResult('memory_list', started, 'after');
    const list = items ?? [];
    const summary = list.length === 0
      ? '0 memories'
      : `${list.length} memories\n` +
        list.map(m => `• ${m.id.slice(0, 8)} ${m.text.slice(0, 80)}`).join('\n');
    return {
      ok: true,
      content: truncate(summary),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

export const memorySearchTool: Tool = {
  schema: {
    name: 'memory_recall',
    description:
      "USE THIS when the user says 'what's my name', 'where do I live', 'what did I tell you about Y', 'what do I prefer', 'remember when I said…'. Returns matching facts from SUNNY's long-term memory. Call FIRST whenever the user refers to herself, her preferences, or prior conversations — never answer from conversation history alone.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['query', 'limit']);
    if (unknown) return validationFailure(started, unknown.message);
    const query = requireString(input, 'query');
    if (isParseError(query)) return validationFailure(started, query.message);
    const limit = optionalNumber(input, 'limit');
    if (isParseError(limit)) return validationFailure(started, limit.message);
    if (signal.aborted) return abortedResult('memory_recall', started, 'before');
    const items = await invokeSafe<ReadonlyArray<EpisodicItem>>(
      'memory_episodic_search',
      { query, limit },
      [],
    );
    if (signal.aborted) return abortedResult('memory_recall', started, 'after');
    const list = items ?? [];
    const summary = list.length === 0
      ? `no memories matched "${query}"`
      : `${list.length} matches for "${query}"\n` +
        list.map(m => `• ${m.id.slice(0, 8)} ${m.text.slice(0, 80)}`).join('\n');
    return {
      ok: true,
      content: truncate(summary),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

// memoryDeleteTool removed 2026-04-20: the flat `memory_delete` Tauri command
// was retired along with the deprecated `memory_add/list/search` surface.
// Episodic rows have no public delete path by design (retention sweeps age
// them out); semantic facts delete via `memory_fact_delete` which is a
// different shape and currently unneeded by the voice path. Re-add a
// `memory_forget` tool if/when the voice agent genuinely needs to drop a
// fact — and wire it to `memory_fact_delete`, not a phantom IPC.
