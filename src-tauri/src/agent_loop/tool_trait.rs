//! Tool trait + capability contract.
//!
//! This is the registration surface for every agent tool. Tools live in
//! sibling modules under `agent_loop::tools::*` and register themselves
//! via [`inventory::submit!`] at link time. `dispatch::run_tool` looks
//! each call up via [`find`] and dispatches through the spec's `invoke`
//! fn pointer; there is no fallback `match`.
//!
//! The contract is deliberately minimal:
//!
//! * A [`ToolSpec`] carries a static name, description, JSON Schema
//!   literal, the capability strings the caller must hold, a
//!   trust-class tag, a `dangerous` side-effect flag, and an async
//!   `invoke` function pointer.
//! * `trust_class`, `dangerous`, and `required_capabilities` live on
//!   the spec itself so adding a new tool never touches the central
//!   match-tables in `catalog.rs`.
//!
//! `Pin<Box<dyn Future>>` is required because async-trait-style object
//! safety is still unstable; this is the same shape `tower::Service`,
//! `axum::Handler`, etc. use today. A small `invoke_fn!` helper would
//! be easy to add later if the boxed-future boilerplate gets painful.

use std::future::Future;
use std::pin::Pin;
use std::sync::RwLock;

use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::AppHandle;

use super::catalog::TrustClass;

/// Per-invocation execution context. Kept small — a tool that needs
/// more than this should reach through `app` for handles rather than
/// expanding the struct.
pub struct ToolCtx<'a> {
    /// Tauri handle — gives access to state, events, windows. Borrowed
    /// because the dispatcher already holds an owned handle for the
    /// duration of the call.
    pub app: &'a AppHandle,
    /// Parent agent session, if this tool was invoked from within a
    /// sub-agent turn. `None` for the main agent.
    pub session_id: Option<&'a str>,
    /// Who initiated this call — e.g. `"agent:main"`, `"agent:research"`.
    /// Used by capability checks and audit logging.
    pub initiator: &'a str,
    /// Recursion depth of the current agent stack. 0 for the main-agent
    /// dispatch; increments with each `spawn_subagent` call so composite
    /// tools can enforce a depth ceiling and prevent infinite recursion.
    pub depth: u32,
}

/// Boxed-future return type for `ToolSpec::invoke`. Declared as a type
/// alias so the `for<'a> fn(...)` signature in [`ToolSpec`] stays
/// readable.
pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// Static description of one tool, gathered by `inventory` at link
/// time. `invoke` is a plain `fn` pointer (not a closure) so the whole
/// struct can live in `.rodata` and the collection is zero-cost at
/// startup.
pub struct ToolSpec {
    /// Canonical tool name. Must match the string the LLM emits in
    /// its `tool_use` block, and must be unique across the registry.
    pub name: &'static str,
    /// One-line description, shown to the LLM in the tool catalog.
    pub description: &'static str,
    /// Raw JSON Schema fragment describing `invoke`'s `Value` arg.
    /// Same shape as `agent_loop::catalog::ToolSpec::input_schema`.
    pub input_schema: &'static str,
    /// Capability strings the initiator must hold. Checked on the
    /// Rust side by [`check_capabilities`] at the dispatch trait
    /// branch and mirrored against the TS-side
    /// `skillExecutor.checkCapability` policy.
    pub required_capabilities: &'static [&'static str],
    /// Trust classification for the tool's OUTPUT — `Pure` skips the
    /// `<untrusted_source>` wrap, `ExternalRead`/`ExternalWrite` get
    /// wrapped defensively. Hoisted onto the spec so new tools never
    /// touch `catalog::trust_class`'s match-table.
    pub trust_class: TrustClass,
    /// `true` if the tool performs a side effect that should require
    /// the user to confirm before dispatch. Hoisted onto the spec so
    /// new tools never touch `catalog::is_dangerous`.
    pub dangerous: bool,
    /// Async invocation entry point. Returns the tool's display
    /// string (`Ok`) or a human-readable error (`Err`). The
    /// dispatcher wraps the result via `wrap_success`/`wrap_error`,
    /// so callers here should *not* add `<untrusted_source>` tags.
    pub invoke: for<'a> fn(&'a ToolCtx<'a>, Value) -> ToolFuture<'a>,
}

inventory::collect!(ToolSpec);

