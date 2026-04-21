/**
 * TranscriptView — sprint-13 θ scrollable companion to the Orb's fleeting
 * `orb-tx` line. Lives inside `<ChatPanel />` as a collapsible section.
 *
 * The orb only shows the last fragment SUNNY spoke; screen-reader users
 * and anyone who glanced away for a second have no way to recover what
 * was said. This view surfaces every voice + chat turn with timestamp,
 * speaker tag, and click-to-copy, while broadcasting the latest SUNNY
 * reply to an `aria-live="polite"` region so assistive tech announces
 * new answers without the user needing to focus the log.
 *
 * We consume `useTranscript` as the single source of truth — warm replay
 * from `memory::conversation::tail` plus a live merge of the parent's
 * in-flight messages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranscript } from '../hooks/useTranscript';
import type {
  LiveMessage,
  TranscriptRole,
  TranscriptRow,
} from '../hooks/useTranscript';

// ---------------------------------------------------------------------------
// Labels + palette
// ---------------------------------------------------------------------------

const SPEAKER_LABEL: Record<TranscriptRole, string> = {
  user: 'YOU',
  sunny: 'SUNNY',
  system: 'SYS',
};

const SPEAKER_COLOR: Record<TranscriptRole, string> = {
  user: 'var(--amber)',
  sunny: 'var(--cyan)',
  system: 'var(--red)',
};

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

const HMS_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatHms(at: number): string {
  try {
    return HMS_FORMATTER.format(new Date(at));
  } catch {
    return '--:--:--';
  }
}

// ---------------------------------------------------------------------------
// Motion preference
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the user has the OS-level "reduce motion" preference
 * on. We honour it by skipping the auto-scroll-to-latest — some users want
 * manual control over where the log sits, especially screen-reader users
 * who scrub back and forth through the history.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    // addEventListener is the modern API; older Safari still ships `addListener`.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Copy text to the clipboard, preferring the async Clipboard API and
 * falling back to a transient `<textarea>` + `execCommand('copy')` when
 * it's unavailable (older Tauri webviews without the permission granted).
 * Returns true on success so callers can flash a "COPIED" badge.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.error('TranscriptView: clipboard.writeText failed', error);
  }
  // Fallback — create a throwaway textarea, select, execCommand.
  try {
    if (typeof document === 'undefined') return false;
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '-1000px';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch (error) {
    console.error('TranscriptView: clipboard fallback failed', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TranscriptViewProps {
  readonly sessionId: string;
  readonly liveMessages: readonly LiveMessage[];
  /** Initial collapsed/expanded state. Defaults to collapsed so the
   *  section doesn't dominate the ChatPanel on first paint. */
  readonly defaultOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TranscriptView({
  sessionId,
  liveMessages,
  defaultOpen = false,
}: TranscriptViewProps) {
  const { rows, latestSunnyText, rowCount } = useTranscript(
    sessionId,
    liveMessages,
  );
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  // Auto-scroll to the latest row when new content lands — unless the user
  // has prefers-reduced-motion set, in which case we leave scroll position
  // alone so manual scrubbing works.
  useEffect(() => {
    if (reducedMotion) return;
    const el = logRef.current;
    if (!el) return;
    if (!open) return;
    el.scrollTop = el.scrollHeight;
  }, [rows, open, reducedMotion]);

  // Clear the "COPIED" ephemeral badge after 1.5 s.
  useEffect(() => {
    if (!copiedKey) return;
    const t = setTimeout(() => setCopiedKey(null), 1500);
    return () => clearTimeout(t);
  }, [copiedKey]);

  const handleCopy = useCallback(async (row: TranscriptRow) => {
    const ok = await copyToClipboard(row.text);
    if (ok) setCopiedKey(row.key);
  }, []);

  const toggle = useCallback(() => setOpen(prev => !prev), []);

  // The last SUNNY row's React key — used so the aria-live region receives a
  // brand-new DOM node per answer, which is what assistive tech needs to
  // emit a fresh announcement.
  const latestSunnyKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].role === 'sunny') return rows[i].key;
    }
    return null;
  }, [rows]);

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    borderBottom: '1px solid var(--line-soft)',
    paddingBottom: 6,
    marginBottom: 2,
  };

  const headerStyle: CSSProperties = {
    all: 'unset',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '4px 6px',
    fontFamily: 'var(--display)',
    fontSize: 9,
    letterSpacing: '0.22em',
    color: 'var(--ink-2)',
    borderLeft: '2px solid var(--cyan)',
    background: 'rgba(57, 229, 255, 0.03)',
  };

  const logStyle: CSSProperties = {
    maxHeight: 180,
    overflowY: 'auto',
    display: open ? 'flex' : 'none',
    flexDirection: 'column',
    gap: 2,
    paddingRight: 2,
    marginTop: 4,
  };

  return (
    <section
      className="transcript-section"
      aria-label="Transcript"
      style={containerStyle}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="transcript-log"
        style={headerStyle}
      >
        <span>TRANSCRIPT · {rowCount}</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {/* Screen-reader announcer for the latest SUNNY line. Always rendered
          (even when the log is collapsed) so VoiceOver / NVDA announce every
          new answer without the user needing to expand or focus the log. */}
      <p
        className="transcript-announcer"
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'absolute',
          left: -9999,
          top: 'auto',
          width: 1,
          height: 1,
          overflow: 'hidden',
        }}
        // key forces a node replacement each time a new answer arrives — a
        // bare text diff isn't reliably re-announced by all screen readers.
        key={latestSunnyKey ?? 'empty'}
      >
        {latestSunnyText}
      </p>

      <div
        id="transcript-log"
        ref={logRef}
        role="log"
        aria-live="off"
        aria-label="Conversation transcript"
        aria-relevant="additions"
        tabIndex={0}
        style={logStyle}
      >
        {rows.length === 0 ? (
          <div
            style={{
              color: 'var(--ink-dim)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              padding: '4px 6px',
            }}
          >
            Transcript is empty.
          </div>
        ) : (
          rows.map(row => (
            <TranscriptRowItem
              key={row.key}
              row={row}
              onCopy={handleCopy}
              copied={copiedKey === row.key}
            />
          ))
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  readonly row: TranscriptRow;
  readonly onCopy: (row: TranscriptRow) => void;
  readonly copied: boolean;
}

function TranscriptRowItem({ row, onCopy, copied }: RowProps) {
  const speaker = SPEAKER_LABEL[row.role];
  const color = SPEAKER_COLOR[row.role];
  const time = formatHms(row.at);

  const handleClick = useCallback(() => onCopy(row), [onCopy, row]);
  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      // Space + Enter already fire click on buttons, so we only need to
      // intercept for any future non-button host (defence in depth).
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onCopy(row);
      }
    },
    [onCopy, row],
  );

  return (
    <button
      type="button"
      className="transcript-row"
      onClick={handleClick}
      onKeyDown={handleKey}
      title="Click to copy"
      aria-label={`${speaker} at ${time}: ${row.text}. Press to copy.`}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'grid',
        gridTemplateColumns: '64px 40px 1fr auto',
        alignItems: 'baseline',
        gap: 6,
        padding: '2px 6px',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        lineHeight: 1.4,
        color: 'var(--ink)',
        borderLeft: `2px solid ${color}`,
      }}
    >
      <span style={{ color: 'var(--ink-dim)' }}>{time}</span>
      <span style={{ color, letterSpacing: '0.08em', fontWeight: 600 }}>
        {speaker}
      </span>
      <span
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--ink)',
        }}
      >
        {row.text}
      </span>
      <span
        aria-hidden="true"
        style={{
          fontFamily: 'var(--display)',
          fontSize: 8,
          letterSpacing: '0.18em',
          color: copied ? 'var(--cyan)' : 'transparent',
          transition: 'color 180ms ease-out',
          minWidth: 48,
          textAlign: 'right',
        }}
      >
        {copied ? 'COPIED' : 'COPY'}
      </span>
    </button>
  );
}
