//! worldinfo — quick, no-API-key real-world info.
//!
//! Weather  : wttr.in          (JSON format=j1, no key)
//! Stocks   : query2.finance.yahoo.com chart v8 (no key)
//! Units    : pure math (length, mass, temp, volume, speed)
//!
//! All results are immutable (`#[derive(Clone, Serialize)]`) — callers receive
//! owned copies, and the in-memory cache stores clones so handlers never mutate
//! any stored value in place.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::agent_loop::helpers::truncate;
use ts_rs::TS;

// ---------------- public types ----------------

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Weather {
    pub city: String,
    pub temp_c: f64,
    pub temp_f: f64,
    pub condition: String,
    #[ts(type = "number")]
    pub humidity: u32,
    pub wind_kph: f64,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DayForecast {
    pub date: String,
    pub high_c: f64,
    pub low_c: f64,
    pub condition: String,
    pub rain_mm: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Forecast {
    pub days: Vec<DayForecast>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StockQuote {
    pub ticker: String,
    pub price: f64,
    pub change_percent: f64,
    pub change_abs: f64,
    pub currency: String,
    pub market: String,
    pub timestamp: String,
}

// ---------------- cache ----------------

const USER_AGENT: &str = "SUNNY/0.1";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const WEATHER_TTL: Duration = Duration::from_secs(60);
const STOCK_TTL: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct CacheEntry<T> {
    stamped: Instant,
    value: T,
}

static WEATHER_CACHE: OnceLock<RwLock<HashMap<String, CacheEntry<Weather>>>> = OnceLock::new();
static FORECAST_CACHE: OnceLock<RwLock<HashMap<String, CacheEntry<Forecast>>>> = OnceLock::new();
static STOCK_CACHE: OnceLock<RwLock<HashMap<String, CacheEntry<StockQuote>>>> = OnceLock::new();

fn weather_cache() -> &'static RwLock<HashMap<String, CacheEntry<Weather>>> {
    WEATHER_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}
fn forecast_cache() -> &'static RwLock<HashMap<String, CacheEntry<Forecast>>> {
    FORECAST_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}
fn stock_cache() -> &'static RwLock<HashMap<String, CacheEntry<StockQuote>>> {
    STOCK_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn cache_get<T: Clone>(
    cache: &RwLock<HashMap<String, CacheEntry<T>>>,
    key: &str,
    ttl: Duration,
) -> Option<T> {
    let guard = cache.read().ok()?;
    let entry = guard.get(key)?;
    if entry.stamped.elapsed() <= ttl {
        Some(entry.value.clone())
    } else {
        None
    }
}

fn cache_put<T: Clone>(cache: &RwLock<HashMap<String, CacheEntry<T>>>, key: String, value: T) {
    if let Ok(mut guard) = cache.write() {
        // Immutable-style: build a fresh entry, drop the old.
        guard.insert(
            key,
            CacheEntry {
                stamped: Instant::now(),
                value,
            },
        );
    }
}

// ---------------- http client ----------------

/// Thin wrapper around the process-wide shared `reqwest::Client`.
///
/// Previously this rebuilt a fresh client per call — each paid a TLS
/// handshake on the first hit to `wttr.in` / Yahoo Finance. The shared
/// client keeps the pool warm; the per-call 10 s timeout is applied
/// per-request at the (single) call site below via
/// `RequestBuilder::timeout`.
fn build_client() -> Result<reqwest::Client, String> {
    Ok(crate::http::client())
}

async fn get_text(url: &str) -> Result<String, String> {
    let client = build_client()?;
    let req = client
        .get(url)
        .timeout(HTTP_TIMEOUT)
        .header(reqwest::header::USER_AGENT, USER_AGENT);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("request failed: {}", e))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read body failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("http {} from {}: {}", status.as_u16(), url, truncate(&body, 180)));
    }
    Ok(body)
}


// ---------------- weather ----------------

pub async fn weather_current(city: String) -> Result<Weather, String> {
    let city = city.trim().to_string();
    if city.is_empty() {
        return Err("city is required".to_string());
    }
    let key = city.to_lowercase();
    if let Some(v) = cache_get(weather_cache(), &key, WEATHER_TTL) {
        return Ok(v);
    }
    let url = format!("https://wttr.in/{}?format=j1", urlencode(&city));
    let body = get_text(&url).await?;
    let weather = parse_wttr_current(&city, &body)?;
    cache_put(weather_cache(), key, weather.clone());
    Ok(weather)
}

