//! Cross-session continuity graph — Obsidian-inspired knowledge graph for Sunny.
//!
//! Stores nodes (sessions, decisions, projects, people, …) and the edges between
//! them in a dedicated SQLite file (`~/.sunny/continuity.db`).  Writing IS graph
//! construction: `[[slug]]` wikilinks in summary text are auto-extracted into
//! `graph_edges` rows on every `upsert_node` call — no separate edge form.
//!
//! # Quick-start
//! ```rust,no_run
//! let store = ContinuityStore::open(path)?;
//! store.upsert_node(NodeKind::Session, "session-2026-04-20-1", "Morning session",
//!     "Worked on [[project-sunny-moc]]. See [[2026-04-20]] daily note.", &[])?;
//! let backlinkers = store.backlinks_of("project-sunny-moc")?; // pure SQL
//! ```
//!
//! # Module layout
//! - `schema`    — DDL, migration, `now_secs()`
//! - `wikilinks` — pure `extract(text) -> Vec<String>`
//! - `moc`       — MOC (Map of Content) auto-generation
//! - `mod` (this file) — `ContinuityStore` public API

pub mod schema;
pub mod wikilinks;
pub mod moc;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use schema::{ensure_schema, now_secs, DB_FILENAME};


use once_cell::sync::OnceCell;
use std::sync::Arc;

/// Process-wide continuity store singleton, opened lazily at first use.
/// `~/.sunny/continuity.db` — same directory convention as `memory.sqlite`.
/// Public for test injection — do not set from production code outside this module.
pub static CONTINUITY_GLOBAL: OnceCell<Arc<Mutex<ContinuityStore>>> = OnceCell::new();

/// Return the process-wide `ContinuityStore`, opening it on first call.
///
/// Opening the DB is fast (WAL already established on a prior run); any error
/// is logged and a locked-but-empty stand-in is NOT returned — callers must
/// handle `None` gracefully.  Returns `None` only when the home directory is
/// unavailable or the DB file cannot be created (both are fatal
/// misconfigurations, not transient failures, so we log once and stay dark).
pub fn global() -> Option<Arc<Mutex<ContinuityStore>>> {
    CONTINUITY_GLOBAL
        .get_or_try_init(|| -> Result<Arc<Mutex<ContinuityStore>>, String> {
            let home = dirs::home_dir()
                .ok_or_else(|| "$HOME not set — cannot open continuity store".to_string())?;
            let dir = home.join(".sunny");
            let store = ContinuityStore::open(&dir)?;
            Ok(Arc::new(Mutex::new(store)))
        })
        .ok()
        .cloned()
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/// The kind of a continuity graph node.
///
/// Used for template bodies, icon rendering, and MOC filtering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NodeKind {
    Session,
    Thread,
    Decision,
    Project,
    Person,
    Artifact,
    DailyNote,
    Moc,
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeKind::Session   => "Session",
            NodeKind::Thread    => "Thread",
            NodeKind::Decision  => "Decision",
            NodeKind::Project   => "Project",
            NodeKind::Person    => "Person",
            NodeKind::Artifact  => "Artifact",
            NodeKind::DailyNote => "DailyNote",
            NodeKind::Moc       => "Moc",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "Session"   => NodeKind::Session,
            "Thread"    => NodeKind::Thread,
            "Decision"  => NodeKind::Decision,
            "Project"   => NodeKind::Project,
            "Person"    => NodeKind::Person,
            "Artifact"  => NodeKind::Artifact,
            "DailyNote" => NodeKind::DailyNote,
            "Moc"       => NodeKind::Moc,
            _           => NodeKind::Thread, // safe default
        }
    }

    /// Per-kind template body pre-filled into `summary` on first creation.
    pub fn template_body(&self) -> &'static str {
        match self {
            NodeKind::Session =>
                "## Session summary\n\n## Key decisions\n\n## Open questions\n\n## Links\n",
            NodeKind::Thread =>
                "## Context\n\n## Progress\n\n## Blockers\n\n## Links\n",
            NodeKind::Decision =>
                "## Decision\n\n## Rationale\n\n## Alternatives\n\n## Tags\n#decision\n",
            NodeKind::Project =>
                "## Goal\n\n## Status\n\n## Key nodes\n\n## Tags\n",
            NodeKind::Person =>
                "## Role\n\n## Contact\n\n## Notes\n",
            NodeKind::Artifact =>
                "## Description\n\n## Location\n\n## References\n",
            NodeKind::DailyNote =>
                "## Sessions\n\n## Decisions\n\n## Open questions\n\n## Notes\n",
            NodeKind::Moc =>
                "## Index\n\n_Auto-generated — do not edit manually._\n",
        }
    }
}

