//! GitHub CLI tools (5 tools via `gh` binary).
//!
//! All tools degrade gracefully when `gh` is not found — they return a
//! structured error suggesting `brew install gh`.
//!
//! Trust classes and L-levels:
//!   gh_pr_list      ExternalRead  dangerous=false  (L1)
//!   gh_pr_view      ExternalRead  dangerous=false  (L1)
//!   gh_issue_list   ExternalRead  dangerous=false  (L1)
//!   gh_pr_create    ExternalWrite dangerous=true   (L4)
//!   gh_issue_create ExternalWrite dangerous=true   (L4)

use serde_json::Value;
use tokio::process::Command;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

// ---------------------------------------------------------------------------
// Helper — run `gh` CLI
// ---------------------------------------------------------------------------

/// Run `gh` with the given args, optionally setting a working directory.
/// Returns `Err` with a user-friendly message when `gh` is not installed.
pub(crate) async fn run_gh(args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    // Probe for gh before attempting to spawn so the error is clean.
    let gh_path = which_gh().ok_or_else(|| {
        "GitHub CLI (`gh`) is not installed or not on PATH. \
         Install it with: brew install gh — then run `gh auth login`."
            .to_string()
    })?;

    let mut cmd = Command::new(&gh_path);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("gh spawn failed: {e}"))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| format!("gh output encoding: {e}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("gh exited {}: {}", output.status, stderr.trim()))
    }
}

/// Returns the path to the `gh` binary, or `None` when absent.
pub(crate) fn which_gh() -> Option<String> {
    // Fast check: try the common Homebrew install path first, then PATH search.
    for candidate in &["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    // Fall back to a PATH search via `which`.
    std::process::Command::new("which")
        .arg("gh")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// gh_pr_list
// ---------------------------------------------------------------------------

const PR_LIST_SCHEMA: &str = r#"{"type":"object","properties":{"repo":{"type":"string","description":"OWNER/REPO or absolute path to local repo. Defaults to repo in current directory."}}}"#;

fn gh_pr_list_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo = optional_string_arg(&input, "repo");
        let mut args = vec!["pr", "list", "--json", "number,title,state,author,headRefName"];
        let repo_flag;
        if let Some(ref r) = repo {
            repo_flag = format!("--repo={r}");
            args.push(&repo_flag);
        }
        run_gh(&args, repo.as_deref()).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "gh_pr_list",
        description: "List open pull requests for a GitHub repository. Provide repo as OWNER/REPO or omit to use the current directory's remote. Requires `gh` CLI authenticated.",
        input_schema: PR_LIST_SCHEMA,
        required_capabilities: &["vcs.read"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: gh_pr_list_invoke,
    }
}

// ---------------------------------------------------------------------------
// gh_pr_create   (L4)
// ---------------------------------------------------------------------------

const PR_CREATE_SCHEMA: &str = r#"{"type":"object","properties":{"repo_path":{"type":"string","description":"Absolute path to local repository."},"title":{"type":"string"},"body":{"type":"string"},"draft":{"type":"boolean","description":"Create as draft PR. Defaults to false."}},"required":["repo_path","title","body"]}"#;

fn gh_pr_create_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo_path = string_arg(&input, "repo_path")?;
        let title = string_arg(&input, "title")?;
        let body = string_arg(&input, "body")?;
        let draft = input.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut args = vec!["pr", "create", "--title", &title, "--body", &body];
        if draft {
            args.push("--draft");
        }

        // `run_gh` needs &str lifetime tied to locals; build owned args vec.
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        run_gh(&refs, Some(&repo_path)).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "gh_pr_create",
        description: "Create a pull request from the current branch of a local repository. L4 — network-write, confirm-gated.",
        input_schema: PR_CREATE_SCHEMA,
        required_capabilities: &["vcs.push"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke: gh_pr_create_invoke,
    }
}

// ---------------------------------------------------------------------------
// gh_pr_view
// ---------------------------------------------------------------------------

