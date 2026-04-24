//! Secret resolution — reads, writes and deletes API keys via the macOS Keychain.
//!
//! # Why this exists
//!
//! A Tauri `.app` launched from Finder / Dock inherits only the `launchd`
//! user environment — it does NOT source `~/.zshenv` / `~/.zshrc`. So a
//! plain `export ANTHROPIC_API_KEY=...` in the user's shell profile is
//! invisible to `std::env::var` inside Sunny.app, and the agent loop silently
//! falls back to whatever local backend is available.
//!
//! This module gives the rest of the crate a single, async-friendly entry
//! point that:
//!
//!   1. Honors whatever is already in the process environment (respects
//!      `cargo tauri dev`, `launchctl setenv`, CI, Docker, etc.).
//!   2. Falls back to reading the key straight out of the macOS Keychain
//!      via `/usr/bin/security find-generic-password`.
//!   3. Lets the Settings → MODELS tab write/delete the Keychain entry
//!      through `secret_set` / `secret_delete` Tauri commands without ever
//!      round-tripping the key material anywhere else.
//!
//! # Security
//!
//! - Keys never touch `localStorage`, `settings.json`, or any log line.
//! - The IPC surface returns only **presence booleans**; the actual key
//!   stays in the Keychain, protected by the user's login keychain ACL.
//! - `security` is invoked with `-w <password>` which is briefly visible
//!   in `ps` to the *same* user. For a personal HUD on a single-user Mac
//!   this is the same tradeoff the install scripts already make. If you
//!   need iron-clad handling, write the key via
//!   `scripts/install-anthropic-key.sh` from your own shell and leave the
//!   in-app writer alone.
//!
//! # Setup
//!
//! ```sh
//! scripts/install-anthropic-key.sh sk-ant-...
//! ```
//!
//! Or, in-app, paste into Settings → MODELS → API KEYS → SAVE.
//!
//! Zero new crate deps — we already use `tokio::process::Command` across the
//! codebase.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::RwLock;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/// Machine-readable identifier for the six providers we stash keys for.
///
/// Kept as a flat string enum because it crosses the Tauri IPC boundary
/// into the webview — `#[serde(rename_all = "snake_case")]` maps to
/// stable wire-compatible identifiers the React side can use as map keys.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    Anthropic,
    Zai,
    Moonshot,
    OpenAi,
    OpenRouter,
    ElevenLabs,
    Wavespeed,
}

impl SecretKind {
    /// Parse from the snake_case id used on the IPC wire. Returns `None`
    /// for unknown strings; commands surface that as a structured error
    /// instead of panicking so a malformed webview call can't crash Rust.
    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "anthropic"   => Some(Self::Anthropic),
            "zai"         => Some(Self::Zai),
            "moonshot"    => Some(Self::Moonshot),
            "openai"      => Some(Self::OpenAi),
            "openrouter"  => Some(Self::OpenRouter),
            "elevenlabs"  => Some(Self::ElevenLabs),
            "wavespeed"   => Some(Self::Wavespeed),
            _ => None,
        }
    }

    /// The Keychain `service` attribute for this provider. We namespace
    /// every entry under `sunny-<provider>-api-key` so external tools can
    /// see at a glance which entries belong to SUNNY.
    pub fn keychain_service(&self) -> &'static str {
        match self {
            Self::Anthropic  => "sunny-anthropic-api-key",
            Self::Zai        => "sunny-zai-api-key",
            Self::Moonshot   => "sunny-moonshot-api-key",
            Self::OpenAi     => "sunny-openai-api-key",
            Self::OpenRouter => "sunny-openrouter-api-key",
            Self::ElevenLabs => "sunny-elevenlabs-api-key",
            Self::Wavespeed  => "sunny-wavespeed-api-key",
        }
    }

    /// Environment-variable aliases checked **before** the Keychain. The
    /// first non-empty match wins. Multiple aliases accommodate providers
    /// with inconsistent naming conventions (Z.AI / GLM / Zhipu, XI /
    /// ElevenLabs, …).
    pub fn env_vars(&self) -> &'static [&'static str] {
        match self {
            Self::Anthropic  => &["ANTHROPIC_API_KEY"],
            Self::Zai        => &["ZAI_API_KEY", "ZHIPU_API_KEY", "GLM_API_KEY"],
            Self::Moonshot   => &["MOONSHOT_API_KEY", "KIMI_API_KEY"],
            Self::OpenAi     => &["OPENAI_API_KEY"],
            Self::OpenRouter => &["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"],
            Self::ElevenLabs => &["ELEVENLABS_API_KEY", "XI_API_KEY"],
            Self::Wavespeed  => &["WAVESPEED_API_KEY", "WAVESPEED_AI_API_KEY"],
        }
    }

    /// Loose sanity check so we never write a value that's obviously not
    /// a key. Stops accidents like pasting the README text in. Exact
    /// prefix rules are intentionally conservative — most of these APIs
    /// don't publish a stable prefix.
    pub fn looks_plausible(&self, raw: &str) -> bool {
        let v = raw.trim();
        if v.len() < 8 || v.len() > 512 { return false; }
        // Reject whitespace / control chars inside the value.
        if v.chars().any(|c| c.is_control() || c == '\n' || c == '\r') { return false; }
        match self {
            // Anthropic keys start with `sk-ant-`.
            Self::Anthropic  => v.starts_with("sk-") || v.starts_with("anthropic-"),
            // OpenAI keys start with `sk-` (including project keys `sk-proj-`).
            Self::OpenAi     => v.starts_with("sk-"),
            // OpenRouter keys start with `sk-or-`.
            Self::OpenRouter => v.starts_with("sk-or-") || v.starts_with("sk-"),
            // Moonshot (Kimi) keys typically start with "sk-" like OpenAI.
            Self::Moonshot   => v.starts_with("sk-"),
            // Z.AI / GLM / ElevenLabs / Wavespeed don't publish a
            // stable prefix, so we just trust the length + non-control
            // check above.
            Self::Zai | Self::ElevenLabs | Self::Wavespeed => true,
        }
    }
}

