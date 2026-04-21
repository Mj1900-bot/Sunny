/**
 * AppsPanel — replaces the former CLIPBOARD slot. Quick-launch tile grid
 * for the user's most-used external apps (Antigravity, Cursor, Claude,
 * Terminal, Spotify, ChatGPT Atlas). Derives "running" state from the
 * live process list provided by `useMetrics` so we don't need a separate
 * poll — each tile shows a green dot + live CPU% when its app is running.
 *
 * Click = launch (or focus, since macOS `open -a` focuses a running app).
 * Right-click = quit (sends SIGTERM via `killall`).
 */

import { useCallback, useMemo, type ReactElement } from 'react';
import { Panel } from './Panel';
import type { ProcessRow } from '../hooks/useMetrics';
import { invokeSafe, isTauri } from '../lib/tauri';
import { toast } from '../hooks/useToast';

type AppDef = {
  readonly id: string;
  /** Display name — also used verbatim for the initials monogram. */
  readonly label: string;
  /** The name passed to macOS `open -a` (matches the .app bundle name). */
  readonly launchName: string;
  /** Substrings to match against process names — case-insensitive, any-match. */
  readonly procMatchers: ReadonlyArray<string>;
  /** Accent color for the monogram tile. */
  readonly color: string;
  /** Optional arg — pass `killall <procName>` target. Defaults to launchName. */
  readonly killName?: string;
};

const APPS: ReadonlyArray<AppDef> = [
  {
    id: 'antigravity',
    label: 'Antigravity',
    launchName: 'Antigravity',
    procMatchers: ['antigravity'],
    color: 'var(--violet, #b48cff)',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    launchName: 'Cursor',
    procMatchers: ['cursor'],
    color: '#39e5ff',
  },
  {
    id: 'claude',
    label: 'Claude',
    launchName: 'Claude',
    procMatchers: ['claude'],
    color: '#ffb347',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    launchName: 'Terminal',
    procMatchers: ['terminal'],
    color: '#7dff9a',
  },
  {
    id: 'spotify',
    label: 'Spotify',
    launchName: 'Spotify',
    procMatchers: ['spotify'],
    color: '#1ed760',
  },
  {
    id: 'atlas',
    label: 'Atlas',
    launchName: 'ChatGPT Atlas',
    procMatchers: ['atlas', 'chatgpt atlas'],
    color: '#ff5ec8',
  },
];

type Props = { readonly procs: ReadonlyArray<ProcessRow> };

type AppStatus = {
  readonly running: boolean;
  readonly cpu: number;
  readonly memMb: number;
};

function monogram(label: string): string {
  // Smart abbreviation: "ChatGPT Atlas" → "CA", "Spotify" → "S".
  // Avoids stretching long labels and stays pleasant inside the 44×44 tile.
  const trimmed = label.trim();
  if (trimmed.length === 0) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed[0].toUpperCase();
}

function matchStatus(app: AppDef, procs: ReadonlyArray<ProcessRow>): AppStatus {
  let cpu = 0;
  let memMb = 0;
  let running = false;
  for (const p of procs) {
    const lc = p.name.toLowerCase();
    for (const m of app.procMatchers) {
      if (lc.includes(m)) {
        running = true;
        cpu += p.cpu;
        memMb += p.mem_mb;
        break;
      }
    }
  }
  return { running, cpu, memMb };
}

async function launch(app: AppDef): Promise<void> {
  if (!isTauri) {
    toast.info(`Would launch ${app.label}`);
    return;
  }
  try {
    await invokeSafe<void>('open_app', { name: app.launchName });
    toast.success(`Opening ${app.label}`);
  } catch {
    toast.error(`Could not open ${app.label}`);
  }
}

async function quit(app: AppDef): Promise<void> {
  if (!isTauri) { toast.info(`Would quit ${app.label}`); return; }
  const target = app.killName ?? app.launchName;
  const res = await invokeSafe<{ stdout: string; stderr: string; code: number }>('run_shell', {
    cmd: `osascript -e 'tell application "${target}" to quit' 2>&1 | head -1`,
  });
  if (res) {
    toast.success(`Quit ${app.label}`);
  }
}

