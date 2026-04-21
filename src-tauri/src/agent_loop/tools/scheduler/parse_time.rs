//! Natural-language time and cron expression parser.
//!
//! `parse_natural_time(text, now)` → unix seconds
//!   Handles relative offsets ("in 30 min", "in 2 hours", "in 1 day") and
//!   absolute anchors ("tomorrow 9am", "today 6pm", "monday 10am",
//!   "friday 8:30pm", "at 14:00").
//!
//! `parse_natural_cron(text)` → `CronSchedule`
//!   Accepts standard 5-field cron expressions ("0 9 * * *") AND natural
//!   English phrases:
//!   - "every hour" / "every 30 minutes"
//!   - "every day at 9am" / "daily at 18:00"
//!   - "every morning" / "every evening"
//!   - "every weekday at 9am" / "every weekend at 10am"
//!   - "every Monday at 10am" / "every Friday 8:30pm"
//!   - "every 2 hours" / "every 15 minutes"
//!
//! All parsing is case-insensitive. Unknown expressions return `Err`.
//!
//! `CronSchedule::next_after(unix_secs)` returns the next fire time strictly
//! after the given timestamp, clamped within ±4 years to avoid infinite loops.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc, Weekday};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A resolved cron-like schedule.  Stored as an interval in seconds for
/// simple cases ("every N minutes/hours"), or as a structured `DayTime`
/// for day-of-week / daily anchors.  The `next_after` method hides the
/// difference from callers.
#[derive(Debug, Clone, PartialEq)]
pub enum CronSchedule {
    /// Fire every `secs` seconds from the schedule's creation.
    IntervalSecs(u64),
    /// Fire at `hour:minute` on specific days of the week.
    /// `days` is a bitmask: bit 0 = Sunday … bit 6 = Saturday (ISO offset +1).
    DayTime { days: u8, hour: u8, minute: u8 },
    /// Standard 5-field cron: (minute, hour, dom, month, dow).
    /// We store the raw fields and compute next-fire naively.
    FiveField {
        minute: CronField,
        hour: CronField,
        dom: CronField,
        month: CronField,
        dow: CronField,
    },
}

/// One field of a 5-field cron expression: either wildcard or a specific value.
#[derive(Debug, Clone, PartialEq)]
pub enum CronField {
    Any,
    Value(u32),
}

impl CronSchedule {
    /// Next fire time strictly after `after_unix` (seconds).
    /// Returns `None` only if no valid time can be found within 4 years.
    pub fn next_after(&self, after_unix: i64) -> Option<i64> {
        match self {
            CronSchedule::IntervalSecs(secs) => {
                if *secs == 0 {
                    return None;
                }
                Some(after_unix + *secs as i64)
            }
            CronSchedule::DayTime { days, hour, minute } => {
                next_day_time_after(after_unix, *days, *hour, *minute)
            }
            CronSchedule::FiveField { minute, hour, dom, month, dow } => {
                next_five_field_after(after_unix, minute, hour, dom, month, dow)
            }
        }
    }

    /// Serialise to a compact string for storage.
    pub fn to_wire(&self) -> String {
        match self {
            CronSchedule::IntervalSecs(s) => format!("interval:{s}"),
            CronSchedule::DayTime { days, hour, minute } => {
                format!("daytime:{days}:{hour}:{minute}")
            }
            CronSchedule::FiveField { minute, hour, dom, month, dow } => {
                format!(
                    "5f:{} {} {} {} {}",
                    field_str(minute),
                    field_str(hour),
                    field_str(dom),
                    field_str(month),
                    field_str(dow)
                )
            }
        }
    }

    /// Deserialise from `to_wire` output.
    pub fn from_wire(s: &str) -> Result<Self, String> {
        if let Some(rest) = s.strip_prefix("interval:") {
            let secs = rest
                .parse::<u64>()
                .map_err(|_| format!("bad interval wire: {s}"))?;
            return Ok(CronSchedule::IntervalSecs(secs));
        }
        if let Some(rest) = s.strip_prefix("daytime:") {
            let parts: Vec<&str> = rest.split(':').collect();
            if parts.len() != 3 {
                return Err(format!("bad daytime wire: {s}"));
            }
            let days = parts[0].parse::<u8>().map_err(|_| format!("bad days: {s}"))?;
            let hour = parts[1].parse::<u8>().map_err(|_| format!("bad hour: {s}"))?;
            let minute = parts[2].parse::<u8>().map_err(|_| format!("bad min: {s}"))?;
            return Ok(CronSchedule::DayTime { days, hour, minute });
        }
        if let Some(rest) = s.strip_prefix("5f:") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() != 5 {
                return Err(format!("bad 5f wire: {s}"));
            }
            return Ok(CronSchedule::FiveField {
                minute: parse_field(parts[0])?,
                hour: parse_field(parts[1])?,
                dom: parse_field(parts[2])?,
                month: parse_field(parts[3])?,
                dow: parse_field(parts[4])?,
            });
        }
        Err(format!("unknown wire format: {s}"))
    }
}

