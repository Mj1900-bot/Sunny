// Only `timezone_now` is currently wired into `lib.rs`. The other
// time helpers (`timezone_convert`, `date_diff`, `date_add`) are
// PARKED — compiled to catch drift, not yet registered.
#![allow(dead_code)]

use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

// timezone_now — current time in an IANA tz.
// ---------------------------------------------------------------------------

/// Common city → IANA zone aliases. Covers the phrasing models reach for
/// ("London", "NYC", "Tokyo") before converging on strict IANA names.
/// Keep alphabetical; lookup is case-insensitive.
const CITY_ALIASES: &[(&str, &str)] = &[
    ("amsterdam", "Europe/Amsterdam"),
    ("auckland", "Pacific/Auckland"),
    ("bangkok", "Asia/Bangkok"),
    ("beijing", "Asia/Shanghai"),
    ("berlin", "Europe/Berlin"),
    ("boston", "America/New_York"),
    ("calgary", "America/Edmonton"),
    ("chicago", "America/Chicago"),
    ("delhi", "Asia/Kolkata"),
    ("denver", "America/Denver"),
    ("dubai", "Asia/Dubai"),
    ("dublin", "Europe/Dublin"),
    ("helsinki", "Europe/Helsinki"),
    ("hongkong", "Asia/Hong_Kong"),
    ("hong kong", "Asia/Hong_Kong"),
    ("honolulu", "Pacific/Honolulu"),
    ("houston", "America/Chicago"),
    ("istanbul", "Europe/Istanbul"),
    ("jakarta", "Asia/Jakarta"),
    ("johannesburg", "Africa/Johannesburg"),
    ("la", "America/Los_Angeles"),
    ("las vegas", "America/Los_Angeles"),
    ("london", "Europe/London"),
    ("los angeles", "America/Los_Angeles"),
    ("madrid", "Europe/Madrid"),
    ("melbourne", "Australia/Melbourne"),
    ("mexico city", "America/Mexico_City"),
    ("miami", "America/New_York"),
    ("montreal", "America/Toronto"),
    ("moscow", "Europe/Moscow"),
    ("mumbai", "Asia/Kolkata"),
    ("new york", "America/New_York"),
    ("newyork", "America/New_York"),
    ("nyc", "America/New_York"),
    ("oslo", "Europe/Oslo"),
    ("paris", "Europe/Paris"),
    ("reykjavik", "Atlantic/Reykjavik"),
    ("rome", "Europe/Rome"),
    ("san francisco", "America/Los_Angeles"),
    ("sao paulo", "America/Sao_Paulo"),
    ("seattle", "America/Los_Angeles"),
    ("seoul", "Asia/Seoul"),
    ("shanghai", "Asia/Shanghai"),
    ("singapore", "Asia/Singapore"),
    ("stockholm", "Europe/Stockholm"),
    ("sydney", "Australia/Sydney"),
    ("taipei", "Asia/Taipei"),
    ("tehran", "Asia/Tehran"),
    ("tokyo", "Asia/Tokyo"),
    ("toronto", "America/Toronto"),
    ("vancouver", "America/Vancouver"),
    ("vienna", "Europe/Vienna"),
    ("warsaw", "Europe/Warsaw"),
    ("zurich", "Europe/Zurich"),
];

/// Read the system's IANA timezone from `/etc/localtime` on macOS/Linux.
/// The file is a symlink (or copy) of the zoneinfo file for the active
/// tz; we extract the path suffix after `zoneinfo/`, which matches the
/// IANA name format that `chrono_tz::Tz::parse` expects.
fn system_tz_name() -> Option<String> {
    let link = std::fs::read_link("/etc/localtime").ok()?;
    let path_str = link.to_string_lossy();
    // Typical macOS: /var/db/timezone/zoneinfo/America/Vancouver
    // Typical Linux: /usr/share/zoneinfo/America/Vancouver
    path_str
        .split_once("zoneinfo/")
        .map(|(_, name)| name.to_string())
        .filter(|name| !name.is_empty())
}

/// Best-effort tz resolver. Accepts IANA names verbatim, common city
/// aliases, and the shortcuts `local`/`system`/`here` (which resolve to
/// the system's configured timezone via `iana-time-zone`). Falls back
/// to `Etc/UTC` if the OS tz can't be read.
fn resolve_tz(raw: &str) -> Result<Tz, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return resolve_tz("local");
    }
    // Exact IANA parse wins (the overwhelmingly common path).
    if let Ok(t) = trimmed.parse::<Tz>() {
        return Ok(t);
    }
    let lower = trimmed.to_lowercase();
    if matches!(lower.as_str(), "local" | "system" | "here") {
        let name = system_tz_name().unwrap_or_else(|| "Etc/UTC".to_string());
        return name
            .parse::<Tz>()
            .map_err(|_| format!("timezone_now: system tz \"{name}\" is not an IANA name"));
    }
    if let Some((_, iana)) = CITY_ALIASES.iter().find(|(alias, _)| *alias == lower) {
        return iana
            .parse::<Tz>()
            .map_err(|_| format!("timezone_now: alias target \"{iana}\" is not an IANA name"));
    }
    // Last-ditch: try spaces → underscores (common LLM mis-formatting).
    let underscored = trimmed.replace(' ', "_");
    if let Ok(t) = underscored.parse::<Tz>() {
        return Ok(t);
    }
    Err(format!(
        "timezone_now: unknown timezone \"{trimmed}\" — pass an IANA name (e.g. Europe/London), a known city (London, NYC, Tokyo), or \"local\""
    ))
}

