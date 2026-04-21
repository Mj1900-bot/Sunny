//! Weather + time tools — live data for the agent loop.
//!
//! All four commands are read-only HTTP queries against open-meteo.com
//! (no API key required). Each command returns a short, human-readable
//! sentence that the LLM can quote or speak directly via the Kokoro
//! pipeline — no JSON wrangling in the prompt.
//!
//! Transport:
//!   * Geocoding: https://geocoding-api.open-meteo.com/v1/search
//!   * Forecast:  https://api.open-meteo.com/v1/forecast
//!
//! Every outbound request carries a 10 s timeout so a flaky upstream
//! can't wedge the agent loop. Errors are mapped to concise strings
//! ("city not found", "weather service unreachable", etc.) — no panics,
//! no unwraps on network-shaped data.

use chrono::{DateTime, NaiveDate, Offset, Utc};
use chrono_tz::Tz;
use serde::Deserialize;
use std::time::Duration;

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
struct GeocodeResult {
    latitude: f64,
    longitude: f64,
    name: String,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    admin1: Option<String>,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(Deserialize, Debug)]
struct GeocodeResponse {
    #[serde(default)]
    results: Option<Vec<GeocodeResult>>,
}

/// Single geocoding call. Internal — callers go through `geocode`.
async fn geocode_once(name: &str) -> Result<Option<GeocodeResult>, String> {
    let client = crate::http::client();
    let url = "https://geocoding-api.open-meteo.com/v1/search";
    let resp = client
        .get(url)
        .timeout(HTTP_TIMEOUT)
        .query(&[("name", name), ("count", "1"), ("language", "en"), ("format", "json")])
        .send()
        .await
        .map_err(|e| format!("geocoding unreachable: {}", short_err(&e.to_string())))?;

    if !resp.status().is_success() {
        return Err(format!("geocoding http {}", resp.status()));
    }
    let body: GeocodeResponse = resp
        .json()
        .await
        .map_err(|e| format!("geocoding decode: {}", short_err(&e.to_string())))?;

    Ok(body.results.and_then(|mut v| if v.is_empty() { None } else { Some(v.remove(0)) }))
}

async fn geocode(city: &str) -> Result<GeocodeResult, String> {
    let trimmed = city.trim();
    if trimmed.is_empty() {
        return Err("city must be a non-empty string".into());
    }

    // Try the full phrase first. If Open-Meteo doesn't know it (common
    // for "Vancouver, BC" or "Paris, TX"), retry with everything
    // before the first comma — the city part alone usually matches.
    if let Some(hit) = geocode_once(trimmed).await? {
        return Ok(hit);
    }
    if let Some((head, _)) = trimmed.split_once(',') {
        let head = head.trim();
        if !head.is_empty() && head != trimmed {
            if let Some(hit) = geocode_once(head).await? {
                return Ok(hit);
            }
        }
    }
    Err(format!("city not found: {trimmed}"))
}

fn pretty_location(g: &GeocodeResult) -> String {
    let mut parts = vec![g.name.clone()];
    if let Some(a) = g.admin1.as_ref().filter(|s| !s.is_empty() && *s != &g.name) {
        parts.push(a.clone());
    }
    if let Some(c) = g.country.as_ref().filter(|s| !s.is_empty()) {
        parts.push(c.clone());
    }
    parts.join(", ")
}

