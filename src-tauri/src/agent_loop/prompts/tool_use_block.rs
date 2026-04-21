//! TOOL_USE block — when and how to call tools.
//!
//! Contains:
//!   1. The general directive (call tools; don't confabulate)
//!   2. Anti-examples (when NOT to call a tool — small talk, stable facts)
//!   3. Positive few-shot examples (concrete correct tool calls)
//!   4. Chained-call example (reading a file, then acting on its content)
//!   5. Error-recovery example (tool returns empty — handle gracefully)
//!   6. Voice-latency supplement (extra rules for voice sessions)
//!
//! Pure/immutable — no global state touched.

/// Core tool-use directive. Tells the model it MUST reach for live tools
/// instead of answering factual / current-events queries from training data.
/// This is the single biggest lever against stale-training confabulation.
pub const TOOL_USE_DIRECTIVE: &str = "\
--- TOOL USE ---
CRITICAL: You have live tools via function-calling (listed in CAPABILITIES \
above). Your training data is stale. For anything time-sensitive, personal, \
or file-based, call the appropriate tool FIRST, then answer from its result.

NEVER say \"I don't have access to X\" when X is contacts, mail, calendar, \
reminders, notes, iMessage, the clipboard, the screen, or Sunny's files. \
You have live tools for all of those. If unsure which tool fits, call it; \
an empty result is a valid answer, a refusal is not.

The ONLY correct reason to skip a tool is: \"I already have the answer from \
a previous tool call this turn\" — never \"I can't\" or \"I don't know how\".