/// Return the current time in the given IANA timezone, formatted as a
/// human-readable English sentence: `"13:42:05 JST, Monday 18 April 2026 (UTC+9)"`.
/// Accepts an empty/missing `tz` as shorthand for `local`.
#[tauri::command]
pub async fn timezone_now(tz: String) -> Result<String, String> {
    let parsed = resolve_tz(&tz)?;
    let now = Utc::now().with_timezone(&parsed);
    Ok(format_datetime(&now))
}

/// Weekday names we render — chrono gives us an enum; this array matches
/// the order of `Weekday::num_days_from_monday`.
const WEEKDAYS: [&str; 7] = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

fn format_datetime(dt: &DateTime<Tz>) -> String {
    let weekday = WEEKDAYS[dt.weekday().num_days_from_monday() as usize];
    let month = MONTHS[(dt.month() - 1) as usize];
    let offset_secs = dt.offset().fix().local_minus_utc();
    let offset_str = format_offset(offset_secs);
    let tz_abbrev = dt.format("%Z").to_string();
    format!(
        "{:02}:{:02}:{:02} {tz_abbrev}, {weekday} {} {month} {} ({offset_str})",
        dt.hour(),
        dt.minute(),
        dt.second(),
        dt.day(),
        dt.year(),
    )
}

fn format_offset(secs: i32) -> String {
    let sign = if secs < 0 { "-" } else { "+" };
    let abs = secs.unsigned_abs();
    let hours = abs / 3600;
    let minutes = (abs % 3600) / 60;
    if minutes == 0 {
        format!("UTC{sign}{hours}")
    } else {
        format!("UTC{sign}{hours}:{minutes:02}")
    }
}

// ---------------------------------------------------------------------------
// timezone_convert — naive local time from one tz to another.
// ---------------------------------------------------------------------------

/// Convert a naive wall-clock time (`2026-04-18T13:42:05`) from one IANA
/// zone to another. If the input parses as a full ISO-8601 (with an offset
/// or trailing `Z`), we honour that instead of `from_tz`.
#[tauri::command]
pub async fn timezone_convert(
    time_iso: String,
    from_tz: String,
    to_tz: String,
) -> Result<String, String> {
    let from: Tz = from_tz
        .trim()
        .parse()
        .map_err(|_| format!("timezone_convert: unknown from_tz \"{from_tz}\""))?;
    let to: Tz = to_tz
        .trim()
        .parse()
        .map_err(|_| format!("timezone_convert: unknown to_tz \"{to_tz}\""))?;

    let trimmed = time_iso.trim();
    let dt_utc: DateTime<Utc> = if let Ok(full) = DateTime::parse_from_rfc3339(trimmed) {
        full.with_timezone(&Utc)
    } else if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S") {
        from.from_local_datetime(&naive)
            .earliest()
            .ok_or_else(|| format!("timezone_convert: ambiguous or invalid local time in {from_tz}"))?
            .with_timezone(&Utc)
    } else if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        from.from_local_datetime(&naive)
            .earliest()
            .ok_or_else(|| format!("timezone_convert: ambiguous or invalid local time in {from_tz}"))?
            .with_timezone(&Utc)
    } else {
        return Err(format!(
            "timezone_convert: could not parse \"{time_iso}\" (expected ISO-8601)"
        ));
    };

    let out = dt_utc.with_timezone(&to);
    Ok(format_datetime(&out))
}

// ---------------------------------------------------------------------------
// date_diff — humanized delta between two ISO-8601 stamps.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn date_diff(a: String, b: String) -> Result<String, String> {
    let da = parse_iso_or_naive(&a)
        .map_err(|e| format!("date_diff: a: {e}"))?;
    let db = parse_iso_or_naive(&b)
        .map_err(|e| format!("date_diff: b: {e}"))?;

    let (earlier, later, direction) = if da <= db {
        (da, db, "later")
    } else {
        (db, da, "earlier")
    };
    let delta = later.signed_duration_since(earlier);
    let human = humanize_duration(delta);
    Ok(format!("b is {human} {direction} than a"))
}

fn parse_iso_or_naive(s: &str) -> Result<DateTime<Utc>, String> {
    let trimmed = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Ok(dt.with_timezone(&Utc));
    }
    // Fall back to plain naive with a few common shapes; treat as UTC.
    let formats = [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ];
    for fmt in formats {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            return Ok(Utc.from_utc_datetime(&naive));
        }
        // Date-only formats parse via NaiveDate → midnight UTC.
        if fmt == "%Y-%m-%d" {
            if let Ok(d) = chrono::NaiveDate::parse_from_str(trimmed, fmt) {
                let naive = d.and_hms_opt(0, 0, 0).unwrap_or_default();
                return Ok(Utc.from_utc_datetime(&naive));
            }
        }
    }
    Err(format!("could not parse \"{s}\" as ISO-8601"))
}

