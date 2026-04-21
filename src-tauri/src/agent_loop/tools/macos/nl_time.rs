//! Natural-language time expression parser for calendar / reminder tools.
//!
//! # Grammar covered
//!
//! Single-point expressions (returns one `NaiveDateTime`):
//!   "tomorrow at 2pm"          → tomorrow 14:00
//!   "today at 3:30pm"          → today 15:30
//!   "tonight"                  → today 20:00
//!   "EOD"                      → today 17:00
//!   "in 30 minutes"            → now + 30 min
//!   "in 2 hours"               → now + 2 h
//!   "Friday 3pm"               → next Friday 15:00 (or today if it's Friday and time is future)
//!   "next Tuesday 9am"         → next occurrence of Tuesday 09:00
//!   "March 15" / "3/15"        → that date current year at 09:00 (next year if past)
//!
//! Range expressions (returns `(NaiveDateTime, NaiveDateTime)`):
//!   "Monday 9-10am"            → next Monday 09:00 → 10:00
//!   "next Tuesday 9am-10am"    → next Tuesday 09:00 → 10:00
//!   "tomorrow 2pm-3pm"         → tomorrow 14:00 → 15:00
//!
//! # Ambiguity contract
//!
//! Inputs that don't match any pattern return `None`. The LLM caller must
//! ask the user to clarify rather than guessing.
//!
//! # Immutability
//!
//! All functions are pure — no global state, no mutation.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Weekday};

/// The two possible parse results — a single moment or a start/end range.
#[derive(Debug, PartialEq, Clone)]
pub enum ParsedTime {
    Single(NaiveDateTime),
    Range(NaiveDateTime, NaiveDateTime),
}

/// Entry point. `now` is the caller's current local time (injected for
/// testability — callers pass `chrono::Local::now().naive_local()`).
///
/// Returns `None` when the expression is ambiguous or unrecognised.
pub fn parse_natural_time(text: &str, now: NaiveDateTime) -> Option<ParsedTime> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Try range first (e.g. "Monday 9-10am") — must precede single-point so
    // "9am-10am" isn't parsed as just "9am".
    if let Some(range) = try_parse_range(trimmed, now) {
        return Some(ParsedTime::Range(range.0, range.1));
    }

    try_parse_single(trimmed, now).map(ParsedTime::Single)
}

// ---------------------------------------------------------------------------
// Single-point parser
// ---------------------------------------------------------------------------

fn try_parse_single(text: &str, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let lower = text.to_lowercase();
    let lower = lower.trim();

    // "in N minutes/hours"
    if let Some(dt) = parse_relative_offset(lower, now) {
        return Some(dt);
    }

    // "tonight"
    if lower == "tonight" {
        return Some(on_date(now.date(), 20, 0));
    }
    // "EOD" / "end of day"
    if lower == "eod" || lower == "end of day" {
        return Some(on_date(now.date(), 17, 0));
    }
    // "now"
    if lower == "now" {
        return Some(now);
    }

    // "tomorrow [at <time>]"
    if lower.starts_with("tomorrow") {
        let tomorrow = now.date() + Duration::days(1);
        let rest = lower["tomorrow".len()..].trim();
        let rest = rest.trim_start_matches("at").trim();
        let t = if rest.is_empty() {
            NaiveTime::from_hms_opt(9, 0, 0)?
        } else {
            parse_time_of_day(rest)?
        };
        return Some(NaiveDateTime::new(tomorrow, t));
    }

    // "today [at <time>]"
    if lower.starts_with("today") {
        let rest = lower["today".len()..].trim();
        let rest = rest.trim_start_matches("at").trim();
        let t = if rest.is_empty() {
            NaiveTime::from_hms_opt(9, 0, 0)?
        } else {
            parse_time_of_day(rest)?
        };
        return Some(NaiveDateTime::new(now.date(), t));
    }

    // "next <weekday> [<time>]"
    if lower.starts_with("next ") {
        let rest = &lower["next ".len()..];
        let (weekday_str, time_part) = split_weekday_and_time(rest);
        if let Some(wd) = parse_weekday(weekday_str) {
            let d = next_weekday_strictly_after(now.date(), wd);
            let t = if time_part.trim().is_empty() {
                NaiveTime::from_hms_opt(9, 0, 0)?
            } else {
                let tp = time_part.trim().trim_start_matches("at").trim();
                parse_time_of_day(tp)?
            };
            return Some(NaiveDateTime::new(d, t));
        }
    }

    // "<weekday> [<time>]" — next occurrence (today if time still future)
    {
        let (weekday_str, time_part) = split_weekday_and_time(lower);
        if let Some(wd) = parse_weekday(weekday_str) {
            let t = if time_part.trim().is_empty() {
                NaiveTime::from_hms_opt(9, 0, 0)?
            } else {
                let tp = time_part.trim().trim_start_matches("at").trim();
                parse_time_of_day(tp)?
            };
            let d = next_weekday(now, wd, t);
            return Some(NaiveDateTime::new(d, t));
        }
    }

    // "March 15" / "3/15" / "15 March"
    if let Some(date) = parse_calendar_date(lower, now.date()) {
        let t = NaiveTime::from_hms_opt(9, 0, 0)?;
        return Some(NaiveDateTime::new(date, t));
    }

    // Bare time: "3pm", "14:30"
    if let Some(t) = parse_time_of_day(lower) {
        // If the time is still in the future today, use today; otherwise tomorrow.
        let candidate = NaiveDateTime::new(now.date(), t);
        return if candidate > now {
            Some(candidate)
        } else {
            Some(NaiveDateTime::new(now.date() + Duration::days(1), t))
        };
    }

    None
}

