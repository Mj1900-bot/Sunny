// Daemon scheduling — voice-first tools for creating persistent agent runs.
//
// Bridges the frontend agent loop to `daemons_add` in `src-tauri/src/daemons.rs`
// (see DaemonSpec). Unlike the older `scheduler_add` Tool, these accept
// natural-language cadence / wall-clock phrases ("every morning at 7",
// "in 15 minutes", "tomorrow at 9am") so a spoken request goes through
// without asking the LLM to compute unix timestamps.
//
// Both tools ALSO accept structured fields (`every_sec`, `at_unix`) as an
// escape hatch — when the LLM has a precise timestamp ready, skip parsing.
//
// The underlying daemon model (from daemons.rs):
//   kind: "once"     — fires once at `at`
//   kind: "interval" — fires every `every_sec`, optional `at` anchor
//                      (first fire = at + every_sec)
//   kind: "on_event" — not exposed here (frontend-dispatched only)

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

type Daemon = {
  id: string;
  title: string;
  kind: string;
  at?: number | null;
  every_sec?: number | null;
  goal: string;
  enabled: boolean;
  created_at: number;
  last_fired_at?: number | null;
  fire_count: number;
};

// ---------------------------------------------------------------------------
// NL parsers — intentionally minimal. Cover the phrases that voice turns
// actually produce; anything fancier (weekday, cron expressions) should be
// passed through as structured fields from the LLM.
// ---------------------------------------------------------------------------

const UNIT_SECS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
};

/**
 * Minimum `every_sec` the tool will accept. Mirrors the Rust-side
 * `daemons::MIN_INTERVAL_SECS` cap in `daemons.rs` — both layers enforce
 * it so a tool that bypasses one still hits the other. Sub-minute polling
 * was the prior fork-bomb amplifier: a recurring daemon whose goal takes
 * longer than one poll interval causes overlapping spawns, each of which
 * calls another spawn-heavy tool.
 */
export const MIN_CADENCE_SECS = 60;

