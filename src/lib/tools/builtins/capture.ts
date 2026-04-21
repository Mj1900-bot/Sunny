// Screen capture. The base64 payload is NEVER embedded in `content` — we only
// describe the image; callers can reach for `data` if they need the bytes.

import { invokeSafe } from '../../tauri';
import {
  abortedResult,
  formatBytes,
  isParseError,
  isRecord,
  optionalNumber,
  rejectUnknown,
  requireNumber,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

type ScreenImage = {
  width: number;
  height: number;
  format: string;
  bytes_len: number;
  base64: string;
};

function describeScreenImage(img: ScreenImage): string {
  return `captured ${img.width}x${img.height} ${img.format} screenshot (${formatBytes(img.bytes_len)})`;
}

export const screenCaptureFullTool: Tool = {
  schema: {
    name: 'screen_capture_full',
    description: 'Capture a full-display screenshot. Returns image metadata; base64 bytes only in `data`.',
    input_schema: {
      type: 'object',
      properties: {
        display: { type: 'integer', minimum: 1, description: '1-based display index (optional)' },
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
    let display: number | undefined;
    if (isRecord(input)) {
      const unknown = rejectUnknown(input, ['display']);
      if (unknown) return validationFailure(started, unknown.message);
      const maybe = optionalNumber(input, 'display');
      if (isParseError(maybe)) return validationFailure(started, maybe.message);
      display = maybe;
    }
    if (signal.aborted) return abortedResult('screen_capture_full', started, 'before');
    const img = await invokeSafe<ScreenImage>('screen_capture_full', { display });
    if (signal.aborted) return abortedResult('screen_capture_full', started, 'after');
    if (!img) {
      return {
        ok: false,
        content: 'Failed to capture full screen.',
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: describeScreenImage(img),
      data: img,
      latency_ms: Date.now() - started,
    };
  },
};

export const screenCaptureRegionTool: Tool = {
  schema: {
    name: 'screen_capture_region',
    description: 'Capture a rectangular screen region. Returns image metadata; base64 bytes only in `data`.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number', minimum: 1 },
        h: { type: 'number', minimum: 1 },
      },
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
    },
  },
  dangerous: false,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['x', 'y', 'w', 'h']);
    if (unknown) return validationFailure(started, unknown.message);
    const x = requireNumber(input, 'x');
    if (isParseError(x)) return validationFailure(started, x.message);
    const y = requireNumber(input, 'y');
    if (isParseError(y)) return validationFailure(started, y.message);
    const w = requireNumber(input, 'w');
    if (isParseError(w)) return validationFailure(started, w.message);
    const h = requireNumber(input, 'h');
    if (isParseError(h)) return validationFailure(started, h.message);
    if (w < 1 || h < 1) return validationFailure(started, '"w" and "h" must be >= 1');
    if (signal.aborted) return abortedResult('screen_capture_region', started, 'before');
    const img = await invokeSafe<ScreenImage>('screen_capture_region', { x, y, w, h });
    if (signal.aborted) return abortedResult('screen_capture_region', started, 'after');
    if (!img) {
      return {
        ok: false,
        content: 'Failed to capture region.',
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `${describeScreenImage(img)} @ (${x}, ${y})`,
      data: img,
      latency_ms: Date.now() - started,
    };
  },
};

export const screenCaptureActiveWindowTool: Tool = {
  schema: {
    name: 'screen_capture_active_window',
    description: 'Capture the currently active window. Returns image metadata; base64 bytes only in `data`.',
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
    if (signal.aborted) return abortedResult('screen_capture_active_window', started, 'before');
    const img = await invokeSafe<ScreenImage>('screen_capture_active_window');
    if (signal.aborted) return abortedResult('screen_capture_active_window', started, 'after');
    if (!img) {
      return {
        ok: false,
        content: 'Failed to capture active window.',
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: true,
      content: `active window: ${describeScreenImage(img)}`,
      data: img,
      latency_ms: Date.now() - started,
    };
  },
};
