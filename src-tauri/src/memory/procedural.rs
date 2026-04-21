//! Procedural memory — learned/runnable skills.
//!
//! A skill is a named bundle of:
//!   * metadata (description, trigger text for embedding-based retrieval)
//!   * an optional pointer to a TypeScript file under `~/.sunny/skills/`
//!   * an optional **recipe** — a deterministic tool sequence the
//!     System-1 executor can run directly, bypassing the LLM planning
//!     loop when goal→skill similarity clears a threshold.
//!
//! The agent writes skills into this table from two paths:
//!   * Manual authorship — UI or JSON import.
//!   * (Future 1d) Skill synthesis — when a recurring goal has a
//!     reproducible successful tool trace, the consolidator compiles it
//!     into a recipe and writes it here.
//!
//! The System-1 router in `src/lib/agentLoop.ts` reads
//! `MemoryPack.matched_skills` on each run and executes the top match
//! when its cosine similarity exceeds the execute threshold. Every
//! successful run calls `bump_use` which drives the ordering of
//! `list_skills` (most-used first).

use rusqlite::params;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::db::{generate_id, now_secs, with_conn, with_reader};

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ProceduralSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Plain-text description of *when* to fire the skill. Embedded so the
    /// context pack's cosine rerank can surface this skill for matching
    /// goals.
    pub trigger_text: String,
    /// Path to a TS source file under `~/.sunny/skills/` — may be empty when
    /// the skill is a pure recipe that needs no back-end code.
    pub skill_path: String,
    #[ts(type = "number")]
    pub uses_count: i64,
    /// How many of `uses_count` invocations produced a `done` status. Added
    /// in schema v4; defaults to 0 on pre-v4 rows. Surfaced in the UI as
    /// "N/M ok" and actively used by [`list_skills`] to rank retrieval:
    /// the ORDER BY computes a Laplace-smoothed success rate
    /// `(success_count + 1) / (uses_count + 2)` so fresh skills stay neutral
    /// (0/0 → 0.5) while high-volume successful skills rise to the top.
    #[serde(default)]
    #[ts(type = "number")]
    pub success_count: i64,
    #[ts(type = "number | null")]
    pub last_used_at: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    /// Deterministic tool sequence. `None` when the skill is script-backed
    /// (old path) rather than recipe-backed. Stored as JSON opaque to Rust
    /// — the executor in `src/lib/skillExecutor.ts` interprets the shape.
    #[serde(default)]
    #[ts(type = "unknown")]
    pub recipe: Option<serde_json::Value>,
    /// Sprint-12 η — hex-encoded ed25519 signature over the canonical
    /// manifest (`{name, description, trigger_text, recipe}`). `None`
    /// means "unsigned" — either a legacy row authored before v8 or a
    /// skill deliberately imported without provenance. The import UI
    /// warns on `None` and rejects on signature mismatch.
    #[serde(default)]
    pub signature: Option<String>,
    /// 16-char hex fingerprint of the signer's public key
    /// (`SHA-256(pub)[0..8]`). `None` when `signature` is `None`. Used
    /// as the key into the trust-on-first-use store so the UI can ask
    /// "trust this signer?" rather than showing a raw pubkey.
    #[serde(default)]
    pub signer_fingerprint: Option<String>,
}

