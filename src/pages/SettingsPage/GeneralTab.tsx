import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useView } from '../../store/view';
import { invokeSafe, isTauri } from '../../lib/tauri';
import { PTT_KEYS } from './HotkeysTab';
import {
  chipBase,
  chipStyle,
  codeStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  twoColGrid,
} from './styles';

// ─────────────────────────────────────────────────────────────────
// GeneralTab — the "everyday knobs" tab. Historically this owned
// every setting SUNNY had; after the deep-dive refactor we moved:
//
//   * AI provider / model / presets → MODELS tab
//   * macOS TCC permissions         → PERMISSIONS tab
//   * Hotkey reference              → HOTKEYS tab
//   * Storage paths / diagnostics   → ADVANCED tab
//
// What's left is the day-to-day stuff: a "is the CLI bridge alive"
// readout, the theme picker, orb knobs, and the voice settings plus
// pipeline smoke test. That keeps this tab small enough to scan
// without scrolling on a 900px window.
// ─────────────────────────────────────────────────────────────────

const THEMES = ['cyan', 'amber', 'green', 'violet', 'magenta'] as const;
const POLICIES = ['fixed', 'load', 'voice', 'focus'] as const;
/** Fallback used when the Tauri `list_voices` command isn't reachable
 *  (dev-server preview, type checking) — must match what the Rust
 *  `voice::list_british_voices()` returns so the UI stays renderable. */
const FALLBACK_VOICES = ['George', 'Daniel', 'Lewis', 'Fable', 'Oliver'] as const;

type PipelineStage = 'idle' | 'recording' | 'transcribing' | 'speaking' | 'done' | 'error';

type Props = {
  readonly onSaveFlash?: (flashing: boolean) => void;
};

