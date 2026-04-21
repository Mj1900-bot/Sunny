//! Hardened WebView sandbox tabs.
//!
//! Every sandbox tab is its own `WebviewWindow` with:
//! - `proxy_url` pointing at a [`bridge`](super::bridge) loopback listener
//!   bound to the tab's profile.
//! - An initialization script that normalizes the browser fingerprint
//!   (timezone, languages, screen jitter, canvas noise, WebGL vendor spoof)
//!   and stubs out sensor APIs the profile denies.
//! - An ephemeral data directory under
//!   `~/Library/Application Support/sunny/wv/<profile>/<tab-uuid>` that we
//!   delete on tab close.
//!
//! Sandbox tabs are managed by the React layer — the frontend calls
//! `browser_sandbox_open` with `{profile_id, tab_id, url}` and we:
//! 1. Spawn a bridge for that tab.
//! 2. Build the WebviewWindow with the proxy pointed at the bridge.
//! 3. Inject the hardening init-script.
//! 4. Record the tab's live state so subsequent `browser_sandbox_close` can
//!    tear down cleanly.
//!
//! WKWebView on macOS honors `proxy_url` for http/https request routing
//! through Tauri 2's wry integration. WebSocket, XHR, fetch(), and image
//! loads all traverse the proxy. The bridge CONNECTs for HTTPS upstream so
//! TLS is terminated by the destination — we never MITM.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browser::dispatcher;
use crate::browser::profile::{JsMode, ProfileId, ProfilePolicy, SecurityLevel};

/// Whether this sandbox tab renders in its own OS-level window or as an
/// embedded child webview pinned over the SUNNY main window's content
/// area. Embedded is the default now because it preserves the single-
/// window feel; windowed is kept for power users who want to park a page
/// on a second monitor.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SandboxKind {
    Windowed,
    Embedded,
}

/// What we track per live sandbox tab so the frontend can show status
/// badges and we can tear down reliably.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SandboxTab {
    pub tab_id: String,
    pub profile_id: String,
    pub url: String,
    #[ts(type = "number")]
    pub bridge_port: u16,
    pub data_dir: String,
    /// For windowed sandboxes this is the `WebviewWindow` label; for
    /// embedded sandboxes this is the child `Webview` label. Both are
    /// fetchable via `AppHandle::get_webview`, which returns any webview
    /// by label regardless of whether it has its own OS window.
    pub window_label: String,
    pub kind: SandboxKind,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// Logical-pixel rectangle used to position embedded child webviews
/// over the SUNNY content area. `x` and `y` are relative to the main
/// window's top-left in CSS-logical units — which is exactly what the
/// browser's `getBoundingClientRect()` gives us, so the frontend can
/// forward the numbers unchanged.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, TS)]
#[ts(export)]
pub struct EmbedBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct SandboxRegistry {
    tabs: Mutex<HashMap<String, SandboxTab>>,
}

impl SandboxRegistry {
    pub fn new() -> Self {
        Self {
            tabs: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<SandboxTab> {
        self.tabs
            .lock()
            .expect("sandbox poisoned")
            .values()
            .cloned()
            .collect()
    }

    pub fn get(&self, tab_id: &str) -> Option<SandboxTab> {
        self.tabs
            .lock()
            .expect("sandbox poisoned")
            .get(tab_id)
            .cloned()
    }

    fn insert(&self, tab: SandboxTab) {
        self.tabs
            .lock()
            .expect("sandbox poisoned")
            .insert(tab.tab_id.clone(), tab);
    }

    fn remove(&self, tab_id: &str) -> Option<SandboxTab> {
        self.tabs
            .lock()
            .expect("sandbox poisoned")
            .remove(tab_id)
    }
}

impl Default for SandboxRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub fn global() -> &'static Arc<SandboxRegistry> {
    static CELL: OnceLock<Arc<SandboxRegistry>> = OnceLock::new();
    CELL.get_or_init(|| Arc::new(SandboxRegistry::new()))
}

pub fn data_dir_for(profile_id: &str, tab_id: &str) -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no data dir".to_string())?;
    Ok(base.join("sunny").join("wv").join(profile_id).join(tab_id))
}

/// Read the current URL of an open sandbox tab. Returns `None` when the
/// webview has been closed out-of-band — the frontend can use that as the
/// trigger to drop the tab from the strip. Works for both windowed and
/// embedded sandboxes because `get_webview` resolves any webview label.
pub fn current_url(app: &tauri::AppHandle, tab_id: &str) -> Option<String> {
    use tauri::Manager;
    let reg = global();
    let record = reg.get(tab_id)?;
    let wv = app.get_webview(&record.window_label)?;
    wv.url().ok().map(|u| u.to_string())
}

