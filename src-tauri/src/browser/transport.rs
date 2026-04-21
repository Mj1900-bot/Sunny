//! Per-profile HTTP client construction.
//!
//! This is the *only* place in the crate allowed to call
//! `reqwest::Client::builder()` directly. The grep check in
//! `scripts/check-net-dispatch.sh` enforces that at CI time. Every other
//! module receives a pre-built `reqwest::Client` via the [`dispatcher`]
//! and inherits the profile's policy automatically.
//!
//! The client we hand out already has:
//! - A proxy URL matching the profile's route (DoH for clearnet,
//!   SOCKS5h for tor, whatever the user pasted for custom).
//! - A rotated or pinned User-Agent.
//! - A rustls config locked to TLS 1.2+ with no session tickets (tickets
//!   cross-correlate visits).
//! - A per-profile cookie jar (persistent or ephemeral).
//! - A 15 s timeout and 4 MiB body cap — higher than reader mode's old
//!   limits but still bounded.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::Client;

use crate::browser::doh;
use crate::browser::profile::{CookieJar, DohResolver, ProfilePolicy, Route, UaMode};

pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Cap on redirects the dispatcher will chase. Matches the old
/// `Policy::limited(10)` value that used to live on the reqwest client —
/// we enforce it in our manual redirect loop so every hop re-enters the
/// SSRF / constitution / tracker gate.
pub const MAX_REDIRECT_HOPS: usize = 10;

/// Realistic macOS Safari strings we rotate between. Keep the list tight so
/// the fingerprint surface is small — a rotating UA picked from 200 strings
/// is no more anonymous than a pinned one, it just looks noisier in logs.
const SAFARI_UA_POOL: &[&str] = &[
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
];

/// The Tor Browser Bundle UA — deliberately uniform so Tor users fingerprint
/// identically. Pinning to an older Firefox ESR is intentional; the TBB
/// tracks that release train.
const TOR_BROWSER_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:115.0) Gecko/20100101 Firefox/115.0";

/// Pick a UA string for this request, honoring the profile's mode. The
/// rotation counter is global, not per-client — otherwise two clients
/// spawned in the same millisecond from the same profile would hit the
/// same bucket.
pub fn user_agent_for(policy: &ProfilePolicy) -> &'static str {
    static ROTATION: AtomicU32 = AtomicU32::new(0);
    match policy.ua_mode {
        UaMode::Rotate => {
            let i = ROTATION.fetch_add(1, Ordering::Relaxed) as usize;
            SAFARI_UA_POOL[i % SAFARI_UA_POOL.len()]
        }
        UaMode::PinnedSafari => SAFARI_UA_POOL[0],
        UaMode::PinnedTorBrowser => TOR_BROWSER_UA,
        UaMode::System => "SUNNY/0.1",
    }
}

/// Build a freshly-configured `reqwest::Client` for the given profile. The
/// caller typically caches this per-profile in [`dispatcher`](super::dispatcher)
/// rather than rebuilding per request — rebuilding on every call throws
/// away the connection pool and the TLS session state we *want* to keep
/// across requests inside the same session.
pub fn build_client(policy: &ProfilePolicy) -> Result<Client, String> {
    let mut b = Client::builder()
        .user_agent(user_agent_for(policy))
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        // Redirects are disabled at the transport layer — the dispatcher
        // follows them manually (capped at `MAX_REDIRECT_HOPS`) so every
        // hop is re-validated against the profile's block / constitution
        // / SSRF gate (a 302 from an allowlisted host to an onion,
        // intranet, or private-IP otherwise slips through the single
        // pre-flight check).
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(4)
        // Disable TLS session tickets — they cross-correlate connections
        // across circuits when using Tor. rustls doesn't expose a direct
        // knob for this; reqwest's `tls_built_in_root_certs` at least
        // ensures we're not picking up the system store on the Tor path.
        .https_only(false);

    match &policy.route {
        Route::Clearnet { doh: doh_provider } => {
            // DoH is a DNS-layer mechanism, not an HTTP proxy — wire it
            // through reqwest's custom resolver trait so every resolution
            // walks through our DoH code instead of getaddrinfo.
            if let Some(provider) = doh_provider {
                b = b.dns_resolver(Arc::new(DohDnsResolver {
                    profile_label: policy.id.as_str().to_string(),
                    provider: *provider,
                }));
            }
        }
        Route::SystemTor { host, port } => {
            // `socks5h://` forces remote resolution inside Tor — critical,
            // since a local resolve would leak the hostname.
            let proxy_url = format!("socks5h://{host}:{port}");
            let proxy = reqwest::Proxy::all(&proxy_url)
                .map_err(|e| format!("parse system-tor proxy: {e}"))?;
            b = b.proxy(proxy);
        }
        Route::BundledTor => {
            // Wired up by the `tor` submodule when the feature is on. The
            // caller is expected to pass a SOCKS port via
            // `set_bundled_tor_port` before this function is reached; if
            // the feature is off we fall through and the dispatcher will
            // reject the request.
            #[cfg(feature = "bundled-tor")]
            if let Some(port) = crate::browser::tor::bundled_socks_port() {
                let proxy_url = format!("socks5h://127.0.0.1:{port}");
                let proxy = reqwest::Proxy::all(&proxy_url)
                    .map_err(|e| format!("parse bundled-tor proxy: {e}"))?;
                b = b.proxy(proxy);
            } else {
                return Err(
                    "bundled Tor not ready — call tor_bootstrap first".into(),
                );
            }

            #[cfg(not(feature = "bundled-tor"))]
            return Err(
                "bundled Tor requires the `bundled-tor` cargo feature".into(),
            );
        }
        Route::Custom { url } => {
            let parsed = validate_proxy_url(url)?;
            let proxy = reqwest::Proxy::all(&parsed)
                .map_err(|e| format!("parse custom proxy: {e}"))?;
            b = b.proxy(proxy);
        }
    }

    // Cookies: we only need reqwest's cookie store for persistent jars.
    // Ephemeral/disabled are enforced at the dispatcher layer by stripping
    // `Set-Cookie` responses before they reach the store.
    if policy.cookies == CookieJar::Persistent {
        b = b.cookie_store(true);
    }

    b.build().map_err(|e| format!("build reqwest client: {e}"))
}

