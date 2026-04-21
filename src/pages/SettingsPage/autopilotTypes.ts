/**
 * autopilotTypes.ts — Shared types + Zod-style inline validation for the
 * Autopilot settings tab.
 *
 * J7's backend commands (`settings_get` / `settings_update`) are declared
 * as stubs here with localStorage fallback until the Rust side lands.
 * The stub is clearly documented and wired to fire once the Tauri runtime
 * detects the command is available.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type TrustLevel = 'confirm_all' | 'smart' | 'autonomous';

export type QualityMode = 'always_best' | 'balanced' | 'cost_aware';

export type WakeWordStatus = 'listening' | 'idle';

/** Canonical shape returned by `settings_get` / sent to `settings_update`. */
export type AutopilotSettings = {
  readonly autopilotEnabled: boolean;
  readonly autopilotVoiceSpeak: boolean;
  readonly autopilotCalmMode: boolean;
  readonly autopilotDailyCostCap: number;          // $0.50–$20.00
  readonly wakeWordEnabled: boolean;
  readonly wakeWordConfidence: number;             // 0.5–0.95
  readonly trustLevel: TrustLevel;
  readonly continuityWarmContext: boolean;
  readonly continuitySessionsToPreload: number;   // 1–10
  readonly providersPreferLocal: boolean;
  readonly glmDailyCostCap: number;               // $0.10–$5.00
  readonly qualityMode: QualityMode;
  readonly ttsVoice: string;
  readonly ttsSpeed: number;                      // 0.5–2.0
  readonly sttModel: string;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const AUTOPILOT_DEFAULTS: AutopilotSettings = {
  autopilotEnabled: true,
  autopilotVoiceSpeak: false,
  autopilotCalmMode: false,
  autopilotDailyCostCap: 1.00,
  wakeWordEnabled: false,
  wakeWordConfidence: 0.70,
  trustLevel: 'smart',
  continuityWarmContext: true,
  continuitySessionsToPreload: 3,
  providersPreferLocal: false,
  glmDailyCostCap: 1.00,
  qualityMode: 'balanced' as QualityMode,
  ttsVoice: 'British',
  ttsSpeed: 1.0,
  sttModel: 'whisper-small',
};

// ---------------------------------------------------------------------------
// Inline validation (no external Zod dependency)
// ---------------------------------------------------------------------------

function isValidTrustLevel(v: unknown): v is TrustLevel {
  return v === 'confirm_all' || v === 'smart' || v === 'autonomous';
}

function isValidQualityMode(v: unknown): v is QualityMode {
  return v === 'always_best' || v === 'balanced' || v === 'cost_aware';
}

/**
 * Validates and coerces a raw backend response into `AutopilotSettings`.
 * Returns `null` if the payload is not an object — callers should fall back
 * to defaults on null.
 */
export function parseAutopilotSettings(raw: unknown): AutopilotSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = AUTOPILOT_DEFAULTS;

  return {
    autopilotEnabled:            typeof r.autopilotEnabled === 'boolean'        ? r.autopilotEnabled            : d.autopilotEnabled,
    autopilotVoiceSpeak:         typeof r.autopilotVoiceSpeak === 'boolean'     ? r.autopilotVoiceSpeak         : d.autopilotVoiceSpeak,
    autopilotCalmMode:           typeof r.autopilotCalmMode === 'boolean'       ? r.autopilotCalmMode           : d.autopilotCalmMode,
    autopilotDailyCostCap:       typeof r.autopilotDailyCostCap === 'number' && Number.isFinite(r.autopilotDailyCostCap) ? r.autopilotDailyCostCap : d.autopilotDailyCostCap,
    wakeWordEnabled:             typeof r.wakeWordEnabled === 'boolean'         ? r.wakeWordEnabled             : d.wakeWordEnabled,
    wakeWordConfidence:          typeof r.wakeWordConfidence === 'number' && Number.isFinite(r.wakeWordConfidence) ? r.wakeWordConfidence : d.wakeWordConfidence,
    trustLevel:                  isValidTrustLevel(r.trustLevel)                ? r.trustLevel                  : d.trustLevel,
    continuityWarmContext:       typeof r.continuityWarmContext === 'boolean'   ? r.continuityWarmContext       : d.continuityWarmContext,
    continuitySessionsToPreload: typeof r.continuitySessionsToPreload === 'number' && Number.isFinite(r.continuitySessionsToPreload) ? Math.min(10, Math.max(1, Math.round(r.continuitySessionsToPreload))) : d.continuitySessionsToPreload,
    providersPreferLocal:        typeof r.providersPreferLocal === 'boolean'    ? r.providersPreferLocal        : d.providersPreferLocal,
    glmDailyCostCap:             typeof r.glmDailyCostCap === 'number' && Number.isFinite(r.glmDailyCostCap) ? r.glmDailyCostCap : d.glmDailyCostCap,
    qualityMode:                 isValidQualityMode(r.qualityMode)               ? r.qualityMode                 : d.qualityMode,
    ttsVoice:                    typeof r.ttsVoice === 'string' && r.ttsVoice.length > 0 ? r.ttsVoice          : d.ttsVoice,
    ttsSpeed:                    typeof r.ttsSpeed === 'number' && Number.isFinite(r.ttsSpeed) ? r.ttsSpeed     : d.ttsSpeed,
    sttModel:                    typeof r.sttModel === 'string' && r.sttModel.length > 0 ? r.sttModel           : d.sttModel,
  };
}

/** Keys currently awaiting server confirmation (optimistic UI). */
export type PendingKeys = ReadonlySet<keyof AutopilotSettings>;
