// Streaming parser for the handful of ANSI / OSC escape sequences we care
// about to keep the terminals store's title + cwd + output buffer in sync.
//
// We do NOT try to re-implement xterm.js — that renders the actual UI.
// This parser only needs to:
//
//   1. Recognize OSC 0/1/2 ("ESC ] <n> ; <title> BEL"|"ST") for window/tab
//      titles, which most macOS shells push on each precmd.
//   2. Recognize OSC 7 ("ESC ] 7 ; file://<host><path> BEL"|"ST") for the
//      current working directory — Apple's /etc/zshrc emits this.
//   3. Strip the output we persist to the ring buffer down to plain text
//      so the AI doesn't have to cope with ANSI.
//
// The parser is **stateful**: PTY output is chunked by a 16ms coalescing
// window in the Rust side, so escape sequences routinely span chunks.
// Callers instantiate one parser per session and feed each chunk through
// `feed()` to receive `{ plain, events }`.
//
// Escape-handling coverage is deliberately narrow. Anything we don't
// recognize is dropped silently from `plain` — better to hide a byte or
// two of gibberish than echo a malformed escape to the AI context.

export type AnsiEvent =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'cwd'; readonly path: string };

type Mode =
  | 'text'
  | 'esc' // just saw ESC (0x1B)
  | 'csi' // ESC [
  | 'osc' // ESC ]
  | 'osc-esc' // saw ESC inside OSC — next char should be \ (ST)
  | 'charset'; // ESC ( ) * + etc — single-byte follow-up

export class AnsiStream {
  private mode: Mode = 'text';
  private oscBuf = '';
  // OSC payloads can legally be quite long (BBEdit pushes ~200 bytes of
  // metadata). Anything beyond this is almost certainly junk or a hostile
  // stream — drop it rather than keep growing.
  private static readonly OSC_MAX = 4096;

  feed(chunk: string): { plain: string; events: AnsiEvent[] } {
    const events: AnsiEvent[] = [];
    let plain = '';

    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i]!;
      const code = ch.charCodeAt(0);

      switch (this.mode) {
        case 'text': {
          if (code === 0x1b) {
            this.mode = 'esc';
          } else if (code === 0x07) {
            // bare BEL outside OSC — skip, don't beep the AI.
          } else if (code === 0x08) {
            // backspace — remove last char from the plain buffer.
            if (plain.length > 0) plain = plain.slice(0, -1);
          } else {
            plain += ch;
          }
          break;
        }
        case 'esc': {
          if (ch === '[') this.mode = 'csi';
          else if (ch === ']') {
            this.mode = 'osc';
            this.oscBuf = '';
          } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+') {
            this.mode = 'charset';
          } else {
            // ESC 7/8 (save/restore cursor), ESC M (reverse index), etc —
            // single-byte escapes. Swallow and return to text.
            this.mode = 'text';
          }
          break;
        }
        case 'csi': {
          // CSI: parameters 0x30..0x3F, intermediates 0x20..0x2F, final 0x40..0x7E.
          if (code >= 0x40 && code <= 0x7e) {
            this.mode = 'text';
          }
          break;
        }
        case 'charset': {
          // Any single byte terminates a charset selection.
          this.mode = 'text';
          break;
        }
        case 'osc': {
          if (code === 0x07) {
            // BEL terminator
            this.flushOsc(events);
            this.mode = 'text';
          } else if (code === 0x1b) {
            this.mode = 'osc-esc';
          } else {
            if (this.oscBuf.length < AnsiStream.OSC_MAX) this.oscBuf += ch;
          }
          break;
        }
        case 'osc-esc': {
          if (ch === '\\') {
            // ESC \ = ST (string terminator)
            this.flushOsc(events);
            this.mode = 'text';
          } else {
            // Malformed — treat as aborted OSC, drop buffer.
            this.oscBuf = '';
            this.mode = 'text';
            // Re-process this character as normal text.
            i -= 1;
          }
          break;
        }
      }
    }

    return { plain, events };
  }

  private flushOsc(events: AnsiEvent[]): void {
    const raw = this.oscBuf;
    this.oscBuf = '';
    if (raw.length === 0) return;

    // `<code>;<payload>`. Some shells omit the semicolon when code is 0/1/2
    // followed by the title directly; handle that conservatively.
    const semi = raw.indexOf(';');
    if (semi < 0) return;
    const codeStr = raw.slice(0, semi);
    const payload = raw.slice(semi + 1);
    if (payload.length === 0) return;

    if (codeStr === '0' || codeStr === '1' || codeStr === '2') {
      const title = sanitizeLine(payload);
      if (title.length > 0) events.push({ kind: 'title', text: title });
      return;
    }

    if (codeStr === '7') {
      // Standard form: file://<host>/<abs-path>. Decode URI-encoded bytes.
      try {
        const url = payload.trim();
        if (url.startsWith('file://')) {
          const stripped = url.slice('file://'.length);
          // <host><path>; path starts at first '/'. Hostnames may be empty.
          const slash = stripped.indexOf('/');
          const path = slash >= 0 ? stripped.slice(slash) : stripped;
          const decoded = decodeURIComponent(path);
          const clean = sanitizeLine(decoded);
          if (clean.length > 0) events.push({ kind: 'cwd', path: clean });
        } else if (url.startsWith('/')) {
          // Some shells push a bare path. Accept it.
          const clean = sanitizeLine(url);
          if (clean.length > 0) events.push({ kind: 'cwd', path: clean });
        }
      } catch {
        // Malformed URL — silently ignore, not worth logging.
      }
      return;
    }
    // Other OSCs (color queries, clipboard, iTerm's 1337, etc.) are
    // intentionally dropped: they don't inform the title/cwd model.
  }
}

function sanitizeLine(text: string): string {
  // Strip control chars except common whitespace; squash whitespace to
  // single spaces so titles fit on one row in the sidebar.
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Heuristic: derive a human-readable label from an OSC title payload.
// macOS zsh tends to push strings like "sunny@macbook:~/code/sunny" or
// "node — ~/code/sunny". Strip the host and collapse long paths to just
// the basename so the sidebar stays readable.
export function labelFromTitle(raw: string, fallback: string): string {
  if (!raw) return fallback;
  let s = raw;
  // "user@host:path" -> "path"
  const colon = s.indexOf(':');
  const at = s.indexOf('@');
  if (at >= 0 && colon > at) s = s.slice(colon + 1);
  // "cmd — path" / "cmd - path" -> "cmd"
  const dash = s.search(/\s[\u2014-]\s/);
  if (dash >= 0) s = s.slice(0, dash);
  s = s.trim();
  if (s.length === 0) return fallback;
  if (s.length > 40) s = `${s.slice(0, 37)}\u2026`;
  return s;
}

// Split an OSC title payload into { label, running } when the shell is
// pushing `cmd — path` style strings. `running` is the leading command
// name; `label` is what belongs in the sidebar title slot.
export function splitTitleRunning(raw: string): { label: string; running: string | null } {
  const dashSplit = raw.split(/\s[\u2014-]\s/);
  if (dashSplit.length < 2) return { label: raw.trim(), running: null };
  const running = dashSplit[0]?.trim() || null;
  const rest = dashSplit.slice(1).join(' — ').trim();
  return { label: rest || raw.trim(), running };
}
