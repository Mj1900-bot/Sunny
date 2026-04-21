//! SUNNY memory subsystem — the cognitive substrate.
//!
//! Replaces the flat `~/.sunny/memory.jsonl` store with three coordinated
//! stores modeled loosely on human memory systems:
//!
//!   * **Episodic** — chronological record of events: user utterances, agent
//!     runs, perception snapshots, tool calls. High volume, lossy. Ring-like
//!     behaviour over time (see consolidator — Phase 1b).
//!
//!   * **Semantic** — stable facts about the user, world, and preferences.
//!     Curated by the consolidator or added explicitly via the user / the
//!     agent. Low volume, high signal.
//!
//!   * **Procedural** — learned skills (pointers to runnable TS files under
//!     `~/.sunny/skills/`). Deferred to Phase 1b; the table exists so the
//!     schema is stable.
//!
//! Storage is a single sqlite file at `~/.sunny/memory/memory.sqlite` with one
//! FTS5 virtual table per store for keyword search. Embeddings are BLOB
//! columns populated in Phase 1b (nomic-embed-text via Ollama); absent
//! embeddings degrade gracefully to FTS-only retrieval.
//!
//! ### Concurrency
//! A single shared `Mutex<Connection>` behind a `OnceLock`. Sqlite is already
//! serialised internally for a single connection; wrapping it in a mutex
//! makes the Rust borrow rules explicit and avoids accidental parallel `&mut`
//! access. Every public entry point locks the connection, runs its statement,
//! and drops the guard — no connection ever escapes the lock.
//!
//! ### Note helpers
//! `note_add` / `note_search` and the `NoteItem` type (re-exported below)
//! give the agent loop a flat episodic-note API. They're thin wrappers
//! over `episodic::add` / `search` that filter to `EpisodicKind::Note`
//! and project to the smaller `NoteItem` shape. Used by the remember,
//! reflect, screen-memory, and integration paths.

pub mod db;
pub mod episodic;
pub mod semantic;
pub mod procedural;
pub mod pack;
pub mod embed;
pub mod hybrid;
pub mod expand;
pub mod consolidator;
pub mod compact;
pub mod retention;
pub mod tool_usage;
pub mod conversation;
pub mod continuity_store;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Flat note shape — a projection of EpisodicItem used by the agent's
// note-writing call sites (remember, reflect, screen-memory, integration).
// Keeps the wire shape small so the frontend MemoryPage and the agent
// loop don't have to carry every episodic column.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export)]
pub struct NoteItem {
    pub id: String,
    pub text: String,
    pub tags: Vec<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Public API surface (used from lib.rs command handlers)
// ---------------------------------------------------------------------------

pub use db::init_default;
#[allow(unused_imports)]
pub use db::memory_dir_default;
pub use db::start_wal_maintenance;
pub use episodic::{
    EpisodicItem, EpisodicKind, add as episodic_add, list as episodic_list,
    search as episodic_search, note_add, note_search,
};
pub use semantic::{
    SemanticFact, add_fact as semantic_add, list_facts as semantic_list,
    search_facts as semantic_search, delete_fact as semantic_delete,
};
pub use procedural::{
    ProceduralSkill, add_skill as procedural_add, list_skills as procedural_list,
    delete_skill as procedural_delete, bump_use as procedural_bump_use,
    get_skill as procedural_get, update_skill as procedural_update,
};
pub use pack::{MemoryPack, MemoryStats, build_pack, stats};
