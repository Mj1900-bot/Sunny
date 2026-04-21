// Agent tools for the policy-enforced browser module in
// src-tauri/src/browser/. These tools let the agent loop route HTTP through
// the same `BrowserDispatcher::fetch` the Web UI uses, so anonymity route /
// tracker blocklist / kill switch / audit log all apply to the agent's
// reads, not just the user's clicks.
//
// Three tools are exposed:
//
//   secure_web_fetch  — fetch + sanitize a URL through a profile
//   deep_research     — parallel multi-source research with citations
//   browser_profiles  — enumerate the available profiles so the agent can
//                       pick the right posture
//
// These complement — they do not replace — the legacy `web_fetch` /
// `tool_web_search` in `tools.web.ts`. Keep both: `web_fetch` is direct
// clearnet and well-tested; `secure_web_fetch` is the dispatcher-gated
// path that respects posture. An agent that wants tor or audit-safe
// behavior picks the new tool; an agent that just needs the text can
// still use the old one.
//
// Usage: `import './lib/tools.sunnyBrowser';` — self-registers on import.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invokeSafe } from './tauri';
import { useTabs, searchUrl as webSearchUrl } from '../pages/WebPage/tabStore';

type ParseError = { readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isParseError(v: unknown): v is ParseError {
  return (
    isRecord(v) &&
    typeof (v as Record<string, unknown>).message === 'string' &&
    !('length' in (v as object))
  );
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
): string | ParseError {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { message: `"${key}" must be a non-empty string` };
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const v = obj[key];
  if (typeof v !== 'string') {
    return { message: `"${key}" must be a string if provided` };
  }
  return v;
}

function optionalInt(
  obj: Record<string, unknown>,
  key: string,
): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    return { message: `"${key}" must be a non-negative integer if provided` };
  }
  return v;
}

function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
): ParseError | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      return { message: `unknown field "${key}"` };
    }
  }
  return null;
}

function validationFailure(started: number, reason: string): ToolResult {
  return {
    ok: false,
    content: `Invalid tool input: ${reason}`,
    latency_ms: Date.now() - started,
  };
}

function abortedResult(
  name: string,
  started: number,
  when: 'before' | 'after',
): ToolResult {
  return {
    ok: false,
    content: `Tool "${name}" aborted ${when} invocation`,
    latency_ms: Date.now() - started,
  };
}

function validateHttpUrl(raw: string): string | ParseError {
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
    return {
      message: `"url" must start with http:// or https:// and contain no whitespace`,
    };
  }
  return raw;
}

// Mirrors `BrowserFetchResult` in src-tauri/src/browser/commands.rs.
type BrowserFetchResult = {
  status: number;
  ok: boolean;
  final_url: string;
  url: string;
  extract: {
    title: string;
    description: string;
    body_html: string;
    text: string;
    favicon_url: string;
  };
};

type ResearchSource = {
  title: string;
  url: string;
  final_url: string;
  snippet: string;
  text: string;
  favicon_url: string;
  fetched_ok: boolean;
  ms: number;
};

type ResearchBrief = {
  query: string;
  profile_id: string;
  sources: ResearchSource[];
  elapsed_ms: number;
};

type ProfilePolicy = {
  id: string;
  label: string;
  route: { kind: string } & Record<string, unknown>;
  cookies: string;
  js_default: string;
  ua_mode: string;
  block_third_party_cookies: boolean;
  block_trackers: boolean;
  block_webrtc: boolean;
  deny_sensors: boolean;
  audit: boolean;
  kill_switch_bypass: boolean;
};

const FETCH_DEFAULT_MAX_CHARS = 4_000;
const FETCH_HARD_MAX_CHARS = 20_000;

// ---------------------------------------------------------------------------
// secure_web_fetch
// ---------------------------------------------------------------------------

