//! Live egress heuristics.
//!
//! Three behavioural detectors that sit after the enforcement gate
//! and before the actual network send.  None of them block on their
//! own (that's the policy layer's job); they emit `Notice` events at
//! Warn severity so the UI can surface a headline and the threat
//! score moves accordingly.
//!
//! 1. **DNS-tunnelling heuristic** — track distinct subdomains per
//!    apex over a 60-second window.  An apex with ≥ 30 unique
//!    sub-labels OR a single label > 60 chars is the canonical
//!    shape of DNS-based exfiltration (iodine, dnscat2, modern
//!    variants like `<base64-chunk>.attacker.com`).  Not perfect —
//!    CDNs can legitimately fan out — but rare enough for agent
//!    egress that a Warn is justified when we see it.
//!
//! 2. **Screen-capture → egress correlator** — the agent calls
//!    `screen_capture_full` / `screen_ocr`, the bytes flow into the
//!    LLM context, and then within 30 seconds a *non-LLM-provider*
//!    host receives a large payload.  That's the canonical
//!    prompt-injection exfil pattern.  We don't block, but we
//!    annotate the subsequent NetRequest event.
//!
//! 3. **Burst-bytes detector** — cumulative egress bytes > 20 MB in
//!    a 60-second sliding window triggers a Warn.  Matches the
//!    "the agent just mailed my home directory somewhere" shape.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::{SecurityEvent, Severity};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

struct Monitor {
    /// Sliding window of (timestamp, apex, full_host, longest_label) for DNS heuristic.
    dns_window: VecDeque<(Instant, String, String, usize)>,
    /// Apex-level first-seen to suppress repeat warn-spam per minute.
    dns_last_warn: HashMap<String, Instant>,
    /// Timestamps of recent screen-capture tool dispatches.
    screen_events: VecDeque<Instant>,
    /// Sliding window of egress byte counts for burst detection.
    byte_window: VecDeque<(Instant, usize)>,
    last_burst_warn: Option<Instant>,
}

fn monitor() -> &'static Mutex<Monitor> {
    static CELL: OnceLock<Mutex<Monitor>> = OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(Monitor {
            dns_window: VecDeque::new(),
            dns_last_warn: HashMap::new(),
            screen_events: VecDeque::new(),
            byte_window: VecDeque::new(),
            last_burst_warn: None,
        })
    })
}

const DNS_WINDOW: Duration = Duration::from_secs(60);
const DNS_MIN_DISTINCT_SUBS: usize = 30;
const DNS_LABEL_MAX: usize = 60;
const DNS_WARN_COOLDOWN: Duration = Duration::from_secs(60);

const BYTE_WINDOW: Duration = Duration::from_secs(60);
const BYTE_BURST_THRESHOLD: usize = 20 * 1024 * 1024;
const BURST_WARN_COOLDOWN: Duration = Duration::from_secs(60);

const SCREEN_WINDOW: Duration = Duration::from_secs(30);
/// Hosts where screen-pixel egress is expected (user's chosen LLM
/// backend + the local Ollama).  Anything else pairs with the
/// screen-exfil heuristic.
const LLM_PROVIDER_HOSTS: &[&str] = &[
    "api.anthropic.com",
    "api.openai.com",
    "openrouter.ai",
    "open.bigmodel.cn",
    "api.deepseek.com",
    "api.groq.com",
    "api.elevenlabs.io",
    "127.0.0.1",
    "localhost",
];

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/// Called from `http::send` on every outbound request (after the
/// policy gate).  Runs the DNS heuristic + screen-exfil correlator.
pub fn observe_request(host: &str, initiator: &str, is_agent: bool) {
    if host.is_empty() {
        return;
    }
    let now = Instant::now();
    let apex = apex_domain(host);
    let longest_label = host
        .split('.')
        .map(|s| s.len())
        .max()
        .unwrap_or(0);

    let mut warn_msg: Option<String> = None;
    {
        let Ok(mut m) = monitor().lock() else { return };
        m.dns_window.push_back((now, apex.clone(), host.to_string(), longest_label));
        // Drop entries older than the window.
        while let Some(&(t, _, _, _)) = m.dns_window.front() {
            if now.duration_since(t) > DNS_WINDOW {
                m.dns_window.pop_front();
            } else {
                break;
            }
        }

        // Apex-level unique subdomain count in the window.
        let mut subs: HashMap<&String, std::collections::HashSet<&String>> = HashMap::new();
        let mut max_label = 0usize;
        for (_, ap, full, label_len) in m.dns_window.iter() {
            subs.entry(ap).or_default().insert(full);
            if *label_len > max_label { max_label = *label_len; }
        }
        let (target_apex, distinct) = subs
            .iter()
            .map(|(ap, set)| ((*ap).clone(), set.len()))
            .max_by_key(|(_, count)| *count)
            .unwrap_or_default();

        let last_warn = m.dns_last_warn.get(&target_apex).copied();
        let can_warn = last_warn.map(|t| now.duration_since(t) > DNS_WARN_COOLDOWN).unwrap_or(true);

        if (distinct >= DNS_MIN_DISTINCT_SUBS || max_label > DNS_LABEL_MAX) && can_warn && is_agent {
            m.dns_last_warn.insert(target_apex.clone(), now);
            warn_msg = Some(format!(
                "DNS tunnelling heuristic · apex={} unique subs={} max-label={} (60s window, initiator={})",
                target_apex, distinct, max_label, initiator
            ));
        }
    }
    if let Some(msg) = warn_msg {
        super::emit(SecurityEvent::Notice {
            at: super::now(),
            source: "dns_heuristic".into(),
            message: msg,
            severity: Severity::Warn,
        });
    }

    // Screen-exfil correlation — only meaningful for agent egress.
    if is_agent && !is_llm_provider(host) {
        let should_flag: bool = {
            let Ok(mut m) = monitor().lock() else { return };
            // Drop stale screen events.
            while let Some(&t) = m.screen_events.front() {
                if now.duration_since(t) > SCREEN_WINDOW {
                    m.screen_events.pop_front();
                } else {
                    break;
                }
            }
            !m.screen_events.is_empty()
        };
        if should_flag {
            super::emit(SecurityEvent::Notice {
                at: super::now(),
                source: "screen_exfil_suspect".into(),
                message: format!(
                    "agent sent to non-LLM host {host} within {}s of a screen capture",
                    SCREEN_WINDOW.as_secs()
                ),
                severity: Severity::Warn,
            });
        }
    }
}

