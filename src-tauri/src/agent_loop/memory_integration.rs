//! Memory wiring for the agent loop — digest assembly, auto-remember, and
//! episodic write-back.
//!
//! Three responsibilities:
//!
//! 1. **Turn-start digest** (`build_memory_digest`) — assembles the
//!    "What I already know about Sunny" + world-model + recent-conversation
//!    block injected into every system prompt. Delegates to `memory::pack`
//!    for FTS + embedding retrieval and caps the conversation tail at
//!    `RECENT_CONVO_MAX_CHARS` (1 500 chars) so a long back-and-forth can't
//!    crowd out the fact digest.
//!
//! 2. **Auto-remember** (`auto_remember_from_user`) — scans the user's raw
//!    message for five narrow first-person phrasings after a successful agent
//!    reply and persists matches as semantic facts. Precision over recall:
//!    spurious extractions pollute memory; missed ones can be added explicitly.
//!
//! 3. **Turn-end write-back** (`write_run_episodic`) — persists the completed
//!    turn (user text + agent reply + tool sequence) as an episodic row so
//!    consolidation and reflection have raw material to mine.

use std::time::Duration;
use std::time::Instant;

use serde_json::json;

use crate::ai::ChatMessage;

use super::helpers::truncate;

/// Maximum total character budget for the "Recent conversation:" block
/// appended to the memory digest. Caps the convo tail so a long back-and-
/// forth can't dominate the system prompt — the digest as a whole must
/// leave room for SOUL/IDENTITY/etc. 1500 chars ≈ 3-6 turn pairs of
/// moderate length, which is the sweet spot before diminishing returns.
const RECENT_CONVO_MAX_CHARS: usize = 1500;

/// Per-message truncation inside the convo block. Keeps individual long
/// replies from swallowing the whole budget while still preserving enough
/// context to be useful. Paired with RECENT_CONVO_MAX_CHARS so we never
/// blow the outer cap even when every slot hits the per-message limit.
const RECENT_CONVO_PER_MSG_CHARS: usize = 220;

// ---------------------------------------------------------------------------
// Memory wiring — digest at turn start, episodic write at turn end,
// auto-remember between the LLM reply and the chat.done emission.
// ---------------------------------------------------------------------------