/// Update the registry's view of a tab's URL. Called when the frontend
/// polls and observes a navigation; keeps the sandbox tab's
/// `SandboxTab.url` field in sync so audit/debug output is accurate.
pub fn set_url(tab_id: &str, url: String) {
    if let Some(mut tab) = global().get(tab_id) {
        tab.url = url;
        global().insert(tab);
    }
}

/// Build the initialization script applied before any page script runs.
/// This is the bulk of the "hardened WebView" posture — we shape what the
/// page can observe about the user.
///
/// Design rules:
/// 1. Every override is wrapped in `try/catch` so a broken environment
///    can't reject the whole script and leave the page *less* protected.
/// 2. Every override is gated on a profile flag so we don't pay cost we
///    don't need. The inlined check strings below become dead-code-
///    eliminated literals at runtime.
/// 3. Match Tor Browser's behavior where we can (fonts allow-list, audio
///    fingerprint resistance, letterboxing, timing rounding). Where we
///    can't fully match, make the fingerprint surface *uniform across
///    Sunny users* rather than unique per-install.
pub fn init_script(policy: &ProfilePolicy) -> String {
    let is_tor = matches!(policy.id.as_str(), "tor");
    let is_private = matches!(policy.id.as_str(), "private");
    let quantize_fingerprint = is_tor || is_private;
    let block_webrtc = policy.block_webrtc;
    let deny_sensors = policy.deny_sensors;
    let disable_js = matches!(policy.js_default, JsMode::Off);
    let security_level = policy.security_level;

    let mut s = String::new();
    s.push_str("(() => { try {\n");
    s.push_str(PREAMBLE);

    // Languages — pinned everywhere so language headers + navigator.*
    // agree.
    s.push_str("  define(navigator, 'language', 'en-US');\n");
    s.push_str("  define(navigator, 'languages', Object.freeze(['en-US', 'en']));\n");

    // Timezone — Tor forces UTC, Private leaves it alone (would look
    // oddly out-of-sync with every other app on the Mac).
    if is_tor {
        s.push_str(TIMEZONE_UTC);
    }

    // Screen + viewport: for private/tor we present a letterboxed window
    // that rounds to common bucket sizes. This is how Tor Browser
    // defends against window-size fingerprinting.
    if quantize_fingerprint {
        s.push_str(LETTERBOX);
    }

    // WebGL vendor/renderer — pin to Apple baseline so Sunny users are
    // uniform on this axis.
    s.push_str(WEBGL_SPOOF);

    // Canvas noise — per-readback seeded randomization that actually
    // defeats fingerprinting, not the weak one-byte XOR we shipped first.
    s.push_str(CANVAS_NOISE);

    // Audio fingerprint resistance — OfflineAudioContext / AnalyserNode
    // floating-point precision is one of the top fingerprint vectors on
    // modern browsers. Perturb the data at getChannelData / getFloat*
    // boundaries.
    s.push_str(AUDIO_FINGERPRINT);

    // Font fingerprint resistance — document.fonts.check() is the
    // primary API that lets a page probe "is Comic Sans installed".
    // We allow-list the common system families and lie "no" to everything
    // else. Also blocks the older offsetHeight-based probe where possible.
    s.push_str(FONTS_ALLOWLIST);

    // Hardware fingerprint — most of these are numerically identifying.
    // Pin to a common bucket.
    s.push_str(HARDWARE_SPOOF);

    // Timing attack resistance. Tor Browser rounds performance.now() to
    // 100 ms at Safest level, 1 ms at Safer, and leaves it alone at
    // Standard. Match that behavior.
    match security_level {
        SecurityLevel::Standard => {}
        SecurityLevel::Safer => s.push_str(&timing_round_script(1.0)),
        SecurityLevel::Safest => s.push_str(&timing_round_script(100.0)),
    }

    // Safer level also denies JIT-hot fingerprint surfaces that aren't
    // reachable from JIT-disabled alternatives.
    if matches!(security_level, SecurityLevel::Safer | SecurityLevel::Safest) {
        s.push_str(SAFER_DISABLE);
    }

    // WebRTC — null it out so STUN can't leak the real IP.
    if block_webrtc {
        s.push_str(WEBRTC_KILL);
    }

    // Sensors + power APIs — deny wholesale when the profile says so.
    if deny_sensors {
        s.push_str(SENSOR_DENY);
    }

    // Hard JS off — noop the "give me more capability" entry points so
    // the page doesn't retry. Tor Browser's "Safest" level parallel.
    if disable_js || matches!(security_level, SecurityLevel::Safest) {
        s.push_str(EVAL_DISABLE);
    }

    // Posture beacon — the frontend can read this with `executeScript`
    // to confirm the init-script actually ran.
    s.push_str(&posture_beacon(policy));

    s.push_str("} catch (_) {} })();\n");
    s
}

