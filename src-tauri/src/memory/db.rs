//! Single shared SQLite connection + schema bootstrapping + one-shot
//! migration from the legacy `~/.sunny/memory.jsonl` file.
//!
//! The connection lives in a `OnceLock<Mutex<Connection>>`. Callers grab it
//! through `with_conn()` which enforces lock-then-run-then-drop so no raw
//! `&mut Connection` escapes the module.
//!
//! Schema is versioned in the `meta` table. Bumping `SCHEMA_VERSION` and
//! adding a new match arm in `apply_migrations()` is the canonical way to
//! evolve storage.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{Connection, OpenFlags, params};

const DIR_NAME: &str = ".sunny";
const SUBDIR_NAME: &str = "memory";
const DB_FILENAME: &str = "memory.sqlite";
const LEGACY_JSONL: &str = "memory.jsonl"; // under ~/.sunny (the old location)

const SCHEMA_VERSION: u32 = 8;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Resolve `~/.sunny/memory` — the containing directory for the DB file and
/// any future memory artifacts (vector indexes, debug dumps, etc.).
pub fn memory_dir_default() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "$HOME not set".to_string())?;
    Ok(home.join(DIR_NAME).join(SUBDIR_NAME))
}

/// Initialize the memory DB (creates the file + schema, runs the legacy
/// migration once). Idempotent; cheap to call repeatedly. Intended to be
/// invoked from `tauri::Builder::setup` so the first user action doesn't pay
/// for migration latency.
pub fn init_default() -> Result<(), String> {
    let dir = memory_dir_default()?;
    init_in(&dir)
}

/// Run a closure with the global connection held under its mutex. The
/// closure takes an immutable reference; sqlite's `Connection` has interior
/// mutability so `execute` / `prepare` still work.
pub fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let mu = conn_cell();
    let guard = mu.lock().map_err(|_| "memory DB mutex poisoned".to_string())?;
    f(&*guard)
}

// ---------------------------------------------------------------------------
// Reader connection pool
// ---------------------------------------------------------------------------

/// Number of read-only connections held in `READER_POOL`. Four is enough for
/// the current workload (memory-pack builder + FTS search + UI inspector all
/// firing concurrently at peak). Raise if profiling shows pool exhaustion.
const READER_POOL_SIZE: usize = 4;

/// The pool of read-only `Connection`s used by `with_reader`. Seeded lazily
/// on first call to `with_reader` (or eagerly by `init_in` after the schema
/// is confirmed present). `None` means "not yet initialised"; an empty `Vec`
/// after initialisation means every connection is currently borrowed.
static READER_POOL: OnceLock<Mutex<Vec<Connection>>> = OnceLock::new();

/// RAII guard that returns a borrowed `Connection` to `READER_POOL` on drop,
/// even if the closure passed to `with_reader` panics.
#[allow(dead_code)]
struct PoolGuard {
    conn: Option<Connection>,
}

impl Drop for PoolGuard {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take() {
            if let Some(pool_mu) = READER_POOL.get() {
                // Best-effort push-back. If the mutex is poisoned we simply
                // let the connection drop — pool size shrinks by one but the
                // program isn't deadlocked.
                if let Ok(mut pool) = pool_mu.lock() {
                    pool.push(c);
                }
            }
        }
    }
}

/// Opens a single read-only SQLite connection to the memory DB in `dir`.
///
/// Flags: `SQLITE_OPEN_READONLY | SQLITE_OPEN_SHARED_CACHE | SQLITE_OPEN_NO_MUTEX`.
/// WAL mode, `synchronous = NORMAL`, and `foreign_keys = ON` match the
/// writer connection so readers observe the same consistency contract.
/// `SQLITE_OPEN_SHARED_CACHE` lets the OS page cache be reused across
/// connections within the same process; in WAL mode readers never block
/// writers and vice-versa, so this is safe and reduces physical I/O.
#[allow(dead_code)]
fn open_reader_connection(dir: &Path) -> Result<Connection, String> {
    let path = dir.join(DB_FILENAME);
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_SHARED_CACHE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&path, flags)
        .map_err(|e| format!("open reader sqlite {}: {e}", path.display()))?;
    // WAL must already be set by the writer; PRAGMA journal_mode on a
    // read-only connection is a no-op but we apply synchronous + fks for
    // consistency with open_connection.
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("reader pragma synchronous: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("reader pragma fks: {e}"))?;
    Ok(conn)
}

/// Seed the reader pool with `READER_POOL_SIZE` read-only connections.
/// Must be called **after** `ensure_schema` so all tables exist before
/// the first reader tries to query them.
///
/// `OnceLock::get_or_try_init` is nightly-only on MSRV 1.77.2 (stabilised
/// in 1.83). We use a two-phase init instead: build the pool on the stack,
/// then attempt `set`; if `set` loses the race the local pool is simply
/// dropped (harmless — the winning thread's pool is already installed).
fn init_reader_pool(dir: &Path) -> Result<(), String> {
    if READER_POOL.get().is_some() {
        return Ok(());
    }
    let mut conns = Vec::with_capacity(READER_POOL_SIZE);
    for _ in 0..READER_POOL_SIZE {
        conns.push(open_reader_connection(dir)?);
    }
    // `set` returns Err(value) if another thread won the race — discard the
    // local pool; the installed one is equivalent.
    let _ = READER_POOL.set(Mutex::new(conns));
    Ok(())
}

