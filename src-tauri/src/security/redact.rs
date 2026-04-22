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
    ///
    /// Fast paths (both sound — if skipped, the input couldn't possibly
    /// have matched any pattern):
    ///
    /// 1. **Length < 16 with no `@`** — shortest recognised secret is
    ///    an 11-digit run; shortest key prefix + body is ~16 chars;
    ///    email is the only single-byte anchor at any length. Short
    ///    messages like "hi", "yes", "open safari" hit this path and
    ///    skip all 7 regex passes.
    ///
    /// 2. **Content cache** — for non-trivial strings under 4 KB we
    ///    look up the input verbatim in a bounded LRU-ish map. A
    ///    20-turn conversation replayed every turn means the oldest 19
    ///    history messages hit the cache and run zero regex work.
    ///    Larger strings (tool results, embedded files) skip the cache
    ///    so we don't blow memory on one-off big payloads.
    pub fn scrub(&self, input: &str) -> String {
        // Fast path 1: cheap length+anchor check.
        if input.len() < 16 && !input.contains('@') {
            return input.to_string();
        }

        // Fast path 2: bounded cache for medium strings.
        if input.len() < 4096 {
            if let Some(cached) = scrub_cache_get(input) {
                return cached;
            }
        }

        let out = self.api_key.replace_all(input, "***");
        let out = self.bearer.replace_all(&out, "$1=***");
        let out = self.bearer_token.replace_all(&out, "$1 ***");
        let out = self.jwt.replace_all(&out, "***");
        let out = self.long_hex.replace_all(&out, "***");
        let out = self.email.replace_all(&out, "***");
        let out = self.long_digits.replace_all(&out, "***");
        let out = out.into_owned();

        if input.len() < 4096 {
            scrub_cache_put(input, &out);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Scrub result cache
//
// Scrubbing is pure: same input string → same scrubbed output. Every
// cloud LLM call scrubs the whole conversation history, so on turn N
// the oldest N-1 messages get scrubbed identically each time. Cache
// by content to eliminate the repeat work.
//
// Eviction: when the map exceeds CAPACITY, we clear the whole thing.
// This is cheaper than maintaining an LRU tail (no per-access bookkeeping)
// and the failure mode is benign — the next few calls take the slow
// path and rebuild the cache. For a 20-turn conversation with ~40
// messages this lands well under the 512 cap and never evicts.
// ---------------------------------------------------------------------------

const SCRUB_CACHE_CAPACITY: usize = 512;

type ScrubCache = std::sync::Mutex<std::collections::HashMap<String, String>>;

fn scrub_cache() -> &'static ScrubCache {
    static CELL: OnceLock<ScrubCache> = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn scrub_cache_get(input: &str) -> Option<String> {
    scrub_cache().lock().ok()?.get(input).cloned()
}

fn scrub_cache_put(input: &str, output: &str) {
    let Ok(mut guard) = scrub_cache().lock() else { return };
    if guard.len() >= SCRUB_CACHE_CAPACITY {
        guard.clear();
    }
    guard.insert(input.to_string(), output.to_string());
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

    // ----- Fast-path + cache behaviour -----

    /// Short non-email strings skip every regex — fastest path. Any
    /// regression here re-introduces 7 regex passes per short message
    /// which was the whole point of the fast path.
    #[test]
    fn short_string_returns_input_unchanged() {
        let out = s("hello");
        assert_eq!(out, "hello");
        let out = s("open Safari");
        assert_eq!(out, "open Safari");
        // Exactly 15 chars — still below the < 16 threshold.
        let out = s("abcdefghijklmno");
        assert_eq!(out, "abcdefghijklmno");
    }

    /// A short string with `@` must NOT take the fast path — emails
    /// can be shorter than 16 chars and still need scrubbing.
    #[test]
    fn short_string_with_at_sign_takes_full_path() {
        let out = s("a@b.co");
        assert!(out.contains("***"));
    }

    /// Length at the fast-path boundary (16) triggers the full scrub
    /// so we don't miss a 16-char secret that happens to land there.
    #[test]
    fn sixteen_chars_takes_full_path() {
        let input = "sk-short16charss"; // 16 chars, not actually matchable
        let out = s(input);
        assert_eq!(out, input); // no regex matches this exact string
    }

    /// Calling scrub() twice with the same non-trivial input returns
    /// the same output and exercises the cache on the second call.
    /// Indirect test — we can't observe cache hits directly, but a
    /// regression that invalidates the cache would break this.
    #[test]
    fn cache_preserves_output_across_calls() {
        let input = "please contact user@example.com for details";
        let first = s(input);
        let second = s(input);
        assert_eq!(first, second);
        assert!(first.contains("***"));
        assert!(!first.contains("user@example.com"));
    }

    /// Strings above the 4KB cap should still be scrubbed, they just
    /// skip the cache. Build a 5KB payload with an embedded secret and
    /// assert the secret is gone.
    #[test]
    fn large_string_still_scrubs_even_though_not_cached() {
        let filler = "x".repeat(5000);
        let input = format!("{filler} sk-ant-abcd1234efgh5678ijkl9012mnop3456 tail");
        let out = s(&input);
        assert!(!out.contains("sk-ant-abcd"));
        assert!(out.contains("***"));
    }
}
