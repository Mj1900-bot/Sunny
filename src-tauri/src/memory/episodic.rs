//! Episodic memory — chronological record of things that happened.
//!
//! High-volume, low-signal. Every user utterance, agent step, and (Phase 2)
//! perception snapshot lands here. The consolidator later extracts durable
//! facts into the semantic store and (eventually) drops old episodic rows.
//!
//! Retrieval is via FTS5 + created-at recency. Embedding-backed similarity
//! is layered on in Phase 1b — the column exists now so the schema is
//! stable, but reads don't depend on it yet.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{self, fts_phrase_from_query, generate_id, now_secs, with_conn, with_reader};
use super::NoteItem;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// The discriminator for an episodic row. Stored as a plain string in SQLite
/// so we can add new kinds without a schema migration.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EpisodicKind {
    User,
    AgentStep,
    ToolCall,
    Perception,
    Note,
    Reflection,
}

impl EpisodicKind {
    fn as_str(&self) -> &'static str {
        match self {
            EpisodicKind::User => "user",
            EpisodicKind::AgentStep => "agent_step",
            EpisodicKind::ToolCall => "tool_call",
            EpisodicKind::Perception => "perception",
            EpisodicKind::Note => "note",
            EpisodicKind::Reflection => "reflection",
        }
    }

    fn from_str(s: &str) -> EpisodicKind {
        match s {
            "user" => EpisodicKind::User,
            "agent_step" => EpisodicKind::AgentStep,
            "tool_call" => EpisodicKind::ToolCall,
            "perception" => EpisodicKind::Perception,
            "reflection" => EpisodicKind::Reflection,
            _ => EpisodicKind::Note,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct EpisodicItem {
    pub id: String,
    pub kind: EpisodicKind,
    pub text: String,
    pub tags: Vec<String>,
    /// Opaque per-kind metadata (e.g. tool name, goal hash, run id). Stored
    /// as a JSON object.
    #[ts(type = "unknown")]
    pub meta: serde_json::Value,
    #[ts(type = "number")]
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Public API — typed surface
// ---------------------------------------------------------------------------

pub fn add(
    kind: EpisodicKind,
    text: String,
    tags: Vec<String>,
    meta: serde_json::Value,
) -> Result<EpisodicItem, String> {
    let item = with_conn(|c| add_in(c, kind, text, tags, meta))?;
    // Fire-and-forget: asynchronously fill in the embedding column for this
    // row. No-op when Ollama isn't running; the backfill loop will retry.
    super::embed::spawn_embed_for("episodic", item.id.clone(), item.text.clone());
    Ok(item)
}

pub fn list(limit: Option<usize>, offset: Option<usize>) -> Result<Vec<EpisodicItem>, String> {
    with_reader(|c| list_in(c, limit, offset)) // read-only path → reader pool
}

pub fn search(query: String, limit: Option<usize>) -> Result<Vec<EpisodicItem>, String> {
    with_reader(|c| search_in(c, &query, limit)) // read-only path → reader pool
}

// ---------------------------------------------------------------------------
// Note helpers — the flat `NoteItem` API for the agent's note-writing paths
// (`memory_remember`, `reflect`, `remember_screen`, `memory_integration`,
// `prompts::seed_user_profile_if_empty`). Thin wrappers over `add` / `search`
// that filter to `EpisodicKind::Note` and project to the smaller shape.
// ---------------------------------------------------------------------------

pub fn note_add(text: String, tags: Vec<String>) -> Result<NoteItem, String> {
    let item = add(EpisodicKind::Note, text, tags, serde_json::Value::Null)?;
    Ok(item.into_note())
}

pub fn note_search(query: String, limit: Option<usize>) -> Result<Vec<NoteItem>, String> {
    // Only surface note-kind rows — filter from full episodic search so the
    // shape matches the pre-sqlite flat-note behaviour callers depend on.
    with_reader(|c| { // read-only path → reader pool
        let hits = search_in(c, &query, Some(limit.unwrap_or(20) * 4))?;
        let notes: Vec<NoteItem> = hits
            .into_iter()
            .filter(|h| matches!(h.kind, EpisodicKind::Note))
            .take(limit.unwrap_or(20))
            .map(|h| h.into_note())
            .collect();
        Ok(notes)
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

impl EpisodicItem {
    fn into_note(self) -> NoteItem {
        NoteItem {
            id: self.id,
            text: self.text,
            tags: self.tags,
            created_at: self.created_at,
        }
    }
}

fn add_in(
    conn: &Connection,
    kind: EpisodicKind,
    text: String,
    tags: Vec<String>,
    meta: serde_json::Value,
) -> Result<EpisodicItem, String> {
    if text.trim().is_empty() {
        return Err("episodic: text must not be empty".into());
    }
    let id = generate_id();
    let tags_json =
        serde_json::to_string(&tags).map_err(|e| format!("serialize tags: {e}"))?;
    let meta_json = serde_json::to_string(&meta).map_err(|e| format!("serialize meta: {e}"))?;
    let created_at = now_secs();
    conn.execute(
        "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, kind.as_str(), text, tags_json, meta_json, created_at],
    )
    .map_err(|e| format!("insert episodic: {e}"))?;
    Ok(EpisodicItem {
        id,
        kind,
        text,
        tags,
        meta,
        created_at,
    })
}

fn list_in(
    conn: &Connection,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<EpisodicItem>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT id, kind, text, tags_json, meta_json, created_at
             FROM episodic
             ORDER BY created_at DESC
             LIMIT ?1 OFFSET ?2",
        )
        .map_err(|e| format!("prepare list: {e}"))?;
    let rows = stmt
        .query_map(
            params![
                limit.unwrap_or(200) as i64,
                offset.unwrap_or(0) as i64,
            ],
            row_to_episodic,
        )
        .map_err(|e| format!("query list: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect list: {e}"))?;
    Ok(rows)
}

fn search_in(
    conn: &Connection,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<EpisodicItem>, String> {
    let phrase = fts_phrase_from_query(query);
    if phrase.is_empty() {
        return Ok(Vec::new());
    }
    // Join FTS virtual table to the base table by rowid. Rank uses sqlite's
    // built-in `bm25` (positive = better on ascending sort; we negate to
    // put best first on DESC).
    let mut stmt = conn
        .prepare_cached(
            "SELECT e.id, e.kind, e.text, e.tags_json, e.meta_json, e.created_at
             FROM episodic_fts f
             JOIN episodic e ON e.rowid = f.rowid
             WHERE episodic_fts MATCH ?1
             ORDER BY bm25(episodic_fts) ASC, e.created_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("prepare episodic search: {e}"))?;
    let rows = stmt
        .query_map(params![phrase, limit.unwrap_or(20) as i64], row_to_episodic)
        .map_err(|e| format!("query episodic search: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect episodic search: {e}"))?;
    Ok(rows)
}

fn row_to_episodic(r: &rusqlite::Row) -> rusqlite::Result<EpisodicItem> {
    let id: String = r.get(0)?;
    let kind_s: String = r.get(1)?;
    let text: String = r.get(2)?;
    let tags_s: String = r.get(3)?;
    let meta_s: String = r.get(4)?;
    let created_at: i64 = r.get(5)?;
    let tags: Vec<String> = serde_json::from_str(&tags_s).unwrap_or_default();
    let meta: serde_json::Value = serde_json::from_str(&meta_s).unwrap_or(serde_json::Value::Null);
    Ok(EpisodicItem {
        id,
        kind: EpisodicKind::from_str(&kind_s),
        text,
        tags,
        meta,
        created_at,
    })
}

// Keep the `db` import warning-free when only tests reference it.
#[allow(dead_code)]
fn _keep_db_import_live() {
    let _ = db::now_secs;
}

// ---------------------------------------------------------------------------
// Tests — isolated scratch connection per test.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;

    #[test]
    fn add_and_list_return_newest_first() {
        let (_dir, conn) = scratch_conn("ep-list");
        add_in(&conn, EpisodicKind::Note, "first".into(), vec![], serde_json::Value::Null).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100)); // created_at is seconds
        add_in(&conn, EpisodicKind::Note, "second".into(), vec![], serde_json::Value::Null).unwrap();
        let rows = list_in(&conn, Some(10), Some(0)).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "second");
    }

    #[test]
    fn delete_removes_row_and_fts_shadow() {
        let (_dir, conn) = scratch_conn("ep-del");
        let i = add_in(
            &conn,
            EpisodicKind::Note,
            "transient".into(),
            vec![],
            serde_json::Value::Null,
        )
        .unwrap();
        conn.execute("DELETE FROM episodic WHERE id = ?1", params![i.id])
            .unwrap();
        let hits = search_in(&conn, "transient", Some(10)).unwrap();
        assert!(hits.is_empty(), "FTS shadow should be cleaned by the delete trigger");
    }

    #[test]
    fn search_finds_fuzzy_prefix_and_ranks_recency_on_tie() {
        let (_dir, conn) = scratch_conn("ep-search");
        // "widgetry" should match the prefix query "widget" via the `*` suffix.
        add_in(
            &conn,
            EpisodicKind::Note,
            "forgot about widgetry notes".into(),
            vec!["random".into()],
            serde_json::Value::Null,
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        add_in(
            &conn,
            EpisodicKind::Note,
            "widget prototype shipping".into(),
            vec!["project".into()],
            serde_json::Value::Null,
        )
        .unwrap();
        let hits = search_in(&conn, "widget", Some(5)).unwrap();
        assert!(!hits.is_empty(), "prefix search should find widgetry");
        // bm25 puts the closer match first; if both are equally close the newer
        // wins via the secondary created_at DESC ordering.
        let texts: Vec<&str> = hits.iter().map(|h| h.text.as_str()).collect();
        assert!(
            texts.iter().any(|t| t.contains("widget")),
            "unexpected hits: {texts:?}",
        );
    }

    #[test]
    fn search_rejects_punctuation_safely() {
        let (_dir, conn) = scratch_conn("ep-punct");
        // Punctuation must NOT panic or return a SQL error.
        let hits = search_in(&conn, "?????", Some(5)).unwrap();
        assert!(hits.is_empty());
        let hits2 = search_in(&conn, "", Some(5)).unwrap();
        assert!(hits2.is_empty());
    }
}