/// Find a registered tool by name. Returns `None` if no
/// `inventory::submit!`ed spec matches — dispatch then falls through
/// to the legacy `match`.
pub fn find(name: &str) -> Option<&'static ToolSpec> {
    inventory::iter::<ToolSpec>
        .into_iter()
        .find(|spec| spec.name == name)
}

/// Iterate every registered tool. Used by `catalog::catalog_merged`
/// to build the combined catalog handed to the LLM.
pub fn all() -> impl Iterator<Item = &'static ToolSpec> {
    inventory::iter::<ToolSpec>.into_iter()
}

// ---------------------------------------------------------------------------
// Capability enforcement
//
// Mirrors the shape of the TS-side `skillExecutor.checkCapability`:
// a tagged union of Allowed / Denied. The initiator string matches
// `ToolCtx::initiator` (`"agent:main"`, `"agent:sub:<id>"`, etc).
//
// `initiator_grants` resolves through `crate::capability::grants_for`,
// which reads `~/.sunny/grants.json` with an mtime-driven cache so UI
// edits take effect without an app restart. See `capability.rs` for
// the policy source and the JSONL denial audit log.
// ---------------------------------------------------------------------------

/// Tagged verdict returned by [`check_capabilities`]. The `Denied`
/// arm carries the reason string the dispatcher folds into a
/// `ToolError { error_kind: "capability_denied", ... }` envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityVerdict {
    Allowed,
    Denied(String),
}

/// One-shot warn ledger — dedups the "initiator has no capability
/// list configured yet" console line so a hot System-1 loop doesn't
/// spam. Keyed by initiator string. Triggered on the
/// `agent:main`-without-explicit-scope legacy path; real denials are
/// deduped separately in `capability::record_denial` keyed by
/// (initiator, tool, cap).
static UNSCOPED_WARNED: Lazy<RwLock<std::collections::HashSet<String>>> =
    Lazy::new(|| RwLock::new(std::collections::HashSet::new()));

/// Look up the capability grant-set for a given initiator.
///
/// Delegates to `crate::capability::grants_for`, which owns the policy
/// source. Returning `None` means "full-access default" — the primary
/// user path (`agent:main` without an explicit entry in grants.json)
/// takes that branch.
fn initiator_grants(initiator: &str) -> Option<Vec<String>> {
    crate::capability::grants_for(initiator)
}

/// Verify that `initiator` holds every capability in `required`.
///
/// Policy:
///   • `required` is empty → always Allowed (no scope-dependent effect).
///   • `initiator_grants(initiator)` is `None` → Allowed with a
///     one-shot "unscoped" warn (matches the TS `capabilities ===
///     undefined` legacy default). Intended for `agent:main`.
///   • grants include every required cap → Allowed.
///   • otherwise → Denied with a reason naming the missing caps, AND
///     a JSONL row appended to `~/.sunny/capability_denials.log` for
///     audit. Per-triple dedup keeps the console WARN at one per
///     (initiator, tool, cap).
pub fn check_capabilities(
    initiator: &str,
    tool: &str,
    required: &[&str],
) -> CapabilityVerdict {
    if required.is_empty() {
        return CapabilityVerdict::Allowed;
    }

    let grants = match initiator_grants(initiator) {
        Some(g) => g,
        None => {
            // One-shot warn per initiator — preserves the "remind me
            // which callers are unscoped" signal without spamming.
            let already = UNSCOPED_WARNED
                .read()
                .map(|g| g.contains(initiator))
                .unwrap_or(false);
            if !already {
                if let Ok(mut g) = UNSCOPED_WARNED.write() {
                    g.insert(initiator.to_string());
                }
                log::warn!(
                    "[tool_trait] initiator `{initiator}` unscoped — full-access default"
                );
            }
            return CapabilityVerdict::Allowed;
        }
    };

    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|cap| !grants.iter().any(|g| g == cap))
        .collect();

    if missing.is_empty() {
        CapabilityVerdict::Allowed
    } else {
        let reason = format!(
            "initiator `{initiator}` is missing required capabilit{}: {} (needed by `{tool}`)",
            if missing.len() == 1 { "y" } else { "ies" },
            missing.join(", ")
        );
        crate::capability::record_denial(initiator, tool, &missing, &reason);
        CapabilityVerdict::Denied(reason)
    }
}

#[cfg(test)]
pub(crate) fn __reset_unscoped_warnings() {
    if let Ok(mut g) = UNSCOPED_WARNED.write() {
        g.clear();
    }
}
