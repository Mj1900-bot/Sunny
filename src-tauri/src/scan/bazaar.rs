//! MalwareBazaar hash-lookup client.
//!
//! <https://bazaar.abuse.ch/api/#sha256> — no API key required (though
//! authenticated queries get higher rate limits; we skip auth to keep setup
//! zero-friction).
//!
//! We also call VirusTotal here when the user has supplied an API key.
//!
//! Results are cached in `~/.sunny/scan_cache.json` so repeated scans don't
//! re-query the network for the same hash.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::types::{Signal, SignalKind, Verdict};

const CACHE_FILE: &str = "scan_cache.json";
// Cache MB verdicts for 30 days. Malware status essentially never transitions
// "malicious" → "clean"; the other direction is rare and the inverse of our
// false-positive path. 30d is a sweet spot between user-perceived freshness
// and hammering the API.
const CACHE_TTL_SECS: i64 = 30 * 24 * 3600;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BazaarVerdict {
    /// true  → confirmed malware sample
    /// false → hash unknown to MalwareBazaar (NOT a guarantee of safety)
    pub is_known_bad: bool,
    /// Optional malware family (e.g. "Amos", "Silver Sparrow").
    pub signature: Option<String>,
    /// Optional detection tags.
    pub tags: Vec<String>,
    /// UNIX seconds when the record was cached.
    pub cached_at: i64,
}

/// Look up a SHA-256 in the local cache; falls back to the network.
/// Network errors return `Ok(None)` so scans don't die on flaky wifi.
pub async fn lookup_sha256(sha256: &str) -> Option<BazaarVerdict> {
    if let Some(cached) = cache_lookup(sha256) {
        return Some(cached);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("sunny-scanner/0.1")
        .build()
        .ok()?;

    let form = [("query", "get_info"), ("hash", sha256)];
    let resp = crate::http::send(
        client
            .post("https://mb-api.abuse.ch/api/v1/")
            .form(&form),
    )
    .await
    .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: BazaarEnvelope = resp.json().await.ok()?;
    let verdict = parse_envelope(body);
    cache_store(sha256, &verdict);
    Some(verdict)
}

/// Convert a `BazaarVerdict` into a wire-compatible `Signal`.
pub fn to_signal(v: &BazaarVerdict) -> Option<Signal> {
    if !v.is_known_bad {
        return None;
    }
    let mut detail = String::from("MalwareBazaar: known-bad sample");
    if let Some(sig) = &v.signature {
        detail.push_str(&format!(" ({sig})"));
    }
    if !v.tags.is_empty() {
        detail.push_str(&format!(" · tags: {}", v.tags.join(", ")));
    }
    Some(Signal {
        kind: SignalKind::MalwareBazaarHit,
        detail,
        weight: Verdict::Malicious,
    })
}

// ---------------------------------------------------------------------------
// VirusTotal (optional — requires user-supplied API key)
// ---------------------------------------------------------------------------

pub async fn lookup_virustotal(sha256: &str, api_key: &str) -> Option<VTVerdict> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("sunny-scanner/0.1")
        .build()
        .ok()?;
    let resp = crate::http::send(
        client
            .get(format!("https://www.virustotal.com/api/v3/files/{sha256}"))
            .header("x-apikey", api_key),
    )
    .await
    .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: VTEnvelope = resp.json().await.ok()?;
    Some(VTVerdict::from(body))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VTVerdict {
    pub malicious: u32,
    pub suspicious: u32,
    pub harmless: u32,
    pub undetected: u32,
    pub popular_threat_name: Option<String>,
}

pub fn vt_to_signal(v: &VTVerdict) -> Option<Signal> {
    if v.malicious == 0 && v.suspicious == 0 {
        return None;
    }
    let name = v
        .popular_threat_name
        .clone()
        .unwrap_or_else(|| "flagged by 1+ engines".into());
    let weight = if v.malicious >= 3 { Verdict::Malicious } else { Verdict::Suspicious };
    Some(Signal {
        kind: SignalKind::VirustotalHit,
        detail: format!(
            "VirusTotal: {} malicious, {} suspicious — {name}",
            v.malicious, v.suspicious
        ),
        weight,
    })
}

// ---------------------------------------------------------------------------
// Wire types — we only pluck what we need, full envelopes are huge.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct BazaarEnvelope {
    query_status: String,
    #[serde(default)]
    data: Vec<BazaarRow>,
}

