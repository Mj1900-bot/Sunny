//! `calendar_create_event` — create a Calendar.app event.
//!
//! # Time input
//!
//! `start` and `end` accept **either** ISO-8601 timestamps or natural-language
//! expressions. Natural-language is attempted first via `nl_time::parse_natural_time`;
//! if that returns `None` the value is handed to the existing ISO parser.
//!
//! When only `start` is a natural-language range expression (e.g. "Monday 9-10am")
//! `end` may be omitted entirely — the range provides both bounds. When `start`
//! resolves to a single moment and `end` is omitted, a 1-hour default is applied.
//!
//! # Schema changes (backward-compatible)
//!
//! `end` is now optional in the JSON schema (was required). The LLM can omit it
//! when `start` is a range expression or when a 1-hour default is acceptable.

use chrono::Local;
use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::agent_loop::tools::macos::nl_time::{parse_natural_time, to_iso_pair, ParsedTime};

const CAPS: &[&str] = &["macos.calendar.write"];

// `end` is now optional — NL range expressions provide both bounds.
const SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string"},"start":{"type":"string"},"end":{"type":"string"},"calendar":{"type":"string"},"notes":{"type":"string"}},"required":["title","start"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let title = string_arg(&input, "title")?;
        let start_raw = string_arg(&input, "start")?;
        let end_raw = optional_string_arg(&input, "end");
        let calendar = optional_string_arg(&input, "calendar");
        let notes = optional_string_arg(&input, "notes");

        let now = Local::now().naive_local();

        // Try natural-language parse on `start`.
        let (start_iso, end_iso) = match parse_natural_time(&start_raw, now) {
            Some(ParsedTime::Range(s, e)) => {
                // Ignore `end` if the start expression already encodes a range.
                (
                    s.format("%Y-%m-%dT%H:%M:%S").to_string(),
                    e.format("%Y-%m-%dT%H:%M:%S").to_string(),
                )
            }
            Some(ParsedTime::Single(s)) => {
                // Use `end` if provided, otherwise default +1 hour.
                let end_iso = match end_raw.as_deref() {
                    Some(end_str) if !end_str.trim().is_empty() => {
                        // Try NL parse on end, fall back to treating as ISO.
                        match parse_natural_time(end_str, now) {
                            Some(pt) => to_iso_pair(&pt).0,
                            None => end_str.to_string(),
                        }
                    }
                    _ => {
                        let pt = ParsedTime::Single(s);
                        to_iso_pair(&pt).1
                    }
                };
                (s.format("%Y-%m-%dT%H:%M:%S").to_string(), end_iso)
            }
            None => {
                // Fall back to the original ISO path.
                let end_str = end_raw
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        format!(
                            "calendar_create_event: `end` is required when `start` is not \
                             natural language. Provide an ISO-8601 end time or use a natural \
                             language range like \"tomorrow 2pm-3pm\"."
                        )
                    })?;
                (start_raw.clone(), end_str.to_string())
            }
        };

        crate::tools_macos::tool_calendar_create_event(
            title, start_iso, end_iso, calendar, notes,
        )
        .await
    })
}

inventory::submit! {
    ToolSpec {
        name: "calendar_create_event",
        description: "Create a calendar event in Calendar.app. Use when Sunny says 'schedule a meeting', 'put X on my calendar', 'book Y at Z'. `start` accepts ISO 8601 OR natural language: 'tomorrow at 2pm', 'next Tuesday 9am-10am', 'Friday 3pm', 'in 30 minutes', 'Monday 9-10am', 'EOD', 'tonight'. `end` is optional when `start` is a range expression.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {

    use crate::agent_loop::tools::macos::nl_time::{parse_natural_time, ParsedTime};
    use chrono::NaiveDateTime;

    fn now() -> NaiveDateTime {
        NaiveDateTime::parse_from_str("2026-04-20 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap()
    }

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    // Verify the NL parser returns the right results for calendar-relevant phrases.

    #[test]
    fn calendar_nl_tomorrow_at_2pm_single() {
        let result = parse_natural_time("tomorrow at 2pm", now());
        assert_eq!(result, Some(ParsedTime::Single(dt("2026-04-21 14:00:00"))));
    }

    #[test]
    fn calendar_nl_next_tuesday_9am_10am_range() {
        let result = parse_natural_time("next Tuesday 9am-10am", now());
        assert_eq!(
            result,
            Some(ParsedTime::Range(
                dt("2026-04-28 09:00:00"),
                dt("2026-04-28 10:00:00")
            ))
        );
    }

    #[test]
    fn calendar_nl_in_30_minutes() {
        let result = parse_natural_time("in 30 minutes", now());
        assert_eq!(result, Some(ParsedTime::Single(dt("2026-04-20 10:30:00"))));
    }

    #[test]
    fn calendar_nl_eod() {
        let result = parse_natural_time("EOD", now());
        assert_eq!(result, Some(ParsedTime::Single(dt("2026-04-20 17:00:00"))));
    }

    #[test]
    fn calendar_nl_tonight() {
        let result = parse_natural_time("tonight", now());
        assert_eq!(result, Some(ParsedTime::Single(dt("2026-04-20 20:00:00"))));
    }

    #[test]
    fn calendar_nl_friday_3pm() {
        // Apr 20 is Monday → next Friday = Apr 24
        let result = parse_natural_time("Friday 3pm", now());
        assert_eq!(result, Some(ParsedTime::Single(dt("2026-04-24 15:00:00"))));
    }

    #[test]
    fn calendar_nl_march_15_next_year() {
        // March 15 has passed (now = Apr 20 2026) → 2027
        let result = parse_natural_time("March 15", now());
        assert_eq!(result, Some(ParsedTime::Single(dt("2027-03-15 09:00:00"))));
    }

    #[test]
    fn calendar_nl_monday_9_to_10am_range() {
        // "Monday 9-10am"; now = Monday Apr 20 10:00 → 9am is past → next Monday Apr 27
        let result = parse_natural_time("Monday 9-10am", now());
        assert_eq!(
            result,
            Some(ParsedTime::Range(
                dt("2026-04-27 09:00:00"),
                dt("2026-04-27 10:00:00")
            ))
        );
    }

    #[test]
    fn calendar_to_iso_pair_single_adds_one_hour() {
        use crate::agent_loop::tools::macos::nl_time::to_iso_pair;
        let pt = ParsedTime::Single(dt("2026-04-21 14:00:00"));
        let (s, e) = to_iso_pair(&pt);
        assert_eq!(s, "2026-04-21T14:00:00");
        assert_eq!(e, "2026-04-21T15:00:00");
    }

    #[test]
    fn calendar_to_iso_pair_range_preserved() {
        use crate::agent_loop::tools::macos::nl_time::to_iso_pair;
        let pt = ParsedTime::Range(dt("2026-04-28 09:00:00"), dt("2026-04-28 10:00:00"));
        let (s, e) = to_iso_pair(&pt);
        assert_eq!(s, "2026-04-28T09:00:00");
        assert_eq!(e, "2026-04-28T10:00:00");
    }
}