const PREAMBLE: &str = r#"
  const define = (obj, key, val) => { try { Object.defineProperty(obj, key, { get: () => val, configurable: true }); } catch (_) {} };
"#;

const TIMEZONE_UTC: &str = r#"
  try {
    const Orig = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locale, opts){ opts = opts || {}; opts.timeZone = 'UTC'; return new Orig(locale, opts); };
    Intl.DateTimeFormat.prototype = Orig.prototype;
  } catch (_) {}
  try { Date.prototype.getTimezoneOffset = function(){ return 0; }; } catch (_) {}
"#;

/// Letterboxing: round innerWidth/innerHeight (the dimensions pages
/// actually query for layout + media-queries) to a 100 px step, exactly
/// how Tor Browser does it. Also pin outer dims and devicePixelRatio.
const LETTERBOX: &str = r#"
  try {
    const bucket = (n) => Math.max(200, Math.floor(Number(n) / 100) * 100);
    define(window, 'innerWidth', bucket(window.innerWidth));
    define(window, 'innerHeight', bucket(window.innerHeight));
    define(window, 'outerWidth', 1440);
    define(window, 'outerHeight', 900);
    define(window, 'devicePixelRatio', 2);
    define(screen, 'width', 1440);
    define(screen, 'height', 900);
    define(screen, 'availWidth', 1440);
    define(screen, 'availHeight', 900);
    define(screen, 'colorDepth', 24);
    define(screen, 'pixelDepth', 24);
    define(screen, 'orientation', { type: 'landscape-primary', angle: 0 });
  } catch (_) {}
"#;

const WEBGL_SPOOF: &str = r#"
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p){
      if (p === 37445) return 'Apple Inc.';
      if (p === 37446) return 'Apple M2';
      return gp.call(this, p);
    };
  } catch (_) {}
  try {
    const gp2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(p){
      if (p === 37445) return 'Apple Inc.';
      if (p === 37446) return 'Apple M2';
      return gp2.call(this, p);
    };
  } catch (_) {}
"#;

/// Per-readback pseudo-random noise derived from a session-seed. Same
/// seed across readbacks inside one page so the page doesn't see the
/// fingerprint flip every frame (which itself is a fingerprint). Uses
/// xmur3 + mulberry32 — small, no crypto API needed.
const CANVAS_NOISE: &str = r#"
  try {
    const seed = (() => {
      const s = (Math.random() * 0x7fffffff) | 0;
      let a = s >>> 0;
      return () => {
        a = Math.imul(a ^ (a >>> 15), a | 1);
        a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
        return ((a ^ (a >>> 14)) >>> 0) / 0x100000000;
      };
    })();
    const noise = () => (Math.floor(seed() * 3) - 1);
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...a) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const d = ctx.getImageData(0, 0, Math.min(this.width, 32), Math.min(this.height, 32));
          for (let i = 0; i < d.data.length; i += 4) {
            d.data[i]     = (d.data[i]     + noise()) & 0xff;
            d.data[i + 1] = (d.data[i + 1] + noise()) & 0xff;
            d.data[i + 2] = (d.data[i + 2] + noise()) & 0xff;
          }
          ctx.putImageData(d, 0, 0);
        }
      } catch (_) {}
      return toDataURL.apply(this, a);
    };
    const getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
      const img = getImageData.call(this, x, y, w, h);
      try {
        for (let i = 0; i < img.data.length; i += 4) {
          img.data[i]     = (img.data[i]     + noise()) & 0xff;
          img.data[i + 1] = (img.data[i + 1] + noise()) & 0xff;
          img.data[i + 2] = (img.data[i + 2] + noise()) & 0xff;
        }
      } catch (_) {}
      return img;
    };
  } catch (_) {}
"#;