/// Public status snapshot returned by the `secrets_status` command. One
/// boolean per provider — we intentionally do NOT return the key body.
#[derive(Serialize, Debug, Clone, Copy, Default, TS)]
#[ts(export)]
pub struct SecretsStatus {
    pub anthropic:   bool,
    pub zai:         bool,
    pub moonshot:    bool,
    pub openai:      bool,
    pub openrouter:  bool,
    pub elevenlabs:  bool,
    pub wavespeed:   bool,
}

/// Outcome of a real-world API ping for one provider. `ok` is the
/// authoritative "yes the key works" signal — `SecretsStatus.*` only
/// proves the Keychain holds a value, not that the value is valid.
#[derive(Serialize, Debug, Clone, TS)]
#[ts(export)]
pub struct VerifyResult {
    /// Provider id (snake_case, matches `SecretKind::from_id`).
    pub provider: String,
    /// True only on a 2xx response from the provider's minimal endpoint.
    pub ok: bool,
    /// HTTP status if the probe completed; None on DNS/TLS/timeout errors.
    #[ts(type = "number | null")]
    pub status: Option<u16>,
    /// Short categorical label used for the UI pill ("ok", "invalid_key",
    /// "rate_limited", "network", "server", "missing"). Always
    /// machine-parseable; never contains user-controlled strings.
    pub category: &'static str,
    /// Human-readable detail for the error, sanitized to never include
    /// the key itself.
    pub message: String,
    /// Round-trip time for the probe in milliseconds.
    #[ts(type = "number")]
    pub latency_ms: u32,
}

/// Outcome of `secret_import_env` — one row per provider, describing
/// whether we found an env-set value and whether we wrote it to Keychain.
#[derive(Serialize, Debug, Clone)]
pub struct ImportOutcome {
    pub provider: String,
    /// Which env var we found a non-empty value under (None = nothing found).
    pub env_var: Option<String>,
    /// Whether the value already matched the Keychain entry (skipped).
    pub already_in_keychain: bool,
    /// Whether we actually wrote the value into Keychain this call.
    pub imported: bool,
    /// If the write failed, the sanitized reason; empty string on success
    /// or when there was nothing to do.
    pub error: String,
}

// ---------------------------------------------------------------------------
// Typed getters (used across the crate)
// ---------------------------------------------------------------------------

pub async fn anthropic_api_key()   -> Option<String> { resolve(SecretKind::Anthropic).await }
pub async fn zai_api_key()         -> Option<String> { resolve(SecretKind::Zai).await }
pub async fn moonshot_api_key()    -> Option<String> { resolve(SecretKind::Moonshot).await }
pub async fn openai_api_key()      -> Option<String> { resolve(SecretKind::OpenAi).await }
pub async fn openrouter_api_key()  -> Option<String> { resolve(SecretKind::OpenRouter).await }
pub async fn elevenlabs_api_key()  -> Option<String> { resolve(SecretKind::ElevenLabs).await }
pub async fn wavespeed_api_key()   -> Option<String> { resolve(SecretKind::Wavespeed).await }

