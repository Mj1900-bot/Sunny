//! Sub-agent spawning — nested ReAct loops for delegated tasks.
//!
//! `spawn_subagent` runs a complete `agent_run_inner` loop at `depth + 1`
//! with its own session id, so a sub-agent's conversation history never
//! contaminates the parent's. The recursion guard (`MAX_SUBAGENT_DEPTH = 3`)
//! stops runaway nesting: exceeding the limit surfaces as a structured
//! `<tool_error error_kind="depth_limit">` that the parent LLM can reason
//! about rather than a panic.
//!
//! Sub-agent step events are multiplexed through `sunny://agent.sub` (instead
//! of `sunny://agent.step`) with a stable `sub_id` so the UI can render a
//! dedicated activity card per spawned agent. Role-based model selection lets
//! specialist sub-agents use a different (often cheaper) model than the main
//! agent.

use serde_json::json;
use tauri::AppHandle;
use uuid::Uuid;

use crate::ai::{ChatMessage, ChatRequest};
use super::providers::auth::{anthropic_key_present, zai_key_present};
use super::helpers::emit_sub_event;
use super::scope::allowed_tools_for_role;
// We will call the common `agent_run_inner` via the `core` module
use super::core::{agent_run_inner, MAX_SUBAGENT_DEPTH};

// ---------------------------------------------------------------------------
// Sub-agent spawning
//
// A sub-agent is a nested ReAct loop (same `agent_run_inner` driver)
// scoped to a single delegated task. It has its own session id so its
// history never contaminates the parent's, and its step events are
// multiplexed through `sunny://agent.sub` with a `sub_id` so the UI can
// render a dedicated card per sub-agent.
// ---------------------------------------------------------------------------

/// Maximum simultaneous *live* children a single parent agent can have.
/// The existing `MAX_SUBAGENT_DEPTH = 3` guard stops vertical recursion
/// (A -> B -> C -> D is refused) but not horizontal fan-out (A emitting
/// 100 siblings at depth 1). With 4 permitted children and depth 3,
/// worst-case concurrent agent count is bounded at 4^3 = 64 — well
/// within the global spawn budget.
const MAX_LIVE_SIBLINGS: usize = 4;

