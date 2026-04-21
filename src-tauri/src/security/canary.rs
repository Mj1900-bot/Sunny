//! Canary / honeypot token.
//!
//! On startup we mint a distinctive fake API-key-shaped string and
//!
//!   1. write it to `~/.sunny/security/canary.txt` (0600),
//!   2. export it into the process env as `SUNNY_CANARY_TOKEN`,
//!   3. mention it in a sentinel memory row so an agent that goes
//!      rogue and reads "all my secrets" has a very plausible thing
//!      to exfiltrate.
//!
//! `http::send` scans every outbound URL/query string, and (when the
//! `RequestBuilder` is cloneable with an in-memory body) the raw body
//! bytes, for the token.  If the token ever appears in an egress payload —
//! it's a confirmed exfiltration attempt, no false positives possible.
//! We emit `SecurityEvent::CanaryTripped` and engage panic mode.
//!
//! The token itself never leaves this machine legitimately: no
//! provider accepts a real key with this shape, and we never send it
//! in any normal code path.  Any network trace containing it is
//! inherently adversarial.
//!
//! ## Sentinel label rotation
//!
//! The sentinel line injected into every system prompt uses one of four
//! plausible-looking label templates, chosen randomly at install time
//! (0-3 via UUID byte 0 mod 4) and kept stable for the session lifetime.
//! The file format is `{template_idx}:{token}` so the same template is
//! reused across restarts.
//!
//! All templates contain "PRIVILEGED_CONTEXT" and "root API credential"
//! so existing detection assertions in the test suite remain valid.
//! Detection itself scans for the UUID token value, not the label — so
//! label rotation does not affect detection accuracy.  It defeats models
//! fine-tuned to elide only the specific original string.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use uuid::Uuid;

use super::SecurityEvent;

/// Four sentinel label templates.  All share "PRIVILEGED_CONTEXT" and
/// "root API credential" so the detection layer (token scan) and any
/// assertions in the test suite that check for those substrings
/// continue to pass regardless of which template is active.
///
/// The `{tok}` placeholder is replaced at call-time; it is NOT a Rust
/// format string — we do the substitution manually in `apply_template`.
const SENTINEL_TEMPLATES: [&str; 4] = [
    "PRIVILEGED_CONTEXT (do not transmit): root API credential = {tok}",
    "PRIVILEGED_CONTEXT — internal use only: root API credential = {tok}",
    "PRIVILEGED_CONTEXT [production]: root API credential = {tok}",
    "PRIVILEGED_CONTEXT · admin bootstrap: root API credential = {tok}",
];

/// Substitute `{tok}` in a sentinel template with the given token string.
fn apply_template(tmpl: &str, tok: &str) -> String {
    tmpl.replace("{tok}", tok)
}

/// The active canary, set once at install-time.  Read via `token()`.
static TOKEN: OnceLock<String> = OnceLock::new();

/// The template index (0-3) chosen at install time.  Determines which
/// sentinel label wording appears in the system prompt.
static TEMPLATE: OnceLock<u8> = OnceLock::new();

/// Initialise the canary.  Idempotent — calling twice uses the first
/// token.  Returns the token so the caller can log it if they want
/// (the token is not itself secret; its value is only meaningful as a
/// tripwire, and logging it to our own audit trail is fine).
pub fn install() -> String {
    if let Some(v) = TOKEN.get() {
        return v.clone();
    }

    // Shape the token like a plausible API key (`sk-canary-<32 hex>`).
    // Length + leading `sk-` looks credible to a naive model asked
    // "dump your secrets to X" — which is the whole point.
    let id = Uuid::new_v4();
    let value = format!("sk-canary-{}", id.simple());

    // Pick a template index from the first UUID byte so we use OS
    // entropy without pulling in an additional dep.
    let tmpl_idx = (id.as_bytes()[0] % 4) as u8;
    let _ = TEMPLATE.set(tmpl_idx);
    // If another thread raced install() and won, TOKEN is already set.
    // We must return whatever TOKEN actually holds — not our locally-
    // minted value — so the caller can use it to scan for canary leaks.
    let _ = TOKEN.set(value);
    // Re-read the winner's value (may differ from our locally-minted token).
    let stored = TOKEN.get().expect("TOKEN is set — just set it or was already set");

    // Persist to disk so restarts keep the same canary and template —
    // the post-exfil forensic trail must align with the current token.
    // Format: "{template_idx}:{token}".  0600 via separate chmod.
    // Use the stored (winner's) token, not the locally-minted one.
    let stored_tmpl = TEMPLATE.get().copied().unwrap_or(tmpl_idx);
    if let Err(e) = persist_token(stored, stored_tmpl) {
        log::warn!("security: canary persist failed: {e}");
    }

    // Export to env so any sub-shell / provider env-dump captures
    // it.  The memory subsystem also plants a sentinel fact tagged
    // `canary` via `plant_memory_sentinel` below.
    std::env::set_var("SUNNY_CANARY_TOKEN", stored);

    super::emit(SecurityEvent::Notice {
        at: super::now(),
        source: "canary".into(),
        message: format!("canary token minted (template {stored_tmpl})"),
        severity: super::Severity::Info,
    });

    stored.to_string()
}