fn field_str(f: &CronField) -> String {
    match f {
        CronField::Any => "*".to_string(),
        CronField::Value(v) => v.to_string(),
    }
}

fn parse_field(s: &str) -> Result<CronField, String> {
    if s == "*" {
        Ok(CronField::Any)
    } else {
        s.parse::<u32>()
            .map(CronField::Value)
            .map_err(|_| format!("bad cron field: {s}"))
    }
}

// ---------------------------------------------------------------------------
// parse_natural_time
// ---------------------------------------------------------------------------

/// Parse a natural-language time string relative to `now_unix` seconds.
///
/// Supported forms:
/// - "in 30 min" / "in 2 hours" / "in 1 day" / "in 3 minutes"
/// - "tomorrow 9am" / "tomorrow at 9am" / "tomorrow at 14:30"
/// - "today 6pm" / "today at 18:00"
/// - "monday 10am" / "friday 8:30pm" (next occurrence of that weekday)
/// - "at 14:00" / "9am" / "6:30pm" (today if in future, else tomorrow)
pub fn parse_natural_time(text: &str, now_unix: i64) -> Result<i64, String> {
    let lower = text.trim().to_lowercase();
    let now: DateTime<Utc> = Utc.timestamp_opt(now_unix, 0).single()
        .ok_or_else(|| format!("invalid now_unix: {now_unix}"))?;

    // --- relative: "in N unit" ---
    if let Some(rest) = lower.strip_prefix("in ") {
        return parse_relative_offset(rest.trim(), now_unix);
    }

    // --- "tomorrow [at] TIME" ---
    if lower.starts_with("tomorrow") {
        let time_part = lower
            .trim_start_matches("tomorrow")
            .trim()
            .trim_start_matches("at")
            .trim();
        let (h, m) = parse_time_of_day(time_part)?;
        let tomorrow = (now + Duration::days(1))
            .date_naive()
            .and_hms_opt(h as u32, m as u32, 0)
            .ok_or("overflow")?;
        return Ok(Utc.from_utc_datetime(&tomorrow).timestamp());
    }

    // --- "today [at] TIME" ---
    if lower.starts_with("today") {
        let time_part = lower
            .trim_start_matches("today")
            .trim()
            .trim_start_matches("at")
            .trim();
        let (h, m) = parse_time_of_day(time_part)?;
        let candidate = now
            .date_naive()
            .and_hms_opt(h as u32, m as u32, 0)
            .ok_or("overflow")?;
        let ts = Utc.from_utc_datetime(&candidate).timestamp();
        return Ok(if ts > now_unix { ts } else { ts + 86400 });
    }

    // --- weekday "monday 10am" etc ---
    if let Some(wd) = extract_leading_weekday(&lower) {
        let time_part = lower
            .trim_start_matches(weekday_name(wd))
            .trim()
            .trim_start_matches("at")
            .trim();
        let (h, m) = if time_part.is_empty() {
            (9u8, 0u8)  // default 9am when no time given
        } else {
            parse_time_of_day(time_part)?
        };
        let ts = next_weekday_at(now_unix, wd, h, m);
        return Ok(ts);
    }

    // --- bare time "at 14:00" / "9am" / "6:30pm" ---
    let stripped = lower.trim_start_matches("at").trim().to_string();
    if let Ok((h, m)) = parse_time_of_day(&stripped) {
        let candidate = now
            .date_naive()
            .and_hms_opt(h as u32, m as u32, 0)
            .ok_or("overflow")?;
        let ts = Utc.from_utc_datetime(&candidate).timestamp();
        return Ok(if ts > now_unix { ts } else { ts + 86400 });
    }

    Err(format!("cannot parse time: {text:?}"))
}

