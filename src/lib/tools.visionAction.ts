// Vision-action tools: OCR-driven click. Usage: `import './tools.visionAction';`
// Wires `click_text_on_screen` and `find_text_on_screen` into the shared tool
// registry. Both combine screen capture + OCR so an agent can say
// "click the blue Submit button" and we will find it and click it.

import { invokeSafe } from './tauri';
import { registerTool, type Tool, type ToolResult } from './tools';

// ---------------------------------------------------------------------------
// Backend types — mirrors of the Rust `ScreenImage` and `OcrResult` structs.
// ---------------------------------------------------------------------------

type ScreenImage = {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly bytes_len: number;
  readonly base64: string;
};

type OcrBox = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly confidence: number;
};

type OcrResult = {
  readonly text: string;
  readonly boxes: ReadonlyArray<OcrBox>;
  readonly engine: string;
  readonly width: number;
  readonly height: number;
};

// ---------------------------------------------------------------------------
// Input validation — local, dependency-free, immutable.
// ---------------------------------------------------------------------------

const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;
type MouseButton = typeof MOUSE_BUTTONS[number];

type ClickInput = {
  readonly text: string;
  readonly nth: number;
  readonly button: MouseButton;
  readonly count: number;
};

type FindInput = {
  readonly text: string;
};

type ValidationError = { readonly error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidationError<T>(v: T | ValidationError): v is ValidationError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in (v as Record<string, unknown>) &&
    typeof (v as ValidationError).error === 'string'
  );
}

function validateClickInput(input: unknown): ClickInput | ValidationError {
  if (!isRecord(input)) return { error: 'expected an object' };

  const allowed = ['text', 'nth', 'button', 'count'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return { error: `unknown field "${key}"` };
  }

  const text = input.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { error: '"text" must be a non-empty string' };
  }

  let nth = 1;
  if (input.nth !== undefined && input.nth !== null) {
    if (
      typeof input.nth !== 'number' ||
      !Number.isFinite(input.nth) ||
      !Number.isInteger(input.nth) ||
      input.nth < 1
    ) {
      return { error: '"nth" must be a positive integer (1-indexed)' };
    }
    nth = input.nth;
  }

  let button: MouseButton = 'left';
  if (input.button !== undefined && input.button !== null) {
    if (typeof input.button !== 'string' || !MOUSE_BUTTONS.includes(input.button as MouseButton)) {
      return { error: `"button" must be one of: ${MOUSE_BUTTONS.join(', ')}` };
    }
    button = input.button as MouseButton;
  }

  let count = 1;
  if (input.count !== undefined && input.count !== null) {
    if (
      typeof input.count !== 'number' ||
      !Number.isFinite(input.count) ||
      !Number.isInteger(input.count)
    ) {
      return { error: '"count" must be an integer' };
    }
    count = Math.min(3, Math.max(1, input.count));
  }

  return { text, nth, button, count };
}

function validateFindInput(input: unknown): FindInput | ValidationError {
  if (!isRecord(input)) return { error: 'expected an object' };
  const allowed = ['text'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return { error: `unknown field "${key}"` };
  }
  const text = input.text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { error: '"text" must be a non-empty string' };
  }
  return { text };
}

// ---------------------------------------------------------------------------
// Matching — case-insensitive substring on individual word boxes.
//
// Tesseract emits one box per word, so the "Submit" button appears as a single
// box. If the query is multi-word we also check concatenations of consecutive
// boxes on the same line (same `y`, sorted by `x`) so "Sign Up" can match two
// adjacent boxes.
//
// To avoid clicking the OCR'd cursor character itself (tesseract occasionally
// picks up a stray "I" or "|" glyph where the text cursor sits), we filter
// out very low-confidence boxes (<30) and boxes narrower than 4px or shorter
// than 4px. These tend to be spurious cursor/caret artefacts rather than real
// UI text.
// ---------------------------------------------------------------------------

const MIN_CONFIDENCE = 30;
const MIN_DIMENSION = 4;

type Match = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly confidence: number;
};

function isUsefulBox(box: OcrBox): boolean {
  return (
    box.confidence >= MIN_CONFIDENCE &&
    box.w >= MIN_DIMENSION &&
    box.h >= MIN_DIMENSION &&
    box.text.trim().length > 0
  );
}

