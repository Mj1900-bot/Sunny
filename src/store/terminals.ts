// Store of user-facing PTY terminal sessions.
//
// Keeps a single source of truth for every interactive terminal the user
// can see in the HUD or the multi-terminal overlay. Unlike the headless
// `pty_agent_*` family the AI already owns, these are the exact same
// shells the human is staring at — so `tools.terminals.ts` can observe
// and drive them via this store, which is what "if I can do it the AI
// can too" means in practice.
//
// What we track per session:
//   - id:           stable app-level id ("user:overlay-1", "dash:shell", …)
//   - sessionId:    backend PTY key (nonce'd each mount — assigned by
//                   PtyTerminal so StrictMode double-mounts never collide)
//   - title:        what's shown in the sidebar; updated live from OSC 0/1/2
//                   unless the user has pinned it
//   - cwd:          latest absolute directory, parsed from OSC 7
//   - output:       a ~64KB ring buffer of the ANSI-stripped shell output,
//                   so the AI can read "what's on screen" without scraping
//                   the xterm DOM
//   - created_at:   wall-clock ms
//
// The store is intentionally light — no backend calls; the PTY component
// wires read/write/close against `pty_*` tauri commands directly.

import { create } from 'zustand';

export type TerminalOrigin = 'dashboard' | 'overlay';

export type TerminalColor =
  | 'cyan' | 'amber' | 'green' | 'violet' | 'magenta' | 'red' | null;

export type TerminalSession = {
  readonly id: string;
  readonly origin: TerminalOrigin;
  readonly created_at: number;
  // Updated by the PtyTerminal component after its `pty_open` resolves.
  readonly sessionId: string | null;
  // Auto-derived unless the user renames the terminal. `titlePinned`
  // suppresses further auto-updates so a manual rename isn't clobbered
  // by the next cd / process launch.
  readonly title: string;
  readonly titlePinned: boolean;
  readonly cwd: string | null;
  // Best-effort "what's currently running" hint, derived from OSC title
  // updates (most macOS shells push `zsh: <cmd>` into the title as part of
  // precmd/preexec). Null when idle / no signal.
  readonly running: string | null;
  // Ring buffer of recent ANSI-stripped output. Capped to MAX_OUTPUT_BYTES
  // so a `tail -f` on a busy log can't eat memory.
  readonly output: string;
  // Monotonic counter bumped on every output append. The overlay uses
  // the difference between this and `last_seen_tick` to show a "has
  // new activity" indicator in the sidebar for tiles the user hasn't
  // focused recently.
  readonly activity_tick: number;
  readonly last_seen_tick: number;
  readonly color: TerminalColor;
  // --- Stats ---
  readonly commandCount: number;
  readonly outputBytes: number;
};

// 64KB is enough for the AI to see a meaningful slice of recent output
// without bloating store diffs on every draw.
const MAX_OUTPUT_BYTES = 64 * 1024;

export type TerminalsState = {
  sessions: ReadonlyArray<TerminalSession>;
  // Which session is visually focused in the overlay. Separate from the
  // dashboard (which shows all three inline panels at once).
  focusedId: string | null;

  add: (opts?: {
    origin?: TerminalOrigin;
    id?: string;
    title?: string;
    titlePinned?: boolean;
    color?: TerminalColor;
  }) => string;
  remove: (id: string) => void;
  setSessionId: (id: string, sessionId: string | null) => void;
  setTitle: (id: string, title: string, opts?: { pin?: boolean }) => void;
  setAutoTitle: (id: string, title: string) => void;
  setCwd: (id: string, cwd: string) => void;
  setRunning: (id: string, running: string | null) => void;
  appendOutput: (id: string, chunk: string) => void;
  clearOutput: (id: string) => void;
  setFocused: (id: string | null) => void;
  // Clears the "new activity" flag for a session. Used when the user
  // focuses a tile whose sidebar dot was pulsing.
  markSeen: (id: string) => void;
  reorderOverlay: (fromIndex: number, toIndex: number) => void;
  duplicate: (id: string) => string | null;
  setColor: (id: string, color: TerminalColor) => void;
  recordCommand: (id: string) => void;
  clearAllOutput: () => void;
  exportOutput: (id: string) => string;
};