export function GeneralTab({ onSaveFlash }: Props) {
  const settings = useView(s => s.settings);
  const patchSettings = useView(s => s.patchSettings);

  const [openclawUp, setOpenclawUp] = useState<boolean | null>(null);
  const [pingBusy, setPingBusy] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>('idle');
  const [pipelineTranscript, setPipelineTranscript] = useState('');
  const [pipelineError, setPipelineError] = useState('');

  // Voice picker options — sourced from the Rust `list_voices` command so
  // this tab stays in sync with `voice::list_british_voices()`. Falls
  // back to a compiled-in list outside Tauri (dev-server preview).
  const [voices, setVoices] = useState<ReadonlyArray<string>>(FALLBACK_VOICES);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const fromRust = await invokeSafe<ReadonlyArray<string>>('list_voices');
      if (alive && fromRust && fromRust.length > 0) setVoices(fromRust);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Flash the SAVED badge in the header after any mutation. Skip the very
  // first render since the settings snapshot just hydrated — we don't want
  // to tell the user we "saved" a value they never touched.
  const firstSettingsRender = useRef(true);
  useEffect(() => {
    if (firstSettingsRender.current) {
      firstSettingsRender.current = false;
      return;
    }
    onSaveFlash?.(true);
    const id = window.setTimeout(() => onSaveFlash?.(false), 900);
    return () => window.clearTimeout(id);
  }, [settings, onSaveFlash]);

  const doPing = useCallback(async () => {
    setPingBusy(true);
    const res = await invokeSafe<boolean>('openclaw_ping');
    setOpenclawUp(res === true);
    setPingBusy(false);
  }, []);

  useEffect(() => { void doPing(); }, [doPing]);

  const testVoice = useCallback(() => {
    void invokeSafe('speak', {
      text: 'Good afternoon. SUNNY online. Voice check.',
      voice: settings.voiceName,
      rate: settings.voiceRate,
    });
  }, [settings.voiceName, settings.voiceRate]);

  const runPipelineTest = useCallback(async () => {
    setPipelineError('');
    setPipelineTranscript('');
    try {
      setPipelineStage('recording');
      const startRes = await invokeSafe<string>('audio_record_start');
      if (startRes === null) throw new Error('audio_record_start unavailable');
      await new Promise<void>(resolve => window.setTimeout(resolve, 2000));
      const path = await invokeSafe<string>('audio_record_stop');
      if (!path) throw new Error('audio_record_stop returned no path');
      setPipelineStage('transcribing');
      const text = await invokeSafe<string>('transcribe', { path });
      if (!text) throw new Error('transcription failed');
      setPipelineTranscript(text);
      setPipelineStage('speaking');
      await invokeSafe('speak', {
        text,
        voice: settings.voiceName,
        rate: settings.voiceRate,
      });
      setPipelineStage('done');
    } catch (err) {
      setPipelineError(err instanceof Error ? err.message : 'pipeline failed');
      setPipelineStage('error');
    }
  }, [settings.voiceName, settings.voiceRate]);

  const ocColor = openclawUp ? 'var(--cyan)' : 'var(--amber)';
  const ocLabel =
    openclawUp === null ? 'checking…'
    : openclawUp ? 'connected'
    : 'not found';
  const pipelineBusy =
    pipelineStage === 'recording' ||
    pipelineStage === 'transcribing' ||
    pipelineStage === 'speaking';
  const pipelineLabel =
    pipelineStage === 'recording' ? 'LISTENING 2s…'
    : pipelineStage === 'transcribing' ? 'TRANSCRIBING…'
    : pipelineStage === 'speaking' ? 'SPEAKING…'
    : pipelineStage === 'done' ? 'PIPELINE OK'
    : pipelineStage === 'error' ? 'PIPELINE ERROR'
    : 'RUN PIPELINE TEST';

  return (
    <div style={twoColGrid}>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>CONNECTION</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              color: ocColor,
              fontFamily: 'var(--display)',
              fontSize: 12,
              letterSpacing: '0.22em',
              fontWeight: 700,
            }}
          >
            ● OPENCLAW · {ocLabel.toUpperCase()}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
            Bridge path:{' '}
            <code style={codeStyle}>~/Library/Application Support/OpenClaw/bridge.sock</code>
          </div>
          <div style={rowStyle}>
            <button onClick={doPing} disabled={pingBusy} style={chipBase}>
              {pingBusy ? 'TESTING…' : 'TEST CONNECTION'}
            </button>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: ocColor,
                letterSpacing: '0.08em',
              }}
            >
              {openclawUp === null ? '—' : openclawUp ? 'ping ok' : 'no gateway'}
            </span>
          </div>
          <div style={hintStyle}>
            The bridge socket is how SUNNY talks to the OpenClaw CLI host. If
            this is red and you expected it up, the MODELS tab lets you flip
            to the Ollama backend without a restart.
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>APPEARANCE</h3>
        <label style={labelStyle}>THEME</label>
        <div style={{ ...rowStyle, marginBottom: 10 }}>
          {THEMES.map(t => (
            <button
              key={t}
              style={chipStyle(settings.theme === t)}
              onClick={() => patchSettings({ theme: t })}
            >
              {t}
            </button>
          ))}
        </div>
        <label htmlFor="settings-orb-intensity" style={labelStyle}>ORB INTENSITY — {settings.orbIntensity}</label>
        <input
          id="settings-orb-intensity"
          type="range"
          min={40}
          max={160}
          value={settings.orbIntensity}
          onChange={e => patchSettings({ orbIntensity: Number(e.target.value) })}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <label htmlFor="settings-grid-opacity" style={labelStyle}>GRID OPACITY — {settings.gridOpacity}%</label>
        <input
          id="settings-grid-opacity"
          type="range"
          min={0}
          max={100}
          value={settings.gridOpacity}
          onChange={e => patchSettings({ gridOpacity: Number(e.target.value) })}
          style={{ width: '100%', marginBottom: 10 }}
        />
        <label style={labelStyle}>ORB STATE POLICY</label>
        <div style={rowStyle}>
          {POLICIES.map(p => (
            <button
              key={p}
              style={chipStyle(settings.orbStatePolicy === p)}
              onClick={() => patchSettings({ orbStatePolicy: p })}
            >
              {p}
            </button>
          ))}
        </div>
        <div style={hintStyle}>
          "load" reacts to system pressure · "voice" lights on wake · "focus"
          follows the frontmost app · "fixed" never moves.
        </div>
      </section>

      <section style={{ ...sectionStyle, gridColumn: '1 / -1' }}>
        <h3 style={sectionTitleStyle}>VOICE</h3>

        <div style={voiceGrid}>
          <div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink)',
              }}
            >
              <input
                type="checkbox"
                checked={settings.voiceEnabled}
                onChange={e => patchSettings({ voiceEnabled: e.target.checked })}
              />
              Voice output enabled
            </label>

            <label style={labelStyle}>VOICE · BRITISH MALE</label>
            <div style={{ ...rowStyle, marginBottom: 10 }}>
              {voices.map(v => (
                <button
                  key={v}
                  style={chipStyle(settings.voiceName === v)}
                  onClick={() => patchSettings({ voiceName: v })}
                >
                  {v} · UK
                </button>
              ))}
            </div>

            <label htmlFor="settings-voice-rate" style={labelStyle}>RATE — {settings.voiceRate} wpm</label>
            <input
              id="settings-voice-rate"
              type="range"
              min={120}
              max={280}
              value={settings.voiceRate}
              onChange={e => patchSettings({ voiceRate: Number(e.target.value) })}
              style={{ width: '100%', marginBottom: 10 }}
            />

            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>WAKE PHRASE</span>
              <span style={comingSoonBadge}>COMING SOON</span>
            </label>
            <input
              type="text"
              value={settings.wakePhrase}
              onChange={e => patchSettings({ wakePhrase: e.target.value })}
              placeholder="hey sunny"
              disabled
              aria-disabled="true"
              title="Wake word detection is under development. Currently press Space to talk."
              style={{ ...inputStyle, marginBottom: 10, opacity: 0.45, cursor: 'not-allowed' }}
            />

            <label style={labelStyle}>PUSH-TO-TALK</label>
            <div style={{ ...rowStyle, marginBottom: 10 }}>
              {PTT_KEYS.map(k => (
                <button
                  key={k}
                  style={chipStyle(settings.pushToTalkKey === k)}
                  onClick={() => patchSettings({ pushToTalkKey: k })}
                >
                  {k}
                </button>
              ))}
            </div>

            <div style={rowStyle}>
              <button style={chipBase} onClick={testVoice}>TEST VOICE</button>
              <button style={chipBase} onClick={() => invokeSafe('speak_stop')}>STOP</button>
            </div>
          </div>

          <div>
            <label style={labelStyle}>PIPELINE</label>
            <div style={hintStyle}>
              Records 2 s from the mic, transcribes via <code style={codeStyle}>whisper</code>,
              then plays it back through Kokoro-82M
              (<code style={codeStyle}>bm_{settings.voiceName.toLowerCase()}</code>) with macOS{' '}
              <code style={codeStyle}>say -v {settings.voiceName}</code> as fallback. Uses the
              fat-PATH so nvm / Homebrew tools are visible.
            </div>
            <div style={{ ...rowStyle, marginTop: 10 }}>
              <button style={chipBase} onClick={runPipelineTest} disabled={pipelineBusy}>
                {pipelineLabel}
              </button>
            </div>
            {pipelineTranscript && (
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--cyan)',
                  marginTop: 8,
                }}
              >
                Heard: <code style={codeStyle}>{pipelineTranscript}</code>
              </div>
            )}
            {pipelineError && (
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--amber)',
                  marginTop: 8,
                }}
              >
                {pipelineError}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const voiceGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  gap: 18,
};

