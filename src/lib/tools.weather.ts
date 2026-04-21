// Weather + time tools — let SUNNY answer "what's the weather" and
// "what time is it in Tokyo" by calling into the Rust backend's
// tools_weather module (open-meteo.com under the hood, no API key).
//
// Usage: `import './lib/tools.weather';` — self-registers on import.
//
// Tools provided:
//   weather_current   — current conditions for a city
//   weather_forecast  — next N days (clamped 1..7)
//   time_in_city      — local time + timezone offset
//   sunrise_sunset    — today's sunrise / sunset
//
// All four are read-only (dangerous: false). The Rust side enforces a
// 10 s HTTP timeout per outbound call, so we don't race it here.

import { registerTool, type Tool, type ToolResult } from './tools';
import { invoke } from './tauri';

// ---------------------------------------------------------------------------
// Local validation helpers (mirror tools.terminals.ts — kept inline so this
// module has no cross-imports with the builtin tools folder).
// ---------------------------------------------------------------------------

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

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined | ParseError {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { message: `"${key}" must be a finite number if provided` };
  }
  return value;
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

function abortedResult(name: string, started: number, when: 'before' | 'after'): ToolResult {
  return {
    ok: false,
    content: `Tool "${name}" aborted ${when} invocation`,
    latency_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Tauri bridge: we use `invoke` (not `invokeSafe`) so the Err(String) the
// Rust command returns propagates up as a catchable exception with the
// actual message intact. `invokeSafe` swallows the reason into a
// console.error + null, which would reduce every failure to a generic
// "tool returned null" — unhelpful for the LLM's error handling path.
// ---------------------------------------------------------------------------

async function callWeatherCommand(
  command: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  try {
    const value = await invoke<string>(command, args);
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const weatherCurrentTool: Tool = {
  schema: {
    name: 'weather_current',
    description:
      'Get current weather (temperature, condition, wind, humidity) for a named city. Uses open-meteo.com — no API key, global coverage. Returns a single sentence suitable for speaking aloud.',
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name, optionally with country (e.g. "Vancouver", "Tokyo", "Paris, France").',
        },
      },
      required: ['city'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('weather_current', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['city']);
    if (unknown) return validationFailure(started, unknown.message);
    const city = requireString(input, 'city');
    if (isParseError(city)) return validationFailure(started, city.message);

    const result = await callWeatherCommand('tool_weather_current', { city });
    if (signal.aborted) return abortedResult('weather_current', started, 'after');
    if (result.ok) {
      return { ok: true, content: result.value, latency_ms: Date.now() - started };
    }
    return { ok: false, content: (result as { ok: false; error: string }).error, latency_ms: Date.now() - started };
  },
};

const weatherForecastTool: Tool = {
  schema: {
    name: 'weather_forecast',
    description:
      'Get a multi-day weather forecast (daily highs, lows, and conditions) for a named city. Days is clamped to 1..7 by the backend.',
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name, optionally with country.',
        },
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 7,
          description: 'How many days to forecast (1..7). Defaults to 3 if omitted.',
        },
      },
      required: ['city'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('weather_forecast', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['city', 'days']);
    if (unknown) return validationFailure(started, unknown.message);
    const city = requireString(input, 'city');
    if (isParseError(city)) return validationFailure(started, city.message);
    const daysIn = optionalNumber(input, 'days');
    if (isParseError(daysIn)) return validationFailure(started, daysIn.message);

    const days = clampDays(daysIn ?? 3);
    const result = await callWeatherCommand('tool_weather_forecast', { city, days });
    if (signal.aborted) return abortedResult('weather_forecast', started, 'after');
    if (result.ok) {
      return { ok: true, content: result.value, latency_ms: Date.now() - started };
    }
    return { ok: false, content: (result as { ok: false; error: string }).error, latency_ms: Date.now() - started };
  },
};

function clampDays(n: number): number {
  const whole = Math.trunc(n);
  if (!Number.isFinite(whole) || whole < 1) return 1;
  if (whole > 7) return 7;
  return whole;
}

const timeInCityTool: Tool = {
  schema: {
    name: 'time_in_city',
    description:
      'Get the current local time and timezone for a named city (e.g. "13:42 JST (UTC+9), Monday 18 April"). Uses the IANA timezone associated with the geocoded location.',
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name, optionally with country.',
        },
      },
      required: ['city'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('time_in_city', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['city']);
    if (unknown) return validationFailure(started, unknown.message);
    const city = requireString(input, 'city');
    if (isParseError(city)) return validationFailure(started, city.message);

    const result = await callWeatherCommand('tool_time_in_city', { city });
    if (signal.aborted) return abortedResult('time_in_city', started, 'after');
    if (result.ok) {
      return { ok: true, content: result.value, latency_ms: Date.now() - started };
    }
    return { ok: false, content: (result as { ok: false; error: string }).error, latency_ms: Date.now() - started };
  },
};

const sunriseSunsetTool: Tool = {
  schema: {
    name: 'sunrise_sunset',
    description:
      "Get today's sunrise and sunset times for a named city, in that city's local timezone.",
    input_schema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name, optionally with country.',
        },
      },
      required: ['city'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (signal.aborted) return abortedResult('sunrise_sunset', started, 'before');
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['city']);
    if (unknown) return validationFailure(started, unknown.message);
    const city = requireString(input, 'city');
    if (isParseError(city)) return validationFailure(started, city.message);

    const result = await callWeatherCommand('tool_sunrise_sunset', { city });
    if (signal.aborted) return abortedResult('sunrise_sunset', started, 'after');
    if (result.ok) {
      return { ok: true, content: result.value, latency_ms: Date.now() - started };
    }
    return { ok: false, content: (result as { ok: false; error: string }).error, latency_ms: Date.now() - started };
  },
};

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

[
  weatherCurrentTool,
  weatherForecastTool,
  timeInCityTool,
  sunriseSunsetTool,
].forEach(registerTool);