#[derive(Deserialize)]
struct BazaarRow {
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

fn parse_envelope(e: BazaarEnvelope) -> BazaarVerdict {
    if e.query_status != "ok" {
        return BazaarVerdict {
            is_known_bad: false,
            signature: None,
            tags: Vec::new(),
            cached_at: now(),
        };
    }
    let row = e.data.into_iter().next();
    BazaarVerdict {
        is_known_bad: true,
        signature: row.as_ref().and_then(|r| r.signature.clone()),
        tags: row.map(|r| r.tags).unwrap_or_default(),
        cached_at: now(),
    }
}

#[derive(Deserialize)]
struct VTEnvelope {
    #[serde(default)]
    data: Option<VTData>,
}
#[derive(Deserialize)]
struct VTData {
    #[serde(default)]
    attributes: Option<VTAttrs>,
}
#[derive(Deserialize)]
struct VTAttrs {
    #[serde(default)]
    last_analysis_stats: Option<VTStats>,
    #[serde(default)]
    popular_threat_classification: Option<VTPopular>,
}
#[derive(Deserialize)]
struct VTStats {
    #[serde(default)]
    malicious: u32,
    #[serde(default)]
    suspicious: u32,
    #[serde(default)]
    harmless: u32,
    #[serde(default)]
    undetected: u32,
}
#[derive(Deserialize)]
struct VTPopular {
    #[serde(default)]
    suggested_threat_label: Option<String>,
}

impl From<VTEnvelope> for VTVerdict {
    fn from(e: VTEnvelope) -> Self {
        let attrs = e.data.and_then(|d| d.attributes).unwrap_or(VTAttrs {
            last_analysis_stats: None,
            popular_threat_classification: None,
        });
        let stats = attrs.last_analysis_stats.unwrap_or(VTStats {
            malicious: 0,
            suspicious: 0,
            harmless: 0,
            undetected: 0,
        });
        VTVerdict {
            malicious: stats.malicious,
            suspicious: stats.suspicious,
            harmless: stats.harmless,
            undetected: stats.undetected,
            popular_threat_name: attrs
                .popular_threat_classification
                .and_then(|p| p.suggested_threat_label),
        }
    }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

fn cache_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".sunny");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(CACHE_FILE))
}

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    entries: HashMap<String, BazaarVerdict>,
}

static CACHE: Mutex<Option<CacheFile>> = Mutex::new(None);

fn load() -> CacheFile {
    let path = match cache_path() {
        Some(p) => p,
        None => return CacheFile::default(),
    };
    let data = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return CacheFile::default(),
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save(c: &CacheFile) {
    if let Some(path) = cache_path() {
        if let Ok(s) = serde_json::to_string(c) {
            let _ = fs::write(&path, s);
        }
    }
}

fn cache_lookup(sha256: &str) -> Option<BazaarVerdict> {
    let mut guard = CACHE.lock().ok()?;
    if guard.is_none() {
        *guard = Some(load());
    }
    let cache = guard.as_ref()?;
    let v = cache.entries.get(sha256)?.clone();
    if now() - v.cached_at > CACHE_TTL_SECS {
        return None;
    }
    Some(v)
}

fn cache_store(sha256: &str, v: &BazaarVerdict) {
    let mut guard = match CACHE.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_none() {
        *guard = Some(load());
    }
    if let Some(cache) = guard.as_mut() {
        cache.entries.insert(sha256.to_string(), v.clone());
        save(cache);
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