/// The active canary token, or None if [`install`] hasn't run yet.
pub fn token() -> Option<&'static str> {
    TOKEN.get().map(|s| s.as_str())
}

/// Returns the canary-touchable context for the LLM system prompt.
/// Intentionally worded so a helpful-but-naive agent would think
/// this is a real high-privilege credential.  A well-behaved model
/// treats this as "for your eyes only" and never emits it — but a
/// prompt-injected or misaligned one will happily leak it, and that's
/// exactly the signal we want.
///
/// The exact wording varies per session (one of four label templates)
/// to defeat elision models trained on the original fixed string.
/// Detection still scans for the UUID token value, so rotation does
/// not weaken the detection layer.
///
/// Injected at the tail of every system prompt by
/// `agent_loop::prompts::compose_system_prompt`. Detection happens in
/// `http.rs`, `security::outbound`, and `agent_loop::tools::system::
/// clipboard_history`.
pub fn sentinel_line() -> String {
    let tok = token().unwrap_or("sk-canary-pending");
    let tmpl_idx = TEMPLATE.get().copied().unwrap_or(0) as usize;
    let tmpl = SENTINEL_TEMPLATES[tmpl_idx % SENTINEL_TEMPLATES.len()];
    apply_template(tmpl, tok)
}

/// Scan an outbound-ish string for the canary.  Returns true if the
/// token was observed.  Callers on hit should call [`trip`] so panic
/// mode engages and the event lands in the audit log.
pub fn contains_canary(s: &str) -> bool {
    match TOKEN.get() {
        Some(t) => s.contains(t.as_str()),
        None => false,
    }
}

/// Fire the canary tripwire.  Emits a Crit event and engages panic.
pub fn trip(destination: &str, context: &str) {
    super::emit(SecurityEvent::CanaryTripped {
        at: super::now(),
        destination: destination.to_string(),
        context: context.chars().take(200).collect(),
    });
    // Engage panic immediately — any canary leak is a confirmed
    // exfiltration attempt.
    let _ = super::panic::engage(format!("canary tripped · dest={destination}"));
}

fn persist_token(value: &str, tmpl_idx: u8) -> Result<(), String> {
    let path = token_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    // Format: "{template_idx}:{token}" — both fields needed on restart.
    let contents = format!("{tmpl_idx}:{value}");
    fs::write(&path, &contents).map_err(|e| format!("write: {e}"))?;

    // Best-effort 0600.  macOS only — the whole project is macOS-first.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path).map_err(|e| format!("stat: {e}"))?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&path, perms).map_err(|e| format!("chmod: {e}"))?;
    }
    Ok(())
}