function patchSession(
  list: ReadonlyArray<TerminalSession>,
  id: string,
  patch: (s: TerminalSession) => TerminalSession,
): ReadonlyArray<TerminalSession> {
  let changed = false;
  const next = list.map(s => {
    if (s.id !== id) return s;
    const updated = patch(s);
    if (updated !== s) changed = true;
    return updated;
  });
  return changed ? next : list;
}

function makeId(origin: TerminalOrigin, seq: number): string {
  return `${origin === 'dashboard' ? 'dash' : 'user'}:${seq}`;
}

// Append-and-trim for the output ring buffer. We trim on codepoint
// boundaries (`slice`) to avoid landing inside a multi-byte sequence.
function appendRingBuffer(prev: string, chunk: string): string {
  const combined = prev + chunk;
  if (combined.length <= MAX_OUTPUT_BYTES) return combined;
  return combined.slice(combined.length - MAX_OUTPUT_BYTES);
}

// ---------------------------------------------------------------------------
// Shared event names + payload types for the TerminalsOverlay. Hoisted
// into the store (rather than the overlay component) so the AI's tool
// module can dispatch open/close requests without pulling the lazy
// overlay chunk into the main bundle.
// ---------------------------------------------------------------------------

export const TERMINALS_OPEN_EVENT = 'sunny-terminals-open';
export const TERMINALS_CLOSE_EVENT = 'sunny-terminals-close';

export type TerminalsOpenDetail = {
  readonly focusId?: string;
  readonly fullscreen?: boolean;
  // If no terminal exists yet, seed a new one with this initial command.
  readonly initialCommand?: string;
};

let seq = 0;

