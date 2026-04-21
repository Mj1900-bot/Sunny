/**
 * The agent loop sometimes returns its raw structured-JSON envelope to
 * the frontend instead of just the human-readable text. Smaller
 * instruction-tuned models (qwen3:30b-q4 notably) produce
 *
 *   {"action": "answer", "text": "Hello, how can I help?"}
 *
 * which the backend may not always strip before handing to the chat
 * panel. If we render that string verbatim, the user sees the JSON
 * literal — technically correct but deeply ugly.
 *
 * This helper pulls the `text` field out when the payload is an envelope
 * shape we recognise, and leaves anything else untouched. It's applied
 * at both render time and speak() time so the chat bubble AND Kokoro
 * read the clean human sentence. All JSON parsing is guarded so bad
 * input can never throw.
 *
 * Recognised shapes:
 *   - `{"action": "answer", "text": "…"}`  → pulls `text`
 *   - `{"action": "…",      "text": "…"}`  → pulls `text` (any action)
 *   - anything else                        → returned unchanged
 *
 * Not recognised / intentionally preserved:
 *   - Plain strings
 *   - JSON arrays
 *   - JSON objects without a `text` field (structured tool calls where
 *     the text extraction happens elsewhere)
 */
export function unwrapAgentEnvelope(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return raw;
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.action === 'string' && typeof obj.text === 'string') {
    return obj.text;
  }

  return raw;
}
