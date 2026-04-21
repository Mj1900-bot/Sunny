// Core built-in tools: app launch, filesystem listing, messages, web,
// gateway ping, shell execution, TTS, clipboard history.

import { invokeSafe } from '../../tauri';
import {
  isParseError,
  isRecord,
  optionalNumber,
  optionalString,
  requireNumber,
  requireString,
  truncate,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

export const openAppTool: Tool = {
  schema: {
    name: 'open_app',
    description: 'Open a native application by name (e.g. "Safari", "Ghostty").',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const name = requireString(input, 'name');
    if (isParseError(name)) return validationFailure(started, name.message);
    await invokeSafe<void>('open_app', { name });
    return {
      ok: true,
      content: `Opened app "${name}".`,
      data: { name },
      latency_ms: Date.now() - started,
    };
  },
};

type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_secs: number;
};

export const fsListTool: Tool = {
  schema: {
    name: 'fs_list',
    description: 'List files and directories at an absolute path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const path = requireString(input, 'path');
    if (isParseError(path)) return validationFailure(started, path.message);
    const entries = await invokeSafe<FsEntry[]>('fs_list', { path }, []);
    const list = entries ?? [];
    const summary = list
      .slice(0, 200)
      .map(e => `${e.is_dir ? 'DIR ' : 'FILE'} ${e.name}`)
      .join('\n');
    return {
      ok: true,
      content: truncate(
        list.length === 0 ? `(empty) ${path}` : `${list.length} entries in ${path}\n${summary}`,
      ),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

type MessageRow = {
  id: string;
  from: string;
  text: string;
  at: number;
};

export const messagesRecentTool: Tool = {
  schema: {
    name: 'messages_recent',
    description: 'Get the most recent messages from the local message store.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Maximum number of messages to return',
        },
      },
      required: ['limit'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const limit = requireNumber(input, 'limit');
    if (isParseError(limit)) return validationFailure(started, limit.message);
    const rows = await invokeSafe<MessageRow[]>('messages_recent', { limit }, []);
    const list = rows ?? [];
    return {
      ok: true,
      content: truncate(
        list.length === 0
          ? 'No recent messages.'
          : list.map(m => `[${m.from}] ${m.text}`).join('\n'),
      ),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

type WebFetchResult = { title?: string; text?: string; url?: string };

export const webFetchReadableTool: Tool = {
  schema: {
    name: 'web_fetch_readable',
    description: 'Fetch a URL and return its main readable text content.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const url = requireString(input, 'url');
    if (isParseError(url)) return validationFailure(started, url.message);
    if (!/^https?:\/\//i.test(url)) {
      return validationFailure(started, 'url must start with http:// or https://');
    }
    const result = await invokeSafe<WebFetchResult>('web_fetch_readable', { url });
    if (!result) {
      return {
        ok: false,
        content: `Failed to fetch ${url}`,
        latency_ms: Date.now() - started,
      };
    }
    const body = `${result.title ? `# ${result.title}\n\n` : ''}${result.text ?? ''}`;
    return {
      ok: true,
      content: truncate(body.length ? body : `(empty readable content from ${url})`),
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

type WebSearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
};

export const webSearchTool: Tool = {
  schema: {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo and return the top results (title, URL, snippet). Use this to discover URLs before fetching them with web_fetch_readable.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query text (natural language or keywords).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Max number of results to return (default 8).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const query = requireString(input, 'query');
    if (isParseError(query)) return validationFailure(started, query.message);
    const limit = optionalNumber(input, 'limit');
    if (isParseError(limit)) return validationFailure(started, limit.message);

    const results = await invokeSafe<ReadonlyArray<WebSearchResult>>('web_search', {
      query,
      limit,
    });
    if (!results || results.length === 0) {
      return {
        ok: false,
        content: `No web results for "${query}"`,
        latency_ms: Date.now() - started,
      };
    }
    const rendered = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
    return {
      ok: true,
      content: truncate(`${results.length} results for "${query}":\n\n${rendered}`),
      data: results,
      latency_ms: Date.now() - started,
    };
  },
};

export const openclawPingTool: Tool = {
  schema: {
    name: 'openclaw_ping',
    description: 'Ping the local OpenClaw gateway to verify connectivity.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, _signal) => {
    const started = Date.now();
    const result = await invokeSafe<{ ok: boolean; latency_ms?: number; version?: string }>(
      'openclaw_ping',
    );
    if (!result) {
      return {
        ok: false,
        content: 'OpenClaw gateway unreachable.',
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: result.ok,
      content: result.ok
        ? `OpenClaw OK${result.version ? ` (v${result.version})` : ''}`
        : 'OpenClaw responded but reported not OK.',
      data: result,
      latency_ms: Date.now() - started,
    };
  },
};

type ShellOutput = { stdout: string; stderr: string; code: number };

export const runShellTool: Tool = {
  schema: {
    name: 'run_shell',
    description: 'Run a shell command and return stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'The shell command line to run' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const cmd = requireString(input, 'cmd');
    if (isParseError(cmd)) return validationFailure(started, cmd.message);
    const out = await invokeSafe<ShellOutput>('run_shell', { cmd });
    if (!out) {
      return {
        ok: false,
        content: `Failed to execute: ${cmd}`,
        latency_ms: Date.now() - started,
      };
    }
    const body =
      `exit ${out.code}\n` +
      (out.stdout ? `--- stdout ---\n${out.stdout}\n` : '') +
      (out.stderr ? `--- stderr ---\n${out.stderr}\n` : '');
    return {
      ok: out.code === 0,
      content: truncate(body),
      data: out,
      latency_ms: Date.now() - started,
    };
  },
};

export const speakTool: Tool = {
  schema: {
    name: 'speak',
    description: 'Speak text aloud through the system TTS voice.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to speak' },
        voice: { type: 'string', description: 'Optional voice name' },
        rate: { type: 'number', description: 'Optional speaking rate in words/min' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, _signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const text = requireString(input, 'text');
    if (isParseError(text)) return validationFailure(started, text.message);
    const voice = optionalString(input, 'voice');
    if (isParseError(voice)) return validationFailure(started, voice.message);
    const rate = optionalNumber(input, 'rate');
    if (isParseError(rate)) return validationFailure(started, rate.message);
    await invokeSafe<void>('speak', { text, voice, rate });
    return {
      ok: true,
      content: `Spoke ${text.length} chars.`,
      data: { text, voice, rate },
      latency_ms: Date.now() - started,
    };
  },
};

type ClipboardEntry = { text: string; at: number };

export const getClipboardHistoryTool: Tool = {
  schema: {
    name: 'get_clipboard_history',
    description: 'Return the most recent clipboard entries captured by SUNNY.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, _signal) => {
    const started = Date.now();
    const entries = await invokeSafe<ClipboardEntry[]>('get_clipboard_history', {}, []);
    const list = entries ?? [];
    return {
      ok: true,
      content: truncate(
        list.length === 0
          ? 'Clipboard history is empty.'
          : list.map((c, i) => `#${i + 1} (${new Date(c.at).toISOString()}): ${c.text}`).join('\n'),
      ),
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};