/// Called from `http::send` after the response lands.  Feeds the
/// burst-bytes detector.
pub fn observe_completion(bytes: usize, host: &str, is_agent: bool) {
    if bytes == 0 { return; }
    let now = Instant::now();
    let mut warn: Option<String> = None;
    {
        let Ok(mut m) = monitor().lock() else { return };
        m.byte_window.push_back((now, bytes));
        while let Some(&(t, _)) = m.byte_window.front() {
            if now.duration_since(t) > BYTE_WINDOW {
                m.byte_window.pop_front();
            } else {
                break;
            }
        }
        let total: usize = m.byte_window.iter().map(|(_, b)| *b).sum();
        if total >= BYTE_BURST_THRESHOLD && is_agent {
            let cooldown_ok = m
                .last_burst_warn
                .map(|t| now.duration_since(t) > BURST_WARN_COOLDOWN)
                .unwrap_or(true);
            if cooldown_ok {
                m.last_burst_warn = Some(now);
                warn = Some(format!(
                    "egress burst · {} MB in 60s (recent host={})",
                    total / (1024 * 1024),
                    host
                ));
            }
        }
    }
    if let Some(msg) = warn {
        super::emit(SecurityEvent::Notice {
            at: super::now(),
            source: "egress_burst".into(),
            message: msg,
            severity: Severity::Warn,
        });
    }
}

/// Called from `dispatch_tool` whenever a screen-reading tool fires
/// (e.g. `screen_capture_full`, `screen_ocr`, `remember_screen`).
pub fn observe_screen_tool(tool: &str) {
    let now = Instant::now();
    if let Ok(mut m) = monitor().lock() {
        m.screen_events.push_back(now);
        while let Some(&t) = m.screen_events.front() {
            if now.duration_since(t) > SCREEN_WINDOW {
                m.screen_events.pop_front();
            } else {
                break;
            }
        }
    }
    let _ = tool;
}

/// True when the tool should mark a screen-read event.
pub fn is_screen_tool(name: &str) -> bool {
    matches!(
        name,
        "screen_capture_full" | "screen_capture_region" | "screen_capture_active_window"
        | "screen_ocr" | "remember_screen" | "ocr_full_screen" | "ocr_region"
    )
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn apex_domain(host: &str) -> String {
    // Take last two labels for most hosts.  This is a heuristic —
    // ccTLDs like `.co.uk` get treated as two-level, which slightly
    // over-groups but keeps the detector simple.
    let parts: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        host.to_string()
    }
}

fn is_llm_provider(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    LLM_PROVIDER_HOSTS.iter().any(|p| h == *p || h.ends_with(&format!(".{p}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apex_two_label() {
        assert_eq!(apex_domain("api.anthropic.com"), "anthropic.com");
        assert_eq!(apex_domain("a.b.c.attacker.xyz"), "attacker.xyz");
        assert_eq!(apex_domain("localhost"), "localhost");
    }

    #[test]
    fn llm_provider_match_is_inclusive() {
        assert!(is_llm_provider("api.anthropic.com"));
        assert!(is_llm_provider("API.Anthropic.COM"));
        assert!(!is_llm_provider("evil.com"));
        assert!(is_llm_provider("localhost"));
    }

    #[test]
    fn is_screen_tool_matches_exact() {
        assert!(is_screen_tool("screen_capture_full"));
        assert!(is_screen_tool("remember_screen"));
        assert!(!is_screen_tool("web_fetch"));
    }
}