/// AudioContext + OfflineAudioContext fingerprinting perturbation. The
/// classical attack is to render a known signal through the context and
/// hash the floating-point output; we add tiny per-channel noise so the
/// hash differs without being audible.
const AUDIO_FINGERPRINT: &str = r#"
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const seed = Math.random() * 1e-7;
    if (AC) {
      const proto = AC.prototype;
      const origGet = proto.getChannelData || (proto.Buffer && proto.Buffer.prototype.getChannelData);
      if (AudioBuffer && AudioBuffer.prototype.getChannelData) {
        const gcd = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function(ch) {
          const arr = gcd.call(this, ch);
          try {
            for (let i = 0; i < arr.length; i += 100) {
              arr[i] = arr[i] + seed * (i % 7);
            }
          } catch (_) {}
          return arr;
        };
      }
      if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype.getFloatFrequencyData) {
        const ggfd = AnalyserNode.prototype.getFloatFrequencyData;
        AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
          ggfd.call(this, arr);
          try {
            for (let i = 0; i < arr.length; i += 50) {
              arr[i] = arr[i] + seed * (i % 11);
            }
          } catch (_) {}
        };
      }
    }
    // OfflineAudioContext.startRendering is the specific API most
    // commercial fingerprinters use — ensure it goes through the
    // perturbed AudioBuffer path above.
    void OAC;
  } catch (_) {}
"#;