/** Parse "in N (seconds|minutes|hours)" → unix seconds from now. */
function parseIn(phrase: string, nowUnix: number): number | null {
  const m = phrase.match(/^in\s+(\d+)\s*(second|minute|hour)s?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = UNIT_SECS[m[2]];
  return unit ? nowUnix + n * unit : null;
}

/**
 * Parse "at HH:MM", "at Xam", "at Xpm", optional "tomorrow " prefix.
 * Returns the next occurrence as unix seconds, rolling to tomorrow if
 * the computed time has already passed today.
 */
function parseAt(phrase: string, now: Date): number | null {
  const m = phrase.match(/^(tomorrow\s+)?at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[2], 10);
  const minute = parseInt(m[3] ?? '0', 10);
  const ampm = m[4];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  let ts = Math.floor(target.getTime() / 1000);
  const isTomorrow = m[1] !== undefined;
  const nowSecs = Math.floor(now.getTime() / 1000);
  if (isTomorrow || ts <= nowSecs) ts += 86400;
  return ts;
}

/** Parse a one-off NL phrase into unix seconds, falling back to Date.parse. */
export function parseWhenPhrase(phrase: string, now: Date = new Date()): number | null {
  const p = phrase.toLowerCase().trim();
  const nowUnix = Math.floor(now.getTime() / 1000);
  if (p === 'now') return nowUnix;
  const inResult = parseIn(p, nowUnix);
  if (inResult !== null) return inResult;
  const atResult = parseAt(p, now);
  if (atResult !== null) return atResult;
  // Last chance: ISO 8601 or any Date-parseable string.
  const parsed = Date.parse(phrase);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  return null;
}

/**
 * Parse a recurring cadence phrase. Returns `every_sec` plus an optional
 * wall-clock anchor (first-fire time). The anchor is expressed as `at`
 * in DaemonSpec semantics: first_fire = at + every_sec, so we return
 * `at = firstFire - every_sec` when the phrase specifies a time of day.
 */
export function parseCadencePhrase(
  phrase: string,
  now: Date = new Date(),
): { every_sec: number; at?: number } | null {
  const p = phrase.toLowerCase().trim();

  // "every morning [at X]" — default to 7am when no time given. Minutes
  // are padded to two digits so the shared `parseAt` regex matches
  // whether the caller said "every morning at 9" or "at 9:05".
  const morning = p.match(/^every morning(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (morning) {
    const hourRaw = morning[1] ?? '7';
    const minRaw = (morning[2] ?? '0').padStart(2, '0');
    const ampmRaw = morning[3] ?? 'am';
    const firstFire = parseAt(`at ${hourRaw}:${minRaw} ${ampmRaw}`, now);
    if (firstFire === null) return null;
    return { every_sec: 86400, at: firstFire - 86400 };
  }

  // "every day at X" — requires an explicit time.
  const dailyAt = p.match(/^every day at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyAt) {
    const hourRaw = dailyAt[1];
    const minRaw = (dailyAt[2] ?? '0').padStart(2, '0');
    const ampmRaw = dailyAt[3] ?? '';
    const firstFire = parseAt(`at ${hourRaw}:${minRaw} ${ampmRaw}`.trim(), now);
    if (firstFire === null) return null;
    return { every_sec: 86400, at: firstFire - 86400 };
  }

  // "every N (second|minute|hour|day)s" — no anchor; interval starts now.
  const everyN = p.match(/^every\s+(\d+)\s*(second|minute|hour|day)s?$/);
  if (everyN) {
    const n = parseInt(everyN[1], 10);
    const unit = UNIT_SECS[everyN[2]];
    return unit ? { every_sec: n * unit } : null;
  }

  // Shorthand idioms.
  if (p === 'hourly' || p === 'every hour') return { every_sec: 3600 };
  if (p === 'daily' || p === 'every day') return { every_sec: 86400 };

  return null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const scheduleOnceTool: Tool = {
  schema: {
    name: 'schedule_once',
    description:
      "Schedule a one-shot agent run at a future time. Use when the user says 'remind me in 15 minutes to …', 'at 3pm call me about …', 'tomorrow at 9am start my briefing'. Prefer the natural-language `when` field — pass `at_unix` only when you have a precise timestamp. The `goal` is the agent goal text that will be handed to the sub-agent when the daemon fires.",
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: "Agent goal text — what SUNNY should do when the daemon fires." },
        when: {
          type: 'string',
          description: "Natural-language time: 'in 15 minutes', 'at 3pm', 'tomorrow at 9am', or ISO 8601.",
        },
        at_unix: {
          type: 'number',
          description: 'Unix seconds (overrides `when` when supplied).',
        },
        title: { type: 'string', description: 'Optional short label; defaults to a slice of `goal`.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['goal', 'when', 'at_unix', 'title']);
    if (unknown) return validationFailure(started, unknown.message);
    const goal = requireString(input, 'goal');
    if (isParseError(goal)) return validationFailure(started, goal.message);

    let atUnix = optionalNumber(input, 'at_unix');
    if (isParseError(atUnix)) return validationFailure(started, atUnix.message);

    if (atUnix === undefined) {
      const whenField = input.when;
      if (typeof whenField !== 'string' || whenField.trim().length === 0) {
        return validationFailure(started, "either `at_unix` or `when` is required");
      }
      const parsed = parseWhenPhrase(whenField);
      if (parsed === null) {
        return validationFailure(
          started,
          `could not parse time phrase "${whenField}" — try 'in 15 minutes', 'at 3pm', 'tomorrow at 9am', or a Unix timestamp via 'at_unix'.`,
        );
      }
      atUnix = parsed;
    }

    const title =
      typeof input.title === 'string' && input.title.trim().length > 0
        ? input.title.trim()
        : goal.slice(0, 50);

    if (signal.aborted) return abortedResult('schedule_once', started, 'before');
    const daemon = await invokeSafe<Daemon>('daemons_add', {
      spec: {
        title,
        kind: 'once',
        at: atUnix,
        every_sec: null,
        on_event: null,
        goal,
        max_runs: null,
      },
    });
    if (signal.aborted) return abortedResult('schedule_once', started, 'after');
    if (!daemon) {
      return {
        ok: false,
        content: 'Failed to create daemon.',
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: truncate(
        `Scheduled "${title}" for ${new Date((atUnix ?? 0) * 1000).toLocaleString()} (daemon ${daemon.id.slice(0, 8)}).`,
      ),
      data: daemon,
      latency_ms: Date.now() - started,
    };
  },
};

export const scheduleRecurringTool: Tool = {
  schema: {
    name: 'schedule_recurring',
    description:
      "Schedule a repeating agent run on a cadence. Use when the user says 'every morning remind me to …', 'every hour check for …', 'every 30 minutes …'. Prefer the natural-language `cadence` field — pass `every_sec` only when you have a precise interval. The `goal` is the agent goal text that will be handed to the sub-agent each time the daemon fires.",
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: "Agent goal text — what SUNNY should do on each fire." },
        cadence: {
          type: 'string',
          description:
            "Natural-language cadence: 'every morning', 'every morning at 7', 'every day at 9am', 'every hour', 'every 30 minutes'.",
        },
        every_sec: {
          type: 'number',
          description: 'Interval in seconds (overrides `cadence` when supplied).',
        },
        at_unix: {
          type: 'number',
          description: 'Optional wall-clock anchor; first fire = at_unix + every_sec.',
        },
        title: { type: 'string', description: 'Optional short label; defaults to a slice of `goal`.' },
        max_runs: { type: 'number', minimum: 1, description: 'Optional cap after which the daemon auto-disables.' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['goal', 'cadence', 'every_sec', 'at_unix', 'title', 'max_runs']);
    if (unknown) return validationFailure(started, unknown.message);
    const goal = requireString(input, 'goal');
    if (isParseError(goal)) return validationFailure(started, goal.message);

    let everySec = optionalNumber(input, 'every_sec');
    if (isParseError(everySec)) return validationFailure(started, everySec.message);
    let atAnchor = optionalNumber(input, 'at_unix');
    if (isParseError(atAnchor)) return validationFailure(started, atAnchor.message);

    if (everySec === undefined) {
      const cadence = input.cadence;
      if (typeof cadence !== 'string' || cadence.trim().length === 0) {
        return validationFailure(started, "either `every_sec` or `cadence` is required");
      }
      const parsed = parseCadencePhrase(cadence);
      if (parsed === null) {
        return validationFailure(
          started,
          `could not parse cadence "${cadence}" — try 'every morning', 'every morning at 7', 'every hour', 'every 30 minutes'.`,
        );
      }
      everySec = parsed.every_sec;
      if (atAnchor === undefined && parsed.at !== undefined) atAnchor = parsed.at;
    }

    if (everySec <= 0) return validationFailure(started, '`every_sec` must be positive');
    if (everySec < MIN_CADENCE_SECS) {
      return validationFailure(
        started,
        `cadence too fast: ${everySec}s (min ${MIN_CADENCE_SECS}s). Sub-minute recurring agent runs are refused to prevent spawn fanout — ask the user if they meant a longer interval, or use \`schedule_once\` for a one-off.`,
      );
    }

    const title =
      typeof input.title === 'string' && input.title.trim().length > 0
        ? input.title.trim()
        : goal.slice(0, 50);

    const maxRuns = optionalNumber(input, 'max_runs');
    if (isParseError(maxRuns)) return validationFailure(started, maxRuns.message);

    if (signal.aborted) return abortedResult('schedule_recurring', started, 'before');
    const daemon = await invokeSafe<Daemon>('daemons_add', {
      spec: {
        title,
        kind: 'interval',
        at: atAnchor ?? null,
        every_sec: everySec,
        on_event: null,
        goal,
        max_runs: maxRuns ?? null,
      },
    });
    if (signal.aborted) return abortedResult('schedule_recurring', started, 'after');
    if (!daemon) {
      return {
        ok: false,
        content: 'Failed to create daemon.',
        latency_ms: Date.now() - started,
      };
    }
    const firstFire = (atAnchor ?? Math.floor(Date.now() / 1000)) + everySec;
    return {
      ok: true,
      content: truncate(
        `Scheduled recurring "${title}" every ${everySec}s, first fire at ${new Date(firstFire * 1000).toLocaleString()} (daemon ${daemon.id.slice(0, 8)}).`,
      ),
      data: daemon,
      latency_ms: Date.now() - started,
    };
  },
};
