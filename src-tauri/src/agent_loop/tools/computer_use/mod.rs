//! Computer-use tools — generalised macOS screen control for any application.
//!
//! ## Tools and trust levels
//!
//! | Tool                | L-level | Side effects                       |
//! |---------------------|---------|------------------------------------|
//! | `screen_capture`    | L0      | None — screen read only            |
//! | `screen_ocr`        | L0      | None — screen read + OCR           |
//! | `screen_describe`   | L0      | None — OCR + optional vision model |
//! | `active_window_info`| L0      | None — AX read                     |
//! | `list_running_apps` | L0      | None — AX read                     |
//! | `mouse_click`       | L3      | Moves cursor and clicks            |
//! | `mouse_drag`        | L3      | Press-drag-release                 |
//! | `keyboard_type`     | L3      | Types text into focused app        |
//! | `keyboard_shortcut` | L3      | Sends a key chord                  |
//!
//! ## Safety gates (applied before any L3 action)
//!
//! 1. **Coordinate clamp** — coords outside screen bounds are rejected.
//! 2. **Dangerous-app block-list** — Terminal, Keychain, password managers,
//!    System Settings block L3 actions without an explicit `force:true`.
//! 3. **Rate limiter** — max 10 interactive actions per 10 s.
//!
//! All `inventory::submit!` calls happen inside the leaf modules; the `pub mod`
//! declarations here are what prevent rustc from dead-code-stripping them.

pub mod safety;

pub mod active_window_info;
pub mod keyboard_shortcut;
pub mod keyboard_type;
pub mod list_running_apps;
pub mod mouse_click;
pub mod mouse_drag;
pub mod screen_capture;
pub mod screen_describe;
pub mod screen_ocr_tool;
