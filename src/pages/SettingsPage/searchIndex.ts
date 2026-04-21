// Static search index for the SettingsPage.
//
// Every entry points at a tab id and carries a bag of keywords that a
// user might type ("what's the model name", "keys", "temperature",
// "dark mode"…). Keeping the index separate from the tab components
// lets us tune it without touching any rendering code, and lets us
// surface sections that aren't yet their own React component (e.g.
// "ABOUT" lives inside AdvancedTab — the search still needs to find it).
//
// The IDs intentionally use stable, short strings — the UI renders
// them as chips, and they make good anchor/telemetry keys later.

export type SettingsTabId =
  | 'general'
  | 'models'
  | 'capabilities'
  | 'constitution'
  | 'permissions'
  | 'hotkeys'
  | 'modules'
  | 'advanced'
  | 'autopilot';

export type SearchEntry = Readonly<{
  /** Short display label shown in the search dropdown. */
  label: string;
  /** One-line description so the user can tell two near-duplicates apart. */
  description: string;
  /** Which tab to jump to on click. */
  tab: SettingsTabId;
  /** Space-separated keywords — lowercase, normalised. Space-delimited
   *  lets us match either whole-word or substring in the same haystack. */
  keywords: string;
}>;

export const SEARCH_INDEX: ReadonlyArray<SearchEntry> = [
  // GENERAL
  { label: 'OpenClaw connection',     description: 'Bridge socket status + ping test',       tab: 'general',
    keywords: 'openclaw connection bridge socket ping claw cli' },
  { label: 'Theme',                   description: 'Cyan / amber / green / violet / magenta', tab: 'general',
    keywords: 'theme color colour amber cyan green violet magenta palette dark light' },
  { label: 'Orb intensity',           description: 'HUD orb glow strength',                  tab: 'general',
    keywords: 'orb intensity glow pulse hud core brightness' },
  { label: 'Grid opacity',            description: 'Background grid visibility',             tab: 'general',
    keywords: 'grid opacity background overlay hud lines' },
  { label: 'Orb state policy',        description: 'Fixed / load / voice / focus',           tab: 'general',
    keywords: 'orb state policy fixed load voice focus mode' },
  { label: 'Voice output',            description: 'Enable / disable speech + pick engine',  tab: 'general',
    keywords: 'voice speech tts speak output british george kokoro say' },
  { label: 'Voice rate',              description: 'Words-per-minute for TTS playback',      tab: 'general',
    keywords: 'voice rate speed wpm words tts speech' },
  { label: 'Wake phrase',             description: 'Phrase that activates voice mode',       tab: 'general',
    keywords: 'wake phrase hey sunny trigger word activation' },
  { label: 'Push-to-talk',            description: 'Which key holds the mic open',           tab: 'general',
    keywords: 'push to talk ptt key space f19 microphone mic record' },
  { label: 'Voice pipeline test',     description: '2 s record → whisper → Kokoro playback', tab: 'general',
    keywords: 'voice pipeline test record transcribe whisper kokoro' },

  // MODELS
  { label: 'Provider',                description: 'OpenClaw CLI or Ollama local',           tab: 'models',
    keywords: 'provider backend openclaw ollama local llm' },
  { label: 'Model',                   description: 'Active model name',                      tab: 'models',
    keywords: 'model llm name slug claude gpt gemma llama qwen' },
  { label: 'Ollama models',           description: 'Live list of pulled Ollama models',      tab: 'models',
    keywords: 'ollama local models installed pulled llama gemma qwen deepseek' },
  { label: 'Presets',                 description: 'Save / switch provider + model combos',  tab: 'models',
    keywords: 'preset presets save combos provider model switch' },
  { label: 'Temperature',             description: 'Sampler heat (0 – 2)',                   tab: 'models',
    keywords: 'temperature heat sampler sampling determinism random' },
  { label: 'Max output tokens',       description: 'Per-turn output cap',                    tab: 'models',
    keywords: 'max tokens output length limit turn budget' },
  { label: 'Context budget',          description: 'Max history + system prompt bytes',      tab: 'models',
    keywords: 'context window budget tokens history memory pack' },
  { label: 'Tool timeout',            description: 'Wall-clock ceiling per tool call',       tab: 'models',
    keywords: 'tool timeout wall clock abort kill budget' },
  { label: 'Anthropic API key',       description: 'Claude — sk-ant-… (Keychain)',           tab: 'models',
    keywords: 'anthropic claude api key keychain secret sk-ant sonnet opus haiku' },
  { label: 'OpenAI API key',          description: 'GPT / Whisper / DALL-E / TTS',           tab: 'models',
    keywords: 'openai gpt api key whisper dalle tts voice transcribe sk-proj' },
  { label: 'OpenRouter API key',      description: 'One key → hundreds of models',           tab: 'models',
    keywords: 'openrouter router api key sk-or aggregator' },
  { label: 'Z.AI API key',            description: 'GLM / Zhipu models',                     tab: 'models',
    keywords: 'zai z.ai glm zhipu api key bigmodel' },
  { label: 'ElevenLabs API key',      description: 'Neural voices + voice cloning',          tab: 'models',
    keywords: 'elevenlabs eleven labs xi api key voice tts neural clone' },
  { label: 'Wavespeed API key',       description: 'Video + image generation',               tab: 'models',
    keywords: 'wavespeed video image generation diffusion api key' },
  { label: 'Import keys from env',    description: 'Persist $ENV keys into Keychain',        tab: 'models',
    keywords: 'import env environment variable keychain bulk migrate' },
  { label: 'Auto-approve safe tools', description: 'Skip ConfirmGate for risk:low',          tab: 'models',
    keywords: 'auto approve safe tools confirm gate risk low safety' },

  // CAPABILITIES
  { label: 'Tool browser',            description: 'Every registered tool + its schema',     tab: 'capabilities',
    keywords: 'tool browser registry schema json try run list available' },
  { label: 'Skills',                  description: 'Loaded skill manifests',                 tab: 'capabilities',
    keywords: 'skill manifest skill pack procedural library' },
  { label: 'Try tool',                description: 'Run zero-argument safe tools inline',    tab: 'capabilities',
    keywords: 'try run tool inline test sandbox zero param' },

  // CONSTITUTION
  { label: 'Identity',                description: 'Name, voice descriptor, operator',       tab: 'constitution',
    keywords: 'identity name voice operator constitution agent persona' },
  { label: 'Values',                  description: 'Soft principles the LLM honours',        tab: 'constitution',
    keywords: 'values principles constitution guidelines ethics' },
  { label: 'Prohibitions',            description: 'Hard rules enforced at tool-call gate',  tab: 'constitution',
    keywords: 'prohibition rule block ban deny restrict prohibit' },
  { label: 'Hour window rules',       description: 'Time-bounded prohibitions',              tab: 'constitution',
    keywords: 'hour window time night quiet do not disturb policy' },

  // PERMISSIONS
  { label: 'Screen recording',        description: 'macOS screen-capture grant',             tab: 'permissions',
    keywords: 'screen recording capture tcc permission macos privacy' },
  { label: 'Accessibility',           description: 'macOS AX tree + input synthesis grant',  tab: 'permissions',
    keywords: 'accessibility ax tcc permission macos privacy mouse keyboard' },
  { label: 'Automation',              description: 'AppleScript / System Events grant',      tab: 'permissions',
    keywords: 'automation applescript system events tcc permission macos' },
  { label: 'Reset TCC',               description: 'Wipe SUNNY\'s TCC allow-list',            tab: 'permissions',
    keywords: 'reset tcc tccutil permission revoke clean prompt again' },

  // HOTKEYS
  { label: 'Keyboard shortcuts',      description: 'Global hotkey reference',                tab: 'hotkeys',
    keywords: 'hotkey keyboard shortcut reference cheatsheet help cmd' },
  { label: 'Push-to-talk key',        description: 'Rebind Space ↔ F19',                     tab: 'hotkeys',
    keywords: 'push to talk ptt rebind space f19 voice hotkey' },

  // MODULES — per-page knobs consumed by the 30+ module pages.
  { label: 'Live refresh',            description: 'Master toggle for module-page polling',   tab: 'modules',
    keywords: 'live refresh poll polling background module auto update cadence off on battery' },
  { label: 'Refresh tier',            description: 'Slow · balanced · fast — poll-rate scale', tab: 'modules',
    keywords: 'refresh tier rate speed slow balanced fast cadence interval poll today brain world dashboard' },
  { label: 'AI actions on pages',     description: 'Toggle Ask-Sunny buttons across modules',  tab: 'modules',
    keywords: 'ai module actions ask sunny triage digest brief summarize expand buttons inbox journal people notes reading inspector' },
  { label: 'Timeline fetch cap',      description: 'Episodic rows loaded per day scrub',      tab: 'modules',
    keywords: 'timeline fetch cap limit episodic memory scrubber rows dots hourly core' },
  { label: 'Focus default length',    description: 'Pomodoro / flow / deep / sprint minutes',  tab: 'modules',
    keywords: 'focus default minutes session length pomodoro 25 45 60 90 timer life flow deep sprint' },
  { label: 'Journal fetch cap',       description: 'Episodic rows grouped by day',            tab: 'modules',
    keywords: 'journal fetch cap limit episodic memory rows day digest patterns life' },
  { label: 'People · warm threshold', description: 'Days since last contact → warm',          tab: 'modules',
    keywords: 'people warm days threshold crm warmth chat message last contact freshness comms' },
  { label: 'People · cold threshold', description: 'Days since last contact → cold',          tab: 'modules',
    keywords: 'people cold days threshold crm warmth chat message stale cooling comms cold' },
  { label: 'Notify feed cap',         description: 'Max notifications retained locally',      tab: 'modules',
    keywords: 'notify notification feed cap log size history local storage comms retention' },
  { label: 'Photos roots',            description: 'Desktop · Screenshots · Downloads',       tab: 'modules',
    keywords: 'photos roots screenshots downloads desktop fs search picture image know folders directories' },
  { label: 'Reading default tab',     description: 'Queue · reading · done on open',          tab: 'modules',
    keywords: 'reading default tab queue now done list state first open know' },
  { label: 'Code repo root',          description: 'Default git-discovery path (~/code)',     tab: 'modules',
    keywords: 'code repo root directory git scan discovery find path projects src do' },
  { label: 'Inspector OCR cap',       description: 'Max chars of screen text sent to LLM',    tab: 'modules',
    keywords: 'inspector ocr cap limit characters screen text ask sunny vision accessibility ai sys' },
  { label: 'Audit — only errors',     description: 'Default AUDIT to failure-only view',      tab: 'modules',
    keywords: 'audit errors only failures tool usage filter default ai sys dangerous red' },

  // ADVANCED
  { label: 'Storage paths',           description: 'Where SUNNY persists data',               tab: 'advanced',
    keywords: 'storage path directory folder location settings constitution memory vault browser sqlite' },
  { label: 'Reduced motion',          description: 'Disable transitions and orb pulse',      tab: 'advanced',
    keywords: 'reduced motion accessibility a11y animation transition pulse vestibular' },
  { label: 'Compact mode',            description: 'Tighter padding for small screens',      tab: 'advanced',
    keywords: 'compact mode dense small screen laptop 13 inch padding tight' },
  { label: 'Diagnostics',             description: 'Memory, consolidator, retention stats',  tab: 'advanced',
    keywords: 'diagnostic stats debug telemetry memory consolidator retention report' },
  { label: 'Export settings',         description: 'Download a JSON snapshot (no secrets)',  tab: 'advanced',
    keywords: 'export backup download snapshot settings json' },
  { label: 'Import settings',         description: 'Restore from JSON snapshot',             tab: 'advanced',
    keywords: 'import restore upload snapshot settings json backup' },
  { label: 'Reset to defaults',       description: 'Wipe settings.json and reload',          tab: 'advanced',
    keywords: 'reset default factory wipe clear remove blank' },
  { label: 'About',                   description: 'Version, runtime, paths',                tab: 'advanced',
    keywords: 'about version build runtime frontend backend info credits' },
  // AUTOPILOT
  { label: 'Autopilot enabled',        description: 'Master toggle for Autopilot mode',           tab: 'autopilot',
    keywords: 'autopilot enabled auto pilot agent run background' },
  { label: 'Voice speak',              description: 'Speak autopilot results aloud (experimental)', tab: 'autopilot',
    keywords: 'voice speak tts autopilot output experimental audio' },
  { label: 'Calm mode',                description: 'Reduce notifications during Autopilot',       tab: 'autopilot',
    keywords: 'calm mode quiet silent do not disturb autopilot focus' },
  { label: 'Daily cost cap',           description: 'Hard ceiling on AI spend per day',            tab: 'autopilot',
    keywords: 'daily cost cap spend budget limit dollar billing autopilot' },
  { label: 'Wake word',                description: 'Hands-free activation via spoken phrase',     tab: 'autopilot',
    keywords: 'wake word activation phrase listening idle voice trigger' },
  { label: 'Wake word confidence',     description: 'Detection threshold 0.5–0.95',               tab: 'autopilot',
    keywords: 'wake word confidence threshold sensitivity detection false positive' },
  { label: 'Trust level',              description: 'Confirm All / Smart / Autonomous',            tab: 'autopilot',
    keywords: 'trust level confirm all smart autonomous approve gate risk safety' },
  { label: 'Warm context',             description: 'Pre-load recent sessions at startup',         tab: 'autopilot',
    keywords: 'warm context continuity preload session history memory startup' },
  { label: 'Sessions to preload',      description: 'Number of prior sessions in context (1–10)', tab: 'autopilot',
    keywords: 'sessions preload context continuity history memory count number' },
  { label: 'Prefer local provider',    description: 'Route to Ollama before cloud fallback',       tab: 'autopilot',
    keywords: 'prefer local provider ollama cloud fallback route model' },
  { label: 'GLM daily cap',            description: 'GLM / Zhipu spending ceiling per day',        tab: 'autopilot',
    keywords: 'glm daily cap zhipu z.ai spend billing budget dollar' },
  { label: 'TTS voice',                description: 'Kokoro voice accent / speaker',               tab: 'autopilot',
    keywords: 'tts voice kokoro british american australian scottish irish accent speaker' },
  { label: 'TTS speed',                description: 'Playback speed multiplier (0.5×–2.0×)',       tab: 'autopilot',
    keywords: 'tts speed rate multiplier fast slow playback voice' },
  { label: 'STT model',                description: 'Whisper variant for speech-to-text',          tab: 'autopilot',
    keywords: 'stt model whisper small medium transcribe speech recognition' },

];