pub fn add_skill(
    name: String,
    description: String,
    trigger_text: String,
    skill_path: String,
    recipe: Option<serde_json::Value>,
    signature: Option<String>,
    signer_fingerprint: Option<String>,
) -> Result<ProceduralSkill, String> {
    let skill = with_conn(|c| {
        if name.trim().is_empty() {
            return Err("procedural: name must not be empty".into());
        }
        // `skill_path` is optional now — pure-recipe skills have no backing
        // TS file. When provided, it still has to look like a TS/TSX file.
        if !skill_path.is_empty()
            && !skill_path.ends_with(".ts")
            && !skill_path.ends_with(".tsx")
        {
            return Err("procedural: skill_path must be a .ts/.tsx file or empty".into());
        }
        // At least one of: a recipe or a skill_path. An empty skill is useless.
        if recipe.is_none() && skill_path.is_empty() {
            return Err("procedural: provide either a recipe or a skill_path".into());
        }

        // Provenance fields are paired: either both present or both absent.
        // A signature without a fingerprint (or vice versa) would prevent
        // the UI from showing a meaningful trust prompt.
        if signature.is_some() != signer_fingerprint.is_some() {
            return Err(
                "procedural: signature and signer_fingerprint must be provided together"
                    .into(),
            );
        }

        let recipe_json = match &recipe {
            Some(v) => Some(serde_json::to_string(v).map_err(|e| format!("encode recipe: {e}"))?),
            None => None,
        };

        let id = generate_id();
        let created_at = now_secs();
        c.execute(
            "INSERT INTO procedural
                (id, name, description, trigger_text, skill_path,
                 uses_count, last_used_at, created_at, recipe_json,
                 signature, signer_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7, ?8, ?9)",
            params![
                id,
                name,
                description,
                trigger_text,
                skill_path,
                created_at,
                recipe_json,
                signature,
                signer_fingerprint,
            ],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(_, Some(s)) if s.contains("UNIQUE") => {
                format!("procedural: skill named '{name}' already exists")
            }
            other => format!("insert procedural: {other}"),
        })?;
        Ok(ProceduralSkill {
            id,
            name,
            description,
            trigger_text,
            skill_path,
            uses_count: 0,
            success_count: 0,
            last_used_at: None,
            created_at,
            recipe,
            signature,
            signer_fingerprint,
        })
    })?;
    // Embed the "trigger + description" so goal→skill matching reflects
    // *when* the skill applies, not just its name. Empty triggers fall back
    // to the description.
    let embed_text = if skill.trigger_text.trim().is_empty() {
        skill.description.clone()
    } else {
        format!("{} — {}", skill.trigger_text, skill.description)
    };
    super::embed::spawn_embed_for("procedural", skill.id.clone(), embed_text);
    Ok(skill)
}

/// Shared ORDER BY clause for skill retrieval. Ranks by Laplace-smoothed
/// success rate first: `(success_count + 1) / (uses_count + 2)`. This
/// treats fresh skills (0/0) as neutral (0.5) while letting high-volume
/// reliable skills dominate (e.g. 9/10 → 10/12 ≈ 0.83) and aggressively
/// demoting high-volume failures (e.g. 2/10 → 3/12 ≈ 0.25). Secondary
/// sorts on `uses_count` then `created_at` break ties deterministically.
/// Tests in this module rely on this exact clause to stay in sync with
/// production ordering.
pub(super) const SKILL_RANK_ORDER_BY: &str =
    "ORDER BY (CAST(success_count + 1 AS REAL) / CAST(uses_count + 2 AS REAL)) DESC, \
              uses_count DESC, \
              created_at DESC";

pub fn list_skills() -> Result<Vec<ProceduralSkill>, String> {
    with_reader(|c| { // read-only path → reader pool
        let sql = format!(
            "SELECT id, name, description, trigger_text, skill_path,
                    uses_count, last_used_at, created_at, recipe_json, success_count,
                    signature, signer_fingerprint
             FROM procedural
             {SKILL_RANK_ORDER_BY}",
        );
        let mut stmt = c
            .prepare_cached(&sql)
            .map_err(|e| format!("prepare procedural list: {e}"))?;
        let rows = stmt
            .query_map([], row_to_skill)
            .map_err(|e| format!("query procedural list: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect procedural list: {e}"))?;
        Ok(rows)
    })
}

/// Single-skill fetch including the recipe. Used by the System-1 router
/// when the context pack has narrowed to a winner and needs the recipe to
/// execute. Returns `Ok(None)` on a missing id (treated as a soft miss —
/// callers fall back to the LLM loop rather than erroring).
pub fn get_skill(id: String) -> Result<Option<ProceduralSkill>, String> {
    with_reader(|c| { // read-only path → reader pool
        let mut stmt = c
            .prepare_cached(
                "SELECT id, name, description, trigger_text, skill_path,
                        uses_count, last_used_at, created_at, recipe_json, success_count,
                        signature, signer_fingerprint
                 FROM procedural
                 WHERE id = ?1",
            )
            .map_err(|e| format!("prepare get skill: {e}"))?;
        let mut rows = stmt
            .query_map(params![id], row_to_skill)
            .map_err(|e| format!("query get skill: {e}"))?;
        match rows.next() {
            Some(r) => r.map(Some).map_err(|e| format!("row get skill: {e}")),
            None => Ok(None),
        }
    })
}