// ---------------------------------------------------------------------------
// Process-level key-presence cache
// ---------------------------------------------------------------------------
//
// `anthropic_key_present` / `zai_key_present` / `moonshot_key_present` (in
// `agent_loop/providers/auth.rs`) are called at the top of `pick_backend`
// on every turn the session cache misses. Under the hood each one calls
// `resolve` → `keychain_find` → spawns `/usr/bin/security
// find-generic-password`. The subprocess spawn costs 50-150 ms on macOS
// cold, and the first-turn `tokio::join!` in `pick_backend` fires two of
// them in parallel — but every subsequent *miss* (new `session_id`, or a
// mid-session provider flip hitting a fresh cache bucket) still pays the
// spawn cost.
//
// Process-level memoisation collapses every subsequent call for the same
// `SecretKind` to a `HashMap` lookup. The presence bit is stable across
// a process lifetime except when the user writes/deletes a key through
// Settings — `keychain_set` and `keychain_delete` below call
// `invalidate_key_presence` to drop the stale bit, so the next probe
// re-runs the subprocess and the UI pill flips immediately.
//
// Trade-off: if the user edits their Keychain with `/usr/bin/security`
// or Keychain Access directly (bypassing the Settings UI), this cache
// will return stale `present: true` / `false` until the next app
// restart. That's an acceptable rarity — Settings is the documented
// path, and a stale "present" only results in one failed API call at
// most before the real subprocess re-resolves on the `resolve()` side.

type KeyPresenceMap = HashMap<SecretKind, bool>;

fn key_presence_cache() -> &'static RwLock<KeyPresenceMap> {
    static CACHE: OnceLock<RwLock<KeyPresenceMap>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Return whether a key for `kind` is currently reachable (env or
/// Keychain), using a process-level cache to avoid re-spawning the
/// `security` subprocess on every call.
///
/// The first call for a given `kind` runs the full `resolve` path
/// (50-150 ms subprocess on macOS cold); subsequent calls return in
/// microseconds from the in-memory map. Invalidation is automatic on
/// `keychain_set` / `keychain_delete` — any other path that mutates
/// the Keychain (e.g. a user running `/usr/bin/security` directly)
/// will read a stale value until process restart.
pub async fn key_present_cached(kind: SecretKind) -> bool {
    // Fast path: read lock, check for a cached answer.
    {
        let guard = key_presence_cache().read().await;
        if let Some(&present) = guard.get(&kind) {
            return present;
        }
    }

    // Miss — resolve through the env/Keychain path.
    let present = resolve(kind)
        .await
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    // Write lock to memoise. Double-check under the lock so a racing
    // resolver doesn't silently overwrite a fresh answer from a
    // parallel caller (both would compute the same bit anyway, so this
    // is more about keeping the map consistent than correctness).
    let mut guard = key_presence_cache().write().await;
    guard.entry(kind).or_insert(present);
    present
}

/// Drop the cached presence bit for `kind`. Called internally by
/// `keychain_set` and `keychain_delete` so the next probe re-resolves.
/// Safe to call when the entry is absent.
pub async fn invalidate_key_presence(kind: SecretKind) {
    let mut guard = key_presence_cache().write().await;
    guard.remove(&kind);
}

/// Drop every cached presence bit. Used by the bulk env-import path —
/// one call is cheaper than seven `invalidate_key_presence` hops when
/// several providers might have flipped in the same pass.
pub async fn invalidate_all_key_presence() {
    let mut guard = key_presence_cache().write().await;
    guard.clear();
}

// ---------------------------------------------------------------------------
// Core resolve / set / delete
// ---------------------------------------------------------------------------

/// Resolve a single secret. Env first (respects CI and launchctl overrides),
/// Keychain second. Trims whitespace so a user who pastes a trailing
/// newline into their shell profile doesn't get an invisible "bad key".
///
/// Also emits a `SecurityEvent::SecretRead` (without the value) so the
/// Security module's audit log records every access — an agent
/// reaching for a provider key is a high-signal event on its own,
/// regardless of whether the key actually exists.
pub async fn resolve(kind: SecretKind) -> Option<String> {
    let provider_id = format!("{kind:?}").to_lowercase();
    for var in kind.env_vars() {
        if let Ok(v) = std::env::var(var) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                emit_secret_read(&provider_id, "env");
                return Some(trimmed.to_string());
            }
        }
    }
    let found = keychain_find(kind.keychain_service()).await;
    if found.is_some() {
        emit_secret_read(&provider_id, "keychain");
    }
    found
}

fn emit_secret_read(provider: &str, caller: &str) {
    crate::security::emit(crate::security::SecurityEvent::SecretRead {
        at: crate::security::now(),
        provider: provider.to_string(),
        caller: caller.to_string(),
    });
}

/// Probe every known provider — used by the Settings MODELS tab to light
/// up the "REACHABLE / MISSING" pills. No key material leaves Rust.
pub async fn status_all() -> SecretsStatus {
    let (anthropic, zai, moonshot, openai, openrouter, elevenlabs, wavespeed) = tokio::join!(
        anthropic_api_key(),
        zai_api_key(),
        moonshot_api_key(),
        openai_api_key(),
        openrouter_api_key(),
        elevenlabs_api_key(),
        wavespeed_api_key(),
    );
    SecretsStatus {
        anthropic:  anthropic.is_some(),
        zai:        zai.is_some(),
        moonshot:   moonshot.is_some(),
        openai:     openai.is_some(),
        openrouter: openrouter.is_some(),
        elevenlabs: elevenlabs.is_some(),
        wavespeed:  wavespeed.is_some(),
    }
}

