//! VCS tools — git + GitHub integration.
//!
//! # Modules
//!
//! * `allowlist`  — URL allow-list check for clone/push (reads `~/.sunny/grants.json`).
//! * `push_guard` — L5 passphrase gate for pushes to `main`/`master`.
//! * `git_ops`    — Pure domain functions over `git2` (no Tauri/inventory).
//! * `git_tools`  — Eight `ToolSpec` registrations for git operations.
//! * `gh_tools`   — Five `ToolSpec` registrations via the `gh` CLI.
//!
//! # Capability taxonomy (coordinates with `tool_trait.rs`)
//!
//! | Capability    | L-level | Tools                                        |
//! |---------------|---------|----------------------------------------------|
//! | `vcs.read`    | L1      | git_status, git_log, git_diff, gh_pr_list,   |
//! |               |         | gh_pr_view, gh_issue_list                    |
//! | `vcs.write`   | L2-L3   | git_branch_create, git_branch_switch,        |
//! |               |         | git_commit (L3), git_clone (L3)              |
//! | `vcs.push`    | L4      | git_push, gh_pr_create, gh_issue_create      |
//! |               |         | (git_push to main/master escalates to L5)    |

pub mod allowlist;
pub mod gh_tools;
pub mod git_ops;
pub mod git_tools;
pub mod push_guard;
