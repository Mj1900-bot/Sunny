//! Schema DDL and migration for the continuity graph.
//!
//! Creates `~/.sunny/continuity.db` (separate from memory.sqlite so the
//! graph can have independent WAL tuning and backup cadence).
//!
//! Tables:
//!   nodes(slug PK, kind, title, summary, tags JSON, created_ts, updated_ts, deleted_at)
//!   graph_edges(id, subject_slug, predicate, object_slug, weight, created_ts)
//!   nodes_fts(slug, title, summary) — FTS5 virtual table
//!
//! Indexes: (kind, updated_ts), tags JSON (expression), FTS.

use rusqlite::{Connection, params};

pub const DB_FILENAME: &str = "continuity.db";
pub(super) const SCHEMA_VERSION: u32 = 1;

/// Ensure schema is present and up-to-date. Idempotent.
pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS continuity_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("create continuity_meta: {e}"))?;

    let current = read_version(conn)?;
    if current < SCHEMA_VERSION {
        apply_migration_v1(conn)?;
        write_version(conn, SCHEMA_VERSION)?;
    }
    Ok(())
}

fn apply_migration_v1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        -- Primary node store.  `kind` is one of the NodeKind enum variants
        -- (Session, Thread, Decision, Project, Person, Artifact, DailyNote, Moc).
        -- `tags` is a JSON array string e.g. '["decision","blocker"]' (pound prefix added in app).
        -- `deleted_at` is NULL for live nodes; soft-delete sets it to unix seconds.
        CREATE TABLE IF NOT EXISTS nodes (
            slug        TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            title       TEXT NOT NULL,
            summary     TEXT NOT NULL DEFAULT '',
            tags        TEXT NOT NULL DEFAULT '[]',
            created_ts  INTEGER NOT NULL,
            updated_ts  INTEGER NOT NULL,
            deleted_at  INTEGER
        );

        -- Indexes for common query patterns.
        CREATE INDEX IF NOT EXISTS ix_nodes_kind_updated
            ON nodes (kind, updated_ts DESC);
        CREATE INDEX IF NOT EXISTS ix_nodes_live_updated
            ON nodes (deleted_at, updated_ts DESC);

        -- Edge store.  Edges are auto-populated from wikilink extraction in
        -- upsert_node; the caller can also insert explicit predicate edges
        -- (e.g. "depends_on", "decided_by").  `weight` defaults to 1.0 and can
        -- be bumped by repeated references so link strength accretes over time.
        CREATE TABLE IF NOT EXISTS graph_edges (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_slug TEXT NOT NULL,
            predicate    TEXT NOT NULL DEFAULT 'links_to',
            object_slug  TEXT NOT NULL,
            weight       REAL NOT NULL DEFAULT 1.0,
            created_ts   INTEGER NOT NULL,
            FOREIGN KEY (subject_slug) REFERENCES nodes(slug),
            FOREIGN KEY (object_slug)  REFERENCES nodes(slug)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ux_graph_edges_pair
            ON graph_edges (subject_slug, predicate, object_slug);
        CREATE INDEX IF NOT EXISTS ix_graph_edges_subject
            ON graph_edges (subject_slug);
        CREATE INDEX IF NOT EXISTS ix_graph_edges_object
            ON graph_edges (object_slug);

        -- FTS5 virtual table for full-text search AND backlink computation.
        -- Backlinks are found via:
        --   SELECT slug FROM nodes_fts WHERE nodes_fts MATCH '"[[target-slug]]"'
        -- The content= linkage means inserts into `nodes` are reflected
        -- automatically via the triggers below.
        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5 (
            slug,
            title,
            summary,
            content='nodes',
            content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
            INSERT INTO nodes_fts (rowid, slug, title, summary)
                VALUES (new.rowid, new.slug, new.title, new.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
            INSERT INTO nodes_fts (nodes_fts, rowid, slug, title, summary)
                VALUES ('delete', old.rowid, old.slug, old.title, old.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
            INSERT INTO nodes_fts (nodes_fts, rowid, slug, title, summary)
                VALUES ('delete', old.rowid, old.slug, old.title, old.summary);
            INSERT INTO nodes_fts (rowid, slug, title, summary)
                VALUES (new.rowid, new.slug, new.title, new.summary);
        END;
        "#,
    )
    .map_err(|e| format!("apply continuity v1 schema: {e}"))?;
    Ok(())
}

fn read_version(conn: &Connection) -> Result<u32, String> {
    conn.query_row(
        "SELECT value FROM continuity_meta WHERE key = 'schema_version'",
        [],
        |r| r.get::<_, String>(0),
    )
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok("0".to_string()),
        other => Err(format!("read continuity version: {other}")),
    })
    .map(|s| s.parse::<u32>().unwrap_or(0))
}

fn write_version(conn: &Connection, v: u32) -> Result<(), String> {
    conn.execute(
        "INSERT INTO continuity_meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![v.to_string()],
    )
    .map_err(|e| format!("write continuity version: {e}"))?;
    Ok(())
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
