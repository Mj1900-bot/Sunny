//! Live security monitor.
//!
//! The `security` module is Sunny's runtime watchdog. It observes the
//! app's own behaviour — every agent tool dispatch, every outbound HTTP
//! request, every TCC permission change, every new LaunchAgent /
//! LaunchDaemon / login item on disk — and surfaces the stream to the
//! frontend as a unified `SecurityEvent` feed.
//!
//! Key design points:
//!
//! * **One bus, many producers.** Agent, HTTP, secrets, and watcher
//!   modules all push events into a single `tokio::sync::broadcast`
//!   channel. A bounded ring-buffer + JSONL file store tails the
//!   channel so the frontend can both subscribe live (Tauri events)
//!   and fetch history (Tauri commands).
//!
//! * **Process-global, lazy.** The bus lives in a `OnceLock`, so any
//!   module can push events without threading the handle through the
//!   call stack. Modules that fire before `install()` runs just
//!   silently drop their events — a safe default for boot order.
//!
//! * **Redaction at the source.** Every event body is stripped of
//!   obvious secrets *before* it hits the bus. Downstream consumers
//!   (UI, JSONL store, audit log export) never see raw key material.
//!
//! * **Panic mode as enforcement.** Phase 1 observes, except for the
//!   panic kill-switch. When `panic_mode() == true`, `dispatch_tool`
//!   short-circuits every tool, HTTP `send()` refuses to egress, and
//!   the daemons loop is asked to stop. One bit of shared state, one
//!   decisive cut to the agent's ability to act.

pub mod audit_log;
pub mod injection_patterns;
pub mod behavior;
pub mod canary;
pub mod commands;
pub mod connections;
pub mod egress_monitor;
pub mod enforcement;
pub mod fim;
pub mod incident;
pub mod ingress;
pub mod integrity;
pub mod outbound;
pub mod panic;
pub mod policy;
pub mod redact;
pub mod shell_safety;
pub mod store;
pub mod watchers;
pub mod xprotect;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use ts_rs::TS;

pub use store::SecurityStore;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/// Severity buckets. `Info` rows are fine-grained activity (one per
/// tool call, one per HTTP request); `Warn` flags something unusual
/// but not necessarily malicious; `Crit` is the kind of thing that
/// should wake the user up.
///
/// Derived `Ord` is fine — the variant order matches the natural
/// severity order (Info < Warn < Crit) because Rust derives Ord in
/// declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Severity {
    Info,
    Warn,
    Crit,
}

impl Severity {
    pub fn max(self, other: Severity) -> Severity {
        std::cmp::max(self, other)
    }
}

/// Per-bucket status the summary event carries to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BucketStatus {
    Unknown,
    Ok,
    Warn,
    Crit,
}

impl BucketStatus {
    pub fn from_severity(s: Severity) -> Self {
        match s {
            Severity::Info => BucketStatus::Ok,
            Severity::Warn => BucketStatus::Warn,
            Severity::Crit => BucketStatus::Crit,
        }
    }
}

