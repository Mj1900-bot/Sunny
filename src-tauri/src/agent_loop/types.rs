//! Core wire types shared across the agent loop.
//!
//! Defines the data structures that cross module boundaries inside
//! `agent_loop`: `ToolCall` (what the LLM asks us to invoke), `ToolOutput`
//! (what we hand back to the LLM — always wrapped in `<untrusted_source>` or
//! `<tool_error>` tags), `ToolError` (machine-parseable error envelope), and
//! `TurnOutcome` (the decision `run_one_turn` returns: either a final text
//! answer or a list of tool calls to dispatch). `AgentStep` is the event
//! shape emitted to the frontend's `sunny://agent.step` bus so the UI can
//! render each reasoning step incrementally.

use serde::Serialize;
use serde_json::Value;

/// One concrete tool invocation the LLM is asking us to run. `id` comes
/// from the LLM (Anthropic) or is synthesised for Ollama (which doesn't
/// return ids), and is threaded back into the response so the model can
/// correlate result → request on the next turn.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// Normalised dispatch outcome. `ok=true` means the tool produced a
/// useful result; `ok=false` carries a structured error payload.
#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub ok: bool,
    /// The body we feed back to the LLM (already wrapped in
    /// `<untrusted_source>` / `<tool_error>` as appropriate).
    pub wrapped: String,
    /// Shorter, unwrapped version suitable for the `agent.step` event
    /// payload the UI renders.
    pub display: String,
}

/// Structured tool-error envelope. Kept machine-parseable so the LLM can
/// reason about whether to retry, give up, or ask the user.
#[derive(Serialize)]
pub struct ToolError<'a> {
    pub error_kind: &'a str,
    pub message: String,
    pub retriable: bool,
}

/// What `run_one_turn` decided to do next after an LLM call: either stop
/// (final answer) or dispatch one-or-more tools and loop again.
pub enum TurnOutcome {
    /// Terminal assistant reply. `streamed` flags whether the provider
    /// already emitted `sunny://chat.chunk` deltas incrementally while the
    /// model was generating. When `true` the caller must NOT re-emit the
    /// full body as another `chat.chunk` — it just finalises with a
    /// zero-delta `{done: true}` and the `chat.done` event. When `false`
    /// the caller emits the full text in a single chunk (legacy path).
    Final {
        text: String,
        streamed: bool,
    },
    Tools {
        /// Any narrative text the model emitted alongside the tool call.
        /// Anthropic may interleave prose + tool_use blocks; we surface
        /// the prose as a "thinking" step for UI context.
        thinking: Option<String>,
        calls: Vec<ToolCall>,
        /// Raw assistant message block, preserved verbatim so we can
        /// replay it back to the LLM on the next turn (Anthropic requires
        /// the assistant's tool_use blocks to be echoed before the
        /// matching tool_result blocks).
        assistant_message: Value,
    },
}

impl TurnOutcome {
    /// Convenience for providers that return a buffered final reply
    /// (no mid-flight streaming to the chat UI).
    pub fn final_buffered(text: String) -> Self {
        TurnOutcome::Final { text, streamed: false }
    }
}

/// Backend selection — which LLM API we talk to this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Anthropic,
    Ollama,
    /// Z.AI's GLM-5.1 via the OpenAI-compatible Chat Completions API.
    /// Selected explicitly via `provider == "glm"` / `"agent:glm"`.
    Glm,
}
