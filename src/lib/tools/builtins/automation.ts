// Automation — mouse + keyboard. All marked dangerous.

import { invokeSafe } from '../../tauri';
import {
  abortedResult,
  enumOf,
  isParseError,
  isRecord,
  rejectUnknown,
  requireNumber,
  requireString,
  requireStringArray,
  validationFailure,
} from '../parse';
import type { Tool } from '../types';

const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;

export const mouseMoveTool: Tool = {
  schema: {
    name: 'mouse_move',
    description: 'Move the mouse cursor to absolute screen coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in pixels' },
        y: { type: 'number', description: 'Y coordinate in pixels' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['x', 'y']);
    if (unknown) return validationFailure(started, unknown.message);
    const x = requireNumber(input, 'x');
    if (isParseError(x)) return validationFailure(started, x.message);
    const y = requireNumber(input, 'y');
    if (isParseError(y)) return validationFailure(started, y.message);
    if (signal.aborted) return abortedResult('mouse_move', started, 'before');
    await invokeSafe<void>('mouse_move', { x, y });
    if (signal.aborted) return abortedResult('mouse_move', started, 'after');
    return {
      ok: true,
      content: `moved cursor to (${x}, ${y})`,
      data: { x, y },
      latency_ms: Date.now() - started,
    };
  },
};

export const mouseClickTool: Tool = {
  schema: {
    name: 'mouse_click',
    description: 'Click the mouse at the current cursor position.',
    input_schema: {
      type: 'object',
      properties: {
        button: { type: 'string', enum: [...MOUSE_BUTTONS], description: 'Which button to click' },
        count: { type: 'integer', enum: [1, 2], description: 'Click count (1 = single, 2 = double)' },
      },
      required: ['button', 'count'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['button', 'count']);
    if (unknown) return validationFailure(started, unknown.message);
    const button = enumOf(input, 'button', MOUSE_BUTTONS);
    if (isParseError(button)) return validationFailure(started, button.message);
    const count = requireNumber(input, 'count');
    if (isParseError(count)) return validationFailure(started, count.message);
    if (count !== 1 && count !== 2) return validationFailure(started, '"count" must be 1 or 2');
    if (signal.aborted) return abortedResult('mouse_click', started, 'before');
    await invokeSafe<void>('mouse_click', { button, count });
    if (signal.aborted) return abortedResult('mouse_click', started, 'after');
    return {
      ok: true,
      content: `clicked ${button} button (${count}x)`,
      data: { button, count },
      latency_ms: Date.now() - started,
    };
  },
};

export const mouseClickAtTool: Tool = {
  schema: {
    name: 'mouse_click_at',
    description: 'Move the cursor to (x, y) and click.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: [...MOUSE_BUTTONS] },
        count: { type: 'integer', minimum: 1, maximum: 3 },
      },
      required: ['x', 'y', 'button', 'count'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['x', 'y', 'button', 'count']);
    if (unknown) return validationFailure(started, unknown.message);
    const x = requireNumber(input, 'x');
    if (isParseError(x)) return validationFailure(started, x.message);
    const y = requireNumber(input, 'y');
    if (isParseError(y)) return validationFailure(started, y.message);
    const button = enumOf(input, 'button', MOUSE_BUTTONS);
    if (isParseError(button)) return validationFailure(started, button.message);
    const count = requireNumber(input, 'count');
    if (isParseError(count)) return validationFailure(started, count.message);
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      return validationFailure(started, '"count" must be an integer 1-3');
    }
    if (signal.aborted) return abortedResult('mouse_click_at', started, 'before');
    await invokeSafe<void>('mouse_click_at', { x, y, button, count });
    if (signal.aborted) return abortedResult('mouse_click_at', started, 'after');
    return {
      ok: true,
      content: `clicked ${button} at (${x}, ${y}) ${count}x`,
      data: { x, y, button, count },
      latency_ms: Date.now() - started,
    };
  },
};

