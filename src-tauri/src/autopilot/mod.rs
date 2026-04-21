//! Autopilot — proactive 24/7 daemon subsystem.
//!
//! # Module layout
//!
//! | File | Purpose |
//! |------|---------|
//! | `mod.rs` | Public API, re-exports, wiring helpers |
//! | `governor.rs` | Cost ledger, token buckets, calm mode, speaking slot |
//! | `deliberator.rs` | Bus subscriber, 3-second coalescing window, tier router |
//! | `scoring.rs` | Pure `score()` function with four weighted components |
//! | `sensors/idle.rs` | Idle-seconds sensor (polled every 15 s) |
//! | `sensors/fs_burst.rs` | File-save burst detector via `notify` crate |
//! | `sensors/build.rs` | Build-log error detector via log file tailing |
//! | `sensors/clipboard_change.rs` | Clipboard delta detector |
//!
//! # Startup
//!
//! Call [`start`] once during the wiring pass. This module intentionally
//! does NOT auto-start from `lib.rs` — the caller controls when the daemon
//! becomes active.

pub mod governor;
pub mod deliberator;
pub mod scoring;
pub mod sensors;

pub use governor::Governor;
pub use deliberator::{Deliberator, T1_THRESHOLD, T2_THRESHOLD, AUTOPILOT_SPEAK_ENABLED, sensor_defaults};
