//! Per-profile bookmarks + history. Lives in the same SQLite file as the
//! audit log (`~/.sunny/browser/audit.sqlite`) because the schemas are tiny
//! and keeping the browser's storage footprint in one file makes backup /
//! wipe scriptable (just delete the file).
//!
//! Design rule: every row carries `profile_id`. There is no
//! "all-profiles-combined" query — a Tor bookmark never surfaces when you
//! look at the default profile, by construction.

use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browser::audit::audit_dir;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Bookmark {
    #[ts(type = "number")]
    pub id: i64,
    pub profile_id: String,
    pub title: String,
    pub url: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HistoryEntry {
    #[ts(type = "number")]
    pub id: i64,
    pub profile_id: String,
    pub title: String,
    pub url: String,
    #[ts(type = "number")]
    pub visited_at: i64,
}

const STORAGE_FILENAME: &str = "storage.sqlite";

fn conn_cell() -> &'static Mutex<Connection> {
    static CELL: OnceLock<Mutex<Connection>> = OnceLock::new();
    CELL.get_or_init(|| {
        let dir = audit_dir().expect("audit dir");
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join(STORAGE_FILENAME);
        let conn = Connection::open(&path).expect("open browser storage db");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &path,
                std::fs::Permissions::from_mode(0o600),
            );
        }
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS bookmarks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  TEXT NOT NULL,
                title       TEXT NOT NULL,
                url         TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_bookmarks_profile_url
                ON bookmarks (profile_id, url);

            CREATE TABLE IF NOT EXISTS history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  TEXT NOT NULL,
                title       TEXT NOT NULL,
                url         TEXT NOT NULL,
                visited_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_history_profile_time
                ON history (profile_id, visited_at DESC);

            CREATE TABLE IF NOT EXISTS downloads (
                id            TEXT PRIMARY KEY,
                profile_id    TEXT NOT NULL,
                source_url    TEXT NOT NULL,
                title         TEXT,
                state         TEXT NOT NULL,
                progress      REAL NOT NULL DEFAULT 0.0,
                file_path     TEXT,
                mime          TEXT,
                bytes_total   INTEGER,
                bytes_done    INTEGER NOT NULL DEFAULT 0,
                error         TEXT,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_downloads_created
                ON downloads (created_at DESC);
            "#,
        )
        .expect("browser storage schema");
        Mutex::new(conn)
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn add_bookmark(profile_id: &str, title: &str, url: &str) -> Result<Bookmark, String> {
    let g = conn_cell().lock().map_err(|_| "poisoned")?;
    let ts = now_secs();
    g.execute(
        "INSERT INTO bookmarks (profile_id, title, url, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (profile_id, url) DO UPDATE SET title = excluded.title",
        params![profile_id, title, url, ts],
    )
    .map_err(|e| format!("insert bookmark: {e}"))?;
    let id: i64 = g
        .query_row(
            "SELECT id FROM bookmarks WHERE profile_id = ?1 AND url = ?2",
            params![profile_id, url],
            |r| r.get(0),
        )
        .map_err(|e| format!("fetch bookmark id: {e}"))?;
    Ok(Bookmark {
        id,
        profile_id: profile_id.to_string(),
        title: title.to_string(),
        url: url.to_string(),
        created_at: ts,
    })
}

pub fn list_bookmarks(profile_id: &str) -> Result<Vec<Bookmark>, String> {
    let g = conn_cell().lock().map_err(|_| "poisoned")?;
    let mut stmt = g
        .prepare(
            "SELECT id, profile_id, title, url, created_at
             FROM bookmarks WHERE profile_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| format!("prep bookmarks: {e}"))?;
    let rows = stmt
        .query_map(params![profile_id], |r| {
            Ok(Bookmark {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                title: r.get(2)?,
                url: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| format!("q bookmarks: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect bookmarks: {e}"))
}

pub fn delete_bookmark(profile_id: &str, url: &str) -> Result<(), String> {
    let g = conn_cell().lock().map_err(|_| "poisoned")?;
    g.execute(
        "DELETE FROM bookmarks WHERE profile_id = ?1 AND url = ?2",
        params![profile_id, url],
    )
    .map_err(|e| format!("delete bookmark: {e}"))?;
    Ok(())
}

pub fn push_history(
    profile_id: &str,
    title: &str,
    url: &str,
) -> Result<HistoryEntry, String> {
    // Tor profile never writes to history.
    if profile_id == "tor" {
        return Ok(HistoryEntry {
            id: 0,
            profile_id: profile_id.to_string(),
            title: title.to_string(),
            url: url.to_string(),
            visited_at: now_secs(),
        });
    }
    let g = conn_cell().lock().map_err(|_| "poisoned")?;
    let ts = now_secs();
    g.execute(
        "INSERT INTO history (profile_id, title, url, visited_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![profile_id, title, url, ts],
    )
    .map_err(|e| format!("insert history: {e}"))?;
    let id: i64 = g.last_insert_rowid();
    Ok(HistoryEntry {
        id,
        profile_id: profile_id.to_string(),
        title: title.to_string(),
        url: url.to_string(),
        visited_at: ts,
    })
}

pub fn list_history(
    profile_id: &str,
    limit: usize,
) -> Result<Vec<HistoryEntry>, String> {
    let g = conn_cell().lock().map_err(|_| "poisoned")?;
    let mut stmt = g
        .prepare(
            "SELECT id, profile_id, title, url, visited_at
             FROM history WHERE profile_id = ?1
             ORDER BY visited_at DESC LIMIT ?2",
        )
        .map_err(|e| format!("prep history: {e}"))?;
    let rows = stmt
        .query_map(params![profile_id, limit as i64], |r| {
            Ok(HistoryEntry {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                title: r.get(2)?,
                url: r.get(3)?,
                visited_at: r.get(4)?,
            })
        })
        .map_err(|e| format!("q history: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect history: {e}"))
}

pub fn clear_history(profile_id: &str) -> Result<usize, String> {
    let g = conn_cell().lock().map_err(|_| "poisoned")?;
    let n = g
        .execute(
            "DELETE FROM history WHERE profile_id = ?1",
            params![profile_id],
        )
        .map_err(|e| format!("clear history: {e}"))?;
    Ok(n)
}

// -- Downloads persistence (see browser::downloads for the mutator API) --

pub(super) fn downloads_conn() -> &'static Mutex<Connection> {
    conn_cell()
}