pub async fn spawn_subagent(
    app: &AppHandle,
    role: &str,
    task: &str,
    model_override: Option<String>,
    parent_session_id: Option<String>,
    parent_depth: u32,
) -> Result<String, String> {
    // Recursion guard — refuse to keep nesting past the hard cap.
    // Surfacing this as a tool-level Err means the wrapping dispatcher
    // emits a structured `<tool_error error_kind="depth_limit">` to the
    // LLM, which can then decide to just answer directly instead of
    // trying to spawn another layer.
    let next_depth = parent_depth + 1;
    if next_depth >= MAX_SUBAGENT_DEPTH {
        return Err(format!(
            "depth_limit: refusing to spawn sub-agent at depth {next_depth} (max {MAX_SUBAGENT_DEPTH})"
        ));
    }

    // Breadth guard — stop the parent from fan-out spamming. Resolved
    // the same way depth_limit is: an Err here surfaces to the LLM as a
    // structured tool error so it can pick a different strategy (wait on
    // an existing sibling, narrow scope, answer directly).
    //
    // The parent-id resolution mirrors the one further down (near
    // `register_with_parent`) — duplicating the two-line expression here
    // keeps this guard a pure pre-check, so a nothing-registered sub-
    // agent can't even get a uuid until we've confirmed there's room.
    let breadth_parent_id = parent_session_id
        .as_deref()
        .map(|s| s.strip_prefix("sub-").unwrap_or(s).to_string())
        .unwrap_or_else(|| super::dialogue::MAIN_AGENT_ID.to_string());
    let live = super::dialogue::count_live_children(&breadth_parent_id);
    if live >= MAX_LIVE_SIBLINGS {
        return Err(format!(
            "sibling_limit: refusing to spawn a {live}th concurrent sub-agent \
             under parent {breadth_parent_id} (max {MAX_LIVE_SIBLINGS}). Await \
             an in-flight sibling or finish one before spawning another."
        ));
    }

    let sub_id = Uuid::new_v4().to_string();
    let model = model_override.or_else(|| default_model_for_role(role));
    let provider = pick_subagent_provider(model.as_deref()).await;

    // Register this sub-agent in the dialogue registries BEFORE we
    // emit the `start` event. That way the moment the UI (or a sibling
    // agent) learns the new sub-agent exists, `agent_message` can
    // already post into its inbox — without this the post would
    // bounce with `unknown recipient`.
    //
    // We also record the parent id so the child (and any of its
    // peers) can enumerate siblings via `list_siblings` and broadcast
    // via `broadcast_to_siblings`. Parent id is whichever session
    // spawned us — a parent sub-agent's uuid, or `MAIN_AGENT_ID` when
    // the top-level agent did the spawn. Sub-agents share a
    // `parent_session_id` naming scheme (`sub-<uuid>`); strip the
    // prefix so children see the bare id the rest of the registry
    // uses.
    let parent_id = parent_session_id
        .as_deref()
        .map(|s| s.strip_prefix("sub-").unwrap_or(s).to_string())
        .unwrap_or_else(|| super::dialogue::MAIN_AGENT_ID.to_string());
    super::dialogue::register_with_parent(&sub_id, &parent_id);

    // Sub-agent lifecycle: "start" event carries enough for the UI to
    // build a card (role, task, chosen model, who spawned it).
    emit_sub_event(
        app,
        &sub_id,
        "start",
        json!({
            "role": role,
            "task": task,
            "model": model,
            "parent": parent_session_id,
            "parent_session_id": parent_session_id,
            "depth": next_depth,
        }),
    );

    let sub_req = ChatRequest {
        message: task.to_string(),
        model: model.clone(),
        provider: Some(provider),
        history: vec![ChatMessage {
            role: "system".into(),
            content: system_prompt_for_role(role),
        }],
        session_id: Some(format!("sub-{sub_id}")),
        chat_mode: None,
    };

    // Scoped "what tools can this role use" set — enforced at
    // dispatch time when policy.subagent_role_scoping is true.
    // Using tokio task-local so every tool dispatch under this
    // subagent (including further nested spawns) inherits the scope.
    let allowed = allowed_tools_for_role(role);
    let fut = crate::http::with_initiator(
        format!("agent:sub:{role}:{sub_id}"),
        agent_run_inner(app.clone(), sub_req, Some(sub_id.clone()), next_depth),
    );
    let result = super::scope::with_role_scope(role.to_string(), allowed, fut).await;

    match &result {
        Ok(answer) => {
            // Record the final answer into the dialogue results map so
            // any sibling `agent_wait`-ing on this id unblocks with the
            // real reply. Do this before we emit `done` so a UI-side
            // listener that polls the registry on the `done` event
            // already sees the populated slot.
            super::dialogue::set_result(&sub_id, answer.clone());
            emit_sub_event(
                app,
                &sub_id,
                "done",
                json!({
                    "role": role,
                    "answer": answer,
                }),
            );
            Ok(format!("[sub-agent {role} answer] {}", answer))
        }
        Err(e) => {
            // Failed runs still need to flip the slot — a sibling
            // waiting on this agent shouldn't hang forever because a
            // child errored. Fold the error into a marker string so the
            // waiter can distinguish it from a successful answer.
            super::dialogue::set_result(&sub_id, format!("[error] {e}"));
            emit_sub_event(
                app,
                &sub_id,
                "error",
                json!({
                    "role": role,
                    "error": e,
                }),
            );
            Err(format!("sub-agent {role} failed: {e}"))
        }
    }
}

