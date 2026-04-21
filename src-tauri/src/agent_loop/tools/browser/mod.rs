//! Browser driver tools.
//!
//! Safari path (AppleScript): `browser_open`, `browser_read_page_text`.
//! CDP path (chromiumoxide):  9 new `browser_cdp_*` tools.
//!
//! The CDP tools drive Chrome/Chromium with a persistent profile so logins
//! persist across SUNNY restarts. They do NOT touch the Safari module.

// --- Safari / AppleScript tools ---
pub mod browser_open;
pub mod browser_read_page_text;

// --- CDP / Chromium automation tools (Sprint-15) ---
pub mod browser_cdp_click;
pub mod browser_cdp_close_tab;
pub mod browser_cdp_eval;
pub mod browser_cdp_list_tabs;
pub mod browser_cdp_open;
pub mod browser_cdp_read;
pub mod browser_cdp_screenshot;
pub mod browser_cdp_type;
pub mod browser_cdp_wait;
