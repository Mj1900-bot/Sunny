//! Dev-tool interop layer — launch Claude Code, Cursor, Antigravity, iTerm,
//! Terminal, Zed, and VS Code with project context and retrieve results.
//!
//! # Architecture
//!
//! ```
//! dev_session_launch  →  launch::launch()  →  bridges/<tool>.rs
//!                                          →  handoff.rs (writes .sunny/handoff.json)
//! dev_session_result  →  bus_watch::poll() →  ~/.sunny/bus/<session_id>/
//! ```
//!
//! # Safety gates
//!
//! * Both tools are `dangerous: true` — routed through `confirm.rs`.
//! * URL-scheme launches are allowlisted (currently only `antigravity://`).
//! * File writes restricted to `{project_path}/.sunny/`.
//! * Project path must be listed in `~/.sunny/grants.json` under
//!   `"dev_tool_paths"` (checked by `grants::check_project_path`).
//! * `sudo`, network to unknown domains, package installs → blocked by
//!   existing `shell_safety.rs` (not extended here).

pub mod bus_watch;
pub mod discover;
pub mod handoff;
pub mod launch;

pub mod bridges;

mod grants;
mod session_tools;