/// A continuity graph node (immutable value type).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub slug:       String,
    pub kind:       NodeKind,
    pub title:      String,
    pub summary:    String,
    pub tags:       Vec<String>,
    pub created_ts: i64,
    pub updated_ts: i64,
    pub deleted_at: Option<i64>,
}

/// A directed edge between two nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub from:      String,  // subject_slug
    pub to:        String,  // object_slug
    pub predicate: String,
    pub weight:    f64,
}

/// A lightweight node descriptor for graph-view rendering.
/// `backlink_count` drives the node radius in the React canvas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub slug:           String,
    pub title:          String,
    pub backlink_count: usize,
    pub tags:           Vec<String>,
}

// ---------------------------------------------------------------------------
// ContinuityStore
// ---------------------------------------------------------------------------

/// Thread-safe handle to the continuity graph database.
///
/// Internally wraps a `Mutex<Connection>` so callers can clone the `Arc`
/// wrapper (if needed) or pass `&ContinuityStore` across threads.  Every
/// public method locks, runs its SQL, and drops the guard immediately.
pub struct ContinuityStore {
    conn: Mutex<Connection>,
    /// Directory that contains the DB file — kept for tests.
    #[allow(dead_code)]
    dir:  PathBuf,
}

impl ContinuityStore {
    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// Open (or create) the continuity database at `dir/continuity.db`.
    ///
    /// Enables WAL mode, applies schema migrations, and returns a ready store.
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("create continuity dir {}: {e}", dir.display()))?;

        let path = dir.join(DB_FILENAME);
        let conn = Connection::open(&path)
            .map_err(|e| format!("open continuity db {}: {e}", path.display()))?;

        // WAL + moderate durability — same settings as memory.sqlite.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("continuity WAL: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("continuity synchronous: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("continuity fks: {e}"))?;

        ensure_schema(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            dir:  dir.to_path_buf(),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "continuity db mutex poisoned".to_string())
    }

    // -----------------------------------------------------------------------
    // Node writes
    // -----------------------------------------------------------------------

    /// Upsert a node and auto-extract `[[slug]]` wikilinks from `summary`
    /// into `graph_edges`.
    ///
    /// If the node is new, `summary` is pre-filled with the kind's template
    /// body when the caller passes an empty string.  On update, the caller's
    /// summary is used verbatim.
    ///
    /// Tags in `tags` are stored as a JSON array.  Pass `&[]` to preserve
    /// existing tags on update; the current implementation always overwrites.
    pub fn upsert_node(
        &self,
        kind:    NodeKind,
        slug:    &str,
        title:   &str,
        summary: &str,
        tags:    &[&str],
    ) -> Result<(), String> {
        let conn = self.lock()?;
        let ts   = now_secs();

        // If caller passed empty summary, seed from template.
        let effective_summary = if summary.is_empty() {
            kind.template_body().to_string()
        } else {
            summary.to_string()
        };

        let tags_json = serde_json::to_string(tags)
            .unwrap_or_else(|_| "[]".to_string());

        conn.execute(
            r#"INSERT INTO nodes (slug, kind, title, summary, tags, created_ts, updated_ts)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(slug) DO UPDATE SET
                   kind       = excluded.kind,
                   title      = excluded.title,
                   summary    = excluded.summary,
                   tags       = excluded.tags,
                   updated_ts = excluded.updated_ts,
                   deleted_at = NULL"#,
            params![slug, kind.as_str(), title, effective_summary, tags_json, ts, ts],
        )
        .map_err(|e| format!("upsert node '{slug}': {e}"))?;

        // Auto-extract wikilinks → edges.
        let targets = wikilinks::extract(&effective_summary);
        for target in &targets {
            if target == slug {
                continue; // skip self-references
            }
            // Ensure the target node exists (stub) so the FK is satisfied.
            conn.execute(
                r#"INSERT OR IGNORE INTO nodes
                   (slug, kind, title, summary, tags, created_ts, updated_ts)
                   VALUES (?1, 'Thread', ?1, '', '[]', ?2, ?2)"#,
                params![target, ts],
            )
            .map_err(|e| format!("stub node '{target}': {e}"))?;

            // Upsert the edge — increment weight on duplicate reference.
            conn.execute(
                r#"INSERT INTO graph_edges (subject_slug, predicate, object_slug, weight, created_ts)
                   VALUES (?1, 'links_to', ?2, 1.0, ?3)
                   ON CONFLICT(subject_slug, predicate, object_slug)
                   DO UPDATE SET weight = weight + 1.0"#,
                params![slug, target, ts],
            )
            .map_err(|e| format!("upsert edge {slug}->{target}: {e}"))?;
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Node reads
    // -----------------------------------------------------------------------

    /// Return the last `n` non-deleted nodes ordered by `updated_ts` DESC.
    pub fn recent_context(&self, n: usize) -> Result<Vec<Node>, String> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare(
                "SELECT slug, kind, title, summary, tags, created_ts, updated_ts, deleted_at
                 FROM nodes
                 WHERE deleted_at IS NULL
                 ORDER BY updated_ts DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("recent_context prepare: {e}"))?;

        let rows = stmt
            .query_map(params![n as i64], row_to_node)
            .map_err(|e| format!("recent_context query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Compute backlinks for `slug` via FTS5 LIKE on the summary column.
    ///
    /// Returns slugs of all non-deleted nodes whose summary contains
    /// `[[slug]]`.  This is the Obsidian pattern: backlinks are derived at
    /// read time, not stored.
    pub fn backlinks_of(&self, slug: &str) -> Result<Vec<String>, String> {
        let conn = self.lock()?;
        let pattern = format!("%[[{slug}]]%");
        let mut stmt = conn
            .prepare(
                "SELECT slug FROM nodes
                 WHERE summary LIKE ?1
                   AND deleted_at IS NULL
                   AND slug != ?2
                 ORDER BY updated_ts DESC",
            )
            .map_err(|e| format!("backlinks_of prepare: {e}"))?;

        let rows = stmt
            .query_map(params![pattern, slug], |r| r.get(0))
            .map_err(|e| format!("backlinks_of query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    /// Return all non-deleted nodes and all edges for the frontend graph view.
    ///
    /// `GraphNode.backlink_count` is computed inline via a subquery so the
    /// caller gets size hints without an additional round-trip.
    pub fn graph_view(&self) -> Result<(Vec<GraphNode>, Vec<Edge>), String> {
        let conn = self.lock()?;

        // Nodes with backlink count.
        let mut nstmt = conn
            .prepare(
                r#"SELECT n.slug, n.title, n.tags,
                          (SELECT count(*) FROM graph_edges e
                           WHERE e.object_slug = n.slug) AS bl
                   FROM nodes n
                   WHERE n.deleted_at IS NULL
                   ORDER BY n.updated_ts DESC"#,
            )
            .map_err(|e| format!("graph_view nodes prepare: {e}"))?;

        let nodes: Vec<GraphNode> = nstmt
            .query_map([], |r| {
                let tags_json: String = r.get(2)?;
                let bl: i64 = r.get(3)?;
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, tags_json, bl))
            })
            .map_err(|e| format!("graph_view nodes query: {e}"))?
            .filter_map(|r| r.ok())
            .map(|(slug, title, tags_json, bl)| {
                let tags = parse_tags(&tags_json);
                GraphNode { slug, title, backlink_count: bl as usize, tags }
            })
            .collect();

        // Edges between non-deleted nodes only.
        let mut estmt = conn
            .prepare(
                r#"SELECT e.subject_slug, e.object_slug, e.predicate, e.weight
                   FROM graph_edges e
                   JOIN nodes sn ON sn.slug = e.subject_slug AND sn.deleted_at IS NULL
                   JOIN nodes tn ON tn.slug = e.object_slug  AND tn.deleted_at IS NULL"#,
            )
            .map_err(|e| format!("graph_view edges prepare: {e}"))?;

        let edges: Vec<Edge> = estmt
            .query_map([], |r| {
                Ok(Edge {
                    from:      r.get(0)?,
                    to:        r.get(1)?,
                    predicate: r.get(2)?,
                    weight:    r.get(3)?,
                })
            })
            .map_err(|e| format!("graph_view edges query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok((nodes, edges))
    }

    // -----------------------------------------------------------------------
    // Daily notes
    // -----------------------------------------------------------------------

    /// Return the slug for `date` (format `YYYY-MM-DD`).
    ///
    /// Creates the daily note node if it doesn't already exist.
    /// Idempotent — safe to call multiple times per day.
    pub fn daily_note_slug(&self, date: &str) -> Result<String, String> {
        let slug  = date.to_string(); // "2026-04-20" is already a valid slug
        let title = format!("Daily Note \u{2014} {date}");

        let conn = self.lock()?;
        let ts   = now_secs();

        // Use serde_json to build the tags array so we never embed a raw `#`
        // inside a raw-string delimiter (which would terminate it early).
        let daily_tags_json = serde_json::json!(["#daily-note"]).to_string();

        conn.execute(
            "INSERT OR IGNORE INTO nodes              (slug, kind, title, summary, tags, created_ts, updated_ts)              VALUES (?1, 'DailyNote', ?2, ?3, ?4, ?5, ?6)",
            params![slug, title, NodeKind::DailyNote.template_body(), daily_tags_json, ts, ts],
        )
        .map_err(|e| format!("daily_note_slug insert: {e}"))?;

        Ok(slug)
    }

    // -----------------------------------------------------------------------
    // MOC
    // -----------------------------------------------------------------------

    /// Regenerate the MOC node for `project_slug` and return it.
    pub fn project_moc(&self, project_slug: &str) -> Result<Node, String> {
        let conn = self.lock()?;
        moc::regenerate(&conn, project_slug)
    }

    // -----------------------------------------------------------------------
    // Tag search
    // -----------------------------------------------------------------------

    /// Return all non-deleted nodes whose `tags` JSON array contains `tag`.
    ///
    /// Uses a LIKE query against the JSON column — efficient enough for
    /// thousands of nodes; an expression index on `tags` keeps it fast at scale.
    pub fn tag_search(&self, tag: &str) -> Result<Vec<Node>, String> {
        let conn = self.lock()?;
        // JSON array stored as '["#decision","#blocker"]' — LIKE match on tag.
        let pattern = format!("%{tag}%");
        let mut stmt = conn
            .prepare(
                "SELECT slug, kind, title, summary, tags, created_ts, updated_ts, deleted_at
                 FROM nodes
                 WHERE tags LIKE ?1
                   AND deleted_at IS NULL
                 ORDER BY updated_ts DESC",
            )
            .map_err(|e| format!("tag_search prepare: {e}"))?;

        let rows = stmt
            .query_map(params![pattern], row_to_node)
            .map_err(|e| format!("tag_search query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    // -----------------------------------------------------------------------
    // Soft delete
    // -----------------------------------------------------------------------

    /// Soft-delete a node by setting `deleted_at` to the current timestamp.
    ///
    /// The node remains in the database and its wikilinks in other nodes'
    /// summaries still resolve (they just won't appear in most queries).
    /// Call `upsert_node` to restore a deleted node.
    pub fn forget_node(&self, slug: &str) -> Result<(), String> {
        let conn = self.lock()?;
        let ts   = now_secs();
        conn.execute(
            "UPDATE nodes SET deleted_at = ?1 WHERE slug = ?2",
            params![ts, slug],
        )
        .map_err(|e| format!("forget_node '{slug}': {e}"))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Full-text search
    // -----------------------------------------------------------------------

    /// Full-text search across slug + title + summary.
    ///
    /// Returns non-deleted nodes ranked by FTS5 relevance.
    pub fn fts_search(&self, query: &str) -> Result<Vec<Node>, String> {
        let conn = self.lock()?;
        // Build a safe FTS5 match expression — each token becomes `token*`.
        let phrase = fts_phrase(query);
        if phrase.is_empty() {
            return Ok(vec![]);
        }

        let mut stmt = conn
            .prepare(
                r#"SELECT n.slug, n.kind, n.title, n.summary, n.tags,
                          n.created_ts, n.updated_ts, n.deleted_at
                   FROM nodes_fts f
                   JOIN nodes n ON n.slug = f.slug
                   WHERE nodes_fts MATCH ?1
                     AND n.deleted_at IS NULL
                   ORDER BY rank"#,
            )
            .map_err(|e| format!("fts_search prepare: {e}"))?;

        let rows = stmt
            .query_map(params![phrase], row_to_node)
            .map_err(|e| format!("fts_search query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn row_to_node(r: &rusqlite::Row<'_>) -> rusqlite::Result<Node> {
    let kind_str: String = r.get(1)?;
    let tags_json: String = r.get(4)?;
    Ok(Node {
        slug:       r.get(0)?,
        kind:       NodeKind::from_str(&kind_str),
        title:      r.get(2)?,
        summary:    r.get(3)?,
        tags:       parse_tags(&tags_json),
        created_ts: r.get(5)?,
        updated_ts: r.get(6)?,
        deleted_at: r.get(7)?,
    })
}

fn parse_tags(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

fn fts_phrase(q: &str) -> String {
    let tokens: Vec<String> = q
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .filter(|t| !t.is_empty())
        .map(|t| format!("{t}*"))
        .collect();
    tokens.join(" OR ")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Open an isolated ContinuityStore in a temp directory.
    fn scratch_store(tag: &str) -> (PathBuf, ContinuityStore) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunny-cont-{tag}-{pid}-{nanos}-{seq}",
            pid = std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let store = ContinuityStore::open(&dir).expect("open store");
        (dir, store)
    }

    // -----------------------------------------------------------------------
    // 1. Wikilink extraction (delegated to wikilinks::tests + integration)
    // -----------------------------------------------------------------------

    #[test]
    fn wikilink_extraction_produces_edges() {
        let (_dir, store) = scratch_store("wikilink-edges");
        store
            .upsert_node(
                NodeKind::Session,
                "sess-1",
                "Session 1",
                "Worked on [[project-alpha]] and noted [[2026-04-20]].",
                &[],
            )
            .unwrap();

        let (_, edges) = store.graph_view().unwrap();
        let targets: Vec<&str> = edges
            .iter()
            .filter(|e| e.from == "sess-1")
            .map(|e| e.to.as_str())
            .collect();
        assert!(targets.contains(&"project-alpha"), "edge to project-alpha");
        assert!(targets.contains(&"2026-04-20"), "edge to daily note");
    }

    // -----------------------------------------------------------------------
    // 2. Backlinks computation (pure SQL, no stored edges)
    // -----------------------------------------------------------------------

    #[test]
    fn backlinks_of_returns_referencing_nodes() {
        let (_dir, store) = scratch_store("backlinks");
        store
            .upsert_node(NodeKind::Project, "proj-a", "Project A", "", &[])
            .unwrap();
        store
            .upsert_node(
                NodeKind::Session,
                "sess-a",
                "Session A",
                "Today worked on [[proj-a]].",
                &[],
            )
            .unwrap();
        store
            .upsert_node(
                NodeKind::Decision,
                "dec-a",
                "Decision A",
                "Decided the approach for [[proj-a]].",
                &["#decision"],
            )
            .unwrap();

        let bl = store.backlinks_of("proj-a").unwrap();
        assert!(bl.contains(&"sess-a".to_string()));
        assert!(bl.contains(&"dec-a".to_string()));
        assert!(!bl.contains(&"proj-a".to_string()), "no self-backlink");
    }

    // -----------------------------------------------------------------------
    // 3. Daily note idempotent creation
    // -----------------------------------------------------------------------

    #[test]
    fn daily_note_idempotent_creation() {
        let (_dir, store) = scratch_store("daily-note");
        let slug1 = store.daily_note_slug("2026-04-20").unwrap();
        let slug2 = store.daily_note_slug("2026-04-20").unwrap();
        assert_eq!(slug1, slug2, "same slug both calls");
        assert_eq!(slug1, "2026-04-20");

        // Exactly one node with this slug.
        let nodes = store.recent_context(100).unwrap();
        let count = nodes.iter().filter(|n| n.slug == "2026-04-20").count();
        assert_eq!(count, 1, "must not duplicate daily note");
    }

    // -----------------------------------------------------------------------
    // 4. Tag search
    // -----------------------------------------------------------------------

    #[test]
    fn tag_search_returns_tagged_nodes() {
        let (_dir, store) = scratch_store("tag-search");
        store
            .upsert_node(NodeKind::Decision, "dec-1", "D1", "Some decision.", &["#decision"])
            .unwrap();
        store
            .upsert_node(NodeKind::Session, "sess-1", "S1", "Normal session.", &["#session"])
            .unwrap();

        let hits = store.tag_search("#decision").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].slug, "dec-1");
    }

    // -----------------------------------------------------------------------
    // 5. MOC regeneration
    // -----------------------------------------------------------------------

    #[test]
    fn project_moc_auto_generates_index() {
        let (_dir, store) = scratch_store("moc-gen");
        store
            .upsert_node(NodeKind::Project, "sunny-proj", "Sunny", "", &[])
            .unwrap();
        store
            .upsert_node(
                NodeKind::Session,
                "sess-moc",
                "Sess",
                "Worked on [[sunny-proj]] today.",
                &[],
            )
            .unwrap();

        let moc = store.project_moc("sunny-proj").unwrap();
        assert_eq!(moc.slug, "sunny-proj-moc");
        assert!(moc.summary.contains("[[sess-moc]]"));
        assert!(moc.tags.contains(&"#moc".to_string()));
    }

    // -----------------------------------------------------------------------
    // 6. Soft-delete excludes from queries
    // -----------------------------------------------------------------------

    #[test]
    fn soft_delete_excludes_from_queries() {
        let (_dir, store) = scratch_store("soft-delete");
        store
            .upsert_node(NodeKind::Session, "live-node", "Live", "Keep me.", &[])
            .unwrap();
        store
            .upsert_node(NodeKind::Session, "dead-node", "Dead", "Delete me.", &["#done"])
            .unwrap();

        store.forget_node("dead-node").unwrap();

        let recent = store.recent_context(50).unwrap();
        let slugs: Vec<&str> = recent.iter().map(|n| n.slug.as_str()).collect();
        assert!(slugs.contains(&"live-node"), "live node must appear");
        assert!(!slugs.contains(&"dead-node"), "deleted node must be excluded");

        // Tag search also excludes deleted.
        let tagged = store.tag_search("#done").unwrap();
        assert!(tagged.is_empty(), "deleted node must not appear in tag search");
    }

    // -----------------------------------------------------------------------
    // 7. FTS matches
    // -----------------------------------------------------------------------

    #[test]
    fn fts_search_matches_summary_content() {
        let (_dir, store) = scratch_store("fts-match");
        store
            .upsert_node(
                NodeKind::Thread,
                "th-rust",
                "Rust async",
                "Discussion about tokio and async runtimes.",
                &[],
            )
            .unwrap();
        store
            .upsert_node(
                NodeKind::Thread,
                "th-unrelated",
                "Gardening",
                "Notes about watering plants.",
                &[],
            )
            .unwrap();

        let hits = store.fts_search("tokio").unwrap();
        assert!(!hits.is_empty(), "FTS should match 'tokio'");
        assert!(hits.iter().any(|n| n.slug == "th-rust"), "th-rust must be in results");
        assert!(
            hits.iter().all(|n| n.slug != "th-unrelated"),
            "th-unrelated must not match"
        );
    }

    // -----------------------------------------------------------------------
    // 8. graph_view edge and node counts
    // -----------------------------------------------------------------------

    #[test]
    fn graph_view_edge_and_node_counts() {
        let (_dir, store) = scratch_store("graph-view");
        store
            .upsert_node(NodeKind::Project, "gv-proj", "GV Project", "", &[])
            .unwrap();
        store
            .upsert_node(
                NodeKind::Session,
                "gv-sess",
                "GV Session",
                "Links to [[gv-proj]].",
                &[],
            )
            .unwrap();
        store
            .upsert_node(
                NodeKind::Decision,
                "gv-dec",
                "GV Decision",
                "Also links to [[gv-proj]].",
                &["#decision"],
            )
            .unwrap();

        let (nodes, edges) = store.graph_view().unwrap();

        // 3 explicit + potentially stub nodes; at minimum 3 non-deleted nodes.
        let named_slugs: Vec<&str> = nodes.iter().map(|n| n.slug.as_str()).collect();
        assert!(named_slugs.contains(&"gv-proj"));
        assert!(named_slugs.contains(&"gv-sess"));
        assert!(named_slugs.contains(&"gv-dec"));

        // Two edges: gv-sess -> gv-proj and gv-dec -> gv-proj.
        let edge_count = edges
            .iter()
            .filter(|e| e.to == "gv-proj")
            .count();
        assert_eq!(edge_count, 2, "two edges into gv-proj");

        // gv-proj's backlink_count in graph nodes should be 2.
        let proj_node = nodes.iter().find(|n| n.slug == "gv-proj").unwrap();
        assert_eq!(proj_node.backlink_count, 2);
    }

    // -----------------------------------------------------------------------
    // 9. Round-trip insert + read
    // -----------------------------------------------------------------------

    #[test]
    fn round_trip_insert_and_read() {
        let (_dir, store) = scratch_store("round-trip");
        store
            .upsert_node(
                NodeKind::Decision,
                "rt-decision",
                "Use SQLite",
                "Chose SQLite over Postgres. #decision",
                &["#decision"],
            )
            .unwrap();

        let recent = store.recent_context(10).unwrap();
        let node = recent.iter().find(|n| n.slug == "rt-decision").unwrap();
        assert_eq!(node.title, "Use SQLite");
        assert!(node.tags.contains(&"#decision".to_string()));
        assert!(node.summary.contains("Chose SQLite over Postgres"));
        assert_eq!(node.deleted_at, None);
    }

    // -----------------------------------------------------------------------
    // 10. Open-questions tag count
    // -----------------------------------------------------------------------

    #[test]
    fn open_questions_tag_count() {
        let (_dir, store) = scratch_store("open-q");
        for i in 0..3 {
            store
                .upsert_node(
                    NodeKind::Thread,
                    &format!("oq-{i}"),
                    &format!("Open Q {i}"),
                    &format!("Question {i} still open."),
                    &["#open-question"],
                )
                .unwrap();
        }
        store
            .upsert_node(NodeKind::Thread, "oq-done", "Done Q", "Closed.", &["#done"])
            .unwrap();

        let open = store.tag_search("#open-question").unwrap();
        assert_eq!(open.len(), 3);
    }

    // -----------------------------------------------------------------------
    // 11. Decision tag auto-filter in tag_search
    // -----------------------------------------------------------------------

    #[test]
    fn decision_tagged_nodes_filter_correctly() {
        let (_dir, store) = scratch_store("decision-filter");
        store
            .upsert_node(NodeKind::Decision, "d1", "D1", "First decision.", &["#decision"])
            .unwrap();
        store
            .upsert_node(NodeKind::Decision, "d2", "D2", "Second decision.", &["#decision"])
            .unwrap();
        store
            .upsert_node(NodeKind::Thread, "t1", "T1", "Not a decision.", &["#thread"])
            .unwrap();

        let decisions = store.tag_search("#decision").unwrap();
        assert_eq!(decisions.len(), 2);
        let slugs: Vec<&str> = decisions.iter().map(|n| n.slug.as_str()).collect();
        assert!(slugs.contains(&"d1"));
        assert!(slugs.contains(&"d2"));
        assert!(!slugs.contains(&"t1"));
    }

    // -----------------------------------------------------------------------
    // 12. Wikilink survives unicode
    // -----------------------------------------------------------------------

    #[test]
    fn wikilink_survives_unicode() {
        let (_dir, store) = scratch_store("unicode-wikilink");
        store
            .upsert_node(
                NodeKind::Thread,
                "unicode-src",
                "Unicode source",
                "Links to [[日本語-ノード]] and [[café-2026]].",
                &[],
            )
            .unwrap();

        let bl_ja = store.backlinks_of("日本語-ノード").unwrap();
        assert!(
            bl_ja.contains(&"unicode-src".to_string()),
            "unicode slug must produce a backlink"
        );

        let bl_cafe = store.backlinks_of("café-2026").unwrap();
        assert!(bl_cafe.contains(&"unicode-src".to_string()));

        let (_, edges) = store.graph_view().unwrap();
        let targets: Vec<&str> = edges
            .iter()
            .filter(|e| e.from == "unicode-src")
            .map(|e| e.to.as_str())
            .collect();
        assert!(targets.contains(&"日本語-ノード"));
        assert!(targets.contains(&"café-2026"));
    }
}