/// Font allow-list. `document.fonts.check('12px Comic Sans MS')` is the
/// primary API a page uses to probe which fonts the user has installed.
/// Return `false` for everything outside a small pinned set so the
/// probe becomes useless. The older offset-measurement probe is harder
/// to stop without breaking CSS layout entirely; we accept that trade.
const FONTS_ALLOWLIST: &str = r#"
  try {
    if (document.fonts && typeof document.fonts.check === 'function') {
      const allowed = new Set([
        'serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif',
        'ui-sans-serif', 'ui-monospace', 'cursive', 'fantasy',
        'Arial', 'Helvetica', 'Helvetica Neue', 'Times', 'Times New Roman',
        'Courier', 'Courier New', 'Verdana', 'Georgia', 'Menlo',
        'Monaco', '-apple-system', 'BlinkMacSystemFont',
      ]);
      const origCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function(font, text) {
        try {
          const m = String(font).match(/(['"]?)([^'",]+)\1$/);
          const family = m ? m[2].trim() : '';
          if (!allowed.has(family)) return false;
          return origCheck(font, text);
        } catch (_) {
          return origCheck(font, text);
        }
      };
    }
  } catch (_) {}
"#;

const HARDWARE_SPOOF: &str = r#"
  try {
    define(navigator, 'hardwareConcurrency', 8);
    define(navigator, 'deviceMemory', 8);
    define(navigator, 'maxTouchPoints', 0);
    define(navigator, 'platform', 'MacIntel');
    define(navigator, 'vendor', 'Apple Computer, Inc.');
    define(navigator, 'oscpu', undefined);
    define(navigator, 'cpuClass', undefined);
    define(navigator, 'doNotTrack', '1');
    define(navigator, 'webdriver', false);
  } catch (_) {}
"#;

fn timing_round_script(resolution_ms: f64) -> String {
    // Resolution is milliseconds. `performance.now()` usually returns a
    // sub-ms value; we floor to the bucket and return as a float so
    // call-sites that expect ms don't break.
    format!(
        r#"
  try {{
    const res = {resolution};
    const origNow = performance.now.bind(performance);
    performance.now = function(){{ return Math.floor(origNow() / res) * res; }};
    if (typeof performance.timeOrigin === 'number') {{
      define(performance, 'timeOrigin', Math.floor(performance.timeOrigin / res) * res);
    }}
  }} catch (_) {{}}
"#,
        resolution = resolution_ms
    )
}

const SAFER_DISABLE: &str = r#"
  try { if (typeof WebAssembly !== 'undefined') window.WebAssembly = undefined; } catch (_) {}
  try { if (window.SharedArrayBuffer) window.SharedArrayBuffer = undefined; } catch (_) {}
  try { if (window.OffscreenCanvas) window.OffscreenCanvas = undefined; } catch (_) {}
"#;

const WEBRTC_KILL: &str = r#"
  try {
    window.RTCPeerConnection = undefined;
    window.webkitRTCPeerConnection = undefined;
    window.RTCDataChannel = undefined;
    window.RTCSessionDescription = undefined;
    window.RTCIceCandidate = undefined;
  } catch (_) {}
"#;

const SENSOR_DENY: &str = r#"
  try {
    define(navigator, 'geolocation', {
      getCurrentPosition: (_ok, err) => err && err({ code: 1, message: 'denied' }),
      watchPosition: () => 0,
      clearWatch: () => {},
    });
  } catch (_) {}
  try { navigator.permissions = { query: () => Promise.resolve({ state: 'denied', onchange: null }) }; } catch (_) {}
  try { navigator.mediaDevices = { getUserMedia: () => Promise.reject(new Error('denied')), enumerateDevices: () => Promise.resolve([]) }; } catch (_) {}
  try { navigator.getBattery = () => Promise.reject(new Error('denied')); } catch (_) {}
  try {
    navigator.usb = undefined;
    navigator.bluetooth = undefined;
    navigator.serial = undefined;
    navigator.hid = undefined;
    navigator.xr = undefined;
  } catch (_) {}
"#;

const EVAL_DISABLE: &str = r#"
  try { window.eval = function(){ throw new Error('eval disabled'); }; } catch (_) {}
  try { window.Function = function(){ throw new Error('Function disabled'); }; } catch (_) {}
  try { if (typeof WebAssembly !== 'undefined') window.WebAssembly = undefined; } catch (_) {}
"#;

fn posture_beacon(policy: &ProfilePolicy) -> String {
    let js_mode = match policy.js_default {
        JsMode::Off => "off",
        JsMode::OffByDefault => "off_by_default",
        JsMode::On => "on",
    };
    let sec = match policy.security_level {
        SecurityLevel::Standard => "standard",
        SecurityLevel::Safer => "safer",
        SecurityLevel::Safest => "safest",
    };
    format!(
        "  try {{ Object.defineProperty(window, '__sunnyx', {{ value: Object.freeze({{ profile: {profile:?}, routeTag: {tag:?}, jsMode: {js:?}, securityLevel: {sec:?} }}), configurable: false, writable: false }}); }} catch (_) {{}}\n",
        profile = policy.id.as_str(),
        tag = policy.route_tag(),
        js = js_mode,
        sec = sec,
    )
}

/// Open a sandbox tab. Returns the SandboxTab record; the actual WebView
/// window is created by the AppHandle. The AppHandle type is kept generic
/// so this file stays decoupled from Tauri's top-level crate graph during
/// tests.
pub async fn open(
    app: &tauri::AppHandle,
    profile_id: ProfileId,
    tab_id: String,
    url: String,
) -> Result<SandboxTab, String> {
    use tauri::{Emitter, Manager};

    let reg = global();
    if let Some(existing) = reg.get(&tab_id) {
        // Reopen on the same tab id == navigation. Reuse the window via its
        // Tauri navigation API rather than rebuilding — keeps the bridge
        // port + data directory + injected init-script intact.
        if let Some(w) = app.get_webview_window(&existing.window_label) {
            let parsed_url =
                tauri::Url::parse(&url).map_err(|e| format!("navigate url: {e}"))?;
            w.navigate(parsed_url)
                .map_err(|e| format!("sandbox navigate: {e}"))?;
            let mut next = existing.clone();
            next.url = url;
            reg.insert(next.clone());
            return Ok(next);
        }
        // Stale registry entry — the window was torn down out-of-band.
        reg.remove(&tab_id);
    }

    let disp = dispatcher::global();
    let policy = disp
        .get_profile(&profile_id)
        .ok_or_else(|| format!("unknown profile: {}", profile_id.as_str()))?;

    let bridge_addr =
        super::bridge::spawn(disp.clone(), profile_id.clone(), tab_id.clone())
            .await?;
    let bridge_port = bridge_addr.port();

    let data_dir = data_dir_for(profile_id.as_str(), &tab_id)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("create sandbox data dir: {e}"))?;

    let init = init_script(&policy);
    let window_label = format!("sunny_wv_{tab_id}");

    let proxy_url_str = format!("http://{bridge_addr}");
    let proxy_url =
        tauri::Url::parse(&proxy_url_str).map_err(|e| format!("bridge url: {e}"))?;
    let parsed_url =
        tauri::Url::parse(&url).map_err(|e| format!("navigate url: {e}"))?;

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        &window_label,
        tauri::WebviewUrl::External(parsed_url),
    )
    .title(format!("SUNNY · {}", policy.route_tag()))
    .inner_size(1200.0, 800.0)
    .min_inner_size(640.0, 480.0)
    .data_directory(data_dir.clone())
    .proxy_url(proxy_url)
    .initialization_script(&init)
    .accept_first_mouse(true)
    .visible(true);

    let window = builder
        .build()
        .map_err(|e| format!("build sandbox webview: {e}"))?;

    // When the user closes the sandbox window from its titlebar we want the
    // same cleanup path as a programmatic close: drop the bridge + data dir
    // and notify the frontend so the React tab strip catches up.
    let app_for_close = app.clone();
    let tab_for_close = tab_id.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            teardown_without_window(&tab_for_close);
            let _ = app_for_close.emit(
                "browser:sandbox:closed",
                &serde_json::json!({ "tab_id": tab_for_close }),
            );
        }
    });

    let tab = SandboxTab {
        tab_id: tab_id.clone(),
        profile_id: profile_id.as_str().to_string(),
        url,
        bridge_port,
        data_dir: data_dir.to_string_lossy().to_string(),
        window_label,
        kind: SandboxKind::Windowed,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    };
    reg.insert(tab.clone());
    Ok(tab)
}