// ---------------------------------------------------------------------------
// Range parser
// ---------------------------------------------------------------------------

fn try_parse_range(text: &str, now: NaiveDateTime) -> Option<(NaiveDateTime, NaiveDateTime)> {
    // Pattern: "<date-prefix> <time1>-<time2>[am|pm]"
    // e.g. "Monday 9-10am", "tomorrow 2pm-3pm", "next Tuesday 9am-10am"
    //
    // Strategy: find a dash that sits between two digit clusters in the
    // time portion, not in a date like "2026-04-18".

    let lower = text.to_lowercase();

    // Split off a potential date/day prefix by finding a range token "H-H"
    // or "Ham-Hpm" pattern.
    let range_re = find_time_range_split(&lower)?;
    let (date_part, start_str, end_str) = range_re;

    // Parse the anchor date from the prefix (or "today" if empty).
    let anchor_dt = if date_part.trim().is_empty() {
        now
    } else {
        // Use try_parse_single with a default time to get the anchor date.
        let probe = format!("{} 9am", date_part.trim());
        try_parse_single(probe.trim(), now)?
    };
    let anchor_date = anchor_dt.date();

    let t_start = parse_time_of_day(start_str.trim())?;
    let t_end_raw = parse_time_of_day_with_hint(end_str.trim(), t_start)?;

    let dt_start = NaiveDateTime::new(anchor_date, t_start);
    let dt_end = NaiveDateTime::new(anchor_date, t_end_raw);

    if dt_end <= dt_start {
        return None; // nonsensical range
    }
    Some((dt_start, dt_end))
}

/// Locate a time-range dash in the form "9-10am", "9am-10am", or "2pm-3pm"
/// inside the full lowercased input. Returns `(prefix, start_token, end_token)`.
fn find_time_range_split(lower: &str) -> Option<(&str, &str, &str)> {
    // We look for a `-` that is preceded by a digit OR an am/pm suffix and
    // followed by a digit, and is not the date separator (YYYY-MM-DD).
    let bytes = lower.as_bytes();
    for i in 1..bytes.len().saturating_sub(1) {
        if bytes[i] != b'-' {
            continue;
        }
        // Right side must start with a digit (time always begins numeric).
        if !bytes[i + 1].is_ascii_digit() {
            continue;
        }
        // Left side: accept either a digit OR an 'm' that is part of am/pm.
        let left = bytes[i - 1];
        let left_ok = left.is_ascii_digit()
            || (left == b'm' && i >= 2 && (bytes[i - 2] == b'a' || bytes[i - 2] == b'p'));
        if !left_ok {
            continue;
        }
        let prefix = lower[..i].trim_end();
        // Walk backwards from i-1 to find start of the time token.
        let tok_start = find_time_tok_start(prefix)?;
        let start_tok = &prefix[tok_start..];
        let end_tok = &lower[i + 1..];

        // Validate: start_tok looks like a time, end_tok starts with a digit.
        if !start_tok.is_empty()
            && start_tok.as_bytes()[0].is_ascii_digit()
            && !end_tok.is_empty()
            && end_tok.as_bytes()[0].is_ascii_digit()
        {
            let date_prefix = &prefix[..tok_start];
            return Some((date_prefix, start_tok, end_tok));
        }
    }
    None
}