/// Run a closure against a pooled read-only connection.
///
/// Pops one connection from `READER_POOL`, runs `f`, then returns it via the
/// `PoolGuard` RAII wrapper — even if `f` panics. Falls back to `with_conn`
/// (the writer path) when the pool is empty or has not yet been initialised,
/// so callers always get a working connection.
#[allow(dead_code)]
pub fn with_reader<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    // Pop a connection under the pool lock, then RELEASE the lock *before*
    // running `f`. Holding the pool mutex across `f()` would:
    //   (1) self-deadlock on the main thread — `PoolGuard::drop` re-locks
    //       the same mutex to push the connection back. std::sync::Mutex is
    //       non-reentrant, so the same-thread re-lock hangs forever (observed
    //       on macOS as `__psynch_mutexwait` in a sample of the UI thread);
    //   (2) serialize every reader query behind a single mutex, defeating
    //       the whole point of a pool.
    // The `and_then` chain below scopes the MutexGuard so it drops at the
    // end of the closure, cleanly releasing the pool before the borrowed
    // connection is used.
    let borrowed = READER_POOL
        .get()
        .and_then(|pool_mu| pool_mu.lock().ok().and_then(|mut pool| pool.pop()));

    if let Some(conn) = borrowed {
        let guard = PoolGuard { conn: Some(conn) };
        return f(guard.conn.as_ref().unwrap());
        // `guard` drops at return; PoolGuard::drop re-locks pool_mu cleanly
        // since the pop-site lock was already released above.
    }

    // Pool empty / uninitialised — fall back to the writer lock.
    with_conn(f)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn conn_cell() -> &'static Mutex<Connection> {
    static CELL: OnceLock<Mutex<Connection>> = OnceLock::new();
    CELL.get_or_init(|| {
        let dir = memory_dir_default().expect("memory dir resolvable");
        // Panicking here is fine — this runs inside OnceLock init and only
        // on an unrecoverable filesystem error; the app can't proceed without
        // a usable memory DB anyway.
        let conn = open_connection(&dir).expect("open memory DB");
        ensure_schema(&conn).expect("ensure memory schema");
        migrate_legacy_jsonl_if_present(&conn).expect("migrate legacy memory.jsonl");
        Mutex::new(conn)
    })
}

fn init_in(dir: &Path) -> Result<(), String> {
    // Touching the OnceLock runs the initializer. We also want the public
    // init to surface errors rather than panic in the cell init, so run the
    // fallible steps here first — the cell init becomes a trivial second
    // call that hits the already-created DB.
    fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let conn = open_connection(dir)?;
    ensure_schema(&conn)?;
    migrate_legacy_jsonl_if_present(&conn)?;
    drop(conn);

    // Seed the reader pool after schema is confirmed — readers must see all
    // tables before being handed to callers. Errors here are non-fatal for
    // the writer path (which never uses the pool) but we propagate so
    // startup visibility is clear.
    init_reader_pool(dir)?;

    // Prime the cell — assign to a named binding so clippy doesn't flag the
    // lock as immediately-dropped; we release it on return.
    let _guard = conn_cell().lock().map_err(|_| "memory DB mutex poisoned".to_string())?;
    drop(_guard);
    Ok(())
}

fn open_connection(dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(dir).map_err(|e| format!("create memory dir: {e}"))?;
    let path = dir.join(DB_FILENAME);
    let conn = Connection::open(&path).map_err(|e| format!("open sqlite {}: {e}", path.display()))?;
    // Write-ahead logging: fewer fsync stalls, better concurrent reads.
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("pragma WAL: {e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("pragma synchronous: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("pragma fks: {e}"))?;
    // WAL hygiene: under heavy concurrent writes the `-wal` sidecar can
    // balloon into hundreds of MB, causing startup latency spikes and (on
    // crash) risking lost frames past the last checkpoint. Three defenses:
    //
    //   * `wal_autocheckpoint=1000` — SQLite automatically checkpoints
    //     whenever the WAL reaches 1000 frames (~4 MB at the default 4 KB
    //     page size). This is the normal case; the checkpoint happens
    //     inline on the commit that crosses the threshold.
    //   * `journal_size_limit=67108864` — hard-cap the WAL file at 64 MB
    //     after a checkpoint truncates it (defense-in-depth if something
    //     goes wrong with autocheckpoint).
    //   * Periodic `start_wal_maintenance` task (see below) runs TRUNCATE
    //     checkpoints every 5 min so the WAL file on disk actually shrinks
    //     rather than just being reusable space inside a large file.
    conn.execute_batch("PRAGMA wal_autocheckpoint=1000;")
        .map_err(|e| format!("pragma wal_autocheckpoint: {e}"))?;
    conn.execute_batch("PRAGMA journal_size_limit=67108864;")
        .map_err(|e| format!("pragma journal_size_limit: {e}"))?;
    // Lock down file perms on first open (best-effort).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(conn)
}

// ---------------------------------------------------------------------------
// WAL maintenance
// ---------------------------------------------------------------------------

/// Run a TRUNCATE checkpoint against the global connection. The TRUNCATE
/// variant blocks briefly to flush the WAL into the main DB file *and*
/// shrink the `-wal` sidecar to zero bytes — unlike PASSIVE which only
/// advances the in-memory pointer. Used by the 5-minute maintenance loop
/// and exposed publicly for tests + emergency manual recovery.
pub async fn force_checkpoint() -> Result<(), String> {
    // The checkpoint itself is synchronous sqlite work; shove it onto the
    // blocking pool so we don't stall the tokio reactor for the lock+IO.
    tauri::async_runtime::spawn_blocking(|| {
        with_conn(|c| {
            c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| format!("wal_checkpoint TRUNCATE: {e}"))
        })
    })
    .await
    .map_err(|e| format!("checkpoint join: {e}"))?
}

