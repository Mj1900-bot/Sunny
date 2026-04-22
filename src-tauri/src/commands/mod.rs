//! Thin `#[tauri::command]` wrappers forwarding to the domain modules.
//!
//! This file exists purely to keep `lib.rs` focused on runtime wiring.
//! Every function here is a 1-to-few-line forwarder; add real logic in the
//! corresponding domain module instead (e.g. `metrics.rs`, `vault.rs`).
//!
//! Commands that already live inside a domain module (`tray::tray_set_status`,
//! `world::world_get`, `constitution::*`, `clipboard::get_clipboard_history`)
//! are registered directly in `lib.rs`'s `invoke_handler!` without a wrapper
//! here.
//!
//! # Regenerating TypeScript bindings
//!
//! When you add `#[derive(TS)] #[ts(export)]` to a struct returned by a
//! `#[tauri::command]` (or change the shape of one that already has it),
//! regenerate the frontend types with:
//!
//! ```text
//! ./scripts/regen-bindings.sh
//! ```
//!
//! That runs the `export_bindings_*` unit tests, which ts-rs uses as the
//! emission hook. Bindings land in `src/bindings/`, driven by
//! `TS_RS_EXPORT_DIR` in `src-tauri/.cargo/config.toml`.

pub mod secrets;
pub use secrets::*;

pub mod metrics;
pub use metrics::*;

pub mod agent;
pub use agent::*;

pub mod voice;
pub use voice::*;

pub mod fs;
pub use fs::*;

pub mod pty;
pub use pty::*;

pub mod audio;
pub use audio::*;

pub mod memory;
pub use memory::*;

pub mod scheduler;
pub use scheduler::*;

pub mod ui;
pub use ui::*;

pub mod vision_ocr;
pub use vision_ocr::*;

pub mod platform;
pub use platform::*;

pub mod messaging;
pub use messaging::*;

pub mod misc;
pub use misc::*;

pub mod identity;
pub use identity::*;

pub mod capability;
pub use capability::*;

pub mod cost;
pub use cost::*;

pub mod plugins;
pub use plugins::*;