export const mouseScrollTool: Tool = {
  schema: {
    name: 'mouse_scroll',
    description: 'Scroll the mouse wheel by dx/dy steps (positive = right/down).',
    input_schema: {
      type: 'object',
      properties: {
        dx: { type: 'number', description: 'Horizontal scroll amount' },
        dy: { type: 'number', description: 'Vertical scroll amount' },
      },
      required: ['dx', 'dy'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['dx', 'dy']);
    if (unknown) return validationFailure(started, unknown.message);
    const dx = requireNumber(input, 'dx');
    if (isParseError(dx)) return validationFailure(started, dx.message);
    const dy = requireNumber(input, 'dy');
    if (isParseError(dy)) return validationFailure(started, dy.message);
    if (signal.aborted) return abortedResult('mouse_scroll', started, 'before');
    await invokeSafe<void>('mouse_scroll', { dx, dy });
    if (signal.aborted) return abortedResult('mouse_scroll', started, 'after');
    return {
      ok: true,
      content: `scrolled (dx=${dx}, dy=${dy})`,
      data: { dx, dy },
      latency_ms: Date.now() - started,
    };
  },
};

export const keyboardTypeTool: Tool = {
  schema: {
    name: 'keyboard_type',
    description: 'Type arbitrary text as if entered from the keyboard.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['text']);
    if (unknown) return validationFailure(started, unknown.message);
    const text = requireString(input, 'text');
    if (isParseError(text)) return validationFailure(started, text.message);
    if (signal.aborted) return abortedResult('keyboard_type', started, 'before');
    await invokeSafe<void>('keyboard_type', { text });
    if (signal.aborted) return abortedResult('keyboard_type', started, 'after');
    return {
      ok: true,
      content: `typed ${text.length} chars`,
      data: { length: text.length },
      latency_ms: Date.now() - started,
    };
  },
};

const COMMON_KEYS = [
  'return', 'enter', 'tab', 'space', 'escape', 'backspace', 'delete',
  'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown',
  'cmd', 'ctrl', 'shift', 'alt', 'option', 'fn',
  'a','b','c','d','e','f','g','h','i','j','k','l','m',
  'n','o','p','q','r','s','t','u','v','w','x','y','z',
  '0','1','2','3','4','5','6','7','8','9',
  'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12',
  ',','.','/',';','\'','[',']','\\','-','=','`',
] as const;

export const keyboardTapTool: Tool = {
  schema: {
    name: 'keyboard_tap',
    description: 'Tap a single key (no modifiers).',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: [...COMMON_KEYS],
          description: 'Key to tap',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['key']);
    if (unknown) return validationFailure(started, unknown.message);
    const key = requireString(input, 'key');
    if (isParseError(key)) return validationFailure(started, key.message);
    if (!COMMON_KEYS.includes(key.toLowerCase() as typeof COMMON_KEYS[number])) {
      return validationFailure(started, `"key" must be one of the supported keys (got "${key}")`);
    }
    if (signal.aborted) return abortedResult('keyboard_tap', started, 'before');
    await invokeSafe<void>('keyboard_tap', { key: key.toLowerCase() });
    if (signal.aborted) return abortedResult('keyboard_tap', started, 'after');
    return {
      ok: true,
      content: `tapped "${key.toLowerCase()}"`,
      data: { key: key.toLowerCase() },
      latency_ms: Date.now() - started,
    };
  },
};

export const keyboardComboTool: Tool = {
  schema: {
    name: 'keyboard_combo',
    description: 'Press a combination of keys simultaneously (e.g. ["cmd","shift","p"]).',
    input_schema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Ordered list of keys to hold',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal) => {
    const started = Date.now();
    if (!isRecord(input)) return validationFailure(started, 'expected an object');
    const unknown = rejectUnknown(input, ['keys']);
    if (unknown) return validationFailure(started, unknown.message);
    const keys = requireStringArray(input, 'keys');
    if (isParseError(keys)) return validationFailure(started, keys.message);
    const normalized = keys.map(k => k.toLowerCase());
    if (signal.aborted) return abortedResult('keyboard_combo', started, 'before');
    await invokeSafe<void>('keyboard_combo', { keys: normalized });
    if (signal.aborted) return abortedResult('keyboard_combo', started, 'after');
    return {
      ok: true,
      content: `pressed combo ${normalized.join('+')}`,
      data: { keys: normalized },
      latency_ms: Date.now() - started,
    };
  },
};
