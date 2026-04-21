//! Long-term memory, conversation, and tool-usage commands.
//!
//! Backed by `~/.sunny/memory/memory.sqlite` via the `memory` domain module.
//!
//! # Module layout
//!
//! | File              | Commands                                     |
//! |-------------------|----------------------------------------------|
//! | `episodic.rs`     | `memory_episodic_*`                          |
//! | `semantic.rs`     | `memory_fact_*`                              |
//! | `procedural.rs`   | `memory_skill_*`                             |
//! | `compact.rs`      | `memory_compact*`, `memory_consolidator_*`   |
//! | `retention.rs`    | `memory_retention_*`                         |
//! | `tool_usage.rs`   | `tool_usage_*`                               |
//! | `conversation.rs` | `conversation_*`                             |
//! | `mod.rs` (here)   | `memory_pack`, `memory_stats` (cross-domain) |

use crate::memory;

pub mod episodic;
pub mod semantic;
pub mod procedural;
pub mod compact;
pub mod retention;
pub mod tool_usage;
pub mod conversation;

pub use episodic::*;
pub use semantic::*;
pub use procedural::*;
pub use compact::*;
pub use retention::*;
pub use tool_usage::*;
pub use conversation::*;

// -- Context pack + stats (cross-domain: touches episodic + semantic + procedural)

#[tauri::command]
pub fn memory_pack(
    opts: Option<memory::pack::BuildOptions>,
) -> Result<memory::MemoryPack, String> {
    memory::build_pack(opts.unwrap_or_default())
}

#[tauri::command]
pub fn memory_stats() -> Result<memory::MemoryStats, String> {
    memory::stats()
}