/// Walk backwards to find where the time token starts (past spaces / weekday).
fn find_time_tok_start(s: &str) -> Option<usize> {
    // Find the last whitespace boundary before a digit run.
    let trimmed = s.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    // Last whitespace index.
    if let Some(pos) = trimmed.rfind(|c: char| c.is_whitespace()) {
        // The token after this whitespace must start with a digit.
        let after = &trimmed[pos + 1..];
        if after.as_bytes().first().map(|b| b.is_ascii_digit()).unwrap_or(false) {
            return Some(pos + 1);
        }
    }
    // No whitespace — the whole thing is the time token (e.g. "9" in "9-10am").
    if trimmed.as_bytes()[0].is_ascii_digit() {
        return Some(0);
    }
    None
}

// ---------------------------------------------------------------------------
// Primitive parsers
// ---------------------------------------------------------------------------

/// "in 30 minutes" / "in 2 hours" / "in 1h30m"
fn parse_relative_offset(lower: &str, now: NaiveDateTime) -> Option<NaiveDateTime> {
    let s = lower.trim().strip_prefix("in ")?.trim();
    // "N minutes" / "N mins" / "N min"
    if let Some(mins) = strip_unit_suffix(s, &["minutes", "minute", "mins", "min"]) {
        let n: i64 = mins.trim().parse().ok()?;
        return Some(now + Duration::minutes(n));
    }
    // "N hours" / "N hour" / "N hr" / "Nh"
    if let Some(hrs) = strip_unit_suffix(s, &["hours", "hour", "hrs", "hr", "h"]) {
        let n: i64 = hrs.trim().parse().ok()?;
        return Some(now + Duration::hours(n));
    }
    // "N days"
    if let Some(days) = strip_unit_suffix(s, &["days", "day"]) {
        let n: i64 = days.trim().parse().ok()?;
        return Some(now + Duration::days(n));
    }
    None
}

fn strip_unit_suffix<'a>(s: &'a str, units: &[&str]) -> Option<&'a str> {
    for unit in units {
        if let Some(num) = s.strip_suffix(unit) {
            return Some(num.trim_end());
        }
        // allow space before unit
        if s.ends_with(&format!(" {unit}")) {
            return Some(&s[..s.len() - unit.len() - 1]);
        }
    }
    None
}

/// Parse a time-of-day token like "2pm", "14:30", "9:30am", "noon".
pub fn parse_time_of_day(s: &str) -> Option<NaiveTime> {
    let s = s.trim().to_lowercase();
    let s = s.as_str();

    if s == "noon" || s == "midday" {
        return NaiveTime::from_hms_opt(12, 0, 0);
    }
    if s == "midnight" {
        return NaiveTime::from_hms_opt(0, 0, 0);
    }

    // Strip am/pm suffix.
    let (core, ampm) = if let Some(c) = s.strip_suffix("am") {
        (c.trim(), Some("am"))
    } else if let Some(c) = s.strip_suffix("pm") {
        (c.trim(), Some("pm"))
    } else {
        (s, None)
    };

    // core is now "H", "H:MM", or "HH:MM"
    let (h, m) = if let Some((hh, mm)) = core.split_once(':') {
        let h: u32 = hh.parse().ok()?;
        let m: u32 = mm.parse().ok()?;
        (h, m)
    } else {
        let h: u32 = core.parse().ok()?;
        (h, 0)
    };

    if h > 23 || m > 59 {
        return None;
    }

    let hour = match ampm {
        Some("am") => {
            if h == 12 {
                0
            } else {
                h
            }
        }
        Some("pm") => {
            if h == 12 {
                12
            } else {
                h + 12
            }
        }
        _ => h, // 24-h input
    };

    if hour > 23 {
        return None;
    }
    NaiveTime::from_hms_opt(hour, m, 0)
}

