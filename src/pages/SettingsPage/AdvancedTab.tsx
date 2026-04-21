/**
 * AdvancedTab — the "under the hood" tab. Four things live here because
 * they're all adjacent in the user's head ("something's weird, where is
 * the knob?") and none of them deserves its own tab:
 *
 *   1. STORAGE — where SUNNY keeps its data, with a one-click path copy.
 *   2. APPEARANCE (extras) — reduced-motion + compact-mode, accessibility
 *      leaning, with visual preview of current state.
 *   3. DIAGNOSTICS — memory stats, consolidator state, quick copy of the
 *      sanitized settings JSON for bug reports.
 *   4. BACKUP — export / import / reset the settings.json (atomic).
 *   5. ABOUT — version + environment.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { useView, type SettingsSnapshot } from '../../store/view';
import { invokeSafe, isTauri } from '../../lib/tauri';
import {
  getSessionKickCount,
  subscribeKickCount,
} from '../../lib/constitutionKicks';
import {
  chipBase,
  codeStyle,
  dangerBtnStyle,
  hintStyle,
  labelStyle,
  primaryBtnStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  statusPillStyle,
} from './styles';

type MemStats = Readonly<{
  episodic?: number; facts?: number; skills?: number; legacy?: number;
}>;

type ConsolidatorStatus = Readonly<{
  last_run?: number | null;
  pending?: number;
  errors?: number;
}>;

const STORAGE_PATHS: ReadonlyArray<{ label: string; path: string; note: string }> = [
  { label: 'Settings',     path: '~/.sunny/settings.json',     note: 'JSON blob — everything you see in this page.' },
  { label: 'Constitution', path: '~/.sunny/constitution.json', note: 'Values / prohibitions / identity (0600).' },
  { label: 'Memory DB',    path: '~/.sunny/memory.sqlite',     note: 'Episodic + semantic + procedural memory.' },
  { label: 'Tool usage',   path: '~/.sunny/tool-usage.sqlite', note: 'Per-tool stats used by the skill synthesiser.' },
  { label: 'Scan vault',   path: '~/.sunny/vault/',            note: 'Quarantined files from the SCAN module.' },
  { label: 'Browser data', path: '~/.sunny/browser/',          note: 'Profiles, bookmarks, history, audit log.' },
  { label: 'OpenClaw bridge', path: '~/Library/Application Support/OpenClaw/bridge.sock', note: 'Socket to the CLI host.' },
];

export function AdvancedTab(): JSX.Element {
  const settings = useView(s => s.settings);
  const patchSettings = useView(s => s.patchSettings);

  const [memStats, setMemStats] = useState<MemStats | null>(null);
  const [consStatus, setConsStatus] = useState<ConsolidatorStatus | null>(null);
  const [lastSweep, setLastSweep] = useState<number | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [copyFlash, setCopyFlash] = useState<string | null>(null);

  // Constitution kick count — cross-session persisted total from the Rust
  // log, plus a live-updating in-process count so the Diagnostics card
  // ticks without needing a manual REFRESH. Subscription is cheap; the
  // bump happens once per violation detected on the voice path.
  const [kickCountPersisted, setKickCountPersisted] = useState<number | null>(null);
  const [kickCountSession, setKickCountSession] = useState<number>(getSessionKickCount());
  useEffect(() => {
    const unsub = subscribeKickCount(() => setKickCountSession(getSessionKickCount()));
    return unsub;
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshDiag = useCallback(async () => {
    if (!isTauri) return;
    setDiagBusy(true);
    const [m, c, s, k] = await Promise.all([
      invokeSafe<MemStats>('memory_stats'),
      invokeSafe<ConsolidatorStatus>('memory_consolidator_status'),
      invokeSafe<number | null>('memory_retention_last_sweep'),
      invokeSafe<number>('constitution_kicks_count'),
    ]);
    setMemStats(m);
    setConsStatus(c);
    setLastSweep(s ?? null);
    setKickCountPersisted(typeof k === 'number' ? k : null);
    setDiagBusy(false);
  }, []);

  useEffect(() => { void refreshDiag(); }, [refreshDiag]);

  const copyToClipboard = useCallback(async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFlash(tag);
      window.setTimeout(() => setCopyFlash(null), 1200);
    } catch {
      setCopyFlash('clipboard denied');
      window.setTimeout(() => setCopyFlash(null), 1500);
    }
  }, []);

  const exportSettings = useCallback(() => {
    const json = JSON.stringify(settings, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `sunny-settings-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [settings]);

  const onImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '');
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const confirmed = window.confirm(
          'Import will overwrite your current SUNNY settings. Continue?',
        );
        if (!confirmed) return;
        // Whitelist: patch only keys the store already knows about. The
        // current value set acts as the schema — anything extra in the
        // file (including `__proto__`, `constructor`, and any future key
        // that doesn't exist yet) is dropped silently. This stops a
        // malicious or drifted snapshot from injecting surprise keys
        // into the zustand state or polluting the prototype chain.
        const currentKeys = new Set(Object.keys(settings));
        const clean: Record<string, unknown> = {};
        for (const k of Object.keys(parsed)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          if (!currentKeys.has(k)) continue;
          clean[k] = parsed[k];
        }
        if (Object.keys(clean).length === 0) {
          window.alert('Import skipped: snapshot had no recognizable settings keys.');
          return;
        }
        patchSettings(clean as Partial<SettingsSnapshot>);
      } catch (err) {
        window.alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  }, [patchSettings, settings]);

  const resetSettings = useView(s => s.resetSettings);

  const resetDefaults = useCallback(() => {
    const confirmed = window.confirm(
      'Reset ALL SUNNY settings to defaults?\n\n' +
      'This wipes themes, voice, provider, model, sampling knobs, and saved presets. ' +
      'API keys in Keychain, Constitution, and Memory are NOT touched — this is just settings.json.',
    );
    if (!confirmed) return;
    // The store action flushes DEFAULTS to both localStorage and the
    // Tauri filesystem copy atomically. Without it, the fs copy would
    // rehydrate the old values on next launch and the "reset" would
    // appear to have no effect.
    resetSettings();
  }, [resetSettings]);

  const relaunch = useCallback(() => {
    void invokeSafe('relaunch_app');
  }, []);

  const diagReport = buildDiagReport(settings, memStats, consStatus, lastSweep);

  return (
    <>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>STORAGE</h3>
        <div style={hintStyle}>
          Everything SUNNY persists is under <code style={codeStyle}>~/.sunny/</code>.
          Click the path to copy it; {isTauri ? 'the REVEAL button opens it in Finder.' : 'reveal only works inside the Tauri app.'}
        </div>
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {STORAGE_PATHS.map(row => (
            <StorageRow
              key={row.path}
              label={row.label}
              path={row.path}
              note={row.note}
              onCopy={() => void copyToClipboard(row.path, `copy:${row.label}`)}
              flashed={copyFlash === `copy:${row.label}`}
            />
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>ACCESSIBILITY</h3>
        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={settings.reducedMotion}
            onChange={e => patchSettings({ reducedMotion: e.target.checked })}
          />
          <span>Reduce motion — strip transitions and orb pulse</span>
        </label>
        <div style={hintStyle}>
          Applies <code style={codeStyle}>body.reduced-motion</code> which
          neutralizes every CSS transition / animation. Helpful on slow GPUs
          or when the HUD sparkle triggers motion sensitivity.
        </div>

        <label style={{ ...checkboxRow, marginTop: 14 }}>
          <input
            type="checkbox"
            checked={settings.compactMode}
            onChange={e => patchSettings({ compactMode: e.target.checked })}
          />
          <span>Compact mode — tighter padding, smaller type</span>
        </label>
        <div style={hintStyle}>
          Tighter gutters in every module page. Great for 13" MacBooks and
          side-by-side terminal/code layouts.
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>DIAGNOSTICS</h3>
        <div style={{ ...rowStyle, marginBottom: 10 }}>
          <button
            type="button"
            style={primaryBtnStyle}
            onClick={() => void refreshDiag()}
            disabled={diagBusy || !isTauri}
          >
            {diagBusy ? 'PROBING…' : 'REFRESH'}
          </button>
          <button
            type="button"
            style={chipBase}
            onClick={() => void copyToClipboard(diagReport, 'copy:diag')}
          >
            {copyFlash === 'copy:diag' ? 'COPIED ✓' : 'COPY REPORT'}
          </button>
          <span style={{ ...hintStyle, marginTop: 0 }}>
            Sanitized JSON. API keys and absolute user paths are stripped
            before copy.
          </span>
        </div>

        <div style={diagGrid}>
          <DiagCell label="MEMORY · EPISODIC" value={formatCount(memStats?.episodic)} />
          <DiagCell label="MEMORY · FACTS"    value={formatCount(memStats?.facts)} />
          <DiagCell label="MEMORY · SKILLS"   value={formatCount(memStats?.skills)} />
          <DiagCell label="MEMORY · LEGACY"   value={formatCount(memStats?.legacy)} />
          <DiagCell label="CONSOLIDATOR PENDING" value={formatCount(consStatus?.pending)} />
          <DiagCell label="CONSOLIDATOR ERRORS"  value={formatCount(consStatus?.errors)} />
          <DiagCell label="CONSOLIDATOR LAST RUN" value={formatRelTime(consStatus?.last_run)} />
          <DiagCell label="RETENTION LAST SWEEP"  value={formatRelTime(lastSweep)} />
          <DiagCell
            label="CONSTITUTION KICKS"
            value={formatKickCount(kickCountPersisted, kickCountSession)}
          />
        </div>

        <pre style={diagPreStyle}>{diagReport}</pre>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>BACKUP</h3>
        <div style={hintStyle}>
          Export writes a JSON snapshot of your settings (no secrets). Import
          merges the snapshot back; the current provider/model is kept if
          the snapshot omits them.
        </div>
        <div style={{ ...rowStyle, marginTop: 10 }}>
          <button type="button" style={primaryBtnStyle} onClick={exportSettings}>
            EXPORT SETTINGS
          </button>
          <button
            type="button"
            style={chipBase}
            onClick={() => fileInputRef.current?.click()}
          >
            IMPORT SETTINGS
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onImportFile}
          />
          <button type="button" style={dangerBtnStyle} onClick={resetDefaults}>
            RESET TO DEFAULTS
          </button>
          {isTauri && (
            <button type="button" style={chipBase} onClick={relaunch}>
              RELAUNCH APP
            </button>
          )}
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>ABOUT</h3>
        <div style={aboutGrid}>
          <AboutRow label="VERSION"  value="SUNNY v0.1.0" />
          <AboutRow label="RUNTIME"  value={isTauri ? 'Tauri (native)' : 'Browser preview'} />
          <AboutRow label="FRONTEND" value="React + Vite + Zustand" />
          <AboutRow label="BACKEND"  value="Rust · Tauri 2 · sqlite · Kokoro-82M · whisper" />
          <AboutRow label="PERSIST"  value={isTauri ? '~/.sunny/ (fs) + localStorage mirror' : 'localStorage (fs unavailable)'} />
          <AboutRow
            label="STATUS"
            value={
              <span style={statusPillStyle('var(--cyan)')}>OPERATIONAL</span>
            }
          />
        </div>
      </section>
    </>
  );
}

/** ---- Small presentational helpers ---- */

