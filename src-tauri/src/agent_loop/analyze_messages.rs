//! `analyze_messages` — profile a person from Sunny's iMessage history.
//!
//! Sunny's canonical use case: "analyze all my texts with <name> and give me
//! a report". This composite tool:
//!   1. resolves the name to a phone/email handle via the contacts index
//!   2. pulls the conversation from Messages.app's chat.db
//!   3. hands the rendered transcript to a sub-agent with an analyst prompt
//!   4. returns the sub-agent's structured report
//!
//! All three steps already exist as primitives (`contacts_book::get_index`,
//! `messaging::fetch_conversation`, `spawn_subagent`). This module just
//! wires them into one callable tool so the planner doesn't have to
//! orchestrate the three separate calls itself.

use std::time::Duration;

use serde_json::Value;

use super::subagents::spawn_subagent;
use crate::contacts_book;
use crate::messaging;

const MAX_MESSAGES: usize = 2000;
/// Cap on the analyst sub-agent. Transcripts are bounded by MAX_MESSAGES;
/// even 2000 messages should fit in a small model's context in under 90s.
const ANALYST_TIMEOUT_SECS: u64 = 90;

pub async fn analyze_messages(
    app: &tauri::AppHandle,
    name: &str,
    limit: Option<usize>,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let needle = name.trim();
    if needle.is_empty() {
        return Err("analyze_messages: name is empty".to_string());
    }

    // 1. Resolve name → handle via the contacts index. The index is a
    //    flat handle→name map, so we reverse-match by walking entries.
    let index = contacts_book::get_index().await;
    let needle_lower = needle.to_ascii_lowercase();
    let candidates: Vec<(String, String)> = index
        .entries()
        .into_iter()
        .filter(|(_handle, display)| display.to_ascii_lowercase().contains(&needle_lower))
        .collect();

    if candidates.is_empty() {
        return Err(format!(
            "analyze_messages: no contact matched '{needle}' — try the exact phone number or email instead"
        ));
    }

    // Prefer the exact-match contact if one exists; else take the first.
    let (chat_handle, chat_display) = candidates
        .iter()
        .find(|(_, d)| d.eq_ignore_ascii_case(needle))
        .cloned()
        .unwrap_or_else(|| candidates[0].clone());

    // 2. Pull the conversation. Cap at `MAX_MESSAGES` regardless of the
    //    caller's limit so a huge history can't blow the LLM context.
    let cap = limit.unwrap_or(500).min(MAX_MESSAGES);
    let messages = messaging::fetch_conversation(chat_handle.clone(), Some(cap), None)
        .await
        .map_err(|e| format!("fetch_conversation({chat_handle}): {e}"))?;

    if messages.is_empty() {
        return Ok(format!(
            "No messages found with {chat_display} ({chat_handle}). Either the conversation is \
             empty or chat.db access hasn't been granted yet."
        ));
    }

    // Render the transcript in plain-text with dates so the LLM can reason
    // about temporal patterns (who ghosted who, how often they reach out).
    // Keep it compact — one line per message.
    let mut transcript = String::with_capacity(messages.len() * 80);
    transcript.push_str(&format!(
        "Conversation with {chat_display} ({chat_handle}) — {} messages:\n\n",
        messages.len()
    ));
    for m in &messages {
        let who = if m.from_me { "Me" } else { m.sender.as_deref().unwrap_or(chat_display.as_str()) };
        let stamp = format_imessage_ts(m.ts);
        let body = m.text.trim();
        if body.is_empty() && !m.has_attachment {
            continue;
        }
        let content = if body.is_empty() {
            "[attachment]".to_string()
        } else if body.len() > 400 {
            let mut t: String = body.chars().take(400).collect();
            t.push_str(" …");
            t
        } else {
            body.to_string()
        };
        transcript.push_str(&format!("[{stamp}] {who}: {content}\n"));
    }

    // 3. Delegate the analysis to a researcher sub-agent. The analyst
    //    prompt asks for a structured report with sections the main
    //    agent can speak or write to a note.
    let task = format!(
        "Analyse the following iMessage conversation and produce a concise \
         personal-relationship profile. Do NOT call web_search or any \
         external tool — work only from the transcript below.\n\n\
         Return the report in these sections, each one or two short \
         paragraphs:\n\
         - Who they are (based on what's discussed)\n\
         - Communication rhythm (frequency, who initiates, response times, tone)\n\
         - Recurring topics or themes\n\
         - Open loops (unanswered questions, unresolved plans)\n\
         - Emotional read (warmth, conflict, recent changes)\n\
         - Notable facts to remember about them\n\n\
         Keep the whole report under 600 words. No bullet-list dumps; \
         prose that reads like a trusted friend briefing Sunny before a \
         reunion.\n\n\
         =====\n{transcript}\n====="
    );

    // We pass Some role="researcher". The sub-agent inherits the same
    // safety rails and returns a plain string which this tool relays
    // unchanged to the main agent.
    let model_override: Option<String> = None;
    let answer = tokio::time::timeout(
        Duration::from_secs(ANALYST_TIMEOUT_SECS),
        spawn_subagent(
            app,
            "researcher",
            &task,
            model_override,
            parent_session_id.map(String::from),
            depth,
        ),
    )
    .await
    .map_err(|_| format!("analyze_messages: analyst timed out after {ANALYST_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("analyze_messages sub-agent: {e}"))?;

    // Prefix for the parent agent so it can tell this apart from direct
    // answers in its context.
    Ok(format!(
        "[analyze_messages report — {} messages with {}]\n\n{}",
        messages.len(),
        chat_display,
        answer
    ))
}

fn format_imessage_ts(ts: i64) -> String {
    // iMessage stores message dates as nanoseconds since Apple's epoch
    // (2001-01-01 UTC). Convert to a human-readable stamp. Fall back to a
    // raw integer if the conversion looks off.
    const APPLE_EPOCH_OFFSET: i64 = 978_307_200; // seconds
    let unix = ts / 1_000_000_000 + APPLE_EPOCH_OFFSET;
    match chrono::DateTime::<chrono::Utc>::from_timestamp(unix, 0) {
        Some(dt) => dt
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string(),
        None => ts.to_string(),
    }
}

/// Parse the tool-call input. Split out so dispatch.rs stays terse.
pub fn parse_input(input: &Value) -> Result<(String, Option<usize>), String> {
    let name = input
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "analyze_messages: 'name' is required".to_string())?
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("analyze_messages: 'name' is empty".to_string());
    }
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize);
    Ok((name, limit))
}
