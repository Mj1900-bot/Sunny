//! CAPABILITIES block — what tools SUNNY has access to.
//!
//! This block is a factual inventory of available tools, separated from
//! tool-USE instructions (which live in tool_use_block.rs). Keeping the
//! inventory here means we can update the list without touching the
//! few-shot examples or the safety rules.
//!
//! Pure/immutable — no global state touched.

/// Complete tool inventory. Injected once per system prompt so the model
/// always knows what it can reach for, even without the SOUL bundle.
pub const CAPABILITIES: &str = "\
--- CAPABILITIES ---
You have live function-calling access to the following tools:

INFORMATION & WEB
  web_search          — single-query web lookup (current facts, news, prices)
  deep_research       — multi-source cited research report (5+ sources)
  web_fetch           — fetch a specific URL and return its content
  world_info          — stable geographic / encyclopaedic facts

WEATHER & TIME
  weather_current     — live weather for a location
  weather_forecast    — multi-day forecast
  timezone_lookup     — current time in any city or timezone

PERSONAL DATA (Sunny's Mac)
  mail_*              — read, search, send email via Mail.app
  calendar_*          — read today/week events, add events
  reminders_*         — list, add, complete reminders
  notes_*             — read and create Apple Notes
  contacts_lookup     — look up phone numbers, emails, contact cards
  memory_recall       — recall facts Sunny has told you previously
  memory_remember     — save new facts about Sunny

MESSAGING & CALLS
  imessage_send       — send an iMessage (resolves contacts internally)
  messaging_send_sms  — send SMS
  facetime_*          — initiate FaceTime audio or video

SYSTEM & FILES
  screen_capture_full — raw screenshot PNG
  remember_screen     — capture + OCR + file under a tag (preferred for 'save this')
  clipboard_history   — read recent clipboard entries
  app_launch          — open a macOS application
  file_read           — read a file by path
  file_write          — write content to a file path
  focused_window      — get the currently focused app + window title

COMPUTATION
  calculator          — evaluate a mathematical expression
  unit_convert        — convert between units

AGENTS
  spawn_subagent      — delegate a task to a specialised sub-agent
  scheduled_task      — schedule a task to run at a future time

MEDIA
  media_play / media_pause / media_next — system media controls
  battery_status / system_metrics       — hardware status
--- END CAPABILITIES ---";

/// Build the capabilities block. Currently returns the constant, but wrapped
/// in a function so future callers can inject dynamic tool lists without
/// changing call sites.
///
/// Returns a newly allocated `String` — never mutates any argument.
pub fn build_capabilities_block() -> String {
    CAPABILITIES.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_block_contains_key_tools() {
        let block = build_capabilities_block();
        assert!(block.contains("web_search"), "must list web_search");
        assert!(block.contains("memory_recall"), "must list memory_recall");
        assert!(block.contains("memory_remember"), "must list memory_remember");
        assert!(block.contains("contacts_lookup"), "must list contacts_lookup");
        assert!(block.contains("spawn_subagent"), "must list spawn_subagent");
        assert!(block.contains("deep_research"), "must list deep_research");
        assert!(block.contains("imessage_send"), "must list imessage_send");
    }

    #[test]
    fn capabilities_block_has_open_and_close_fence() {
        let block = build_capabilities_block();
        assert!(block.contains("--- CAPABILITIES ---"), "must have opening fence");
        assert!(block.contains("--- END CAPABILITIES ---"), "must have closing fence");
    }

    #[test]
    fn build_capabilities_block_is_deterministic() {
        assert_eq!(
            build_capabilities_block(),
            build_capabilities_block(),
            "must be deterministic"
        );
    }
}
