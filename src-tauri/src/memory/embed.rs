//! Embedding service — dense vector representations for memory rows.
//!
//! Transport: HTTP POST to Ollama's `/api/embed` (or the older
//! `/api/embeddings` endpoint as a fallback). We don't bundle a model; the
//! user is expected to have `nomic-embed-text` pulled into their local
//! Ollama. When Ollama isn't running or the model isn't installed, every
//! entry point degrades gracefully:
//!
//!   * `embed()` returns `Err` — the caller (usually `spawn_*_embed`) logs
//!     at debug and skips the UPDATE. The row stays with `embedding = NULL`
//!     and the backfill loop will retry later.
//!   * `similarity_search()` returns an empty vec — hybrid search falls
//!     back to FTS-only ranking.
//!
//! The net effect: the memory system works without embeddings (FTS still
//! does its job), and *gets smarter* the moment Ollama is available. No
//! hard dependency, no breakage.
//!
//! ### Encoding
//! Embeddings are stored as BLOBs of little-endian f32s. 768 dims for
//! nomic-embed-text → 3072 bytes per row. At 10k rows that's ~30 MB — fine
//! for sqlite, fine for brute-force cosine.

use std::collections::HashMap;
use std::time::Duration;

use rusqlite::params;
use serde::Deserialize;

use super::db::{lock_guard, with_conn};

// ---------------------------------------------------------------------------
// Public knobs
// ---------------------------------------------------------------------------

const OLLAMA_HOST: &str = "http://127.0.0.1:11434";
/// Default embedding model. nomic-embed-text is 768-dim, ~1 GB on disk,
/// fast (<50ms/request on Apple silicon).
const DEFAULT_MODEL: &str = "nomic-embed-text";
const EMBED_TIMEOUT: Duration = Duration::from_secs(8);

// ---------------------------------------------------------------------------
// Low-level: embed a single string
// ---------------------------------------------------------------------------

/// Compute an embedding for `text` via the local Ollama. Prefers the newer
/// `/api/embed` endpoint; on 404 (older Ollama) falls through to the legacy
/// `/api/embeddings`. Returns `Err` on any transport or parse failure so
/// callers can decide whether to retry.
pub async fn embed(text: &str) -> Result<Vec<f32>, String> {
    embed_with_model(text, DEFAULT_MODEL).await
}

pub async fn embed_with_model(text: &str, model: &str) -> Result<Vec<f32>, String> {
    if text.trim().is_empty() {
        return Err("embed: text is empty".into());
    }
    // Use the process-wide shared client so keep-alive to the local
    // Ollama daemon is reused across embedding calls. The 8 s embed
    // timeout is applied per-request below (reqwest's per-request
    // timeout wins over the client-level default).
    let client = crate::http::client();

    // Try the modern endpoint first. `input` is a scalar string; the server
    // returns `{ "embeddings": [[…]] }`.
    let modern_body = serde_json::json!({ "model": model, "input": text });
    let modern_req = client
        .post(format!("{OLLAMA_HOST}/api/embed"))
        .timeout(EMBED_TIMEOUT)
        .json(&modern_body);
    let modern = crate::http::send(modern_req).await;

    match modern {
        Ok(resp) if resp.status().is_success() => {
            let parsed: ModernResponse = resp
                .json()
                .await
                .map_err(|e| format!("embed parse (modern): {e}"))?;
            parsed
                .embeddings
                .into_iter()
                .next()
                .ok_or_else(|| "embed: empty embeddings array".into())
        }
        Ok(resp) if resp.status().as_u16() == 404 => fallback_legacy(&client, text, model).await,
        Ok(resp) => Err(format!("embed http {}", resp.status())),
        Err(e) => {
            // Connection refused / timeout → most likely Ollama is off. Let the
            // caller tell the user once and move on.
            Err(format!("embed transport: {e}"))
        }
    }
}