pub async fn weather_forecast(city: String, days: u32) -> Result<Forecast, String> {
    let city = city.trim().to_string();
    if city.is_empty() {
        return Err("city is required".to_string());
    }
    if !(1..=7).contains(&days) {
        return Err(format!("days must be between 1 and 7 (got {})", days));
    }
    let key = format!("{}|{}", city.to_lowercase(), days);
    if let Some(v) = cache_get(forecast_cache(), &key, WEATHER_TTL) {
        return Ok(v);
    }
    let url = format!("https://wttr.in/{}?format=j1", urlencode(&city));
    let body = get_text(&url).await?;
    let forecast = parse_wttr_forecast(&body, days)?;
    cache_put(forecast_cache(), key, forecast.clone());
    Ok(forecast)
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            _ => {
                let mut buf = [0u8; 4];
                let bytes = c.encode_utf8(&mut buf).as_bytes().to_vec();
                bytes.iter().map(|b| format!("%{:02X}", b)).collect()
            }
        })
        .collect()
}

fn parse_wttr_current(city: &str, body: &str) -> Result<Weather, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("wttr parse failed: {}", e))?;
    let current = v
        .get("current_condition")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "wttr: missing current_condition".to_string())?;

    let temp_c: f64 = current
        .get("temp_C")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "wttr: missing temp_C".to_string())?;
    let temp_f: f64 = current
        .get("temp_F")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(temp_c * 9.0 / 5.0 + 32.0);
    let humidity: u32 = current
        .get("humidity")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let wind_kph: f64 = current
        .get("windspeedKmph")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let condition = current
        .get("weatherDesc")
        .and_then(|x| x.as_array())
        .and_then(|a| a.first())
        .and_then(|o| o.get("value"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let observed_at = current
        .get("localObsDateTime")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    // Fall back to the nearest_area name if wttr returns a canonical form.
    let display_city = v
        .get("nearest_area")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|o| o.get("areaName"))
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|o| o.get("value"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| city.to_string());

    Ok(Weather {
        city: display_city,
        temp_c,
        temp_f,
        condition,
        humidity,
        wind_kph,
        observed_at,
    })
}

fn parse_wttr_forecast(body: &str, days: u32) -> Result<Forecast, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("wttr parse failed: {}", e))?;
    let arr = v
        .get("weather")
        .and_then(|w| w.as_array())
        .ok_or_else(|| "wttr: missing weather array".to_string())?;

    let days_out: Vec<DayForecast> = arr
        .iter()
        .take(days as usize)
        .filter_map(|d| {
            let date = d.get("date")?.as_str()?.to_string();
            let high_c: f64 = d.get("maxtempC")?.as_str()?.parse().ok()?;
            let low_c: f64 = d.get("mintempC")?.as_str()?.parse().ok()?;
            let condition = d
                .get("hourly")
                .and_then(|h| h.as_array())
                .and_then(|h| h.get(4).or_else(|| h.first()))
                .and_then(|h| h.get("weatherDesc"))
                .and_then(|w| w.as_array())
                .and_then(|a| a.first())
                .and_then(|o| o.get("value"))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let rain_mm: f64 = d
                .get("hourly")
                .and_then(|h| h.as_array())
                .map(|h| {
                    h.iter()
                        .filter_map(|hr| hr.get("precipMM")?.as_str()?.parse::<f64>().ok())
                        .sum::<f64>()
                })
                .unwrap_or(0.0);
            Some(DayForecast {
                date,
                high_c,
                low_c,
                condition,
                rain_mm,
            })
        })
        .collect();

    if days_out.is_empty() {
        return Err("wttr: no forecast days parsed".to_string());
    }
    Ok(Forecast { days: days_out })
}

// ---------------- stocks ----------------

pub async fn stock_quote(ticker: String) -> Result<StockQuote, String> {
    let ticker = ticker.trim().to_uppercase();
    if ticker.is_empty() {
        return Err("ticker is required".to_string());
    }
    let key = ticker.clone();
    if let Some(v) = cache_get(stock_cache(), &key, STOCK_TTL) {
        return Ok(v);
    }
    let url = format!(
        "https://query2.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d",
        urlencode(&ticker)
    );
    let body = get_text(&url).await?;
    let quote = parse_yahoo_chart(&ticker, &body)?;
    cache_put(stock_cache(), key, quote.clone());
    Ok(quote)
}

