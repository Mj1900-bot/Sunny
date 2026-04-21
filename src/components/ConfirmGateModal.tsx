/**
 * ConfirmGateModal — user-facing gate for the Rust agent_loop's
 * ConfirmGate handshake.
 *
 * The Rust side emits `sunny://agent.confirm.request` whenever a
 * side-effectful tool (mail_send, imessage_send, shortcut_run, ...) is
 * about to fire, then blocks the ReAct loop for up to 30 s waiting on
 * `sunny://agent.confirm.response` with `{ id, approved, reason? }`.
 *
 * This component owns the frontend side of that handshake:
 *   - A listener bridge pushes incoming requests into the `confirmGate`
 *     store.
 *   - The modal renders the oldest queued request.
 *   - Allow / Deny buttons (and Enter / Escape hotkeys) call
 *     `useConfirmGate.resolve(...)`, which emits the response event and
 *     pops the head of the queue.
 *   - After 30 s without user action the request auto-denies with
 *     "timeout - no user input" so the frontend's state matches the
 *     Rust-side timeout.
 *
 * Mount once, near the top of the HUD (below Dashboard chrome,
 * above other overlays). Invisible when the queue is empty.
 */

import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type JSX,
} from 'react';
import { invokeSafe, listen } from '../lib/tauri';
import { useView } from '../store/view';
import {
  useConfirmGate,
  type ConfirmRequest,
} from '../store/confirmGate';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Rust side times out at 30 s — keep the frontend in lock-step so we
// don't auto-deny after the Rust waiter is already gone (harmless, but
// noisy) and never leave a stale modal on screen past the agent's
// deadline.
const REQUEST_TIMEOUT_MS = 30_000;

const REQUEST_EVENT = 'sunny://agent.confirm.request';

// Tool-name -> short human-readable description. Kept small and flat on
// purpose: the goal is "what is SUNNY about to do?", not full docs. Unknown
// tools fall through to a generic "Run a tool action" label.
const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  mail_send: 'Send an email',
  imessage_send: 'Send an iMessage',
  sms_send: 'Send a text message',
  shortcut_run: 'Run a macOS Shortcut',
  app_launch: 'Launch an app',
  app_quit: 'Quit an app',
  calendar_create_event: 'Create a calendar event',
  calendar_delete_event: 'Delete a calendar event',
  reminders_add: 'Add a reminder',
  reminders_complete: 'Complete a reminder',
  browser_open: 'Open a URL in the browser',
  browser_navigate: 'Navigate the browser to a URL',
  run_shell: 'Execute a shell command',
  exec: 'Execute a shell command',
  file_write: 'Write a file to disk',
  file_delete: 'Delete a file',
  notify: 'Post a system notification',
};

function describeTool(name: string): string {
  return TOOL_DESCRIPTIONS[name] ?? 'Run a tool action';
}

// ---------------------------------------------------------------------------
// Voice-flow: speak the confirmation prompt when the surrounding turn is
// voice-driven. We read the current VoiceState off the `data-voice-state`
// attribute that `VoiceButton` mirrors to the DOM — this keeps the modal
// decoupled from the `useVoiceChat` hook tree (the hook is owned by the
// Overview page and can't be subscribed to safely from here).
//
// Only "voice-adjacent" states get a spoken prompt: the user is in a turn
// (`thinking`, `speaking`) or at rest between turns (`idle`). `recording`
// and `transcribing` are skipped to avoid SUNNY talking over an open mic.
// ---------------------------------------------------------------------------

const VOICE_STATES_TO_SPEAK: ReadonlySet<string> = new Set([
  'idle',
  'speaking',
  'thinking',
]);

function readVoiceState(): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLElement>('[data-voice-state]');
  return el?.getAttribute('data-voice-state') ?? null;
}

function buildSpokenPrompt(name: string, preview?: string): string {
  const verb = describeTool(name).toLowerCase();
  const trimmedPreview = preview?.trim();
  if (trimmedPreview && trimmedPreview.length > 0 && trimmedPreview.length <= 140) {
    return `SUNNY wants to ${verb}: ${trimmedPreview}. Say yes or no — press enter to approve, escape to deny.`;
  }
  return `SUNNY wants to ${verb}. Press enter to approve, or escape to deny.`;
}

// ---------------------------------------------------------------------------
// Requester badge formatting
// ---------------------------------------------------------------------------

type RequesterKind = 'main' | 'sub-agent';

type RequesterBadge = {
  readonly kind: RequesterKind;
  readonly label: string;
};