function findMatches(boxes: ReadonlyArray<OcrBox>, query: string): ReadonlyArray<Match> {
  const needle = query.trim().toLowerCase();
  const useful = boxes.filter(isUsefulBox);

  const singles: Array<Match> = [];
  for (const box of useful) {
    if (box.text.toLowerCase().includes(needle)) {
      singles.push({
        text: box.text,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        confidence: box.confidence,
      });
    }
  }

  // For multi-word queries, stitch adjacent same-line boxes and test again.
  const multiWord = needle.includes(' ');
  const multis: Array<Match> = [];
  if (multiWord) {
    const byLine = new Map<number, Array<OcrBox>>();
    for (const box of useful) {
      // Bucket boxes by vertical band (rounded to 8px) — cheap "same line".
      const band = Math.round(box.y / 8);
      const list = byLine.get(band) ?? [];
      byLine.set(band, [...list, box]);
    }
    for (const line of byLine.values()) {
      const sorted = [...line].sort((a, b) => a.x - b.x);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < Math.min(sorted.length, i + 8); j++) {
          const slice = sorted.slice(i, j + 1);
          const joined = slice.map(b => b.text).join(' ').toLowerCase();
          if (joined.includes(needle)) {
            const minX = Math.min(...slice.map(b => b.x));
            const minY = Math.min(...slice.map(b => b.y));
            const maxR = Math.max(...slice.map(b => b.x + b.w));
            const maxB = Math.max(...slice.map(b => b.y + b.h));
            const avgConf =
              slice.reduce((a, b) => a + b.confidence, 0) / slice.length;
            multis.push({
              text: slice.map(b => b.text).join(' '),
              x: minX,
              y: minY,
              w: maxR - minX,
              h: maxB - minY,
              confidence: avgConf,
            });
          }
        }
      }
    }
  }

  // Deduplicate overlapping boxes — if two matches cover >60% of the same
  // area, keep the higher-confidence one. Prevents double-counting when a
  // word appears inside a stitched multi-word match.
  const combined = [...singles, ...multis];
  const kept: Array<Match> = [];
  for (const m of combined) {
    const duplicate = kept.find(k => overlapRatio(k, m) > 0.6);
    if (!duplicate) {
      kept.push(m);
    } else if (m.confidence > duplicate.confidence) {
      const idx = kept.indexOf(duplicate);
      kept.splice(idx, 1, m);
    }
  }

  // Sort top-to-bottom, left-to-right so "nth" is intuitive.
  return [...kept].sort((a, b) => a.y - b.y || a.x - b.x);
}

function overlapRatio(a: Match, b: Match): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  if (smaller <= 0) return 0;
  return inter / smaller;
}

// ---------------------------------------------------------------------------
// Shared pipeline — capture then OCR. Returns structured errors so each tool
// can report a caller-friendly message.
// ---------------------------------------------------------------------------

type PipelineFailure =
  | { readonly kind: 'capture'; readonly content: string }
  | { readonly kind: 'ocr'; readonly content: string }
  | { readonly kind: 'aborted' };

type PipelineSuccess = {
  readonly kind: 'ok';
  readonly image: ScreenImage;
  readonly ocr: OcrResult;
};

type PipelineResult = PipelineSuccess | PipelineFailure;

async function captureAndOcr(signal: AbortSignal): Promise<PipelineResult> {
  if (signal.aborted) return { kind: 'aborted' };

  const image = await invokeSafe<ScreenImage>('screen_capture_full', { display: 0 });
  if (signal.aborted) return { kind: 'aborted' };
  if (!image) {
    return {
      kind: 'capture',
      content: 'screen capture unavailable — check Screen Recording permission',
    };
  }

  if (signal.aborted) return { kind: 'aborted' };

  let ocr: OcrResult | null = null;
  try {
    // Tauri v2 auto-renames snake_case Rust args to camelCase on the JS
    // side — the Rust command accepts `png_base64` but must be invoked
    // as `pngBase64`.
    ocr = await invokeSafe<OcrResult>('ocr_image_base64', { pngBase64: image.base64 });
  } catch {
    ocr = null;
  }
  if (signal.aborted) return { kind: 'aborted' };
  if (!ocr) {
    return {
      kind: 'ocr',
      content: 'ocr unavailable — brew install tesseract',
    };
  }

  return { kind: 'ok', image, ocr };
}

// ---------------------------------------------------------------------------
// Tool 1 — find_text_on_screen (read-only inspection).
// ---------------------------------------------------------------------------