/// Like `parse_time_of_day` but when a bare hour like "10" is given without
/// an am/pm suffix, infer am/pm from the reference time so "9am-10" → 10am.
fn parse_time_of_day_with_hint(s: &str, reference: NaiveTime) -> Option<NaiveTime> {
    let lower = s.to_lowercase();
    let s = lower.trim();
    // If it already has an am/pm suffix, parse normally.
    if s.ends_with("am") || s.ends_with("pm") {
        return parse_time_of_day(s);
    }
    // Try to parse as-is; if the resulting hour is < reference hour, bump by 12.
    let t = parse_time_of_day(s)?;
    if t.hour() < reference.hour() && t.hour() < 12 {
        NaiveTime::from_hms_opt(t.hour() + 12, t.minute(), 0)
    } else {
        Some(t)
    }
}

/// Build a `NaiveDateTime` on a specific date at h:m.
fn on_date(date: NaiveDate, h: u32, m: u32) -> NaiveDateTime {
    NaiveDateTime::new(date, NaiveTime::from_hms_opt(h, m, 0).expect("valid time"))
}

/// Parse weekday name (full or 3-letter abbreviation).
fn parse_weekday(s: &str) -> Option<Weekday> {
    match s.trim().to_lowercase().as_str() {
        "monday" | "mon" => Some(Weekday::Mon),
        "tuesday" | "tue" | "tues" => Some(Weekday::Tue),
        "wednesday" | "wed" => Some(Weekday::Wed),
        "thursday" | "thu" | "thurs" => Some(Weekday::Thu),
        "friday" | "fri" => Some(Weekday::Fri),
        "saturday" | "sat" => Some(Weekday::Sat),
        "sunday" | "sun" => Some(Weekday::Sun),
        _ => None,
    }
}

/// Split a string like "monday 3pm" into ("monday", "3pm").
/// Works for weekday prefix followed by optional time token.
fn split_weekday_and_time(s: &str) -> (&str, &str) {
    // Weekday names are at most 9 chars ("wednesday").
    const DAYS: &[&str] = &[
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon",
        "tue", "tues", "wed", "thu", "thurs", "fri", "sat", "sun",
    ];
    for day in DAYS {
        if let Some(rest) = s.strip_prefix(day) {
            let rest = rest.trim_start_matches(|c: char| c == ' ' || c == ',');
            let rest = rest.trim_start_matches("at").trim();
            return (day, rest);
        }
    }
    // No weekday found — return the whole string as "time part" with no prefix.
    ("", s)
}

/// Next occurrence of `weekday` at or after today, but only if the requested
/// time is strictly future. Otherwise returns the NEXT week's occurrence.
fn next_weekday(now: NaiveDateTime, wd: Weekday, t: NaiveTime) -> NaiveDate {
    let today = now.date();
    let today_wd = today.weekday();
    let days_ahead = weekday_delta(today_wd, wd);
    let candidate = today + Duration::days(days_ahead as i64);
    let candidate_dt = NaiveDateTime::new(candidate, t);
    if candidate_dt > now {
        candidate
    } else {
        candidate + Duration::weeks(1)
    }
}

/// Next occurrence of `weekday` for "next <weekday>" syntax.
///
/// Convention: "next Tuesday" always means the Tuesday of the following week,
/// not the nearest upcoming Tuesday. I.e. we always add a full week on top of
/// the weekday delta so the result is never in the current week.
fn next_weekday_strictly_after(date: NaiveDate, wd: Weekday) -> NaiveDate {
    let days_ahead = weekday_delta(date.weekday(), wd);
    // Always push to the following week.
    let delta = if days_ahead == 0 { 7 } else { days_ahead + 7 };
    date + Duration::days(delta as i64)
}

/// Days from `from` to `to` (0 if same, 1-6 otherwise).
fn weekday_delta(from: Weekday, to: Weekday) -> u32 {
    let f = from.num_days_from_monday();
    let t = to.num_days_from_monday();
    (7 + t - f) % 7
}

