// Introspection — read-only, safe.

import { invokeSafe } from '../../tauri';
import {
  abortedResult,
  isRecord,
  rejectUnknown,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

export const cursorPositionTool: Tool = {
  schema: {
    name: 'cursor_position',
    description: 'Return the current mouse cursor position in screen coordinates.',
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
    if (signal.aborted) return abortedResult('cursor_position', started, 'before');
    const result = await invokeSafe<[number, number]>('cursor_position');
    if (signal.aborted) return abortedResult('cursor_position', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: 'Failed to read cursor position.',
        latency_ms: Date.now() - started,
      };
    }
    const [x, y] = result;
    return {
      ok: true,
      content: `cursor at (${x}, ${y})`,
      data: { x, y },
      latency_ms: Date.now() - started,
    };
  },
};

export const screenSizeTool: Tool = {
  schema: {
    name: 'screen_size',
    description: 'Return the size of the primary display in pixels.',
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
    if (signal.aborted) return abortedResult('screen_size', started, 'before');
    const result = await invokeSafe<[number, number]>('screen_size');
    if (signal.aborted) return abortedResult('screen_size', started, 'after');
    if (!result) {
      return {
        ok: false,
        content: 'Failed to read screen size.',
        latency_ms: Date.now() - started,
      };
    }
    const [width, height] = result;
    return {
      ok: true,
      content: `screen size ${width}x${height}`,
      data: { width, height },
      latency_ms: Date.now() - started,
    };
  },
};