fn parse_yahoo_chart(ticker: &str, body: &str) -> Result<StockQuote, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("yahoo parse failed: {}", e))?;

    // Error envelope: chart.error may be non-null on bad ticker / 4xx-ish.
    if let Some(err) = v.pointer("/chart/error") {
        if !err.is_null() {
            let desc = err
                .get("description")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown yahoo error");
            return Err(format!("yahoo: {}", desc));
        }
    }

    let meta = v
        .pointer("/chart/result/0/meta")
        .ok_or_else(|| "yahoo: missing meta".to_string())?;

    let price = meta
        .get("regularMarketPrice")
        .and_then(|x| x.as_f64())
        .ok_or_else(|| "yahoo: missing regularMarketPrice".to_string())?;
    let prev = meta
        .get("chartPreviousClose")
        .and_then(|x| x.as_f64())
        .or_else(|| meta.get("previousClose").and_then(|x| x.as_f64()))
        .unwrap_or(price);
    let change_abs = price - prev;
    let change_percent = if prev.abs() > f64::EPSILON {
        (change_abs / prev) * 100.0
    } else {
        0.0
    };
    let currency = meta
        .get("currency")
        .and_then(|s| s.as_str())
        .unwrap_or("USD")
        .to_string();
    let market = meta
        .get("exchangeName")
        .and_then(|s| s.as_str())
        .or_else(|| meta.get("fullExchangeName").and_then(|s| s.as_str()))
        .unwrap_or("")
        .to_string();
    let ts_epoch = meta
        .get("regularMarketTime")
        .and_then(|x| x.as_i64())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });
    let timestamp = format_epoch(ts_epoch);

    Ok(StockQuote {
        ticker: ticker.to_string(),
        price,
        change_percent,
        change_abs,
        currency,
        market,
        timestamp,
    })
}

fn format_epoch(secs: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

// ---------------- unit conversion ----------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dim {
    Length,
    Mass,
    Temp,
    Volume,
    Speed,
}

/// (canonical-unit factor, dimension). Temperature is handled out-of-band.
fn unit_spec(name: &str) -> Option<(f64, Dim)> {
    // Length — canonical: meters
    let n = name.trim().to_lowercase();
    let n = n.as_str();
    match n {
        // length
        "m" | "meter" | "meters" => Some((1.0, Dim::Length)),
        "km" | "kilometer" | "kilometers" => Some((1000.0, Dim::Length)),
        "cm" | "centimeter" | "centimeters" => Some((0.01, Dim::Length)),
        "mm" | "millimeter" | "millimeters" => Some((0.001, Dim::Length)),
        "mi" | "mile" | "miles" => Some((1609.344, Dim::Length)),
        "ft" | "foot" | "feet" => Some((0.3048, Dim::Length)),
        "in" | "inch" | "inches" => Some((0.0254, Dim::Length)),
        "yd" | "yard" | "yards" => Some((0.9144, Dim::Length)),

        // mass — canonical: kilograms
        "kg" | "kilogram" | "kilograms" => Some((1.0, Dim::Mass)),
        "g" | "gram" | "grams" => Some((0.001, Dim::Mass)),
        "mg" | "milligram" | "milligrams" => Some((1e-6, Dim::Mass)),
        "lb" | "lbs" | "pound" | "pounds" => Some((0.45359237, Dim::Mass)),
        "oz" | "ounce" | "ounces" => Some((0.028349523125, Dim::Mass)),

        // temp — handled separately but still tagged
        "c" | "celsius" => Some((0.0, Dim::Temp)),
        "f" | "fahrenheit" => Some((0.0, Dim::Temp)),
        "k" | "kelvin" => Some((0.0, Dim::Temp)),

        // volume — canonical: liters
        "l" | "liter" | "liters" => Some((1.0, Dim::Volume)),
        "ml" | "milliliter" | "milliliters" => Some((0.001, Dim::Volume)),
        "gal" | "gallon" | "gallons" => Some((3.785411784, Dim::Volume)), // US gallon
        "fl_oz" | "floz" | "fluid_ounce" | "fluid_ounces" => Some((0.0295735295625, Dim::Volume)),
        "pt" | "pint" | "pints" => Some((0.473176473, Dim::Volume)),
        "qt" | "quart" | "quarts" => Some((0.946352946, Dim::Volume)),

        // speed — canonical: meters/second
        "ms" | "m/s" | "mps" => Some((1.0, Dim::Speed)),
        "kph" | "km/h" | "kmph" => Some((1.0 / 3.6, Dim::Speed)),
        "mph" => Some((0.44704, Dim::Speed)),
        "knots" | "kn" | "knot" => Some((0.514444, Dim::Speed)),

        _ => None,
    }
}