export const useTerminals = create<TerminalsState>(set => ({
  sessions: [],
  focusedId: null,

  add: (opts = {}) => {
    seq += 1;
    const origin: TerminalOrigin = opts.origin ?? 'overlay';
    const id = opts.id ?? makeId(origin, seq);
    const title = opts.title ?? (origin === 'dashboard' ? 'shell' : `terminal ${seq}`);
    const session: TerminalSession = {
      id,
      origin,
      created_at: Date.now(),
      sessionId: null,
      title,
      titlePinned: opts.titlePinned ?? false,
      cwd: null,
      running: null,
      output: '',
      activity_tick: 0,
      last_seen_tick: 0,
      color: opts.color ?? null,
      commandCount: 0,
      outputBytes: 0,
    };
    set(s => ({
      sessions: [...s.sessions, session],
      focusedId: s.focusedId ?? (origin === 'overlay' ? id : s.focusedId),
    }));
    return id;
  },

  remove: id => {
    set(s => {
      const sessions = s.sessions.filter(x => x.id !== id);
      let focusedId = s.focusedId;
      if (focusedId === id) {
        // Focus the next overlay terminal if any, otherwise clear.
        focusedId = sessions.find(x => x.origin === 'overlay')?.id ?? null;
      }
      return { sessions, focusedId };
    });
  },

  setSessionId: (id, sessionId) => {
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.sessionId === sessionId ? x : { ...x, sessionId },
      ),
    }));
  },

  setTitle: (id, title, opts = {}) => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    set(s => ({
      sessions: patchSession(s.sessions, id, x => ({
        ...x,
        title: trimmed,
        titlePinned: opts.pin ?? x.titlePinned,
      })),
    }));
  },

  // Auto-updates only apply when the user hasn't pinned the title.
  setAutoTitle: (id, title) => {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.titlePinned || x.title === trimmed ? x : { ...x, title: trimmed },
      ),
    }));
  },

  setCwd: (id, cwd) => {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) return;
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.cwd === trimmed ? x : { ...x, cwd: trimmed },
      ),
    }));
  },

  setRunning: (id, running) => {
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.running === running ? x : { ...x, running },
      ),
    }));
  },

  appendOutput: (id, chunk) => {
    if (chunk.length === 0) return;
    set(s => ({
      sessions: patchSession(s.sessions, id, x => ({
        ...x,
        output: appendRingBuffer(x.output, chunk),
        outputBytes: x.outputBytes + chunk.length,
        activity_tick: x.activity_tick + 1,
      })),
    }));
  },

  clearOutput: id => {
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.output.length === 0 ? x : { ...x, output: '', activity_tick: x.activity_tick + 1 },
      ),
    }));
  },

  setFocused: id => {
    set(s => {
      if (s.focusedId === id) return s;
      // Clear the activity flag on the newly focused tile in the same
      // atomic update so the sidebar dot disappears instantly.
      const sessions =
        id === null
          ? s.sessions
          : patchSession(s.sessions, id, x =>
              x.last_seen_tick === x.activity_tick
                ? x
                : { ...x, last_seen_tick: x.activity_tick },
            );
      return { focusedId: id, sessions };
    });
  },

  markSeen: id => {
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.last_seen_tick === x.activity_tick
          ? x
          : { ...x, last_seen_tick: x.activity_tick },
      ),
    }));
  },

  reorderOverlay: (fromIndex, toIndex) => {
    set(s => {
      const overlays = s.sessions.filter(x => x.origin === 'overlay');
      const others = s.sessions.filter(x => x.origin !== 'overlay');
      if (
        fromIndex < 0 || fromIndex >= overlays.length ||
        toIndex < 0 || toIndex >= overlays.length ||
        fromIndex === toIndex
      ) return s;
      const reordered = [...overlays];
      const [item] = reordered.splice(fromIndex, 1);
      if (!item) return s;
      reordered.splice(toIndex, 0, item);
      return { sessions: [...others, ...reordered] };
    });
  },

  duplicate: id => {
    const source = useTerminals.getState().sessions.find(x => x.id === id);
    if (!source) return null;
    seq += 1;
    const newId = makeId(source.origin, seq);
    const session: TerminalSession = {
      id: newId,
      origin: source.origin,
      created_at: Date.now(),
      sessionId: null,
      title: `${source.title} (copy)`,
      titlePinned: false,
      cwd: null,
      running: null,
      output: '',
      activity_tick: 0,
      last_seen_tick: 0,
      color: source.color,
      commandCount: 0,
      outputBytes: 0,
    };
    set(st => ({
      sessions: [...st.sessions, session],
      focusedId: newId,
    }));
    return newId;
  },

  setColor: (id, color) => {
    set(s => ({
      sessions: patchSession(s.sessions, id, x =>
        x.color === color ? x : { ...x, color },
      ),
    }));
  },

  recordCommand: id => {
    set(s => ({
      sessions: patchSession(s.sessions, id, x => ({
        ...x,
        commandCount: x.commandCount + 1,
      })),
    }));
  },

  clearAllOutput: () => {
    set(s => ({
      sessions: s.sessions.map(x =>
        x.output.length === 0 ? x : { ...x, output: '', activity_tick: x.activity_tick + 1 },
      ),
    }));
  },

  exportOutput: id => {
    const session = useTerminals.getState().sessions.find(x => x.id === id);
    return session?.output ?? '';
  },
}));

// ---------------------------------------------------------------------------
// Non-React accessors. Tool runners use these to read state outside React
// without eating a subscription.
// ---------------------------------------------------------------------------

export function getTerminal(id: string): TerminalSession | null {
  return useTerminals.getState().sessions.find(s => s.id === id) ?? null;
}

export function listTerminals(): ReadonlyArray<TerminalSession> {
  return useTerminals.getState().sessions;
}

export const TERMINALS_MAX_OUTPUT_BYTES = MAX_OUTPUT_BYTES;