/// Write a key to the login Keychain under the provider-specific service
/// name. Replaces any existing entry atomically via `-U`.
///
/// Rejects plausibly-malformed input (too short, wrong prefix, embedded
/// control chars) before spawning anything. If validation fails the error
/// message only references the provider id — the candidate key body is
/// never echoed back.
pub async fn keychain_set(kind: SecretKind, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if !kind.looks_plausible(trimmed) {
        return Err(format!(
            "value does not look like a valid {} API key (length or format check failed)",
            match kind {
                SecretKind::Anthropic   => "Anthropic",
                SecretKind::Zai         => "Z.AI / GLM",
                SecretKind::Moonshot    => "Moonshot / Kimi",
                SecretKind::OpenAi      => "OpenAI",
                SecretKind::OpenRouter  => "OpenRouter",
                SecretKind::ElevenLabs  => "ElevenLabs",
                SecretKind::Wavespeed   => "Wavespeed",
            }
        ));
    }

    let user = std::env::var("USER").unwrap_or_else(|_| "sunny".to_string());
    let service = kind.keychain_service();

    // Step 1 — delete any existing entry so stale ACLs don't wedge the
    // -U update. Errors here are non-fatal (entry may not exist yet).
    let _ = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-a", &user, "-s", service])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;

    // Step 2 — route through stdin so the key is never visible in `ps`.
    let result = keychain_set_via_stdin(kind, trimmed).await;

    // Invalidate the process-level presence cache regardless of
    // outcome: on success the bit should flip true; on failure the
    // prior bit may be stale (delete-then-fail leaves no entry). The
    // next `key_present_cached` call will re-resolve.
    invalidate_key_presence(kind).await;

    result
}

/// Remove a Keychain entry for the given provider. Missing entries are
/// treated as success — the post-condition is "no entry exists", and
/// that's already met.
pub async fn keychain_delete(kind: SecretKind) -> Result<(), String> {
    let user = std::env::var("USER").unwrap_or_else(|_| "sunny".to_string());
    let service = kind.keychain_service();
    let status = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-a", &user, "-s", service])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawn security: {e}"))?;
    // Exit 44 = "item not found" — that's fine, idempotent delete.
    if status.success() || status.code() == Some(44) {
        // Drop the cached presence bit so the next probe sees the
        // deletion immediately rather than reporting stale `true`.
        invalidate_key_presence(kind).await;
        Ok(())
    } else {
        Err(format!(
            "security delete-generic-password failed (exit {})",
            status.code().unwrap_or(-1)
        ))
    }
}

/// Shell out to `/usr/bin/security` and read a generic-password entry by
/// service name. Returns `None` on any failure (tool missing, no entry,
/// non-UTF8, empty value, etc.) — callers treat "no key" as a normal,
/// recoverable state.
async fn keychain_find(service: &str) -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