fn parse_relative_offset(rest: &str, now_unix: i64) -> Result<i64, String> {
    // "N unit[s]" — strip trailing 's'
    let parts: Vec<&str> = rest.splitn(2, ' ').collect();
    if parts.len() != 2 {
        return Err(format!("expected 'N unit', got: {rest:?}"));
    }
    let n: i64 = parts[0]
        .parse()
        .map_err(|_| format!("bad number in offset: {:?}", parts[0]))?;
    if n <= 0 {
        return Err(format!("offset must be positive, got {n}"));
    }
    let unit = parts[1].trim_end_matches('s').trim();
    let delta_secs: i64 = match unit {
        "sec" | "second" => n,
        "min" | "minute" => n * 60,
        "hour" => n * 3600,
        "day" => n * 86400,
        "week" => n * 7 * 86400,
        other => return Err(format!("unknown time unit: {other:?}")),
    };
    Ok(now_unix + delta_secs)
}

/// Parse "9am", "9:30am", "14:00", "6pm", "6:30pm" → (hour, minute).
pub fn parse_time_of_day(s: &str) -> Result<(u8, u8), String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("empty time string".to_string());
    }

    // Handle pm/am suffix
    let (base, pm, am) = if s.ends_with("pm") {
        (&s[..s.len() - 2], true, false)
    } else if s.ends_with("am") {
        (&s[..s.len() - 2], false, true)
    } else {
        (s, false, false)
    };
    let _ = am; // only pm matters for adjustment

    let (h, m) = if let Some(idx) = base.find(':') {
        let hh = base[..idx].parse::<u8>().map_err(|_| format!("bad hour: {s}"))?;
        let mm = base[idx + 1..].parse::<u8>().map_err(|_| format!("bad minute: {s}"))?;
        (hh, mm)
    } else {
        let hh = base.parse::<u8>().map_err(|_| format!("bad time: {s}"))?;
        (hh, 0)
    };

    let h = if pm && h < 12 { h + 12 } else if !pm && !am && h < 12 { h } else { h };
    if h > 23 || m > 59 {
        return Err(format!("time out of range: {s}"));
    }
    Ok((h, m))
}

fn extract_leading_weekday(lower: &str) -> Option<Weekday> {
    for wd in ALL_WEEKDAYS {
        if lower.starts_with(weekday_name(*wd)) {
            return Some(*wd);
        }
    }
    None
}

const ALL_WEEKDAYS: &[Weekday] = &[
    Weekday::Mon,
    Weekday::Tue,
    Weekday::Wed,
    Weekday::Thu,
    Weekday::Fri,
    Weekday::Sat,
    Weekday::Sun,
];

fn weekday_name(wd: Weekday) -> &'static str {
    match wd {
        Weekday::Mon => "monday",
        Weekday::Tue => "tuesday",
        Weekday::Wed => "wednesday",
        Weekday::Thu => "thursday",
        Weekday::Fri => "friday",
        Weekday::Sat => "saturday",
        Weekday::Sun => "sunday",
    }
}

/// Next occurrence of `wd` at `hour:minute` UTC, strictly after `now_unix`.
fn next_weekday_at(now_unix: i64, wd: Weekday, hour: u8, minute: u8) -> i64 {
    let now: DateTime<Utc> = Utc.timestamp_opt(now_unix, 0).single().unwrap_or(Utc::now());
    let target_dow = wd.num_days_from_monday(); // 0=Mon … 6=Sun
    let current_dow = now.weekday().num_days_from_monday();
    let mut days_ahead = (target_dow + 7 - current_dow) % 7;

    // Same weekday but time already passed → add 7 days
    let candidate_today = now
        .date_naive()
        .and_hms_opt(hour as u32, minute as u32, 0);
    if days_ahead == 0 {
        if let Some(c) = candidate_today {
            if Utc.from_utc_datetime(&c).timestamp() <= now_unix {
                days_ahead = 7;
            }
        }
    }

    let target_date = now.date_naive() + Duration::days(days_ahead as i64);
    let dt = target_date
        .and_hms_opt(hour as u32, minute as u32, 0)
        .unwrap_or_else(|| target_date.and_hms_opt(0, 0, 0).unwrap());
    Utc.from_utc_datetime(&dt).timestamp()
}

// ---------------------------------------------------------------------------
// parse_natural_cron
// ---------------------------------------------------------------------------

/// ALL_WEEKDAY_BITS = all days (0b1111111 = 127).
const ALL_DAYS: u8 = 0b0111_1111;
/// Bits for Mon–Fri.
const WEEKDAYS: u8 = 0b0011_1110;
/// Bits for Sat–Sun.
const WEEKEND: u8 = 0b1000_0001;