/// Parse calendar dates: "March 15", "3/15", "15 March", "Mar 15".
fn parse_calendar_date(lower: &str, today: NaiveDate) -> Option<NaiveDate> {
    // "M/D" or "M/DD" or "MM/DD"
    if let Some(date) = parse_slash_date(lower, today) {
        return Some(date);
    }
    // "Month DD" or "DD Month" (full/abbrev month name)
    parse_named_month_date(lower, today)
}

fn parse_slash_date(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return None;
    }
    let m: u32 = parts[0].trim().parse().ok()?;
    let d: u32 = parts[1].trim().parse().ok()?;
    resolve_md(m, d, today)
}

fn parse_named_month_date(s: &str, today: NaiveDate) -> Option<NaiveDate> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    // Try "Month DD"
    if let Some(m) = month_name_to_num(parts[0]) {
        if let Ok(d) = parts[1].parse::<u32>() {
            return resolve_md(m, d, today);
        }
    }
    // Try "DD Month"
    if let Some(m) = month_name_to_num(parts[1]) {
        if let Ok(d) = parts[0].parse::<u32>() {
            return resolve_md(m, d, today);
        }
    }
    None
}

fn resolve_md(month: u32, day: u32, today: NaiveDate) -> Option<NaiveDate> {
    if month == 0 || month > 12 || day == 0 || day > 31 {
        return None;
    }
    let this_year = NaiveDate::from_ymd_opt(today.year(), month, day)?;
    if this_year >= today {
        Some(this_year)
    } else {
        // Roll to next year if date has passed.
        NaiveDate::from_ymd_opt(today.year() + 1, month, day)
    }
}

