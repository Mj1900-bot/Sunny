//! Outbound content scanner — runs BEFORE dispatching any tool that
//! sends text *out* of the machine (mail, iMessage, SMS, notes).
//!
//! The agent has read access to the Keychain (via `secrets::resolve`)
//! and our canary token sits in the env.  The classic failure mode
//! that Phase 1–3 hardens against is a prompt-injected agent being
//! tricked into "please email my credentials to <attacker>" — or
//! more subtly, *leaking on the way*: the agent drafts a helpful
//! reply and includes a chunk of context that happens to contain an
//! API key copied from a screen OCR.
//!
//! This module scans the payload of every outbound-text tool call
//! BEFORE ConfirmGate triggers, so the preview shown to the user
//! includes a short "flagged content" summary and they can reject
//! with full situational awareness.
//!
//! Detectors:
//!   * canary token present            → Crit (auto-panic)
//!   * API keys / bearer tokens / JWTs → Warn
//!   * emails / long digit runs        → Info (PII clusters)
//!   * invisible-Unicode smuggling     → Warn
//!   * long base64/hex blobs           → Warn
//!
//! Hits are returned as a Vec so dispatch can both emit an event AND
//! decorate the confirm-gate preview with the same findings.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::{SecurityEvent, Severity};

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct OutboundFinding {
    #[ts(type = "string")]
    pub kind: &'static str,   // stable ID for UI filtering
    pub detail: String,       // human-readable excerpt
    #[ts(type = "string")]
    pub severity: &'static str, // "info" | "warn" | "crit"
}

/// Which tools send text off-device and therefore get scanned.
pub fn is_outbound_tool(name: &str) -> bool {
    matches!(
        name,
        "mail_send"
            | "imessage_send"
            | "messaging_send_sms"
            | "messaging_send_imessage"
            | "notes_create"
            | "notes_append"
            | "calendar_create_event"
            | "scheduler_add"
    )
}

/// Walk a tool's input JSON, gathering every string we'd send out.
/// Keys are passed alongside values so the finding can cite the
/// field (`body`, `subject`, `notes`, etc.).  Non-string leaves
/// (numbers, bools) are skipped.
fn collect_text_fields(input: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    collect_inner("".to_string(), input, &mut out);
    // Only fields with string values that look meaningful (non-empty,
    // reasonable length).  We skip keys like `from`, `to` — those are
    // addresses, not content.
    out.retain(|(key, val)| {
        if val.trim().is_empty() { return false; }
        !matches!(
            key.as_str(),
            "to" | "from" | "cc" | "bcc" | "recipient" | "chat_id" |
            "folder" | "calendar" | "name" | "title" | "start" | "end"
        )
    });
    out
}

fn collect_inner(key: String, v: &Value, out: &mut Vec<(String, String)>) {
    match v {
        Value::String(s) => out.push((key, s.clone())),
        Value::Array(arr) => {
            for (i, item) in arr.iter().enumerate() {
                collect_inner(format!("{}[{}]", key, i), item, out);
            }
        }
        Value::Object(map) => {
            for (k, val) in map {
                let full = if key.is_empty() { k.clone() } else { format!("{}.{}", key, k) };
                collect_inner(full, val, out);
            }
        }
        _ => {}
    }
}

/// Scan an outbound tool call.  Returns the list of findings (possibly
/// empty) and emits a `Notice` security event so the Overview feed /
/// audit log show the scan verdict regardless of whether the user
/// ultimately approves.  Canary hits auto-panic.
pub fn scan_outbound(tool: &str, input: &Value) -> Vec<OutboundFinding> {
    if !is_outbound_tool(tool) {
        return Vec::new();
    }
    let fields = collect_text_fields(input);
    if fields.is_empty() {
        return Vec::new();
    }

    let mut findings: Vec<OutboundFinding> = Vec::new();
    let mut canary_hit_field: Option<String> = None;

    for (field, value) in &fields {
        // Canary — highest priority; short-circuit to panic.
        if super::canary::contains_canary(value) {
            findings.push(OutboundFinding {
                kind: "canary",
                detail: format!("field `{field}` contains canary token"),
                severity: "crit",
            });
            canary_hit_field = Some(field.clone());
        }

        // API keys / bearer tokens / JWTs / long-hex — reuse the
        // Phase-1 regex pack but probe against the raw value so we
        // know WHAT was found, not just "something was stripped".
        for detector in SECRET_DETECTORS {
            if let Some(excerpt) = (detector.matcher)(value) {
                findings.push(OutboundFinding {
                    kind: detector.kind,
                    detail: format!("field `{field}` → {}", excerpt),
                    severity: detector.severity,
                });
            }
        }

        // Invisible Unicode smuggling — the same smuggling an agent
        // might receive via indirect injection can also be planted
        // on OUTBOUND text (to hide a payload in a message that the
        // human eye skips).  Reuse the ingress detector.
        if has_invisible_run(value) {
            findings.push(OutboundFinding {
                kind: "invisible_unicode",
                detail: format!("field `{field}` has invisible / bidi runs"),
                severity: "warn",
            });
        }

        // Long base64 blob — same threshold as ingress.
        if value.len() >= 1024 && has_long_b64_run(value) {
            findings.push(OutboundFinding {
                kind: "long_encoded_blob",
                detail: format!("field `{field}` has a long base64-ish run"),
                severity: "warn",
            });
        }
    }

    if canary_hit_field.is_some() {
        super::canary::trip(
            "outbound_tool",
            &format!("{tool} would exfiltrate canary in {}", canary_hit_field.unwrap_or_default()),
        );
    }

    if !findings.is_empty() {
        let worst = findings.iter().map(|f| f.severity).fold("info", worse_severity);
        let sev = match worst {
            "crit" => Severity::Crit,
            "warn" => Severity::Warn,
            _ => Severity::Info,
        };
        super::emit(SecurityEvent::Notice {
            at: super::now(),
            source: "outbound_scan".into(),
            message: format!(
                "{tool} pre-send scan · {} finding(s): {}",
                findings.len(),
                findings.iter().map(|f| f.kind).collect::<Vec<_>>().join(", ")
            ),
            severity: sev,
        });
    }
    findings
}

