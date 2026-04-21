/**
 * ModelsTab — provider, sampling knobs, Keychain-backed API keys, and
 * live Ollama model detection.
 *
 * # API-key security model
 *
 * - Key material is stored in the macOS login Keychain, which is:
 *   * Encrypted at rest with the user's login password.
 *   * Locked when the screen is locked / user is logged out.
 *   * ACL'd so only SUNNY (and tools the user explicitly grants) can read it.
 * - The React side never holds the key in state — the moment you press SAVE
 *   the draft is wiped and the input re-masked.
 * - The IPC surface (`secret_set` / `secret_delete` / `secrets_status`)
 *   returns only booleans. The webview never sees the stored material.
 * - We do NOT mirror into localStorage, settings.json, or any log line.
 *
 * # Keychain details
 *
 * Each provider lives under service name `sunny-<provider>-api-key`,
 * account = `$USER`. You can audit / manage them from Keychain Access.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { useView, type ModelPreset } from '../../store/view';
import { invoke, invokeSafe, isTauri } from '../../lib/tauri';
import {
  chipBase,
  chipStyle,
  codeStyle,
  dangerBtnStyle,
  hintStyle,
  inputStyle,
  labelStyle,
  primaryBtnStyle,
  rowStyle,
  sectionStyle,
  sectionTitleStyle,
  statusPillStyle,
  twoColGrid,
} from './styles';

// ---------------------------------------------------------------------------
// Preset catalogue
// ---------------------------------------------------------------------------

const BUILTIN_PRESETS: ReadonlyArray<ModelPreset> = [
  { id: 'kimi-26',      label: 'Moonshot → Kimi K2.6',  provider: 'kimi',     model: 'kimi-k2.6' },
  { id: 'glm-51',       label: 'Z.AI → GLM-5.1',        provider: 'glm',      model: 'glm-5.1' },
  { id: 'oc-sunny',      label: 'OpenClaw → Sunny',       provider: 'openclaw', model: 'sunny' },
  { id: 'oc-alfred',    label: 'OpenClaw → Alfred',     provider: 'openclaw', model: 'alfred' },
  { id: 'oc-stephanie', label: 'OpenClaw → Stephanie',  provider: 'openclaw', model: 'stephanie' },
  { id: 'oc-opus',      label: 'OpenClaw → Opus 4.6',   provider: 'openclaw', model: 'claude-opus-4-6' },
  { id: 'oc-sonnet',    label: 'OpenClaw → Sonnet 4.6', provider: 'openclaw', model: 'claude-sonnet-4-6' },
  { id: 'oc-haiku',     label: 'OpenClaw → Haiku 4.5',  provider: 'openclaw', model: 'claude-haiku-4-5' },
  { id: 'ol-llama',     label: 'Ollama → Llama 3.2',    provider: 'ollama',   model: 'llama3.2' },
  { id: 'ol-gemma',     label: 'Ollama → Gemma 4',      provider: 'ollama',   model: 'gemma4:26b' },
  { id: 'ol-qwen',      label: 'Ollama → Qwen 2.5',     provider: 'ollama',   model: 'qwen2.5' },
];

// Fallback quick picks when Ollama isn't running — curated defaults only.
// Once the Rust side answers, the live installed list replaces this.
const OPENCLAW_QUICK_PICKS: ReadonlyArray<string> = [
  'sunny', 'alfred', 'stephanie',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
];

const OLLAMA_FALLBACK_PICKS: ReadonlyArray<string> = [
  'llama3.2', 'gemma4:26b', 'qwen2.5',
  'qwen3:30b-a3b-instruct-2507-q4_K_M',
  'qwen3:30b-a3b-thinking-2507-q4_K_M',
  'deepseek-r1',
];

// ---------------------------------------------------------------------------
// Provider catalogue (key-storage UI)
// ---------------------------------------------------------------------------

type ProviderId =
  | 'anthropic'
  | 'zai'
  | 'moonshot'
  | 'openai'
  | 'openrouter'
  | 'elevenlabs'
  | 'wavespeed';

type ProviderMeta = Readonly<{
  id: ProviderId;
  label: string;
  purpose: string;
  envNames: ReadonlyArray<string>;
  keychainService: string;
  /** Ordered placeholder — gives the user a shape hint without autofilling. */
  placeholder: string;
  /** URL for docs / dashboard, opened in the default browser. */
  docsUrl: string;
}>;