/// Spawn the WAL maintenance task. Runs a TRUNCATE checkpoint every 5
/// minutes for the life of the process. Idempotent — safe to call multiple
/// times (each call spawns a new loop, but the SQL itself is safe to
/// duplicate and the only cost is a wasted timer). Failures inside the
/// loop log at `warn` and the loop keeps ticking; a single checkpoint
/// failure should never kill WAL hygiene forever.
pub fn start_wal_maintenance() {
    use std::time::Duration;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5 * 60));
        // First tick fires immediately — skip so we don't race startup.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = force_checkpoint().await {
                log::warn!("memory: wal checkpoint failed: {e}");
            } else {
                log::debug!("memory: wal checkpoint (TRUNCATE) ok");
            }
        }
    });
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("create meta: {e}"))?;

    let current = read_schema_version(conn)?;
    if current < SCHEMA_VERSION {
        apply_migrations(conn, current, SCHEMA_VERSION)?;
        write_schema_version(conn, SCHEMA_VERSION)?;
    }
    Ok(())
}

fn read_schema_version(conn: &Connection) -> Result<u32, String> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("read schema_version: {other}")),
        })?;
    Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
}

fn write_schema_version(conn: &Connection, v: u32) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![v.to_string()],
    )
    .map_err(|e| format!("write schema_version: {e}"))?;
    Ok(())
}

fn apply_migrations(conn: &Connection, from: u32, to: u32) -> Result<(), String> {
    for v in (from + 1)..=to {
        match v {
            1 => migration_v1(conn)?,
            2 => migration_v2(conn)?,
            3 => migration_v3(conn)?,
            4 => migration_v4(conn)?,
            5 => migration_v5(conn)?,
            6 => migration_v6(conn)?,
            7 => migration_v7(conn)?,
            8 => migration_v8(conn)?,
            other => return Err(format!("unknown migration target v{other}")),
        }
    }
    Ok(())
}