/// Parse a natural-language cron string OR a standard 5-field cron expression.
pub fn parse_natural_cron(text: &str) -> Result<CronSchedule, String> {
    let lower = text.trim().to_lowercase();

    // 5-field standard cron: "M H DOM Month DOW" (5 whitespace-separated tokens)
    let parts: Vec<&str> = lower.split_whitespace().collect();
    if parts.len() == 5 && !lower.starts_with("every") && !lower.starts_with("daily") {
        return parse_five_field(parts[0], parts[1], parts[2], parts[3], parts[4]);
    }

    // --- "every N minutes/hours" ---
    if let Some(rest) = lower.strip_prefix("every ") {
        return parse_every(rest.trim());
    }

    // --- "daily at TIME" / "daily TIME" ---
    if lower.starts_with("daily") {
        let time_part = lower
            .trim_start_matches("daily")
            .trim()
            .trim_start_matches("at")
            .trim();
        let (h, m) = parse_time_of_day(time_part).unwrap_or((0, 0));
        return Ok(CronSchedule::DayTime {
            days: ALL_DAYS,
            hour: h,
            minute: m,
        });
    }

    Err(format!("cannot parse cron expression: {text:?}"))
}

fn parse_every(rest: &str) -> Result<CronSchedule, String> {
    // "hour" / "day" — shorthands
    if rest == "hour" {
        return Ok(CronSchedule::IntervalSecs(3600));
    }
    if rest == "day" || rest == "day at midnight" {
        return Ok(CronSchedule::DayTime { days: ALL_DAYS, hour: 0, minute: 0 });
    }

    // "morning" / "evening" / "night"
    if rest == "morning" {
        return Ok(CronSchedule::DayTime { days: ALL_DAYS, hour: 9, minute: 0 });
    }
    if rest == "evening" {
        return Ok(CronSchedule::DayTime { days: ALL_DAYS, hour: 18, minute: 0 });
    }
    if rest == "night" {
        return Ok(CronSchedule::DayTime { days: ALL_DAYS, hour: 21, minute: 0 });
    }

    // "N minutes" / "N hours"
    if let Some(n_str) = rest.strip_suffix(" minutes").or_else(|| rest.strip_suffix(" minute")) {
        let n = n_str.trim().parse::<u64>()
            .map_err(|_| format!("bad number: {n_str:?}"))?;
        return Ok(CronSchedule::IntervalSecs(n * 60));
    }
    if let Some(n_str) = rest.strip_suffix(" hours").or_else(|| rest.strip_suffix(" hour")) {
        let n = n_str.trim().parse::<u64>()
            .map_err(|_| format!("bad number: {n_str:?}"))?;
        return Ok(CronSchedule::IntervalSecs(n * 3600));
    }
    if let Some(n_str) = rest.strip_suffix(" days").or_else(|| rest.strip_suffix(" day")) {
        let n = n_str.trim().parse::<u64>()
            .map_err(|_| format!("bad number: {n_str:?}"))?;
        return Ok(CronSchedule::IntervalSecs(n * 86400));
    }
    if let Some(n_str) = rest.strip_suffix(" weeks").or_else(|| rest.strip_suffix(" week")) {
        let n = n_str.trim().parse::<u64>()
            .map_err(|_| format!("bad number: {n_str:?}"))?;
        return Ok(CronSchedule::IntervalSecs(n * 7 * 86400));
    }

    // "weekday [at TIME]" / "weekday morning" etc.
    if rest.starts_with("weekday") {
        let time_part = rest
            .trim_start_matches("weekday")
            .trim()
            .trim_start_matches("at")
            .trim();
        let (h, m) = parse_time_anchor(time_part)?;
        return Ok(CronSchedule::DayTime { days: WEEKDAYS, hour: h, minute: m });
    }
    if rest.starts_with("weekend") {
        let time_part = rest
            .trim_start_matches("weekend")
            .trim()
            .trim_start_matches("at")
            .trim();
        let (h, m) = parse_time_anchor(time_part)?;
        return Ok(CronSchedule::DayTime { days: WEEKEND, hour: h, minute: m });
    }

    // "monday [at TIME]" etc.
    for wd in ALL_WEEKDAYS {
        let name = weekday_name(*wd);
        if rest.starts_with(name) {
            let time_part = rest
                .trim_start_matches(name)
                .trim()
                .trim_start_matches("at")
                .trim();
            let (h, m) = parse_time_anchor(time_part)?;
            let bit = weekday_bit(*wd);
            return Ok(CronSchedule::DayTime { days: bit, hour: h, minute: m });
        }
    }

    // "day at TIME" / "day TIME"
    if let Some(time_part) = rest.strip_prefix("day at ").or_else(|| rest.strip_prefix("day ")) {
        let (h, m) = parse_time_of_day(time_part.trim())?;
        return Ok(CronSchedule::DayTime { days: ALL_DAYS, hour: h, minute: m });
    }

    Err(format!("cannot parse 'every {rest}'"))
}