function formatRequester(raw: string | undefined): RequesterBadge {
  if (!raw || raw === 'main') {
    return { kind: 'main', label: 'MAIN' };
  }
  // Sub-agent ids are UUIDs from the Rust side. Shorten to keep the
  // badge legible ("researcher:7f2a" reads cleanly; full UUID does not).
  // If the caller passed a colon-delimited "role:id" use the role part
  // verbatim and shorten the id; otherwise show the first 4 chars.
  const trimmed = raw.trim();
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    const role = parts[0] ?? 'sub';
    const id = parts[parts.length - 1] ?? '';
    const shortId = id.slice(0, 4);
    const label = shortId ? `${role.toUpperCase()}:${shortId}` : role.toUpperCase();
    return { kind: 'sub-agent', label };
  }
  const shortId = trimmed.slice(0, 6);
  return { kind: 'sub-agent', label: `SUB-AGENT:${shortId}` };
}

// ---------------------------------------------------------------------------
// Listener bridge — single subscription, mounted alongside the modal.
// ---------------------------------------------------------------------------

function useConfirmRequestBridge(): void {
  const push = useConfirmGate(s => s.push);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const stop = await listen<Omit<ConfirmRequest, 'receivedAt'>>(
        REQUEST_EVENT,
        req => {
          if (!active) return;
          if (!req || typeof req.id !== 'string' || typeof req.name !== 'string') return;
          push({
            id: req.id,
            name: req.name,
            preview: req.preview,
            requester: req.requester,
          });
        },
      );
      if (!active) {
        stop();
        return;
      }
      unlisten = stop;
    })();
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [push]);
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function ConfirmGateModal(): JSX.Element | null {
  useConfirmRequestBridge();
  const head = useConfirmGate(s => s.queue[0]);
  const resolve = useConfirmGate(s => s.resolve);

  if (!head) return null;

  return (
    <ConfirmCard
      key={head.id}
      item={head}
      onAllow={() => resolve(head.id, true)}
      onDeny={(reason?: string) =>
        resolve(head.id, false, reason ?? 'user denied')
      }
      onTimeout={() =>
        resolve(head.id, false, 'timeout - no user input')
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

type CardProps = {
  readonly item: ConfirmRequest;
  readonly onAllow: () => void;
  readonly onDeny: (reason?: string) => void;
  readonly onTimeout: () => void;
};

function ConfirmCard({ item, onAllow, onDeny, onTimeout }: CardProps): JSX.Element {
  const allowBtnRef = useRef<HTMLButtonElement | null>(null);
  const voiceName = useView(s => s.settings.voiceName);
  const voiceRate = useView(s => s.settings.voiceRate);
  const reducedMotion = useView(s => s.settings.reducedMotion);
  const badge = useMemo(() => formatRequester(item.requester), [item.requester]);
  const description = useMemo(() => describeTool(item.name), [item.name]);
  const preview = item.preview && item.preview.length > 0 ? item.preview : item.name;

  // Focus Allow by default so Enter triggers the primary action without
  // a tab. Escape still denies regardless of focus (window listener).
  useEffect(() => {
    allowBtnRef.current?.focus();
  }, [item.id]);

  // Voice-flow: if the current turn is voice-driven, speak the prompt
  // through Kokoro (George by default, rate from settings). Keyboard
  // remains the only way to actually approve/deny for now — voice
  // recognition of "yes/no" is a follow-up (mic cycle not yet wired
  // for side-conversation into an open modal).
  useEffect(() => {
    const vs = readVoiceState();
    if (!vs || !VOICE_STATES_TO_SPEAK.has(vs)) return;
    const text = buildSpokenPrompt(item.name, item.preview);
    void invokeSafe<void>('speak', {
      text,
      voice: voiceName || 'George',
      rate: voiceRate,
    });
  }, [item.id, item.name, item.preview, voiceName, voiceRate]);

  // Enter = Allow, Esc = Deny. Window-level so the modal responds even
  // when a background panel still holds focus at mount time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDeny('user denied via escape');
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onAllow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAllow, onDeny]);

  // Auto-deny on Rust-side timeout to stay in sync. We tie the timer to
  // the request id so re-mounts don't multiply deadlines.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      onTimeout();
    }, REQUEST_TIMEOUT_MS);
    return () => window.clearTimeout(handle);
  }, [item.id, onTimeout]);

  const cyan = 'var(--cyan, #39e5ff)';
  const amber = 'var(--amber, #ffb347)';
  const red = 'var(--red, #ff4d5e)';
  const ink = 'var(--ink, #e6f8ff)';
  const ink2 = 'var(--ink-2, #a9d4e5)';

  const backdrop: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 10001,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.4)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  };
  // fix #6: prefers-reduced-transparency guard applied via className below

  const isSubAgent = badge.kind === 'sub-agent';
  const accent = isSubAgent ? amber : cyan;
  const accentGlow = isSubAgent
    ? 'rgba(255, 179, 71, 0.35)'
    : 'rgba(57, 229, 255, 0.35)';

  const pulseAnimation = reducedMotion
    ? 'none'
    : 'sunny-confirmgate-pulse 2.4s ease-in-out infinite';

  const card: CSSProperties = {
    position: 'relative',
    minWidth: 480,
    maxWidth: 640,
    background: 'rgba(8, 16, 22, 0.96)',
    border: '1px solid rgba(140, 190, 210, 0.18)',
    boxShadow: `0 0 0 1px rgba(0,0,0,0.4), 0 24px 72px rgba(0,0,0,0.65), 0 0 48px ${accentGlow}`,
    color: ink,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    animation: pulseAnimation,
  };

  const leftBar: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    background: accent,
    boxShadow: `0 0 12px ${accentGlow}`,
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 22px 12px 26px',
    borderBottom: '1px solid rgba(140, 190, 210, 0.14)',
    fontSize: 11,
    letterSpacing: '0.28em',
    textTransform: 'uppercase',
    color: accent,
  };

  const badgeStyle: CSSProperties = {
    padding: '3px 10px',
    fontSize: 10,
    letterSpacing: '0.24em',
    textTransform: 'uppercase',
    color: isSubAgent ? '#1a0f00' : '#041218',
    background: accent,
    border: `1px solid ${accent}`,
    fontWeight: 700,
  };

  const body: CSSProperties = {
    padding: '18px 22px 6px 26px',
  };

  const toolName: CSSProperties = {
    fontFamily: '"Orbitron", ui-sans-serif, system-ui, sans-serif',
    fontSize: 18,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    color: ink,
    marginBottom: 6,
    wordBreak: 'break-word',
  };

  const descStyle: CSSProperties = {
    fontSize: 13,
    lineHeight: 1.5,
    color: ink2,
    marginBottom: 14,
  };

  const previewLabel: CSSProperties = {
    fontSize: 10,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    color: 'rgba(140, 190, 210, 0.7)',
    marginBottom: 6,
  };

  const previewStyle: CSSProperties = {
    maxHeight: 180,
    overflow: 'auto',
    padding: '10px 12px',
    margin: 0,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'rgba(210, 235, 245, 0.92)',
    background: 'rgba(0, 0, 0, 0.35)',
    border: '1px solid rgba(140, 190, 210, 0.12)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const footer: CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '14px 22px 18px 26px',
    borderTop: '1px solid rgba(140, 190, 210, 0.14)',
    marginTop: 16,
  };

  const denyBtn: CSSProperties = {
    padding: '8px 18px',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    color: red,
    background: 'transparent',
    border: `1px solid ${red}`,
    cursor: 'pointer',
  };

  const allowBtn: CSSProperties = {
    padding: '8px 18px',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 11,
    letterSpacing: '0.22em',
    textTransform: 'uppercase',
    color: '#041218',
    background: cyan,
    border: `1px solid ${cyan}`,
    boxShadow: `0 0 18px rgba(57, 229, 255, 0.35)`,
    cursor: 'pointer',
    fontWeight: 700,
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`confirm-gate-title-${item.id}`}
      aria-describedby={`confirm-gate-desc-${item.id}`}
      className="cgm-backdrop"
      style={backdrop}
    >
      <style>{`
        @keyframes sunny-confirmgate-pulse {
          0%, 100% {
            box-shadow:
              0 0 0 1px rgba(0,0,0,0.4),
              0 24px 72px rgba(0,0,0,0.65),
              0 0 36px ${accentGlow};
          }
          50% {
            box-shadow:
              0 0 0 1px rgba(0,0,0,0.4),
              0 24px 72px rgba(0,0,0,0.65),
              0 0 64px ${accentGlow};
          }
        }
        @media (prefers-reduced-transparency: reduce) {
          .cgm-backdrop {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            background: rgba(0, 0, 0, 0.82) !important;
          }
        }
      `}</style>
      <div style={card}>
        <div style={leftBar} aria-hidden="true" />
        <div style={header}>
          <span>Confirm &middot; Tool Call</span>
          <span style={badgeStyle} aria-label={`requester ${badge.label}`}>
            {badge.label}
          </span>
        </div>
        <div style={body}>
          <div id={`confirm-gate-title-${item.id}`} style={toolName}>
            {item.name}
          </div>
          <div id={`confirm-gate-desc-${item.id}`} style={descStyle}>
            {description}
          </div>
          <div style={previewLabel}>Preview</div>
          <pre style={previewStyle} aria-label="Tool call preview">
            {preview}
          </pre>
        </div>
        <div style={footer}>
          <button
            type="button"
            style={denyBtn}
            onClick={() => onDeny('user denied')}
          >
            Deny (Esc)
          </button>
          <button
            ref={allowBtnRef}
            type="button"
            style={allowBtn}
            onClick={onAllow}
          >
            Allow (Enter)
          </button>
        </div>
      </div>
    </div>
  );
}
