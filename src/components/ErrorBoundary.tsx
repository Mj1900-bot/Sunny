import { Component } from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';
import { useView } from '../store/view';

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
  componentStack: string | null;
};

const INITIAL_STATE: State = {
  error: null,
  componentStack: null,
};

const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_LINES = 6;

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function firstLines(input: string | null | undefined, count: number): string {
  if (!input) return '';
  return input.split('\n').slice(0, count).join('\n');
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = INITIAL_STATE;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Prefix so terminal users grepping /tmp/sunny.err can filter on it.
    // eslint-disable-next-line no-console
    console.error('[sunny/error-boundary]', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reset = (): void => {
    this.setState(INITIAL_STATE);
  };

  handleReturnToOverview = (): void => {
    try {
      useView.getState().setView('overview');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sunny/error-boundary] failed to switch view', err);
    }
    this.reset();
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const name = error.name || 'Error';
    const message = truncate(error.message || 'Unknown error', MAX_MESSAGE_CHARS);
    const stack = firstLines(error.stack ?? componentStack, MAX_STACK_LINES);

    return (
      <div style={styles.root} role="alert" aria-live="assertive">
        <div style={styles.panel}>
          <div style={styles.header}>MODULE FAULT</div>
          <div style={styles.subheader}>
            {name}
            <span style={styles.sep}> / </span>
            <span style={styles.muted}>render halted</span>
          </div>

          <div style={styles.message}>{message}</div>

          {stack ? <pre style={styles.stack}>{stack}</pre> : null}

          <div style={styles.actions}>
            <button
              type="button"
              style={styles.buttonPrimary}
              onClick={this.handleReturnToOverview}
            >
              RETURN TO OVERVIEW
            </button>
            <button
              type="button"
              style={styles.buttonGhost}
              onClick={this.handleReload}
            >
              RELOAD APP
            </button>
          </div>
        </div>
      </div>
    );
  }
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const DISPLAY = "'Orbitron', sans-serif";

const styles: Record<string, CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(2, 6, 10, 0.92)',
    padding: 24,
    zIndex: 9999,
  },
  panel: {
    width: 'min(640px, 100%)',
    border: '1px solid var(--red)',
    background: 'var(--panel-2, rgba(4, 10, 16, 0.88))',
    boxShadow: '0 0 24px rgba(255, 77, 94, 0.35), inset 0 0 12px rgba(255, 77, 94, 0.08)',
    padding: '20px 22px',
    fontFamily: MONO,
    color: 'var(--ink, #e6f8ff)',
  },
  header: {
    fontFamily: DISPLAY,
    fontSize: 14,
    fontWeight: 800,
    letterSpacing: '0.32em',
    color: 'var(--red)',
    textShadow: '0 0 10px rgba(255, 77, 94, 0.55)',
    marginBottom: 8,
  },
  subheader: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: '0.12em',
    color: 'var(--red)',
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  sep: {
    color: 'var(--ink-dim, #6f9fb2)',
    margin: '0 6px',
  },
  muted: {
    color: 'var(--ink-2, #a9d4e5)',
  },
  message: {
    fontFamily: MONO,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--ink, #e6f8ff)',
    borderLeft: '2px solid var(--red)',
    paddingLeft: 10,
    marginBottom: 14,
    wordBreak: 'break-word',
  },
  stack: {
    fontFamily: MONO,
    fontSize: 11,
    lineHeight: 1.45,
    color: 'var(--ink-2, #a9d4e5)',
    background: 'rgba(255, 77, 94, 0.06)',
    border: '1px solid rgba(255, 77, 94, 0.25)',
    padding: '10px 12px',
    margin: 0,
    marginBottom: 16,
    maxHeight: 180,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
  },
  actions: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
  },
  buttonPrimary: {
    fontFamily: DISPLAY,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.28em',
    color: 'var(--bg, #02060a)',
    background: 'var(--red)',
    border: '1px solid var(--red)',
    padding: '9px 14px',
    cursor: 'pointer',
    textTransform: 'uppercase',
    boxShadow: '0 0 12px rgba(255, 77, 94, 0.5)',
  },
  buttonGhost: {
    fontFamily: DISPLAY,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.28em',
    color: 'var(--red)',
    background: 'transparent',
    border: '1px solid var(--red)',
    padding: '9px 14px',
    cursor: 'pointer',
    textTransform: 'uppercase',
  },
};


// ---------------------------------------------------------------------------
// PageErrorBoundary — lightweight boundary for individual HUD module pages.
// A crash in one page (Voice, Tasks, …) should never kill the whole HUD.
// Renders a compact inline panel so the surrounding chrome stays live.
// ---------------------------------------------------------------------------

type PageBoundaryProps = {
  children: ReactNode;
  /** Human-readable page name shown in the fallback (e.g. "VOICE"). */
  label?: string;
};

type PageBoundaryState = {
  error: Error | null;
};

const PAGE_BOUNDARY_INITIAL: PageBoundaryState = { error: null };

export class PageErrorBoundary extends Component<PageBoundaryProps, PageBoundaryState> {
  state: PageBoundaryState = PAGE_BOUNDARY_INITIAL;

  static getDerivedStateFromError(error: Error): PageBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.label ?? 'page';
    // eslint-disable-next-line no-console
    console.error(`[sunny/page-error-boundary:${label}]`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState(PAGE_BOUNDARY_INITIAL);
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label ?? 'PAGE';
    const message = truncate(error.message || 'Unknown error', MAX_MESSAGE_CHARS);

    return (
      <div style={pageStyles.root} role="alert" aria-live="assertive">
        <div style={pageStyles.header}>{label} · FAULT</div>
        <div style={pageStyles.message}>{message}</div>
        <button type="button" style={pageStyles.btn} onClick={this.reset}>
          RETRY
        </button>
      </div>
    );
  }
}

const pageStyles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
    border: '1px solid var(--red)',
    background: 'rgba(255, 77, 94, 0.06)',
    color: 'var(--red)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 11,
    letterSpacing: '0.12em',
    minHeight: 120,
  },
  header: {
    fontFamily: "'Orbitron', sans-serif",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.28em',
    textTransform: 'uppercase' as const,
  },
  message: {
    color: 'var(--ink-2, #a9d4e5)',
    maxWidth: 400,
    textAlign: 'center' as const,
    lineHeight: 1.4,
  },
  btn: {
    fontFamily: "'Orbitron', sans-serif",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.22em',
    color: 'var(--red)',
    background: 'transparent',
    border: '1px solid var(--red)',
    padding: '6px 12px',
    cursor: 'pointer',
  },
};
