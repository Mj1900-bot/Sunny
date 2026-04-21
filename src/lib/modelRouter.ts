/**
 * Model router — purpose-based provider/model selection.
 *
 * Before this module, every auxiliary LLM call (reflection, introspection,
 * consolidation, synthesizer-driven future work) shared the same provider
 * + model as foreground planning. That meant:
 *
 *   • A 15-min consolidator pass hit the big model every time, costing
 *     ~5–10× more tokens than a small model would. For local Ollama users
 *     that's a huge CPU/GPU hit; for OpenClaw users it's real dollars.
 *
 *   • Latency for reflection / introspection tracked the big model even
 *     though they're structured JSON extractions that a 3B model handles
 *     reliably.
 *
 *   • A single-provider failure took out planning AND introspection at
 *     once, so the agent had no graceful-degradation path.
 *
 * The router fixes all three by letting each "purpose" pick its own
 * (provider, model) pair. Defaults favour a cheap local model for the
 * metacognitive passes and keep the user's configured provider for
 * planning. Users can override any purpose individually via settings.
 *
 * Usage (callers):
 *
 *   const reply = await chatFor('reflection', prompt);
 *
 * That's the whole API. `chatFor` returns a string (final answer from the
 * chat IPC) or throws if the transport failed. Callers that want the
 * granular provider/model (for logging) can call `resolveRoute(purpose)`.
 */

import { invokeSafe, isTauri } from './tauri';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Every purpose that touches the LLM surface. Adding a new one is a
 * four-line change:
 *   1. Extend this union.
 *   2. Add a DEFAULT_ROUTES entry.
 *   3. Add an optional settings override field below.
 *   4. Call `chatFor('<new-purpose>', prompt)`.
 */
export type ChatPurpose =
  | 'planning'       // The main agent loop (user-facing latency matters)
  | 'reflection'     // Post-run lesson extraction (background, can be slow)
  | 'introspection'  // Pre-run clarify/direct decision (on critical path!)
  | 'consolidation'  // Episodic → semantic extraction (background)
  | 'critic'         // Dangerous-action review (on critical path, must be fast)
  | 'decomposition'  // HTN: detect complex goals and split into sub-goals
  | 'synthesis';     // Future — tool-sequence generalization

export type Route = {
  readonly provider: string;
  readonly model: string;
  /** Why this route was chosen — logged with every call for debuggability. */
  readonly source: 'override' | 'default';
};

export type ChatOptions = {
  readonly signal?: AbortSignal;
  /** Force a specific route, bypassing settings and defaults. */
  readonly routeOverride?: { provider: string; model: string };
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default models per purpose. The "planning" slot picks up whatever the
 * user configured in settings (falling back to Ollama llama3.2). Every
 * background purpose defaults to a small local model so the consolidator
 * doesn't bleed tokens at 3am on the user's configured big-model budget.
 *
 * Why qwen2.5:3b?
 *   - ~2 GB, fits on anyone's disk, runs on CPU if GPU is busy
 *   - Strong JSON-following at 3B parameters (many cheap models flunk this)
 *   - Apache-licensed so redistribution is clean
 *
 * Users without that model pulled still get llama3.2 (also widely installed)
 * via the catch-all below. Neither model is strictly required — if Ollama
 * is off entirely, `chatFor` returns null and callers degrade gracefully.
 */
const DEFAULT_CHEAP_MODEL = 'qwen2.5:3b';
const DEFAULT_CHEAP_FALLBACK = 'llama3.2';

const DEFAULT_ROUTES: Record<ChatPurpose, { provider: string; model: string }> = {
  planning:      { provider: 'inherit', model: 'inherit' }, // read from settings
  reflection:    { provider: 'ollama', model: DEFAULT_CHEAP_MODEL },
  introspection: { provider: 'ollama', model: DEFAULT_CHEAP_MODEL },
  consolidation: { provider: 'ollama', model: DEFAULT_CHEAP_MODEL },
  critic:        { provider: 'ollama', model: DEFAULT_CHEAP_MODEL },
  decomposition: { provider: 'ollama', model: DEFAULT_CHEAP_MODEL },
  synthesis:     { provider: 'ollama', model: DEFAULT_CHEAP_MODEL },
};

// ---------------------------------------------------------------------------
// Settings — per-purpose overrides
// ---------------------------------------------------------------------------

type PersistedSettings = {
  readonly provider?: string;
  readonly model?: string;
  // Per-purpose overrides. Each is `{ provider, model }` or absent.
  readonly routes?: Partial<Record<ChatPurpose, { provider?: string; model?: string }>>;
};

function readSettings(): PersistedSettings {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem('sunny.settings.v1');
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const routes = isRecord(parsed.routes) ? (parsed.routes as PersistedSettings['routes']) : undefined;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      routes,
    };
  } catch {
    return {};
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the final (provider, model) for a purpose. Precedence:
 *   1. per-purpose override in settings.routes.<purpose>
 *   2. purpose default (possibly resolved from settings.provider/model
 *      when the default says "inherit")
 *   3. DEFAULT_CHEAP_FALLBACK if the above end up empty
 */
export function resolveRoute(purpose: ChatPurpose): Route {
  const settings = readSettings();
  const override = settings.routes?.[purpose];
  if (override && override.provider && override.model) {
    return {
      provider: override.provider,
      model: override.model,
      source: 'override',
    };
  }

  const def = DEFAULT_ROUTES[purpose];
  if (def.provider === 'inherit' || def.model === 'inherit') {
    return {
      provider: settings.provider ?? 'ollama',
      model: settings.model ?? DEFAULT_CHEAP_FALLBACK,
      source: 'default',
    };
  }
  return { provider: def.provider, model: def.model, source: 'default' };
}

// ---------------------------------------------------------------------------
// Public entry point — the thin wrapper over `chat` IPC
// ---------------------------------------------------------------------------

/**
 * Dispatch a chat call for a given purpose. Returns the model's reply, or
 * null when Tauri isn't available / the IPC failed / an empty reply came
 * back. Callers are expected to treat null as "skip this operation" and
 * degrade gracefully — same contract every metacognitive module in the
 * codebase already follows.
 */
export async function chatFor(
  purpose: ChatPurpose,
  message: string,
  opts: ChatOptions = {},
): Promise<string | null> {
  if (!isTauri) return null;
  if (!message || message.trim().length === 0) return null;

  const route =
    opts.routeOverride && opts.routeOverride.provider && opts.routeOverride.model
      ? {
          provider: opts.routeOverride.provider,
          model: opts.routeOverride.model,
          source: 'override' as const,
        }
      : resolveRoute(purpose);

  const reply = await invokeSafe<string>('chat', {
    req: {
      message,
      provider: route.provider,
      model: route.model,
    },
  });
  if (typeof reply !== 'string' || reply.trim().length === 0) return null;
  return reply;
}

/**
 * Test-only surface. Not used by production code paths.
 */
export const __internal = {
  DEFAULT_ROUTES,
  DEFAULT_CHEAP_MODEL,
  DEFAULT_CHEAP_FALLBACK,
};