/// Like `parse_time_of_day` but also understands "morning" / "evening" shorthands.
fn parse_time_anchor(s: &str) -> Result<(u8, u8), String> {
    match s.trim() {
        "" => Ok((9, 0)),   // default when no time given
        "morning" => Ok((9, 0)),
        "evening" => Ok((18, 0)),
        "night" | "midnight" => Ok((0, 0)),
        other => parse_time_of_day(other),
    }
}

/// Bit position for a weekday.  Bit 0 = Sunday, bit 1 = Monday … bit 6 = Saturday.
fn weekday_bit(wd: Weekday) -> u8 {
    match wd {
        Weekday::Sun => 0b0000_0001,
        Weekday::Mon => 0b0000_0010,
        Weekday::Tue => 0b0000_0100,
        Weekday::Wed => 0b0000_1000,
        Weekday::Thu => 0b0001_0000,
        Weekday::Fri => 0b0010_0000,
        Weekday::Sat => 0b0100_0000,
    }
}

fn parse_five_field(min: &str, hr: &str, dom: &str, mon: &str, dow: &str) -> Result<CronSchedule, String> {
    Ok(CronSchedule::FiveField {
        minute: parse_field(min)?,
        hour: parse_field(hr)?,
        dom: parse_field(dom)?,
        month: parse_field(mon)?,
        dow: parse_field(dow)?,
    })
}

// ---------------------------------------------------------------------------
// CronSchedule::next_after helpers
// ---------------------------------------------------------------------------

fn next_day_time_after(after: i64, days: u8, hour: u8, minute: u8) -> Option<i64> {
    let now: DateTime<Utc> = Utc.timestamp_opt(after, 0).single()?;
    // Scan up to 8 days forward to find the next matching weekday.
    for offset in 0i64..=8 {
        let candidate_date = now.date_naive() + Duration::days(offset);
        let candidate_dt = Utc
            .from_utc_datetime(
                &candidate_date.and_hms_opt(hour as u32, minute as u32, 0)?,
            );
        let ts = candidate_dt.timestamp();
        if ts <= after {
            continue;
        }
        let wd = candidate_date.weekday();
        let bit = weekday_bit(wd);
        if days & bit != 0 {
            return Some(ts);
        }
    }
    None
}