// Small pill that sits next to the WAKE PHRASE label. Signals to the user
// that the input below is stubbed — wake-word detection is pending a proper
// KWS implementation (see `useWakeWord.ts` WAKE_WORD_ENABLED gate).
const comingSoonBadge: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.14em',
  fontWeight: 700,
  color: 'var(--amber)',
  border: '1px solid var(--amber)',
  borderRadius: 3,
  padding: '1px 5px',
  opacity: 0.85,
};

/**
 * Compute the header badge for the GENERAL / SETTINGS page. Shows a live
 * "saved Ns ago" counter when the user has actually mutated something in
 * this session (tracked by the `saveFlash` toggle) — otherwise falls back
 * to the static "PERSISTED · path" line so the user always knows WHERE
 * SUNNY writes, not just WHEN.
 *
 * The timer ticks every second via a local counter, but re-renders only
 * when the displayed label string actually changes — avoids waking the
 * SettingsPage root 60 times a minute for cosmetic reasons.
 */
export function useGeneralBadge(saveFlash: boolean): string {
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (saveFlash) setLastSavedAt(Date.now());
  }, [saveFlash]);

  useEffect(() => {
    if (lastSavedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  return useMemo(() => {
    if (saveFlash) return 'SAVING…';
    if (lastSavedAt !== null) {
      const seconds = Math.max(0, Math.round((now - lastSavedAt) / 1000));
      if (seconds < 1) return 'SAVED · just now';
      if (seconds < 60) return `SAVED · ${seconds}s ago`;
      const mins = Math.round(seconds / 60);
      if (mins < 60) return `SAVED · ${mins}m ago`;
      const hours = Math.round(mins / 60);
      return `SAVED · ${hours}h ago`;
    }
    return isTauri
      ? 'PERSISTED · ~/.sunny/settings.json'
      : 'PERSISTED · localStorage';
  }, [saveFlash, lastSavedAt, now]);
}
