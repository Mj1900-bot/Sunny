//! Calendar integration — list / create / delete events via AppleScript.
//!
//! Talks to the system `Calendar.app` by shelling out to `osascript`. We emit
//! records using a bespoke separator scheme (`---EVTSEP---` between events,
//! `|||` between fields) so that titles / notes containing commas, quotes,
//! newlines, or tabs survive the round trip intact.
//!
//! Field order on every event line:
//!   id ||| title ||| start ||| end ||| location ||| notes ||| calendar ||| allDay
//!
//! Dates travel in ISO-8601 ("YYYY-MM-DDTHH:MM:SS"); on the AppleScript side
//! we convert to the native `date "YYYY-MM-DD HH:MM:SS"` literal which the
//! Calendar scripting dictionary parses without ambiguity.
//!
//! Requires the user to grant Calendar access in
//! System Settings → Privacy & Security → Calendars.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const OSA_TIMEOUT: Duration = Duration::from_secs(8);
const FIELD_SEP: &str = "|||";
const RECORD_SEP: &str = "---EVTSEP---";
const DEFAULT_LIMIT: usize = 200;
const PERMISSION_MSG: &str =
    "Calendar access required — System Settings → Privacy & Security → Calendars → add Sunny";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub location: String,
    pub notes: String,
    pub calendar: String,
    pub all_day: bool,
}

// ─── public API ─────────────────────────────────────────────────────────────