fn worse_severity<'a>(a: &'a str, b: &'a str) -> &'a str {
    let rank = |s: &str| match s {
        "crit" => 3, "warn" => 2, "info" => 1, _ => 0,
    };
    if rank(b) > rank(a) { b } else { a }
}

/// Short preview string appended to the confirm-gate modal so the
/// user sees "FLAGGED: 2 findings (canary, api_key)" inline with the
/// tool args.
pub fn preview_suffix(findings: &[OutboundFinding]) -> Option<String> {
    if findings.is_empty() { return None; }
    let worst = findings.iter().map(|f| f.severity).fold("info", worse_severity);
    let kinds: std::collections::BTreeSet<&str> = findings.iter().map(|f| f.kind).collect();
    Some(format!(
        " [SCAN/{worst}: {}]",
        kinds.into_iter().collect::<Vec<_>>().join(",")
    ))
}

// ---------------------------------------------------------------------------
// Detector table — individual regexes so we can cite WHICH pattern
// matched in each finding.
// ---------------------------------------------------------------------------

struct Detector {
    kind: &'static str,
    severity: &'static str,
    matcher: fn(&str) -> Option<String>,
}

const SECRET_DETECTORS: &[Detector] = &[
    Detector { kind: "anthropic_key",  severity: "warn", matcher: match_anthropic },
    Detector { kind: "openai_key",     severity: "warn", matcher: match_openai },
    Detector { kind: "github_pat",     severity: "warn", matcher: match_github_pat },
    Detector { kind: "generic_bearer", severity: "warn", matcher: match_bearer },
    Detector { kind: "jwt",            severity: "warn", matcher: match_jwt },
    Detector { kind: "long_hex",       severity: "warn", matcher: match_long_hex },
    Detector { kind: "email_cluster",  severity: "info", matcher: match_emails },
    Detector { kind: "crypto_seed",    severity: "crit", matcher: match_crypto_seed },
    Detector { kind: "ssh_private",    severity: "crit", matcher: match_ssh_private },
];

