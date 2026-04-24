//! ToolSpec registrations for the eight git tools.
//!
//! Each tool is a thin wrapper over `git_ops::*` that validates JSON
//! input, calls the domain function, and serialises the result.
//!
//! Trust classes and L-levels:
//!   git_status       ExternalRead  dangerous=false  (L1)
//!   git_log          ExternalRead  dangerous=false  (L1)
//!   git_diff         ExternalRead  dangerous=false  (L1)
//!   git_commit       ExternalWrite dangerous=true   (L3)
//!   git_branch_create ExternalWrite dangerous=false  (L2)
//!   git_branch_switch ExternalWrite dangerous=false  (L2)
//!   git_clone        ExternalWrite dangerous=true   (L3)
//!   git_push         ExternalWrite dangerous=true   (L4/L5)

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::allowlist::{check_clone_target_dir, check_url};
use super::git_ops;
use super::push_guard::check_push_target;

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

const STATUS_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string","description":"Absolute path to the git repository root."}},"required":["repo_path"]}"#;

fn git_status_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let status = git_ops::git_status(&repo_path)?;
        serde_json::to_string(&status).map_err(|e| format!("git_status encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_status",
        description: "Return staged, unstaged, and untracked files plus the current branch name for a local git repository.",
        input_schema: STATUS_SCHEMA,
        required_capabilities: &["vcs.read"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: git_status_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_log
// ---------------------------------------------------------------------------

const LOG_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200,"description":"Number of commits to return. Defaults to 20."}},"required":["repo_path"]}"#;

