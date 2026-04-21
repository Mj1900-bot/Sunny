//! System-introspection tools — metrics, battery, focused window, OCR,
//! clipboard history. All read-only; `system.*` capabilities cover
//! them. OCR + screen capture require `macos.screen`; clipboard
//! history requires `macos.clipboard`.
pub mod battery_status;
pub mod clipboard_history;
pub mod focused_window;
pub mod screen_capture_full;
pub mod screen_ocr;
pub mod system_metrics;
