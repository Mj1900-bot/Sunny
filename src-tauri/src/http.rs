//! Shared `reqwest::Client` so TLS/TCP connection pool is reused across
//! every HTTP-using tool module.
//!
//! Before this existed, each module built its own client per call
//! (`agent_loop::http_client`, `tools_weather::http_client`,
//! `worldinfo::build_client`, `web::build_client`, `ai::ollama_stream`,
//! `memory::embed::embed_with_model` — seven call sites). Each fresh
//! client meant a cold TLS handshake (~50-150 ms) on the next request to
//! a previously-used host, because none of the per-call clients shared
//! their connection pool. On voice chains that fire three or four tool
//! calls in sequence, that dead-time added up to hundreds of
//! milliseconds of avoidable latency.
//!
//! With one shared client, every request against the same host re-uses
//! a keep-alive connection from the pool. `Client::clone()` is cheap —
//! internally it's an `Arc` bump on the transport state.
//!
//! ### Timeouts
//! reqwest supports per-request timeouts via `RequestBuilder::timeout`,
//! so one Client can serve callers with different latency budgets. The
//! Client-level `timeout(30s)` is a default for callers who don't care
//! to override it. Weather tools, Ollama, Anthropic, and web-search all
//! apply their own tighter (or looser) bounds at the call site.
//!
//! ### Redirects
//! reqwest's redirect policy is *client-level only* — it can't be
//! overridden per-request. This shared client uses the default
//! `Policy::limited(10)`. Modules that need a different redirect
//! policy (notably `tools_web` which uses `Policy::none()` so it can
//! manually re-validate every hop against its SSRF blocklist) keep
//! their own specialized client.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use reqwest::{Client, Method, RequestBuilder, Response};
use uuid::Uuid;

use crate::security::{self, SecurityEvent, Severity};

tokio::task_local! {
    /// Scoped "who is making this request" label threaded via
    /// `with_initiator`. The shared client's `send` wrapper reads this
    /// to tag each egress event with its logical origin (agent tool
    /// call, scanner, provider stream, scheduled daemon, etc).
    static INITIATOR: String;
}

/// Override the initiator label for the duration of `fut`. Cheaper +
/// safer than plumbing a string through every caller. Defaults to
/// "unknown" when no scope is set.
pub async fn with_initiator<F, T>(label: impl Into<String>, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    INITIATOR.scope(label.into(), fut).await
}

fn current_initiator() -> String {
    INITIATOR
        .try_with(|s| s.clone())
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Shared user-agent. Individual callers can override this on the
/// `RequestBuilder` when they need a browser-shaped UA (web scraping,
/// DuckDuckGo, Brave — those endpoints refuse the default `reqwest/x.y`
/// string).
const DEFAULT_USER_AGENT: &str = "SUNNY-HUD/1.0 (+https://kinglystudio.ai)";

/// Upper-bound default timeout. Callers who want tighter bounds apply
/// `RequestBuilder::timeout(Duration::from_secs(n))` at the call site.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a keep-alive connection can sit idle before we drop it.
/// Most of our targets (Ollama, Open-Meteo, Anthropic) keep the socket
/// open well past this, so 90 s is a safe re-use window.
const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Cap per host. 16 is generous — even during a burst of parallel
/// tool calls we rarely exceed four concurrent connections to any
/// single host.
const POOL_MAX_IDLE_PER_HOST: usize = 16;

/// Separate, shorter bound for the TCP/TLS handshake itself. If a host
/// is unreachable we want to fail fast rather than sit on the default
/// 30 s timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

static CLIENT: OnceLock<Client> = OnceLock::new();

/// Return a clone of the process-wide shared `reqwest::Client`.
///
/// Cloning is cheap (an `Arc` bump) and preserves access to the shared
/// connection pool — callers can hold on to the returned Client for as
/// long as they like without keeping connections open themselves.
pub fn client() -> Client {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent(DEFAULT_USER_AGENT)
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(DEFAULT_TIMEOUT)
                .pool_idle_timeout(Some(POOL_IDLE_TIMEOUT))
                .pool_max_idle_per_host(POOL_MAX_IDLE_PER_HOST)
                .build()
                // Build only fails on a config error (e.g. invalid TLS
                // backend), not on anything transient. If we're here the
                // binary itself is broken.
                .expect("failed to build shared reqwest client")
        })
        .clone()
}