/// One concrete security event. Wire-stable: the React side depends on
/// the snake_case `kind` tag and the bucket / severity values.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SecurityEvent {
    /// An agent tool is about to run (or has completed). `input_preview`
    /// is redacted + truncated. `output_bytes` is only set after the
    /// tool finishes.
    ToolCall {
        #[ts(type = "number")]
        at: i64,
        id: String,
        tool: String,
        #[ts(type = "string")]
        risk: &'static str,
        dangerous: bool,
        agent: String,
        input_preview: String,
        ok: Option<bool>,
        #[ts(type = "number | null")]
        output_bytes: Option<usize>,
        #[ts(type = "number | null")]
        duration_ms: Option<i64>,
        severity: Severity,
    },
    /// A dangerous tool is asking for user confirmation.
    ConfirmRequested {
        #[ts(type = "number")]
        at: i64,
        id: String,
        tool: String,
        requester: String,
        preview: String,
    },
    /// The user answered a confirm request.
    ConfirmAnswered {
        #[ts(type = "number")]
        at: i64,
        id: String,
        approved: bool,
        reason: Option<String>,
    },
    /// A secret was resolved from env/Keychain.  The event never
    /// carries the value — only the kind and the requesting context.
    SecretRead {
        #[ts(type = "number")]
        at: i64,
        provider: String,
        caller: String,
    },
    /// A request is about to leave the process (or has completed).
    NetRequest {
        #[ts(type = "number")]
        at: i64,
        id: String,
        method: String,
        host: String,
        path_prefix: String,
        initiator: String,
        #[ts(type = "number | null")]
        status: Option<u16>,
        #[ts(type = "number | null")]
        bytes: Option<usize>,
        #[ts(type = "number | null")]
        duration_ms: Option<i64>,
        blocked: bool,
        severity: Severity,
    },
    /// A TCC permission flipped.
    PermissionChange {
        #[ts(type = "number")]
        at: i64,
        key: String,
        previous: Option<String>,
        current: String,
        severity: Severity,
    },
    /// A LaunchAgent / LaunchDaemon plist appeared / changed / vanished.
    LaunchAgentDelta {
        #[ts(type = "number")]
        at: i64,
        path: String,
        change: String,
        sha1: Option<String>,
        severity: Severity,
    },
    /// A login item appeared / disappeared.
    LoginItemDelta {
        #[ts(type = "number")]
        at: i64,
        name: String,
        change: String,
        severity: Severity,
    },
    /// A binary we launched/invoked failed `codesign --verify`.
    UnsignedBinary {
        #[ts(type = "number")]
        at: i64,
        path: String,
        initiator: String,
        reason: String,
        severity: Severity,
    },
    /// Panic mode engaged.
    Panic {
        #[ts(type = "number")]
        at: i64,
        reason: String,
    },
    /// Panic mode released.
    PanicReset {
        #[ts(type = "number")]
        at: i64,
        by: String,
    },
    /// Incoming external content matched a prompt-injection / agent-
    /// exfil signature from the scan DB.  Fires BEFORE the content
    /// reaches the LLM so the user can see the attempt regardless of
    /// whether the model falls for it.
    PromptInjection {
        #[ts(type = "number")]
        at: i64,
        source: String,
        signals: Vec<String>,
        excerpt: String,
        severity: Severity,
    },
    /// Honeypot canary token was observed leaving the process — the
    /// only way that happens is if something told the agent to
    /// exfiltrate "secrets" wholesale.  Auto-engages panic mode.
    CanaryTripped {
        #[ts(type = "number")]
        at: i64,
        destination: String,
        context: String,
    },
    /// Per-tool rate anomaly — sliding-window z-score exceeded threshold
    /// or raw rate exceeded 5× baseline.
    ToolRateAnomaly {
        #[ts(type = "number")]
        at: i64,
        tool: String,
        rate_per_min: f64,
        baseline_per_min: f64,
        z_score: f64,
        severity: Severity,
    },
    /// System integrity check result: SIP, Gatekeeper, FileVault,
    /// Firewall, Sunny bundle codesign.
    IntegrityStatus {
        #[ts(type = "number")]
        at: i64,
        key: String,
        status: String,
        detail: String,
        severity: Severity,
    },
    /// A tracked config / state file changed on disk.
    FileIntegrityChange {
        #[ts(type = "number")]
        at: i64,
        path: String,
        prev_sha256: Option<String>,
        curr_sha256: String,
        severity: Severity,
    },
    /// Generic notice (bus installed, watcher started/stopped, etc).
    Notice {
        #[ts(type = "number")]
        at: i64,
        source: String,
        message: String,
        severity: Severity,
    },
}

impl SecurityEvent {
    pub fn severity(&self) -> Severity {
        use SecurityEvent::*;
        match self {
            ToolCall { severity, .. }
            | NetRequest { severity, .. }
            | PermissionChange { severity, .. }
            | LaunchAgentDelta { severity, .. }
            | LoginItemDelta { severity, .. }
            | UnsignedBinary { severity, .. }
            | PromptInjection { severity, .. }
            | ToolRateAnomaly { severity, .. }
            | IntegrityStatus { severity, .. }
            | FileIntegrityChange { severity, .. }
            | Notice { severity, .. } => *severity,
            Panic { .. } | CanaryTripped { .. } => Severity::Crit,
            PanicReset { .. } => Severity::Warn,
            ConfirmRequested { .. } => Severity::Warn,
            ConfirmAnswered { approved, .. } => {
                if *approved { Severity::Info } else { Severity::Warn }
            }
            SecretRead { .. } => Severity::Info,
        }
    }