function fmtMem(mb: number): string {
  if (mb <= 0) return '';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

export function AppsPanel({ procs }: Props): ReactElement {
  const statuses = useMemo<ReadonlyArray<[AppDef, AppStatus]>>(
    () => APPS.map(a => [a, matchStatus(a, procs)]),
    [procs],
  );

  const runningCount = statuses.reduce((n, [, s]) => n + (s.running ? 1 : 0), 0);
  const totalCpu = statuses.reduce((n, [, s]) => n + (s.running ? s.cpu : 0), 0);

  const onTileClick = useCallback((app: AppDef) => { void launch(app); }, []);
  const onTileContext = useCallback((e: React.MouseEvent, app: AppDef) => {
    e.preventDefault();
    void quit(app);
  }, []);

  return (
    <Panel
      id="p-clip"
      title="APPS"
      right={
        <span style={{ color: runningCount > 0 ? 'var(--cyan)' : 'var(--ink-dim)' }}>
          {runningCount}/{APPS.length} OPEN
          {runningCount > 0 && (
            <span style={{ color: 'var(--ink-dim)', marginLeft: 6 }}>
              {Math.round(totalCpu)}%
            </span>
          )}
        </span>
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {statuses.map(([app, s]) => (
          <AppRow
            key={app.id}
            app={app}
            status={s}
            onClick={() => onTileClick(app)}
            onContextMenu={e => onTileContext(e, app)}
          />
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Row — full-width single-line item
// ---------------------------------------------------------------------------

function AppRow({
  app, status, onClick, onContextMenu,
}: {
  readonly app: AppDef;
  readonly status: AppStatus;
  readonly onClick: () => void;
  readonly onContextMenu: (e: React.MouseEvent) => void;
}): ReactElement {
  const { running, cpu, memMb } = status;

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={`${app.label} — click to ${running ? 'focus' : 'open'}, right-click to quit`}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        border: '1px solid var(--line-soft)',
        borderLeft: `2px solid ${running ? app.color : 'var(--line-soft)'}`,
        background: running ? 'rgba(57,229,255,0.05)' : 'rgba(57,229,255,0.02)',
        transition: 'background 0.15s ease, box-shadow 0.15s ease',
        minWidth: 0,
        flexShrink: 0,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = running
          ? 'rgba(57,229,255,0.10)'
          : 'rgba(57,229,255,0.05)';
        e.currentTarget.style.boxShadow = `0 0 10px rgba(57,229,255,0.15)`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = running
          ? 'rgba(57,229,255,0.05)'
          : 'rgba(57,229,255,0.02)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Monogram icon */}
      <div
        aria-hidden
        style={{
          width: 26, height: 26,
          borderRadius: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `linear-gradient(135deg, ${app.color}33, ${app.color}10)`,
          border: `1px solid ${app.color}55`,
          color: app.color,
          fontFamily: 'var(--display)',
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: '0.04em',
          boxShadow: running ? `0 0 6px ${app.color}44` : 'none',
          flexShrink: 0,
        }}
      >
        {monogram(app.label)}
      </div>

      {/* Label — takes remaining space */}
      <div
        style={{
          fontFamily: 'var(--display)',
          fontSize: 11,
          letterSpacing: '0.14em',
          color: running ? 'var(--ink)' : 'var(--ink-2)',
          fontWeight: 700,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: '1 1 auto',
          minWidth: 0,
        }}
      >
        {app.label}
      </div>

      {/* Status dot + CPU% + MEM */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.04em',
          color: 'var(--ink-dim)',
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: running ? 'var(--green)' : 'var(--ink-dim)',
            boxShadow: running ? '0 0 5px var(--green)' : 'none',
            flexShrink: 0,
          }}
        />
        {running ? (
          <>
            <b style={{ color: 'var(--cyan)', fontWeight: 700 }}>{Math.round(cpu)}%</b>
            {memMb > 0 && (
              <span style={{ color: 'var(--ink-dim)' }}>{fmtMem(memMb)}</span>
            )}
          </>
        ) : (
          <span>offline</span>
        )}
      </div>
    </button>
  );
}