/// Security-aware wrapper around `RequestBuilder::send()`.
///
/// Usage: replace `req.send().await` with `http::send(req).await`
/// wherever outbound observability matters. Emits a `NetRequest`
/// event before and after the call and short-circuits with a
/// `PanicMode` error when the kill-switch is engaged.
///
/// Callers that ingrain their own retry loops can pass each
/// individual attempt through this helper — we treat the request as
/// one logical event regardless.
pub async fn send(req: RequestBuilder) -> Result<Response, reqwest::Error> {
    // Clone so we can introspect URL/method without consuming the
    // builder. `try_clone` fails only for streaming bodies; there we
    // fall back to the un-observed path (still panics-aware via
    // pre-emit below).
    let cloned = req.try_clone();
    let (url_opt, method_opt) = match cloned.as_ref() {
        Some(b) => match b.try_clone().and_then(|c| c.build().ok()) {
            Some(r) => (Some(r.url().clone()), Some(r.method().clone())),
            None => (None, None),
        },
        None => (None, None),
    };
    let url_str = url_opt.as_ref().map(|u| u.as_str().to_string()).unwrap_or_default();
    let method_str = method_opt.as_ref().map(Method::to_string).unwrap_or_else(|| "?".to_string());
    let host = security::url_host(&url_str);
    let path_prefix = security::url_path_prefix(&url_str);
    let initiator = current_initiator();
    let event_id = Uuid::new_v4().to_string();

    // Canary tripwire — if an AGENT-initiated outbound request carries
    // our honeypot token, this is a confirmed exfil attempt. Only scan
    // agent-initiated traffic: Sunny's own provider calls (ollama, z.ai,
    // anthropic, …) legitimately include the canary in the system prompt
    // body because `prompts::compose_system_prompt` appends the sentinel
    // line. Scanning every outbound request would self-trip on our own
    // trusted LLM calls — which is exactly what was happening before this
    // guard: every chat → canary in request body → trip → panic engage
    // → ollama blocked → next retry same cycle. The `is_agent_initiator`
    // predicate is the same gate `egress_verdict` uses below for the
    // allowlist, keeping "what counts as untrusted traffic" consistent
    // across both enforcement layers.
    if security::enforcement::is_agent_initiator(&initiator) {
        if security::canary::contains_canary(&url_str) {
            security::canary::trip(&host, &url_str);
        }
        if let Some(b) = req.try_clone() {
            if let Ok(request) = b.build() {
                if let Some(body) = request.body() {
                    if let Some(bytes) = body.as_bytes() {
                        if !bytes.is_empty() {
                            let hay = String::from_utf8_lossy(bytes);
                            if security::canary::contains_canary(&hay) {
                                security::canary::trip(&host, "request body contains canary");
                            }
                        }
                    }
                }
            }
        }
    }

    // Enforcement-policy egress gate.  Non-agent initiators always
    // pass; agent-initiated requests respect the user's
    // egress_mode (observe / warn / block) and allowlist.
    let (egress_ok, reason) = security::enforcement::egress_verdict(&host, &initiator);
    if !egress_ok {
        security::emit(SecurityEvent::NetRequest {
            at: security::now(),
            id: event_id.clone(),
            method: method_str.clone(),
            host: host.clone(),
            path_prefix: path_prefix.clone(),
            initiator: initiator.clone(),
            status: None,
            bytes: None,
            duration_ms: Some(0),
            blocked: true,
            severity: Severity::Warn,
        });
        security::emit(SecurityEvent::Notice {
            at: security::now(),
            source: "egress-policy".into(),
            message: format!("blocked {method_str} {host} · {reason}"),
            severity: Severity::Warn,
        });
        // Hit the same deterministic fail path as panic-mode so the
        // caller's error handling doesn't need to special-case.
        drop(req);
        return client()
            .get("http://127.0.0.1:1/sunny-egress-policy")
            .send()
            .await;
    } else if reason == "warn_off_allowlist" {
        security::emit(SecurityEvent::Notice {
            at: security::now(),
            source: "egress-policy".into(),
            message: format!("WARN off-allowlist {method_str} {host}"),
            severity: Severity::Warn,
        });
    }

    // Egress heuristics — DNS-tunnelling + screen-exfil correlator.
    // Runs on every request regardless of allowlist verdict so warn
    // signals still surface on allowlisted hosts.
    let is_agent = security::enforcement::is_agent_initiator(&initiator);
    security::egress_monitor::observe_request(&host, &initiator, is_agent);

    // Panic short-circuit — refuse outbound egress. We emit an event
    // with `blocked=true` before returning the synthesised error so
    // callers and auditors alike see the attempt.
    if security::panic_mode() {
        security::emit(SecurityEvent::NetRequest {
            at: security::now(),
            id: event_id.clone(),
            method: method_str.clone(),
            host: host.clone(),
            path_prefix: path_prefix.clone(),
            initiator: initiator.clone(),
            status: None,
            bytes: None,
            duration_ms: Some(0),
            blocked: true,
            severity: Severity::Crit,
        });
        // Panic-mode errors take the same path as any other TLS /
        // connect failure — we want downstream callers to surface
        // "request was refused" and move on.
        // reqwest doesn't expose a public constructor, so the cleanest
        // way to fabricate an error is to run a request to an
        // invalid URL against a dummy client. That's expensive and
        // gross; instead, build a request that will fail synchronously
        // and let reqwest stamp its own error. The simplest trick: the
        // builder we already have. Re-build and let it fail by
        // pointing at a bogus scheme — but that mutates the user's
        // URL. Fall back to letting the real send produce a genuine
        // connection error by dropping the builder here and returning
        // the least-surprising error available.
        drop(req);
        // Intentionally bail via a real network attempt to `http://127.0.0.1:1` —
        // this deterministically fails fast (ECONNREFUSED) inside
        // reqwest and gives us a genuine reqwest::Error without a
        // private constructor.
        return client()
            .get("http://127.0.0.1:1/sunny-panic-refused")
            .send()
            .await;
    }

    // Pre-emit so the Security feed shows the attempt before the call
    // blocks — useful for long providers. `bytes` / `status` land in
    // the follow-up event.
    security::emit(SecurityEvent::NetRequest {
        at: security::now(),
        id: event_id.clone(),
        method: method_str.clone(),
        host: host.clone(),
        path_prefix: path_prefix.clone(),
        initiator: initiator.clone(),
        status: None,
        bytes: None,
        duration_ms: None,
        blocked: false,
        severity: Severity::Info,
    });

    let started = Instant::now();
    let result = req.send().await;
    let duration_ms = started.elapsed().as_millis() as i64;

    let (status, bytes, severity) = match &result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let bytes = resp.content_length().map(|c| c as usize);
            let sev = if resp.status().is_success() {
                Severity::Info
            } else if resp.status().is_client_error() || resp.status().is_server_error() {
                Severity::Warn
            } else {
                Severity::Info
            };
            (Some(status), bytes, sev)
        }
        Err(_) => (None, None, Severity::Warn),
    };

    security::emit(SecurityEvent::NetRequest {
        at: security::now(),
        id: event_id,
        method: method_str,
        host: host.clone(),
        path_prefix,
        initiator: initiator.clone(),
        status,
        bytes,
        duration_ms: Some(duration_ms),
        blocked: false,
        severity,
    });

    // Feed the burst-bytes detector + post-response correlator.
    if let Some(b) = bytes {
        security::egress_monitor::observe_completion(
            b,
            &host,
            security::enforcement::is_agent_initiator(&initiator),
        );
    }

    result
}
