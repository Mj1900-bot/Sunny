//! Trait-registered tools (sprint-11 pilot, extended sprint-12 +
//! migrated en-masse in sprint-13 α).
//!
//! Each submodule owns one tool end-to-end — argument parsing, the
//! underlying domain call, and the `inventory::submit!` that wires
//! the spec into `tool_trait`'s registry at link time.
//!
//! ## Capability taxonomy (coordinates with sprint-13 β)
//!
//! Every tool declares `required_capabilities: &'static [&'static str]`
//! on its `ToolSpec`. Sprint-13 α *declares* them; sprint-13 β wires
//! the Rust-side grant source that enforces them. The strings form a
//! hierarchy — read < write < dangerous — and are mirrored on the
//! TS-side `skillExecutor.checkCapability` policy. 30-second tour:
//!
//!   * `network.read`          — outbound HTTPS to a known API
//!                               (Open-Meteo, timeapi.io).
//!   * `web:fetch` / `web:search` — unrestricted URL fetch / a web
//!                               search provider. Split from
//!                               `network.read` so a scoped sub-agent
//!                               can be told "no arbitrary URLs".
//!   * `browser:open` / `browser:read` — drive / read Safari.
//!   * `app:launch`            — launch arbitrary macOS apps.
//!   * `shortcut:run`          — run a macOS Shortcut.
//!   * `macos.mail`            — read Mail.app. `.write` to send.
//!   * `macos.calendar`        — read Calendar. `.write` to create.
//!   * `macos.notes`           — read Notes. `.write` to create/append.
//!   * `macos.reminders`       — read Reminders. `.write` to add.
//!   * `macos.messaging`       — read Messages. `.write` to send.
//!   * `macos.contacts`        — read Contacts.
//!   * `macos.media`           — read Now Playing. `.write` for toggle.
//!   * `macos.screen`          — OCR / full-screen capture.
//!   * `macos.clipboard`       — clipboard history.
//!   * `macos.accessibility`   — focused window + AX queries.
//!   * `system.metrics`        — CPU / battery / disk.
//!   * `shell.sandbox`         — allowlisted sandboxed shell command.
//!   * `compute.run`           — `py_run` Python sandbox.
//!   * `memory.read`           — `memory_recall`.
//!   * `memory.write`          — `memory_remember`, `memory_compact`.
//!   * `vision.describe`       — local multimodal image describe.
//!   * `persona.write`         — rewrite HEARTBEAT autogen block.
//!   * `scheduler.write`       — schedule a recurring / one-shot job.
//!   * `agent.dialogue`        — multi-agent messaging / broadcast.
//!   * `hud.read`              — peek at HUD page state.
//!   * `hud.navigate`          — flip / act on a HUD page.
//!
//! Empty cap list (`&[]`) means "no capability check" and is reserved
//! for pure compute (`calc`, `uuid_new`, `timezone_now`, `unit_convert`)
//! where the evaluator never reaches outside the process.
//!
//! ## What stayed in `dispatch.rs`
//!
//! Tools that thread `depth` / `parent_session_id` through the
//! agent-loop (every composite sub-agent driver + `spawn_subagent`
//! itself + `agent_wait`) remain in the legacy match because
//! `ToolCtx` does not carry those fields today and the sprint-13 α
//! brief forbids extending `tool_trait.rs`. Sprint-14 will grow
//! `ToolCtx::depth` + `ToolCtx::parent_session_id` and migrate the
//! rest.
//!
//! The `pub mod` declarations aren't strictly necessary for spec
//! collection — `inventory` gathers by link-time presence, not
//! module path — but they make it impossible for `rustc` to
//! dead-code-strip a tool whose only caller is the linker.

pub mod agents;
pub mod browser;
pub mod composite;
pub mod compute;
pub mod hud;
pub mod macos;
pub mod media;
pub mod memory;
pub mod persona;
pub mod scheduler;
pub mod shell;
pub mod system;
pub mod vision;
pub mod weather_time;
pub mod web;
pub mod dev_tools;

pub mod computer_use;
pub mod vcs;

pub mod apple;
pub mod sandbox;
pub mod documents;

pub mod spotlight;
pub mod screen;

pub mod net;