/// Lightweight first-person fact extractor. Called after the main agent
/// produces a successful `Final` reply but before `chat.done` fires, so
/// the next turn's memory pack already knows any newly-disclosed fact.
///
/// We deliberately keep the patterns narrow: five first-person phrasings
/// that are almost never ambiguous. A missed extraction is fine (the
/// user can always use `memory_remember` via the tool), but a spurious
/// one pollutes semantic memory — so precision beats recall here.
///
/// Every match is persisted via `memory::note_add` (episodic-note
/// shape) plus a semantic fact upsert keyed on the same subject. The
/// semantic write is what `memory_recall` and the memory-digest builder
/// actually consume; the episodic row is just a breadcrumb.
pub async fn auto_remember_from_user(message: &str) {
    use regex::Regex;
    use std::sync::OnceLock;

    // Whole-message match, case-insensitive, trimmed first so trailing
    // punctuation / whitespace doesn't defeat the `$` anchor.
    static NAME_IS: OnceLock<Regex> = OnceLock::new();
    static I_AM: OnceLock<Regex> = OnceLock::new();
    static I_LIVE: OnceLock<Regex> = OnceLock::new();
    static REMEMBER: OnceLock<Regex> = OnceLock::new();
    static PREFER: OnceLock<Regex> = OnceLock::new();

    let name_is = NAME_IS.get_or_init(|| {
        Regex::new(r"(?i)^my name is ([A-Za-z][A-Za-z \-']{1,30})\.?$").expect("name-is regex")
    });
    let i_am = I_AM.get_or_init(|| {
        Regex::new(r"(?i)^i(?:'m| am) ([A-Za-z][A-Za-z \-']{1,30})$").expect("i-am regex")
    });
    let i_live = I_LIVE.get_or_init(|| {
        Regex::new(r"(?i)^i (?:live in|'m in|am in) (.+)$").expect("i-live regex")
    });
    let remember = REMEMBER.get_or_init(|| {
        Regex::new(r"(?i)^(?:remember (?:that )?|note (?:that )?)(.+)$").expect("remember regex")
    });
    let prefer = PREFER.get_or_init(|| {
        Regex::new(r"(?i)^i prefer (.+)$").expect("prefer regex")
    });

    let trimmed = message.trim().trim_end_matches(|c: char| c == '.' || c == '!' || c == '?');
    if trimmed.is_empty() {
        return;
    }

    struct Match {
        pattern: &'static str,
        subject: &'static str,
        fact: String,
    }

    let mut matches: Vec<Match> = Vec::new();

    if let Some(caps) = name_is.captures(trimmed) {
        if let Some(g) = caps.get(1) {
            matches.push(Match {
                pattern: "name_is",
                subject: "user.name",
                fact: format!("user name: {}", g.as_str().trim()),
            });
        }
    } else if let Some(caps) = i_am.captures(trimmed) {
        // Skip common verb continuations that trigger false positives
        // ("I'm going to…", "I am doing…"). We already constrained the
        // capture to a short alphabetic token so most junk is filtered,
        // but a couple of common gerund/verb openers slip through.
        if let Some(g) = caps.get(1) {
            let candidate = g.as_str().trim();
            let lower = candidate.to_ascii_lowercase();
            let is_verb = lower.starts_with("going ")
                || lower.starts_with("doing ")
                || lower.starts_with("working ")
                || lower.starts_with("trying ")
                || lower.starts_with("feeling ")
                || lower.starts_with("looking ")
                || lower.starts_with("not ")
                || lower == "fine"
                || lower == "ok"
                || lower == "okay"
                || lower == "good"
                || lower == "well"
                || lower == "tired"
                || lower == "sorry";
            if !is_verb {
                matches.push(Match {
                    pattern: "i_am",
                    subject: "user.name",
                    fact: format!("user goes by: {candidate}"),
                });
            }
        }
    }

    if let Some(caps) = i_live.captures(trimmed) {
        if let Some(g) = caps.get(1) {
            matches.push(Match {
                pattern: "i_live",
                subject: "user.location",
                fact: format!("user location: {}", g.as_str().trim()),
            });
        }
    }

    if let Some(caps) = remember.captures(trimmed) {
        if let Some(g) = caps.get(1) {
            matches.push(Match {
                pattern: "remember",
                subject: "user.note",
                fact: format!("sunny says: {}", g.as_str().trim()),
            });
        }
    }

    if let Some(caps) = prefer.captures(trimmed) {
        if let Some(g) = caps.get(1) {
            matches.push(Match {
                pattern: "prefer",
                subject: "user.preference",
                fact: format!("user preference: {}", g.as_str().trim()),
            });
        }
    }

    if matches.is_empty() {
        return;
    }

    for m in matches {
        log::info!(
            "[tool-use] auto-remember matched pattern={} → {}",
            m.pattern,
            m.fact
        );
        let fact_for_legacy = m.fact.clone();
        let fact_for_semantic = m.fact.clone();
        let subject = m.subject.to_string();

        // Fire both writes in one `spawn_blocking` so we only pay the
        // worker-hop cost once. Failures are swallowed — memory is a
        // side concern and must never block the user reply.
        let joined = tokio::task::spawn_blocking(move || {
            if let Err(e) = crate::memory::note_add(fact_for_legacy, vec!["auto-remember".into()])
            {
                log::warn!("[tool-use] auto-remember note_add failed: {e}");
            }
            if let Err(e) = crate::memory::semantic_add(
                subject,
                fact_for_semantic,
                vec!["auto-remember".into()],
                Some(1.0),
                Some("auto-remember".into()),
            ) {
                log::warn!("[tool-use] auto-remember semantic_add failed: {e}");
            }
        })
        .await;
        if let Err(e) = joined {
            log::warn!("[tool-use] auto-remember join error: {e}");
        }
    }
}

