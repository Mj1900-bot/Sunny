//! Deterministic compute helpers for the SUNNY agent loop.
//!
//! Large language models are famously unreliable at arithmetic, unit
//! conversion, timezone math, and cryptographic hashing — they happily
//! invent plausible-looking digits. This module exposes a set of small,
//! pure Tauri commands that do those things *correctly* so the model can
//! call them instead of hallucinating results.

pub mod calc;
pub mod data;
pub mod time;
pub mod units;

pub use calc::calc;
// Parked helpers are registered at their definition site via
// `#[tauri::command]`; only the actively-wired commands are re-exported
// here so the Tauri invoke handler can reference them from one place.
pub use data::uuid_new;
pub use time::timezone_now;
pub use units::convert_units;
