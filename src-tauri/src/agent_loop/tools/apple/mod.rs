//! Apple ecosystem tools — Shortcuts, Music.app, Photos.app, HomeKit scenes,
//! Focus modes, and system notifications.
//!
//! ## Capability taxonomy
//!
//! | Tool                   | L-level | Capability           | dangerous |
//! |------------------------|---------|----------------------|-----------|
//! | `shortcut_list`        | L0      | `shortcut:run`       | false     |
//! | `apple_shortcut_run`   | L3      | `shortcut:run`       | true      |
//! | `music_now_playing`    | L0      | `macos.media`        | false     |
//! | `music_play`           | L2      | `macos.media.write`  | false     |
//! | `music_pause`          | L2      | `macos.media.write`  | false     |
//! | `music_skip`           | L2      | `macos.media.write`  | false     |
//! | `music_volume`         | L0/L2   | `macos.media`        | false     |
//! | `photos_recent`        | L1      | `macos.photos`       | false     |
//! | `photos_search`        | L1      | `macos.photos`       | false     |
//! | `homekit_scene_run`    | L3      | `shortcut:run`       | true      |
//! | `focus_mode_set`       | L2      | `shortcut:run`       | false     |
//! | `system_notification`  | L0      | (none)               | false     |
//!
//! ## Entitlements required
//!
//! - `photos_recent` / `photos_search` require the **Photos Library** privacy
//!   entitlement: System Settings → Privacy & Security → Photos → Sunny.
//! - `music_*` require Automation permission for **Music.app**.
//! - `apple_shortcut_run`, `homekit_scene_run`, `focus_mode_set` require the
//!   `shortcuts` CLI (macOS Monterey 12+) and Shortcuts automation access.
//! - `system_notification` requires no entitlement — `display notification`
//!   in osascript works from any process.

mod core;

pub mod shortcut_list;
pub mod shortcut_run;
pub mod music_play;
pub mod music_pause;
pub mod music_now_playing;
pub mod music_skip;
pub mod music_volume;
pub mod photos_recent;
pub mod photos_search;
pub mod homekit_scene_run;
pub mod focus_mode_set;
pub mod system_notification;