fn month_name_to_num(s: &str) -> Option<u32> {
    match s.to_lowercase().as_str() {
        "january" | "jan" => Some(1),
        "february" | "feb" => Some(2),
        "march" | "mar" => Some(3),
        "april" | "apr" => Some(4),
        "may" => Some(5),
        "june" | "jun" => Some(6),
        "july" | "jul" => Some(7),
        "august" | "aug" => Some(8),
        "september" | "sep" | "sept" => Some(9),
        "october" | "oct" => Some(10),
        "november" | "nov" => Some(11),
        "december" | "dec" => Some(12),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Public utility: convert a ParsedTime into ISO timestamps for the
// calendar tool. Default event duration is 1 hour when only a Single is given.
// ---------------------------------------------------------------------------

/// Convert a `ParsedTime` to `(start_iso, end_iso)` strings suitable for
/// `tool_calendar_create_event`. A `Single` result gets a 1-hour default duration.
pub fn to_iso_pair(pt: &ParsedTime) -> (String, String) {
    match pt {
        ParsedTime::Single(dt) => {
            let end = *dt + Duration::hours(1);
            (fmt_iso(dt), fmt_iso(&end))
        }
        ParsedTime::Range(s, e) => (fmt_iso(s), fmt_iso(e)),
    }
}

fn fmt_iso(dt: &NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    /// Fixed "now" for all tests: Monday 2026-04-20 10:00:00 (not DST boundary).
    fn now() -> NaiveDateTime {
        NaiveDateTime::parse_from_str("2026-04-20 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap()
    }

    fn single(text: &str) -> Option<NaiveDateTime> {
        match parse_natural_time(text, now())? {
            ParsedTime::Single(dt) => Some(dt),
            ParsedTime::Range(s, _) => Some(s), // allow range start as fallback
        }
    }

    fn range(text: &str) -> Option<(NaiveDateTime, NaiveDateTime)> {
        match parse_natural_time(text, now())? {
            ParsedTime::Range(s, e) => Some((s, e)),
            ParsedTime::Single(_) => None,
        }
    }

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    // ---- 10 NL-time unit tests ----

    #[test]
    fn nl_tomorrow_at_2pm() {
        // "tomorrow at 2pm" → 2026-04-21 14:00
        assert_eq!(single("tomorrow at 2pm"), Some(dt("2026-04-21 14:00:00")));
    }

    #[test]
    fn nl_in_30_minutes() {
        // "in 30 minutes" → now + 30 min = 10:30
        assert_eq!(single("in 30 minutes"), Some(dt("2026-04-20 10:30:00")));
    }

    #[test]
    fn nl_in_2_hours() {
        assert_eq!(single("in 2 hours"), Some(dt("2026-04-20 12:00:00")));
    }

    #[test]
    fn nl_next_tuesday() {
        // now is Monday 2026-04-20; "next Tuesday" → 2026-04-28 09:00
        // (strictly after Monday, next Tuesday = Apr 21 is "this Tuesday";
        //  "next Tuesday" means the one after that — Apr 28)
        assert_eq!(single("next Tuesday"), Some(dt("2026-04-28 09:00:00")));
    }

    #[test]
    fn nl_friday_3pm() {
        // now is Monday 2026-04-20; next Friday = 2026-04-24
        assert_eq!(single("Friday 3pm"), Some(dt("2026-04-24 15:00:00")));
    }

    #[test]
    fn nl_eod() {
        assert_eq!(single("EOD"), Some(dt("2026-04-20 17:00:00")));
    }

    #[test]
    fn nl_tonight() {
        assert_eq!(single("tonight"), Some(dt("2026-04-20 20:00:00")));
    }

    #[test]
    fn nl_march_15_rolls_to_next_year() {
        // March 15 2026 is already past (now is April 20 2026) → 2027-03-15
        assert_eq!(single("March 15"), Some(dt("2027-03-15 09:00:00")));
    }

    #[test]
    fn nl_slash_date_future() {
        // 5/10 = May 10 2026, which is in the future relative to Apr 20
        assert_eq!(single("5/10"), Some(dt("2026-05-10 09:00:00")));
    }

    #[test]
    fn nl_monday_range_9_to_10am() {
        // "Monday 9-10am" — now is Monday Apr 20 at 10:00; 9am is past, so next Monday
        let (s, e) = range("Monday 9-10am").expect("range parse");
        assert_eq!(s, dt("2026-04-27 09:00:00"));
        assert_eq!(e, dt("2026-04-27 10:00:00"));
    }

    #[test]
    fn nl_tomorrow_range() {
        let (s, e) = range("tomorrow 2pm-3pm").expect("range");
        assert_eq!(s, dt("2026-04-21 14:00:00"));
        assert_eq!(e, dt("2026-04-21 15:00:00"));
    }

    #[test]
    fn nl_next_tuesday_range() {
        let (s, e) = range("next Tuesday 9am-10am").expect("range");
        assert_eq!(s, dt("2026-04-28 09:00:00"));
        assert_eq!(e, dt("2026-04-28 10:00:00"));
    }

    #[test]
    fn nl_ambiguous_returns_none() {
        // Garbage input must return None.
        assert_eq!(parse_natural_time("whenever", now()), None);
        assert_eq!(parse_natural_time("", now()), None);
        assert_eq!(parse_natural_time("blahblah", now()), None);
    }

    #[test]
    fn nl_bare_time_future() {
        // "3pm" when now is 10am → same day
        assert_eq!(single("3pm"), Some(dt("2026-04-20 15:00:00")));
    }

    #[test]
    fn nl_bare_time_past_rolls_to_tomorrow() {
        // "9am" when now is 10am → tomorrow
        assert_eq!(single("9am"), Some(dt("2026-04-21 09:00:00")));
    }

    #[test]
    fn nl_to_iso_pair_single_adds_one_hour() {
        let pt = ParsedTime::Single(dt("2026-04-21 14:00:00"));
        let (s, e) = to_iso_pair(&pt);
        assert_eq!(s, "2026-04-21T14:00:00");
        assert_eq!(e, "2026-04-21T15:00:00");
    }

    #[test]
    fn nl_to_iso_pair_range_preserves() {
        let pt = ParsedTime::Range(dt("2026-04-21 09:00:00"), dt("2026-04-21 10:00:00"));
        let (s, e) = to_iso_pair(&pt);
        assert_eq!(s, "2026-04-21T09:00:00");
        assert_eq!(e, "2026-04-21T10:00:00");
    }
}