/// Pick a sensible default model for a given role. Returns `None` when
/// we want the backend's built-in default (`pick_model` downstream will
/// fall back to `DEFAULT_ANTHROPIC_MODEL`, Ollama tag lookup, etc.).
fn default_model_for_role(role: &str) -> Option<String> {
    // Cheap synchronous env probes — the routing agent caches these
    // rarely-changing checks so we don't hit keychain on every spawn.
    let has_anthropic = std::env::var("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let has_glm = std::env::var("ZAI_API_KEY")
        .or_else(|_| std::env::var("ZHIPU_API_KEY"))
        .or_else(|_| std::env::var("GLM_API_KEY"))
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    match role {
        "researcher" => Some(if has_glm {
            "glm-5.1".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        "coder" => Some(if has_glm {
            "glm-5.1".to_string()
        } else if has_anthropic {
            "claude-sonnet-4-6".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        "writer" => Some(if has_anthropic {
            "claude-sonnet-4-6".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        "browser_driver" => Some(if has_glm {
            "glm-5.1".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        "planner" => Some(if has_anthropic {
            "claude-sonnet-4-6".to_string()
        } else if has_glm {
            "glm-5.1".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        // Fast and cheap is fine for short-form condense / critique work.
        "summarizer" | "critic" => Some("qwen2.5:7b-instruct-q4_0".to_string()),
        // Skeptic plays devil's advocate — short-form critique, same
        // budget as critic.
        "skeptic" => Some("qwen2.5:7b-instruct-q4_0".to_string()),
        // Synthesizer must merge multiple viewpoints coherently — give
        // it the strongest available writer model.
        "synthesizer" => Some(if has_anthropic {
            "claude-sonnet-4-6".to_string()
        } else if has_glm {
            "glm-5.1".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        // Arbiter renders final judgement — reach for the deepest
        // reasoner we have a key for.
        "arbiter" => Some(if has_anthropic {
            "claude-sonnet-4-6".to_string()
        } else if has_glm {
            "glm-5.1".to_string()
        } else {
            "qwen3:30b-a3b-instruct-2507".to_string()
        }),
        // Unknown role — let the outer defaults apply.
        _ => None,
    }
}

/// Choose the `ChatRequest.provider` string for a sub-agent given the
/// model it will run. Mirrors what the routing layer in `ai.rs` expects:
/// `"agent:glm"` / `"agent:anthropic"` / `"agent:ollama"`. The sub-agent
/// runs inside `agent_run_inner`, so the `agent:` prefix keeps
/// `pick_backend` on the same ReAct path as the main loop.
async fn pick_subagent_provider(model: Option<&str>) -> String {
    let is_glm_model = model
        .map(|m| m.to_ascii_lowercase().starts_with("glm"))
        .unwrap_or(false);
    if is_glm_model && zai_key_present().await {
        return "agent:glm".to_string();
    }
    let is_claude_model = model
        .map(|m| {
            let lower = m.to_ascii_lowercase();
            lower.starts_with("claude") || lower.starts_with("anthropic")
        })
        .unwrap_or(false);
    if is_claude_model && anthropic_key_present().await {
        return "agent:anthropic".to_string();
    }
    // No explicit model preference → mirror main-agent default ordering:
    // Anthropic if we have a key, else Ollama.
    if anthropic_key_present().await {
        "agent:anthropic".to_string()
    } else {
        "agent:ollama".to_string()
    }
}

/// Brief persona + boundaries for each sub-agent role. The system prompt
/// is kept short on purpose — the sub-agent has the whole tool catalog
/// available and we just want to nudge its behaviour, not prescribe
/// every move.
fn system_prompt_for_role(role: &str) -> String {
    let persona = match role {
        "researcher" => "You are a research sub-agent. Gather facts and cite sources. \
            Use web_search and web_fetch extensively. Return a concise summary with source URLs.",
        "coder" => "You are a coding sub-agent. Write, review, or debug code. \
            Use file tools to read context. Output minimal, correct diffs or code blocks.",
        "writer" => "You are a writing sub-agent. Produce polished prose. \
            Match the requested tone and length exactly.",
        "browser_driver" => "You are a browser-driver sub-agent. Operate Safari to complete \
            a task — open, navigate, read, click. Report each step.",
        "planner" => "You are a planner sub-agent. Break the given goal into a numbered \
            plan of steps, each tagged with the appropriate role.",
        "summarizer" => "You are a summariser sub-agent. Condense long content into 3-5 \
            bullet points. No filler.",
        "critic" => "You are a critic sub-agent. Find flaws in the given output. Return \
            risks and concrete fixes.",
        "skeptic" => "You are a skeptic sub-agent in a multi-agent council. Your job is to \
            argue the OPPOSITE position to the researcher's claim. Stress-test assumptions; \
            surface counter-evidence, alternative framings, and unstated premises. Do NOT \
            agree to be polite — if the researcher is right, say specifically why the \
            strongest opposing case still fails. Be concrete, not contrarian-for-sport.",
        "synthesizer" => "You are a synthesizer sub-agent in a multi-agent council. You \
            receive outputs from a researcher, a critic, and a skeptic. Merge them into ONE \
            coherent candidate answer. Weigh evidence, do not average positions. Where the \
            critic or skeptic revealed a genuine flaw in the researcher's claim, update the \
            claim; where their objections were weak, dismiss them briefly. Return the \
            candidate answer as plain prose — no bullet list of 'what each agent said'.",
        "arbiter" => "You are the arbiter sub-agent — final judge of a multi-agent council. \
            You receive the researcher, critic, skeptic, AND synthesizer outputs plus the \
            synthesizer's candidate answer. Your job is NOT to average. Pick the single \
            best position, or explicitly synthesise a new one that beats all four. Then \
            write the final answer as plain prose. On the very LAST line, output exactly: \
            CONFIDENCE: N%  where N is an integer 0-100 reflecting how confident you are \
            in the final answer. Nothing after that line.",
        _ => "You are a specialised sub-agent. Complete the task concisely and return \
            a direct answer.",
    };
    format!(
        "{persona}\n\nSpeak in short British sentences; no emoji. Return your final \
        answer as plain text when done — your caller is another agent that will parse it."
    )
}
