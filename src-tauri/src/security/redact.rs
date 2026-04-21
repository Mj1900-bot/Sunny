//! Redaction — strips obvious secrets from every event before it
//! escapes Rust.
//!
//! This is defensive, not a replacement for careful authoring:
//! modules that know they handle sensitive input (secrets.rs,
//! messaging.rs, mail.rs) are expected to put narrow fingerprints /
//! summaries on the bus in the first place. `scrub_event` catches the
//! cases where a tool input echoed something the author didn't
//! anticipate — an OpenAI key in a pasted prompt, an emoji-free phone
//! number, a JWT in a `web_fetch` URL.
//!
//! Patterns matched:
//!
//! * `sk-*` / `xoxb-*` / `ghp_*` / `AKIA*` — common API-key prefixes.
//! * Bearer tokens in headers.
//! * JWTs (three dot-separated base64url segments, roughly 80+ chars).
//! * 32+ hex runs that look like hashes or opaque tokens.
//! * Email addresses (coarse — user@host pattern).
//! * Long digit runs that might be card numbers / phone numbers.
//!
//! All matches are replaced with `***`. Truncation still applies
//! independently — see `SecurityEvent` emitters for caps.

use std::sync::OnceLock;

use regex::Regex;

use super::SecurityEvent;

/// Per-category regex pack. We build the set once and reuse — regex
/// compile is non-trivial and this code sits on every bus emit.
pub struct RedactionSet {
    api_key: Regex,
    bearer: Regex,
    bearer_token: Regex,
    jwt: Regex,
    long_hex: Regex,
    email: Regex,
    long_digits: Regex,
}

impl RedactionSet {
    pub fn get() -> &'static RedactionSet {
        static CELL: OnceLock<RedactionSet> = OnceLock::new();
        CELL.get_or_init(|| RedactionSet {
            // Common API-key prefixes. The tail character class
            // matches base64url / hex / underscore / dash.
            api_key: Regex::new(
                r"(?x)
                \b(
                    sk-ant-[A-Za-z0-9_\-]{16,} |
                    sk-proj-[A-Za-z0-9_\-]{16,} |
                    sk-or-[A-Za-z0-9_\-]{16,} |
                    sk-[A-Za-z0-9_\-]{20,} |
                    xoxb-[A-Za-z0-9\-]{20,} |
                    ghp_[A-Za-z0-9]{30,} |
                    github_pat_[A-Za-z0-9_]{20,} |
                    AIza[A-Za-z0-9_\-]{30,} |
                    AKIA[A-Z0-9]{16,} |
                    ASIA[A-Z0-9]{16,}
                )\b
                ",
            )
            .expect("api_key regex"),
            bearer: Regex::new(r"(?i)\b(bearer|token|api[-_ ]?key|authorization)\s*[:=]\s*([A-Za-z0-9._\-]{16,})")
                .expect("bearer regex"),
            // Separate pattern for the value that follows a literal
            // `Bearer ` (or `Token `) prefix, regardless of whether a
            // header name preceded it.  Matches "Bearer aBcDeFgHi…"
            // anywhere in the string.
            bearer_token: Regex::new(r"(?i)\b(bearer|token)\s+([A-Za-z0-9._\-]{16,})\b")
                .expect("bearer_token regex"),
            // Three base64url segments separated by dots, total ≥ 60
            // chars (keeps us from flagging `1.2.3` or short tokens).
            jwt: Regex::new(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{8,}\b")
                .expect("jwt regex"),
            long_hex: Regex::new(r"\b[0-9a-fA-F]{32,}\b").expect("long_hex regex"),
            email: Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
                .expect("email regex"),
            long_digits: Regex::new(r"\b\d{11,}\b").expect("long_digits regex"),
        })
    }

    /// Scrub a single free-form string. The replacement is `***` —
    /// intentionally distinct from a normal token so the redaction is
    /// human-visible in the UI.
    pub fn scrub(&self, input: &str) -> String {
        let out = self.api_key.replace_all(input, "***");
        let out = self.bearer.replace_all(&out, "$1=***");
        let out = self.bearer_token.replace_all(&out, "$1 ***");
        let out = self.jwt.replace_all(&out, "***");
        let out = self.long_hex.replace_all(&out, "***");
        let out = self.email.replace_all(&out, "***");
        let out = self.long_digits.replace_all(&out, "***");
        out.into_owned()
    }
}