/// Render a "Recent conversation:" block summarising the last few turn
/// pairs from `history`. Returns `None` when the history is empty or no
/// usable (non-empty, non-system) messages survive filtering.
///
/// Policy:
///   * <6 messages → include every user/assistant turn verbatim (per-
///     message truncated to `RECENT_CONVO_PER_MSG_CHARS`).
///   * ≥6 messages → keep the last 3 user↔assistant pairs verbatim plus
///     a single "(N earlier turns)" summary line for everything older.
///
/// `ChatMessage.content` is plain text (the frontend never ships tool_use
/// blocks through the chat wire) so there's no leak-risk here. The total
/// block is hard-capped at `RECENT_CONVO_MAX_CHARS`; messages past that
/// cap are dropped from the tail backwards so the most recent turn always
/// survives.
fn build_recent_conversation_block(history: &[ChatMessage]) -> Option<String> {
    // Single pass over `history` with a bounded window — we render at
    // most 6 trailing user/assistant messages (3 pairs), so we never
    // need to hold more than 6 entries in memory regardless of how
    // long the full history is. Also tracks the total conversational
    // count so the "(N earlier turns)" summary can be produced without
    // a second walk. System rows and whitespace-only content are
    // filtered out here to match the upstream contract (system is
    // already handled by `compose_system_prompt`; empty content would
    // render as a lonely bullet).
    use std::collections::VecDeque;
    const WINDOW: usize = 6;
    let mut window: VecDeque<(&str, &str)> = VecDeque::with_capacity(WINDOW);
    let mut total_conv_rows: usize = 0;
    for m in history {
        if m.role.eq_ignore_ascii_case("system") {
            continue;
        }
        let trimmed = m.content.trim();
        if trimmed.is_empty() {
            continue;
        }
        let role = match m.role.to_ascii_lowercase().as_str() {
            "assistant" => "assistant",
            _ => "user",
        };
        if window.len() == WINDOW {
            window.pop_front();
        }
        window.push_back((role, trimmed));
        total_conv_rows += 1;
    }

    if window.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("Recent conversation:".to_string());

    // Only emit the summary line when we actually dropped messages.
    // Matches the previous threshold — the summary appears iff the
    // conversation had at least 6 conversational rows AND we kept the
    // trailing window of 6.
    let use_summary = total_conv_rows >= WINDOW;
    if use_summary {
        let skipped = total_conv_rows - window.len();
        if skipped > 0 {
            lines.push(format!("({} earlier turns)", skipped));
        }
    }
    for (role, content) in &window {
        let label = if *role == "assistant" { "SUNNY" } else { "Sunny" };
        lines.push(format!("- {}: {}", label, truncate(content, RECENT_CONVO_PER_MSG_CHARS)));
    }

    // Outer-cap enforcement: drop the OLDEST rendered messages (just
    // after the header / summary line) until the block fits. We keep
    // the header on line 0 and the optional "(N earlier turns)" line
    // on line 1 so the summary survives even if we need to drop
    // individual message lines to fit.
    let header_rows = if use_summary { 2 } else { 1 };
    let mut total: usize = lines.iter().map(|l| l.chars().count() + 1).sum();
    while total > RECENT_CONVO_MAX_CHARS && lines.len() > header_rows + 1 {
        // Remove the first message line (index == header_rows).
        let removed = lines.remove(header_rows);
        total = total.saturating_sub(removed.chars().count() + 1);
    }

    // If after dropping we only have the header(s) left, the block is
    // useless — bail rather than emit a lonely "Recent conversation:"
    // line with no content.
    if lines.len() <= header_rows {
        return None;
    }

    Some(lines.join("\n"))
}

/// Build a compact digest of relevant memory for the current turn, formatted
/// as plain bullet lines we prepend to the system prompt. Returns `None`
/// when the pack is empty, fails to build, or exceeds the soft deadline —
/// never blocks the voice loop.
///
/// `history` is the caller's prior-turn transcript (oldest-first). When
/// non-empty we append a "Recent conversation:" block summarising the
/// last few user↔assistant pairs so the agent re-enters the dialog with
/// short-term context even after a long thread. The convo block is
/// capped at `RECENT_CONVO_MAX_CHARS` to keep the digest from
/// dominating the system prompt.
///
/// Runs on `spawn_blocking` with a 500ms timeout because `build_pack` is a
/// synchronous sqlite call chain. The embed-based rerank inside it is
/// already short-circuited (`memory/pack.rs:142`) so in practice this is
/// a pair of FTS queries that complete in single-digit milliseconds, but
/// we still guard against sqlite contention stalling the voice turn.
pub async fn build_memory_digest(goal: &str, history: &[ChatMessage]) -> Option<String> {
    let goal_owned = goal.to_string();
    let started = Instant::now();
    let join = tokio::task::spawn_blocking(move || {
        let opts = crate::memory::pack::BuildOptions {
            // FTS-only, no skills on the critical path. The embed rerank
            // is already disabled inside pack.rs; skills add latency
            // without meaningful signal for the voice loop.
            goal: Some(goal_owned),
            semantic_limit: Some(8),
            recent_limit: Some(3),
            matched_limit: Some(3),
            skill_limit: Some(0),
        };
        crate::memory::pack::build_pack(opts)
    });

    let outcome = tokio::time::timeout(Duration::from_millis(500), join).await;
    // Pack failures are non-fatal — we still emit the recent-conversation
    // block on its own if we have history to show. Only the pack part of
    // the digest goes empty on a timeout / join error / build error.
    let pack = match outcome {
        Ok(Ok(Ok(p))) => Some(p),
        Ok(Ok(Err(e))) => {
            log::info!("[tool-use] memory pack build failed ({e}) — skipping pack section");
            None
        }
        Ok(Err(e)) => {
            log::info!("[tool-use] memory pack join error ({e}) — skipping pack section");
            None
        }
        Err(_) => {
            log::info!(
                "[tool-use] memory pack timed out after {}ms — skipping pack section",
                started.elapsed().as_millis()
            );
            None
        }
    };

    let mut lines: Vec<String> = Vec::new();

    if let Some(pack) = pack.as_ref() {
        if !pack.semantic.is_empty() {
            lines.push("What I already know about Sunny:".to_string());
            for f in pack.semantic.iter().take(8) {
                lines.push(format!("- {}", truncate(&f.text, 160)));
            }
        }

        if !pack.recent_episodic.is_empty() {
            lines.push("Recent events I observed:".to_string());
            for e in pack.recent_episodic.iter().take(3) {
                lines.push(format!("- {}", truncate(&e.text, 120)));
            }
        }

        // Inject the world state. The world updater background loop keeps
        // `pack.world` current (focus, activity, next event, mail unread,
        // battery) — before this, the pack was built but dropped before
        // rendering, so the LLM never saw it. Agent 10's architectural
        // review flagged this as the single highest-value fix: every
        // voice turn now reads context from "Right now:" instead of
        // having to guess or call world_info explicitly.
        if let Some(world_lines) = render_world_block(pack.world.as_ref()) {
            lines.push(world_lines);
        }
    }

    // Append the recent-conversation block last so the agent reads it
    // closest to the current user turn. This block is independent of
    // the memory pack — even when the pack is empty / timed out, a
    // history tail is still worth showing.
    if let Some(convo) = build_recent_conversation_block(history) {
        if !lines.is_empty() {
            // Blank line between pack sections and the convo block so
            // the model sees them as distinct contexts.
            lines.push(String::new());
        }
        lines.push(convo);
    }

    if lines.is_empty() {
        log::info!(
            "[tool-use] memory pack built in {}ms — empty (no digest)",
            started.elapsed().as_millis()
        );
        None
    } else {
        let joined = lines.join("\n");
        log::info!(
            "[tool-use] memory pack built in {}ms — digest_len={}",
            started.elapsed().as_millis(),
            joined.len()
        );
        Some(joined)
    }
}

