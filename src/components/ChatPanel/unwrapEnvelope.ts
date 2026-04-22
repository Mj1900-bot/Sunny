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
 * Parse a string that may be a JSON envelope. Whitelist approach — we
 * only recognise the single shape that carries human-readable text
 * ({action:'answer', text:<string>}). Every other JSON object shape
 * is treated as agent-internal metadata (tool intents, verdict blobs,
 * reflexion scores, etc.) and returns empty text so display + TTS
 * both skip it.
 *
 * This is the whitelist because Sunny's agent and models occasionally
 * produce schemas we haven't seen before — tool envelopes, verdict
 * critics, reasoning traces, subagent decisions. Any of them rendered
 * verbatim in the chat or spoken aloud is broken UX. Default-suppress
 * every unrecognised JSON object; a future structured response format
 * can be added here explicitly when needed.
 */
function tryParseEnvelope(s: string): { text: string } | null {
  try {
    const p: unknown = JSON.parse(s);
    if (
      p === null ||
      typeof p !== 'object' ||
      Array.isArray(p)
    ) return null;
    const o = p as Record<string, unknown>;
    // Single known good shape: answer envelope with human-readable text.
    if (o.action === 'answer' && typeof o.text === 'string') {
      return { text: o.text };
    }
    // Everything else is agent-internal metadata → empty text means
    // the UI suppresses the bubble and TTS doesn't speak.
    return { text: '' };
  } catch {
    /* fall through */
  }
  return null;
}

export function unwrapAgentEnvelope(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;

  // Shape 1: the whole string is JSON. Pure envelope case.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const parsed = tryParseEnvelope(trimmed);
    if (parsed) return parsed.text;
  }

  // Shape 2: ```json fenced block (reflexion critics + some models wrap
  // their structured output this way). Strip the fence and retry.
  if (trimmed.startsWith('```json') && trimmed.endsWith('```')) {
    const inner = trimmed.slice('```json'.length, -3).trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      const parsed = tryParseEnvelope(inner);
      if (parsed) return parsed.text;
    }
  }

  // Shape 3: prose + trailing envelope. The anchor matches ANY JSON
  // object that starts at position > 0 and runs to the end — covers
  // {"action":…}, {"verdict":…}, {"tool":…}, etc. Conservative on
  // non-envelope JSON in prose (code examples) because we require the
  // `}` to be the very last non-whitespace character.
  const lastOpen = trimmed.lastIndexOf('{');
  if (lastOpen > 0 && trimmed.endsWith('}')) {
    const tail = trimmed.slice(lastOpen);
    const parsed = tryParseEnvelope(tail);
    if (parsed) {
      // Prose came BEFORE the envelope — use the prose, not the
      // envelope's text (if any). The envelope is the agent's
      // structured echo; the prose is the human-readable version.
      const prose = trimmed.slice(0, lastOpen).trimEnd();
      if (prose.length > 0) return prose;
      return parsed.text;
    }
  }

  return raw;
}
