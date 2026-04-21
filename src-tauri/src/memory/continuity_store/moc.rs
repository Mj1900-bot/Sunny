//! MOC (Map of Content) auto-generation.
//!
//! `project_moc(conn, project_slug)` scans for all non-deleted nodes whose
//! summary contains `[[project_slug]]` (i.e. backlinks) and regenerates a
//! MOC node that lists every linked thread, decision, session, and artifact.
//!
//! The MOC node has:
//!   slug  = "<project_slug>-moc"
//!   kind  = NodeKind::Moc
//!   title = "MOC: <project_slug>"
//!   summary = generated index body (wikilinks to all backlinkers)
//!   tags  = ["#moc"]
//!
//! This mirrors Obsidian's "Map of Content" pattern: the MOC is just another
//! node whose summary is reconstructed on demand — never stale because it
//! regenerates on every call.

use rusqlite::{Connection, params};
use crate::memory::continuity_store::schema::now_secs;
use crate::memory::continuity_store::{Node, NodeKind};

/// Regenerate and upsert the MOC node for `project_slug`.
/// Returns the freshly-written MOC `Node`.
pub fn regenerate(conn: &Connection, project_slug: &str) -> Result<Node, String> {
    let moc_slug = format!("{project_slug}-moc");
    let pattern = format!("%[[{project_slug}]]%");

    // Collect all non-deleted backlinkers ordered by updated_ts desc.
    let mut stmt = conn
        .prepare(
            "SELECT slug, kind, title FROM nodes
             WHERE summary LIKE ?1
               AND deleted_at IS NULL
               AND slug != ?2
             ORDER BY updated_ts DESC",
        )
        .map_err(|e| format!("moc prepare: {e}"))?;

    let rows: Vec<(String, String, String)> = stmt
        .query_map(params![pattern, moc_slug], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| format!("moc query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Build the index body — one line per linked node.
    let mut body = format!("# MOC: {project_slug}\n\n");
    if rows.is_empty() {
        body.push_str("_No linked nodes yet._\n");
    } else {
        for (slug, kind, title) in &rows {
            body.push_str(&format!("- [[{slug}]] ({kind}) — {title}\n"));
        }
    }
    body.push('\n');
    body.push_str(&format!("_Regenerated at {}_", now_secs()));

    let tags = serde_json::json!(["#moc"]).to_string();
    let title = format!("MOC: {project_slug}");
    let ts = now_secs();

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
        params![moc_slug, "Moc", title, body, tags, ts, ts],
    )
    .map_err(|e| format!("moc upsert: {e}"))?;

    Ok(Node {
        slug: moc_slug,
        kind: NodeKind::Moc,
        title,
        summary: body,
        tags: vec!["#moc".to_string()],
        created_ts: ts,
        updated_ts: ts,
        deleted_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::continuity_store::schema::ensure_schema;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn seed_node(conn: &Connection, slug: &str, kind: &str, title: &str, summary: &str) {
        let ts = now_secs();
        conn.execute(
            "INSERT OR REPLACE INTO nodes (slug, kind, title, summary, tags, created_ts, updated_ts)
             VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)",
            params![slug, kind, title, summary, ts, ts],
        )
        .expect("seed node");
    }

    fn scratch_continuity(tag: &str) -> (std::path::PathBuf, Connection) {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "sunny-moc-{tag}-{pid}-{nanos}-{seq}",
            pid = std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let conn = Connection::open(dir.join("continuity.db")).expect("open db");
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        ensure_schema(&conn).expect("continuity schema");
        (dir, conn)
    }

    #[test]
    fn moc_regen_builds_index_of_backlinkers() {
        let (_dir, conn) = scratch_continuity("moc-basic");
        seed_node(&conn, "my-project", "Project", "My Project", "Top-level project.");
        seed_node(&conn, "session-1", "Session", "Session 1", "Worked on [[my-project]].");
        seed_node(&conn, "decision-1", "Decision", "Decision 1", "Decided approach for [[my-project]].");

        let moc = regenerate(&conn, "my-project").unwrap();
        assert!(moc.summary.contains("[[session-1]]"), "MOC should reference session-1");
        assert!(moc.summary.contains("[[decision-1]]"), "MOC should reference decision-1");
        assert_eq!(moc.slug, "my-project-moc");
        assert!(moc.tags.contains(&"#moc".to_string()));
    }

    #[test]
    fn moc_regen_is_idempotent() {
        let (_dir, conn) = scratch_continuity("moc-idempotent");
        seed_node(&conn, "proj", "Project", "Proj", "A project.");
        seed_node(&conn, "s1", "Session", "S1", "Refs [[proj]].");

        let moc1 = regenerate(&conn, "proj").unwrap();
        let moc2 = regenerate(&conn, "proj").unwrap();
        // Both calls should produce the same slug without duplicating the node.
        assert_eq!(moc1.slug, moc2.slug);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM nodes WHERE slug = 'proj-moc'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "MOC node must not be duplicated");
    }

    #[test]
    fn moc_empty_project_has_placeholder() {
        let (_dir, conn) = scratch_continuity("moc-empty");
        seed_node(&conn, "lonely-proj", "Project", "Lonely", "Nobody links here.");

        let moc = regenerate(&conn, "lonely-proj").unwrap();
        assert!(moc.summary.contains("No linked nodes yet"), "empty MOC must have placeholder");
    }
}