// ---------------------------------------------------------------------------
// Stdin-piping writer — key bytes are piped to the security binary, not
// passed as argv where they would be visible in `ps`. `security
// add-generic-password` reads the password from stdin when `-w` is absent
// and stdin is not a tty.
// ---------------------------------------------------------------------------
async fn keychain_set_via_stdin(kind: SecretKind, value: &str) -> Result<(), String> {
    let user = std::env::var("USER").unwrap_or_else(|_| "sunny".to_string());
    let service = kind.keychain_service();

    let mut child = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-a", &user,
            "-s", service,
            "-U",
            "-D", "SUNNY API key",
            "-j", &format!("Created by SUNNY HUD for provider {:?}", kind),
            // `-w` is deliberately absent — password is fed via stdin below.
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn security: {e}"))?;

    // Write `<key>\n` then close stdin explicitly so the child sees EOF.
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(|e| format!("write key to security stdin: {e}"))?;

    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait security: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let redacted = stderr.replace(value, "***");
        return Err(format!(
            "security add-generic-password failed (exit {}): {}",
            out.status.code().unwrap_or(-1),
            redacted.trim(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Provider probes — "does this key actually work?"
// ---------------------------------------------------------------------------
//
// The Settings → MODELS tab needs to answer "is my key valid" not just
// "did I write something into Keychain". We hit each provider's cheapest
// authenticated endpoint and classify the response into a stable set of
// categories the UI uses to light up pills.
//
// Design constraints:
//   * No external crate — reuses the shared reqwest client.
//   * 8 s hard cap; callers always get an answer or a "network" category.
//   * The raw key never appears in the response body or the error message.
//   * Endpoints are GET-only so we can't accidentally charge the user.

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Description of how to authenticate against each provider's probe
/// endpoint. Centralised so `probe_endpoint` stays short and adding a
/// new provider is a one-line addition.
fn probe_endpoint(kind: SecretKind) -> (&'static str, &'static str, &'static str) {
    // (url, header_name, header_value_prefix)
    match kind {
        // Anthropic — /v1/models requires x-api-key + anthropic-version.
        // The probe uses both via a custom header injection below; we
        // return a sentinel here and special-case the call.
        SecretKind::Anthropic => ("https://api.anthropic.com/v1/models", "x-api-key", ""),
        // OpenAI — /v1/models is the canonical "am I authenticated" probe.
        SecretKind::OpenAi => ("https://api.openai.com/v1/models", "authorization", "Bearer "),
        // OpenRouter — /api/v1/auth/key returns {data: {label, usage, limit}}.
        SecretKind::OpenRouter => ("https://openrouter.ai/api/v1/auth/key", "authorization", "Bearer "),
        // Z.AI / GLM — /api/paas/v4/models requires bearer auth.
        SecretKind::Zai => ("https://open.bigmodel.cn/api/paas/v4/models", "authorization", "Bearer "),
        // Moonshot / Kimi — /v1/models returns the model list for the key's org.
        SecretKind::Moonshot => ("https://api.moonshot.ai/v1/models", "authorization", "Bearer "),
        // ElevenLabs — /v1/user returns subscription + character quota.
        SecretKind::ElevenLabs => ("https://api.elevenlabs.io/v1/user", "xi-api-key", ""),
        // Wavespeed — /api/v3/me or /api/v3/credits; we pick /credits since
        // it returns a cheap JSON blob on success.
        SecretKind::Wavespeed => ("https://api.wavespeed.ai/api/v3/credits", "authorization", "Bearer "),
    }
}

fn classify_status(status: u16) -> (&'static str, &'static str) {
    // (category, short human message)
    match status {
        200..=299 => ("ok", "key works"),
        401 | 403 => ("invalid_key", "provider rejected the key"),
        404 => ("invalid_endpoint", "endpoint not found — probe out of date"),
        408 | 504 => ("timeout", "provider timed out"),
        429 => ("rate_limited", "rate-limited — key may still be valid"),
        500..=599 => ("server", "provider server error"),
        _ => ("unknown", "unexpected http status"),
    }
}

/// Hit the provider-specific probe endpoint with the stored key and return
/// a structured outcome. Caller holds a `SecretKind`; we re-resolve the
/// key here so a concurrent `keychain_set` takes effect immediately.
pub async fn verify(kind: SecretKind) -> VerifyResult {
    let provider_id = format!("{kind:?}").to_lowercase();

    let started = std::time::Instant::now();
    let Some(key) = resolve(kind).await else {
        return VerifyResult {
            provider: provider_id,
            ok: false,
            status: None,
            category: "missing",
            message: "no key stored — set one above first".into(),
            latency_ms: 0,
        };
    };

    let (url, header_name, prefix) = probe_endpoint(kind);
    let client = crate::http::client();
    let mut req = client.get(url).timeout(PROBE_TIMEOUT);

    // Anthropic demands a second header alongside `x-api-key` — their
    // API errors "missing anthropic-version" if we skip it. Everyone
    // else takes a single auth header.
    if matches!(kind, SecretKind::Anthropic) {
        req = req.header("anthropic-version", "2023-06-01");
    }
    req = req.header(header_name, format!("{prefix}{key}"));

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let elapsed = started.elapsed().as_millis() as u32;
            let sanitized = redact(&format!("{e}"), &key);
            let category: &'static str = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "network"
            } else if e.is_request() {
                "network"
            } else {
                "network"
            };
            return VerifyResult {
                provider: provider_id,
                ok: false,
                status: None,
                category,
                message: sanitized,
                latency_ms: elapsed,
            };
        }
    };

    let status_code = resp.status().as_u16();
    let (category, short) = classify_status(status_code);
    let ok = resp.status().is_success();
    let elapsed = started.elapsed().as_millis() as u32;

    // Don't read the body on success — saves bandwidth and sidesteps any
    // chance the key leaks back via an error envelope. On failure we do
    // read, trim, and redact so the user gets actionable context.
    let message = if ok {
        short.to_string()
    } else {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(180).collect();
        let trimmed = snippet.trim().to_string();
        let display = if trimmed.is_empty() { short.to_string() } else { trimmed };
        redact(&display, &key)
    };

    VerifyResult {
        provider: provider_id,
        ok,
        status: Some(status_code),
        category,
        message,
        latency_ms: elapsed,
    }
}

/// Strip any accidental echo of the key from a diagnostic string.
/// Defensive — none of our providers return the key in their error
/// bodies, but a future misconfigured gateway might.
fn redact(s: &str, key: &str) -> String {
    if key.is_empty() || s.len() < key.len() {
        return s.to_string();
    }
    s.replace(key, "***")
}

// ---------------------------------------------------------------------------
// Bulk env → Keychain import
// ---------------------------------------------------------------------------

/// Scan every provider's env-var aliases and persist any non-empty
/// values to the Keychain. Non-destructive — if the key is already in
/// the Keychain (with the same value) we skip it so repeat calls are
/// cheap.
pub async fn import_env_to_keychain() -> Vec<ImportOutcome> {
    let kinds = [
        SecretKind::Anthropic,
        SecretKind::OpenAi,
        SecretKind::OpenRouter,
        SecretKind::Zai,
        SecretKind::ElevenLabs,
        SecretKind::Wavespeed,
    ];
    let mut outcomes = Vec::with_capacity(kinds.len());

    for kind in kinds {
        let provider_id = format!("{kind:?}").to_lowercase();

        // Find the first env var that has a non-empty value for this
        // provider. We don't touch the Keychain if nothing is in env.
        let mut env_hit: Option<(String, String)> = None;
        for var in kind.env_vars() {
            if let Ok(v) = std::env::var(var) {
                let trimmed = v.trim();
                if !trimmed.is_empty() {
                    env_hit = Some((var.to_string(), trimmed.to_string()));
                    break;
                }
            }
        }

        let Some((var, value)) = env_hit else {
            outcomes.push(ImportOutcome {
                provider: provider_id,
                env_var: None,
                already_in_keychain: false,
                imported: false,
                error: String::new(),
            });
            continue;
        };

        // Skip when the existing Keychain value already matches — no
        // need to re-encrypt the same bytes. We read through
        // `keychain_find` directly to avoid the env-first branch.
        let existing = keychain_find(kind.keychain_service()).await;
        if existing.as_deref() == Some(value.as_str()) {
            outcomes.push(ImportOutcome {
                provider: provider_id,
                env_var: Some(var),
                already_in_keychain: true,
                imported: false,
                error: String::new(),
            });
            continue;
        }

        // Write — `keychain_set` runs its validator, which can legitimately
        // reject values that happen to be in env (e.g. a shell-pasted
        // "test" string). Surface the sanitized error rather than claiming
        // success.
        match keychain_set(kind, &value).await {
            Ok(()) => outcomes.push(ImportOutcome {
                provider: provider_id,
                env_var: Some(var),
                already_in_keychain: false,
                imported: true,
                error: String::new(),
            }),
            Err(e) => outcomes.push(ImportOutcome {
                provider: provider_id,
                env_var: Some(var),
                already_in_keychain: false,
                imported: false,
                error: redact(&e, &value),
            }),
        }
    }
    outcomes
}

// ---------------------------------------------------------------------------
// Auth profiles — named on-disk credential bundles for `http_request`
// ---------------------------------------------------------------------------
//
// Profiles live at `~/.sunny/secrets/<name>.json`. The file must be mode
// 0600 (user-only); we refuse to read anything looser so a misconfigured
// profile doesn't quietly ship a token to an agent tool via the inventory
// of readable files. Profile names are constrained to `[A-Za-z0-9_-]+`
// to forbid path-traversal.
//
// Schema (one of):
//   { "type": "bearer",  "token": "..." }
//   { "type": "basic",   "username": "...", "password": "..." }
//   { "type": "api_key", "header": "x-api-key", "value": "..." }
//   { "type": "custom",  "headers": { "X-A": "...", "X-B": "..." } }

use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthProfile {
    Bearer { token: String },
    Basic { username: String, password: String },
    ApiKey { header: String, value: String },
    Custom { headers: BTreeMap<String, String> },
}

/// Read an auth profile from `~/.sunny/secrets/<name>.json`. Fails
/// closed on anything that looks wrong: invalid name, missing file,
/// permissions looser than 0600, or malformed JSON. Error messages
/// never echo the file body.
pub async fn get_profile(name: &str) -> Result<AuthProfile, String> {
    // Name is constrained to the URL-safe subset so `name` cannot
    // escape the secrets directory via `..` or absolute path tricks.
    if name.is_empty()
        || name
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    {
        return Err(format!("invalid profile name `{name}`"));
    }

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".sunny")
        .join("secrets")
        .join(format!("{name}.json"));

    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("profile `{name}`: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mode = meta.mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!(
                "profile `{name}`: permissions {mode:o} too loose (want 0600)"
            ));
        }
    }
    let _ = meta;

    let body = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("profile `{name}`: {e}"))?;
    let profile: AuthProfile = serde_json::from_str(&body)
        .map_err(|_| format!("profile `{name}`: invalid JSON schema"))?;
    Ok(profile)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// The Keychain path can't be exercised hermetically in CI (it touches the