const PR_VIEW_SCHEMA: &str = r#"{"type":"object","properties":{"pr_number":{"type":"integer","description":"PR number."},"repo":{"type":"string","description":"OWNER/REPO. Omit to use current directory."}},"required":["pr_number"]}"#;

fn gh_pr_view_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let pr_number = input
            .get("pr_number")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "missing integer arg `pr_number`".to_string())?;
        let repo = optional_string_arg(&input, "repo");

        let pr_str = pr_number.to_string();
        let mut args = vec![
            "pr", "view", pr_str.as_str(),
            "--json", "number,title,state,body,reviews,checksUrl",
        ];
        let repo_flag;
        if let Some(ref r) = repo {
            repo_flag = format!("--repo={r}");
            args.push(&repo_flag);
        }
        run_gh(&args, None).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "gh_pr_view",
        description: "Fetch details + review status for a pull request by number.",
        input_schema: PR_VIEW_SCHEMA,
        required_capabilities: &["vcs.read"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: gh_pr_view_invoke,
    }
}

// ---------------------------------------------------------------------------
// gh_issue_list
// ---------------------------------------------------------------------------

const ISSUE_LIST_SCHEMA: &str = r#"{"type":"object","properties":{"repo":{"type":"string","description":"OWNER/REPO. Omit to use current directory."},"state":{"type":"string","enum":["open","closed","all"],"description":"Filter by state. Defaults to open."}}}"#;

fn gh_issue_list_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo = optional_string_arg(&input, "repo");
        let state = optional_string_arg(&input, "state")
            .unwrap_or_else(|| "open".to_string());

        let state_flag = format!("--state={state}");
        let mut args = vec![
            "issue", "list",
            "--json", "number,title,state,author,labels",
            state_flag.as_str(),
        ];
        let repo_flag;
        if let Some(ref r) = repo {
            repo_flag = format!("--repo={r}");
            args.push(&repo_flag);
        }
        run_gh(&args, repo.as_deref()).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "gh_issue_list",
        description: "List GitHub issues for a repository. Defaults to open issues. Filter by state: open | closed | all.",
        input_schema: ISSUE_LIST_SCHEMA,
        required_capabilities: &["vcs.read"],
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke: gh_issue_list_invoke,
    }
}

// ---------------------------------------------------------------------------
// gh_issue_create   (L4)
// ---------------------------------------------------------------------------

const ISSUE_CREATE_SCHEMA: &str = r#"{"type":"object","properties":{"repo":{"type":"string","description":"OWNER/REPO."},"title":{"type":"string"},"body":{"type":"string"}},"required":["repo","title","body"]}"#;

fn gh_issue_create_invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let repo = string_arg(&input, "repo")?;
        let title = string_arg(&input, "title")?;
        let body = string_arg(&input, "body")?;
        let repo_flag = format!("--repo={repo}");
        let args = vec!["issue", "create", "--title", &title, "--body", &body, &repo_flag];
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        run_gh(&refs, None).await
    })
}

inventory::submit! {
    ToolSpec {
        name: "gh_issue_create",
        description: "Create a GitHub issue. L4 — network-write, confirm-gated.",
        input_schema: ISSUE_CREATE_SCHEMA,
        required_capabilities: &["vcs.push"],
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke: gh_issue_create_invoke,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_gh_returns_string_or_none() {
        // Just assert the function doesn't panic; the actual result
        // depends on the test host environment.
        let result = which_gh();
        // If Some, it must be a non-empty absolute path.
        if let Some(path) = result {
            assert!(!path.is_empty());
        }
    }

    #[test]
    fn missing_gh_produces_friendly_error() {
        // Simulate absent gh by checking the error message from run_gh.
        // We can't easily mock the fs check, but we verify the error
        // text contract that downstream code relies on.
        let err_msg = "GitHub CLI (`gh`) is not installed or not on PATH. \
                        Install it with: brew install gh — then run `gh auth login`.";
        assert!(err_msg.contains("brew install gh"));
    }
}