// ---------------------------------------------------------------------------
// Current weather
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct CurrentBlock {
    #[serde(default)]
    temperature_2m: Option<f64>,
    #[serde(default)]
    weather_code: Option<u32>,
    #[serde(default)]
    wind_speed_10m: Option<f64>,
    #[serde(default)]
    relative_humidity_2m: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct CurrentResponse {
    #[serde(default)]
    current: Option<CurrentBlock>,
}

#[tauri::command]
pub async fn tool_weather_current(city: String) -> Result<String, String> {
    let loc = geocode(&city).await?;
    let client = crate::http::client();
    let lat = loc.latitude.to_string();
    let lon = loc.longitude.to_string();
    let resp = client
        .get("https://api.open-meteo.com/v1/forecast")
        .timeout(HTTP_TIMEOUT)
        .query(&[
            ("latitude", lat.as_str()),
            ("longitude", lon.as_str()),
            ("current", "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m"),
            ("temperature_unit", "celsius"),
            ("wind_speed_unit", "kmh"),
            ("timezone", "auto"),
        ])
        .send()
        .await
        .map_err(|e| format!("weather service unreachable: {}", short_err(&e.to_string())))?;

    if !resp.status().is_success() {
        return Err(format!("weather http {}", resp.status()));
    }
    let body: CurrentResponse = resp
        .json()
        .await
        .map_err(|e| format!("weather decode: {}", short_err(&e.to_string())))?;

    let c = body.current.ok_or_else(|| "weather service returned no current block".to_string())?;
    let temp = c.temperature_2m.ok_or_else(|| "no temperature reading".to_string())?;
    let condition = wmo_phrase(c.weather_code.unwrap_or(0));
    let wind = c.wind_speed_10m.unwrap_or(0.0);
    let humidity = c.relative_humidity_2m.unwrap_or(0.0);

    Ok(format!(
        "In {}, it's {:.0}°C and {}, wind {:.0} km/h, humidity {:.0}%.",
        pretty_location(&loc),
        temp,
        condition,
        wind,
        humidity,
    ))
}

// ---------------------------------------------------------------------------
// Multi-day forecast
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct DailyBlock {
    #[serde(default)]
    time: Vec<String>,
    #[serde(default)]
    temperature_2m_max: Vec<Option<f64>>,
    #[serde(default)]
    temperature_2m_min: Vec<Option<f64>>,
    #[serde(default)]
    weather_code: Vec<Option<u32>>,
}

#[derive(Deserialize, Debug)]
struct ForecastResponse {
    #[serde(default)]
    daily: Option<DailyBlock>,
}

#[tauri::command]
pub async fn tool_weather_forecast(city: String, days: u32) -> Result<String, String> {
    let capped = days.clamp(1, 7);
    let loc = geocode(&city).await?;
    let client = crate::http::client();
    let lat = loc.latitude.to_string();
    let lon = loc.longitude.to_string();
    let forecast_days = capped.to_string();
    let resp = client
        .get("https://api.open-meteo.com/v1/forecast")
        .timeout(HTTP_TIMEOUT)
        .query(&[
            ("latitude", lat.as_str()),
            ("longitude", lon.as_str()),
            ("daily", "temperature_2m_max,temperature_2m_min,weather_code"),
            ("temperature_unit", "celsius"),
            ("wind_speed_unit", "kmh"),
            ("timezone", "auto"),
            ("forecast_days", forecast_days.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("forecast service unreachable: {}", short_err(&e.to_string())))?;

    if !resp.status().is_success() {
        return Err(format!("forecast http {}", resp.status()));
    }
    let body: ForecastResponse = resp
        .json()
        .await
        .map_err(|e| format!("forecast decode: {}", short_err(&e.to_string())))?;

    let daily = body.daily.ok_or_else(|| "forecast service returned no daily block".to_string())?;
    let n = daily
        .time
        .len()
        .min(daily.temperature_2m_max.len())
        .min(daily.temperature_2m_min.len())
        .min(daily.weather_code.len());
    if n == 0 {
        return Err("forecast returned zero days".into());
    }

    let mut lines: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        let label = format_day_label(&daily.time[i]);
        let hi = daily.temperature_2m_max[i]
            .map(|v| format!("{:.0}°C", v))
            .unwrap_or_else(|| "?".into());
        let lo = daily.temperature_2m_min[i]
            .map(|v| format!("{:.0}°C", v))
            .unwrap_or_else(|| "?".into());
        let cond = wmo_phrase(daily.weather_code[i].unwrap_or(0));
        lines.push(format!("{label}: {cond}, high {hi} / low {lo}"));
    }

    Ok(format!(
        "{}-day forecast for {}: {}.",
        n,
        pretty_location(&loc),
        lines.join("; "),
    ))
}

fn format_day_label(iso: &str) -> String {
    // iso is YYYY-MM-DD; render as "Mon 18 Apr" for brevity.
    match NaiveDate::parse_from_str(iso, "%Y-%m-%d") {
        Ok(d) => d.format("%a %-d %b").to_string(),
        Err(_) => iso.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Local time in a city
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tool_time_in_city(city: String) -> Result<String, String> {
    let loc = geocode(&city).await?;
    let tz_name = loc
        .timezone
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("no timezone known for {}", pretty_location(&loc)))?;

    let tz: Tz = tz_name
        .parse()
        .map_err(|_| format!("unknown IANA timezone: {tz_name}"))?;

    let now_utc: DateTime<Utc> = Utc::now();
    let local = now_utc.with_timezone(&tz);

    // Timezone abbreviation (e.g. "JST", "PDT") and UTC offset in whole hours
    // where possible, else "UTC±HH:MM" for half-hour zones.
    let offset_seconds = local.offset().fix().local_minus_utc();
    let offset_label = format_offset(offset_seconds);
    let abbr = format!("{}", local.format("%Z"));

    Ok(format!(
        "{} in {} — {} ({}), {}.",
        local.format("%H:%M"),
        pretty_location(&loc),
        abbr,
        offset_label,
        local.format("%A %-d %B"),
    ))
}

fn format_offset(seconds: i32) -> String {
    let sign = if seconds < 0 { '-' } else { '+' };
    let abs = seconds.unsigned_abs();
    let hours = abs / 3600;
    let minutes = (abs % 3600) / 60;
    if minutes == 0 {
        format!("UTC{sign}{hours}")
    } else {
        format!("UTC{sign}{hours}:{minutes:02}")
    }
}

// ---------------------------------------------------------------------------
// Sunrise + sunset
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct SunDailyBlock {
    #[serde(default)]
    time: Vec<String>,
    #[serde(default)]
    sunrise: Vec<String>,
    #[serde(default)]
    sunset: Vec<String>,
}

#[derive(Deserialize, Debug)]
struct SunResponse {
    #[serde(default)]
    daily: Option<SunDailyBlock>,
    #[serde(default)]
    timezone: Option<String>,
}

#[tauri::command]
pub async fn tool_sunrise_sunset(city: String) -> Result<String, String> {
    let loc = geocode(&city).await?;
    let client = crate::http::client();
    let lat = loc.latitude.to_string();
    let lon = loc.longitude.to_string();
    let resp = client
        .get("https://api.open-meteo.com/v1/forecast")
        .timeout(HTTP_TIMEOUT)
        .query(&[
            ("latitude", lat.as_str()),
            ("longitude", lon.as_str()),
            ("daily", "sunrise,sunset"),
            ("timezone", "auto"),
            ("forecast_days", "1"),
        ])
        .send()
        .await
        .map_err(|e| format!("sun service unreachable: {}", short_err(&e.to_string())))?;

    if !resp.status().is_success() {
        return Err(format!("sun http {}", resp.status()));
    }
    let body: SunResponse = resp
        .json()
        .await
        .map_err(|e| format!("sun decode: {}", short_err(&e.to_string())))?;

    let daily = body.daily.ok_or_else(|| "sun service returned no daily block".to_string())?;
    let tz_name = body
        .timezone
        .as_deref()
        .or(loc.timezone.as_deref())
        .unwrap_or("UTC");

    let sunrise_iso = daily.sunrise.first().ok_or_else(|| "no sunrise returned".to_string())?;
    let sunset_iso = daily.sunset.first().ok_or_else(|| "no sunset returned".to_string())?;
    let date_iso = daily.time.first().cloned().unwrap_or_else(|| sunrise_iso.clone());

    let sunrise = format_time_of_day(sunrise_iso, tz_name);
    let sunset = format_time_of_day(sunset_iso, tz_name);
    let date_label = format_day_label(date_iso.split('T').next().unwrap_or(&date_iso));

    Ok(format!(
        "In {} on {}, sunrise is at {} and sunset at {} ({}).",
        pretty_location(&loc),
        date_label,
        sunrise,
        sunset,
        tz_name,
    ))
}

/// open-meteo returns local-clock ISO strings like "2026-04-18T06:23" when
/// `timezone=auto`. No parsing of the timezone needed — just pluck HH:MM.
fn format_time_of_day(iso: &str, tz_name: &str) -> String {
    if let Some(time_part) = iso.split('T').nth(1) {
        let hm = time_part.get(..5).unwrap_or(time_part);
        return hm.to_string();
    }
    // Fallback: try to parse an offset-aware RFC3339 and project into the tz.
    if let Ok(dt) = DateTime::parse_from_rfc3339(iso) {
        if let Ok(tz) = tz_name.parse::<Tz>() {
            return dt.with_timezone(&tz).format("%H:%M").to_string();
        }
        return dt.format("%H:%M").to_string();
    }
    iso.to_string()
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------


/// Trim noisy reqwest error chains down to the first clause so the agent
/// gets something it can actually speak aloud.
fn short_err(msg: &str) -> String {
    msg.split(':').next().unwrap_or(msg).trim().to_string()
}

// ---------------------------------------------------------------------------
// WMO weather code → human phrase
//
// Table source: https://open-meteo.com/en/docs#weathervariables — the codes
// come from the WMO 4677 standard. We collapse variants ("light/moderate/
// heavy") into a single phrase because the LLM will re-phrase anyway and
// the temperature reading already conveys intensity.
// ---------------------------------------------------------------------------

fn wmo_phrase(code: u32) -> &'static str {
    match code {
        0 => "clear",
        1 => "mostly clear",
        2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "foggy",
        51 | 53 | 55 => "drizzling",
        56 | 57 => "freezing drizzle",
        61 | 63 | 65 => "raining",
        66 | 67 => "freezing rain",
        71 | 73 | 75 => "snowing",
        77 => "snow grains",
        80 | 81 | 82 => "rain showers",
        85 | 86 => "snow showers",
        95 => "thunderstorm",
        96 | 99 => "thunderstorm with hail",
        _ => "unsettled",
    }
}
