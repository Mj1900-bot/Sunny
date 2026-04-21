import { useCallback, useEffect, useState } from 'react';
import { useView } from '../store/view';
import { invokeSafe } from '../lib/tauri';

const THEMES = ['cyan', 'amber', 'green', 'violet', 'magenta'] as const;
const POLICIES = ['fixed', 'load', 'voice', 'focus'] as const;

const BRIDGE_PATH = '~/Library/Application Support/OpenClaw/bridge.sock';
const SANDBOXES = ['main', 'alfred', 'stephanie', 'test-agent'] as const;

const OPENCLAW_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;
const OLLAMA_MODELS = ['llama3.2', 'gemma4:26b', 'qwen2.5'] as const;

type Provider = 'ollama' | 'openclaw' | 'glm';

type Preset = {
  readonly id: string;
  readonly label: string;
  readonly provider: Provider;
  readonly model: string;
};

const PRESETS: readonly Preset[] = [
  { id: 'oc-opus', label: 'OpenClaw → Opus', provider: 'openclaw', model: OPENCLAW_MODELS[0] },
  { id: 'oc-ollama-gemma', label: 'OpenClaw → Ollama Gemma', provider: 'openclaw', model: OLLAMA_MODELS[1] },
  { id: 'ol-llama', label: 'Ollama → Llama 3.2', provider: 'ollama', model: OLLAMA_MODELS[0] },
  { id: 'ol-gemma3', label: 'Ollama → Gemma3', provider: 'ollama', model: OLLAMA_MODELS[1] },
];

type PipelineStage = 'idle' | 'recording' | 'transcribing' | 'speaking' | 'done' | 'error';