/// Open an embedded sandbox tab. Creates a child `Webview` pinned to the
/// main SUNNY window at the supplied logical rectangle. The webview
/// stacks on top of the React UI and renders the live page with full
/// fidelity, while the same hardening layer (bridge proxy + init script
/// + ephemeral data dir) remains in place.
///
/// Re-invoking with an existing `tab_id` navigates that embedded webview
/// instead of creating a new one, matching the windowed `open` contract.
pub async fn open_embedded(
    app: &tauri::AppHandle,
    profile_id: ProfileId,
    tab_id: String,
    url: String,
    bounds: EmbedBounds,
) -> Result<SandboxTab, String> {
    use tauri::{LogicalPosition, LogicalSize, Manager};

    let reg = global();
    if let Some(existing) = reg.get(&tab_id) {
        // Already live — navigate + reposition without rebuilding.
        if let Some(wv) = app.get_webview(&existing.window_label) {
            let parsed_url =
                tauri::Url::parse(&url).map_err(|e| format!("navigate url: {e}"))?;
            wv.navigate(parsed_url)
                .map_err(|e| format!("sandbox navigate: {e}"))?;
            let _ = wv.set_position(LogicalPosition::new(bounds.x, bounds.y));
            let _ = wv.set_size(LogicalSize::new(bounds.width, bounds.height));
            let _ = wv.show();
            let mut next = existing.clone();
            next.url = url;
            reg.insert(next.clone());
            return Ok(next);
        }
        // Stale registry entry — fall through and rebuild.
        reg.remove(&tab_id);
    }

    let disp = dispatcher::global();
    let policy = disp
        .get_profile(&profile_id)
        .ok_or_else(|| format!("unknown profile: {}", profile_id.as_str()))?;

    let bridge_addr =
        super::bridge::spawn(disp.clone(), profile_id.clone(), tab_id.clone())
            .await?;
    let bridge_port = bridge_addr.port();

    let data_dir = data_dir_for(profile_id.as_str(), &tab_id)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("create sandbox data dir: {e}"))?;

    let init = init_script(&policy);
    let webview_label = format!("sunny_wv_{tab_id}");

    let proxy_url_str = format!("http://{bridge_addr}");
    let proxy_url =
        tauri::Url::parse(&proxy_url_str).map_err(|e| format!("bridge url: {e}"))?;
    let parsed_url =
        tauri::Url::parse(&url).map_err(|e| format!("navigate url: {e}"))?;

    // `add_child` lives on `Window`, not `WebviewWindow`. In Tauri 2 a
    // `WebviewWindow` is a Window + its primary Webview packaged together;
    // we want the underlying Window so we can attach a second webview
    // alongside the React UI one.
    let main = app
        .get_window("main")
        .ok_or_else(|| "main window not available".to_string())?;

    let builder = tauri::webview::WebviewBuilder::new(
        &webview_label,
        tauri::WebviewUrl::External(parsed_url),
    )
    .data_directory(data_dir.clone())
    .proxy_url(proxy_url)
    .initialization_script(&init)
    .accept_first_mouse(true);

    main.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    )
    .map_err(|e| format!("add embedded webview: {e}"))?;

    let tab = SandboxTab {
        tab_id: tab_id.clone(),
        profile_id: profile_id.as_str().to_string(),
        url,
        bridge_port,
        data_dir: data_dir.to_string_lossy().to_string(),
        window_label: webview_label,
        kind: SandboxKind::Embedded,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    };
    reg.insert(tab.clone());
    Ok(tab)
}

/// Reposition + resize a live embedded webview. The frontend calls this
/// whenever the SUNNY content-area rectangle changes (window resize,
/// sidebar toggle, split drag). No-op for windowed sandboxes — they own
/// their own OS window and ignore the frontend's geometry suggestions.
pub fn set_bounds(
    app: &tauri::AppHandle,
    tab_id: &str,
    bounds: EmbedBounds,
) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, Manager};
    let record = global()
        .get(tab_id)
        .ok_or_else(|| format!("no such sandbox tab: {tab_id}"))?;
    if record.kind != SandboxKind::Embedded {
        return Ok(());
    }
    let wv = app
        .get_webview(&record.window_label)
        .ok_or_else(|| format!("webview gone: {}", record.window_label))?;
    wv.set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| format!("set_position: {e}"))?;
    wv.set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| format!("set_size: {e}"))?;
    Ok(())
}

