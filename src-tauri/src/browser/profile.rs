//! Browser profiles: the policy object every network call is scoped to.
//!
//! The four built-in profiles are:
//!
//! | id          | transport                         | cookies    | JS     | use case                  |
//! |-------------|-----------------------------------|------------|--------|---------------------------|
//! | `default`   | clearnet + DoH                    | persistent | opt-in | everyday research         |
//! | `private`   | clearnet + DoH                    | ephemeral  | opt-in | no-trace single session   |
//! | `tor`       | bundled arti OR system tor OR proxy | ephemeral | off     | true anonymity            |
//! | `custom`    | user-supplied SOCKS5/HTTPS proxy  | ephemeral  | opt-in | VPN / Mullvad / enterprise|
//!
//! Anything beyond this catalogue is authored by the user from Settings.
//! `ProfilePolicy` is designed so every field has a safe, least-privilege
//! default — forgetting to set one should never *relax* posture.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable id for a profile. Not a UUID — these are human-readable so they
/// show up in audit logs, debug output, and file paths (`wv/<profile>/...`).
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProfileId(pub String);

impl ProfileId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn default_() -> Self {
        Self("default".into())
    }

    pub fn private() -> Self {
        Self("private".into())
    }

    pub fn tor() -> Self {
        Self("tor".into())
    }

    /// Parked — reserved for user-defined proxy profiles (Phase 2).
    #[allow(dead_code)]
    pub fn custom() -> Self {
        Self("custom".into())
    }
}

/// The four routes a profile's traffic can take. See the table above.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Route {
    /// Direct connection. DoH suppresses DNS leaks to the local resolver.
    Clearnet {
        /// Which DoH resolver to use. `None` keeps the system resolver (use
        /// only if you explicitly want that).
        doh: Option<DohResolver>,
    },

    /// Bundled `arti-client`. Only meaningful when built with the
    /// `bundled-tor` feature; otherwise the dispatcher will fall back to
    /// [`Route::SystemTor`] or error out.
    BundledTor,

    /// Local SOCKS5 at `host:port` (typically `127.0.0.1:9050`). Resolution
    /// happens remotely (`socks5h`) so DNS cannot leak.
    SystemTor {
        host: String,
        #[ts(type = "number")]
        port: u16,
    },

    /// User-supplied proxy. Parsed and validated in `transport::build_client`.
    /// Accepts `socks5://`, `socks5h://`, `http://`, `https://`. When auth is
    /// baked into the URL we parse it out before logging (never audit'd).
    Custom {
        url: String,
    },
}

/// DNS-over-HTTPS resolvers we support for the clearnet route. We use HTTPS
/// POST/GET to a known endpoint and ignore the system resolver — this kills
/// the ISP-side DNS leak even when TLS is terminated by something downstream.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum DohResolver {
    Cloudflare,
    Quad9,
    Google,
}

impl DohResolver {
    /// Parked — the DoH client plumbing in `transport.rs` encodes the
    /// endpoint directly; this helper exists for diagnostics / UI.
    #[allow(dead_code)]
    pub fn endpoint(&self) -> &'static str {
        match self {
            DohResolver::Cloudflare => "https://cloudflare-dns.com/dns-query",
            DohResolver::Quad9 => "https://dns.quad9.net/dns-query",
            DohResolver::Google => "https://dns.google/dns-query",
        }
    }
}

/// Cookie / storage posture. `Persistent` keeps cookies between runs; the
/// others wipe on profile close or never write at all.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CookieJar {
    /// Written to disk; survives app restart.
    Persistent,
    /// RAM-only; vanishes when the profile is closed.
    Ephemeral,
    /// Drop every `Set-Cookie` response header.
    Disabled,
}