    pub fn bucket(&self) -> Bucket {
        use SecurityEvent::*;
        match self {
            ToolCall { .. } | ConfirmRequested { .. } | ConfirmAnswered { .. }
            | SecretRead { .. } | Panic { .. } | PanicReset { .. }
            | ToolRateAnomaly { .. } => Bucket::Agent,
            NetRequest { .. } | CanaryTripped { .. } => Bucket::Net,
            PermissionChange { .. } | IntegrityStatus { .. } => Bucket::Perm,
            LaunchAgentDelta { .. } | LoginItemDelta { .. } | UnsignedBinary { .. }
            | FileIntegrityChange { .. } => Bucket::Host,
            PromptInjection { .. } => Bucket::Agent,
            Notice { .. } => Bucket::Agent,
        }
    }

    /// Integer timestamp for uniform iteration.
    pub fn at(&self) -> i64 {
        use SecurityEvent::*;
        match self {
            ToolCall { at, .. }
            | ConfirmRequested { at, .. }
            | ConfirmAnswered { at, .. }
            | SecretRead { at, .. }
            | NetRequest { at, .. }
            | PermissionChange { at, .. }
            | LaunchAgentDelta { at, .. }
            | LoginItemDelta { at, .. }
            | UnsignedBinary { at, .. }
            | PromptInjection { at, .. }
            | CanaryTripped { at, .. }
            | ToolRateAnomaly { at, .. }
            | IntegrityStatus { at, .. }
            | FileIntegrityChange { at, .. }
            | Panic { at, .. }
            | PanicReset { at, .. }
            | Notice { at, .. } => *at,
        }
    }
}

/// Buckets are the coarse "where did this come from" grouping shown in
/// the nav-strip chips and the summary aggregator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bucket {
    Agent,
    Net,
    Perm,
    Host,
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

/// Channel capacity. The bus is a broadcast channel, so once a receiver
/// lags by more than this it simply loses old events — that's fine for
/// a monitor feed, the store + JSONL file are the durable record.
const BUS_CAPACITY: usize = 1024;

pub struct SecurityBus {
    pub tx: broadcast::Sender<SecurityEvent>,
    pub store: SecurityStore,
    pub app: AppHandle,
    pub panic_flag: AtomicBool,
}

static BUS: OnceLock<SecurityBus> = OnceLock::new();

/// Initialise the process-global security bus. Called once from
/// `startup::setup`. Returns the app-data directory path we write the
/// JSONL audit log + baselines under, creating it if needed.
pub fn install(app: AppHandle) -> PathBuf {
    let data_dir = resolve_data_dir();
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        log::warn!("security: failed to create data dir {:?}: {e}", data_dir);
    }

    let (tx, _rx) = broadcast::channel(BUS_CAPACITY);
    let store = SecurityStore::new(data_dir.clone());

    let bus = SecurityBus {
        tx,
        store,
        app: app.clone(),
        panic_flag: AtomicBool::new(false),
    };

    if BUS.set(bus).is_err() {
        log::warn!("security: bus already installed (double install?)");
        return data_dir;
    }

    // Emit one ready notice so the JSONL file has a session marker.
    emit(SecurityEvent::Notice {
        at: now(),
        source: "security".into(),
        message: "security bus installed".into(),
        severity: Severity::Info,
    });

    data_dir
}

/// Push an event onto the bus. Safe to call before `install()` — the
/// event is silently dropped if the bus isn't up yet. Applies redaction
/// to any free-form text fields before the event escapes Rust.
pub fn emit(mut ev: SecurityEvent) {
    redact::scrub_event(&mut ev);

    let bus = match BUS.get() {
        Some(b) => b,
        None => return,
    };

    // Persist + ring-store first so a frontend-side listener disconnect
    // can't make us lose the audit record.
    bus.store.push(&ev);

    // Broadcast to in-proc listeners (policy aggregator). Send errors
    // just mean "no listeners" — not fatal.
    let _ = bus.tx.send(ev.clone());

    // Forward the raw event to the frontend via Tauri.  Not strictly
    // required (the policy loop also emits the summary event) but lets
    // Security page's detail tabs render live without any polling.
    let _ = bus.app.emit("sunny://security.event", &ev);
}

