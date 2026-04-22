/**
 * The agent loop sometimes returns its raw structured-JSON envelope to
 * the frontend instead of just the human-readable text. Smaller
 * instruction-tuned models (qwen3:30b-q4 notably) sometimes double-emit
 * — first a prose answer, then the JSON envelope wrapping the same text:
 *
 *   Hello there, how's it going?{"action": "answer", "text": "Hello there, how's it going?"}
 *
 * Both forms should render as a single clean sentence in the UI and via
 * TTS. This helper handles three shapes:
 *
 *   1. Pure envelope: `{"action": "answer", "text": "…"}` → returns `text`
 *   2. Prose + trailing envelope: `Hello…{"action":"answer","text":"Hi"}`
 *      → returns the envelope's `text` (the tail wins because when the
 *      model double-formats, the envelope is the authoritative copy)
 *   3. Anything else → returns unchanged
 *
 * All JSON parsing is guarded so malformed input can never throw.
 */

/**
 * Result shape from tryParseEnvelope:
 *   - action === 'answer' → text is the human-visible answer (may be empty)
 *   - action === 'tool' / anything else → text is '' (the envelope is a
 *     machine-only action intent that should NOT be read aloud or shown
 *     in the transcript)
 */
function tryParseEnvelope(s: string): { action: string; text: string } | null {
  try {
    const p: unknown = JSON.parse(s);
    if (
      p === null ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
      typeof (p as Record<string, unknown>).action !== 'string'
    ) return null;
    const o = p as Record<string, unknown>;
    const action = o.action as string;
    // Answer envelopes carry the human text in `.text`.
    if (action === 'answer' && typeof o.text === 'string') {
      return { action, text: o.text };
    }
    // Tool / other action envelopes (e.g. {"action":"tool","tool":"app_launch",…})
    // are AGENT-INTERNAL intents. The agent loop dispatches the tool call
    // directly; the raw JSON should never reach the UI transcript or TTS.
    // Return empty string so display + speak both skip it.
    return { action, text: '' };
  } catch {
    /* fall through */
  }
  return null;
}

export function unwrapAgentEnvelope(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;

  // Shape 1: the whole string is the envelope.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = tryParseEnvelope(trimmed);
    if (parsed) return parsed.text;
  }

  // Shape 2: prose + trailing envelope. Anchor on the `{"action"` marker
  // because that's the specific envelope shape — arbitrary JSON objects
  // inside prose (code samples, config snippets) shouldn't be touched.
  const anchor = trimmed.search(/\{\s*"action"\s*:/);
  if (anchor > 0 && trimmed.endsWith('}')) {
    const tail = trimmed.slice(anchor);
    const parsed = tryParseEnvelope(tail);
    if (parsed) return parsed.text;
  }

  return raw;
}