/// Everything the dispatcher needs to make a request-shaped decision. All
/// fields have safe defaults — the defaults for `private` and `tor`
/// tighten the posture further.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProfilePolicy {
    pub id: ProfileId,
    pub label: String,
    pub route: Route,
    pub cookies: CookieJar,

    /// Reader mode disables JS execution entirely — we parse sanitized HTML
    /// only. Sandbox tabs run JS inside WKWebView. The profile picks a
    /// *default* — the tab can still override per-site with user consent.
    pub js_default: JsMode,

    /// Rotate the User-Agent per request (Tor profile) vs pin one per
    /// session (default profile) vs let the system decide (custom).
    pub ua_mode: UaMode,

    /// Strip third-party `Set-Cookie` headers whose origin differs from
    /// the top-level document. Kills the most common tracking primitive.
    pub block_third_party_cookies: bool,

    /// Consult the tracker/ad block list and reject matching requests.
    pub block_trackers: bool,

    /// WebRTC leaks the real IP even under SOCKS. Tor / private disable it.
    pub block_webrtc: bool,

    /// Geolocation, camera, mic, USB, MIDI all denied when true.
    pub deny_sensors: bool,

    /// Record every outbound connection (ts, host, port, ms, bytes) in the
    /// audit log. Disabled by default for `tor` so the log itself is
    /// anonymity-preserving.
    pub audit: bool,

    /// Override the global kill switch for this profile. If the global
    /// kill switch is on and this is `false`, no traffic leaves.
    pub kill_switch_bypass: bool,

    /// Reject any request whose URL is not `https://`. Clearnet profiles
    /// default to `false` so `http://` links from the reader still load;
    /// `private` and `tor` default to `true` so a typo can't leak.
    #[serde(default)]
    pub https_only: bool,

    /// Tor-Browser-style security slider. Governs the injected init-script
    /// (JS off at `Safest`, audio/WASM disabled at `Safer`) and the
    /// reqwest client's TLS posture. Defaults to `Standard`.
    #[serde(default)]
    pub security_level: SecurityLevel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JsMode {
    /// Reader mode only; no JS ever executes.
    Off,
    /// JS is off by default but the user can enable per-site.
    OffByDefault,
    /// JS runs inside sandbox tabs. Reader tabs still never run JS.
    On,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UaMode {
    /// Per-session random pick from a pool of common macOS/iOS UA strings.
    Rotate,
    /// Pinned to a single realistic macOS Safari string.
    PinnedSafari,
    /// Pinned to the Tor Browser UA (Firefox/ESR). Only useful under Tor so
    /// the destination sees the uniform TBB fingerprint.
    PinnedTorBrowser,
    /// Whatever `reqwest` sends by default. Only for debugging.
    System,
}

/// Security Level, modelled directly on Tor Browser's three-way slider.
/// Each step up disables more surface in exchange for breaking more sites.
///
/// - **Standard** — everything permitted that isn't explicitly dangerous.
/// - **Safer** — disable JIT-hot fingerprinting surfaces (WebAssembly,
///   OfflineAudioContext, a few Web APIs), aggressive timing-rounding.
///   Breaks many interactive web apps but leaves most reading sites alone.
/// - **Safest** — no JS at all, in addition to everything Safer does. This
///   is what the Tor Browser "safest" slider gives you: bank vault mode.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SecurityLevel {
    Standard,
    Safer,
    Safest,
}

impl Default for SecurityLevel {
    fn default() -> Self {
        SecurityLevel::Standard
    }
}

impl Default for ProfilePolicy {
    fn default() -> Self {
        Self {
            id: ProfileId::default_(),
            label: "Default".into(),
            route: Route::Clearnet {
                doh: Some(DohResolver::Cloudflare),
            },
            cookies: CookieJar::Persistent,
            js_default: JsMode::OffByDefault,
            ua_mode: UaMode::PinnedSafari,
            block_third_party_cookies: true,
            block_trackers: true,
            block_webrtc: false,
            deny_sensors: true,
            audit: true,
            kill_switch_bypass: false,
            https_only: false,
            security_level: SecurityLevel::Standard,
        }
    }
}

impl ProfilePolicy {
    /// No-trace single-session profile: clearnet + DoH, ephemeral storage,
    /// locked-down sensors, WebRTC blocked, HTTPS-only.
    pub fn private_default() -> Self {
        Self {
            id: ProfileId::private(),
            label: "Private".into(),
            cookies: CookieJar::Ephemeral,
            js_default: JsMode::OffByDefault,
            ua_mode: UaMode::Rotate,
            block_webrtc: true,
            audit: false,
            https_only: true,
            security_level: SecurityLevel::Safer,
            ..Self::default()
        }
    }