export function SettingsDropdown() {
  const { settingsOpen, closeSettings, settings, patchSettings } = useView();
  const [openclawUp, setOpenclawUp] = useState<boolean | null>(null);
  const [pingBusy, setPingBusy] = useState<boolean>(false);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>('idle');
  const [pipelineTranscript, setPipelineTranscript] = useState<string>('');
  const [pipelineError, setPipelineError] = useState<string>('');

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [closeSettings]);

  useEffect(() => {
    document.body.classList.remove('theme-cyan', 'theme-amber', 'theme-green', 'theme-violet', 'theme-magenta');
    if (settings.theme !== 'cyan') document.body.classList.add(`theme-${settings.theme}`);
  }, [settings.theme]);

  const doPing = useCallback(async () => {
    setPingBusy(true);
    const res = await invokeSafe<boolean>('openclaw_ping');
    setOpenclawUp(res);
    setPingBusy(false);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    doPing();
  }, [settingsOpen, doPing]);

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
      const msg = err instanceof Error ? err.message : 'pipeline failed';
      setPipelineError(msg);
      setPipelineStage('error');
    }
  }, [settings.voiceName, settings.voiceRate]);

  if (!settingsOpen) return null;

  const testVoice = () =>
    invokeSafe('speak', {
      text: 'Good afternoon. SUNNY online. Voice check.',
      voice: settings.voiceName,
      rate: settings.voiceRate,
    });

  const applyPreset = (preset: Preset) =>
    patchSettings({ provider: preset.provider, model: preset.model });

  const ocColor = openclawUp === true ? 'var(--cyan)' : 'var(--amber)';
  const ocLabel =
    openclawUp === null ? 'checking…'
      : openclawUp ? 'connected'
      : 'not found';
  const pipelineBusy = pipelineStage === 'recording' || pipelineStage === 'transcribing' || pipelineStage === 'speaking';
  const pipelineLabel =
    pipelineStage === 'recording' ? 'LISTENING 2s…'
      : pipelineStage === 'transcribing' ? 'TRANSCRIBING…'
      : pipelineStage === 'speaking' ? 'SPEAKING…'
      : pipelineStage === 'done' ? 'PIPELINE OK'
      : pipelineStage === 'error' ? 'PIPELINE ERROR'
      : 'PIPELINE TEST';

  return (
    <div className="settings-backdrop" onClick={closeSettings}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-head">
          <h2>SETTINGS</h2>
          <button onClick={closeSettings} aria-label="Close">×</button>
        </div>

        <section>
          <h3>Connection</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            <div
              style={{
                fontFamily: "'Orbitron', var(--display, var(--mono))",
                fontSize: 11,
                letterSpacing: '0.22em',
                color: ocColor,
                fontWeight: 700,
              }}
            >
              ● OPENCLAW · {ocLabel.toUpperCase()}
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', var(--mono)",
                fontSize: 11,
                color: 'var(--ink-2)',
              }}
            >
              Bridge path: <code style={{ color: 'var(--cyan)' }}>{BRIDGE_PATH}</code>
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', var(--mono)",
                fontSize: 11,
                color: 'var(--ink-2)',
              }}
            >
              Sandboxes:{' '}
              {SANDBOXES.map((s, i) => (
                <span key={s}>
                  <code style={{ color: 'var(--cyan)' }}>{s}</code>
                  {i < SANDBOXES.length - 1 ? ', ' : ''}
                </span>
              ))}
            </div>
          </div>
          <div className="row">
            <button onClick={doPing} disabled={pingBusy}>
              {pingBusy ? 'TESTING…' : 'TEST CONNECTION'}
            </button>
            <span
              style={{
                fontFamily: "'JetBrains Mono', var(--mono)",
                fontSize: 11,
                color: ocColor,
                alignSelf: 'center',
                letterSpacing: '0.08em',
              }}
            >
              {openclawUp === null ? '—' : openclawUp ? 'ping ok' : 'no gateway'}
            </span>
          </div>
        </section>

        <section>
          <h3>Appearance</h3>
          <label>THEME
            <div className="row">
              {THEMES.map(t => (
                <button
                  key={t}
                  className={settings.theme === t ? 'active' : ''}
                  onClick={() => patchSettings({ theme: t })}
                >{t}</button>
              ))}
            </div>
          </label>
          <label>ORB INTENSITY <span className="v">{settings.orbIntensity}</span>
            <input type="range" min={40} max={160}
              value={settings.orbIntensity}
              aria-label="Orb intensity"
              aria-valuetext={String(settings.orbIntensity)}
              onChange={e => patchSettings({ orbIntensity: Number(e.target.value) })} />
          </label>
          <label>GRID OPACITY <span className="v">{settings.gridOpacity}%</span>
            <input type="range" min={0} max={100}
              value={settings.gridOpacity}
              aria-label="Grid opacity"
              aria-valuetext={settings.gridOpacity + '%'}
              onChange={e => patchSettings({ gridOpacity: Number(e.target.value) })} />
          </label>
          <label>ORB STATE POLICY
            <div className="row">
              {POLICIES.map(p => (
                <button
                  key={p}
                  className={settings.orbStatePolicy === p ? 'active' : ''}
                  onClick={() => patchSettings({ orbStatePolicy: p })}
                >{p}</button>
              ))}
            </div>
          </label>
        </section>

        <section>
          <h3>Voice</h3>
          <label className="switch">
            <input type="checkbox" checked={settings.voiceEnabled}
              onChange={e => patchSettings({ voiceEnabled: e.target.checked })} />
            Voice output enabled
          </label>
          <label>VOICE
            <div className="row">
              {['George', 'Daniel', 'Lewis', 'Fable', 'Oliver'].map(v => (
                <button
                  key={v}
                  className={settings.voiceName === v ? 'active' : ''}
                  onClick={() => patchSettings({ voiceName: v })}
                >{v} · UK male</button>
              ))}
            </div>
          </label>
          <label>RATE <span className="v">{settings.voiceRate} wpm</span>
            <input type="range" min={120} max={280}
              value={settings.voiceRate}
              aria-label="Voice rate"
              aria-valuetext={settings.voiceRate + ' words per minute'}
              onChange={e => patchSettings({ voiceRate: Number(e.target.value) })} />
          </label>
          <div className="row">
            <button onClick={testVoice}>Test voice</button>
            <button onClick={() => invokeSafe('speak_stop')}>Stop</button>
          </div>
        </section>

        <section>
          <h3>Voice Provider</h3>
          <p className="hint">
            Transcription: tries <code>openclaw transcribe</code>, falls back to <code>whisper</code> CLI.
          </p>
          <div className="row">
            <button onClick={runPipelineTest} disabled={pipelineBusy}>
              {pipelineLabel}
            </button>
          </div>
          {pipelineTranscript && (
            <p className="hint" style={{ color: 'var(--cyan-2)' }}>
              Heard: <code>{pipelineTranscript}</code>
            </p>
          )}
          {pipelineError && (
            <p className="hint" style={{ color: 'var(--amber)' }}>
              {pipelineError}
            </p>
          )}
        </section>

        <section>
          <h3>AI Provider</h3>
          <label>PRESETS
            <div className="row">
              {PRESETS.map(preset => {
                const active =
                  settings.provider === preset.provider && settings.model === preset.model;
                return (
                  <button
                    key={preset.id}
                    className={active ? 'active' : ''}
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </label>
          <label>PROVIDER
            <div className="row">
              <button
                className={settings.provider === 'ollama' ? 'active' : ''}
                onClick={() => patchSettings({ provider: 'ollama' })}
              >Ollama (local)</button>
              <button
                className={settings.provider === 'glm' ? 'active' : ''}
                onClick={() => patchSettings({ provider: 'glm', model: 'glm-5.1' })}
              >Z.AI GLM</button>
              <button
                className={settings.provider === 'openclaw' ? 'active' : ''}
                onClick={() => patchSettings({ provider: 'openclaw' })}
              >OpenClaw CLI</button>
            </div>
          </label>
          <label>MODEL
            <input
              type="text"
              value={settings.model}
              onChange={e => patchSettings({ model: e.target.value })}
              placeholder="llama3.2 / gemma4:26b / claude-opus-4-6"
            />
          </label>
          <p className="hint">
            Ollama talks to <code>127.0.0.1:11434</code>. OpenClaw shells to <code>openclaw chat</code>.
          </p>
        </section>

        <section>
          <h3>About</h3>
          <p className="hint">
            SUNNY v0.1.0 — personal assistant HUD · macOS native via Tauri.
          </p>
        </section>
      </div>
    </div>
  );
}
