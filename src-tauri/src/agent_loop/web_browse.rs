//! `web_browse` — drive Safari with a `browser_driver` sub-agent to
//! accomplish a navigation goal.
//!
//! Canonical use: Sunny says "SUNNY, go to news.ycombinator.com and find
//! the top story about X". The composite:
//!   1. Builds a task prompt instructing the browser_driver how to use
//!      its allowed tools (`browser_open`, `browser_read_page_text`,
//!      `web_extract_links`) within a hard `max_steps` cap.
//!   2. Spawns the sub-agent via `spawn_subagent` with role
//!      `"browser_driver"` so the `scope` module restricts it to
//!      browser + web read tools (plus compute/memory read).
//!   3. Returns the sub-agent's final answer.
//!
//! Confirm-gate behaviour is INHERITED — each `browser_open` call the
//! sub-agent makes goes through `is_dangerous("browser_open") == true`
//! so Sunny still confirms each page load. `web_browse` itself is not
//! in the dangerous list (no direct side effect of its own).

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use super::helpers::{string_arg, u32_arg};
use super::subagents::spawn_subagent;

/// Wall-clock ceiling for the browser_driver sub-agent. Each step can open
/// a page and wait for it to load; 20 steps @ ~5s each = 100s worst case.
const BROWSE_TIMEOUT_SECS: u64 = 180;

const DEFAULT_MAX_STEPS: u32 = 8;
const MIN_MAX_STEPS: u32 = 1;
const MAX_MAX_STEPS: u32 = 20;

pub async fn web_browse(
    app: &AppHandle,
    start_url: &str,
    goal: &str,
    max_steps: Option<u32>,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let start_url = start_url.trim();
    if start_url.is_empty() {
        return Err("web_browse: 'start_url' is empty".to_string());
    }
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("web_browse: 'goal' is empty".to_string());
    }

    // Minimum shape check — reject obvious non-URLs before burning a
    // sub-agent. We don't parse rigorously; the sub-agent will surface
    // `browser_open` errors for anything bogus we let through.
    if !(start_url.starts_with("http://") || start_url.starts_with("https://")) {
        return Err(format!(
            "web_browse: 'start_url' must begin with http:// or https:// — got {start_url}"
        ));
    }

    let cap = max_steps.unwrap_or(DEFAULT_MAX_STEPS).clamp(MIN_MAX_STEPS, MAX_MAX_STEPS);

    let task = format!(
        "You are a browser-driver sub-agent. Your job is to complete \
         Sunny's goal by navigating web pages.\n\n\
         START URL: {start_url}\n\
         GOAL: {goal}\n\n\
         You have EXACTLY these tools available:\n\
           • browser_open — open a URL in Safari (user will confirm each call)\n\
           • browser_read_page_text — read the visible text of the current Safari tab\n\
           • web_extract_links — fetch a URL's links without opening it in Safari\n\
           • web_fetch — fetch a URL's readable text without opening Safari\n\n\
         RULES:\n\
         1. Hard limit: {cap} tool calls total. Budget them carefully.\n\
         2. Start by opening the START URL and reading the page text.\n\
         3. Prefer `web_fetch` / `web_extract_links` over `browser_open` \
            when you only need to read content — those don't require \
            confirmation and are faster.\n\
         4. When you have the answer, stop calling tools and write your \
            final response.\n\
         5. Your final response MUST contain:\n\
            ANSWER: <one-to-three sentences directly addressing the goal>\n\
            RELEVANT_URLS:\n\
              - <url> — <one-line why it matters>\n\
              - (list up to 5, fewer is fine)\n\
         6. Do not invent URLs. Every URL in RELEVANT_URLS must have \
            appeared in a tool output during this run.\n\
         7. If the goal is unreachable (site down, paywall, blocked), \
            say so plainly and return whatever partial evidence you \
            gathered.\n\n\
         Begin."
    );

    tokio::time::timeout(
        Duration::from_secs(BROWSE_TIMEOUT_SECS),
        spawn_subagent(
            app,
            "browser_driver",
            &task,
            None,
            parent_session_id.map(String::from),
            depth,
        ),
    )
    .await
    .map_err(|_| format!("web_browse: browser_driver timed out after {BROWSE_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("web_browse: browser_driver failed: {e}"))
}

pub fn parse_input(input: &Value) -> Result<(String, String, Option<u32>), String> {
    let start_url = string_arg(input, "start_url")?;
    let goal = string_arg(input, "goal")?;
    let max_steps = u32_arg(input, "max_steps");
    Ok((start_url, goal, max_steps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_requires_start_url_and_goal() {
        assert!(parse_input(&json!({})).is_err());
        assert!(parse_input(&json!({"start_url":"https://x.com"})).is_err());
        assert!(parse_input(&json!({"goal":"find X"})).is_err());
        let (u, g, m) =
            parse_input(&json!({"start_url":"https://x.com","goal":"find X"})).unwrap();
        assert_eq!(u, "https://x.com");
        assert_eq!(g, "find X");
        assert!(m.is_none());
    }

    #[test]
    fn parse_reads_max_steps() {
        let (_u, _g, m) = parse_input(&json!({
            "start_url":"https://x.com","goal":"g","max_steps":3
        }))
        .unwrap();
        assert_eq!(m, Some(3));
    }
}