fn git_log_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20) as usize;
        let log = git_ops::git_log(&repo_path, limit)?;
        serde_json::to_string(&log).map_err(|e| format!("git_log encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_log",
        description: "Return the last N commits (hash, author, date, subject) for a local git repository. Default N=20, max 200.",
        input_schema: LOG_SCHEMA,
        required_capabilities: &["vcs.read"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: git_log_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

const DIFF_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string"},"staged":{"type":"boolean","description":"Diff index vs HEAD (staged). Defaults to false (workdir vs index)."},"file":{"type":"string","description":"Restrict diff to this path (relative to repo root)."}},"required":["repo_path"]}"#;

fn git_diff_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let staged = input.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
        let file = optional_string_arg(&input, "file");
        let patch = git_ops::git_diff(&repo_path, staged, file.as_deref())?;
        Ok(patch)
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_diff",
        description: "Return a unified diff for a local repository. Pass staged=true for index-vs-HEAD; otherwise diffs working tree vs index. Optionally restrict to a single file.",
        input_schema: DIFF_SCHEMA,
        required_capabilities: &["vcs.read"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: git_diff_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_commit   (L3 — dangerous, confirm-gated)
// ---------------------------------------------------------------------------

const COMMIT_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string"},"message":{"type":"string","description":"Commit message."},"files":{"type":"array","items":{"type":"string"},"description":"Paths (relative to repo root) to stage before committing. Empty = commit current index."}},"required":["repo_path","message"]}"#;

fn git_commit_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let message = string_arg(&input, "message")?;
        let files: Vec<String> = input
            .get("files")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let short_sha = git_ops::git_commit(&repo_path, &message, &files)?;
        Ok(format!("committed {short_sha}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_commit",
        description: "Stage optional files then create a git commit with the given message. Requires user confirmation (L3 — writes to disk).",
        input_schema: COMMIT_SCHEMA,
        required_capabilities: &["vcs.write"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke: git_commit_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_branch_create   (L2)
// ---------------------------------------------------------------------------

const BRANCH_CREATE_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string"},"name":{"type":"string","description":"New branch name."},"base":{"type":"string","description":"Commit-ish to branch from. Defaults to HEAD."}},"required":["repo_path","name"]}"#;

fn git_branch_create_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let name = string_arg(&input, "name")?;
        let base = optional_string_arg(&input, "base");
        git_ops::git_branch_create(&repo_path, &name, base.as_deref())?;
        Ok(format!("branch `{name}` created"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_branch_create",
        description: "Create a new local branch from an optional base ref (defaults to HEAD). L2 — local write, no confirmation required.",
        input_schema: BRANCH_CREATE_SCHEMA,
        required_capabilities: &["vcs.write"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke: git_branch_create_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_branch_switch   (L2)
// ---------------------------------------------------------------------------

const BRANCH_SWITCH_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string"},"name":{"type":"string","description":"Branch name to check out."}},"required":["repo_path","name"]}"#;

fn git_branch_switch_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let name = string_arg(&input, "name")?;
        git_ops::git_branch_switch(&repo_path, &name)?;
        Ok(format!("switched to branch `{name}`"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_branch_switch",
        description: "Check out a local branch. L2 — modifies working tree, no confirmation required.",
        input_schema: BRANCH_SWITCH_SCHEMA,
        required_capabilities: &["vcs.write"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: false,
        invoke: git_branch_switch_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_clone   (L3 — dangerous, writes to disk, URL allowlisted)
// ---------------------------------------------------------------------------

const CLONE_SCHEMA: &str = r#"{"type":"object","properties":{"url":{"type":"string","description":"Remote repository URL (HTTPS or SCP SSH)."},"target_dir":{"type":"string","description":"Absolute local path to clone into."}},"required":["url","target_dir"]}"#;

fn git_clone_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let url = string_arg(&input, "url")?;
        let target_dir = string_arg(&input, "target_dir")?;

        // Positive allowlists — host (url) AND destination (target_dir).
        // ConfirmGate is still the user-facing gate for dangerous: true,
        // but these refuse outright before the user is asked, so a
        // prompt-injected sub-agent can't escape to `~/.ssh` or `~/Library`
        // even if the user misreads the ConfirmGate modal.
        check_url(&url)?;
        check_clone_target_dir(&target_dir)?;

        git2::Repository::clone(&url, &target_dir)
            .map_err(|e| format!("git_clone: {e}"))?;

        Ok(format!("cloned `{url}` → `{target_dir}`"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_clone",
        description: "Clone a remote repository to a local directory. Two allowlists must pass: the remote host must be in allowed_repo_hosts (default: github.com, gitlab.com), and target_dir must be under an allowed_clone_dirs prefix (default: $HOME/Projects, $HOME/src, $HOME/code, $HOME/workspace). Forbidden segments (.ssh, Library, .aws, etc.) are refused even if a prefix would otherwise admit them. Both lists live in ~/.sunny/grants.json. L3 — writes to disk, confirm-gated.",
        input_schema: CLONE_SCHEMA,
        required_capabilities: &["vcs.write"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke: git_clone_invoke,
    }
}

// ---------------------------------------------------------------------------
// git_push   (L4 + L5 guard for main/master)
// ---------------------------------------------------------------------------

const PUSH_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string"},"remote":{"type":"string","description":"Remote name. Defaults to \"origin\"."},"branch":{"type":"string","description":"Branch to push. Defaults to the current branch."},"confirm_main_push":{"type":"string","description":"Must be set to \"I confirm push to main\" when pushing to main or master."}},"required":["repo_path"]}"#;

fn git_push_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let remote_name = optional_string_arg(&input, "remote")
            .unwrap_or_else(|| "origin".to_string());

        let repo = git2::Repository::open(&repo_path)
            .map_err(|e| format!("git_push: cannot open `{repo_path}`: {e}"))?;

        // Resolve branch to push.
        let branch = if let Some(b) = optional_string_arg(&input, "branch") {
            b
        } else {
            repo.head()
                .ok()
                .and_then(|h| h.shorthand().map(String::from))
                .unwrap_or_else(|| "HEAD".to_string())
        };

        // L5 guard: main/master require typed confirmation.
        check_push_target(&branch, &input)?;

        let mut remote = repo
            .find_remote(&remote_name)
            .map_err(|e| format!("git_push: remote `{remote_name}`: {e}"))?;

        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        remote
            .push(&[refspec.as_str()], None)
            .map_err(|e| format!("git_push: push failed: {e}"))?;

        Ok(format!("pushed `{branch}` to `{remote_name}`"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "git_push",
        description: "Push a branch to a remote. L4 network-write — confirm-gated with a preview of what will be pushed. Pushing to main or master requires the confirm_main_push field set to exactly \"I confirm push to main\" (L5 guard).",
        input_schema: PUSH_SCHEMA,
        required_capabilities: &["vcs.push"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke: git_push_invoke,
    }
}
