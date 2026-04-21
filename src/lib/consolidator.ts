/**
 * Memory consolidator — periodic LLM-driven extraction of durable semantic
 * facts from the episodic log.
 *
 * This is the "sleep/dream" pass that turns streams of events into stable
 * knowledge. Runs on a slow timer (default 15 min) so it doesn't compete
 * with foreground agent latency, and uses the user's configured chat
 * provider (reusing the normal `chat` IPC — no separate inference path).
 *
 *   backend : memory_consolidator_pending(limit) → EpisodicItem[]
 *                 memory_consolidator_mark_done(ts)
 *                 memory_consolidator_status()
 *   frontend: this module — runs the LLM, parses the JSON, writes facts
 *             via memory_fact_add, advances the watermark
 *
 * Why TS and not Rust: the provider routing (OpenClaw / Ollama / Anthropic)
 * already lives in the frontend chat pipeline. Duplicating it Rust-side
 * would be ~3 pages of plumbing for no user-visible benefit.
 *
 * Degrades silently when Ollama/OpenClaw aren't reachable — each failed
 * tick leaves the watermark untouched, so events accumulate and get
 * processed the next time a model is available.
 */
import { invokeSafe, isTauri } from './tauri';
import { chatFor } from './modelRouter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type EpisodicKind =
  | 'user'
  | 'agent_step'
  | 'tool_call'
  | 'perception'
  | 'note'
  | 'reflection';

type EpisodicItem = {
  readonly id: string;
  readonly kind: EpisodicKind;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
  readonly meta: unknown;
  readonly created_at: number;
};

type ExtractedFact = {
  readonly subject: string;
  readonly text: string;
  readonly confidence: number;
  readonly tags?: ReadonlyArray<string>;
};

export type ConsolidatorOptions = {
  /** How often to run (ms). Default 15 min. */
  readonly tickMs?: number;
  /** How many episodic rows per pass. Default 40 (clamped server-side). */
  readonly batchSize?: number;
  /** Chat provider override. Defaults to user's configured provider. */
  readonly provider?: string;
  /** Chat model override. Defaults to user's configured model. */
  readonly model?: string;
};

// ---------------------------------------------------------------------------
// Settings — read the same key view.ts persists to
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Module-local singleton — startConsolidator / stopConsolidator
// ---------------------------------------------------------------------------

let activeTimer: number | null = null;
let tickInFlight = false;

/**
 * Start the consolidator on a timer. Idempotent — calling twice reuses the
 * existing timer. Returns an unsubscribe function.
 */
export function startConsolidator(opts: ConsolidatorOptions = {}): () => void {
  if (!isTauri) return () => undefined;
  if (activeTimer !== null) return stopConsolidator;

  const tickMs = opts.tickMs ?? 15 * 60_000;

  // First tick is delayed a minute after boot so the first query a user
  // types doesn't contend with a consolidation round.
  const firstDelay = 60_000;
  activeTimer = window.setTimeout(function run() {
    void runTick(opts);
    activeTimer = window.setInterval(() => {
      void runTick(opts);
    }, tickMs);
  }, firstDelay);

  return stopConsolidator;
}

