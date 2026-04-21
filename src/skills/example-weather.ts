// Example skill: wraps the (hypothetical) `weather_current` Tauri command as a
// tool named `skill.weather.current`. Use this file as a template for new
// skills — copy it, change the id/name/tools, and drop it into `src/skills/`.

import type { SkillManifest } from '../lib/skills';
import type { Tool, ToolResult } from '../lib/tools';
import { invokeSafe } from '../lib/tauri';

type WeatherReading = {
  readonly location: string;
  readonly temp_c: number;
  readonly conditions: string;
  readonly fetched_at: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(started: number, reason: string): ToolResult {
  return {
    ok: false,
    content: `Invalid tool input: ${reason}`,
    latency_ms: Date.now() - started,
  };
}

const weatherCurrentTool: Tool = {
  schema: {
    name: 'skill.weather.current',
    description: 'Fetch the current weather for a named location.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or place name (e.g. "Vancouver, BC")',
        },
      },
      required: ['location'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal): Promise<ToolResult> => {
    const started = Date.now();

    if (!isRecord(input)) return failure(started, 'expected an object');
    const loc = input.location;
    if (typeof loc !== 'string' || loc.length === 0) {
      return failure(started, '"location" must be a non-empty string');
    }

    if (signal.aborted) {
      return {
        ok: false,
        content: 'skill.weather.current aborted before invocation',
        latency_ms: Date.now() - started,
      };
    }

    const reading = await invokeSafe<WeatherReading>('weather_current', { location: loc });
    if (!reading) {
      return {
        ok: false,
        content: `No weather data available for "${loc}".`,
        latency_ms: Date.now() - started,
      };
    }

    return {
      ok: true,
      content: `${reading.location}: ${reading.temp_c}\u00b0C, ${reading.conditions}`,
      data: reading,
      latency_ms: Date.now() - started,
    };
  },
};

const manifest: SkillManifest = {
  id: 'skill.weather',
  name: 'Weather',
  description: 'Current-conditions lookup via the local weather bridge.',
  version: '0.1.0',
  author: 'Sunny',
  tools: [weatherCurrentTool],
};

export default manifest;