async fn fallback_legacy(
    client: &reqwest::Client,
    text: &str,
    model: &str,
) -> Result<Vec<f32>, String> {
    let legacy_body = serde_json::json!({ "model": model, "prompt": text });
    let legacy_req = client
        .post(format!("{OLLAMA_HOST}/api/embeddings"))
        .timeout(EMBED_TIMEOUT)
        .json(&legacy_body);
    let resp = crate::http::send(legacy_req)
        .await
        .map_err(|e| format!("embed legacy transport: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("embed legacy http {}", resp.status()));
    }
    let parsed: LegacyResponse = resp
        .json()
        .await
        .map_err(|e| format!("embed parse (legacy): {e}"))?;
    Ok(parsed.embedding)
}

#[derive(Deserialize)]
struct ModernResponse {
    embeddings: Vec<Vec<f32>>,
}

#[derive(Deserialize)]
struct LegacyResponse {
    embedding: Vec<f32>,
}

// ---------------------------------------------------------------------------
// Encoding — f32 little-endian to BLOB and back
// ---------------------------------------------------------------------------

pub fn encode_f32_le(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

pub fn decode_f32_le(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() % 4 != 0 {
        return Err(format!(
            "decode_f32_le: BLOB length {} is not a multiple of 4",
            bytes.len()
        ));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr: [u8; 4] = chunk.try_into().unwrap();
        out.push(f32::from_le_bytes(arr));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Math — cosine similarity, normalized to [-1, 1].
// ---------------------------------------------------------------------------

/// Cosine similarity. Defined as the dot product of the unit-normalised
/// vectors; returns 0.0 on mismatched lengths or zero-magnitude input rather
/// than NaN / panic. Callers expect the convention `1.0 = identical,
/// 0.0 = orthogonal, -1.0 = opposite`.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0_f32;
    let mut na = 0.0_f32;
    let mut nb = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na <= 0.0 || nb <= 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

// ---------------------------------------------------------------------------
// Fire-and-forget embedders — called from Tauri command wrappers right
// after an insert. The insert returns immediately; the embedding lands
// asynchronously, visible to the next similarity query.
// ---------------------------------------------------------------------------

/// Spawn a background task that embeds `text`, then UPDATEs the row's
/// `embedding` column. Uses tauri's async_runtime so it joins the existing
/// tokio runtime and doesn't require the caller to pass an AppHandle.
pub fn spawn_embed_for(table: &'static str, id: String, text: String) {
    tauri::async_runtime::spawn(async move {
        let Ok(vec) = embed(&text).await else {
            log::debug!("embed: skipped {table}:{id} (ollama unavailable)");
            return;
        };
        let bytes = encode_f32_le(&vec);
        let sql = format!("UPDATE {table} SET embedding = ?1 WHERE id = ?2");
        if let Err(e) = with_conn(|c| {
            c.execute(&sql, params![bytes, id])
                .map(|_| ())
                .map_err(|e| format!("update embedding {table}:{id}: {e}"))
        }) {
            log::warn!("{e}");
        }
    });
}

// ---------------------------------------------------------------------------
// Backfill — a supervised loop that walks un-embedded rows and fills them
// in. Throttled to avoid hammering Ollama when the DB is large.
// ---------------------------------------------------------------------------

/// Start the backfill loop. Runs forever (well, for the life of the app),
/// wakes every `tick` seconds, processes up to `batch` rows per store per
/// tick, sleeps between embed calls to stay polite. Idempotent — calling
/// twice is harmless; the second call's task will race with the first's
/// queries and lose some rounds, which is fine.
pub fn start_backfill_loop() {
    tauri::async_runtime::spawn(async move {
        // Wait a few seconds after boot so we don't fight startup I/O.
        tokio::time::sleep(Duration::from_secs(5)).await;
        let tick = Duration::from_secs(30);
        let batch = 8_usize;
        loop {
            match tick_once(batch).await {
                Ok(filled) => {
                    if filled > 0 {
                        log::info!("backfill: embedded {filled} rows this tick");
                    }
                }
                Err(e) => log::debug!("backfill tick: {e}"),
            }
            tokio::time::sleep(tick).await;
        }
    });
}

async fn tick_once(batch: usize) -> Result<usize, String> {
    let mut total = 0_usize;
    for table in ["episodic", "semantic", "procedural"] {
        let rows = fetch_pending(table, batch)?;
        for (id, text) in rows {
            match embed(&text).await {
                Ok(v) => {
                    let bytes = encode_f32_le(&v);
                    let sql = format!("UPDATE {table} SET embedding = ?1 WHERE id = ?2");
                    if with_conn(|c| {
                        c.execute(&sql, params![bytes, id])
                            .map(|_| ())
                            .map_err(|e| format!("backfill update: {e}"))
                    })
                    .is_ok()
                    {
                        total += 1;
                    }
                }
                Err(e) => {
                    // One failure is usually "Ollama not running" — bail
                    // this whole tick instead of hammering the next 7 rows
                    // with guaranteed-to-fail requests.
                    log::debug!("backfill embed failed ({e}); deferring tick");
                    return Ok(total);
                }
            }
            // Tiny inter-request delay — keeps CPU usage on a small mac modest.
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    Ok(total)
}

fn fetch_pending(table: &str, limit: usize) -> Result<Vec<(String, String)>, String> {
    let column = if table == "procedural" { "trigger_text" } else { "text" };
    let guard = lock_guard()?;
    let sql = format!(
        "SELECT id, {column} FROM {table}
         WHERE embedding IS NULL
           AND {column} IS NOT NULL
           AND length({column}) > 0
         LIMIT ?1"
    );
    let mut stmt = guard.prepare(&sql).map_err(|e| format!("prep pending: {e}"))?;
    let rows = stmt
        .query_map(params![limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| format!("query pending: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect pending: {e}"))?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Canonical rerank primitives — single home for fetching embeddings by id
// and cosine-ranking typed candidates. Used by both `memory::hybrid::search`
// (episodic hybrid path) and `memory::pack::build_pack` (cross-store pack).
//
// Motivation: both modules previously carried their own `fetch_embeddings_by_id`
// and a near-identical cosine rerank loop. Consolidating them here removes the
// duplication flagged by κ v10 and guarantees a single ordering rule.
// ---------------------------------------------------------------------------

/// Bulk-fetch embeddings for a set of row IDs from `table`. Rows without an
/// embedding blob are silently omitted from the returned map (the caller
/// decides how to treat a missing entry). Errors propagate when the sqlite
/// query itself fails; a missing row is NOT an error.
pub fn fetch_embeddings_by_id(
    table: &str,
    ids: &[String],
) -> Result<HashMap<String, Vec<f32>>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, embedding FROM {table}
         WHERE id IN ({placeholders}) AND embedding IS NOT NULL"
    );
    with_conn(|c| {
        let mut stmt = c.prepare(&sql).map_err(|e| format!("fetch_embeddings prep: {e}"))?;
        let params: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let mut out = HashMap::new();
        let rows = stmt
            .query_map(&params[..], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| format!("fetch_embeddings query: {e}"))?;
        for row in rows {
            let (id, blob) = row.map_err(|e| format!("fetch_embeddings row: {e}"))?;
            if let Ok(v) = decode_f32_le(&blob) {
                out.insert(id, v);
            }
        }
        Ok(out)
    })
}

/// Generic cosine rerank: given typed candidates, a way to extract each
/// one's id, and a precomputed map of embeddings, sort DESC by cosine to
/// `query_vec`. Rows missing from the embedding map get a sentinel score
/// of `-2.0` so they sort AFTER any real match (cosine range is [-1, 1]).
/// This preserves FTS order at the tail of the result instead of dropping
/// embedding-less rows outright — which matters on fresh installs where
/// the backfill hasn't caught up yet.
///
/// `limit` caps the returned vec. Pass `usize::MAX` to disable truncation.
pub fn rerank_by_id<T: Clone, F: Fn(&T) -> String>(
    query_vec: &[f32],
    candidates: Vec<T>,
    embeddings: &HashMap<String, Vec<f32>>,
    limit: usize,
    get_id: F,
) -> Vec<T> {
    if candidates.is_empty() {
        return candidates;
    }
    let mut scored: Vec<(f32, T)> = candidates
        .into_iter()
        .map(|c| {
            let id = get_id(&c);
            let score = embeddings
                .get(&id)
                .map(|v| cosine(query_vec, v))
                .unwrap_or(-2.0);
            (score, c)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit);
    scored.into_iter().map(|(_, c)| c).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let v = vec![0.1_f32, -0.25, 3.14, f32::MIN_POSITIVE, 0.0];
        let bytes = encode_f32_le(&v);
        let back = decode_f32_le(&bytes).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn decode_rejects_malformed_length() {
        let bad = vec![0_u8, 1, 2]; // 3 bytes ≠ multiple of 4
        assert!(decode_f32_le(&bad).is_err());
    }

    #[test]
    fn cosine_identity_is_one_and_zero_on_orthogonal() {
        let a = vec![1.0_f32, 0.0, 0.0];
        let b = vec![0.0_f32, 1.0, 0.0];
        let c = vec![1.0_f32, 0.0, 0.0];
        assert!((cosine(&a, &c) - 1.0).abs() < 1e-6);
        assert!(cosine(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn cosine_handles_mismatched_and_empty() {
        assert_eq!(cosine(&[], &[]), 0.0);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
        // Zero-magnitude input → 0.0 rather than NaN.
        let zero = vec![0.0_f32; 4];
        let v = vec![1.0_f32, 0.0, 0.0, 0.0];
        assert_eq!(cosine(&zero, &v), 0.0);
    }

    #[test]
    fn cosine_is_symmetric() {
        let a = vec![0.1_f32, 0.2, 0.3];
        let b = vec![0.4_f32, 0.5, 0.6];
        let ab = cosine(&a, &b);
        let ba = cosine(&b, &a);
        assert!((ab - ba).abs() < 1e-6);
    }

    #[test]
    fn rerank_by_id_sorts_desc_and_places_missing_at_tail() {
        // Pure-function test over the generic reranker. No sqlite here —
        // this is the unified rerank primitive used by hybrid + pack, so
        // verifying it in isolation keeps the contract honest.
        #[derive(Clone, Debug, PartialEq)]
        struct Item {
            id: String,
        }
        let cands = vec![
            Item { id: "a".into() }, // close to query
            Item { id: "b".into() }, // farther
            Item { id: "c".into() }, // no embedding → must sort last
        ];
        let mut embeddings: HashMap<String, Vec<f32>> = HashMap::new();
        embeddings.insert("a".into(), vec![1.0, 0.0, 0.0]);
        embeddings.insert("b".into(), vec![0.1, 0.9, 0.0]);
        // "c" deliberately absent.

        let q = vec![1.0_f32, 0.0, 0.0];
        let ranked = rerank_by_id(&q, cands, &embeddings, 10, |i| i.id.clone());
        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked[0].id, "a"); // most similar
        assert_eq!(ranked[1].id, "b");
        assert_eq!(ranked[2].id, "c"); // embedding-less tail
    }

    #[test]
    fn rerank_by_id_truncates_to_limit() {
        #[derive(Clone)]
        struct Item {
            id: String,
        }
        let cands: Vec<Item> = (0..5).map(|n| Item { id: format!("i{n}") }).collect();
        let mut embeddings: HashMap<String, Vec<f32>> = HashMap::new();
        for n in 0..5 {
            // Progressively less similar to [1,0,0].
            let v = vec![1.0 - n as f32 * 0.1, n as f32 * 0.1, 0.0];
            embeddings.insert(format!("i{n}"), v);
        }
        let q = vec![1.0_f32, 0.0, 0.0];
        let ranked = rerank_by_id(&q, cands, &embeddings, 2, |i| i.id.clone());
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].id, "i0");
    }
}