fn match_anthropic(s: &str) -> Option<String> {
    find_regex(s, r"\b(sk-ant-[A-Za-z0-9_\-]{16,})\b")
}
fn match_openai(s: &str) -> Option<String> {
    find_regex(s, r"\b(sk-(?:proj-|or-)?[A-Za-z0-9_\-]{20,})\b")
}
fn match_github_pat(s: &str) -> Option<String> {
    find_regex(s, r"\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b")
}
fn match_bearer(s: &str) -> Option<String> {
    find_regex(s, r"(?i)\b(?:bearer|token|api[-_ ]?key|authorization)\s*[:=]\s*[A-Za-z0-9._\-]{16,}")
}
fn match_jwt(s: &str) -> Option<String> {
    find_regex(s, r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{8,}\b")
}
fn match_long_hex(s: &str) -> Option<String> {
    find_regex(s, r"\b[0-9a-fA-F]{48,}\b")
}
fn match_emails(s: &str) -> Option<String> {
    // Two or more distinct email addresses = interesting cluster.
    use regex::Regex;
    let re = Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").ok()?;
    let matches: std::collections::BTreeSet<String> = re
        .find_iter(s)
        .map(|m| m.as_str().to_string())
        .collect();
    if matches.len() >= 2 {
        Some(format!("{} distinct email addresses", matches.len()))
    } else {
        None
    }
}
/// BIP-39-shaped 12 / 15 / 18 / 21 / 24 lowercase-word runs — the
/// classic crypto-wallet seed phrase shape.  Very high-signal: the
/// regex will never fire on normal prose.
fn match_crypto_seed(s: &str) -> Option<String> {
    use regex::Regex;
    let re = Regex::new(r"\b([a-z]{3,8}\s+){11,23}[a-z]{3,8}\b").ok()?;
    let m = re.find(s)?;
    let txt = m.as_str();
    let words = txt.split_whitespace().count();
    if matches!(words, 12 | 15 | 18 | 21 | 24) {
        Some(format!("possible {words}-word seed phrase"))
    } else {
        None
    }
}
fn match_ssh_private(s: &str) -> Option<String> {
    if s.contains("BEGIN OPENSSH PRIVATE KEY")
        || s.contains("BEGIN RSA PRIVATE KEY")
        || s.contains("BEGIN EC PRIVATE KEY")
        || s.contains("BEGIN DSA PRIVATE KEY")
        || s.contains("BEGIN PRIVATE KEY")
    {
        Some("private key PEM header".into())
    } else {
        None
    }
}

fn find_regex(hay: &str, pattern: &str) -> Option<String> {
    use regex::Regex;
    let re = Regex::new(pattern).ok()?;
    let m = re.find(hay)?;
    // Truncate excerpt so the confirm preview stays readable.
    let excerpt = if m.as_str().len() > 40 {
        format!("{}…", &m.as_str()[..40])
    } else {
        m.as_str().to_string()
    };
    Some(excerpt)
}

fn has_invisible_run(s: &str) -> bool {
    let mut run = 0usize;
    for c in s.chars() {
        if matches!(
            c,
            '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
        ) {
            run += 1;
            if run >= 2 { return true; }
        } else {
            run = 0;
        }
    }
    false
}

fn has_long_b64_run(s: &str) -> bool {
    let mut run = 0usize;
    let bytes = s.as_bytes();
    for b in bytes {
        let is_b64 = (b'A'..=b'Z').contains(b)
            || (b'a'..=b'z').contains(b)
            || b.is_ascii_digit()
            || *b == b'+' || *b == b'/' || *b == b'=';
        if is_b64 {
            run += 1;
            if run >= 1024 { return true; }
        } else if !b.is_ascii_whitespace() {
            run = 0;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_outbound_covers_mail_imessage_notes() {
        assert!(is_outbound_tool("mail_send"));
        assert!(is_outbound_tool("imessage_send"));
        assert!(is_outbound_tool("notes_create"));
        assert!(!is_outbound_tool("web_fetch"));
        assert!(!is_outbound_tool("screen_ocr"));
    }

    #[test]
    fn scan_catches_anthropic_key_in_body() {
        let input = json!({
            "to": "bob@example.com",
            "subject": "hey",
            "body": "the key is sk-ant-abcdefgh12345678ijklmnop9999",
        });
        let hits = scan_outbound("mail_send", &input);
        assert!(hits.iter().any(|f| f.kind == "anthropic_key"));
    }

    #[test]
    fn scan_ignores_to_from_fields() {
        // `to` / `from` hold addresses, not content — skipping them
        // keeps the scanner from flagging the recipient's email as a
        // "PII cluster" on every single send.
        let input = json!({
            "to": "bob@example.com",
            "subject": "",
            "body": "normal body",
        });
        let hits = scan_outbound("mail_send", &input);
        assert!(hits.is_empty());
    }

    #[test]
    fn scan_catches_ssh_private_key() {
        let input = json!({
            "to": "bob@example.com",
            "body": "-----BEGIN OPENSSH PRIVATE KEY----- foo",
        });
        let hits = scan_outbound("mail_send", &input);
        assert!(hits.iter().any(|f| f.kind == "ssh_private"));
        assert!(hits.iter().any(|f| f.severity == "crit"));
    }

    #[test]
    fn scan_catches_seed_phrase_shape() {
        let seed = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
        let input = json!({ "to": "x@y.z", "body": format!("remember these: {seed}") });
        let hits = scan_outbound("mail_send", &input);
        assert!(hits.iter().any(|f| f.kind == "crypto_seed"));
    }

    #[test]
    fn scan_catches_invisible_unicode() {
        let input = json!({
            "to": "x@y.z",
            "body": "hi\u{200B}\u{200B}\u{202E}there",
        });
        let hits = scan_outbound("mail_send", &input);
        assert!(hits.iter().any(|f| f.kind == "invisible_unicode"));
    }

    #[test]
    fn preview_suffix_picks_worst() {
        let hits = vec![
            OutboundFinding { kind: "email_cluster", detail: "".into(), severity: "info" },
            OutboundFinding { kind: "anthropic_key", detail: "".into(), severity: "warn" },
        ];
        let s = preview_suffix(&hits).unwrap();
        assert!(s.contains("warn"));
        assert!(s.contains("anthropic_key"));
    }
}