// user's login keychain and may prompt), so we only assert the pure-env
// branch and validator here. The Keychain branch is covered by manual
// smoke tests in `docs/SETUP-API-KEYS.md`.

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise every env-touching test in this module. `std::env::set_var`
    /// is not thread-safe against concurrent reads on other threads, and
    /// each test below both sets and reads the same env names — running
    /// them in parallel produces flaky "returned the Keychain value
    /// instead of the env mock" failures on machines where the user has
    /// the real Keychain entry populated. The lock holds for the full
    /// test body and is dropped automatically on unwind.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// When `ANTHROPIC_API_KEY` is set in the process env, the function must
    /// return it verbatim without invoking `security`.
    #[tokio::test]
    async fn env_var_wins() {
        let _g = env_guard();
        unsafe {
            std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-test-env-wins");
        }
        let got = anthropic_api_key().await;
        unsafe {
            std::env::remove_var("ANTHROPIC_API_KEY");
        }
        assert_eq!(got.as_deref(), Some("sk-ant-test-env-wins"));
    }

    /// Whitespace-only env var must be treated as missing so the Keychain
    /// fallback can take over.
    #[tokio::test]
    async fn blank_env_var_is_ignored() {
        let _g = env_guard();
        unsafe {
            std::env::set_var("ANTHROPIC_API_KEY", "   ");
        }
        let got = anthropic_api_key().await;
        unsafe {
            std::env::remove_var("ANTHROPIC_API_KEY");
        }
        assert_ne!(got.as_deref(), Some("   "));
    }

    /// Nonexistent Keychain service must return `None`, not panic.
    #[tokio::test]
    async fn keychain_miss_returns_none() {
        let _g = env_guard();
        unsafe {
            std::env::remove_var("ANTHROPIC_API_KEY");
        }
        let got = keychain_find("sunny-this-service-should-not-exist-xyz").await;
        assert!(got.is_none());
    }

    /// When `ZAI_API_KEY` is set in the process env, the function must
    /// return it verbatim without invoking `security`.
    #[tokio::test]
    async fn zai_env_var_wins() {
        let _g = env_guard();
        unsafe {
            for v in SecretKind::Zai.env_vars() {
                std::env::remove_var(v);
            }
            std::env::set_var("ZAI_API_KEY", "zai-test-env-wins");
        }
        let got = zai_api_key().await;
        unsafe {
            std::env::remove_var("ZAI_API_KEY");
        }
        assert_eq!(got.as_deref(), Some("zai-test-env-wins"));
    }

    #[tokio::test]
    async fn zai_accepts_glm_alias() {
        let _g = env_guard();
        unsafe {
            for v in SecretKind::Zai.env_vars() {
                std::env::remove_var(v);
            }
            std::env::set_var("GLM_API_KEY", "glm-test-alias");
        }
        let got = zai_api_key().await;
        unsafe {
            std::env::remove_var("GLM_API_KEY");
        }
        assert_eq!(got.as_deref(), Some("glm-test-alias"));
    }

    #[tokio::test]
    async fn openrouter_accepts_alias() {
        let _g = env_guard();
        unsafe {
            for v in SecretKind::OpenRouter.env_vars() {
                std::env::remove_var(v);
            }
            std::env::set_var("OPEN_ROUTER_API_KEY", "sk-or-alias");
        }
        let got = openrouter_api_key().await;
        unsafe {
            std::env::remove_var("OPEN_ROUTER_API_KEY");
        }
        assert_eq!(got.as_deref(), Some("sk-or-alias"));
    }

    #[tokio::test]
    async fn elevenlabs_accepts_xi_alias() {
        let _g = env_guard();
        unsafe {
            for v in SecretKind::ElevenLabs.env_vars() {
                std::env::remove_var(v);
            }
            std::env::set_var("XI_API_KEY", "xi-test-alias-abcdefghij");
        }
        let got = elevenlabs_api_key().await;
        unsafe {
            std::env::remove_var("XI_API_KEY");
        }
        assert_eq!(got.as_deref(), Some("xi-test-alias-abcdefghij"));
    }

    #[test]
    fn plausibility_rejects_obvious_garbage() {
        assert!(!SecretKind::Anthropic.looks_plausible(""));
        assert!(!SecretKind::Anthropic.looks_plausible("   "));
        assert!(!SecretKind::Anthropic.looks_plausible("short"));
        assert!(!SecretKind::Anthropic.looks_plausible("no-prefix-123456789"));
        assert!(!SecretKind::Anthropic.looks_plausible("sk-with\nembedded-newline"));
        assert!(SecretKind::Anthropic.looks_plausible("sk-ant-abcd1234efgh5678"));
        assert!(SecretKind::OpenAi.looks_plausible("sk-proj-1234567890abcdef"));
        assert!(SecretKind::OpenRouter.looks_plausible("sk-or-v1-aaabbbccc"));
        // Providers without a stable prefix: accept length + non-control.
        assert!(SecretKind::Zai.looks_plausible("abcdefgh12345"));
        assert!(SecretKind::ElevenLabs.looks_plausible("xi_abcdef1234567890"));
        assert!(SecretKind::Wavespeed.looks_plausible("ws_abcdef1234567890"));
        assert!(!SecretKind::Wavespeed.looks_plausible(&"a".repeat(600)));
    }

    #[test]
    fn from_id_roundtrip() {
        for id in ["anthropic", "zai", "openai", "openrouter", "elevenlabs", "wavespeed"] {
            assert!(SecretKind::from_id(id).is_some(), "missing mapping for {id}");
        }
        assert!(SecretKind::from_id("unknown").is_none());
        assert!(SecretKind::from_id("").is_none());
    }

    /// Every provider must have a usable probe endpoint. A typo here ships
    /// as a silent "the TEST button always says network" bug, which is
    /// impossible to diagnose from the UI — so we just assert shape.
    #[test]
    fn every_provider_has_a_probe() {
        for kind in [
            SecretKind::Anthropic, SecretKind::OpenAi, SecretKind::OpenRouter,
            SecretKind::Zai, SecretKind::ElevenLabs, SecretKind::Wavespeed,
        ] {
            let (url, header, _prefix) = probe_endpoint(kind);
            assert!(url.starts_with("https://"), "{kind:?} probe url must be https");
            assert!(!header.is_empty(), "{kind:?} probe header must not be empty");
        }
    }

    /// Classification is the contract with the React side — every
    /// category value shows up as a pill colour and help text, so a
    /// regression in this table would light up the wrong UI.
    #[test]
    fn classify_status_categorises_known_codes() {
        assert_eq!(classify_status(200).0, "ok");
        assert_eq!(classify_status(204).0, "ok");
        assert_eq!(classify_status(401).0, "invalid_key");
        assert_eq!(classify_status(403).0, "invalid_key");
        assert_eq!(classify_status(404).0, "invalid_endpoint");
        assert_eq!(classify_status(408).0, "timeout");
        assert_eq!(classify_status(429).0, "rate_limited");
        assert_eq!(classify_status(500).0, "server");
        assert_eq!(classify_status(502).0, "server");
        assert_eq!(classify_status(418).0, "unknown");
    }

    /// `key_present_cached` must memoise the answer — two calls for
    /// the same `SecretKind` should resolve once and serve the second
    /// from the in-memory map. We prove this by populating env with a
    /// unique value, reading it once, clearing env, and verifying the
    /// second call still returns `true` (because the cache held the
    /// presence bit, not the value).
    #[tokio::test]
    async fn key_present_cached_memoises_across_calls() {
        let _g = env_guard();
        // Pick an unused provider so we can't collide with a real
        // Keychain entry on the dev machine.
        let kind = SecretKind::Wavespeed;
        invalidate_key_presence(kind).await;

        unsafe {
            for v in kind.env_vars() {
                std::env::remove_var(v);
            }
            std::env::set_var("WAVESPEED_API_KEY", "ws_cache_test_abcdef1234");
        }
        let first = key_present_cached(kind).await;
        // Now clear the env so a fresh `resolve` would return `false`.
        unsafe {
            std::env::remove_var("WAVESPEED_API_KEY");
        }
        // Second call must still see the cached `true`.
        let second = key_present_cached(kind).await;
        // Clean up before asserts so a failing test doesn't poison the
        // cache for later tests.
        invalidate_key_presence(kind).await;

        assert!(first, "first call should report key present");
        assert!(second, "second call should serve from cache");
    }

    /// `invalidate_key_presence` must force a re-resolve on the next
    /// call. Otherwise Settings-save would leave `pick_backend`
    /// serving a stale "key missing" bit for the rest of the session.
    #[tokio::test]
    async fn invalidate_key_presence_forces_reresolve() {
        let _g = env_guard();
        let kind = SecretKind::Wavespeed;
        invalidate_key_presence(kind).await;

        unsafe {
            for v in kind.env_vars() {
                std::env::remove_var(v);
            }
        }
        // With nothing in env and no Keychain entry for this test
        // service, the cached value should be `false`.
        let before = key_present_cached(kind).await;

        // Now "write the key" (via env) and invalidate the cache as
        // `keychain_set` would.
        unsafe {
            std::env::set_var("WAVESPEED_API_KEY", "ws_invalidate_test_abcdef");
        }
        invalidate_key_presence(kind).await;
        let after = key_present_cached(kind).await;

        // Clean up.
        unsafe {
            std::env::remove_var("WAVESPEED_API_KEY");
        }
        invalidate_key_presence(kind).await;

        assert!(!before, "expected no key before write");
        assert!(after, "expected invalidation to force a re-resolve");
    }

    /// Redact is the last-line-of-defence against a provider echoing our
    /// key. Short inputs should pass through unchanged; any exact
    /// occurrence of the key must become `***`.
    #[test]
    fn redact_scrubs_key_but_preserves_context() {
        let key = "sk-ant-abcdef1234567890";
        let body = format!(
            "error: invalid key {key}; see https://console.anthropic.com"
        );
        let r = redact(&body, key);
        assert!(!r.contains(key), "key leaked past redact");
        assert!(r.contains("console.anthropic.com"), "context lost");
        // Empty key is a no-op (avoids `replace("", "***")` behaviour).
        assert_eq!(redact("hello", ""), "hello");
        // Short body is a no-op.
        assert_eq!(redact("abc", "this-is-much-longer"), "abc");
    }
}