/// Increment `uses_count` (and optionally `success_count`) and stamp
/// `last_used_at` to now. Called by the System-1 router after every
/// skill execution — `success=true` when the run reached `done`,
/// `false` when it aborted or errored out. This gives the UI a real
/// reliability ratio ("17/20 ok") and lets future routing prefer
/// skills that have actually worked.
pub fn bump_use(id: String, success: bool) -> Result<ProceduralSkill, String> {
    with_conn(|c| {
        let now = now_secs();
        let sql = if success {
            "UPDATE procedural
             SET uses_count = uses_count + 1,
                 success_count = success_count + 1,
                 last_used_at = ?1
             WHERE id = ?2"
        } else {
            "UPDATE procedural
             SET uses_count = uses_count + 1,
                 last_used_at = ?1
             WHERE id = ?2"
        };
        let updated = c
            .execute(sql, params![now, id])
            .map_err(|e| format!("bump_use update: {e}"))?;
        if updated == 0 {
            return Err(format!("procedural: no skill with id '{id}'"));
        }
        // Re-read so the caller sees the fresh uses_count / last_used_at.
        let mut stmt = c
            .prepare_cached(
                "SELECT id, name, description, trigger_text, skill_path,
                        uses_count, last_used_at, created_at, recipe_json, success_count,
                        signature, signer_fingerprint
                 FROM procedural
                 WHERE id = ?1",
            )
            .map_err(|e| format!("bump_use reread prep: {e}"))?;
        let mut rows = stmt
            .query_map(params![id], row_to_skill)
            .map_err(|e| format!("bump_use reread query: {e}"))?;
        match rows.next() {
            Some(r) => r.map_err(|e| format!("bump_use reread row: {e}")),
            None => Err("procedural: row vanished after bump".into()),
        }
    })
}

pub fn delete_skill(id: String) -> Result<(), String> {
    with_conn(|c| {
        c.execute("DELETE FROM procedural WHERE id = ?1", params![id])
            .map_err(|e| format!("delete procedural: {e}"))?;
        Ok(())
    })
}

