//! The Sunny secure browser.
//!
//! This module is the single source of truth for anything that touches the
//! network on behalf of the Web page, the Downloads manager, or the Research
//! orchestrator. The public contract, enforced by code review and the grep
//! check in `scripts/check-net-dispatch.sh`, is:
//!
//! > No code outside this module may construct a `reqwest::Client` or spawn a
//! > `yt-dlp` / `ffmpeg` process targeting user-supplied URLs. Everything goes
//! > through the [`dispatcher`] so the active profile's policy — anonymity
//! > route, ad/tracker block lists, audit trail, kill switch — applies
//! > uniformly.
//!
//! Sub-modules:
//! - [`profile`]  : profile catalogue + policy knobs (clearnet / tor / proxy).
//! - [`transport`]: builds the per-profile `reqwest::Client` with the right
//!                  proxy wiring and fingerprint-resistant headers.
//! - [`audit`]    : append-only SQLite log of outbound requests per profile.
//! - [`dispatcher`]: the call that everything else goes through.
//! - [`storage`]  : per-profile bookmarks + history.
//! - [`reader`]   : legacy-compatible readable HTML extractor (moved from
//!                  `web.rs` so the dispatcher can reuse it).
//! - [`sandbox`]  : multi-webview sandbox tab control surface.
//! - [`bridge`]   : loopback HTTP proxy used by sandbox webview tabs.
//! - [`downloads`]: yt-dlp + ffmpeg-backed download queue.
//! - [`media`]    : ffmpeg frame/audio extraction for the video workbench.
//! - [`research`] : multi-source research orchestrator.
//! - [`commands`] : thin `#[tauri::command]` wrappers.
//!
//! `tor.rs` is gated behind `--features bundled-tor`. Without it, the
//! [`TorRoute`](profile::TorRoute) can still use a system Tor daemon or a
//! user-supplied proxy URL.

pub mod audit;
pub mod bridge;
pub mod commands;
pub mod dispatcher;
pub mod doh;
pub mod downloads;
pub mod media;
pub mod profile;
pub mod reader;
pub mod research;
pub mod sandbox;
pub mod storage;
pub mod transport;

#[cfg(feature = "bundled-tor")]
pub mod tor;

// Sprint-15 — CDP (DevTools Protocol) automation backend.
// Drives Chrome/Chromium for click/type/eval/screenshot workflows with
// persistent login sessions. Lives alongside the existing Safari path.
pub mod cdp;
