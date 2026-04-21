//! Multi-agent dialogue tools — post messages / enumerate siblings /
//! broadcast. All `agent.dialogue` capability; read the initiator id
//! off `ToolCtx::initiator` (strip the `agent:` prefix).
//!
//! `spawn_subagent`, `agent_wait`, plus every composite that threads
//! `depth` and `parent_session_id` remain in `dispatch.rs`'s legacy
//! match for this sprint — `ToolCtx` does not yet carry those fields
//! and the brief forbids extending `tool_trait.rs` in sprint-13 α.
pub mod agent_broadcast;
pub mod agent_list_siblings;
pub mod agent_message;
pub mod agent_wait;