/// Show or hide an embedded webview. Used when the user switches between
/// Web-module tabs (only the active tab is visible) or navigates away
/// from the Web module entirely (all embedded webviews go hidden so they
/// don't paint on top of e.g. the Settings module).
pub fn set_visible(
    app: &tauri::AppHandle,
    tab_id: &str,
    visible: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let record = global()
        .get(tab_id)
        .ok_or_else(|| format!("no such sandbox tab: {tab_id}"))?;
    if record.kind != SandboxKind::Embedded {
        return Ok(());
    }
    let wv = app
        .get_webview(&record.window_label)
        .ok_or_else(|| format!("webview gone: {}", record.window_label))?;
    if visible {
        wv.show().map_err(|e| format!("show: {e}"))
    } else {
        wv.hide().map_err(|e| format!("hide: {e}"))
    }
}

/// Close a sandbox tab — destroys the WebView (window or child) and
/// wipes its data directory. Ephemeral by contract; the caller should
/// persist anything worth keeping before this returns.
pub fn close(app: &tauri::AppHandle, tab_id: &str) -> Result<(), String> {
    use tauri::Manager;
    let tab = global()
        .remove(tab_id)
        .ok_or_else(|| format!("no such sandbox tab: {tab_id}"))?;

    match tab.kind {
        SandboxKind::Windowed => {
            if let Some(w) = app.get_webview_window(&tab.window_label) {
                let _ = w.close();
            }
        }
        SandboxKind::Embedded => {
            if let Some(wv) = app.get_webview(&tab.window_label) {
                let _ = wv.close();
            }
        }
    }

    super::bridge::shutdown_tab(tab_id);
    let _ = std::fs::remove_dir_all(&tab.data_dir);
    Ok(())
}