pub async fn list_calendars() -> Result<Vec<String>, String> {
    let script = r#"
tell application "Calendar"
    set outList to {}
    repeat with c in calendars
        set end of outList to (name of c as string)
    end repeat
    set AppleScript's text item delimiters to linefeed
    set outText to outList as string
    set AppleScript's text item delimiters to ""
    return outText
end tell
"#;
    let raw = run_osascript(script).await?;
    Ok(raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

pub async fn list_events_range(
    start_iso: String,
    end_iso: String,
    calendar_name: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<CalendarEvent>, String> {
    let start_as = iso_to_applescript_date(&start_iso)
        .ok_or_else(|| format!("invalid start_iso: {start_iso}"))?;
    let end_as = iso_to_applescript_date(&end_iso)
        .ok_or_else(|| format!("invalid end_iso: {end_iso}"))?;
    let bounded_limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 2000);

    let cal_filter = match calendar_name.as_deref() {
        Some(name) => format!(
            r#"set calList to {{}}
    repeat with c in calendars
        if (name of c as string) is "{}" then set end of calList to c
    end repeat"#,
            escape_as_string(name)
        ),
        None => "set calList to calendars".to_string(),
    };

    let script = format!(
        r#"{helpers}
tell application "Calendar"
    set startBound to date "{start_as}"
    set endBound to date "{end_as}"
    {cal_filter}
    set outParts to {{}}
    set total to 0
    set capHit to false
    repeat with c in calList
        if capHit then exit repeat
        set calName to (name of c as string)
        try
            set evs to (every event of c whose start date is greater than or equal to startBound and start date is less than or equal to endBound)
        on error
            set evs to {{}}
        end try
        repeat with ev in evs
            if total ≥ {limit} then
                set capHit to true
                exit repeat
            end if
            set evId to (uid of ev as string)
            set evTitle to my _safe(summary of ev)
            set evStart to my _isoFromDate(start date of ev)
            set evEnd to my _isoFromDate(end date of ev)
            set evLoc to my _safe(location of ev)
            set evNotes to my _safe(description of ev)
            set evAllDay to allday event of ev
            if evAllDay then
                set adFlag to "true"
            else
                set adFlag to "false"
            end if
            set evLine to evId & "{fs}" & evTitle & "{fs}" & evStart & "{fs}" & evEnd & "{fs}" & evLoc & "{fs}" & evNotes & "{fs}" & calName & "{fs}" & adFlag
            set end of outParts to evLine
            set total to total + 1
        end repeat
    end repeat
    set AppleScript's text item delimiters to "{rs}"
    set outText to outParts as string
    set AppleScript's text item delimiters to ""
    return outText
end tell"#,
        helpers = applescript_helpers(),
        start_as = start_as,
        end_as = end_as,
        cal_filter = cal_filter,
        limit = bounded_limit,
        fs = FIELD_SEP,
        rs = RECORD_SEP,
    );

    let raw = run_osascript(&script).await?;
    Ok(parse_event_stream(&raw))
}

pub async fn create_event(
    title: String,
    start_iso: String,
    end_iso: String,
    calendar_name: Option<String>,
    location: Option<String>,
    notes: Option<String>,
) -> Result<CalendarEvent, String> {
    let start_as = iso_to_applescript_date(&start_iso)
        .ok_or_else(|| format!("invalid start_iso: {start_iso}"))?;
    let end_as = iso_to_applescript_date(&end_iso)
        .ok_or_else(|| format!("invalid end_iso: {end_iso}"))?;

    let title_as = escape_as_string(&title);
    let loc_as = escape_as_string(location.as_deref().unwrap_or(""));
    let notes_as = escape_as_string(notes.as_deref().unwrap_or(""));

    let cal_selector = match calendar_name.as_deref() {
        Some(name) => format!(r#"calendar "{}""#, escape_as_string(name)),
        None => r#"(first calendar whose writable is true)"#.to_string(),
    };

    let script = format!(
        r#"{helpers}
tell application "Calendar"
    set targetCal to {cal_selector}
    set newEv to make new event at end of events of targetCal with properties {{summary:"{title}", start date: date "{start_as}", end date: date "{end_as}", location:"{loc}", description:"{notes}"}}
    set evId to (uid of newEv as string)
    set evTitle to my _safe(summary of newEv)
    set evStart to my _isoFromDate(start date of newEv)
    set evEnd to my _isoFromDate(end date of newEv)
    set evLoc to my _safe(location of newEv)
    set evNotes to my _safe(description of newEv)
    set calName to (name of targetCal as string)
    set evAllDay to allday event of newEv
    if evAllDay then
        set adFlag to "true"
    else
        set adFlag to "false"
    end if
    return evId & "{fs}" & evTitle & "{fs}" & evStart & "{fs}" & evEnd & "{fs}" & evLoc & "{fs}" & evNotes & "{fs}" & calName & "{fs}" & adFlag
end tell"#,
        helpers = applescript_helpers(),
        cal_selector = cal_selector,
        title = title_as,
        start_as = start_as,
        end_as = end_as,
        loc = loc_as,
        notes = notes_as,
        fs = FIELD_SEP,
    );

    let raw = run_osascript(&script).await?;
    parse_event_line(raw.trim()).ok_or_else(|| format!("create_event: could not parse response: {raw}"))
}

pub async fn delete_event(id: String, calendar_name: Option<String>) -> Result<(), String> {
    let id_as = escape_as_string(&id);

    // We scan calendars and delete the first matching uid. AppleScript's
    // `whose uid is X` can be flaky across stores, so we iterate explicitly.
    let cal_filter = match calendar_name.as_deref() {
        Some(name) => format!(
            r#"set calList to {{}}
    repeat with c in calendars
        if (name of c as string) is "{}" then set end of calList to c
    end repeat"#,
            escape_as_string(name)
        ),
        None => "set calList to calendars".to_string(),
    };

    let script = format!(
        r#"tell application "Calendar"
    {cal_filter}
    set didDelete to false
    repeat with c in calList
        if didDelete then exit repeat
        try
            set matches to (every event of c whose uid is "{id_as}")
        on error
            set matches to {{}}
        end try
        repeat with ev in matches
            delete ev
            set didDelete to true
            exit repeat
        end repeat
    end repeat
    if didDelete then
        return "ok"
    else
        error "event not found: {id_as}"
    end if
end tell"#,
        cal_filter = cal_filter,
        id_as = id_as,
    );

    run_osascript(&script).await.map(|_| ())
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// AppleScript helpers — date ↔ ISO + string sanitiser. Inlined into every
/// script so the module stays self-contained (no temp files, no library load).
fn applescript_helpers() -> &'static str {
    r#"on _pad2(n)
    set n to n as integer
    if n < 10 then
        return "0" & (n as string)
    else
        return (n as string)
    end if
end _pad2

on _isoFromDate(d)
    set y to year of d
    set m to (month of d) as integer
    set dd to day of d
    set hh to hours of d
    set mm to minutes of d
    set ss to seconds of d
    return (y as string) & "-" & my _pad2(m) & "-" & my _pad2(dd) & "T" & my _pad2(hh) & ":" & my _pad2(mm) & ":" & my _pad2(ss)
end _isoFromDate

on _safe(s)
    try
        set t to s as string
    on error
        return ""
    end try
    -- strip newlines / tabs / our separators so parsing stays clean
    set AppleScript's text item delimiters to {return, linefeed, tab, "|||", "---EVTSEP---"}
    set parts to text items of t
    set AppleScript's text item delimiters to " "
    set cleaned to parts as string
    set AppleScript's text item delimiters to ""
    return cleaned
end _safe
"#
}

/// Convert ISO-8601 "2026-04-18T14:30:00" → "2026-04-18 14:30:00" as expected
/// by AppleScript's `date "..."` literal. Tolerant of trailing zone suffix
/// ("Z" or "+07:00") which we strip — we pass wall-clock to AppleScript.
pub(crate) fn iso_to_applescript_date(iso: &str) -> Option<String> {
    let iso = iso.trim();
    if iso.is_empty() {
        return None;
    }
    // Strip any timezone suffix (Z, +HH:MM, -HH:MM after the T section).
    let (date_part, time_part_raw) = iso.split_once('T').unwrap_or((iso, "00:00:00"));
    let time_part = strip_tz(time_part_raw);

    let date_bits: Vec<&str> = date_part.split('-').collect();
    if date_bits.len() != 3 {
        return None;
    }
    let y: u32 = date_bits[0].parse().ok()?;
    let mo: u32 = date_bits[1].parse().ok()?;
    let d: u32 = date_bits[2].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || y < 1900 {
        return None;
    }

    let time_bits: Vec<&str> = time_part.split(':').collect();
    let (h, mi, s) = match time_bits.len() {
        3 => (
            time_bits[0].parse::<u32>().ok()?,
            time_bits[1].parse::<u32>().ok()?,
            time_bits[2].split('.').next()?.parse::<u32>().ok()?,
        ),
        2 => (
            time_bits[0].parse::<u32>().ok()?,
            time_bits[1].parse::<u32>().ok()?,
            0,
        ),
        _ => return None,
    };
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }

    Some(format!(
        "{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"
    ))
}

fn strip_tz(time: &str) -> &str {
    // Find first 'Z' / '+' / '-' after position 0 (position 0 would be a
    // negative sign, impossible for time anyway).
    for (i, ch) in time.char_indices() {
        if i == 0 { continue; }
        if ch == 'Z' || ch == '+' || ch == '-' {
            return &time[..i];
        }
    }
    time
}

fn escape_as_string(s: &str) -> String {
    // Escape for embedding inside an AppleScript double-quoted literal.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Parse one `|||`-delimited event line.
pub(crate) fn parse_event_line(line: &str) -> Option<CalendarEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.split(FIELD_SEP).collect();
    if parts.len() < 8 {
        return None;
    }
    Some(CalendarEvent {
        id: parts[0].trim().to_string(),
        title: parts[1].to_string(),
        start: parts[2].trim().to_string(),
        end: parts[3].trim().to_string(),
        location: parts[4].to_string(),
        notes: parts[5].to_string(),
        calendar: parts[6].to_string(),
        all_day: parts[7].trim().eq_ignore_ascii_case("true"),
    })
}

fn parse_event_stream(raw: &str) -> Vec<CalendarEvent> {
    raw.split(RECORD_SEP)
        .filter_map(parse_event_line)
        .collect()
}

/// Range-filter predicate — exposed for testing and reuse if we ever add
/// client-side re-filtering (e.g. refining a cached day-view by hour).
/// Parked — tests live in this file, no other caller yet.
#[allow(dead_code)]
pub(crate) fn in_range(event_start_iso: &str, start_iso: &str, end_iso: &str) -> bool {
    // ISO-8601 is lexicographically ordered when same format + length.
    let norm_s = normalise_iso(event_start_iso);
    let norm_lo = normalise_iso(start_iso);
    let norm_hi = normalise_iso(end_iso);
    norm_s >= norm_lo && norm_s <= norm_hi
}

#[allow(dead_code)]
fn normalise_iso(s: &str) -> String {
    // Make sure we compare in a consistent "YYYY-MM-DDTHH:MM:SS" shape.
    let trimmed = s.trim();
    let (d, t_raw) = trimmed.split_once('T').unwrap_or((trimmed, "00:00:00"));
    let t = strip_tz(t_raw);
    let padded_time = match t.matches(':').count() {
        2 => t.to_string(),
        1 => format!("{t}:00"),
        _ => "00:00:00".to_string(),
    };
    format!("{d}T{padded_time}")
}

/// Detect all-day events from their ISO start/end stamps — a day boundary
/// pair (00:00:00 → next-day 00:00:00) is treated as all-day even when the
/// AppleScript `allday event` flag isn't set (some data sources ship these
/// as "timed" but obviously span a whole day). Parked — for use by the
/// display-layer refactor that surfaces all-day events separately.
#[allow(dead_code)]
pub(crate) fn infer_all_day(start_iso: &str, end_iso: &str, flag: bool) -> bool {
    if flag {
        return true;
    }
    let s = normalise_iso(start_iso);
    let e = normalise_iso(end_iso);
    s.ends_with("T00:00:00") && e.ends_with("T00:00:00") && s != e
}

async fn run_osascript(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("osascript");
    // kill_on_drop so a timeout doesn't orphan the process — otherwise
    // repeated timeouts pile up zombie osascript children that saturate
    // the AppleScript bridge for the whole app.
    cmd.arg("-e").arg(script).kill_on_drop(true);

    let output = match timeout(OSA_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("osascript spawn failed: {e}")),
        Err(_) => return Err(format!("osascript timed out after {}s", OSA_TIMEOUT.as_secs())),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(classify_osascript_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end_matches('\n').to_string())
}

fn classify_osascript_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    // Only treat errors as a permission failure when the stderr actually looks
    // like one. The previous bare `access` substring match was too broad and
    // swallowed unrelated AppleScript errors (e.g. scripting additions, locale
    // date-literal failures) behind a misleading "grant access" banner.
    let is_permission =
        lower.contains("-1743")                    // errAEEventNotPermitted
        || lower.contains("-1744")                 // errAEUserCanceled w/ privacy
        || lower.contains("not authorized")
        || lower.contains("not allowed to send")
        || lower.contains("doesn’t have permission")
        || lower.contains("doesn't have permission")
        || lower.contains("access for assistive")  // rare, but seen in logs
        || lower.contains("privacy");

    if is_permission {
        return PERMISSION_MSG.to_string();
    }
    format!("osascript: {}", stderr.trim())
}

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_to_as_date_basic_and_tz_stripping() {
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30:00"),
            Some("2026-04-18 14:30:00".to_string())
        );
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30:00Z"),
            Some("2026-04-18 14:30:00".to_string())
        );
        assert_eq!(
            iso_to_applescript_date("2026-04-18T14:30:00+07:00"),
            Some("2026-04-18 14:30:00".to_string())
        );
        // Date-only → midnight
        assert_eq!(
            iso_to_applescript_date("2026-04-18"),
            Some("2026-04-18 00:00:00".to_string())
        );
        // Junk
        assert_eq!(iso_to_applescript_date(""), None);
        assert_eq!(iso_to_applescript_date("2026/04/18T00:00:00"), None);
        assert_eq!(iso_to_applescript_date("2026-13-18T00:00:00"), None);
    }

    #[test]
    fn parse_event_line_handles_all_fields() {
        let line = "EVT-123|||Team Sync|||2026-04-18T14:00:00|||2026-04-18T15:00:00|||Room 4|||Discuss roadmap|||Work|||false";
        let ev = parse_event_line(line).expect("parsed");
        assert_eq!(ev.id, "EVT-123");
        assert_eq!(ev.title, "Team Sync");
        assert_eq!(ev.start, "2026-04-18T14:00:00");
        assert_eq!(ev.location, "Room 4");
        assert_eq!(ev.notes, "Discuss roadmap");
        assert_eq!(ev.calendar, "Work");
        assert!(!ev.all_day);

        // All-day true variant, empty location / notes
        // 8 fields, 7 separators; fields 5 & 6 are empty strings
        let line2 = &[
            "EVT-9",
            "Holiday",
            "2026-12-25T00:00:00",
            "2026-12-26T00:00:00",
            "",
            "",
            "Home",
            "true",
        ]
        .join(FIELD_SEP);
        let ev2 = parse_event_line(&line2).expect("parsed");
        assert!(ev2.all_day);
        assert_eq!(ev2.location, "");
        assert_eq!(ev2.notes, "");

        // Malformed → None
        assert!(parse_event_line("too|||few|||fields").is_none());
        assert!(parse_event_line("").is_none());
    }

    #[test]
    fn range_predicate_includes_endpoints_and_tz_normalised() {
        assert!(in_range(
            "2026-04-18T12:00:00",
            "2026-04-18T00:00:00",
            "2026-04-18T23:59:59"
        ));
        // Endpoint inclusion (both bounds)
        assert!(in_range(
            "2026-04-18T00:00:00",
            "2026-04-18T00:00:00",
            "2026-04-18T23:59:59"
        ));
        assert!(in_range(
            "2026-04-18T23:59:59",
            "2026-04-18T00:00:00",
            "2026-04-18T23:59:59"
        ));
        // Outside
        assert!(!in_range(
            "2026-04-17T23:00:00",
            "2026-04-18T00:00:00",
            "2026-04-18T23:59:59"
        ));
        assert!(!in_range(
            "2026-04-19T00:00:00",
            "2026-04-18T00:00:00",
            "2026-04-18T23:59:59"
        ));
        // Tz suffix stripped for comparison
        assert!(in_range(
            "2026-04-18T12:00:00Z",
            "2026-04-18T00:00:00+00:00",
            "2026-04-18T23:59:59Z"
        ));
    }

    #[test]
    fn all_day_detection_flag_or_day_boundaries() {
        // explicit flag wins
        assert!(infer_all_day("2026-04-18T09:00:00", "2026-04-18T10:00:00", true));
        // day-boundary pair spanning at least 1 day → all-day
        assert!(infer_all_day(
            "2026-04-18T00:00:00",
            "2026-04-19T00:00:00",
            false
        ));
        // timed event → not all-day
        assert!(!infer_all_day(
            "2026-04-18T09:00:00",
            "2026-04-18T10:00:00",
            false
        ));
        // zero-length at midnight → not all-day (sanity check)
        assert!(!infer_all_day(
            "2026-04-18T00:00:00",
            "2026-04-18T00:00:00",
            false
        ));
    }
}

// === REGISTER IN lib.rs ===
// mod calendar;
// #[tauri::command]s: calendar_list_events, calendar_list_calendars, calendar_create_event, calendar_delete_event
// invoke_handler: same names
// No new deps.
// === END REGISTER ===