fn temp_to_kelvin(v: f64, unit: &str) -> Option<f64> {
    match unit.trim().to_lowercase().as_str() {
        "c" | "celsius" => Some(v + 273.15),
        "f" | "fahrenheit" => Some((v - 32.0) * 5.0 / 9.0 + 273.15),
        "k" | "kelvin" => Some(v),
        _ => None,
    }
}

fn kelvin_to_unit(k: f64, unit: &str) -> Option<f64> {
    match unit.trim().to_lowercase().as_str() {
        "c" | "celsius" => Some(k - 273.15),
        "f" | "fahrenheit" => Some((k - 273.15) * 9.0 / 5.0 + 32.0),
        "k" | "kelvin" => Some(k),
        _ => None,
    }
}

pub async fn unit_convert(
    value: f64,
    from_unit: String,
    to_unit: String,
) -> Result<f64, String> {
    let (from_factor, from_dim) = unit_spec(&from_unit)
        .ok_or_else(|| format!("unknown unit: '{}'", from_unit))?;
    let (to_factor, to_dim) = unit_spec(&to_unit)
        .ok_or_else(|| format!("unknown unit: '{}'", to_unit))?;

    if from_dim != to_dim {
        return Err(format!(
            "dimension mismatch: '{}' ({:?}) vs '{}' ({:?})",
            from_unit, from_dim, to_unit, to_dim
        ));
    }

    if from_dim == Dim::Temp {
        let k = temp_to_kelvin(value, &from_unit)
            .ok_or_else(|| format!("bad temperature unit: {}", from_unit))?;
        return kelvin_to_unit(k, &to_unit)
            .ok_or_else(|| format!("bad temperature unit: {}", to_unit));
    }

    // canonical value -> target unit
    let canonical = value * from_factor;
    Ok(canonical / to_factor)
}

