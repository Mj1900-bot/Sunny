//! CDP (Chrome DevTools Protocol) browser automation backend.
//!
//! Drives an installed Chrome/Chromium via `chromiumoxide` so SUNNY can
//! click elements, fill forms, evaluate JS, and persist logins across
//! sessions — none of which is possible with the read-only Safari/AppleScript
//! path.
//!
//! # Architecture
//!
//! A single [`BrowserHandle`] singleton is kept alive for up to
//! `IDLE_TIMEOUT_SECS` (10 minutes) after the last tool call. The first tool
//! call spawns Chrome with a persistent user-data directory at
//! `~/.sunny/browser-profile/` so cookies, localStorage, and saved passwords
//! are preserved across restarts. Subsequent tool calls reuse the existing
//! process; after the idle timer fires the process is killed and the slot is
//! reset so the next call restarts cleanly.
//!
//! # Modules
//!
//! - [`handle`]  : `BrowserHandle` singleton + lifecycle management.
//! - [`session`] : per-tab `TabSession` (open, click, type, read, screenshot…).
//! - [`error`]   : typed `CdpError` enum and `CdpResult<T>` alias.
//! - [`types`]   : immutable return-value structs (`TabInfo`, `CdpText`, …).
//! - [`security`]: URL validation and confirm-gate risk classification.

pub mod error;
pub mod handle;
pub mod security;
pub mod session;
pub mod types;
