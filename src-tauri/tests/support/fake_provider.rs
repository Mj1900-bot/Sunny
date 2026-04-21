//! `FakeProvider` — a scripted, turn-indexed LLM stand-in for integration
//! tests. No network calls are made; each `next_turn` call pops the front
//! of the scripted response queue and returns it.
//!
//! Also exports `ScriptedTurn` — the per-turn descriptor callers build to
//! describe what the fake model "returns" on that iteration.

use serde_json::{json, Value};
use std::collections::VecDeque;

use sunny_lib::agent_loop::types::{ToolCall, TurnOutcome};

/// One scripted response the fake model emits when called.
#[derive(Debug, Clone)]
pub enum ScriptedTurn {
    /// Model returns a final text answer.
    Final(String),
    /// Model calls one or more tools.
    Tools(Vec<ScriptedToolCall>),
}

/// Lightweight descriptor for a single tool call inside a scripted turn.
#[derive(Debug, Clone)]
pub struct ScriptedToolCall {
    pub name: &'static str,
    pub args: Value,
}

impl ScriptedToolCall {
    pub fn new(name: &'static str, args: Value) -> Self {
        Self { name, args }
    }
}

/// A deterministic provider that replays scripted turns one-by-one.
///
/// Constructed with a `Vec<ScriptedTurn>`; each call to `next_turn` pops
/// the front. If the queue is exhausted the provider panics — tests
/// should script exactly as many turns as the scenario drives.
pub struct FakeProvider {
    queue: VecDeque<ScriptedTurn>,
}

impl FakeProvider {
    pub fn new(script: Vec<ScriptedTurn>) -> Self {
        Self {
            queue: VecDeque::from(script),
        }
    }

    /// Pop the next scripted response and convert it to a `TurnOutcome`.
    pub fn next_turn(&mut self) -> TurnOutcome {
        let scripted = self
            .queue
            .pop_front()
            .expect("FakeProvider queue exhausted — add more ScriptedTurn entries");

        match scripted {
            ScriptedTurn::Final(text) => TurnOutcome::final_buffered(text),
            ScriptedTurn::Tools(calls) => {
                let tool_calls: Vec<ToolCall> = calls
                    .iter()
                    .enumerate()
                    .map(|(i, c)| ToolCall {
                        id: format!("fake_tool_id_{i}"),
                        name: c.name.to_string(),
                        input: c.args.clone(),
                    })
                    .collect();

                let assistant_message = json!({
                    "role": "assistant",
                    "content": tool_calls.iter().map(|tc| json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.input,
                    })).collect::<Vec<_>>()
                });

                TurnOutcome::Tools {
                    thinking: None,
                    calls: tool_calls,
                    assistant_message,
                }
            }
        }
    }

    /// Whether all scripted turns have been consumed. Useful for
    /// asserting the provider was fully drained.
    #[allow(dead_code)]
    pub fn is_exhausted(&self) -> bool {
        self.queue.is_empty()
    }
}