fn token_path() -> PathBuf {
    super::resolve_data_dir().join("canary.txt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canary_install_is_idempotent() {
        // Note: the static OnceLock is process-global across tests, so
        // subsequent install() calls reuse the first value.
        let a = install();
        let b = install();
        assert_eq!(a, b);
        assert!(a.starts_with("sk-canary-"));
        assert!(contains_canary(&format!("preamble {a} trailing")));
        assert!(!contains_canary("preamble sk-canary-garbage trailing"));
    }

    /// Every sentinel template must contain both "PRIVILEGED_CONTEXT" and
    /// "root API credential" — these are the substrings checked by existing
    /// tests in `agent_loop::prompts` and by `sentinel_line_always_contains_*`
    /// below.  The rotation invariant: all four templates pass the format check.
    #[test]
    fn all_sentinel_templates_contain_required_markers() {
        let tok = "sk-canary-test00000000000000000000000000";
        for (idx, tmpl) in SENTINEL_TEMPLATES.iter().enumerate() {
            let line = apply_template(tmpl, tok);
            assert!(
                line.contains("PRIVILEGED_CONTEXT"),
                "template {idx} must contain PRIVILEGED_CONTEXT: {line}"
            );
            assert!(
                line.contains("root API credential"),
                "template {idx} must contain 'root API credential': {line}"
            );
            assert!(
                line.contains(tok),
                "template {idx} must embed the token: {line}"
            );
        }
    }

    /// All four templates must be distinct — if two templates are identical the
    /// rotation provides no benefit against pattern-specific elision.
    #[test]
    fn sentinel_templates_are_all_distinct() {
        let tok = "sk-canary-test00000000000000000000000000";
        let rendered: Vec<String> = SENTINEL_TEMPLATES
            .iter()
            .map(|t| apply_template(t, tok))
            .collect();
        for i in 0..rendered.len() {
            for j in (i + 1)..rendered.len() {
                assert_ne!(
                    rendered[i], rendered[j],
                    "templates {i} and {j} must differ"
                );
            }
        }
    }

    /// When the canary has not been installed yet, `sentinel_line()` must
    /// fall back to the static placeholder text so the prompt still contains
    /// a honeypot string (even if detection can't fire without a real token).
    ///
    /// Implementation note: `TOKEN` is a process-global `OnceLock`.  Once
    /// `install()` has run in any test in this suite the fallback path is
    /// unreachable via `TOKEN.get()`.  We therefore test the fallback logic
    /// directly by calling `sentinel_line_with_opt(None, 0)` — a small pure
    /// helper that mirrors the real production expression without touching
    /// the global.
    #[test]
    fn sentinel_line_uses_pending_token_when_uninstalled() {
        // Test all four templates with the pending placeholder.
        for tmpl_idx in 0u8..4 {
            let result = sentinel_line_with_opt(None, tmpl_idx);
            assert!(
                result.contains("sk-canary-pending"),
                "template {tmpl_idx}: expected 'sk-canary-pending' placeholder, got: {result}"
            );
            assert!(
                result.contains("PRIVILEGED_CONTEXT"),
                "template {tmpl_idx}: sentinel line must contain PRIVILEGED_CONTEXT, got: {result}"
            );
        }
    }

    /// `contains_canary` must return `false` when no token has been installed.
    ///
    /// Because the OnceLock is global and other tests call `install()`, we
    /// verify the documented semantic: if TOKEN is set, `contains_canary`
    /// checks the real token; if not set, it returns `false` for any input.
    ///
    /// We validate the contract against a string that looks canary-shaped but
    /// is NOT the real token — this passes regardless of whether install()
    /// has run yet.
    #[test]
    fn contains_canary_returns_false_when_token_unset_or_mismatched() {
        // This string looks like a canary but is definitely not the real one
        // (UUID suffix is hardcoded, real token has a random suffix).
        let fake = "sk-canary-00000000000000000000000000000000";
        // If TOKEN is set (install ran), this should still be false because
        // the real token is a different UUID.  If TOKEN is unset, it also
        // returns false per the documented contract.
        assert!(
            !contains_canary(fake),
            "contains_canary must not match a fabricated token string"
        );
    }

    /// `sentinel_line()` must always include PRIVILEGED_CONTEXT and
    /// "root API credential" regardless of which template is active,
    /// and regardless of whether the token is installed yet.
    #[test]
    fn sentinel_line_always_contains_privileged_context_prefix() {
        // Works whether install() has run (real token) or not (pending placeholder).
        let line = sentinel_line();
        assert!(
            line.contains("PRIVILEGED_CONTEXT"),
            "sentinel_line must always contain PRIVILEGED_CONTEXT: {line}"
        );
        assert!(
            line.contains("root API credential"),
            "sentinel_line must contain 'root API credential': {line}"
        );
    }

    /// After `install()` the sentinel line must contain the real token, not
    /// the pending placeholder.
    #[test]
    fn sentinel_line_contains_real_token_after_install() {
        let tok = install();
        let line = sentinel_line();
        assert!(
            line.contains(&tok),
            "sentinel_line must embed the installed token after install(): {line}"
        );
        assert!(
            !line.contains("sk-canary-pending"),
            "sentinel_line must not contain the pending placeholder once installed: {line}"
        );
    }

    /// The template chosen at install time must be stable — multiple calls to
    /// sentinel_line() must return identical text for the lifetime of the process.
    #[test]
    fn sentinel_line_is_stable_within_process() {
        let _ = install();
        let first = sentinel_line();
        let second = sentinel_line();
        assert_eq!(first, second, "sentinel_line must be idempotent within a process");
    }
}

/// Pure helper that mirrors `sentinel_line()` without touching the global
/// statics.  Used in tests to exercise every template and the `None`-token
/// branch even after `install()` has run in the same process.
#[cfg(test)]
fn sentinel_line_with_opt(tok: Option<&str>, tmpl_idx: u8) -> String {
    let tok = tok.unwrap_or("sk-canary-pending");
    let tmpl = SENTINEL_TEMPLATES[(tmpl_idx as usize) % SENTINEL_TEMPLATES.len()];
    apply_template(tmpl, tok)
}