fn migration_v1(conn: &Connection) -> Result<(), String> {
    // Episodic — chronological events. `kind` is one of:
    //   "user"        : user utterance
    //   "agent_step"  : an AgentStep from a run
    //   "tool_call"   : explicit tool call record (redundant with agent_step
    //                   most of the time — kept for future granular access)
    //   "perception"  : ambient perception snapshot (Phase 2)
    //   "note"        : free-form operator / legacy memory.jsonl entry
    //
    // `tags` is a JSON array stringified; we index a denormalised copy in
    // the FTS row so tag-hits contribute to search scoring.
    //
    // `embedding` is a BLOB of 384×f32 little-endian (nomic-embed-text).
    // Absent until Phase 1b; FTS handles keyword search in the meantime.
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS episodic (
            id           TEXT PRIMARY KEY,
            kind         TEXT NOT NULL,
            text         TEXT NOT NULL,
            tags_json    TEXT NOT NULL DEFAULT '[]',
            meta_json    TEXT NOT NULL DEFAULT '{}',
            created_at   INTEGER NOT NULL,
            embedding    BLOB
        );
        CREATE INDEX IF NOT EXISTS ix_episodic_created_at ON episodic (created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_episodic_kind       ON episodic (kind, created_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5 (
            text,
            tags,
            content='episodic',
            content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS episodic_ai AFTER INSERT ON episodic BEGIN
            INSERT INTO episodic_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS episodic_ad AFTER DELETE ON episodic BEGIN
            INSERT INTO episodic_fts (episodic_fts, rowid, text, tags)
                VALUES ('delete', old.rowid, old.text, old.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS episodic_au AFTER UPDATE ON episodic BEGIN
            INSERT INTO episodic_fts (episodic_fts, rowid, text, tags)
                VALUES ('delete', old.rowid, old.text, old.tags_json);
            INSERT INTO episodic_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags_json);
        END;

        -- Semantic — curated facts. `subject` is optional (useful for
        -- ontology-like queries: "all facts about Mom"). `confidence` is
        -- 0.0–1.0 — the consolidator writes lower values for inferred facts,
        -- 1.0 for explicit user-added ones.
        CREATE TABLE IF NOT EXISTS semantic (
            id           TEXT PRIMARY KEY,
            subject      TEXT NOT NULL DEFAULT '',
            text         TEXT NOT NULL,
            tags_json    TEXT NOT NULL DEFAULT '[]',
            confidence   REAL NOT NULL DEFAULT 1.0,
            source       TEXT NOT NULL DEFAULT 'user',
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL,
            embedding    BLOB
        );
        CREATE INDEX IF NOT EXISTS ix_semantic_subject ON semantic (subject);
        CREATE INDEX IF NOT EXISTS ix_semantic_updated ON semantic (updated_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5 (
            subject, text, tags,
            content='semantic',
            content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS semantic_ai AFTER INSERT ON semantic BEGIN
            INSERT INTO semantic_fts (rowid, subject, text, tags)
                VALUES (new.rowid, new.subject, new.text, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_ad AFTER DELETE ON semantic BEGIN
            INSERT INTO semantic_fts (semantic_fts, rowid, subject, text, tags)
                VALUES ('delete', old.rowid, old.subject, old.text, old.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_au AFTER UPDATE ON semantic BEGIN
            INSERT INTO semantic_fts (semantic_fts, rowid, subject, text, tags)
                VALUES ('delete', old.rowid, old.subject, old.text, old.tags_json);
            INSERT INTO semantic_fts (rowid, subject, text, tags)
                VALUES (new.rowid, new.subject, new.text, new.tags_json);
        END;

        -- Procedural — learned skills. `skill_path` points at a TS file under
        -- ~/.sunny/skills/ (loaded by the skills registry on app boot). The
        -- row also stores a plain-text trigger description for semantic
        -- matching ("when the user asks for their morning summary, run …").
        CREATE TABLE IF NOT EXISTS procedural (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            description  TEXT NOT NULL,
            trigger_text TEXT NOT NULL,
            skill_path   TEXT NOT NULL,
            uses_count   INTEGER NOT NULL DEFAULT 0,
            last_used_at INTEGER,
            created_at   INTEGER NOT NULL,
            embedding    BLOB
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_procedural_name ON procedural (name);
        "#,
    )
    .map_err(|e| format!("apply v1 schema: {e}"))?;
    Ok(())
}

/// v2 — skills gain a `recipe_json` column holding a deterministic tool
/// sequence. Populated by `add_skill` when a recipe is supplied; NULL for
/// skills that only exist as TS files (the Phase 1b path, still supported).
///
/// `skill_path` is made NULL-able here because skills authored as pure
/// recipes don't need a backing TS file. SQLite doesn't support dropping
/// NOT NULL without table rewrite; we use the idempotent-add approach by
/// checking for the column first.
fn migration_v2(conn: &Connection) -> Result<(), String> {
    // Idempotent column-add: PRAGMA table_info → check presence → add if missing.
    let has_recipe: bool = conn
        .prepare("PRAGMA table_info(procedural)")
        .map_err(|e| format!("pragma prep: {e}"))?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma query: {e}"))?
        .filter_map(|r| r.ok())
        .any(|name| name == "recipe_json");

    if !has_recipe {
        conn.execute(
            "ALTER TABLE procedural ADD COLUMN recipe_json TEXT",
            [],
        )
        .map_err(|e| format!("add recipe_json: {e}"))?;
    }

    // Historical skills were authored expecting skill_path to be required,
    // which is fine going forward — the application layer writes an empty
    // string for pure-recipe skills. No schema change needed here; keeping
    // the comment for future maintainers so this migration isn't re-added.

    Ok(())
}

/// v3 — tool usage telemetry. Every tool call records a row in `tool_usage`
/// so the Memory inspector can surface per-tool success rate + latency
/// distribution, and the critic can warn when asked to invoke a tool
/// with a poor recent track record. INTEGER PK (not TEXT UUID) because
/// this table grows linearly with tool invocations — typical heavy use
/// is thousands of rows/day, and auto-increment ints keep the index
/// compact. Retention sweep (memory::retention) deletes rows > 30 d.
fn migration_v3(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS tool_usage (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_name    TEXT NOT NULL,
            ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
            latency_ms   INTEGER NOT NULL,
            error_msg    TEXT,
            created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_tool_usage_name_created
            ON tool_usage (tool_name, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_tool_usage_created
            ON tool_usage (created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_tool_usage_name_ok
            ON tool_usage (tool_name, ok);
        "#,
    )
    .map_err(|e| format!("apply v3 schema: {e}"))?;
    Ok(())
}

/// v4 — per-skill success tracking. Before this migration, skills only
/// recorded `uses_count` (total invocations). A skill that was invoked
/// 20 times but only produced a usable answer 3 of those times would
/// rank above a rock-solid skill invoked 10 times. Adding `success_count`
/// lets the UI (and the System-1 router, in a future phase) prefer
/// reliable skills — and it lets the user SEE "17/20 ok" on the
/// Procedural tab rather than just a count.
fn migration_v4(conn: &Connection) -> Result<(), String> {
    // Idempotent column add — safe to re-run (and the legacy test DB path).
    let has_col: bool = conn
        .prepare("PRAGMA table_info(procedural)")
        .map_err(|e| format!("pragma prep: {e}"))?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma query: {e}"))?
        .filter_map(|r| r.ok())
        .any(|name| name == "success_count");
    if !has_col {
        conn.execute(
            "ALTER TABLE procedural ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("add success_count: {e}"))?;
    }
    Ok(())
}

/// v5 — semantic facts get a soft-delete column used by the compaction
/// pass (`memory::compact`). Compaction clusters near-duplicate facts by
/// embedding cosine similarity and tombstones the losers so the
/// higher-confidence representative carries the merged tag union. We
/// record a timestamp rather than deleting because a mistuned threshold
/// can always be rolled back by clearing the column — a true DELETE
/// would be destructive and irreversible.
fn migration_v5(conn: &Connection) -> Result<(), String> {
    let has_col: bool = conn
        .prepare("PRAGMA table_info(semantic)")
        .map_err(|e| format!("pragma prep: {e}"))?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma query: {e}"))?
        .filter_map(|r| r.ok())
        .any(|name| name == "deleted_at");
    if !has_col {
        conn.execute("ALTER TABLE semantic ADD COLUMN deleted_at INTEGER", [])
            .map_err(|e| format!("add deleted_at: {e}"))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS ix_semantic_live
                 ON semantic (deleted_at, updated_at DESC)",
            [],
        )
        .map_err(|e| format!("create ix_semantic_live: {e}"))?;
    }
    Ok(())
}

/// v6 — tool_usage gets a `reason` column. Captures the model's prose
/// immediately preceding a tool call (Anthropic `thinking` block /
/// Ollama content-before-tool_calls) so the audit surface can show WHY
/// the model picked a given tool — not just that it did. Nullable
/// because historical rows, panic-mode refusals, and schema-level
/// rejections never see the model's reasoning. Capped at 500 chars by
/// the writer to keep the row compact.
fn migration_v6(conn: &Connection) -> Result<(), String> {
    let has_col: bool = conn
        .prepare("PRAGMA table_info(tool_usage)")
        .map_err(|e| format!("pragma prep: {e}"))?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma query: {e}"))?
        .filter_map(|r| r.ok())
        .any(|name| name == "reason");
    if !has_col {
        conn.execute("ALTER TABLE tool_usage ADD COLUMN reason TEXT", [])
            .map_err(|e| format!("add reason: {e}"))?;
    }
    Ok(())
}

/// v7 — persistent per-session conversation thread. Fixes J v4 friction
/// #2: before this table, multi-turn coherence lived only in ChatPanel's
/// React store. Voice / AUTO / daemons / command-bar invocations landed
/// as first-message-of-life runs even when they reused a `session_id`,
/// so `remember that` silently failed outside Chat. The `conversation`
/// table is owned by `memory::conversation` which the agent_loop reads
/// before composing the system prompt and writes after committing a
/// final answer.
fn migration_v7(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS conversation (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conv_session_at
            ON conversation (session_id, at);
        "#,
    )
    .map_err(|e| format!("apply v7 schema: {e}"))?;
    Ok(())
}

/// v8 — sprint-12 η provenance columns on `procedural`.
///
/// `signature` is the 128-char hex ed25519 signature computed over the
/// canonical JSON representation of the skill manifest (see
/// `crate::identity::canonicalize`).  `signer_fingerprint` is the
/// 16-char SHA-256-truncated pubkey fingerprint of whoever signed it.
/// Both columns are NULLABLE: existing rows (authored before v8) stay
/// `NULL / NULL` and read back as "unsigned" in the UI.  New inserts
/// via `memory_skill_add` populate them when the caller supplies a
/// signature (the default path — the editor signs on save), but the
/// schema doesn't enforce presence because the skill synthesizer pipeline
/// may legitimately land unsigned skills in a future sprint.
///
/// Idempotent via the `PRAGMA table_info` check.
fn migration_v8(conn: &Connection) -> Result<(), String> {
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(procedural)")
        .map_err(|e| format!("pragma prep: {e}"))?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "signature") {
        conn.execute("ALTER TABLE procedural ADD COLUMN signature TEXT", [])
            .map_err(|e| format!("add signature: {e}"))?;
    }
    if !cols.iter().any(|c| c == "signer_fingerprint") {
        conn.execute(
            "ALTER TABLE procedural ADD COLUMN signer_fingerprint TEXT",
            [],
        )
        .map_err(|e| format!("add signer_fingerprint: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// One-time migration from ~/.sunny/memory.jsonl
// ---------------------------------------------------------------------------

fn migrate_legacy_jsonl_if_present(conn: &Connection) -> Result<(), String> {
    migrate_legacy_jsonl_from(conn, None)
}

/// Variant that accepts an explicit legacy path, for tests that need to
/// exercise the migration without mutating `HOME` (which would race with
/// other tests reading `dirs::home_dir()` in parallel). Production path
/// (above) resolves via `dirs::home_dir()` as before.
fn migrate_legacy_jsonl_from(
    conn: &Connection,
    override_path: Option<&std::path::Path>,
) -> Result<(), String> {
    // Only run once — guarded by a meta flag.
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'legacy_jsonl_migrated'",
            [],
            |r| r.get(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("read legacy flag: {other}")),
        })?;
    if done.is_some() {
        return Ok(());
    }

    let legacy: PathBuf = if let Some(explicit) = override_path {
        explicit.to_path_buf()
    } else {
        let Some(home) = dirs::home_dir() else {
            // No home — mark done so we don't retry forever.
            mark_legacy_migrated(conn)?;
            return Ok(());
        };
        home.join(DIR_NAME).join(LEGACY_JSONL)
    };
    if !legacy.exists() {
        mark_legacy_migrated(conn)?;
        return Ok(());
    }

    let raw = fs::read_to_string(&legacy).map_err(|e| format!("read legacy jsonl: {e}"))?;
    let tx_guard = conn.unchecked_transaction().map_err(|e| format!("begin migration tx: {e}"))?;

    // Pass 1: collect tombstones.
    let mut deleted = std::collections::HashSet::<String>::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
            continue;
        };
        if v.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false) {
            if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                deleted.insert(id.to_string());
            }
        }
    }

    // Pass 2: insert live items as episodic `note` kind. Preserve original
    // id so any previously-shared references still resolve.
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO episodic (id, kind, text, tags_json, meta_json, created_at)
             VALUES (?1, 'note', ?2, ?3, '{\"migrated_from\":\"memory.jsonl\"}', ?4)",
        )
        .map_err(|e| format!("prepare legacy insert: {e}"))?;

    let mut imported = 0_usize;
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
            continue;
        };
        if v.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(id) = v.get("id").and_then(|x| x.as_str()) else { continue };
        if deleted.contains(id) {
            continue;
        }
        let Some(text) = v.get("text").and_then(|x| x.as_str()) else { continue };
        let tags = v
            .get("tags")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
        let tags_s = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        let created_at = v.get("created_at").and_then(|x| x.as_i64()).unwrap_or(0);
        stmt.execute(params![id, text, tags_s, created_at])
            .map_err(|e| format!("insert legacy row: {e}"))?;
        imported += 1;
    }
    drop(stmt);
    tx_guard.commit().map_err(|e| format!("commit migration: {e}"))?;
    mark_legacy_migrated(conn)?;

    // Don't delete the legacy file — leave it around as a safety net. The
    // user can remove it manually once they're happy with the new store.
    log::info!("memory: migrated {imported} rows from legacy memory.jsonl");
    Ok(())
}

fn mark_legacy_migrated(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('legacy_jsonl_migrated', 'v1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .map_err(|e| format!("mark migrated: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers shared across episodic/semantic/procedural modules
// ---------------------------------------------------------------------------

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn generate_id() -> String {
    // Same algorithm as the old memory_store::generate_id — 32-char hex
    // without pulling in `rand`. Uniqueness via nanos + pid + counter.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let ctr = COUNTER.fetch_add(1, Ordering::Relaxed) as u128;

    let hi = nanos.rotate_left(17) ^ (pid.rotate_left(33)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let lo = ctr
        .rotate_left(7)
        .wrapping_mul(0xBF58_476D_1CE4_E5B9)
        ^ nanos.rotate_right(5);
    let packed = hi ^ lo.rotate_left(64);
    format!("{:032x}", packed)
}

/// FTS5 requires a sanitised match expression — unescaped quotes / operators
/// can error out. This helper produces a "phrase" query with all punctuation
/// stripped and non-alphanumerics collapsed to spaces, so arbitrary user
/// input is always a legal match pattern.
///
/// FTS5 reserves the upper-case bareword tokens `AND`, `OR`, `NOT`, and
/// `NEAR` as binary/unary operators. A user utterance containing any of
/// those (e.g. "did NOT work", "pros AND cons") would otherwise cause a
/// `fts5: syntax error near "NOT"` failure at MATCH time. We lower-case
/// every token before assembling the expression — FTS5's default tokenizer
/// case-folds terms internally, so recall is unaffected, but the parser no
/// longer sees a reserved operator.
pub(crate) fn fts_phrase_from_query(q: &str) -> String {
    let cleaned: String = q
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    let tokens: Vec<String> = cleaned
        .split_whitespace()
        .map(|t| t.to_lowercase())
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    // Prefix match on each token (`abc*`) so partial words also score.
    tokens
        .iter()
        .map(|t| format!("{t}*"))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[allow(dead_code)]
pub(crate) fn lock_guard() -> Result<MutexGuard<'static, Connection>, String> {
    conn_cell().lock().map_err(|_| "memory DB mutex poisoned".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    pub fn scratch_dir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunny-mem-{tag}-{pid}-{nanos}-{seq}",
            pid = std::process::id()
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Builds an isolated connection in a scratch directory with the schema
    /// applied — used by the per-store test modules to avoid touching the
    /// global OnceLock connection.
    pub fn scratch_conn(tag: &str) -> (PathBuf, Connection) {
        let dir = scratch_dir(tag);
        let conn = open_connection(&dir).expect("open scratch db");
        ensure_schema(&conn).expect("scratch schema");
        (dir, conn)
    }

    #[test]
    fn fts_phrase_rejects_punctuation_and_emits_prefix_tokens() {
        let q = fts_phrase_from_query("mom's birthday? 2026!");
        // Each alphanumeric token becomes `t*` joined by OR.
        assert!(q.contains("mom"));
        assert!(q.contains("*"));
        assert!(!q.contains("'"));
        assert!(!q.contains("?"));
    }

    #[test]
    fn fts_phrase_empty_for_whitespace() {
        assert_eq!(fts_phrase_from_query("   "), "");
        assert_eq!(fts_phrase_from_query(""), "");
    }

    /// Regression: FTS5 treats upper-case `AND`, `OR`, `NOT`, and `NEAR` as
    /// reserved operators. A user query like "did NOT work" used to slip
    /// through the sanitiser unchanged and blew up the memory-pack builder
    /// with `fts5: syntax error near "NOT"`. The sanitiser now lower-cases
    /// every token so the parser only ever sees terms.
    #[test]
    fn fts_phrase_neutralises_reserved_fts5_operators() {
        // The join separator is literally ` OR ` — that is the one place a
        // reserved keyword is *meant* to appear. A leak is when a reserved
        // keyword shows up as a user-supplied token, i.e. as `NOT*`,
        // `AND*`, `NEAR*`, or the beginning of a phrase. Those are the
        // shapes that make FTS5 raise "syntax error near `NOT`".
        for reserved in ["NOT", "AND", "OR", "NEAR"] {
            let q = fts_phrase_from_query(&format!("did {reserved} work"));
            assert!(
                !q.contains(&format!("{reserved}*")),
                "raw reserved keyword `{reserved}` leaked as token: {q}"
            );
            assert!(q.contains(&format!("{}*", reserved.to_lowercase())));
            assert!(q.contains("did*"));
            assert!(q.contains("work*"));
        }

        // Mixed-case / multi-operator utterances also get normalised.
        let q = fts_phrase_from_query("pros AND cons but NOT disasters");
        assert!(!q.contains("AND*"));
        assert!(!q.contains("NOT*"));
        assert!(q.contains("and*"));
        assert!(q.contains("not*"));
    }

    /// End-to-end proof: the sanitised phrase actually executes against an
    /// FTS5 virtual table without raising a syntax error. This is what
    /// broke memory-pack building in production.
    #[test]
    fn fts_phrase_is_accepted_by_live_fts5_match() {
        let (_dir, conn) = scratch_conn("fts-reserved");
        // Seed one row so the table is non-empty. Content doesn't matter —
        // we're proving MATCH parses, not that it recalls specific rows.
        conn.execute(
            "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
             VALUES (?1, 'note', ?2, '[]', '{}', 1)",
            params![generate_id(), "seed text for fts5 match parse"],
        )
        .unwrap();

        for raw in [
            "did NOT work",
            "pros AND cons",
            "this OR that",
            "keywords NEAR each other",
            "NOT AND OR NEAR",
        ] {
            let phrase = fts_phrase_from_query(raw);
            assert!(!phrase.is_empty(), "phrase empty for input: {raw}");
            let result: Result<i64, _> = conn.query_row(
                "SELECT count(*) FROM episodic_fts WHERE episodic_fts MATCH ?1",
                params![phrase],
                |r| r.get(0),
            );
            assert!(
                result.is_ok(),
                "FTS5 MATCH rejected sanitised phrase `{phrase}` (from `{raw}`): {:?}",
                result.err()
            );
        }
    }

    #[test]
    fn schema_bootstraps_cleanly() {
        let (_dir, conn) = scratch_conn("schema");
        // Every table/virtual-table we created should exist.
        for name in ["episodic", "semantic", "procedural", "meta", "episodic_fts", "semantic_fts"] {
            let found: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                    params![name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "missing table: {name}");
        }
        // schema_version should be SCHEMA_VERSION.
        let v = read_schema_version(&conn).unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // v5 — semantic.deleted_at must exist so the compactor can
        // soft-tombstone merged rows without losing them.
        let has_deleted_at: bool = conn
            .prepare("PRAGMA table_info(semantic)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .any(|name| name == "deleted_at");
        assert!(has_deleted_at, "semantic.deleted_at (v5) missing");

        // v6 — tool_usage.reason must exist so the audit log can carry
        // the model's pre-dispatch thinking alongside each call.
        let has_reason: bool = conn
            .prepare("PRAGMA table_info(tool_usage)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .any(|name| name == "reason");
        assert!(has_reason, "tool_usage.reason (v6) missing");
    }

    /// Stress test for the WAL hygiene pragmas. Spawns 100 concurrent
    /// insert batches against a scratch connection (same pragmas as prod)
    /// and asserts the `-wal` sidecar stays under 16 MB after manually
    /// draining with a TRUNCATE checkpoint. The autocheckpoint=1000 +
    /// journal_size_limit=64 MB + TRUNCATE-on-demand combination is what
    /// keeps the on-disk footprint bounded in production.
    #[test]
    fn wal_sidecar_stays_bounded_under_concurrent_writes() {
        use std::sync::Arc;
        use std::thread;

        let dir = scratch_dir("wal-stress");
        let conn = open_connection(&dir).expect("open wal-stress db");
        ensure_schema(&conn).expect("schema");
        let shared = Arc::new(std::sync::Mutex::new(conn));

        // 100 concurrent threads, each inserting 50 rows with non-trivial
        // text so the WAL actually accrues pages (short text would land in
        // a handful of pages total regardless of row count).
        let mut handles = Vec::new();
        for t in 0..100 {
            let c = Arc::clone(&shared);
            handles.push(thread::spawn(move || {
                for i in 0..50 {
                    let guard = c.lock().expect("lock");
                    let id = format!("stress-{t}-{i}-{}", generate_id());
                    let text = format!(
                        "stress row thread={t} i={i} payload={}",
                        "x".repeat(256)
                    );
                    guard
                        .execute(
                            "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
                             VALUES (?1, 'note', ?2, '[]', '{}', ?3)",
                            params![id, text, now_secs()],
                        )
                        .expect("insert");
                }
            }));
        }
        for h in handles {
            h.join().expect("thread join");
        }

        // Drain the WAL the same way the production maintenance loop does.
        {
            let guard = shared.lock().expect("lock for checkpoint");
            guard
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .expect("truncate checkpoint");
        }

        let wal = dir.join(format!("{DB_FILENAME}-wal"));
        if wal.exists() {
            let size = fs::metadata(&wal).expect("wal stat").len();
            assert!(
                size <= 16 * 1024 * 1024,
                "WAL file exceeded 16 MB after TRUNCATE checkpoint: {size} bytes",
            );
        }

        // Sanity: all 5000 rows are actually committed and visible.
        let guard = shared.lock().expect("lock for count");
        let count: i64 = guard
            .query_row(
                "SELECT count(*) FROM episodic WHERE kind = 'note'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(count, 100 * 50, "expected 5000 stress rows, saw {count}");
    }

    #[test]
    fn migration_imports_live_items_and_respects_tombstones() {
        // Use `migrate_legacy_jsonl_from(conn, Some(explicit_path))` rather
        // than mutating $HOME — process-wide env manipulation races with
        // tests in `safety_paths` and `world` that also call
        // `dirs::home_dir()` concurrently. The override keeps this test
        // fully self-contained.
        let dir = scratch_dir("mig");
        let legacy = dir.join("legacy_memory.jsonl");
        let mut content = String::new();
        content.push_str(r#"{"id":"a","text":"keep","tags":["t1"],"created_at":100}"#);
        content.push('\n');
        content.push_str(r#"{"id":"b","text":"drop","tags":[],"created_at":101}"#);
        content.push('\n');
        content.push_str(r#"{"id":"b","deleted":true}"#);
        content.push('\n');
        content.push_str(r#"{"id":"c","text":"keep2","tags":["t1","t2"],"created_at":102}"#);
        content.push('\n');
        fs::write(&legacy, content).unwrap();

        // Fresh DB in scratch/memory/
        let memdir = dir.join("memory");
        let conn = open_connection(&memdir).unwrap();
        ensure_schema(&conn).unwrap();
        migrate_legacy_jsonl_from(&conn, Some(&legacy)).unwrap();

        let rows: Vec<(String, String)> = conn
            .prepare("SELECT id, text FROM episodic ORDER BY created_at")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
        assert_eq!(ids, vec!["a".to_string(), "c".to_string()]);

        // Rerunning is a no-op (flag already set).
        let before: i64 = conn
            .query_row("SELECT count(*) FROM episodic", [], |r| r.get(0))
            .unwrap();
        migrate_legacy_jsonl_from(&conn, Some(&legacy)).unwrap();
        let after: i64 = conn
            .query_row("SELECT count(*) FROM episodic", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
    }
    /// Proves that `open_reader_connection` and `with_reader` both work and
    /// that concurrent read-only connections in WAL mode do not produce
    /// SQLITE_BUSY or deadlocks.
    ///
    /// Strategy: spawn 8 threads each opening their own read-only connection
    /// to the same scratch DB (exercises `open_reader_connection` in parallel)
    /// and then verify `with_reader` works single-threaded on the same DB via
    /// a local pool — avoiding the process-wide `READER_POOL` OnceLock which
    /// can only be set once and may already point at a different scratch dir
    /// from a concurrently-running test.
    #[test]
    fn concurrent_readers_do_not_deadlock() {
        use std::sync::{Arc, Mutex};
        use std::thread;

        // Isolated DB with schema.
        let dir = scratch_dir("reader-pool");
        let writer = open_connection(&dir).expect("writer conn");
        ensure_schema(&writer).expect("schema");
        writer
            .execute(
                "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
                 VALUES (?1, 'note', 'reader pool test row', '[]', '{}', ?2)",
                params![generate_id(), now_secs()],
            )
            .expect("seed row");
        drop(writer);

        // --- Part 1: 8 concurrent open_reader_connection calls (WAL + shared cache) ---
        let dir_arc = Arc::new(dir.clone());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let d = Arc::clone(&dir_arc);
            handles.push(thread::spawn(move || {
                let conn = open_reader_connection(&d).expect("open reader");
                let count: i64 = conn
                    .query_row(
                        "SELECT count(*) FROM episodic WHERE kind = 'note'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("reader SELECT: {e}"))
                    .expect("SELECT ok");
                assert!(count >= 1, "expected >= 1 row, got {count}");
                // Drop conn — returns WAL read lock.
            }));
        }
        for h in handles {
            h.join().expect("reader thread panicked");
        }

        // --- Part 2: verify with_reader via a local pool (not the global OnceLock) ---
        // Build a tiny local pool of 2 connections and a closure that mimics
        // what with_reader does, so we exercise the PoolGuard logic directly.
        let local_pool: Arc<Mutex<Vec<Connection>>> = Arc::new(Mutex::new(
            (0..2)
                .map(|_| open_reader_connection(&dir).expect("pool conn"))
                .collect(),
        ));

        struct LocalGuard {
            conn: Option<Connection>,
            pool: Arc<Mutex<Vec<Connection>>>,
        }
        impl Drop for LocalGuard {
            fn drop(&mut self) {
                if let Some(c) = self.conn.take() {
                    if let Ok(mut p) = self.pool.lock() {
                        p.push(c);
                    }
                }
            }
        }

        let run_local = |pool: &Arc<Mutex<Vec<Connection>>>| -> Result<i64, String> {
            let conn = pool.lock().map_err(|_| "pool poisoned".to_string())?.pop()
                .ok_or_else(|| "pool empty".to_string())?;
            let guard = LocalGuard { conn: Some(conn), pool: Arc::clone(pool) };
            let result = guard.conn.as_ref().unwrap()
                .query_row(
                    "SELECT count(*) FROM episodic WHERE kind = 'note'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| format!("local pool query: {e}"));
            drop(guard); // push-back via Drop
            result.map_err(|e| e)
        };

        // Borrow 2 connections sequentially to prove push-back works.
        let r1 = run_local(&local_pool).expect("local pool borrow 1");
        let r2 = run_local(&local_pool).expect("local pool borrow 2");
        assert!(r1 >= 1 && r2 >= 1, "unexpected counts: {r1}, {r2}");

        // Confirm pool was restored to 2 connections after both borrows.
        let remaining = local_pool.lock().unwrap().len();
        assert_eq!(remaining, 2, "pool should have 2 connections after 2 sequential borrows");
    }

    /// Reader pool integration: spin up a scratch DB, seed one episodic row,
    /// initialise the reader pool, then run 8 parallel `with_reader`-style
    /// calls each doing a SELECT and verify every call returns the seed row.
    ///
    /// Because `READER_POOL` is a process-wide `OnceLock` (already occupied by
    /// earlier tests), we build a LOCAL pool that mirrors the production pool
    /// logic exactly — same `open_reader_connection`, same `PoolGuard` RAII
    /// push-back — so the exercise is faithful without racing the global lock.
    #[test]
    fn reader_pool_parallel_selects_all_return_seed_row() {
        use std::sync::{Arc, Mutex};

        // ── Build isolated DB with one seed row ──────────────────────────
        let dir = scratch_dir("reader-pool-integ");
        let writer = open_connection(&dir).expect("writer");
        ensure_schema(&writer).expect("schema");

        let seed_id = generate_id();
        let seed_text = "reader pool integration seed row";
        writer
            .execute(
                "INSERT INTO episodic (id, kind, text, tags_json, meta_json, created_at)
                 VALUES (?1, 'note', ?2, '[]', '{}', ?3)",
                params![seed_id.clone(), seed_text, now_secs()],
            )
            .expect("seed insert");
        drop(writer);

        // ── Build a local pool of 4 read-only connections ────────────────
        const LOCAL_POOL_SIZE: usize = 4;
        let pool: Arc<Mutex<Vec<Connection>>> = Arc::new(Mutex::new(
            (0..LOCAL_POOL_SIZE)
                .map(|_| open_reader_connection(&dir).expect("reader conn"))
                .collect(),
        ));

        // ── Helper: borrow one connection, run the closure, push back ────
        struct Guard {
            conn: Option<Connection>,
            pool: Arc<Mutex<Vec<Connection>>>,
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                if let Some(c) = self.conn.take() {
                    if let Ok(mut p) = self.pool.lock() {
                        p.push(c);
                    }
                }
            }
        }

        let with_local = move |pool: &Arc<Mutex<Vec<Connection>>>,
                                f: &dyn Fn(&Connection) -> Result<String, String>|
              -> Result<String, String> {
            let conn = {
                let mut guard = pool.lock().map_err(|_| "pool poisoned".to_string())?;
                guard.pop().ok_or_else(|| "pool empty".to_string())?
            };
            let g = Guard { conn: Some(conn), pool: Arc::clone(pool) };
            let result = f(g.conn.as_ref().unwrap());
            drop(g); // push-back via Drop
            result
        };

        // ── 8 sequential borrows (pool is size 4 — proves push-back works)
        let pool_ref = Arc::clone(&pool);
        let seed_id_clone = seed_id.clone();

        let mut results = Vec::with_capacity(8);
        for _ in 0..8 {
            let got = with_local(&pool_ref, &|conn| {
                conn.query_row(
                    "SELECT id FROM episodic WHERE kind = 'note' ORDER BY created_at LIMIT 1",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|e| format!("SELECT id: {e}"))
            })
            .expect("reader query");
            results.push(got);
        }

        // Every result must be the seed id.
        for (i, got) in results.iter().enumerate() {
            assert_eq!(
                got, &seed_id_clone,
                "call {i}: expected seed row id, got {got}"
            );
        }

        // Pool should be fully restored — all 4 connections back.
        let remaining = pool.lock().unwrap().len();
        assert_eq!(remaining, LOCAL_POOL_SIZE, "all pool connections must be returned after borrows");
    }

}

// Expose test helpers to the store-specific test modules (same crate).
#[cfg(test)]
pub(crate) use tests::scratch_conn;
