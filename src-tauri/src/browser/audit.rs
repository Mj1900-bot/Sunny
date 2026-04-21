//! Append-only audit log for outbound HTTP requests.
//!
//! Backed by SQLite under `~/.sunny/browser/audit.sqlite` — separate from the
//! memory DB so (a) a corrupted memory file never drags the browser down
//! and (b) the audit log has its own, more aggressive retention policy.
//!
//! What we record: `(ts, profile_id, tab_id, method, host, port, bytes_in,
//! bytes_out, ms, blocked_by)`. What we never record: full URL paths,
//! query strings, bodies. Paths can be privacy-sensitive even inside our
//! own process — think `https://site/api/reset-password?token=...`.
//!
//! Tor-profile requests are *never* audited. The `AuditSink::record`
//! function checks the policy flag and drops silently.

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, params};

use crate::browser::profile::ProfilePolicy;

const DIR_NAME: &str = ".sunny";
const SUBDIR_NAME: &str = "browser";
const DB_FILENAME: &str = "audit.sqlite";

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct AuditRecord {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub ts: i64,
    pub profile_id: String,
    pub tab_id: Option<String>,
    pub method: String,
    pub host: String,
    #[ts(type = "number")]
    pub port: u16,
    #[ts(type = "number")]
    pub bytes_in: i64,
    #[ts(type = "number")]
    pub bytes_out: i64,
    #[ts(type = "number")]
    pub duration_ms: i64,
    pub blocked_by: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub profile_id: String,
    pub tab_id: Option<String>,
    pub method: String,
    pub host: String,
    pub port: u16,
    pub bytes_in: i64,
    pub bytes_out: i64,
    pub duration_ms: i64,
    pub blocked_by: Option<String>,
}

pub fn audit_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    Ok(home.join(DIR_NAME).join(SUBDIR_NAME))
}

fn conn_cell() -> &'static Mutex<Connection> {
    static CELL: OnceLock<Mutex<Connection>> = OnceLock::new();
    CELL.get_or_init(|| {
        let dir = audit_dir().expect("audit dir");
        fs::create_dir_all(&dir).expect("create audit dir");
        let path = dir.join(DB_FILENAME);
        let conn = Connection::open(&path).expect("open audit sqlite");
        // File mode 0600 on unix so nobody else on the box can read.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        ensure_schema(&conn).expect("ensure audit schema");
        Mutex::new(conn)
    })
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           INTEGER NOT NULL,
            profile_id   TEXT NOT NULL,
            tab_id       TEXT,
            method       TEXT NOT NULL,
            host         TEXT NOT NULL,
            port         INTEGER NOT NULL,
            bytes_in     INTEGER NOT NULL DEFAULT 0,
            bytes_out    INTEGER NOT NULL DEFAULT 0,
            duration_ms  INTEGER NOT NULL DEFAULT 0,
            blocked_by   TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_audit_ts       ON audit (ts DESC);
        CREATE INDEX IF NOT EXISTS ix_audit_profile  ON audit (profile_id, ts DESC);
        CREATE INDEX IF NOT EXISTS ix_audit_blocked  ON audit (blocked_by) WHERE blocked_by IS NOT NULL;
        "#,
    )
    .map_err(|e| format!("audit schema: {e}"))?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SCHEMA_VERSION.to_string()],
    )
    .map_err(|e| format!("audit version: {e}"))?;
    Ok(())
}

/// Record one request outcome. Does nothing when the profile has
/// `audit = false`. Swallows DB errors so an audit failure can't take a
/// browsing session down — we log instead.
pub fn record(policy: &ProfilePolicy, entry: AuditEntry) {
    if !policy.audit {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mu = conn_cell();
    let Ok(guard) = mu.lock() else {
        log::warn!("audit: mutex poisoned; dropping record");
        return;
    };
    let res = guard.execute(
        "INSERT INTO audit (ts, profile_id, tab_id, method, host, port, bytes_in, bytes_out, duration_ms, blocked_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            ts,
            entry.profile_id,
            entry.tab_id,
            entry.method,
            entry.host,
            entry.port as i64,
            entry.bytes_in,
            entry.bytes_out,
            entry.duration_ms,
            entry.blocked_by,
        ],
    );
    if let Err(e) = res {
        log::warn!("audit: insert failed: {e}");
    }
}

pub fn list_recent(limit: usize) -> Result<Vec<AuditRecord>, String> {
    let mu = conn_cell();
    let guard = mu
        .lock()
        .map_err(|_| "audit mutex poisoned".to_string())?;
    let mut stmt = guard
        .prepare(
            "SELECT id, ts, profile_id, tab_id, method, host, port, bytes_in, bytes_out, duration_ms, blocked_by
             FROM audit ORDER BY ts DESC LIMIT ?1",
        )
        .map_err(|e| format!("audit prep: {e}"))?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok(AuditRecord {
                id: r.get(0)?,
                ts: r.get(1)?,
                profile_id: r.get(2)?,
                tab_id: r.get(3)?,
                method: r.get(4)?,
                host: r.get(5)?,
                port: {
                    let p: i64 = r.get(6)?;
                    p as u16
                },
                bytes_in: r.get(7)?,
                bytes_out: r.get(8)?,
                duration_ms: r.get(9)?,
                blocked_by: r.get(10)?,
            })
        })
        .map_err(|e| format!("audit q: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("audit collect: {e}"))
}

pub fn clear_older_than(seconds: i64) -> Result<usize, String> {
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        - seconds;
    let mu = conn_cell();
    let guard = mu
        .lock()
        .map_err(|_| "audit mutex poisoned".to_string())?;
    let n = guard
        .execute("DELETE FROM audit WHERE ts < ?1", params![cutoff])
        .map_err(|e| format!("audit purge: {e}"))?;
    Ok(n)
}