const findTextOnScreenTool: Tool = {
  schema: {
    name: 'find_text_on_screen',
    description:
      'Capture the screen and return all OCR boxes whose text contains the query (case-insensitive). Read-only; use before `click_text_on_screen` to reason about layout.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to search for (case-insensitive)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    const parsed = validateFindInput(input);
    if (isValidationError(parsed)) {
      return {
        ok: false,
        content: `Invalid tool input: ${parsed.error}`,
        latency_ms: Math.round(performance.now() - started),
      };
    }

    const pipeline = await captureAndOcr(signal);
    if (pipeline.kind === 'aborted') {
      return {
        ok: false,
        content: 'find_text_on_screen aborted',
        latency_ms: Math.round(performance.now() - started),
      };
    }
    if (pipeline.kind !== 'ok') {
      return {
        ok: false,
        content: pipeline.content,
        latency_ms: Math.round(performance.now() - started),
      };
    }

    const matches = findMatches(pipeline.ocr.boxes, parsed.text);
    const summary =
      matches.length === 0
        ? `no match for "${parsed.text}" on screen`
        : `${matches.length} matches for "${parsed.text}"\n` +
          matches
            .map(
              (m, i) =>
                `#${i + 1}: "${m.text}" @ (${Math.round(m.x)}, ${Math.round(m.y)}) ${Math.round(m.w)}x${Math.round(m.h)} conf=${Math.round(m.confidence)}`,
            )
            .join('\n');

    return {
      ok: true,
      content: summary,
      data: {
        query: parsed.text,
        screen: { width: pipeline.ocr.width, height: pipeline.ocr.height },
        matches: matches.map(m => ({
          text: m.text,
          x: Math.round(m.x),
          y: Math.round(m.y),
          w: Math.round(m.w),
          h: Math.round(m.h),
          center_x: Math.round(m.x + m.w / 2),
          center_y: Math.round(m.y + m.h / 2),
          confidence: Math.round(m.confidence),
        })),
      },
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2 — click_text_on_screen (capture + OCR + click).
// ---------------------------------------------------------------------------

const clickTextOnScreenTool: Tool = {
  schema: {
    name: 'click_text_on_screen',
    description:
      'Capture the screen, OCR it, find the Nth box whose text contains the query (case-insensitive), and click its centre. Combines `screen_capture_full`, `ocr_image_base64`, and `mouse_click_at` into one atomic action.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to search for (case-insensitive)' },
        nth: {
          type: 'integer',
          minimum: 1,
          description: '1-indexed match to click when multiple boxes match (default 1)',
        },
        button: {
          type: 'string',
          enum: [...MOUSE_BUTTONS],
          description: 'Mouse button to click with (default "left")',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'Click count 1-3 (default 1)',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  dangerous: true,
  run: async (input, signal): Promise<ToolResult> => {
    const started = performance.now();
    const parsed = validateClickInput(input);
    if (isValidationError(parsed)) {
      return {
        ok: false,
        content: `Invalid tool input: ${parsed.error}`,
        latency_ms: Math.round(performance.now() - started),
      };
    }

    const pipeline = await captureAndOcr(signal);
    if (pipeline.kind === 'aborted') {
      return {
        ok: false,
        content: 'click_text_on_screen aborted',
        latency_ms: Math.round(performance.now() - started),
      };
    }
    if (pipeline.kind !== 'ok') {
      return {
        ok: false,
        content: pipeline.content,
        latency_ms: Math.round(performance.now() - started),
      };
    }

    const matches = findMatches(pipeline.ocr.boxes, parsed.text);
    if (matches.length === 0) {
      return {
        ok: false,
        content: `no match for "${parsed.text}" on screen`,
        latency_ms: Math.round(performance.now() - started),
      };
    }
    if (parsed.nth > matches.length) {
      return {
        ok: false,
        content: `only ${matches.length} matches for "${parsed.text}" — nth=${parsed.nth} out of range`,
        data: { matches_found: matches.length },
        latency_ms: Math.round(performance.now() - started),
      };
    }

    const chosen = matches[parsed.nth - 1];
    const x = Math.round(chosen.x + chosen.w / 2);
    const y = Math.round(chosen.y + chosen.h / 2);

    if (signal.aborted) {
      return {
        ok: false,
        content: 'click_text_on_screen aborted',
        latency_ms: Math.round(performance.now() - started),
      };
    }

    await invokeSafe<void>('mouse_click_at', {
      x,
      y,
      button: parsed.button,
      count: parsed.count,
    });

    return {
      ok: true,
      content: `clicked "${chosen.text}" at (${x}, ${y})`,
      data: {
        x,
        y,
        matched_text: chosen.text,
        button: parsed.button,
        count: parsed.count,
        nth: parsed.nth,
        total_matches: matches.length,
      },
      latency_ms: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------
// Self-register at module load. The orchestrator adds a side-effect import
// (`import './tools.visionAction';`) somewhere in the boot path.
// ---------------------------------------------------------------------------

registerTool(findTextOnScreenTool);
registerTool(clickTextOnScreenTool);