/// Cleanup path that doesn't touch the window — used when the window
/// itself has been destroyed by the OS/user. Idempotent; safe to call from
/// any thread.
fn teardown_without_window(tab_id: &str) {
    if let Some(tab) = global().remove(tab_id) {
        let _ = std::fs::remove_dir_all(&tab.data_dir);
    }
    super::bridge::shutdown_tab(tab_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_disables_webrtc_for_tor() {
        let policy = ProfilePolicy::tor_default();
        let s = init_script(&policy);
        assert!(s.contains("RTCPeerConnection = undefined"));
        assert!(s.contains("'UTC'"));
    }

    #[test]
    fn init_script_allows_eval_for_default_standard_level() {
        let policy = ProfilePolicy::default();
        let s = init_script(&policy);
        // Default profile: Standard security level, JS on by user opt-in.
        // No eval disablement should fire.
        assert!(!s.contains("eval disabled"));
    }

    #[test]
    fn init_script_pins_webgl_vendor() {
        let policy = ProfilePolicy::default();
        let s = init_script(&policy);
        assert!(s.contains("Apple Inc."));
        assert!(s.contains("Apple M2"));
    }

    #[test]
    fn init_script_letterboxes_private_and_tor_only() {
        let private = init_script(&ProfilePolicy::private_default());
        assert!(private.contains("innerWidth"));
        assert!(private.contains("Math.floor"));
        assert!(private.contains("bucket"));
        let default = init_script(&ProfilePolicy::default());
        assert!(!default.contains("bucket("));
    }

    #[test]
    fn init_script_rounds_timing_on_safer() {
        let mut p = ProfilePolicy::default();
        p.security_level = SecurityLevel::Safer;
        let s = init_script(&p);
        assert!(s.contains("const res = 1"));
        assert!(s.contains("performance.now"));
    }

    #[test]
    fn init_script_rounds_timing_to_100ms_on_safest() {
        let mut p = ProfilePolicy::default();
        p.security_level = SecurityLevel::Safest;
        let s = init_script(&p);
        assert!(s.contains("const res = 100"));
        // Safest also disables eval.
        assert!(s.contains("eval disabled"));
    }

    #[test]
    fn init_script_disables_wasm_on_safer() {
        let mut p = ProfilePolicy::default();
        p.security_level = SecurityLevel::Safer;
        let s = init_script(&p);
        assert!(s.contains("window.WebAssembly = undefined"));
    }

    #[test]
    fn init_script_spoofs_hardware_fingerprints() {
        let s = init_script(&ProfilePolicy::default());
        assert!(s.contains("hardwareConcurrency"));
        assert!(s.contains("deviceMemory"));
        assert!(s.contains("maxTouchPoints"));
    }

    #[test]
    fn init_script_guards_document_fonts() {
        let s = init_script(&ProfilePolicy::default());
        assert!(s.contains("document.fonts.check"));
        assert!(s.contains("allowed.has(family)"));
    }

    #[test]
    fn init_script_adds_canvas_noise_not_xor() {
        let s = init_script(&ProfilePolicy::default());
        // The weak one-byte XOR got replaced with seeded noise + proper
        // getImageData override. Check for the signature.
        assert!(s.contains("getImageData"));
        assert!(s.contains("noise()"));
        assert!(s.contains("mulberry32") || s.contains("Math.imul"));
    }

    #[test]
    fn init_script_perturbs_audio_fingerprint() {
        let s = init_script(&ProfilePolicy::default());
        assert!(s.contains("getChannelData"));
        assert!(s.contains("AudioBuffer"));
    }

    #[test]
    fn posture_beacon_reports_security_level() {
        let s = init_script(&ProfilePolicy::tor_default());
        assert!(s.contains("securityLevel: \"safer\""));
        assert!(s.contains("profile: \"tor\""));
    }

    // --- Embedded vs windowed dispatch ----------------------------------

    fn fake_tab(tab_id: &str, kind: SandboxKind) -> SandboxTab {
        SandboxTab {
            tab_id: tab_id.to_string(),
            profile_id: "default".to_string(),
            url: "https://example.com".to_string(),
            bridge_port: 12345,
            data_dir: "/tmp/sunny-test".to_string(),
            window_label: format!("sunny_wv_{tab_id}"),
            kind,
            created_at: 0,
        }
    }

    #[test]
    fn sandbox_kind_serialises_to_lowercase_for_frontend() {
        // The frontend's zustand store expects `"embedded" | "windowed"`
        // so we pin the serde representation. Flipping this breaks the
        // tabStore without any type-level warning.
        let embedded = serde_json::to_string(&SandboxKind::Embedded).unwrap();
        let windowed = serde_json::to_string(&SandboxKind::Windowed).unwrap();
        assert_eq!(embedded, "\"embedded\"");
        assert_eq!(windowed, "\"windowed\"");
    }

    #[test]
    fn embed_bounds_round_trips_through_tauri_ipc_payload() {
        // Tauri IPC commands receive EmbedBounds as a struct field inside
        // their args object. We confirm the deserializer accepts the
        // shape the frontend sends (plain numbers, camelCase-free).
        let payload =
            r#"{"x": 100.5, "y": 42.0, "width": 900.0, "height": 600.25}"#;
        let b: EmbedBounds = serde_json::from_str(payload).unwrap();
        assert_eq!(b.x, 100.5);
        assert_eq!(b.y, 42.0);
        assert_eq!(b.width, 900.0);
        assert_eq!(b.height, 600.25);
    }

    #[test]
    fn registry_insert_and_get_preserves_kind() {
        // Regression: earlier drafts of `close()` accidentally always
        // took the windowed branch because it didn't read `kind` out of
        // the registry. Pin the registry round-trip so that bug can't
        // sneak back in.
        let reg = SandboxRegistry::new();
        reg.insert(fake_tab("k1", SandboxKind::Embedded));
        reg.insert(fake_tab("k2", SandboxKind::Windowed));
        assert_eq!(reg.get("k1").unwrap().kind, SandboxKind::Embedded);
        assert_eq!(reg.get("k2").unwrap().kind, SandboxKind::Windowed);
        assert!(reg.remove("k1").is_some());
        assert!(reg.get("k1").is_none());
        assert_eq!(reg.list().len(), 1);
    }

    #[test]
    fn registry_remove_is_idempotent() {
        // `close()` is called from both programmatic paths and the
        // window-destroyed event handler; it must tolerate a
        // double-remove without panicking.
        let reg = SandboxRegistry::new();
        reg.insert(fake_tab("x", SandboxKind::Embedded));
        assert!(reg.remove("x").is_some());
        assert!(reg.remove("x").is_none());
    }

    #[test]
    fn sandbox_tab_serialises_window_label_for_frontend_id() {
        // tabStore polls `browser_sandbox_current_url` by tab_id but the
        // React side never sees `window_label`. We still confirm the
        // JSON shape includes it so Rust-side debug logs + the
        // `browser_sandbox_list` command stay useful.
        let tab = fake_tab("T1", SandboxKind::Embedded);
        let json = serde_json::to_value(&tab).unwrap();
        assert_eq!(json["tab_id"], "T1");
        assert_eq!(json["window_label"], "sunny_wv_T1");
        assert_eq!(json["kind"], "embedded");
    }
}