// ---------------------------------------------------------------------------
// Query engine
// ---------------------------------------------------------------------------

/**
 * Rank entries against the query. Higher is better. Returns the first
 * `limit` non-zero matches, or an empty list if nothing meets the
 * scoring threshold.
 *
 * Scoring is intentionally simple — we don't ship a full fuzzy search
 * library for ~50 entries. Exact substring in the label wins; partial
 * match in the keyword bag is a strong signal; word-initial matches
 * ("ptt" → "push to talk") get a small bonus so common abbreviations
 * still surface.
 */
export function searchSettings(query: string, limit = 8): ReadonlyArray<SearchEntry> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  type Scored = { readonly score: number; readonly entry: SearchEntry };
  const scored: Scored[] = [];

  for (const entry of SEARCH_INDEX) {
    const label = entry.label.toLowerCase();
    const desc = entry.description.toLowerCase();
    const keywords = entry.keywords.toLowerCase();
    let score = 0;

    if (label === q) score += 100;
    else if (label.startsWith(q)) score += 60;
    else if (label.includes(q)) score += 40;

    if (desc.includes(q)) score += 20;

    if (keywords.includes(q)) score += 30;

    // Abbreviation match — "ptt" against the initials of
    // "push to talk".
    if (q.length >= 2 && q.length <= 5) {
      const initials = keywords
        .split(/\s+/)
        .map(w => w.charAt(0))
        .join('');
      if (initials.includes(q)) score += 15;
    }

    if (score > 0) scored.push({ score, entry });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.entry);
}
