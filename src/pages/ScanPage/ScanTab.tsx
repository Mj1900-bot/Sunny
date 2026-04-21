import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from 'react';
import { isTauri } from '../../lib/tauri';
import {
  scanAbort,
  scanFindings,
  scanPickFolder,
  scanRunningExecutables,
  scanSignatureCatalog,
  scanStart,
  scanStartMany,
  scanStartRoots,
  scanStatus,
} from './api';
import type {
  Finding,
  ScanOptions,
  ScanProgress,
  SignatureCatalog,
} from './types';
import {
  chipActiveStyle,
  chipBaseStyle,
  dangerBtnStyle,
  emptyStateStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  mutedBtnStyle,
  primaryBtnStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles';
import { SMART_PRESETS, agentConfigRoots, pathPresets, type Preset } from './components/ScanTab/presets';
import { Toggle } from './components/ScanTab/Toggle';
import { ProbePanel } from './components/ScanTab/ProbePanel';
import { ThreatDatabasePanel } from './components/ScanTab/ThreatDatabasePanel';
import { ProgressView, isRunning } from './components/ScanTab/ProgressView';

// Poll the scan status twice per second — fast enough to feel live, slow
// enough that a cheap in-proc mutex lock never becomes a bottleneck.
const POLL_MS = 500;

type Props = {
  readonly onScanStarted: (scanId: string) => void;
  readonly activeScanId: string | null;
  readonly onJumpToFindings?: () => void;
};

export function ScanTab({ onScanStarted, activeScanId, onJumpToFindings }: Props) {
  // Best-effort home resolution from either localStorage (user may have set
  // their name once) or a hardcoded fallback. Rust is the source of truth for
  // final path resolution, so this is only a UI nicety.
  const home = useMemo(() => {
    if (typeof window === 'undefined') return '/Users/sunny';
    const saved = window.localStorage?.getItem('sunny.user');
    return '/Users/' + (saved ?? 'sunny');
  }, []);

  const [target, setTarget] = useState<string>(() => `${home}/Downloads`);
  const [options, setOptions] = useState<ScanOptions>({
    recursive: true,
    maxFileSize: 100 * 1024 * 1024,
    onlineLookup: true,
    virustotal: false,
    deep: false,
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [findings, setFindings] = useState<ReadonlyArray<Finding>>([]);
  const [dragOver, setDragOver] = useState(false);
  const [catalog, setCatalog] = useState<SignatureCatalog | null>(null);

  // Fetch the curated threat database once on mount. This is static data
  // on the Rust side, so a single fetch suffices for the session.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const cat = await scanSignatureCatalog();
      if (alive) setCatalog(cat);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Poll the active scan — status for counters, findings for the flagged
  // breakdown below the HUD. We poll findings every 2nd tick so we don't
  // saturate IPC when the list grows large (cheap Rust side, but still).
  useEffect(() => {
    if (!activeScanId) {
      setProgress(null);
      setFindings([]);
      return;
    }
    let alive = true;
    let beat = 0;
    const tick = async () => {
      const next = await scanStatus(activeScanId);
      if (!alive) return;
      setProgress(next);
      if (beat % 2 === 0) {
        const f = await scanFindings(activeScanId);
        if (alive && f) setFindings(f);
      }
      beat += 1;
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [activeScanId]);

  const patch = useCallback(
    <K extends keyof ScanOptions>(key: K, value: ScanOptions[K]) => {
      setOptions(prev => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleStart = useCallback(async () => {
    const trimmed = target.trim();
    if (trimmed.length === 0) {
      setStartError('Pick a target first.');
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const id = await scanStart(trimmed, options);
      onScanStarted(id);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [target, options, onScanStarted]);

  const handlePresetClick = useCallback(
    async (preset: Preset) => {
      if (preset.kind === 'path' && preset.path) {
        setTarget(preset.path);
        return;
      }
      if (preset.kind === 'running') {
        setStarting(true);
        setStartError(null);
        try {
          const paths = await scanRunningExecutables();
          if (paths.length === 0) {
            setStartError('No running executables resolved — need Full Disk Access?');
            return;
          }
          const id = await scanStartMany('RUNNING PROCESSES', paths, options);
          onScanStarted(id);
        } catch (err) {
          setStartError(err instanceof Error ? err.message : String(err));
        } finally {
          setStarting(false);
        }
        return;
      }
      if (preset.kind === 'agent-configs') {
        setStarting(true);
        setStartError(null);
        try {
          const roots = agentConfigRoots(home);
          const id = await scanStartRoots('AGENT CONFIGS', roots, {
            ...options,
            recursive: true,
            deep: true,
          });
          onScanStarted(id);
        } catch (err) {
          setStartError(err instanceof Error ? err.message : String(err));
        } finally {
          setStarting(false);
        }
        return;
      }
      if (preset.kind === 'prompt-injection-sweep') {
        setStarting(true);
        setStartError(null);
        try {
          const trimmed = target.trim();
          if (!trimmed) {
            setStartError('Pick a target path first — the sweep runs against it.');
            return;
          }
          // Deep mode reads every file's content preview, which is how
          // the content regex set gets a chance to fire on .md/.txt/.json
          // prompts even when no other signal fired first.
          const id = await scanStart(trimmed, { ...options, recursive: true, deep: true });
          onScanStarted(id);
        } catch (err) {
          setStartError(err instanceof Error ? err.message : String(err));
        } finally {
          setStarting(false);
        }
        return;
      }
    },
    [options, onScanStarted, target, home],
  );

  const handlePickFolder = useCallback(async () => {
    try {
      const chosen = await scanPickFolder('Select a folder to scan for threats');
      if (chosen) setTarget(chosen);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleAbort = useCallback(async () => {
    if (!activeScanId) return;
    try {
      await scanAbort(activeScanId);
    } catch (err) {
      console.error('abort failed', err);
    }
  }, [activeScanId]);

  // Drag-and-drop — we only care about the first dropped item.
  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const onDragLeave = useCallback(() => setDragOver(false), []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const first = e.dataTransfer.files[0];
      if (!first) return;
      // In a Tauri webview, File objects expose the absolute path via `.path`
      // (not standard DOM, but present). Fall back to the name (user will
      // notice immediately).
      type TauriFile = File & { path?: string };
      const tf = first as TauriFile;
      const path = tf.path ?? first.name;
      setTarget(path);
    },
    [],
  );

  const running = progress !== null && isRunning(progress.phase);
  const pathPresetList = useMemo(() => pathPresets(home), [home]);

  if (!isTauri) {
    return (
      <div style={emptyStateStyle}>
        SCANNER REQUIRES THE TAURI BACKEND — launch SUNNY via <code>pnpm tauri dev</code> or the built app.
      </div>
    );
  }

  return (
    <>
      {/* Target picker */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <span>TARGET</span>
          <span style={{ ...hintStyle, marginLeft: 'auto' }}>
            Drop a folder anywhere on this card
          </span>
        </div>

        <label style={labelStyle}>PATH</label>
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <input
            type="text"
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder="/absolute/path/to/scan"
            style={{
              ...inputStyle,
              borderColor: dragOver ? 'var(--cyan)' : 'var(--line-soft)',
              background: dragOver ? 'rgba(57, 229, 255, 0.08)' : 'rgba(2, 6, 10, 0.6)',
            }}
            disabled={running}
          />
          <button
            style={{ ...mutedBtnStyle, padding: '8px 14px' }}
            onClick={handlePickFolder}
            disabled={running}
          >
            PICK FOLDER…
          </button>
        </div>
        <div style={{ ...hintStyle, marginTop: 6 }}>
          Type a path, pick one via the native dialog, or drop a folder onto this card.
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={labelStyle}>SMART TARGETS</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {SMART_PRESETS.map(p => (
              <button
                key={p.id}
                style={{
                  ...chipBaseStyle,
                  borderColor: 'var(--cyan)',
                  color: 'var(--cyan)',
                  background: 'rgba(57, 229, 255, 0.10)',
                }}
                onClick={() => void handlePresetClick(p)}
                disabled={running || starting}
                title={p.description}
              >
                ▸ {p.label}
              </button>
            ))}
          </div>

          <label style={labelStyle}>FOLDER PRESETS</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {pathPresetList.map(p => {
              const active = target === p.path;
              return (
                <button
                  key={p.id}
                  style={active ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
                  onClick={() => void handlePresetClick(p)}
                  disabled={running}
                  title={p.description}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Options */}
      <section style={sectionStyle}>
        <div style={sectionTitleStyle}>OPTIONS</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Toggle
            label="RECURSIVE"
            desc="Descend into subfolders."
            value={options.recursive}
            disabled={running}
            onChange={v => patch('recursive', v)}
          />
          <Toggle
            label="ONLINE LOOKUP"
            desc="Query MalwareBazaar for each hash."
            value={options.onlineLookup}
            disabled={running}
            onChange={v => patch('onlineLookup', v)}
          />
          <Toggle
            label="DEEP"
            desc="Hash every file, not just those with risk signals."
            value={options.deep}
            disabled={running}
            onChange={v => patch('deep', v)}
          />
          <Toggle
            label="VIRUSTOTAL"
            desc="Requires SUNNY_VIRUSTOTAL_KEY env var."
            value={options.virustotal}
            disabled={running}
            onChange={v => patch('virustotal', v)}
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={labelStyle}>MAX FILE SIZE</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { label: '10 MB', value: 10 * 1024 * 1024 },
              { label: '100 MB', value: 100 * 1024 * 1024 },
              { label: '1 GB', value: 1024 * 1024 * 1024 },
              { label: 'No limit', value: null },
            ].map(opt => {
              const active = options.maxFileSize === opt.value;
              return (
                <button
                  key={opt.label}
                  style={active ? { ...chipBaseStyle, ...chipActiveStyle } : chipBaseStyle}
                  onClick={() => patch('maxFileSize', opt.value)}
                  disabled={running}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Threat database — what we're scanning for */}
      {catalog && <ThreatDatabasePanel catalog={catalog} />}

      {/* Ad-hoc probe tool */}
      <ProbePanel />

      {/* Start / abort */}
      <section style={sectionStyle}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            style={primaryBtnStyle}
            onClick={handleStart}
            disabled={starting || running}
          >
            {starting ? 'STARTING…' : running ? 'SCAN IN PROGRESS' : 'START SCAN'}
          </button>
          {running && (
            <button
              className="scan-abort-btn"
              onClick={handleAbort}
              title="Abort scan (sends cancel signal to Rust)"
              style={{
                ...dangerBtnStyle,
                padding: '8px 18px',
                letterSpacing: '0.26em',
                fontWeight: 700,
                borderWidth: 1,
              }}
            >
              ■ ABORT
            </button>
          )}
          {startError !== null && (
            <span style={{ ...hintStyle, color: 'var(--amber)' }}>{startError}</span>
          )}
        </div>
      </section>

      {/* Live progress + threat gauge */}
      {progress !== null && (
        <ProgressView
          progress={progress}
          findings={findings}
          onJumpToFindings={onJumpToFindings}
        />
      )}
    </>
  );
}