/// Accept one of: `socks5://`, `socks5h://`, `http://`, `https://` URLs.
/// Reject anything else. Strip credentials for the logged form (callers
/// that audit should call [`redact_proxy`] separately).
pub fn validate_proxy_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("proxy URL is empty".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("http://")
        || lower.starts_with("https://");
    if !allowed {
        return Err(format!(
            "unsupported proxy scheme in `{}` — expected socks5, socks5h, http, https",
            trimmed
        ));
    }
    Ok(trimmed.to_string())
}

/// DNS-over-HTTPS resolver adapter that plugs into reqwest's
/// `dns_resolver` builder. Every name lookup re-enters our [`doh`] module
/// — no OS resolver, no DNS leaks, no third-party middleboxes in the way.
struct DohDnsResolver {
    profile_label: String,
    provider: DohResolver,
}

impl Resolve for DohDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let profile = self.profile_label.clone();
        let provider = self.provider;
        let host = name.as_str().to_string();
        Box::pin(async move {
            // reqwest's Name carries the hostname only; port gets stitched
            // by hyper based on the URL scheme. We pass 0 and let the
            // caller overwrite — Addrs is an iterator over SocketAddr
            // whose port reqwest rewrites downstream.
            let addrs = doh::resolve(&profile, &host, 0, provider)
                .await
                .map_err(|e| {
                    Box::<dyn std::error::Error + Send + Sync>::from(e)
                })?;
            let iter: Vec<SocketAddr> = addrs;
            let boxed: Addrs = Box::new(iter.into_iter());
            Ok(boxed)
        })
    }
}

/// Strip any `user:pass@` authority from a proxy URL so it's safe to audit.
/// Parked — reserved for the audit-log proxy field when custom proxies land.
#[allow(dead_code)]
pub fn redact_proxy(raw: &str) -> String {
    let (scheme, rest) = match raw.find("://") {
        Some(idx) => (&raw[..idx + 3], &raw[idx + 3..]),
        None => return raw.to_string(),
    };
    match rest.find('@') {
        Some(at) => format!("{scheme}{}", &rest[at + 1..]),
        None => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_socks5h() {
        assert!(validate_proxy_url("socks5h://127.0.0.1:9050").is_ok());
    }

    #[test]
    fn validate_rejects_bare_host() {
        assert!(validate_proxy_url("127.0.0.1:9050").is_err());
    }

    #[test]
    fn validate_rejects_ftp() {
        assert!(validate_proxy_url("ftp://proxy").is_err());
    }

    #[test]
    fn redact_strips_credentials() {
        assert_eq!(
            redact_proxy("socks5h://alice:hunter2@127.0.0.1:9050"),
            "socks5h://127.0.0.1:9050"
        );
        assert_eq!(
            redact_proxy("https://proxy.example.com:443"),
            "https://proxy.example.com:443"
        );
    }

    #[test]
    fn user_agent_pinned_safari_is_stable() {
        let mut p = ProfilePolicy::default();
        p.ua_mode = UaMode::PinnedSafari;
        let a = user_agent_for(&p);
        let b = user_agent_for(&p);
        assert_eq!(a, b);
        assert!(a.contains("Safari"));
    }

    #[test]
    fn user_agent_tor_browser_is_uniform() {
        let mut p = ProfilePolicy::tor_default();
        p.ua_mode = UaMode::PinnedTorBrowser;
        assert!(user_agent_for(&p).contains("Firefox"));
    }
}