/// Render the world state as a compact "Right now:" block. Each line is
/// only included if the underlying field has meaningful signal (no point
/// telling the LLM "mail unread: null" when we don't know). Returns None
/// when nothing is worth reporting — in which case the caller skips the
/// section entirely rather than emitting a dangling header.
fn render_world_block(world: Option<&crate::world::WorldState>) -> Option<String> {
    let w = world?;
    let mut bullets: Vec<String> = Vec::new();

    // Focus: app + window title. Skip when both are empty (user is at the
    // desktop or just launched the app — nothing to say).
    if let Some(focus) = w.focus.as_ref() {
        if !focus.app_name.is_empty() {
            let line = if focus.window_title.is_empty() {
                format!("focused: {}", focus.app_name)
            } else {
                format!(
                    "focused: {} — \"{}\"",
                    focus.app_name,
                    truncate(&focus.window_title, 80)
                )
            };
            bullets.push(line);
        }
    }

    // Activity: only report when classifier is confident enough to name a
    // category. "Unknown" and "Idle" are not useful context. Matching by
    // string keeps us out of the private `world::model` module.
    match w.activity.as_str() {
        "unknown" | "idle" => {}
        other => bullets.push(format!("activity: {other}")),
    }

    // Next calendar event: title + relative time when start is parseable.
    // Only include if the event is within ~24 h — anything further out is
    // ambient context the user didn't ask about.
    if let Some(ev) = w.next_event.as_ref() {
        if !ev.title.is_empty() {
            let rel = relative_time_to(&ev.start, w.timestamp_ms);
            let line = match rel {
                Some(r) => format!("next event: \"{}\" {}", truncate(&ev.title, 60), r),
                None => format!("next event: \"{}\"", truncate(&ev.title, 60)),
            };
            bullets.push(line);
        }
    }

    // Mail unread: only surface if nonzero — "0 unread" is noise.
    if let Some(n) = w.mail_unread {
        if n > 0 {
            bullets.push(format!("mail unread: {n}"));
        }
    }

    // Battery: only surface when discharging AND below 20%. The user
    // doesn't care SUNNY knows battery=73% while plugged in; they care
    // when it's about to matter.
    if let (Some(pct), Some(charging)) = (w.battery_pct, w.battery_charging) {
        if !charging && pct < 20.0 {
            bullets.push(format!("battery: {:.0}% (discharging)", pct));
        }
    }

    if bullets.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(64 + bullets.iter().map(|b| b.len() + 3).sum::<usize>());
    out.push_str("Right now:");
    for b in bullets {
        out.push_str("\n- ");
        out.push_str(&b);
    }
    Some(out)
}