/// Scrub every free-form string field on an event in place. Structural
/// fields (enums, integers, bool) are left alone; their values are
/// already constrained by the type system.
pub fn scrub_event(ev: &mut SecurityEvent) {
    let set = RedactionSet::get();
    use SecurityEvent::*;
    match ev {
        ToolCall { tool: _, input_preview, agent, .. } => {
            *input_preview = set.scrub(input_preview);
            *agent = set.scrub(agent);
        }
        ConfirmRequested { tool: _, preview, requester, .. } => {
            *preview = set.scrub(preview);
            *requester = set.scrub(requester);
        }
        ConfirmAnswered { reason, .. } => {
            if let Some(r) = reason.as_mut() {
                *r = set.scrub(r);
            }
        }
        SecretRead { caller, provider: _, .. } => {
            *caller = set.scrub(caller);
        }
        NetRequest { host, path_prefix, initiator, .. } => {
            // host + path_prefix are already structurally safe after
            // url_host / url_path_prefix, but a malformed input could
            // still carry a JWT in a path segment — belt + braces.
            *host = set.scrub(host);
            *path_prefix = set.scrub(path_prefix);
            *initiator = set.scrub(initiator);
        }
        PermissionChange { previous, current, .. } => {
            if let Some(p) = previous.as_mut() {
                *p = set.scrub(p);
            }
            *current = set.scrub(current);
        }
        LaunchAgentDelta { path, change, .. } => {
            *path = set.scrub(path);
            *change = set.scrub(change);
        }
        LoginItemDelta { name, change, .. } => {
            *name = set.scrub(name);
            *change = set.scrub(change);
        }
        UnsignedBinary { path, initiator, reason, .. } => {
            *path = set.scrub(path);
            *initiator = set.scrub(initiator);
            *reason = set.scrub(reason);
        }
        Panic { reason, .. } => {
            *reason = set.scrub(reason);
        }
        PanicReset { by, .. } => {
            *by = set.scrub(by);
        }
        PromptInjection { source, signals: _, excerpt, .. } => {
            *source = set.scrub(source);
            *excerpt = set.scrub(excerpt);
        }
        CanaryTripped { destination, context, .. } => {
            *destination = set.scrub(destination);
            *context = set.scrub(context);
        }
        ToolRateAnomaly { tool, .. } => {
            *tool = set.scrub(tool);
        }
        IntegrityStatus { key, status, detail, .. } => {
            *key = set.scrub(key);
            *status = set.scrub(status);
            *detail = set.scrub(detail);
        }
        FileIntegrityChange { path, .. } => {
            *path = set.scrub(path);
        }
        Notice { source, message, .. } => {
            *source = set.scrub(source);
            *message = set.scrub(message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::Severity;

    fn s(input: &str) -> String {
        RedactionSet::get().scrub(input)
    }

    #[test]
    fn scrubs_anthropic_key() {
        let out = s("error from sk-ant-abcd1234efgh5678ijkl9012mnop3456");
        assert!(!out.contains("sk-ant-"));
        assert!(out.contains("***"));
    }

    #[test]
    fn scrubs_openai_key() {
        let out = s("OPENAI_KEY=sk-proj-abcdefghij1234567890ABCDEFGHIJ");
        assert!(!out.contains("sk-proj-"));
        assert!(out.contains("***"));
    }

    #[test]
    fn scrubs_github_pat() {
        let out = s("ghp_abcdefghij1234567890ABCDEFGHIJKLMN");
        assert!(!out.contains("ghp_abcdef"));
        assert!(out.contains("***"));
    }

    #[test]
    fn scrubs_bearer_header_value() {
        let out = s("Authorization: Bearer aBcDeFgHiJkLmNoPqRsT");
        // Must not contain the token; "Bearer" marker itself is OK to
        // keep for context.
        assert!(!out.contains("aBcDeFgHiJkLmNoPqRsT"));
    }

    #[test]
    fn scrubs_jwt_like_strings() {
        let out = s("header eyJabcdefghij.zzzzzzzzzz.yyyyyyyy tail");
        assert!(out.contains("***"));
        assert!(!out.contains("eyJ"));
    }

    #[test]
    fn scrubs_long_hex_run() {
        let out = s("sha256=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
        assert!(out.contains("***"));
    }

    #[test]
    fn scrubs_email_address() {
        let out = s("hello user@example.com goodbye");
        assert!(!out.contains("user@example.com"));
        assert!(out.contains("hello"));
        assert!(out.contains("goodbye"));
    }

    #[test]
    fn does_not_over_scrub_short_tokens() {
        let out = s("api call took 123 ms");
        assert!(out.contains("123"));
    }

    #[test]
    fn scrub_event_in_place() {
        let mut ev = SecurityEvent::ToolCall {
            at: 0,
            id: "x".into(),
            tool: "mail_send".into(),
            risk: "dangerous",
            dangerous: true,
            agent: "main".into(),
            input_preview: "to user@example.com subject hi body sk-ant-abcdefgh12345678ijklmnop".into(),
            ok: None,
            output_bytes: None,
            duration_ms: None,
            severity: Severity::Info,
        };
        scrub_event(&mut ev);
        if let SecurityEvent::ToolCall { input_preview, .. } = ev {
            assert!(!input_preview.contains("sk-ant-"));
            assert!(!input_preview.contains("@example.com"));
        }
    }
}
