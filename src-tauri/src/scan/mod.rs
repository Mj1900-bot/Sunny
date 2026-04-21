//! Virus scanner module.
//!
//! Public surface:
//!   - `types`       — wire-compatible structs (Verdict, Finding, Progress…)
//!   - `commands`    — Tauri command handlers wired in `lib.rs`
//!
//! Private internals:
//!   - `hash`        — SHA-256 streaming with cancellation
//!   - `heuristic`   — per-file inspections (path, xattr, codesign, magic)
//!   - `bazaar`      — MalwareBazaar + VirusTotal hash lookups (with cache)
//!   - `vault`       — quarantine storage under `~/.sunny/scan_vault/`
//!   - `scanner`     — orchestrator (walker + analyzer + progress tracker)

pub mod bazaar;
pub mod commands;
pub mod hash;
pub mod heuristic;
pub mod scanner;
pub mod signatures;
pub mod types;
pub mod vault;