// ---------------- tests ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[tokio::test]
    async fn length_m_to_ft() {
        let v = unit_convert(1.0, "m".into(), "ft".into()).await.unwrap();
        assert!(approx(v, 3.28084, 1e-4));
    }

    #[tokio::test]
    async fn length_mi_to_km() {
        let v = unit_convert(1.0, "mi".into(), "km".into()).await.unwrap();
        assert!(approx(v, 1.609344, 1e-6));
    }

    #[tokio::test]
    async fn length_cm_to_in() {
        let v = unit_convert(2.54, "cm".into(), "in".into()).await.unwrap();
        assert!(approx(v, 1.0, 1e-6));
    }

    #[tokio::test]
    async fn mass_kg_to_lb() {
        let v = unit_convert(1.0, "kg".into(), "lb".into()).await.unwrap();
        assert!(approx(v, 2.20462, 1e-4));
    }

    #[tokio::test]
    async fn mass_oz_to_g() {
        let v = unit_convert(1.0, "oz".into(), "g".into()).await.unwrap();
        assert!(approx(v, 28.3495, 1e-3));
    }

    #[tokio::test]
    async fn temp_c_to_f_freezing() {
        let v = unit_convert(0.0, "c".into(), "f".into()).await.unwrap();
        assert!(approx(v, 32.0, 1e-6));
    }

    #[tokio::test]
    async fn temp_f_to_c_body() {
        let v = unit_convert(98.6, "f".into(), "c".into()).await.unwrap();
        assert!(approx(v, 37.0, 1e-3));
    }

    #[tokio::test]
    async fn temp_c_to_k() {
        let v = unit_convert(25.0, "c".into(), "k".into()).await.unwrap();
        assert!(approx(v, 298.15, 1e-6));
    }

    #[tokio::test]
    async fn speed_kph_to_mph() {
        let v = unit_convert(100.0, "kph".into(), "mph".into()).await.unwrap();
        assert!(approx(v, 62.1371, 1e-3));
    }

    #[tokio::test]
    async fn speed_knots_to_kph() {
        let v = unit_convert(1.0, "knots".into(), "kph".into()).await.unwrap();
        assert!(approx(v, 1.852, 1e-3));
    }

    #[tokio::test]
    async fn unknown_unit_errors() {
        let err = unit_convert(1.0, "parsec".into(), "m".into()).await.unwrap_err();
        assert!(err.contains("unknown unit"), "got: {}", err);
    }

    #[tokio::test]
    async fn dimension_mismatch_errors() {
        let err = unit_convert(1.0, "kg".into(), "m".into()).await.unwrap_err();
        assert!(err.contains("dimension mismatch"), "got: {}", err);
    }

    // ---- fixture parsing ----

    const WTTR_FIXTURE: &str = r#"{
      "current_condition": [{
        "temp_C": "12",
        "temp_F": "54",
        "humidity": "72",
        "windspeedKmph": "14",
        "localObsDateTime": "2026-04-17 10:00 AM",
        "weatherDesc": [{"value": "Partly cloudy"}]
      }],
      "nearest_area": [{
        "areaName": [{"value": "Vancouver"}]
      }],
      "weather": [
        {
          "date": "2026-04-17",
          "maxtempC": "14",
          "mintempC": "7",
          "hourly": [
            {"precipMM": "0.0", "weatherDesc": [{"value": "Clear"}]},
            {"precipMM": "0.2", "weatherDesc": [{"value": "Cloudy"}]},
            {"precipMM": "0.0", "weatherDesc": [{"value": "Sunny"}]},
            {"precipMM": "0.1", "weatherDesc": [{"value": "Overcast"}]},
            {"precipMM": "0.0", "weatherDesc": [{"value": "Partly cloudy"}]}
          ]
        },
        {
          "date": "2026-04-18",
          "maxtempC": "16",
          "mintempC": "8",
          "hourly": [
            {"precipMM": "1.5", "weatherDesc": [{"value": "Rain"}]}
          ]
        }
      ]
    }"#;

    #[test]
    fn parse_wttr_current_happy() {
        let w = parse_wttr_current("vancouver", WTTR_FIXTURE).unwrap();
        assert_eq!(w.city, "Vancouver");
        assert!(approx(w.temp_c, 12.0, 1e-9));
        assert!(approx(w.temp_f, 54.0, 1e-9));
        assert_eq!(w.humidity, 72);
        assert!(approx(w.wind_kph, 14.0, 1e-9));
        assert_eq!(w.condition, "Partly cloudy");
        assert_eq!(w.observed_at, "2026-04-17 10:00 AM");
    }

    #[test]
    fn parse_wttr_forecast_happy() {
        let f = parse_wttr_forecast(WTTR_FIXTURE, 2).unwrap();
        assert_eq!(f.days.len(), 2);
        assert_eq!(f.days[0].date, "2026-04-17");
        assert!(approx(f.days[0].high_c, 14.0, 1e-9));
        assert!(approx(f.days[0].low_c, 7.0, 1e-9));
        assert!(approx(f.days[0].rain_mm, 0.3, 1e-9));
        assert_eq!(f.days[1].date, "2026-04-18");
        assert!(approx(f.days[1].rain_mm, 1.5, 1e-9));
    }

    const YAHOO_FIXTURE: &str = r#"{
      "chart": {
        "error": null,
        "result": [{
          "meta": {
            "currency": "USD",
            "symbol": "AAPL",
            "exchangeName": "NMS",
            "fullExchangeName": "NasdaqGS",
            "regularMarketPrice": 190.25,
            "chartPreviousClose": 188.50,
            "regularMarketTime": 1713369600
          }
        }]
      }
    }"#;

    #[test]
    fn parse_yahoo_chart_happy() {
        let q = parse_yahoo_chart("AAPL", YAHOO_FIXTURE).unwrap();
        assert_eq!(q.ticker, "AAPL");
        assert!(approx(q.price, 190.25, 1e-9));
        assert!(approx(q.change_abs, 1.75, 1e-9));
        assert!(approx(q.change_percent, 0.9283, 1e-3));
        assert_eq!(q.currency, "USD");
        assert_eq!(q.market, "NMS");
        assert!(!q.timestamp.is_empty());
    }

    #[test]
    fn parse_yahoo_chart_error_envelope() {
        let body = r#"{"chart":{"error":{"code":"Not Found","description":"No data found"},"result":null}}"#;
        let err = parse_yahoo_chart("ZZZZ", body).unwrap_err();
        assert!(err.contains("No data found"), "got: {}", err);
    }
}

// === REGISTER IN lib.rs ===
// mod worldinfo;
// #[tauri::command]s: weather_current, weather_forecast, stock_quote, unit_convert
// invoke_handler: same names
// No new Cargo deps.
// === END REGISTER ===