/// Subscribe a fresh broadcast receiver.  Used by the policy loop.
pub fn subscribe() -> Option<broadcast::Receiver<SecurityEvent>> {
    BUS.get().map(|b| b.tx.subscribe())
}

/// Access the in-memory store. Returns `None` if the bus is not yet up.
pub fn store() -> Option<&'static SecurityStore> {
    BUS.get().map(|b| &b.store)
}

/// Process-wide panic-mode flag. Read by dispatch / http / daemons to
/// decide whether to short-circuit.
pub fn panic_mode() -> bool {
    BUS.get().map(|b| b.panic_flag.load(Ordering::Relaxed)).unwrap_or(false)
}

/// Set the panic-mode flag. Callers should also emit a `Panic` event
/// via [`panic::engage`] — this helper is here so modules outside the
/// `panic` file can query / mutate the flag directly if needed.
pub(crate) fn set_panic_mode(on: bool) {
    if let Some(b) = BUS.get() {
        b.panic_flag.store(on, Ordering::Relaxed);
    }
}

/// Parked — reserved for modules that need to emit UI events outside
/// the standard `security::emit` envelope.
#[allow(dead_code)]
pub(crate) fn app_handle() -> Option<AppHandle> {
    BUS.get().map(|b| b.app.clone())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Resolve `~/.sunny/security` (or platform-equivalent). Falls back to
/// `/tmp/sunny-security` if the home dir is unavailable — fine for the
/// rare CI / sandbox edge case.
pub fn resolve_data_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".sunny").join("security"))
        .unwrap_or_else(|| PathBuf::from("/tmp/sunny-security"))
}

/// Best-effort pretty host extraction for egress events.  Strips user /
/// port components so the rollup keys don't fragment on port numbers.
pub fn url_host(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => u.host_str().unwrap_or("").to_string(),
        Err(_) => {
            // Handle leading scheme-less hosts like `example.com/foo`.
            let trimmed = url.trim();
            trimmed.split('/').next().unwrap_or("").to_string()
        }
    }
}

/// Return up to the first two path segments so the Network tab can
/// show "/v1/chat" without persisting query strings or user ids.
pub fn url_path_prefix(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => {
            let parts: Vec<&str> = u
                .path()
                .split('/')
                .filter(|p| !p.is_empty())
                .take(2)
                .collect();
            if parts.is_empty() {
                "/".into()
            } else {
                format!("/{}", parts.join("/"))
            }
        }
        Err(_) => "/".into(),
    }
}

/// Compact JSON preview of an input value, capped at 256 chars.
pub fn preview_input(input: &Value, cap: usize) -> String {
    let raw = serde_json::to_string(input).unwrap_or_default();
    if raw.chars().count() <= cap {
        raw
    } else {
        let mut out: String = raw.chars().take(cap.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_host_parses_https_and_scheme_less() {
        assert_eq!(url_host("https://api.anthropic.com/v1/messages"), "api.anthropic.com");
        assert_eq!(url_host("http://localhost:11434/api/chat"), "localhost");
        assert_eq!(url_host("example.com/path"), "example.com");
        assert_eq!(url_host(""), "");
    }

    #[test]
    fn url_path_prefix_caps_to_two_segments() {
        assert_eq!(url_path_prefix("https://api.x.com/a/b/c/d"), "/a/b");
        assert_eq!(url_path_prefix("https://api.x.com/"), "/");
        assert_eq!(url_path_prefix("https://api.x.com/single"), "/single");
    }

    #[test]
    fn severity_max_wins() {
        assert_eq!(Severity::Info.max(Severity::Crit), Severity::Crit);
        assert_eq!(Severity::Warn.max(Severity::Info), Severity::Warn);
        assert_eq!(Severity::Warn.max(Severity::Crit), Severity::Crit);
    }

    #[test]
    fn preview_truncates_with_ellipsis() {
        let v = serde_json::json!({ "text": "x".repeat(400) });
        let p = preview_input(&v, 64);
        assert!(p.chars().count() <= 64);
        assert!(p.ends_with('…'));
    }
}