const PROVIDERS: ReadonlyArray<ProviderMeta> = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    purpose: 'Claude Opus / Sonnet / Haiku — the default agent loop brain.',
    envNames: ['ANTHROPIC_API_KEY'],
    keychainService: 'sunny-anthropic-api-key',
    placeholder: 'sk-ant-api03-…',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT + Whisper + TTS)',
    purpose: 'GPT-4o / 4.1, DALL-E, Whisper transcription, OpenAI TTS voices.',
    envNames: ['OPENAI_API_KEY'],
    keychainService: 'sunny-openai-api-key',
    placeholder: 'sk-proj-…  or  sk-…',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (model router)',
    purpose: 'One key, hundreds of models — pay-as-you-go across vendors.',
    envNames: ['OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY'],
    keychainService: 'sunny-openrouter-api-key',
    placeholder: 'sk-or-v1-…',
    docsUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'zai',
    label: 'Z.AI / GLM',
    purpose: 'Zhipu GLM models — strong Chinese + code, cheap long-context.',
    envNames: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY'],
    keychainService: 'sunny-zai-api-key',
    placeholder: 'z-ai-…  or  glm-…',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    purpose: 'Kimi K2.6 — 1T/32B MoE with agent-swarm coordination, #1 on SWE-Bench Pro.',
    envNames: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    keychainService: 'sunny-moonshot-api-key',
    placeholder: 'sk-…',
    docsUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs (voice)',
    purpose: 'Premium neural voices for speak output and custom voice clones.',
    envNames: ['ELEVENLABS_API_KEY', 'XI_API_KEY'],
    keychainService: 'sunny-elevenlabs-api-key',
    placeholder: 'xi-api-key-…  or  sk_…',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    id: 'wavespeed',
    label: 'Wavespeed (video + image)',
    purpose: 'Wavespeed diffusion stack — fast image + video generation.',
    envNames: ['WAVESPEED_API_KEY', 'WAVESPEED_AI_API_KEY'],
    keychainService: 'sunny-wavespeed-api-key',
    placeholder: 'ws_…',
    docsUrl: 'https://wavespeed.ai/dashboard/api-keys',
  },
];

type SecretsStatus = Readonly<Record<ProviderId, boolean>>;

/** Machine-readable outcome of a `secret_verify` probe. Must stay in
 * lock-step with `src-tauri/src/secrets.rs::VerifyResult`. */
type VerifyResult = Readonly<{
  provider: ProviderId;
  ok: boolean;
  status: number | null;
  category:
    | 'ok' | 'invalid_key' | 'invalid_endpoint' | 'timeout'
    | 'rate_limited' | 'server' | 'unknown' | 'missing' | 'network';
  message: string;
  latency_ms: number;
}>;

/** Outcome of `secret_import_env`. One row per provider.
 * Mirrors `src-tauri/src/secrets.rs::ImportOutcome`. */
type ImportOutcome = Readonly<{
  provider: ProviderId;
  env_var: string | null;
  already_in_keychain: boolean;
  imported: boolean;
  error: string;
}>;

const CATEGORY_COLOR: Record<VerifyResult['category'], string> = {
  ok: 'var(--cyan)',
  invalid_key: 'var(--red)',
  invalid_endpoint: 'var(--amber)',
  timeout: 'var(--amber)',
  rate_limited: 'var(--amber)',
  server: 'var(--amber)',
  unknown: 'var(--ink-dim)',
  missing: 'var(--ink-dim)',
  network: 'var(--amber)',
};