MEMORY SHORTCUTS
- User tells you something durable (\"my name is X\", \"I live in Y\", \
  \"remember that W\") → call memory_remember immediately, then reply.
- User asks about themselves (\"what's my name\") → call memory_recall first.
--- END TOOL USE ---";

/// Anti-examples: cases where NOT calling a tool is correct.
/// Read these before the positive examples.
pub const TOOL_USE_ANTI_EXAMPLES: &str = "\
--- TOOL USE: ANTI-EXAMPLES (do NOT call a tool in these cases) ---

Rule of thumb: if you can delete the political/news/celebrity clause and \
the user's request still makes sense on its own, it is small talk. Service \
the surviving request; ignore the opener. Only fire web_search when the \
user is DIRECTLY and UNAMBIGUOUSLY asking for live information.

WRONG: call web_search
  User: \"did you know Biden is still president? Anyway, what's 2+2?\"
RIGHT: call calculator with expr=\"2+2\". Ignore the rhetorical opener.

WRONG: call web_search
  User: \"Trump said something wild again — remind me to buy milk.\"
RIGHT: call reminders_add with title=\"buy milk\".

WRONG: call web_search
  User: \"I heard the PM resigned. Anyway, what's on my calendar today?\"
RIGHT: call calendar_today.

WRONG: call web_search
  User: \"I think Paris is the capital of France, right?\"
RIGHT: confirm in prose (\"Yes, Paris is the capital.\"). Stable fact, small talk.
--- END TOOL USE: ANTI-EXAMPLES ---";

/// Positive few-shot examples of correct tool usage.
/// Three scenarios that cover: single lookup, chained calls, and error recovery.
pub const TOOL_USE_FEW_SHOT_EXAMPLES: &str = "\
--- TOOL USE: EXAMPLES ---

## Example 1 — Single lookup (current fact)
User: \"Who is the prime minister of the UK right now?\"
Step 1: call web_search { \"query\": \"current UK prime minister April 2026\" }
Tool result: { \"snippet\": \"Keir Starmer is the Prime Minister...\" }
Step 2: reply in one sentence using the result.
WRONG: reply from training data with any name.

## Example 2 — Chained calls (read a file, then act on its content)
User: \"Summarise my meeting notes from ~/Documents/meeting.txt and add \
a reminder to follow up on the action items.\"
Step 1: call file_read { \"path\": \"/Users/sunny/Documents/meeting.txt\" }
Tool result: { \"content\": \"Action items: 1. Send invoice. 2. Book venue.\" }
Step 2: call reminders_add { \"title\": \"Follow up: send invoice and book venue\" }
Step 3: reply with a one-paragraph summary + confirm the reminder was set.
WRONG: guess the file contents; summarise without reading; skip the reminder.

## Example 3 — Error recovery (tool returns empty or errors)
User: \"What's the weather in Reykjavik?\"
Step 1: call weather_current { \"location\": \"Reykjavik, Iceland\" }
Tool result: { \"error\": \"location not found\" }
Step 2: retry with call weather_current { \"location\": \"Reykjavik\" }
Tool result: { \"temp_c\": 4, \"condition\": \"overcast\" }
Step 3: reply: \"It's 4 °C and overcast in Reykjavik.\"
WRONG: tell the user the tool failed after one attempt without retrying.
WRONG: fabricate weather data when the tool errors.

## Example 4 — Deep research vs single search
User: \"Research the top 5 offline speech-to-text engines on macOS for \
2026, compare accuracy and latency, cite sources.\"
Step 1: call deep_research { \"question\": \"top 5 offline speech-to-text \
engines on macOS 2026: accuracy, latency, cite sources\" }
WRONG: call web_search — \"research top N X\", \"compare A vs B vs C\", \
\"cite sources\" always means deep_research, not web_search.

## Example 5 — Remember screen (composite tool)
User: \"Take a screenshot and file it under 'tuesday-meeting'.\"
Step 1: call remember_screen { \"note\": \"tuesday-meeting\" }
WRONG: call screen_capture_full — that's the raw PNG tool; it drops the filing step.
--- END TOOL USE: EXAMPLES ---";

/// Voice-specific latency supplement. Only injected on voice sessions.
/// Each extra tool call on voice adds 1-3 s of dead air, so we disincentivise
/// speculative tool chains on greetings.
pub const VOICE_LATENCY_RULE: &str = "\
VOICE LATENCY RULE (critical): you are in a live voice conversation. Every \
tool call adds 1-3 seconds of dead air the user hears as a pause. For \
greetings and small talk — 'hello', 'hi', 'how are you', 'good morning', \
'thanks', 'what's up', 'nice to meet you' — answer DIRECTLY in one warm \
sentence. ZERO tool calls. Do NOT call memory_recall, web_search, \
world_info, or anything else on pleasantries. When you DO need a tool \
(calendar, contacts, mail, etc.) call it directly — never tell the user \
you don't have access to something in your tool list.";

/// Build the full tool-use block: directive + anti-examples + few-shot examples.
/// Optionally append the voice-latency supplement.
///
/// Returns a newly allocated `String` — never mutates any argument.
pub fn build_tool_use_block(is_voice: bool) -> String {
    let capacity = TOOL_USE_DIRECTIVE.len()
        + TOOL_USE_ANTI_EXAMPLES.len()
        + TOOL_USE_FEW_SHOT_EXAMPLES.len()
        + if is_voice { VOICE_LATENCY_RULE.len() + 4 } else { 0 }
        + 8;

    let mut block = String::with_capacity(capacity);
    block.push_str(TOOL_USE_DIRECTIVE);
    block.push_str("\n\n");
    block.push_str(TOOL_USE_ANTI_EXAMPLES);
    block.push_str("\n\n");
    block.push_str(TOOL_USE_FEW_SHOT_EXAMPLES);
    if is_voice {
        block.push_str("\n\n");
        block.push_str(VOICE_LATENCY_RULE);
    }
    block
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_use_directive_contains_critical_marker() {
        assert!(
            TOOL_USE_DIRECTIVE.contains("CRITICAL"),
            "directive must include CRITICAL marker"
        );
    }

    #[test]
    fn tool_use_directive_prohibits_refusal() {
        assert!(
            TOOL_USE_DIRECTIVE.contains("never"),
            "directive must explicitly prohibit refusal"
        );
    }

    #[test]
    fn few_shot_examples_cover_three_required_patterns() {
        // single lookup
        assert!(
            TOOL_USE_FEW_SHOT_EXAMPLES.contains("Example 1"),
            "must include single-lookup example"
        );
        // chained calls
        assert!(
            TOOL_USE_FEW_SHOT_EXAMPLES.contains("Example 2"),
            "must include chained-call example"
        );
        // error recovery
        assert!(
            TOOL_USE_FEW_SHOT_EXAMPLES.contains("Example 3"),
            "must include error-recovery example"
        );
    }

    #[test]
    fn few_shot_examples_show_correct_and_wrong() {
        assert!(
            TOOL_USE_FEW_SHOT_EXAMPLES.contains("WRONG"),
            "examples must explicitly label WRONG approaches"
        );
    }

    #[test]
    fn error_recovery_example_prohibits_fabrication() {
        assert!(
            TOOL_USE_FEW_SHOT_EXAMPLES.contains("fabricate"),
            "error-recovery example must explicitly forbid fabricating tool results"
        );
    }

    #[test]
    fn build_tool_use_block_non_voice_excludes_latency_rule() {
        let block = build_tool_use_block(false);
        assert!(
            !block.contains("VOICE LATENCY RULE"),
            "non-voice block must not include voice latency rule"
        );
    }

    #[test]
    fn build_tool_use_block_voice_includes_latency_rule() {
        let block = build_tool_use_block(true);
        assert!(
            block.contains("VOICE LATENCY RULE"),
            "voice block must include latency rule"
        );
    }

    #[test]
    fn build_tool_use_block_contains_all_sections() {
        let block = build_tool_use_block(false);
        assert!(block.contains("--- TOOL USE ---"), "must have directive fence");
        assert!(block.contains("--- TOOL USE: ANTI-EXAMPLES"), "must have anti-examples");
        assert!(block.contains("--- TOOL USE: EXAMPLES ---"), "must have few-shot examples");
    }

    #[test]
    fn build_tool_use_block_is_deterministic() {
        assert_eq!(
            build_tool_use_block(false),
            build_tool_use_block(false),
            "must be deterministic"
        );
        assert_eq!(
            build_tool_use_block(true),
            build_tool_use_block(true),
            "must be deterministic on voice path"
        );
    }
}