/// Edit a skill in place. Every field is optional — an absent field means
/// "keep the current value". Used by the Memory → Procedural tab's inline
/// edit affordance. Name conflicts (unique index) surface as
/// `"skill named 'X' already exists"` the same way `add_skill` does.
///
/// On recipe change, triggers a re-embed: the trigger_text / description
/// change invalidates the stored embedding, so we spawn a fresh embed
/// task. An unavailable Ollama just leaves the old embedding in place —
/// it still matches reasonably until the user runs another turn.
///
/// Implementation: a single atomic UPDATE within a transaction using
/// COALESCE(?new, existing_col) — one SQL round-trip regardless of how
/// many fields the caller changes. This replaces the previous N-UPDATE
/// pattern (up to 4 separate statements) and eliminates the window where
/// a crash between two updates could leave the row partially updated.
pub fn update_skill(
    id: String,
    name: Option<String>,
    description: Option<String>,
    trigger_text: Option<String>,
    recipe: Option<Option<serde_json::Value>>, // double-option: None=skip, Some(None)=clear
) -> Result<ProceduralSkill, String> {
    with_conn(|c| {
        // Validate inputs before touching the DB.
        if let Some(ref n) = name {
            if n.trim().is_empty() {
                return Err("procedural: name must not be empty".into());
            }
        }

        // Encode the recipe when the caller wants to change it.
        // `recipe` is `Option<Option<Value>>`:
        //   None              → caller didn't touch recipe → pass NULL to COALESCE → keep existing
        //   Some(None)        → caller explicitly clears it → store NULL
        //   Some(Some(v))     → caller sets a new value      → encode as JSON string
        let recipe_encoded: Option<Option<String>> = match recipe {
            None => None, // no-op: COALESCE keeps existing column value
            Some(None) => Some(None), // explicit clear
            Some(Some(ref v)) => Some(Some(
                serde_json::to_string(v).map_err(|e| format!("encode recipe: {e}"))?,
            )),
        };

        // Single atomic UPDATE. COALESCE(?param, col) means: use the
        // parameter when it is NOT NULL, otherwise keep the existing
        // column value. For the recipe column we need a second level of
        // option — ?5 being NULL means "keep existing" (recipe=None
        // arm), while ?5 being a sentinel triggers a NULL-set; we handle
        // this by using the CASE expression below.
        //
        // All four columns are updated in one statement, which also means
        // the UNIQUE constraint on `name` is checked atomically — no
        // risk of partial updates on constraint violation.
        let recipe_param: Option<String> = recipe_encoded.clone().unwrap_or(None);
        // When recipe_encoded is None we want COALESCE to keep existing;
        // when it is Some(None) we want to store NULL; when Some(Some(s))
        // we want to store the string. We model this with a second
        // boolean flag rather than trying to fit three states into one
        // nullable param.
        let clear_recipe: bool = matches!(recipe_encoded, Some(None));

        let sql = if clear_recipe {
            "UPDATE procedural
             SET name        = COALESCE(?1, name),
                 description = COALESCE(?2, description),
                 trigger_text= COALESCE(?3, trigger_text),
                 recipe_json  = NULL
             WHERE id = ?4"
        } else {
            "UPDATE procedural
             SET name        = COALESCE(?1, name),
                 description = COALESCE(?2, description),
                 trigger_text= COALESCE(?3, trigger_text),
                 recipe_json  = COALESCE(?5, recipe_json)
             WHERE id = ?4"
        };

        let updated = if clear_recipe {
            c.execute(
                sql,
                rusqlite::params![name, description, trigger_text, id],
            )
        } else {
            c.execute(
                sql,
                rusqlite::params![name, description, trigger_text, id, recipe_param],
            )
        }
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(_, Some(s)) if s.contains("UNIQUE") => {
                let n = name.as_deref().unwrap_or("<unchanged>");
                format!("procedural: skill named '{n}' already exists")
            }
            other => format!("update skill: {other}"),
        })?;

        if updated == 0 {
            return Err(format!("procedural: no skill with id '{id}'"));
        }

        // Re-read the updated row so the returned struct reflects the
        // actual DB state (COALESCE keeps old values we didn't supply).
        let mut stmt = c
            .prepare_cached(
                "SELECT id, name, description, trigger_text, skill_path,
                        uses_count, last_used_at, created_at, recipe_json, success_count,
                        signature, signer_fingerprint
                 FROM procedural WHERE id = ?1",
            )
            .map_err(|e| format!("update reread prep: {e}"))?;
        let mut rows = stmt
            .query_map(params![id], row_to_skill)
            .map_err(|e| format!("update reread: {e}"))?;
        let updated_skill = match rows.next() {
            Some(r) => r.map_err(|e| format!("update reread row: {e}"))?,
            None => return Err(format!("procedural: row vanished after update '{id}'")),
        };

        // Trigger re-embed when text-shaped fields changed.
        let text_changed = description.is_some() || trigger_text.is_some();
        if text_changed {
            let embed_text = if updated_skill.trigger_text.trim().is_empty() {
                updated_skill.description.clone()
            } else {
                format!("{} — {}", updated_skill.trigger_text, updated_skill.description)
            };
            super::embed::spawn_embed_for("procedural", updated_skill.id.clone(), embed_text);
        }
        Ok(updated_skill)
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn row_to_skill(r: &rusqlite::Row) -> rusqlite::Result<ProceduralSkill> {
    let recipe_s: Option<String> = r.get(8)?;
    let recipe = recipe_s.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    // `success_count` is column 9 — added in schema v4. Pre-v4 callers
    // (none reach here) would trip a column-out-of-range; the migration
    // runs before any query in practice.
    let success_count: i64 = r.get::<_, i64>(9).unwrap_or(0);
    // Columns 10/11 — sprint-12 η provenance. `unwrap_or(None)` keeps
    // pre-v8 test callers (scratch_conn without the migration applied)
    // from tripping on "Invalid column index" — production always has
    // the columns because the migration runs at boot.
    let signature: Option<String> = r.get::<_, Option<String>>(10).unwrap_or(None);
    let signer_fingerprint: Option<String> =
        r.get::<_, Option<String>>(11).unwrap_or(None);
    Ok(ProceduralSkill {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        trigger_text: r.get(3)?,
        skill_path: r.get(4)?,
        uses_count: r.get(5)?,
        last_used_at: r.get(6)?,
        created_at: r.get(7)?,
        success_count,
        recipe,
        signature,
        signer_fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::db::scratch_conn;
    use rusqlite::Connection;

    fn add_via(
        conn: &Connection,
        name: &str,
        path: &str,
        recipe: Option<&str>,
    ) -> Result<ProceduralSkill, String> {
        let id = generate_id();
        let created_at = now_secs();
        let recipe_val = recipe
            .map(|s| serde_json::from_str::<serde_json::Value>(s).unwrap_or(serde_json::Value::Null));
        let recipe_json = recipe.map(|s| s.to_string());
        conn.execute(
            "INSERT INTO procedural
                (id, name, description, trigger_text, skill_path,
                 uses_count, last_used_at, created_at, recipe_json)
             VALUES (?1, ?2, '', '', ?3, 0, NULL, ?4, ?5)",
            params![id, name, path, created_at, recipe_json],
        )
        .map_err(|e| format!("insert: {e}"))?;
        Ok(ProceduralSkill {
            id,
            name: name.into(),
            description: "".into(),
            trigger_text: "".into(),
            skill_path: path.into(),
            uses_count: 0,
            success_count: 0,
            last_used_at: None,
            created_at,
            recipe: recipe_val,
            signature: None,
            signer_fingerprint: None,
        })
    }

    #[test]
    fn skill_names_are_unique() {
        let (_dir, conn) = scratch_conn("proc-unique");
        add_via(&conn, "morning-brief", "/tmp/ok.ts", None).unwrap();
        let dupe = add_via(&conn, "morning-brief", "/tmp/other.ts", None);
        assert!(dupe.is_err(), "duplicate skill names must be rejected");
    }

    #[test]
    fn list_orders_by_uses_desc_then_recency() {
        let (_dir, conn) = scratch_conn("proc-order");
        let a = add_via(&conn, "a", "/tmp/a.ts", None).unwrap();
        let b = add_via(&conn, "b", "/tmp/b.ts", None).unwrap();
        conn.execute(
            "UPDATE procedural SET uses_count = 5 WHERE id = ?1",
            params![b.id],
        )
        .unwrap();

        let mut stmt = conn
            .prepare_cached(
                "SELECT id FROM procedural ORDER BY uses_count DESC, created_at DESC",
            )
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids.first().cloned().unwrap(), b.id);
        assert!(ids.contains(&a.id));
    }

    #[test]
    fn list_skills_ranks_by_laplace_smoothed_success_rate() {
        // Reproduces the production ORDER BY in `SKILL_RANK_ORDER_BY`.
        // Three skills exercise the three regimes:
        //   strong : 10 uses, 9 success  → smoothed = 10/12 ≈ 0.833
        //   fresh  :  0 uses, 0 success  → smoothed =  1/2  = 0.500
        //   flaky  : 10 uses, 2 success  → smoothed =  3/12 = 0.250
        // Expected order on the smoothed-rate DESC sort: strong, fresh, flaky.
        let (_dir, conn) = scratch_conn("proc-smoothed-order");
        let strong = add_via(&conn, "strong", "/tmp/strong.ts", None).unwrap();
        let fresh = add_via(&conn, "fresh", "/tmp/fresh.ts", None).unwrap();
        let flaky = add_via(&conn, "flaky", "/tmp/flaky.ts", None).unwrap();

        conn.execute(
            "UPDATE procedural SET uses_count = 10, success_count = 9 WHERE id = ?1",
            params![strong.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE procedural SET uses_count = 10, success_count = 2 WHERE id = ?1",
            params![flaky.id],
        )
        .unwrap();

        let sql = format!("SELECT id FROM procedural {SKILL_RANK_ORDER_BY}");
        let mut stmt = conn.prepare_cached(&sql).unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(ids, vec![strong.id, fresh.id, flaky.id]);
    }

    #[test]
    fn list_skills_tiebreaks_equal_rate_by_uses_count() {
        // Two skills with identical smoothed rate (both 5/10 → 6/12 = 0.5)
        // should tiebreak on uses_count DESC. Seeding the high-volume one
        // first and checking it leads verifies the secondary sort.
        let (_dir, conn) = scratch_conn("proc-tiebreak");
        let niche = add_via(&conn, "niche", "/tmp/niche.ts", None).unwrap();
        let popular = add_via(&conn, "popular", "/tmp/popular.ts", None).unwrap();

        // Both at exactly 50 % post-smoothing: niche 5/10, popular 50/100.
        conn.execute(
            "UPDATE procedural SET uses_count = 10, success_count = 5 WHERE id = ?1",
            params![niche.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE procedural SET uses_count = 100, success_count = 50 WHERE id = ?1",
            params![popular.id],
        )
        .unwrap();

        let sql = format!("SELECT id FROM procedural {SKILL_RANK_ORDER_BY}");
        let mut stmt = conn.prepare_cached(&sql).unwrap();
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        // Popular (100 uses) wins over niche (10 uses) when smoothed rate ties.
        assert_eq!(ids.first().cloned().unwrap(), popular.id);
    }

    #[test]
    fn bump_use_success_counter_independent_of_uses_counter() {
        // Pure SQL version of bump_use that accepts an injected connection
        // — the production fn uses with_conn (global cell), which would
        // leak between tests.
        fn bump(conn: &Connection, id: &str, success: bool) {
            let now = now_secs();
            let sql = if success {
                "UPDATE procedural
                 SET uses_count = uses_count + 1,
                     success_count = success_count + 1,
                     last_used_at = ?1
                 WHERE id = ?2"
            } else {
                "UPDATE procedural
                 SET uses_count = uses_count + 1,
                     last_used_at = ?1
                 WHERE id = ?2"
            };
            conn.execute(sql, params![now, id]).unwrap();
        }

        let (_dir, conn) = scratch_conn("proc-success");
        let s = add_via(&conn, "daily-brief", "/tmp/d.ts", None).unwrap();
        // 5 successes, 2 failures
        for _ in 0..5 { bump(&conn, &s.id, true); }
        for _ in 0..2 { bump(&conn, &s.id, false); }
        let (uses, succ): (i64, i64) = conn
            .query_row(
                "SELECT uses_count, success_count FROM procedural WHERE id = ?1",
                params![s.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(uses, 7);
        assert_eq!(succ, 5);
    }

    #[test]
    fn recipe_roundtrips_through_insert_and_read() {
        let (_dir, conn) = scratch_conn("proc-recipe");
        let recipe = r#"{"steps":[{"kind":"tool","tool":"fs_list","input":{"path":"/tmp"}}]}"#;
        let s = add_via(&conn, "rec", "", Some(recipe)).unwrap();
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, name, description, trigger_text, skill_path,
                        uses_count, last_used_at, created_at, recipe_json
                 FROM procedural WHERE id = ?1",
            )
            .unwrap();
        let got: ProceduralSkill = stmt
            .query_row(params![s.id], row_to_skill)
            .unwrap();
        let got_recipe = got.recipe.expect("recipe stored");
        // Ensure the steps array survived JSON round-trip.
        let steps = got_recipe.get("steps").and_then(|v| v.as_array()).unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(
            steps[0].get("tool").and_then(|v| v.as_str()),
            Some("fs_list")
        );
    }
}