const CATEGORY_LABEL: Record<VerifyResult['category'], string> = {
  ok: 'VALID',
  invalid_key: 'INVALID KEY',
  invalid_endpoint: 'ENDPOINT 404',
  timeout: 'TIMED OUT',
  rate_limited: 'RATE LIMITED',
  server: 'SERVER ERROR',
  unknown: 'UNKNOWN',
  missing: 'NO KEY',
  network: 'NETWORK ERROR',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ModelsTab(): JSX.Element {
  const settings = useView(s => s.settings);
  const patchSettings = useView(s => s.patchSettings);

  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [secretsBusy, setSecretsBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<ReadonlyArray<string> | null>(null);
  const [verifyResults, setVerifyResults] = useState<ReadonlyMap<ProviderId, VerifyResult>>(
    () => new Map(),
  );
  const [verifyingId, setVerifyingId] = useState<ProviderId | null>(null);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ReadonlyArray<ImportOutcome> | null>(null);

  const refreshSecrets = useCallback(async () => {
    setSecretsBusy(true);
    const s = await invokeSafe<SecretsStatus>('secrets_status');
    setSecrets(
      s ?? {
        anthropic: false, zai: false, moonshot: false, openai: false,
        openrouter: false, elevenlabs: false, wavespeed: false,
      },
    );
    setSecretsBusy(false);
  }, []);

  const refreshOllama = useCallback(async () => {
    const models = await invokeSafe<ReadonlyArray<string>>('ollama_list_models');
    setOllamaModels(models ?? []);
  }, []);

  const verifyProvider = useCallback(async (id: ProviderId) => {
    if (!isTauri) return;
    setVerifyingId(id);
    try {
      const result = await invoke<VerifyResult>('secret_verify', { provider: id });
      setVerifyResults(prev => {
        const next = new Map(prev);
        next.set(id, result);
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setVerifyResults(prev => {
        const next = new Map(prev);
        next.set(id, {
          provider: id,
          ok: false,
          status: null,
          category: 'network',
          message,
          latency_ms: 0,
        });
        return next;
      });
    } finally {
      setVerifyingId(null);
    }
  }, []);

  const importFromEnv = useCallback(async () => {
    if (!isTauri) return;
    setImporting(true);
    setImportSummary(null);
    try {
      const outcomes = await invoke<ReadonlyArray<ImportOutcome>>('secret_import_env');
      setImportSummary(outcomes);
      await refreshSecrets();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface as a synthetic row so the user sees something actionable.
      setImportSummary([{
        provider: 'anthropic',
        env_var: null,
        already_in_keychain: false,
        imported: false,
        error: message,
      }]);
    } finally {
      setImporting(false);
    }
  }, [refreshSecrets]);

  useEffect(() => { void refreshSecrets(); }, [refreshSecrets]);
  useEffect(() => { void refreshOllama(); }, [refreshOllama]);

  const presets = useMemo<ReadonlyArray<ModelPreset>>(() => {
    const byId = new Map<string, ModelPreset>();
    for (const p of BUILTIN_PRESETS) byId.set(p.id, p);
    for (const p of settings.customPresets) byId.set(p.id, p);
    return Array.from(byId.values());
  }, [settings.customPresets]);

  const applyPreset = useCallback((preset: ModelPreset) => {
    patchSettings({ provider: preset.provider, model: preset.model });
  }, [patchSettings]);

  const addCustomPreset = useCallback(() => {
    const id = `user-${Date.now().toString(36)}`;
    const next: ModelPreset = {
      id,
      label: `${
        settings.provider === 'openclaw'
          ? 'OpenClaw'
          : settings.provider === 'glm'
          ? 'Z.AI'
          : settings.provider === 'kimi'
          ? 'Moonshot'
          : 'Ollama'
      } → ${settings.model}`,
      provider: settings.provider,
      model: settings.model,
    };
    patchSettings({ customPresets: [...settings.customPresets, next] });
  }, [patchSettings, settings.provider, settings.model, settings.customPresets]);

  const deleteCustomPreset = useCallback((id: string) => {
    patchSettings({
      customPresets: settings.customPresets.filter(p => p.id !== id),
    });
  }, [patchSettings, settings.customPresets]);

  const isBuiltIn = useCallback(
    (id: string): boolean => BUILTIN_PRESETS.some(p => p.id === id),
    [],
  );

  // Quick picks: Ollama → live installed list (when reachable) → fallback.
  // OpenClaw has no probe endpoint, so we keep the static curated list.
  const quickPicks = useMemo<ReadonlyArray<string>>(() => {
    if (settings.provider === 'openclaw') return OPENCLAW_QUICK_PICKS;
    if (ollamaModels === null) return OLLAMA_FALLBACK_PICKS;
    if (ollamaModels.length === 0) return OLLAMA_FALLBACK_PICKS;
    return ollamaModels;
  }, [settings.provider, ollamaModels]);

  const ollamaStatusLabel = useMemo(() => {
    if (settings.provider !== 'ollama') return null;
    if (ollamaModels === null) return 'probing…';
    if (ollamaModels.length === 0) return 'daemon not reachable — using fallback list';
    return `${ollamaModels.length} installed`;
  }, [settings.provider, ollamaModels]);

  return (
    <>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>PROVIDER</h3>

        <label style={labelStyle}>BACKEND</label>
        <div style={{ ...rowStyle, marginBottom: 10 }}>
          <button
            style={chipStyle(settings.provider === 'openclaw')}
            onClick={() => patchSettings({ provider: 'openclaw' })}
          >
            OpenClaw CLI
          </button>
          <button
            style={chipStyle(settings.provider === 'ollama')}
            onClick={() => patchSettings({ provider: 'ollama' })}
          >
            Ollama (local)
          </button>
          <button
            style={chipStyle(settings.provider === 'glm')}
            onClick={() => patchSettings({ provider: 'glm', model: 'glm-5.1' })}
          >
            Z.AI GLM
          </button>
          <button
            style={chipStyle(settings.provider === 'kimi')}
            onClick={() => patchSettings({ provider: 'kimi', model: 'kimi-k2.6' })}
          >
            Kimi K2.6
          </button>
          <span style={{ ...hintStyle, marginTop: 0, marginLeft: 8 }}>
            {settings.provider === 'openclaw'
              ? 'Talks to the OpenClaw bridge socket.'
              : settings.provider === 'glm'
              ? 'Streams from Z.AI\'s GLM-5.1 (Coding Plan). Needs ZAI_API_KEY.'
              : settings.provider === 'kimi'
              ? 'Streams from Moonshot\'s Kimi K2.6 (1T / 32B active, SWE-Bench #1). Needs MOONSHOT_API_KEY.'
              : 'Streams from a local Ollama daemon — works fully offline.'}
          </span>
        </div>

        <label style={labelStyle}>MODEL</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            value={settings.model}
            onChange={e => patchSettings({ model: e.target.value })}
            placeholder="leave blank for AUTO · or: sunny / gemma4:26b / claude-opus-4-6"
            style={{ ...inputStyle, flex: 1 }}
          />
          {settings.model.trim().length === 0 ? (
            <span
              style={statusPillStyle('var(--cyan)')}
              title="Empty model = runtime picker. OpenClaw / Ollama choose per request based on load, capability, and budget."
            >
              AUTO · RUNTIME PICKER
            </span>
          ) : (
            <button
              type="button"
              style={{ ...chipBase, padding: '6px 10px', fontSize: 10 }}
              onClick={() => patchSettings({ model: '' })}
              title="Clear the model name to fall back to runtime auto-selection"
            >
              CLEAR · AUTO
            </button>
          )}
        </div>
        {settings.model.trim().length === 0 && (
          <div style={hintStyle}>
            No model pinned — the backend picks one per request. Set a value
            below to lock in a specific model for every turn.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <div style={hintStyle}>
            Quick picks for <code style={codeStyle}>{settings.provider}</code>:
          </div>
          {settings.provider === 'ollama' && (
            <>
              <span
                style={statusPillStyle(
                  ollamaModels && ollamaModels.length > 0 ? 'var(--cyan)' : 'var(--amber)',
                )}
              >
                OLLAMA · {ollamaStatusLabel?.toUpperCase()}
              </span>
              <button
                style={{ ...chipBase, padding: '2px 8px', fontSize: 10 }}
                onClick={() => void refreshOllama()}
              >
                REFRESH
              </button>
            </>
          )}
        </div>
        <div style={{ ...rowStyle, marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
          {quickPicks.map(m => (
            <button
              key={m}
              style={chipStyle(settings.model === m)}
              onClick={() => patchSettings({ model: m })}
              title={m}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>PRESETS</h3>
        <div style={hintStyle}>
          One-click switch between provider + model combinations. Saved
          presets live in <code style={codeStyle}>~/.sunny/settings.json</code>{' '}
          and survive across devices when you sync that file.
        </div>

        <div style={{ ...rowStyle, marginTop: 10, marginBottom: 10 }}>
          {presets.map(p => {
            const active =
              settings.provider === p.provider && settings.model === p.model;
            return (
              <span key={p.id} style={presetChipWrap(active)}>
                <button
                  style={{
                    ...chipBase,
                    border: 'none',
                    background: 'transparent',
                    color: active ? 'var(--cyan)' : 'var(--ink-2)',
                    fontWeight: active ? 700 : 500,
                  }}
                  onClick={() => applyPreset(p)}
                >
                  {p.label}
                </button>
                {!isBuiltIn(p.id) && (
                  <button
                    title="Delete preset"
                    onClick={() => deleteCustomPreset(p.id)}
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--red)',
                      padding: '0 6px 0 0',
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <div style={rowStyle}>
          <button style={chipBase} onClick={addCustomPreset}>
            + SAVE CURRENT AS PRESET
          </button>
          <span style={{ ...hintStyle, marginTop: 0 }}>
            Adds <code style={codeStyle}>{settings.provider} → {settings.model}</code>{' '}
            to the list above.
          </span>
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>SAMPLING</h3>
        <div style={twoColGrid}>
          <div>
            <label htmlFor="settings-temperature" style={labelStyle}>TEMPERATURE — {settings.temperature.toFixed(2)}</label>
            <input
              id="settings-temperature"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings.temperature}
              onChange={e => patchSettings({ temperature: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <div style={hintStyle}>
              0 · deterministic · 0.7 · balanced · 1.2 · exploratory · 2 · chaotic.
              Claude ignores values above 1; Ollama clamps to the model's range.
            </div>
          </div>

          <div>
            <label htmlFor="settings-max-tokens" style={labelStyle}>MAX OUTPUT TOKENS — {settings.maxTokens}</label>
            <input
              id="settings-max-tokens"
              type="range"
              min={256}
              max={8192}
              step={64}
              value={settings.maxTokens}
              onChange={e => patchSettings({ maxTokens: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <div style={hintStyle}>
              Hard cap per agent turn. Answers that hit the ceiling get the
              "max_tokens" stop reason in the Auto log.
            </div>
          </div>

          <div>
            <label htmlFor="settings-context-budget" style={labelStyle}>
              CONTEXT BUDGET — {settings.contextBudget.toLocaleString()} tokens
            </label>
            <input
              id="settings-context-budget"
              type="range"
              min={4096}
              max={200_000}
              step={2048}
              value={settings.contextBudget}
              onChange={e => patchSettings({ contextBudget: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <div style={hintStyle}>
              Upper bound on system + history + tool-result bytes fed to each
              turn. Raise for long sessions, lower to save tokens on cheap
              models.
            </div>
          </div>

          <div>
            <label htmlFor="settings-tool-timeout" style={labelStyle}>TOOL TIMEOUT — {(settings.toolTimeoutMs / 1000).toFixed(0)} s</label>
            <input
              id="settings-tool-timeout"
              type="range"
              min={5_000}
              max={180_000}
              step={1_000}
              value={settings.toolTimeoutMs}
              onChange={e => patchSettings({ toolTimeoutMs: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
            <div style={hintStyle}>
              Hard wall-clock ceiling for any single tool invocation before
              the agent loop aborts the step and moves on.
            </div>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>API KEYS · STORED IN macOS KEYCHAIN</h3>

        <div style={securityCalloutStyle}>
          <span style={statusPillStyle('var(--cyan)')}>KEYCHAIN</span>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-2)' }}>
            Keys are encrypted at rest by macOS, ACL'd to your login, and
            invoked on demand. The webview never receives key material —
            only a reachable / missing flag. Env vars win over Keychain, so
            a <code style={codeStyle}>launchctl setenv</code> override still
            applies.
          </div>
        </div>

        <div style={{ ...rowStyle, marginBottom: 10 }}>
          <button
            style={primaryBtnStyle}
            onClick={() => void refreshSecrets()}
            disabled={secretsBusy || !isTauri}
          >
            {secretsBusy ? 'PROBING…' : 'RE-CHECK KEYCHAIN'}
          </button>
          <button
            style={chipBase}
            onClick={() => void importFromEnv()}
            disabled={importing || !isTauri}
            title="Scan $ENV for provider keys and persist any found into Keychain"
          >
            {importing ? 'IMPORTING…' : 'IMPORT FROM ENV'}
          </button>
          {!isTauri && (
            <span style={{ ...hintStyle, marginTop: 0 }}>
              Key storage only works inside the Tauri app.
            </span>
          )}
        </div>

        {importSummary && (
          <ImportSummary summary={importSummary} onDismiss={() => setImportSummary(null)} />
        )}

        <div style={keyGridStyle}>
          {PROVIDERS.map(p => (
            <KeyRow
              key={p.id}
              meta={p}
              present={secrets?.[p.id] ?? null}
              verifyResult={verifyResults.get(p.id) ?? null}
              verifying={verifyingId === p.id}
              onSaved={() => void refreshSecrets()}
              onCleared={() => {
                void refreshSecrets();
                setVerifyResults(prev => {
                  if (!prev.has(p.id)) return prev;
                  const next = new Map(prev);
                  next.delete(p.id);
                  return next;
                });
              }}
              onVerify={() => void verifyProvider(p.id)}
            />
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>SAFETY</h3>

        <label style={checkboxRow}>
          <input
            type="checkbox"
            checked={settings.autoApproveSafe}
            onChange={e => patchSettings({ autoApproveSafe: e.target.checked })}
          />
          <span>
            Auto-approve <code style={codeStyle}>risk: "low"</code> tool calls
          </span>
        </label>
        <div style={hintStyle}>
          When on, the ConfirmGate modal is bypassed for read-only / low-risk
          actions (file listing, OCR, web fetch…). Medium and HIGH-risk calls
          always surface the modal, and the 3-second HIGH-risk countdown
          still runs — this toggle never relaxes it.
        </div>

        <div style={{ marginTop: 10, ...rowStyle, gap: 16 }}>
          <span
            style={statusPillStyle(
              settings.autoApproveSafe ? 'var(--cyan)' : 'var(--amber)',
            )}
          >
            {settings.autoApproveSafe ? 'AUTO-APPROVE ON' : 'ALWAYS CONFIRM'}
          </span>
          <span style={{ ...hintStyle, marginTop: 0 }}>
            Dangerous actions still require explicit APPROVE.
          </span>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// KeyRow — per-provider editable row
// ---------------------------------------------------------------------------

type KeyRowProps = Readonly<{
  meta: ProviderMeta;
  present: boolean | null;
  verifyResult: VerifyResult | null;
  verifying: boolean;
  onSaved: () => void;
  onCleared: () => void;
  onVerify: () => void;
}>;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

function KeyRow({
  meta, present, verifyResult, verifying, onSaved, onCleared, onVerify,
}: KeyRowProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const clearedFlashRef = useRef<number | null>(null);
  const [clearedFlash, setClearedFlash] = useState(false);

  useEffect(() => {
    // Flash "saved" badge clears itself after 1.2s.
    if (state.kind !== 'saved') return;
    const id = window.setTimeout(() => setState({ kind: 'idle' }), 1200);
    return () => window.clearTimeout(id);
  }, [state]);

  useEffect(() => () => {
    if (clearedFlashRef.current) window.clearTimeout(clearedFlashRef.current);
  }, []);

  const wipeDraft = useCallback(() => {
    setDraft('');
    setReveal(false);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const save = useCallback(async () => {
    const value = draft.trim();
    if (!value) return;
    if (!isTauri) {
      setState({ kind: 'error', message: 'Key storage only works inside the Tauri app.' });
      return;
    }
    setState({ kind: 'saving' });
    try {
      // Use `invoke` directly so the Rust-side `Err(String)` reaches us
      // verbatim — `invokeSafe` would swallow the message as a generic
      // null, and the user would have no idea *why* the save failed.
      await invoke<null>('secret_set', { provider: meta.id, value });
      wipeDraft();
      onSaved();
      setState({ kind: 'saved', at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
    }
  }, [draft, meta.id, onSaved, wipeDraft]);

  const clear = useCallback(async () => {
    const confirmed = window.confirm(
      `Delete the ${meta.label} key from your Keychain?\n\nThis removes the SUNNY entry only. An environment-variable override (${meta.envNames.join(' / ')}) would still resolve.`,
    );
    if (!confirmed) return;
    if (!isTauri) return;
    setState({ kind: 'saving' });
    try {
      await invoke<null>('secret_delete', { provider: meta.id });
      wipeDraft();
      onCleared();
      setClearedFlash(true);
      if (clearedFlashRef.current) window.clearTimeout(clearedFlashRef.current);
      clearedFlashRef.current = window.setTimeout(() => setClearedFlash(false), 1200);
      setState({ kind: 'idle' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
    }
  }, [meta, onCleared, wipeDraft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      wipeDraft();
    }
  };

  const openDocs = useCallback(() => {
    void invokeSafe('open_url', { url: meta.docsUrl });
  }, [meta.docsUrl]);

  const statusColor =
    present === null ? 'var(--ink-dim)'
    : present ? 'var(--cyan)'
    : 'var(--amber)';
  const statusLabel =
    state.kind === 'saving' ? 'SAVING…'
    : clearedFlash ? 'CLEARED'
    : state.kind === 'saved' ? 'SAVED ✓'
    : present === null ? 'UNKNOWN'
    : present ? 'REACHABLE'
    : 'MISSING';

  return (
    <div style={keyCardStyle}>
      <div style={keyHeaderStyle}>
        <div>
          <div
            style={{
              fontFamily: 'var(--display)',
              fontSize: 11,
              letterSpacing: '0.22em',
              color: 'var(--ink)',
              fontWeight: 700,
            }}
          >
            {meta.label}
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
              color: 'var(--ink-dim)',
              marginTop: 2,
            }}
          >
            {meta.purpose}
          </div>
        </div>
        <span style={statusPillStyle(statusColor)}>{statusLabel}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <input
          ref={inputRef}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          name={`sunny-${meta.id}-key-entry`}
          placeholder={meta.placeholder}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={() => {
            // Hint: collapse accidental trailing whitespace right after a paste.
            window.requestAnimationFrame(() => {
              setDraft(d => d.replace(/^\s+|\s+$/g, ''));
            });
          }}
          style={{
            ...inputStyle,
            flex: 1,
            fontFamily: 'var(--mono)',
            letterSpacing: '0.04em',
          }}
          aria-label={`${meta.label} API key`}
          disabled={!isTauri || state.kind === 'saving'}
        />
        <button
          type="button"
          style={{ ...chipBase, padding: '6px 10px', fontSize: 10 }}
          onClick={() => setReveal(r => !r)}
          title={reveal ? 'Hide' : 'Reveal'}
          disabled={!isTauri}
        >
          {reveal ? 'HIDE' : 'SHOW'}
        </button>
        <button
          type="button"
          style={{ ...primaryBtnStyle, padding: '6px 12px' }}
          onClick={() => void save()}
          disabled={!isTauri || draft.trim().length === 0 || state.kind === 'saving'}
        >
          SAVE
        </button>
        <button
          type="button"
          style={{ ...chipBase, padding: '6px 10px', fontSize: 10 }}
          onClick={onVerify}
          disabled={!isTauri || verifying || present !== true}
          title="Hit the provider's auth endpoint with the stored key to confirm it works"
        >
          {verifying ? 'TESTING…' : 'TEST'}
        </button>
        <button
          type="button"
          style={{ ...dangerBtnStyle, padding: '6px 10px', fontSize: 10 }}
          onClick={() => void clear()}
          disabled={!isTauri || state.kind === 'saving' || present === false}
          title="Delete the Keychain entry (env-var overrides still apply)"
        >
          CLEAR
        </button>
      </div>

      {state.kind === 'error' && (
        <div style={keyErrorStyle}>{state.message}</div>
      )}

      {verifyResult && (
        <VerifyBadge result={verifyResult} />
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          marginTop: 6,
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
        }}
      >
        <span>
          env:{' '}
          {meta.envNames.map((n, i) => (
            <span key={n}>
              <code style={codeStyle}>{n}</code>
              {i < meta.envNames.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
        <span>
          keychain: <code style={codeStyle}>{meta.keychainService}</code>
        </span>
        <button
          type="button"
          onClick={openDocs}
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: 'var(--cyan)',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          open dashboard ↗
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VerifyBadge — render the outcome of a single `secret_verify` call
// ---------------------------------------------------------------------------

function VerifyBadge({ result }: { readonly result: VerifyResult }): JSX.Element {
  const color = CATEGORY_COLOR[result.category] ?? 'var(--ink-dim)';
  const label = CATEGORY_LABEL[result.category] ?? result.category.toUpperCase();
  const latencyText =
    result.latency_ms > 0 ? ` · ${result.latency_ms} ms` : '';
  const statusText =
    result.status !== null ? ` · HTTP ${result.status}` : '';

  return (
    <div
      style={{
        marginTop: 8,
        padding: '8px 10px',
        border: `1px solid ${color}`,
        background: 'rgba(0, 0, 0, 0.25)',
        display: 'grid',
        gap: 4,
      }}
      role="status"
      aria-live="polite"
    >
      <div
        style={{
          fontFamily: 'var(--display)',
          fontSize: 10,
          letterSpacing: '0.22em',
          color,
          fontWeight: 700,
        }}
      >
        {label}{statusText}{latencyText}
      </div>
      {result.message && (
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImportSummary — one row per provider after an env → Keychain sweep
// ---------------------------------------------------------------------------

type ImportSummaryProps = {
  readonly summary: ReadonlyArray<ImportOutcome>;
  readonly onDismiss: () => void;
};

function ImportSummary({ summary, onDismiss }: ImportSummaryProps): JSX.Element {
  const imported = summary.filter(r => r.imported).length;
  const skipped = summary.filter(r => r.already_in_keychain).length;
  const noEnv = summary.filter(r => r.env_var === null && !r.imported && !r.error).length;
  const errored = summary.filter(r => r.error.length > 0).length;

  return (
    <div
      style={{
        marginBottom: 12,
        padding: '10px 12px',
        border: '1px solid var(--line-soft)',
        background: 'rgba(4, 10, 16, 0.55)',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
      }}>
        <span style={statusPillStyle('var(--cyan)')}>IMPORT · {imported} NEW</span>
        <span style={{ ...hintStyle, marginTop: 0 }}>
          {skipped > 0 && <>{skipped} already in Keychain · </>}
          {noEnv > 0 && <>{noEnv} not in env · </>}
          {errored > 0 && <>{errored} failed</>}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onDismiss}
          style={{ ...chipBase, padding: '2px 8px', fontSize: 10 }}
        >
          DISMISS
        </button>
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {summary.map(row => (
          <ImportSummaryRow key={row.provider} row={row} />
        ))}
      </div>
    </div>
  );
}

function ImportSummaryRow({ row }: { readonly row: ImportOutcome }): JSX.Element {
  let label: string;
  let color: string;
  if (row.error.length > 0) {
    label = 'FAILED';
    color = 'var(--red)';
  } else if (row.imported) {
    label = 'IMPORTED';
    color = 'var(--cyan)';
  } else if (row.already_in_keychain) {
    label = 'SKIPPED';
    color = 'var(--ink-dim)';
  } else if (row.env_var === null) {
    label = 'NO ENV';
    color = 'var(--ink-dim)';
  } else {
    label = 'UNCHANGED';
    color = 'var(--ink-dim)';
  }

  const providerLabel =
    PROVIDERS.find(p => p.id === row.provider)?.label ?? row.provider;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, max-content) 110px 1fr',
        gap: 10,
        alignItems: 'center',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        padding: '3px 0',
      }}
    >
      <span style={{ color: 'var(--ink)' }}>{providerLabel}</span>
      <span
        style={{
          color,
          fontFamily: 'var(--display)',
          fontSize: 9.5,
          letterSpacing: '0.22em',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--ink-dim)' }}>
        {row.error.length > 0
          ? row.error
          : row.env_var
            ? `from ${row.env_var}`
            : '—'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function presetChipWrap(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: `1px solid ${active ? 'var(--cyan)' : 'var(--line-soft)'}`,
    background: active ? 'rgba(57, 229, 255, 0.12)' : 'rgba(6, 14, 22, 0.55)',
  };
}

const keyGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
  gap: 10,
};

const keyCardStyle: CSSProperties = {
  border: '1px solid var(--line-soft)',
  padding: '12px 14px',
  background: 'rgba(4, 10, 16, 0.55)',
};

const keyHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
};

const keyErrorStyle: CSSProperties = {
  marginTop: 6,
  padding: '6px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--amber)',
  border: '1px solid rgba(255, 179, 71, 0.45)',
  background: 'rgba(255, 179, 71, 0.06)',
};

const securityCalloutStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  marginBottom: 12,
  border: '1px solid rgba(57, 229, 255, 0.25)',
  background: 'rgba(57, 229, 255, 0.04)',
};

const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
};
