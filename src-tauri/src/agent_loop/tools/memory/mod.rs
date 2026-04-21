//! Long-term memory tools. Read-path needs `memory.read`; write-path
//! needs `memory.write`. `memory_compact` is a soft-delete rewrite and
//! is tagged `memory.write` (though not `dangerous`, since it's fully
//! reversible).
pub mod memory_compact;
pub mod memory_recall;
pub mod memory_remember;