/// Turn an ISO-8601 event start time + current epoch-ms into a short
/// phrase like "in 25 minutes", "in 3 hours", "tomorrow", or None when
/// the event is >24h out (or the string can't be parsed). Best-effort:
/// parsing failures return None rather than panicking.
fn relative_time_to(iso: &str, now_ms: i64) -> Option<String> {
    use chrono::TimeZone;
    // Try RFC3339 first (e.g. "2026-04-20T14:30:00Z" or "...+07:00")
    let epoch_secs: i64 = if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
        dt.timestamp()
    } else {
        // calendar.rs emits "YYYY-MM-DDTHH:MM:SS" without timezone —
        // treat as local wall-clock time.
        let naive = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S").ok()?;
        chrono::Local.from_local_datetime(&naive).single()?.timestamp()
    };
    let delta_secs = epoch_secs - (now_ms / 1000);
    if delta_secs < 0 {
        return Some("(started)".into());
    }
    if delta_secs < 90 {
        return Some("in under a minute".into());
    }
    if delta_secs < 3600 {
        return Some(format!("in {} min", delta_secs / 60));
    }
    if delta_secs < 24 * 3600 {
        return Some(format!("in {} hr", delta_secs / 3600));
    }
    None
}

/// Write an episodic row for this agent run. Captures goal and full tool
/// sequence so the downstream skill synthesiser can spot repeatable
/// patterns. Failures are logged and swallowed — memory is a side
/// concern, it should never block the user's reply.
pub fn write_run_episodic(goal: &str, tool_names: &[String], status: &str) {
    let tags = vec!["run".to_string(), status.to_string()];
    let meta = json!({
        "goal": goal,
        "tool_sequence": tool_names,
    });
    let text = if tool_names.is_empty() {
        format!("[{status}] {}", truncate(goal, 200))
    } else {
        format!(
            "[{status}] {} | tools: {}",
            truncate(goal, 200),
            tool_names.join(", ")
        )
    };
    if let Err(e) =
        crate::memory::episodic_add(crate::memory::EpisodicKind::AgentStep, text, tags, meta)
    {
        log::debug!("agent_loop: episodic write failed ({e})");
    }

    // Hook 3: continuity graph — auto-log session node. Non-blocking; any
    // failure is silently skipped so memory writes never block the turn.
    {
        let session_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let slug = format!("session-{session_ts}");
        let title = format!("Session {session_ts}");
        // Summary = goal (truncated). A richer LLM summary can be passed
        // here once the session-summariser is wired; goal is always available.
        let summary = truncate(goal, 400);
        let tag_refs: Vec<&str> = [status, "session", "auto-log"]
            .iter()
            .copied()
            .collect();
        if let Some(arc) = crate::memory::continuity_store::global() {
            if let Ok(store) = arc.lock() {
                let upsert_result = store.upsert_node(
                    crate::memory::continuity_store::NodeKind::Session,
                    &slug,
                    &title,
                    &summary,
                    &tag_refs,
                );
                if let Err(e) = upsert_result {
                    log::debug!("agent_loop: continuity upsert skipped ({e})");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Continuity warm-context digest
// ---------------------------------------------------------------------------

/// Maximum character budget for the continuity warm-context block prepended
/// to the system prompt at every session start.
const CONTINUITY_DIGEST_CAP: usize = 800;

/// Build a compact warm-context digest from the last `n_sessions` entries in
/// the continuity graph, formatted as compact Markdown.
///
/// Returns `None` when:
///   - `continuity.warm_context_enabled` is `false` in `~/.sunny/settings.json`
///   - The continuity store is offline or its mutex is poisoned
///   - No nodes have been recorded yet in the graph
///
/// Format:
/// ```text
/// ## Prior sessions (last 3)
/// - [session-123] "Morning session": Worked on GovGrants auth. #blocker
/// - [session-124] "Debug build": Fixed the Tauri codesign issue.
/// ```
///
/// Total output is hard-capped at [`CONTINUITY_DIGEST_CAP`] characters;
/// individual entry summaries are ellipsis-truncated to fit. This function
/// is synchronous and completes in single-digit milliseconds (SQLite
/// read-only query).
pub fn build_continuity_digest(n_sessions: usize) -> Option<String> {
    // Gate: continuity.warm_context_enabled defaults TRUE when absent so warm
    // context works out of the box without explicit configuration.
    let enabled = crate::settings::load()
        .ok()
        .and_then(|v| {
            v.get("continuity")
                .and_then(|c| c.get("warm_context_enabled"))
                .and_then(|e| e.as_bool())
        })
        .unwrap_or(true);

    if !enabled {
        log::debug!("[continuity] warm_context_enabled=false — skipping digest");
        return None;
    }

    // Graceful skip when the store is not yet initialised or $HOME is
    // unavailable (e.g. sandboxed build environments).
    let arc = crate::memory::continuity_store::global()?;
    let store = match arc.lock() {
        Ok(g) => g,
        Err(_) => {
            log::debug!("[continuity] store mutex poisoned — skipping digest");
            return None;
        }
    };
    let nodes = match store.recent_context(n_sessions) {
        Ok(n) => n,
        Err(e) => {
            log::debug!("[continuity] recent_context failed ({e}) — skipping digest");
            return None;
        }
    };

    let digest = format_continuity_digest(&nodes)?;
    log::debug!(
        "[continuity] warm-context digest: {} chars, {} entries",
        digest.chars().count(),
        nodes.len(),
    );
    Some(digest)
}

/// Pure formatter — converts a pre-fetched node slice into compact Markdown.
///
/// Separated from `build_continuity_digest` for unit-testability: the
/// formatting logic has no side effects and operates only on the slice.
/// Returns `None` when the slice is empty.  Entries are appended until the
/// cumulative character count would exceed [`CONTINUITY_DIGEST_CAP`]; the
/// summary text within each entry is ellipsis-truncated to fit, or the
/// entry is omitted entirely when even the skeleton no longer fits.
fn format_continuity_digest(
    nodes: &[crate::memory::continuity_store::Node],
) -> Option<String> {
    if nodes.is_empty() {
        return None;
    }

    let header = format!("## Prior sessions (last {})", nodes.len());
    // Running budget in chars: start with the cap minus the header line.
    let mut remaining: usize = CONTINUITY_DIGEST_CAP
        .saturating_sub(header.chars().count() + 1); // +1 for newline separator
    let mut lines: Vec<String> = vec![header];

    for node in nodes {
        let tags_str = if node.tags.is_empty() {
            String::new()
        } else {
            format!(" {}", node.tags.join(" "))
        };

        // Take the first non-empty, non-heading line of the summary.
        let raw_summary = node
            .summary
            .lines()
            .find(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .unwrap_or("")
            .trim();

        // Skeleton cost = prefix chars + tags chars + 1 newline separator.
        let prefix = format!("- [{}] \"{}\": ", node.slug, node.title);
        let skeleton_cost = prefix.chars().count() + tags_str.chars().count() + 1;

        if remaining < skeleton_cost {
            break; // No room even for the bare skeleton — stop adding entries.
        }
        let summary_budget = remaining.saturating_sub(skeleton_cost);

        let summary_part = if raw_summary.chars().count() <= summary_budget {
            raw_summary.to_string()
        } else if summary_budget == 0 {
            String::new()
        } else {
            // Ellipsis-truncate: leave 1 char for the ellipsis character.
            let cut: String = raw_summary
                .chars()
                .take(summary_budget.saturating_sub(1))
                .collect();
            format!("{}…", cut.trim_end())
        };

        let entry = format!("{}{}{}", prefix, summary_part, tags_str);
        remaining = remaining.saturating_sub(entry.chars().count() + 1);
        lines.push(entry);
    }

    if lines.len() <= 1 {
        return None;
    }

    Some(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn recent_convo_none_when_empty() {
        let out = build_recent_conversation_block(&[]);
        assert!(out.is_none());
    }

    #[test]
    fn recent_convo_skips_whitespace_only_messages() {
        // A history of only blank content shouldn't render a lonely
        // header — bail with None instead.
        let history = vec![msg("user", "   "), msg("assistant", "\n\n")];
        assert!(build_recent_conversation_block(&history).is_none());
    }

    #[test]
    fn recent_convo_short_history_verbatim() {
        // <6 messages → every message should appear, no summary line.
        let history = vec![
            msg("user", "hey sunny"),
            msg("assistant", "hello Sunny, what's up"),
            msg("user", "remember the last thing"),
        ];
        let block = build_recent_conversation_block(&history).expect("some block");
        assert!(block.starts_with("Recent conversation:"));
        assert!(block.contains("Sunny: hey sunny"));
        assert!(block.contains("SUNNY: hello Sunny, what's up"));
        assert!(block.contains("Sunny: remember the last thing"));
        assert!(!block.contains("earlier turns"));
    }

    #[test]
    fn recent_convo_long_history_keeps_last_three_pairs_with_summary() {
        // 5 pairs → 10 messages. Should keep last 3 pairs (6 msgs) +
        // a "(4 earlier turns)" summary line for the 4 dropped.
        let mut history: Vec<ChatMessage> = Vec::new();
        for i in 0..5 {
            history.push(msg("user", &format!("question {i}")));
            history.push(msg("assistant", &format!("answer {i}")));
        }
        let block = build_recent_conversation_block(&history).expect("some block");
        assert!(block.starts_with("Recent conversation:"));
        assert!(block.contains("(4 earlier turns)"));
        // Last three pairs (indices 2..=4) must be present.
        for i in 2..5 {
            assert!(block.contains(&format!("question {i}")), "missing q{i}");
            assert!(block.contains(&format!("answer {i}")), "missing a{i}");
        }
        // First two pairs must be gone.
        for i in 0..2 {
            assert!(!block.contains(&format!("question {i}")), "leaked q{i}");
            assert!(!block.contains(&format!("answer {i}")), "leaked a{i}");
        }
    }

    /// Very-long history stresses the bounded-window iteration: 500
    /// turns = 1000 messages, but we must still keep only the last 6
    /// and emit a "(994 earlier turns)" summary. No unbounded allocation
    /// is observable at this API surface, but this test guards against
    /// a regression that accidentally reintroduces the full-history Vec
    /// — the summary count would reveal it.
    #[test]
    fn recent_convo_very_long_history_bounded_window() {
        let mut history: Vec<ChatMessage> = Vec::new();
        for i in 0..500 {
            history.push(msg("user", &format!("q{i}")));
            history.push(msg("assistant", &format!("a{i}")));
        }
        let block = build_recent_conversation_block(&history).expect("some block");
        // 1000 total conversational rows, 6 kept → 994 summarised.
        assert!(
            block.contains("(994 earlier turns)"),
            "summary must reflect bounded window; got:\n{block}"
        );
        // Only the last 3 pairs (indices 497..=499) should appear.
        assert!(block.contains("q497"), "q497 must be present");
        assert!(block.contains("a499"), "a499 must be present");
        assert!(!block.contains("q100"), "q100 must be dropped");
        assert!(!block.contains("a0"), "a0 must be dropped");
    }

    #[test]
    fn recent_convo_respects_char_cap() {
        // Build a long history where each reply is huge. Even after
        // per-message truncation the outer cap must win.
        let big = "x".repeat(5000);
        let mut history: Vec<ChatMessage> = Vec::new();
        for _ in 0..10 {
            history.push(msg("user", &big));
            history.push(msg("assistant", &big));
        }
        let block = build_recent_conversation_block(&history).expect("some block");
        assert!(
            block.chars().count() <= RECENT_CONVO_MAX_CHARS + 32,
            "block {} > cap {}",
            block.chars().count(),
            RECENT_CONVO_MAX_CHARS
        );
    }

    #[test]
    fn recent_convo_filters_system_role() {
        // System messages should never make it into the convo block —
        // they're rendered upstream by compose_system_prompt.
        let history = vec![
            msg("system", "you are sunny"),
            msg("user", "hi"),
            msg("assistant", "hi sunny"),
        ];
        let block = build_recent_conversation_block(&history).expect("some block");
        assert!(!block.to_lowercase().contains("you are sunny"));
        assert!(block.contains("Sunny: hi"));
    }

    #[test]
    fn digest_includes_recent_turns() {
        // Exercises the full `build_memory_digest` path: no memory
        // subsystem is needed because the pack build is allowed to
        // fail silently — we just need to prove the convo block shows
        // up in the returned digest when history is non-empty.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");

        let history = vec![
            msg("user", "what's the capital of France"),
            msg("assistant", "Paris, love."),
            msg("user", "and of Japan"),
            msg("assistant", "Tokyo."),
            msg("user", "thanks"),
            msg("assistant", "any time."),
        ];

        let digest = rt.block_on(async move {
            build_memory_digest("follow-up question", &history).await
        });

        let digest = digest.expect("digest should include convo block");
        assert!(
            digest.contains("Recent conversation:"),
            "digest missing convo header: {digest}"
        );
        assert!(digest.contains("Tokyo"), "digest missing last assistant reply");
        assert!(digest.contains("Sunny: thanks"), "digest missing last user turn");
    }

    // ---------------------------------------------------------------------------
    // Smoke test (c) — Phase-2 hook wiring
    // ---------------------------------------------------------------------------

    /// Smoke (c): `write_run_episodic` with a dummy goal produces a node in the
    /// continuity store. We point the global at an isolated temp DB so the test
    /// is fully hermetic and doesn't touch `~/.sunny/continuity.db`.
    #[test]
    fn write_run_episodic_creates_continuity_node() {
        use crate::memory::continuity_store::{ContinuityStore, NodeKind};
        use std::sync::{Arc, Mutex};

        // Prepare an isolated temp dir for this test's continuity DB.
        let tmp = std::env::temp_dir().join(format!(
            "sunny-cont-smoke-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).expect("tmp dir");

        // Pre-populate the global with the test store.
        let store = ContinuityStore::open(&tmp).expect("open test store");
        let arc: Arc<Mutex<ContinuityStore>> = Arc::new(Mutex::new(store));
        // Inject via once_cell. If already claimed by a parallel test, the
        // `write_run_episodic` below would write to that other global instead
        // of our `arc` — skip cleanly in that case.
        if crate::memory::continuity_store::CONTINUITY_GLOBAL
            .set(arc.clone())
            .is_err()
        {
            eprintln!("continuity global already claimed by a sibling test; skipping");
            std::fs::remove_dir_all(&tmp).ok();
            return;
        }

        // Call the function under test.
        super::write_run_episodic("smoke test goal", &["tool_a".to_string()], "success");

        // Verify a Session node was written.
        let locked = arc.lock().expect("lock");
        let recent = locked.recent_context(10).expect("recent_context");
        let sessions: Vec<_> = recent
            .iter()
            .filter(|n| n.kind == NodeKind::Session)
            .collect();
        assert!(
            !sessions.is_empty(),
            "write_run_episodic must produce at least one Session node in continuity"
        );
        assert!(
            sessions[0].summary.contains("smoke test goal"),
            "session summary must include goal text"
        );


        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ---------------------------------------------------------------------------
    // format_continuity_digest unit tests
    // ---------------------------------------------------------------------------

    fn make_node(slug: &str, title: &str, summary: &str, tags: &[&str]) -> crate::memory::continuity_store::Node {
        crate::memory::continuity_store::Node {
            slug: slug.to_string(),
            kind: crate::memory::continuity_store::NodeKind::Session,
            title: title.to_string(),
            summary: summary.to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            created_ts: 0,
            updated_ts: 0,
            deleted_at: None,
        }
    }

    /// format_continuity_digest on an empty slice returns None.
    #[test]
    fn continuity_digest_empty_nodes_returns_none() {
        let nodes: Vec<crate::memory::continuity_store::Node> = vec![];
        assert!(
            format_continuity_digest(&nodes).is_none(),
            "empty slice must produce None"
        );
    }

    /// A single node produces the expected Markdown header + bullet entry.
    #[test]
    fn continuity_digest_single_node_format() {
        let nodes = vec![make_node(
            "session-123",
            "Morning session",
            "Worked on GovGrants auth.",
            &["#blocker"],
        )];
        let digest = format_continuity_digest(&nodes).expect("digest should be produced");
        assert!(
            digest.starts_with("## Prior sessions (last 1)"),
            "header must lead the digest; got: {digest:?}"
        );
        assert!(
            digest.contains("- [session-123] \"Morning session\":"),
            "bullet must contain slug and quoted title; got: {digest:?}"
        );
        assert!(
            digest.contains("Worked on GovGrants auth."),
            "bullet must include summary text; got: {digest:?}"
        );
        assert!(
            digest.contains("#blocker"),
            "bullet must include tags; got: {digest:?}"
        );
    }

    /// Total digest length must not exceed CONTINUITY_DIGEST_CAP even when
    /// individual summaries are very long.
    #[test]
    fn continuity_digest_respects_char_cap() {
        let long_summary = "x".repeat(2000);
        let nodes: Vec<_> = (0..5)
            .map(|i| make_node(
                &format!("sess-cap-{i}"),
                &format!("Session {i}"),
                &long_summary,
                &[],
            ))
            .collect();
        let digest = format_continuity_digest(&nodes).expect("some entries must fit");
        let len = digest.chars().count();
        assert!(
            len <= CONTINUITY_DIGEST_CAP,
            "digest len {len} exceeds cap {CONTINUITY_DIGEST_CAP}"
        );
    }

    /// Entries that would push past the cap are omitted entirely. The first
    /// entry must always be present (it fits within the cap).
    #[test]
    fn continuity_digest_drops_entries_past_cap() {
        let medium_summary = "a".repeat(300);
        let nodes: Vec<_> = (0..3)
            .map(|i| make_node(
                &format!("drop-sess-{i}"),
                &format!("Session {i}"),
                &medium_summary,
                &[],
            ))
            .collect();
        let digest = format_continuity_digest(&nodes).expect("at least one entry fits");
        let len = digest.chars().count();
        assert!(
            len <= CONTINUITY_DIGEST_CAP,
            "digest must stay under cap ({len} > {CONTINUITY_DIGEST_CAP})"
        );
        assert!(
            digest.contains("drop-sess-0"),
            "first entry must be present in the digest"
        );
    }

}