    /// Tor profile. JS off by default (Tor Browser's safest level parallel).
    /// No audit log — we don't want to even record which .onion the user
    /// visited inside our own store.
    pub fn tor_default() -> Self {
        let route = if cfg!(feature = "bundled-tor") {
            Route::BundledTor
        } else {
            Route::SystemTor {
                host: "127.0.0.1".into(),
                port: 9050,
            }
        };
        Self {
            id: ProfileId::tor(),
            label: "Tor".into(),
            route,
            cookies: CookieJar::Ephemeral,
            js_default: JsMode::Off,
            ua_mode: UaMode::PinnedTorBrowser,
            block_third_party_cookies: true,
            block_trackers: true,
            block_webrtc: true,
            deny_sensors: true,
            audit: false,
            kill_switch_bypass: false,
            // Tor allows `.onion` which is plaintext HTTP by convention,
            // so we can't flip `https_only` on unconditionally. Safer
            // level still guards JIT-hot fingerprint surfaces.
            https_only: false,
            security_level: SecurityLevel::Safer,
        }
    }

    /// Custom proxy profile — the dispatcher populates `route` from user
    /// settings. This constructor only gives you the defaults for *the
    /// rest* of the policy. Parked — wire-up with `browser_profiles_upsert`
    /// custom-proxy UX is Phase 2.
    #[allow(dead_code)]
    pub fn custom_default(url: String) -> Self {
        Self {
            id: ProfileId::custom(),
            label: "Custom Proxy".into(),
            route: Route::Custom { url },
            cookies: CookieJar::Ephemeral,
            js_default: JsMode::OffByDefault,
            ua_mode: UaMode::PinnedSafari,
            block_webrtc: true,
            audit: true,
            https_only: true,
            security_level: SecurityLevel::Safer,
            ..Self::default()
        }
    }

    /// One-word posture tag for the tab chrome: `CLEAR`, `TOR`, `PRIVATE`,
    /// `PROXY`. Purely cosmetic; not used for routing decisions.
    pub fn route_tag(&self) -> &'static str {
        match &self.route {
            Route::Clearnet { .. } => {
                if self.cookies == CookieJar::Persistent {
                    "CLEAR"
                } else {
                    "PRIVATE"
                }
            }
            Route::BundledTor | Route::SystemTor { .. } => "TOR",
            Route::Custom { .. } => "PROXY",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_has_safe_posture() {
        let d = ProfilePolicy::default();
        assert!(d.block_third_party_cookies);
        assert!(d.block_trackers);
        assert!(d.deny_sensors);
        assert_eq!(d.js_default, JsMode::OffByDefault);
    }

    #[test]
    fn tor_profile_never_audits() {
        let t = ProfilePolicy::tor_default();
        assert!(!t.audit, "Tor audit log leaks visit history — must stay off");
        assert_eq!(t.js_default, JsMode::Off);
        assert!(t.block_webrtc);
    }

    #[test]
    fn private_wipes_cookies_and_blocks_webrtc() {
        let p = ProfilePolicy::private_default();
        assert_eq!(p.cookies, CookieJar::Ephemeral);
        assert!(p.block_webrtc);
    }

    #[test]
    fn route_tag_distinguishes_persistent_vs_private_clearnet() {
        let mut p = ProfilePolicy::default();
        assert_eq!(p.route_tag(), "CLEAR");
        p.cookies = CookieJar::Ephemeral;
        assert_eq!(p.route_tag(), "PRIVATE");
    }

    #[test]
    fn default_security_level_is_standard() {
        assert_eq!(ProfilePolicy::default().security_level, SecurityLevel::Standard);
    }

    #[test]
    fn private_and_tor_default_to_safer() {
        assert_eq!(ProfilePolicy::private_default().security_level, SecurityLevel::Safer);
        assert_eq!(ProfilePolicy::tor_default().security_level, SecurityLevel::Safer);
    }

    #[test]
    fn private_default_enforces_https_only() {
        assert!(ProfilePolicy::private_default().https_only);
    }

    #[test]
    fn tor_default_does_not_enforce_https_only() {
        // .onion sites over Tor are plaintext-HTTP by convention; the
        // circuit provides the encryption. HTTPS-Only on Tor would break
        // onion browsing.
        assert!(!ProfilePolicy::tor_default().https_only);
    }

    #[test]
    fn custom_profile_defaults_to_safer_and_https_only() {
        let p = ProfilePolicy::custom_default("socks5h://127.0.0.1:9050".into());
        assert_eq!(p.security_level, SecurityLevel::Safer);
        assert!(p.https_only);
    }
}
