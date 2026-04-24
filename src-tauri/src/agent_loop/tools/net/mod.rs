//! Generic network tools — HTTP primitives the main agent can use to
//! hit arbitrary public APIs without waiting for a bespoke wrapper.
//!
//! Every tool in this module MUST:
//!   1. Validate the URL via `crate::tools_web::validate_public_http_url`
//!      (the shared SSRF gate).
//!   2. Send via `crate::http::send` so the audit log, egress monitor,
//!      canary scanner, and panic-mode kill-switch all fire.
//!   3. Wrap the handler body in
//!      `crate::http::with_initiator("tool:<name>", fut)` so
//!      `NetRequest` events carry a distinguishable initiator on the
//!      Security Network tab.
//!
//! Main-agent-only on first ship. Tools here are NOT added to any
//! sub-agent role allowlist in `agent_loop::scope` without explicit
//! safety-aligner sign-off.

pub mod http_request;