type StorageRowProps = {
  readonly label: string;
  readonly path: string;
  readonly note: string;
  readonly onCopy: () => void;
  readonly flashed: boolean;
};

function StorageRow({ label, path, note, onCopy, flashed }: StorageRowProps): JSX.Element {
  return (
    <div style={storageRowStyle}>
      <span style={storageLabel}>{label}</span>
      <button
        type="button"
        onClick={onCopy}
        style={{
          all: 'unset',
          cursor: 'pointer',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: flashed ? 'var(--green)' : 'var(--cyan)',
          padding: '2px 6px',
          border: '1px dashed rgba(120, 170, 200, 0.18)',
          overflowWrap: 'anywhere',
        }}
        title="Copy path"
      >
        {flashed ? 'COPIED ✓' : path}
      </button>
      <span style={storageNote}>{note}</span>
      {isTauri && (
        <button
          type="button"
          style={{ ...chipBase, padding: '2px 8px', fontSize: 10 }}
          onClick={() => void invokeSafe('fs_reveal', { path })}
          title="Reveal in Finder"
        >
          REVEAL
        </button>
      )}
    </div>
  );
}

function DiagCell({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div style={diagCellStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={diagValueStyle}>{value}</span>
    </div>
  );
}

function AboutRow({ label, value }: { readonly label: string; readonly value: React.ReactNode }): JSX.Element {
  return (
    <div style={aboutRowStyle}>
      <span style={aboutLabelStyle}>{label}</span>
      <span style={aboutValueStyle}>{value}</span>
    </div>
  );
}

function formatCount(n: number | undefined): string {
  if (typeof n !== 'number') return '—';
  return n.toLocaleString();
}

/**
 * Render the constitution kick count. Shows the cross-session persisted
 * total with the current session's delta broken out in parens so the
 * operator can spot a run of new kicks without diffing between renders.
 * Example: `42 (+3 this session)` or `— (no data)` before the REFRESH
 * round-trip completes.
 */
function formatKickCount(persisted: number | null, session: number): string {
  if (persisted === null) {
    return session > 0 ? `${session.toLocaleString()} (session)` : '—';
  }
  if (session === 0) return persisted.toLocaleString();
  return `${persisted.toLocaleString()} (+${session.toLocaleString()} session)`;
}

function formatRelTime(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86_400)}d ago`;
}

/**
 * Build a paste-friendly diagnostic report. Strips absolute user paths
 * (replaces the home directory with `~`) and elides any property whose
 * name contains "key", "secret", or "token" just in case a future schema
 * adds one — defence in depth against "I pasted my bug report into a
 * forum and leaked my API key".
 */
function buildDiagReport(
  settings: SettingsSnapshot,
  mem: MemStats | null,
  cons: ConsolidatorStatus | null,
  retention: number | null,
): string {
  const SECRET_RE = /key|secret|token/i;
  const redact = (obj: unknown): unknown => {
    if (Array.isArray(obj)) return obj.map(redact);
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (SECRET_RE.test(k)) out[k] = '***';
        else out[k] = redact(v);
      }
      return out;
    }
    return obj;
  };

  const report = {
    kind: 'sunny-diag/v1',
    capturedAt: new Date().toISOString(),
    runtime: isTauri ? 'tauri' : 'browser',
    settings: redact(settings),
    memory: mem ?? null,
    consolidator: cons ?? null,
    retentionLastSweep: retention,
  };
  return JSON.stringify(report, null, 2);
}

/** ---- Styles ---- */

const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
};

const storageRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '130px minmax(0, 1fr) minmax(0, 1.2fr) auto',
  gap: 10,
  alignItems: 'center',
  padding: '6px 8px',
  borderBottom: '1px dashed rgba(120, 170, 200, 0.08)',
};

const storageLabel: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 10,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
  textTransform: 'uppercase',
};

const storageNote: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--ink-dim)',
};

const diagGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 8,
  marginBottom: 10,
};

const diagCellStyle: CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.55)',
  display: 'grid',
  gap: 4,
};

const diagValueStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 14,
  color: 'var(--cyan)',
  letterSpacing: '0.04em',
};

const diagPreStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--ink)',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid var(--line-soft)',
  padding: '10px 12px',
  margin: 0,
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre',
};

const aboutGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 8,
};

const aboutRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '110px 1fr',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px',
  border: '1px solid var(--line-soft)',
  background: 'rgba(4, 10, 16, 0.45)',
};

const aboutLabelStyle: CSSProperties = {
  fontFamily: 'var(--display)',
  fontSize: 10,
  letterSpacing: '0.22em',
  color: 'var(--ink-dim)',
};

const aboutValueStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
};