export function stopConsolidator(): void {
  if (activeTimer !== null) {
    window.clearTimeout(activeTimer);
    window.clearInterval(activeTimer);
    activeTimer = null;
  }
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

/**
 * Exposed for manual "consolidate now" triggers from the UI. Safe to call
 * any time; a pass that's already in flight short-circuits the second
 * call rather than overlapping.
 */
export async function runConsolidationOnce(
  opts: ConsolidatorOptions = {},
): Promise<{ processed: number; extracted: number } | null> {
  if (!isTauri) return null;
  if (tickInFlight) return { processed: 0, extracted: 0 };
  tickInFlight = true;
  try {
    return await runTick(opts);
  } finally {
    tickInFlight = false;
  }
}

async function runTick(
  opts: ConsolidatorOptions,
): Promise<{ processed: number; extracted: number }> {
  const batch = opts.batchSize ?? 40;
  const rows = await invokeSafe<ReadonlyArray<EpisodicItem>>('memory_consolidator_pending', {
    limit: batch,
  });
  if (!rows || rows.length === 0) {
    return { processed: 0, extracted: 0 };
  }

  const prompt = buildExtractionPrompt(rows);
  // Consolidation runs on a slow timer and doesn't affect latency — route
  // to the cheap model so overnight passes don't chew through big-model
  // tokens. Callers can still force a route via opts.{provider,model}.
  const routeOverride =
    opts.provider && opts.model ? { provider: opts.provider, model: opts.model } : undefined;
  const raw = await chatFor('consolidation', prompt, { routeOverride });
  if (!raw) {
    // Model was unreachable / returned empty — leave watermark untouched
    // so we re-try this batch next tick.
    console.warn('[consolidator] empty reply; leaving watermark');
    return { processed: 0, extracted: 0 };
  }

  const facts = parseFacts(raw);

  // Write each fact idempotently (semantic.add_fact upserts on
  // (subject, text), so replays are safe).
  let written = 0;
  for (const f of facts) {
    const ok = await invokeSafe('memory_fact_add', {
      subject: f.subject,
      text: f.text,
      tags: [...(f.tags ?? []), 'consolidated'],
      confidence: Math.max(0, Math.min(1, f.confidence)),
      source: 'consolidator',
    });
    if (ok !== null) written += 1;
  }

  // Advance the watermark to the newest processed row's created_at.
  const newestTs = rows.reduce((max, r) => (r.created_at > max ? r.created_at : max), 0);
  if (newestTs > 0) {
    await invokeSafe('memory_consolidator_mark_done', { ts: newestTs });
  }

  if (written > 0) {
    // One log line so the user can see the loop making progress in devtools.
    console.info(`[consolidator] ${rows.length} rows → ${written} facts`);
  }
  return { processed: rows.length, extracted: written };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildExtractionPrompt(rows: ReadonlyArray<EpisodicItem>): string {
  // Cap each row's text so one verbose event can't dominate the window.
  const eventBlock = rows
    .map((r, i) => {
      const when = new Date(r.created_at * 1000).toISOString();
      const text = r.text.length > 400 ? `${r.text.slice(0, 397)}…` : r.text;
      return `${String(i + 1).padStart(2, '0')}. [${when}] (${r.kind}) ${text}`;
    })
    .join('\n');

  return [
    'You are a memory consolidator inside SUNNY, a personal assistant.',
    'You read the recent log of events and extract durable facts about the',
    "user — their preferences, projects, relationships, and recurring",
    'patterns. Facts must be stable (true after the event, not transient),',
    'specific, and actionable.',
    '',
    'OUTPUT FORMAT — reply with a single JSON array. No prose, no markdown',
    'fences. Each element is:',
    '  {',
    '    "subject": "<ontology key like user.preference, project.sunny,',
    '                 contact.mom; empty string if none applies>",',
    '    "text":    "<one concise declarative sentence>",',
    '    "confidence": <float 0.0–1.0>,',
    '    "tags":    ["optional", "labels"]',
    '  }',
    '',
    'Rules:',
    "- Skip anything you can't infer with reasonable certainty.",
    '- Deduplicate: if two events say the same thing, emit one fact.',
    '- Prefer user statements over agent actions as sources of truth.',
    '- Do NOT summarise events; extract facts about the user.',
    '- If no facts are worth extracting, return `[]`.',
    '',
    'RECENT EVENTS:',
    eventBlock,
    '',
    'JSON:',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing — the model occasionally wraps in fences or adds
// prose. Salvage the first balanced array and parse that.
// ---------------------------------------------------------------------------

function parseFacts(raw: string): ReadonlyArray<ExtractedFact> {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const direct = safeParseArray(fenceStripped);
  if (direct) return direct;

  const salvaged = extractLargestArray(fenceStripped);
  if (salvaged) {
    const retry = safeParseArray(salvaged);
    if (retry) return retry;
  }
  return [];
}

function safeParseArray(raw: string): ReadonlyArray<ExtractedFact> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const text = typeof rec.text === 'string' ? rec.text.trim() : '';
      if (!text) continue;
      const subject = typeof rec.subject === 'string' ? rec.subject : '';
      const conf =
        typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
          ? rec.confidence
          : 0.7;
      const tags = Array.isArray(rec.tags)
        ? rec.tags.filter((t): t is string => typeof t === 'string')
        : [];
      facts.push({ subject, text, confidence: conf, tags });
    }
    return facts;
  } catch {
    return null;
  }
}

function extractLargestArray(raw: string): string | null {
  let best: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '[') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < raw.length; j += 1) {
      const ch = raw[j];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          const candidate = raw.slice(i, j + 1);
          if (!best || candidate.length > best.length) best = candidate;
          break;
        }
      }
    }
  }
  return best;
}