const secureWebFetchTool: Tool = {
  schema: {
    name: 'secure_web_fetch',
    description:
      'GET a URL through the browser dispatcher under a named profile, returning the readable article text. The profile picks the anonymity route (clearnet with DoH, system-tor, custom proxy), tracker-block posture, UA rotation, and audit policy. Prefer this over web_fetch when (a) you need Tor / a proxy, (b) you want the request to show up in the audit log, or (c) you want the kill switch to apply. Accepts profile_id: "default" | "private" | "tor" | any user-defined id (see browser_profiles). Output is truncated to max_chars with a "[truncated at N chars]" marker when longer.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL to fetch.',
        },
        profile_id: {
          type: 'string',
          description:
            'Profile to route through. Defaults to "default" (clearnet + DoH). Use "tor" for anonymity, "private" for ephemeral cookies, or a user-authored id.',
        },
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: FETCH_HARD_MAX_CHARS,
          description: `Max characters of readable text to return (default ${FETCH_DEFAULT_MAX_CHARS}, hard ceiling ${FETCH_HARD_MAX_CHARS}).`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('secure_web_fetch', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url', 'profile_id', 'max_chars']);
    if (unknown) return validationFailure(started, unknown.message);

    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);

    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);
    const profileId = profileIn ?? 'default';

    const maxCharsIn = optionalInt(input, 'max_chars');
    if (isParseError(maxCharsIn)) return validationFailure(started, maxCharsIn.message);
    const maxChars = maxCharsIn ?? FETCH_DEFAULT_MAX_CHARS;

    const result = await invokeSafe<BrowserFetchResult>('browser_fetch_readable', {
      profileId,
      url,
      tabId: null,
    });
    if (result === null) {
      return {
        ok: false,
        content: `secure_web_fetch("${url}", ${profileId}) failed (backend unavailable or blocked by policy).`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('secure_web_fetch', started, 'after');

    const body = result.extract.text.length === 0 ? '(empty body)' : result.extract.text;
    const truncated =
      body.length > maxChars ? `${body.slice(0, maxChars)}\n[truncated at ${maxChars} chars]` : body;

    const header = [
      `# ${result.extract.title || result.final_url}`,
      result.extract.description.length > 0 ? `> ${result.extract.description}` : '',
      `Source: ${result.final_url}${result.final_url !== url ? ` (redirected from ${url})` : ''}`,
      `Profile: ${profileId} · HTTP ${result.status}`,
      '',
    ]
      .filter(line => line.length > 0)
      .join('\n');

    return {
      ok: result.ok,
      content: `${header}\n${truncated}`,
      data: {
        url: result.url,
        final_url: result.final_url,
        profile_id: profileId,
        status: result.status,
        title: result.extract.title,
        chars: truncated.length,
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// deep_research
// ---------------------------------------------------------------------------

const deepResearchTool: Tool = {
  schema: {
    name: 'deep_research',
    description:
      'Run a multi-source research pass on a question: one DuckDuckGo search through the chosen profile, then fan out to up to max_sources parallel readable fetches of the top hits, dedupe by canonical URL, and return a cited markdown brief. Each source shows up with title, host, a trimmed readable excerpt, and its fetch latency. Use when a single web_fetch/web_search is not enough to answer an open question.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The question to research, in natural language.',
        },
        profile_id: {
          type: 'string',
          description:
            'Profile to route through (default "default"). Use "tor" if the topic is sensitive; results come back the same, just with a slower tunnel.',
        },
        max_sources: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of sources to read in parallel. Default 8.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('deep_research', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['query', 'profile_id', 'max_sources']);
    if (unknown) return validationFailure(started, unknown.message);

    const queryIn = requireString(input, 'query');
    if (isParseError(queryIn)) return validationFailure(started, queryIn.message);

    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);
    const profileId = profileIn ?? 'default';

    const maxIn = optionalInt(input, 'max_sources');
    if (isParseError(maxIn)) return validationFailure(started, maxIn.message);

    const brief = await invokeSafe<ResearchBrief>('browser_research_run', {
      profileId,
      query: queryIn,
      maxSources: maxIn,
    });
    if (brief === null) {
      return {
        ok: false,
        content: `deep_research("${queryIn}") failed (backend unavailable or blocked by policy).`,
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('deep_research', started, 'after');

    // Cap per-source excerpt so the whole brief fits in a sensible prompt.
    const EXCERPT_CHARS = 1500;
    const lines: string[] = [];
    lines.push(`# Research brief: ${brief.query}`);
    lines.push(
      `Profile: ${brief.profile_id} · ${brief.sources.length} sources in ${brief.elapsed_ms}ms`,
    );
    lines.push('');
    brief.sources.forEach((s, i) => {
      const host = (() => {
        try {
          return new URL(s.final_url).hostname.replace(/^www\./, '');
        } catch {
          return s.final_url;
        }
      })();
      lines.push(`## [${i + 1}] ${s.title || host}`);
      lines.push(`Source: ${host} · ${s.final_url}${s.fetched_ok ? '' : ' (fetch failed)'} · ${s.ms}ms`);
      if (s.snippet.length > 0) {
        lines.push(`> ${s.snippet}`);
      }
      if (s.text.length > 0) {
        const excerpt =
          s.text.length > EXCERPT_CHARS
            ? `${s.text.slice(0, EXCERPT_CHARS)}\n[truncated]`
            : s.text;
        lines.push('');
        lines.push(excerpt);
      }
      lines.push('');
    });

    return {
      ok: true,
      content: lines.join('\n'),
      data: {
        query: brief.query,
        profile_id: brief.profile_id,
        sources: brief.sources.map(s => ({
          title: s.title,
          url: s.final_url,
          fetched_ok: s.fetched_ok,
        })),
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// browser_profiles — self-description so the agent can pick the right route
// ---------------------------------------------------------------------------

const browserProfilesTool: Tool = {
  schema: {
    name: 'browser_profiles',
    description:
      'Enumerate the browser profiles available to secure_web_fetch and deep_research. Returns id, label, route kind (clearnet / system_tor / bundled_tor / custom), and the one-line posture (cookies, JS mode, tracker block, WebRTC, audit). Use this before picking a non-default profile so you know what exists on this machine.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_profiles', started, 'before');

    const profiles = await invokeSafe<ProfilePolicy[]>('browser_profiles_list');
    if (profiles === null) {
      return {
        ok: false,
        content: 'browser_profiles failed (backend unavailable).',
        latency_ms: Date.now() - started,
      };
    }
    if (signal.aborted) return abortedResult('browser_profiles', started, 'after');

    const lines: string[] = ['# Browser profiles', ''];
    profiles.forEach(p => {
      const routeTag = (() => {
        switch (p.route.kind) {
          case 'bundled_tor':
          case 'system_tor':
            return 'TOR';
          case 'custom':
            return 'PROXY';
          case 'clearnet':
          default:
            return p.cookies === 'persistent' ? 'CLEAR' : 'PRIVATE';
        }
      })();
      const postureBits = [
        routeTag,
        p.js_default === 'off'
          ? 'JS OFF'
          : p.js_default === 'on'
            ? 'JS ON'
            : 'JS OPT-IN',
        `cookies=${p.cookies}`,
      ];
      if (p.block_trackers) postureBits.push('trackers blocked');
      if (p.block_webrtc) postureBits.push('webrtc off');
      if (!p.audit) postureBits.push('no audit');
      lines.push(`- \`${p.id}\` · **${p.label}** — ${postureBits.join(' · ')}`);
    });

    return {
      ok: true,
      content: lines.join('\n'),
      data: { profiles: profiles.map(p => ({ id: p.id, label: p.label })) },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Action tools: the agent can queue downloads, open sandbox windows, read
// the audit log, manage bookmarks. Dangerous-flagged where appropriate so
// ConfirmGate runs before the critic skips them.
// ---------------------------------------------------------------------------

type DownloadJob = {
  id: string;
  profile_id: string;
  source_url: string;
  title: string | null;
  state:
    | 'queued'
    | 'probing'
    | 'downloading'
    | 'post_process'
    | 'done'
    | 'failed'
    | 'cancelled';
  progress: number;
  file_path: string | null;
  error: string | null;
};

const browserDownloadTool: Tool = {
  schema: {
    name: 'browser_download',
    description:
      'Enqueue a video or file download for the given URL through a profile. Returns the initial DownloadJob record (the job continues in the background); call browser_download_status to check progress, browser_download_reveal to open Finder on the finished file. Uses yt-dlp when available (covers 1000+ sites), ffmpeg as fallback for direct media / HLS / DASH URLs. Honors the profile\'s tor/proxy/kill-switch posture.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL of the page or media to download.' },
        profile_id: {
          type: 'string',
          description: 'Profile to route through. Defaults to "default".',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_download', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url', 'profile_id']);
    if (unknown) return validationFailure(started, unknown.message);
    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);
    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);
    const profileId = profileIn ?? 'default';

    const job = await invokeSafe<DownloadJob>('browser_downloads_enqueue', {
      profileId,
      url,
    });
    if (job === null) {
      return {
        ok: false,
        content: `browser_download("${url}") failed. Is yt-dlp or ffmpeg installed? (brew install yt-dlp ffmpeg)`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `Queued ${job.id} (${profileId}) — state=${job.state}. Call browser_download_status to monitor.`,
      data: job,
      latency_ms: Date.now() - started,
    };
  },
};

const browserDownloadStatusTool: Tool = {
  schema: {
    name: 'browser_download_status',
    description:
      'Look up a DownloadJob by id, or list all jobs when no id is given. Returns state, progress 0..1, file_path (once done), and any error. Safe to poll.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Download job id. Omit to list all jobs.' },
      },
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_download_status', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['id']);
    if (unknown) return validationFailure(started, unknown.message);
    const idIn = optionalString(input, 'id');
    if (isParseError(idIn)) return validationFailure(started, idIn.message);

    if (idIn) {
      const job = await invokeSafe<DownloadJob | null>('browser_downloads_get', { id: idIn });
      if (!job) {
        return {
          ok: false,
          content: `no download with id ${idIn}`,
          latency_ms: Date.now() - started,
        };
      }
      return {
        ok: true,
        content: formatDownload(job),
        data: job,
        latency_ms: Date.now() - started,
      };
    }

    const jobs = await invokeSafe<DownloadJob[]>('browser_downloads_list', undefined, []);
    const list = jobs ?? [];
    const body =
      list.length === 0
        ? '(no downloads yet)'
        : list.map(formatDownload).join('\n---\n');
    return {
      ok: true,
      content: body,
      data: list,
      latency_ms: Date.now() - started,
    };
  },
};

function formatDownload(job: DownloadJob): string {
  const pct = Math.round(job.progress * 100);
  const bar = '#'.repeat(Math.min(pct / 5, 20)).padEnd(20, '.');
  return [
    `${job.id} (${job.profile_id})`,
    `state: ${job.state} [${bar}] ${pct}%`,
    job.title ? `title: ${job.title}` : '',
    job.file_path ? `file: ${job.file_path}` : '',
    job.error ? `error: ${job.error}` : '',
    `source: ${job.source_url}`,
  ]
    .filter(l => l.length > 0)
    .join('\n');
}

const browserSandboxTool: Tool = {
  schema: {
    name: 'browser_sandbox',
    description:
      'Open a hardened WebView tab in its own window for JS-heavy sites reader mode can\'t render. The window spawns with the profile\'s anonymity route, the full fingerprint init-script, and an ephemeral per-tab data directory that\'s wiped on close. Returns a SandboxTab with tab_id and bridge_port; close via browser_sandbox_close when done.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to open.' },
        profile_id: {
          type: 'string',
          description: 'Profile to route through. Defaults to "default".',
        },
        tab_id: {
          type: 'string',
          description:
            'Stable id for the tab (so repeated opens reuse the same window). Auto-generated if omitted.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_sandbox', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url', 'profile_id', 'tab_id']);
    if (unknown) return validationFailure(started, unknown.message);
    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);
    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);
    const tabIn = optionalString(input, 'tab_id');
    if (isParseError(tabIn)) return validationFailure(started, tabIn.message);

    const tabId = tabIn ?? `agent_${Math.random().toString(36).slice(2, 10)}`;
    const res = await invokeSafe<unknown>('browser_sandbox_open', {
      profileId: profileIn ?? 'default',
      tabId,
      url,
    });
    if (res === null) {
      return {
        ok: false,
        content: `browser_sandbox("${url}") failed to open.`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `Opened sandbox tab ${tabId} for ${url}.`,
      data: res,
      latency_ms: Date.now() - started,
    };
  },
};

const browserSandboxCloseTool: Tool = {
  schema: {
    name: 'browser_sandbox_close',
    description:
      'Close a sandbox tab spawned by browser_sandbox. Wipes the per-tab ephemeral data directory and tears down the loopback HTTP bridge. Returns ok even if the tab was already gone.',
    input_schema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Id of the tab to close.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_sandbox_close', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['tab_id']);
    if (unknown) return validationFailure(started, unknown.message);
    const tabIdIn = requireString(input, 'tab_id');
    if (isParseError(tabIdIn)) return validationFailure(started, tabIdIn.message);
    await invokeSafe('browser_sandbox_close', { tabId: tabIdIn });
    return {
      ok: true,
      content: `closed ${tabIdIn}`,
      latency_ms: Date.now() - started,
    };
  },
};

type BookmarkRow = {
  id: number;
  profile_id: string;
  title: string;
  url: string;
  created_at: number;
};

const browserBookmarkTool: Tool = {
  schema: {
    name: 'browser_bookmark',
    description:
      'Save a URL as a bookmark under the given profile. Profile separation matters — `tor` bookmarks are never visible to `default` by design. Returns the stored BookmarkRow.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to bookmark.' },
        title: { type: 'string', description: 'Title to show in the sidebar.' },
        profile_id: {
          type: 'string',
          description: 'Profile to bookmark under. Defaults to "default".',
        },
      },
      required: ['url', 'title'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_bookmark', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['url', 'title', 'profile_id']);
    if (unknown) return validationFailure(started, unknown.message);
    const urlIn = requireString(input, 'url');
    if (isParseError(urlIn)) return validationFailure(started, urlIn.message);
    const url = validateHttpUrl(urlIn);
    if (isParseError(url)) return validationFailure(started, url.message);
    const titleIn = requireString(input, 'title');
    if (isParseError(titleIn)) return validationFailure(started, titleIn.message);
    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);
    const profileId = profileIn ?? 'default';

    const row = await invokeSafe<BookmarkRow>('browser_bookmarks_add', {
      profileId,
      title: titleIn,
      url,
    });
    if (row === null) {
      return {
        ok: false,
        content: `browser_bookmark failed for profile=${profileId}`,
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `Bookmarked "${titleIn}" under ${profileId}.`,
      data: row,
      latency_ms: Date.now() - started,
    };
  },
};

type AuditRow = {
  id: number;
  ts: number;
  profile_id: string;
  tab_id: string | null;
  method: string;
  host: string;
  port: number;
  bytes_in: number;
  bytes_out: number;
  duration_ms: number;
  blocked_by: string | null;
};

const browserAuditTool: Tool = {
  schema: {
    name: 'browser_audit',
    description:
      'Read the browser\'s audit log — every outbound HTTP request we\'ve seen recently, with host:port, byte counts, latency, and any blocked-by reason. Use when the user asks "what did the browser just do", when investigating a suspected leak, or before recommending a privacy change. Tor-profile traffic is NEVER in this log by design.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'How many rows to return. Default 100.',
        },
        only_blocked: {
          type: 'boolean',
          description: 'Set true to only show requests that were blocked by policy.',
        },
      },
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_audit', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['limit', 'only_blocked']);
    if (unknown) return validationFailure(started, unknown.message);

    const limitIn = optionalInt(input, 'limit');
    if (isParseError(limitIn)) return validationFailure(started, limitIn.message);
    const onlyBlocked = input.only_blocked === true;

    const rows = await invokeSafe<AuditRow[]>('browser_audit_recent', {
      limit: limitIn ?? 100,
    });
    if (rows === null) {
      return {
        ok: false,
        content: 'browser_audit failed (backend unavailable).',
        latency_ms: Date.now() - started,
      };
    }
    const filtered = onlyBlocked ? rows.filter(r => r.blocked_by !== null) : rows;
    const lines = filtered.map(r => {
      const when = new Date(r.ts * 1000).toISOString().slice(11, 19);
      const suffix = r.blocked_by ? ` BLOCKED:${r.blocked_by}` : ` ${r.duration_ms}ms`;
      return `${when} ${r.profile_id} ${r.method} ${r.host}:${r.port} in=${r.bytes_in} out=${r.bytes_out}${suffix}`;
    });
    return {
      ok: true,
      content:
        lines.length === 0
          ? '(no matching audit rows)'
          : `${lines.length} rows${onlyBlocked ? ' (blocked only)' : ''}:\n${lines.join('\n')}`,
      data: { count: filtered.length, rows: filtered },
      latency_ms: Date.now() - started,
    };
  },
};

type TorStatusShape = {
  bootstrapped: boolean;
  progress: number;
  socks_port: number | null;
  source?: string;
};

const browserTorStatusTool: Tool = {
  schema: {
    name: 'browser_tor_status',
    description:
      'Check whether Tor routing is currently available — probes the system Tor daemon at 127.0.0.1:9050 (or reports the bundled arti state when that feature is built). Use before calling secure_web_fetch / deep_research with profile_id="tor" so you can tell the user clearly if Tor is unavailable.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (_input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('browser_tor_status', started, 'before');
    const s = await invokeSafe<TorStatusShape>('browser_tor_status');
    if (s === null) {
      return {
        ok: false,
        content: 'browser_tor_status failed (backend unavailable).',
        latency_ms: Date.now() - started,
      };
    }
    const body = s.bootstrapped
      ? `Tor available (${s.source ?? 'system'}): socks5h://127.0.0.1:${s.socks_port ?? 9050}, ${s.progress}% bootstrapped.`
      : 'Tor is NOT running. Install via `brew install tor && brew services start tor`, or rebuild Sunny with --features bundled-tor.';
    return {
      ok: true,
      content: body,
      data: s,
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sunny_web_current_tab  — read what the user is looking at right now
// ---------------------------------------------------------------------------
//
// This is the "what am I looking at?" hook. When the user asks the agent a
// question about the page in front of them, the agent calls this first so
// it doesn't burn a fetch re-downloading a page the frontend already has.
// Returns the active Web-module tab's URL, title, profile, and extracted
// text (cap-bounded). When the active tab is a thin sandbox tab with no
// reader extract, the tool tells the agent that and suggests falling back
// to `secure_web_fetch`.

const sunnyWebCurrentTabTool: Tool = {
  schema: {
    name: 'sunny_web_current_tab',
    description:
      "Read the user's currently-active tab in the Web module — URL, title, profile, render mode (reader vs live sandbox), and already-extracted article text if reader mode has parsed the page. Use this before calling secure_web_fetch when the user asks about the page they're looking at, so the agent sees the same content the user sees instead of re-downloading. Returns `{ active: false }` when the Web module is empty.",
    input_schema: {
      type: 'object',
      properties: {
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: FETCH_HARD_MAX_CHARS,
          description: `Max characters of extracted text to return (default ${FETCH_DEFAULT_MAX_CHARS}, hard ceiling ${FETCH_HARD_MAX_CHARS}).`,
        },
      },
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('sunny_web_current_tab', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['max_chars']);
    if (unknown) return validationFailure(started, unknown.message);

    const maxCharsIn = optionalInt(input, 'max_chars');
    if (isParseError(maxCharsIn)) return validationFailure(started, maxCharsIn.message);
    const maxChars = maxCharsIn ?? FETCH_DEFAULT_MAX_CHARS;

    const state = useTabs.getState();
    const tab = state.tabs.find(t => t.id === state.activeTabId) ?? null;
    if (!tab || tab.url.length === 0) {
      return {
        ok: true,
        content: 'No active Web-module tab. The user has not opened a URL yet.',
        data: { active: false },
        latency_ms: Date.now() - started,
      };
    }

    const extracted =
      tab.load.kind === 'ready' ? tab.load.result.extract : null;
    const text = extracted?.text ?? '';
    const truncated =
      text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]` : text;

    const headerLines = [
      `# ${tab.title || hostname(tab.url) || tab.url}`,
      extracted?.description && extracted.description.length > 0
        ? `> ${extracted.description}`
        : '',
      `URL: ${tab.url}`,
      `Profile: ${tab.profileId} · Render: ${tab.renderMode === 'reader' ? 'reader (extracted text)' : 'live (real page, extract may be empty)'}`,
      '',
    ].filter(line => line.length > 0);

    const body =
      truncated.length > 0
        ? truncated
        : tab.renderMode === 'sandbox'
          ? '(no extracted text — the page is rendered live in a sandbox. Call secure_web_fetch with this URL for a readable extraction.)'
          : tab.load.kind === 'loading'
            ? '(page is still loading; try again in a moment)'
            : tab.load.kind === 'error'
              ? `(reader failed: ${tab.load.message})`
              : '(empty body)';

    return {
      ok: true,
      content: `${headerLines.join('\n')}\n${body}`,
      data: {
        active: true,
        url: tab.url,
        title: tab.title,
        profile_id: tab.profileId,
        render_mode: tab.renderMode,
        load_kind: tab.load.kind,
        chars: body.length,
      },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// sunny_web_navigate  — drive the user's browser
// ---------------------------------------------------------------------------
//
// Lets the agent show the user something. Given a URL (or a free-text
// query, which is routed through DuckDuckGo the same way the address
// bar does it), the tool navigates the active Web tab — or, if the
// caller asks, opens a new tab. Respects the active tab's profile by
// default; an explicit `profile_id` overrides for one-shot privacy
// escalation ("open this in tor").

const sunnyWebNavigateTool: Tool = {
  schema: {
    name: 'sunny_web_navigate',
    description:
      "Navigate the user's Web module to a URL or free-text query. Use this when the user asks the agent to open, show, or look at a site — the agent drives the browser instead of printing a link. Free-text queries are routed through DuckDuckGo automatically, same as the address bar. Set `new_tab: true` to open a fresh tab; omit to reuse the active tab. Set `profile_id` to escalate privacy for one navigation (e.g. open a sensitive link in 'tor' or 'private').",
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'URL, bare hostname ("example.com"), or free-text query. Non-URL input is routed through the default search engine.',
        },
        new_tab: {
          type: 'boolean',
          description: 'Open a new tab instead of replacing the active one (default false).',
        },
        profile_id: {
          type: 'string',
          description:
            "Override the navigation's profile. Defaults to the active tab's profile.",
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('sunny_web_navigate', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['target', 'new_tab', 'profile_id']);
    if (unknown) return validationFailure(started, unknown.message);

    const targetIn = requireString(input, 'target');
    if (isParseError(targetIn)) return validationFailure(started, targetIn.message);

    const newTabRaw = input['new_tab'];
    if (newTabRaw !== undefined && typeof newTabRaw !== 'boolean') {
      return validationFailure(started, '"new_tab" must be a boolean if provided');
    }
    const newTab = newTabRaw === true;

    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);

    const state = useTabs.getState();
    const activeTab =
      state.tabs.find(t => t.id === state.activeTabId) ?? state.tabs[0] ?? null;
    const profileId = profileIn ?? activeTab?.profileId ?? 'default';

    let tabId: string;
    if (newTab || !activeTab) {
      tabId = state.openTab(profileId, targetIn);
    } else {
      if (activeTab.profileId !== profileId) {
        // Profile mismatch — open a new tab so we don't silently rewrite
        // the user's active profile on their current tab.
        tabId = state.openTab(profileId, targetIn);
      } else {
        tabId = activeTab.id;
        await state.navigate(activeTab.id, targetIn);
      }
    }

    return {
      ok: true,
      content: `Navigating tab ${tabId} (profile ${profileId}) to: ${targetIn}`,
      data: { tab_id: tabId, profile_id: profileId, target: targetIn, new_tab: newTab },
      latency_ms: Date.now() - started,
    };
  },
};

// ---------------------------------------------------------------------------
// sunny_web_search  — open a search in the user's browser
// ---------------------------------------------------------------------------
//
// Convenience wrapper for "search for X" prompts. Distinct from
// deep_research: that one runs headless + returns text. This one opens
// a visible search results page so the user can browse the results
// themselves. Pairs well with agentic workflows where the agent wants
// to hand off control to the user.

const sunnyWebSearchTool: Tool = {
  schema: {
    name: 'sunny_web_search',
    description:
      "Open a web search in the user's Web module for the given query. Like typing into the address bar and pressing Enter. Use this when the user wants to browse search results themselves rather than have the agent synthesize an answer. Distinct from deep_research (which runs headless and returns text). Respects the active tab's profile so Tor-profile tabs search via the Tor route.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for.',
        },
        new_tab: {
          type: 'boolean',
          description: 'Open in a new tab (default true for search).',
        },
        profile_id: {
          type: 'string',
          description:
            "Override the profile. Defaults to the active tab's profile.",
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('sunny_web_search', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['query', 'new_tab', 'profile_id']);
    if (unknown) return validationFailure(started, unknown.message);

    const queryIn = requireString(input, 'query');
    if (isParseError(queryIn)) return validationFailure(started, queryIn.message);

    const newTabRaw = input['new_tab'];
    if (newTabRaw !== undefined && typeof newTabRaw !== 'boolean') {
      return validationFailure(started, '"new_tab" must be a boolean if provided');
    }
    const newTab = newTabRaw !== false;

    const profileIn = optionalString(input, 'profile_id');
    if (isParseError(profileIn)) return validationFailure(started, profileIn.message);

    const state = useTabs.getState();
    const activeTab =
      state.tabs.find(t => t.id === state.activeTabId) ?? state.tabs[0] ?? null;
    const profileId = profileIn ?? activeTab?.profileId ?? 'default';
    const url = webSearchUrl(queryIn);

    let tabId: string;
    if (newTab || !activeTab) {
      tabId = state.openTab(profileId, url);
    } else {
      tabId = activeTab.id;
      await state.navigate(activeTab.id, url);
    }

    return {
      ok: true,
      content: `Searching for "${queryIn}" in tab ${tabId} (profile ${profileId}).`,
      data: { tab_id: tabId, profile_id: profileId, query: queryIn, search_url: url, new_tab: newTab },
      latency_ms: Date.now() - started,
    };
  },
};

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

[
  secureWebFetchTool,
  deepResearchTool,
  browserProfilesTool,
  browserDownloadTool,
  browserDownloadStatusTool,
  browserSandboxTool,
  browserSandboxCloseTool,
  browserBookmarkTool,
  browserAuditTool,
  browserTorStatusTool,
  sunnyWebCurrentTabTool,
  sunnyWebNavigateTool,
  sunnyWebSearchTool,
].forEach(registerTool);
