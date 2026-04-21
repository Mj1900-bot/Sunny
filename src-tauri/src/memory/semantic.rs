//! Semantic memory — curated, durable facts.
//!
//! Lower volume, higher signal than episodic. Facts have a `subject` for
//! ontology-like queries ("everything about Mom"), a `confidence` so the
//! consolidator can write tentative inferences without polluting user-added
//! ground truth, and a `source` label so we know where each fact came from.
//!
//! Writes are atomic; existing facts with the same `(subject, text)` pair
//! are updated in place (confidence max, updated_at bumped) rather than
//! duplicated — so the consolidator can re-assert facts idempotently.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{fts_phrase_from_query, generate_id, now_secs, with_conn, with_reader};

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct SemanticFact {
    pub id: String,
    /// Ontology key — "user.name", "contact.mom", "project.sunny". Empty
    /// string when no natural subject.
    pub subject: String,
    pub text: String,
    pub tags: Vec<String>,
    /// 0.0–1.0. 1.0 = user-asserted, lower = inferred by the consolidator.
    pub confidence: f64,
    /// Free-form provenance tag: "user" | "consolidator" | "skill" | …
    pub source: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

pub fn add_fact(
    subject: String,
    text: String,
    tags: Vec<String>,
    confidence: Option<f64>,
    source: Option<String>,
) -> Result<SemanticFact, String> {
    let fact = with_conn(|c| add_in(c, subject, text, tags, confidence, source))?;
    // Embed the combined subject + text so subject-scoped queries ("mom")
    // rank the right facts even when the raw text doesn't mention them.
    let embed_text = if fact.subject.is_empty() {
        fact.text.clone()
    } else {
        format!("{}: {}", fact.subject, fact.text)
    };
    super::embed::spawn_embed_for("semantic", fact.id.clone(), embed_text);
    Ok(fact)
}

pub fn list_facts(
    subject: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<SemanticFact>, String> {
    with_reader(|c| list_in(c, subject, limit, offset)) // read-only path → reader pool
}

/// List facts with "pinned" core-identity facts guaranteed in the top-K.
///
/// Motivation: `list_facts` returns rows in strict recency order. On a
/// long-running user, recent chatter can shove core identity facts like
/// `user.name` and `user.location` off the first 8 slots — exactly the
/// moment the memory digest needs them most.
///
/// Strategy: reserve half of `limit` for `subject LIKE 'user.%'` rows
/// (still ordered by recency among themselves), then fill the remaining
/// slots with the most-recent non-user.* facts. De-duplicated, merged,
/// and re-sorted by `updated_at DESC` to preserve a stable read order.
pub fn list_facts_pinned_first(limit: usize) -> Result<Vec<SemanticFact>, String> {
    with_reader(|c| list_pinned_in(c, limit)) // read-only path → reader pool
}

pub fn search_facts(query: String, limit: Option<usize>) -> Result<Vec<SemanticFact>, String> {
    with_reader(|c| search_in(c, &query, limit)) // read-only path → reader pool
}

pub fn delete_fact(id: String) -> Result<(), String> {
    with_conn(|c| {
        c.execute("DELETE FROM semantic WHERE id = ?1", params![id])
            .map_err(|e| format!("delete semantic: {e}"))?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn add_in(
    conn: &Connection,
    subject: String,
    text: String,
    tags: Vec<String>,
    confidence: Option<f64>,
    source: Option<String>,
) -> Result<SemanticFact, String> {
    if text.trim().is_empty() {
        return Err("semantic: text must not be empty".into());
    }
    let confidence = confidence.unwrap_or(1.0).clamp(0.0, 1.0);
    let source = source.unwrap_or_else(|| "user".to_string());
    let now = now_secs();
    let tags_json =
        serde_json::to_string(&tags).map_err(|e| format!("serialize tags: {e}"))?;

    // Idempotent upsert on (subject, text): keep the higher confidence,
    // refresh updated_at and source.
    let existing: Option<(String, f64, i64)> = conn
        .query_row(
            "SELECT id, confidence, created_at FROM semantic
             WHERE subject = ?1 AND text = ?2",
            params![subject, text],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    if let Some((id, prev_conf, created_at)) = existing {
        let new_conf = prev_conf.max(confidence);
        conn.execute(
            "UPDATE semantic
             SET tags_json = ?1,
                 confidence = ?2,
                 source = ?3,
                 updated_at = ?4
             WHERE id = ?5",
            params![tags_json, new_conf, source, now, id],
        )
        .map_err(|e| format!("update semantic: {e}"))?;
        return Ok(SemanticFact {
            id,
            subject,
            text,
            tags,
            confidence: new_conf,
            source,
            created_at,
            updated_at: now,
        });
    }

    let id = generate_id();
    conn.execute(
        "INSERT INTO semantic
            (id, subject, text, tags_json, confidence, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, subject, text, tags_json, confidence, source, now],
    )
    .map_err(|e| format!("insert semantic: {e}"))?;
    Ok(SemanticFact {
        id,
        subject,
        text,
        tags,
        confidence,
        source,
        created_at: now,
        updated_at: now,
    })
}

fn list_in(
    conn: &Connection,
    subject: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<SemanticFact>, String> {
    let lim = limit.unwrap_or(200) as i64;
    let off = offset.unwrap_or(0) as i64;
    if let Some(s) = subject {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, subject, text, tags_json, confidence, source, created_at, updated_at
                 FROM semantic
                 WHERE subject = ?1
                   AND deleted_at IS NULL
                 ORDER BY updated_at DESC
                 LIMIT ?2 OFFSET ?3",
            )
            .map_err(|e| format!("prepare semantic list: {e}"))?;
        let rows = stmt
            .query_map(params![s, lim, off], row_to_fact)
            .map_err(|e| format!("query semantic list: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect semantic list: {e}"))?;
        Ok(rows)
    } else {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, subject, text, tags_json, confidence, source, created_at, updated_at
                 FROM semantic
                 WHERE deleted_at IS NULL
                 ORDER BY updated_at DESC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| format!("prepare semantic list all: {e}"))?;
        let rows = stmt
            .query_map(params![lim, off], row_to_fact)
            .map_err(|e| format!("query semantic list all: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect semantic list all: {e}"))?;
        Ok(rows)
    }
}

fn list_pinned_in(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<SemanticFact>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    // Split the budget: half for pinned (user.*) facts, rest for recency.
    // `max(1)` guarantees pinned facts get at least one slot even when
    // `limit == 1`, since the whole point of this function is to protect
    // identity facts from recency eviction. If the pinned query returns
    // fewer rows than its share, we backfill the leftover slots with
    // additional recency rows below — the total always sums to `limit`
    // when enough non-pinned rows exist.
    let pinned_budget = (limit / 2).max(1);

    // 1) Pull pinned (user.*) facts, most-recent first.
    let mut stmt_pinned = conn
        .prepare_cached(
            "SELECT id, subject, text, tags_json, confidence, source, created_at, updated_at
             FROM semantic
             WHERE subject LIKE 'user.%'
               AND deleted_at IS NULL
             ORDER BY updated_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare semantic list pinned (user.*): {e}"))?;
    let pinned: Vec<SemanticFact> = stmt_pinned
        .query_map(params![pinned_budget as i64], row_to_fact)
        .map_err(|e| format!("query semantic list pinned (user.*): {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect semantic list pinned (user.*): {e}"))?;

    // 2) Backfill with recency rows. Ask for enough to fill the FULL limit
    //    in case pinned under-delivered — we'll truncate after the merge.
    //    This makes the function degrade gracefully on new users who have
    //    zero user.* facts yet.
    let recency_needed = limit
        .saturating_sub(pinned.len())
        .max(limit.saturating_sub(pinned_budget));
    let mut stmt_recent = conn
        .prepare_cached(
            "SELECT id, subject, text, tags_json, confidence, source, created_at, updated_at
             FROM semantic
             WHERE subject NOT LIKE 'user.%'
               AND deleted_at IS NULL
             ORDER BY updated_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("prepare semantic list pinned (recency): {e}"))?;
    let recency: Vec<SemanticFact> = stmt_recent
        .query_map(params![recency_needed as i64], row_to_fact)
        .map_err(|e| format!("query semantic list pinned (recency): {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect semantic list pinned (recency): {e}"))?;

    // 3) Merge + re-sort by updated_at DESC for a stable consumer-facing
    //    order, then truncate to `limit`. Build a fresh Vec rather than
    //    mutating inputs — keeps the data flow immutable.
    let mut merged: Vec<SemanticFact> = pinned
        .into_iter()
        .chain(recency.into_iter())
        .collect();
    merged.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    merged.truncate(limit);
    Ok(merged)
}

fn search_in(
    conn: &Connection,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<SemanticFact>, String> {
    let phrase = fts_phrase_from_query(query);
    if phrase.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT s.id, s.subject, s.text, s.tags_json, s.confidence, s.source,
                    s.created_at, s.updated_at
             FROM semantic_fts f
             JOIN semantic s ON s.rowid = f.rowid
             WHERE semantic_fts MATCH ?1
               AND s.deleted_at IS NULL
             ORDER BY bm25(semantic_fts) ASC, s.confidence DESC, s.updated_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare semantic search: {e}"))?;
    let rows = stmt
        .query_map(params![phrase, limit.unwrap_or(20) as i64], row_to_fact)
        .map_err(|e| format!("query semantic search: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect semantic search: {e}"))?;
    Ok(rows)
}

fn row_to_fact(r: &rusqlite::Row) -> rusqlite::Result<SemanticFact> {
    let id: String = r.get(0)?;
    let subject: String = r.get(1)?;
    let text: String = r.get(2)?;
    let tags_s: String = r.get(3)?;
    let confidence: f64 = r.get(4)?;
    let source: String = r.get(5)?;
    let created_at: i64 = r.get(6)?;
    let updated_at: i64 = r.get(7)?;
    let tags: Vec<String> = serde_json::from_str(&tags_s).unwrap_or_default();
    Ok(SemanticFact {
        id,
        subject,
        text,
        tags,
        confidence,
        source,
        created_at,
        updated_at,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;

    #[test]
    fn adding_twice_idempotent_on_subject_text() {
        let (_dir, conn) = scratch_conn("sem-upsert");
        let a = add_in(
            &conn,
            "contact.mom".into(),
            "Mom's birthday is March 12".into(),
            vec!["family".into()],
            Some(0.8),
            Some("consolidator".into()),
        )
        .unwrap();
        let b = add_in(
            &conn,
            "contact.mom".into(),
            "Mom's birthday is March 12".into(),
            vec!["family".into()],
            Some(1.0),
            Some("user".into()),
        )
        .unwrap();
        assert_eq!(a.id, b.id, "idempotent upsert should reuse the id");
        assert_eq!(b.confidence, 1.0, "confidence should raise on upsert");
        assert_eq!(b.source, "user");
    }

    #[test]
    fn list_filters_by_subject_and_ranks_by_updated_at() {
        let (_dir, conn) = scratch_conn("sem-list");
        add_in(&conn, "project.sunny".into(), "Rust+React".into(), vec![], None, None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        add_in(&conn, "project.sunny".into(), "Tauri 2".into(), vec![], None, None).unwrap();
        add_in(&conn, "contact.mom".into(), "Vancouver".into(), vec![], None, None).unwrap();
        let rows = list_in(&conn, Some("project.sunny".into()), Some(10), Some(0)).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "Tauri 2");
    }

    #[test]
    fn pinned_user_facts_survive_recency_flood() {
        let (_dir, conn) = scratch_conn("sem-pinned");
        // Insert the two core identity facts FIRST so that under strict
        // recency order they'd normally be the *oldest* rows in the DB.
        add_in(
            &conn,
            "user.name".into(),
            "Sunny".into(),
            vec![],
            None,
            None,
        )
        .unwrap();
        add_in(
            &conn,
            "user.location".into(),
            "Vancouver BC".into(),
            vec![],
            None,
            None,
        )
        .unwrap();
        // Sleep so subsequent updated_at values are strictly greater than
        // the user.* rows — now.secs() has 1-second granularity.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // Flood 20 non-user.* facts with newer updated_at.
        for i in 0..20 {
            add_in(
                &conn,
                format!("note.{i}"),
                format!("random fact {i}"),
                vec![],
                None,
                None,
            )
            .unwrap();
        }

        // Sanity: strict recency would evict both user.* rows from top-8.
        let recency_only = list_in(&conn, None, Some(8), Some(0)).unwrap();
        assert_eq!(recency_only.len(), 8);
        assert!(
            !recency_only.iter().any(|f| f.subject.starts_with("user.")),
            "baseline list_in should NOT contain user.* facts under recency flood"
        );

        // list_pinned_in must surface both user.* facts within the top-8.
        let pinned = list_pinned_in(&conn, 8).unwrap();
        assert_eq!(pinned.len(), 8);
        let subjects: Vec<&str> = pinned.iter().map(|f| f.subject.as_str()).collect();
        assert!(
            subjects.contains(&"user.name"),
            "expected user.name in pinned top-8, got {subjects:?}"
        );
        assert!(
            subjects.contains(&"user.location"),
            "expected user.location in pinned top-8, got {subjects:?}"
        );
    }

    #[test]
    fn search_scores_subject_and_text_hits() {
        let (_dir, conn) = scratch_conn("sem-search");
        add_in(&conn, "project.sunny".into(), "Runs on Tauri 2".into(), vec![], None, None).unwrap();
        add_in(&conn, "".into(), "Tauri is a Rust framework".into(), vec![], None, None).unwrap();
        let hits = search_in(&conn, "tauri", Some(10)).unwrap();
        assert_eq!(hits.len(), 2);
    }
}