fn next_five_field_after(
    after: i64,
    minute: &CronField,
    hour: &CronField,
    dom: &CronField,
    month: &CronField,
    dow: &CronField,
) -> Option<i64> {
    // Scan minute-by-minute capped at 4 years to avoid infinite loops.
    let limit = after + 4 * 365 * 86400;
    let mut t = after + 60; // advance at least one minute
    // Round up to next minute boundary.
    t = (t / 60) * 60;

    while t < limit {
        let dt: DateTime<Utc> = Utc.timestamp_opt(t, 0).single()?;

        let m_ok = match month {
            CronField::Any => true,
            CronField::Value(v) => dt.month() == *v,
        };
        let dom_ok = match dom {
            CronField::Any => true,
            CronField::Value(v) => dt.day() == *v,
        };
        let dow_ok = match dow {
            CronField::Any => true,
            // cron dow: 0=Sun … 6=Sat; chrono: Mon=0 … Sun=6
            CronField::Value(v) => {
                let cron_dow = match dt.weekday() {
                    Weekday::Sun => 0u32,
                    Weekday::Mon => 1,
                    Weekday::Tue => 2,
                    Weekday::Wed => 3,
                    Weekday::Thu => 4,
                    Weekday::Fri => 5,
                    Weekday::Sat => 6,
                };
                cron_dow == *v
            }
        };
        let h_ok = match hour {
            CronField::Any => true,
            CronField::Value(v) => dt.hour() == *v,
        };
        let min_ok = match minute {
            CronField::Any => true,
            CronField::Value(v) => dt.minute() == *v,
        };

        if m_ok && dom_ok && dow_ok && h_ok && min_ok {
            return Some(t);
        }

        // Jump forward smartly — if the hour matches but minute doesn't, advance by minute.
        // Otherwise, advance by an hour to skip bulk of non-matching slots.
        if m_ok && dom_ok && dow_ok && h_ok {
            t += 60;
        } else if m_ok && dom_ok && dow_ok {
            t += 3600;
        } else {
            t += 86400;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_745_000_000; // fixed epoch for deterministic tests

    // 1. Relative offset parsing
    #[test]
    fn relative_in_30_min() {
        let t = parse_natural_time("in 30 min", NOW).unwrap();
        assert_eq!(t, NOW + 30 * 60);
    }

    #[test]
    fn relative_in_2_hours() {
        let t = parse_natural_time("in 2 hours", NOW).unwrap();
        assert_eq!(t, NOW + 2 * 3600);
    }

    #[test]
    fn relative_in_1_day() {
        let t = parse_natural_time("in 1 day", NOW).unwrap();
        assert_eq!(t, NOW + 86400);
    }

    // 2. NL cron — interval forms
    #[test]
    fn cron_every_hour() {
        let s = parse_natural_cron("every hour").unwrap();
        assert_eq!(s, CronSchedule::IntervalSecs(3600));
    }

    #[test]
    fn cron_every_30_minutes() {
        let s = parse_natural_cron("every 30 minutes").unwrap();
        assert_eq!(s, CronSchedule::IntervalSecs(30 * 60));
    }

    #[test]
    fn cron_every_2_hours() {
        let s = parse_natural_cron("every 2 hours").unwrap();
        assert_eq!(s, CronSchedule::IntervalSecs(7200));
    }

    // 3. NL cron — day-time forms
    #[test]
    fn cron_every_morning() {
        let s = parse_natural_cron("every morning").unwrap();
        assert_eq!(s, CronSchedule::DayTime { days: ALL_DAYS, hour: 9, minute: 0 });
    }

    #[test]
    fn cron_every_day_at_9am() {
        let s = parse_natural_cron("every day at 9am").unwrap();
        assert_eq!(s, CronSchedule::DayTime { days: ALL_DAYS, hour: 9, minute: 0 });
    }

    #[test]
    fn cron_every_weekday_morning() {
        let s = parse_natural_cron("every weekday morning").unwrap();
        assert_eq!(s, CronSchedule::DayTime { days: WEEKDAYS, hour: 9, minute: 0 });
    }

    #[test]
    fn cron_every_monday_10am() {
        let s = parse_natural_cron("every monday at 10am").unwrap();
        let bit = weekday_bit(Weekday::Mon);
        assert_eq!(s, CronSchedule::DayTime { days: bit, hour: 10, minute: 0 });
    }

    #[test]
    fn cron_every_friday_8_30pm() {
        let s = parse_natural_cron("every friday 8:30pm").unwrap();
        let bit = weekday_bit(Weekday::Fri);
        assert_eq!(s, CronSchedule::DayTime { days: bit, hour: 20, minute: 30 });
    }

    // 4. Standard 5-field cron
    #[test]
    fn cron_five_field_0_9_star() {
        let s = parse_natural_cron("0 9 * * *").unwrap();
        assert!(matches!(s, CronSchedule::FiveField { .. }));
        let next = s.next_after(NOW).unwrap();
        // Should be >= NOW
        assert!(next > NOW);
    }

    // 5. Wire round-trip
    #[test]
    fn cron_wire_roundtrip_interval() {
        let original = CronSchedule::IntervalSecs(3600);
        let wire = original.to_wire();
        let restored = CronSchedule::from_wire(&wire).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn cron_wire_roundtrip_daytime() {
        let original = CronSchedule::DayTime { days: WEEKDAYS, hour: 9, minute: 30 };
        let wire = original.to_wire();
        let restored = CronSchedule::from_wire(&wire).unwrap();
        assert_eq!(original, restored);
    }

    // 6. next_after for DayTime
    #[test]
    fn next_after_day_time_advances_correctly() {
        let s = CronSchedule::DayTime { days: ALL_DAYS, hour: 9, minute: 0 };
        let next = s.next_after(NOW).unwrap();
        assert!(next > NOW);
        // Should be within 2 days
        assert!(next < NOW + 2 * 86400);
    }
}