fn humanize_duration(d: Duration) -> String {
    let total_secs = d.num_seconds().abs();
    if total_secs == 0 {
        return "0 seconds".to_string();
    }

    let days = total_secs / 86_400;
    let hours = (total_secs % 86_400) / 3_600;
    let minutes = (total_secs % 3_600) / 60;
    let seconds = total_secs % 60;

    let mut parts: Vec<String> = Vec::new();
    if days > 0 {
        parts.push(format!("{days} day{}", if days == 1 { "" } else { "s" }));
    }
    if hours > 0 {
        parts.push(format!("{hours} hour{}", if hours == 1 { "" } else { "s" }));
    }
    if minutes > 0 {
        parts.push(format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" }));
    }
    if seconds > 0 && days == 0 {
        // Drop seconds for multi-day intervals to keep the output readable.
        parts.push(format!("{seconds} second{}", if seconds == 1 { "" } else { "s" }));
    }
    if parts.is_empty() {
        parts.push("less than a second".to_string());
    }
    parts.join(", ")
}

// ---------------------------------------------------------------------------
// date_add — ISO-8601 + `Nd Nh Nm Ns` → ISO-8601.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn date_add(base: String, delta: String) -> Result<String, String> {
    let base_dt = parse_iso_or_naive(&base)
        .map_err(|e| format!("date_add: base: {e}"))?;
    let offset = parse_delta(&delta)
        .map_err(|e| format!("date_add: delta: {e}"))?;

    let new_dt = base_dt
        .checked_add_signed(offset)
        .ok_or_else(|| "date_add: resulting date is out of range".to_string())?;
    Ok(new_dt.to_rfc3339())
}

fn parse_delta(raw: &str) -> Result<Duration, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("delta must be non-empty".into());
    }
    let (sign, body) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1i64, rest.trim_start()),
        None => (1i64, trimmed.strip_prefix('+').map(|s| s.trim_start()).unwrap_or(trimmed)),
    };

    // Accumulate: walk tokens, each of the form `<digits>(d|h|m|s)`.
    let mut total_secs: i64 = 0;
    let mut digits = String::new();
    for ch in body.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if ch.is_whitespace() {
            continue;
        }
        let n: i64 = digits.parse().map_err(|_| format!("invalid number near \"{ch}\""))?;
        digits.clear();
        let secs = match ch.to_ascii_lowercase() {
            'd' => n.checked_mul(86_400),
            'h' => n.checked_mul(3_600),
            'm' => n.checked_mul(60),
            's' => Some(n),
            other => return Err(format!("unknown unit \"{other}\" (expected d/h/m/s)")),
        }
        .ok_or_else(|| "delta overflow".to_string())?;
        total_secs = total_secs
            .checked_add(secs)
            .ok_or_else(|| "delta overflow".to_string())?;
    }
    if !digits.is_empty() {
        return Err(format!("trailing number \"{digits}\" has no unit"));
    }

    Ok(Duration::seconds(total_secs * sign))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timezone_now_parses() {
        let out = timezone_now("UTC".into()).await.unwrap();
        assert!(out.contains("UTC"), "got {out}");
        let err = timezone_now("Not/Real".into()).await.unwrap_err();
        assert!(err.contains("unknown timezone"), "got {err}");
    }

    #[tokio::test]
    async fn timezone_convert_roundtrip() {
        let out = timezone_convert(
            "2026-04-18T12:00:00".into(),
            "UTC".into(),
            "Asia/Tokyo".into(),
        )
        .await
        .unwrap();
        assert!(out.contains("21:00"), "got {out}");
    }

    #[tokio::test]
    async fn date_diff_and_add() {
        let out = date_diff(
            "2026-04-18T10:00:00Z".into(),
            "2026-04-20T14:13:00Z".into(),
        )
        .await
        .unwrap();
        assert!(out.contains("2 days"), "got {out}");
        assert!(out.contains("4 hours"), "got {out}");
        assert!(out.contains("13 minutes"), "got {out}");

        let out = date_add(
            "2026-04-18T10:00:00Z".into(),
            "3d 4h".into(),
        )
        .await
        .unwrap();
        assert!(out.starts_with("2026-04-21T14:00:00"), "got {out}");

        let out = date_add(
            "2026-04-18T10:00:00Z".into(),
            "-1h 30m".into(),
        )
        .await
        .unwrap();
        assert!(out.starts_with("2026-04-18T08:30:00"), "got {out}");
    }

    #[test]
    fn format_offset_cases() {
        assert_eq!(format_offset(0), "UTC+0");
        assert_eq!(format_offset(9 * 3600), "UTC+9");
        assert_eq!(format_offset(-5 * 3600), "UTC-5");
        assert_eq!(format_offset(5 * 3600 + 30 * 60), "UTC+5:30");
    }
}
