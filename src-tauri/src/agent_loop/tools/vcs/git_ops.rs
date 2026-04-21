//! Pure git operations using the `git2` crate.
//!
//! Each function is a thin domain helper called by the corresponding
//! `ToolSpec` invoke closure.  Kept free of Tauri / inventory concerns
//! so unit tests can exercise them without a running app.

use std::path::Path;

use git2::{
    BranchType, DiffFormat, DiffOptions, Repository, StatusOptions,
};

// ---------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------

/// One entry in the working-tree / index status report.
#[derive(Debug, serde::Serialize)]
pub struct StatusEntry {
    pub path: String,
    pub status: String,
}

/// Staged/unstaged/untracked files plus the current branch name.
#[derive(Debug, serde::Serialize)]
pub struct RepoStatus {
    pub branch: String,
    pub entries: Vec<StatusEntry>,
}

pub fn git_status(repo_path: &str) -> Result<RepoStatus, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("git_status: cannot open `{repo_path}`: {e}"))?;

    let branch = current_branch_name(&repo);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("git_status: status query failed: {e}"))?;

    let mut entries = Vec::new();
    for entry in statuses.iter() {
        let path = entry
            .path()
            .unwrap_or("<non-utf8>")
            .to_string();
        let st = entry.status();
        let label = status_label(st);
        entries.push(StatusEntry { path, status: label });
    }

    Ok(RepoStatus { branch, entries })
}

fn current_branch_name(repo: &Repository) -> String {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .unwrap_or_else(|| "HEAD (detached)".to_string())
}

fn status_label(st: git2::Status) -> String {
    let mut parts = Vec::new();
    if st.contains(git2::Status::INDEX_NEW) { parts.push("staged:new"); }
    if st.contains(git2::Status::INDEX_MODIFIED) { parts.push("staged:modified"); }
    if st.contains(git2::Status::INDEX_DELETED) { parts.push("staged:deleted"); }
    if st.contains(git2::Status::INDEX_RENAMED) { parts.push("staged:renamed"); }
    if st.contains(git2::Status::WT_MODIFIED) { parts.push("modified"); }
    if st.contains(git2::Status::WT_DELETED) { parts.push("deleted"); }
    if st.contains(git2::Status::WT_NEW) { parts.push("untracked"); }
    if st.contains(git2::Status::CONFLICTED) { parts.push("conflicted"); }
    if parts.is_empty() { "unknown".to_string() } else { parts.join("|") }
}

// ---------------------------------------------------------------------------
// git_log
// ---------------------------------------------------------------------------

/// Summary of a single commit.
#[derive(Debug, serde::Serialize)]
pub struct CommitInfo {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

pub fn git_log(repo_path: &str, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("git_log: cannot open `{repo_path}`: {e}"))?;

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("git_log: revwalk failed: {e}"))?;
    revwalk
        .push_head()
        .map_err(|e| format!("git_log: push_head failed: {e}"))?;
    revwalk.set_sorting(git2::Sort::TIME).map_err(|e| format!("git_log: sort failed: {e}"))?;

    let mut commits = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = oid.map_err(|e| format!("git_log: oid error: {e}"))?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("git_log: find_commit failed: {e}"))?;

        let author = commit.author();
        let name = author.name().unwrap_or("unknown").to_string();
        let epoch = commit.time().seconds();
        let date = chrono::DateTime::from_timestamp(epoch, 0)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| epoch.to_string());
        let subject = commit
            .summary()
            .unwrap_or("")
            .to_string();
        let hash = format!("{:.12}", oid);

        commits.push(CommitInfo { hash, author: name, date, subject });
    }

    Ok(commits)
}

// ---------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------

pub fn git_diff(
    repo_path: &str,
    staged: bool,
    file: Option<&str>,
) -> Result<String, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("git_diff: cannot open `{repo_path}`: {e}"))?;

    let mut diff_opts = DiffOptions::new();
    if let Some(f) = file {
        diff_opts.pathspec(f);
    }

    let diff = if staged {
        // Index → HEAD
        let head_tree = repo
            .head()
            .and_then(|h| h.peel_to_tree())
            .ok();
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))
            .map_err(|e| format!("git_diff staged: {e}"))?
    } else {
        // Working tree → index
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| format!("git_diff unstaged: {e}"))?
    };

    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };
        let content = std::str::from_utf8(line.content()).unwrap_or("?");
        out.push_str(prefix);
        out.push_str(content);
        true
    })
    .map_err(|e| format!("git_diff print: {e}"))?;

    Ok(out)
}

// ---------------------------------------------------------------------------
// git_commit
// ---------------------------------------------------------------------------

/// Stage `files` (if provided) then create a commit with `message`.
pub fn git_commit(
    repo_path: &str,
    message: &str,
    files: &[String],
) -> Result<String, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("git_commit: cannot open `{repo_path}`: {e}"))?;

    let mut index = repo
        .index()
        .map_err(|e| format!("git_commit: index: {e}"))?;

    if !files.is_empty() {
        for f in files {
            index
                .add_path(Path::new(f))
                .map_err(|e| format!("git_commit: add_path `{f}`: {e}"))?;
        }
        index.write().map_err(|e| format!("git_commit: index write: {e}"))?;
    }

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("git_commit: write_tree: {e}"))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("git_commit: find_tree: {e}"))?;

    let sig = repo
        .signature()
        .map_err(|e| format!("git_commit: signature: {e}"))?;

    let parent_commit = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| format!("git_commit: commit: {e}"))?;

    Ok(format!("{:.12}", oid))
}

// ---------------------------------------------------------------------------
// git_branch_create
// ---------------------------------------------------------------------------

pub fn git_branch_create(
    repo_path: &str,
    name: &str,
    base: Option<&str>,
) -> Result<(), String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("git_branch_create: cannot open `{repo_path}`: {e}"))?;

    let base_commit = if let Some(b) = base {
        let obj = repo
            .revparse_single(b)
            .map_err(|e| format!("git_branch_create: base `{b}`: {e}"))?;
        obj.peel_to_commit()
            .map_err(|e| format!("git_branch_create: peel `{b}`: {e}"))?
    } else {
        repo.head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| format!("git_branch_create: HEAD: {e}"))?
    };

    repo.branch(name, &base_commit, false)
        .map_err(|e| format!("git_branch_create: branch `{name}`: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// git_branch_switch
// ---------------------------------------------------------------------------

pub fn git_branch_switch(repo_path: &str, name: &str) -> Result<(), String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("git_branch_switch: cannot open `{repo_path}`: {e}"))?;

    let branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|e| format!("git_branch_switch: branch `{name}` not found: {e}"))?;

    let reference = branch
        .into_reference();
    let refname = reference
        .name()
        .ok_or_else(|| format!("git_branch_switch: invalid ref name for `{name}`"))?;

    let obj = repo
        .revparse_single(refname)
        .map_err(|e| format!("git_branch_switch: revparse `{name}`: {e}"))?;

    repo.checkout_tree(&obj, None)
        .map_err(|e| format!("git_branch_switch: checkout_tree: {e}"))?;

    repo.set_head(refname)
        .map_err(|e| format!("git_branch_switch: set_head: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests for log parsing / diff formatting helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_label_new_file() {
        let st = git2::Status::INDEX_NEW;
        assert!(status_label(st).contains("staged:new"));
    }

    #[test]
    fn status_label_untracked() {
        let st = git2::Status::WT_NEW;
        assert!(status_label(st).contains("untracked"));
    }

    #[test]
    fn status_label_modified() {
        let st = git2::Status::WT_MODIFIED;
        assert_eq!(status_label(st), "modified");
    }

    #[test]
    fn status_label_conflict() {
        let st = git2::Status::CONFLICTED;
        assert!(status_label(st).contains("conflicted"));
    }

    #[test]
    fn status_label_multi() {
        let st = git2::Status::INDEX_MODIFIED | git2::Status::WT_MODIFIED;
        let label = status_label(st);
        assert!(label.contains("staged:modified"));
        assert!(label.contains("modified"));
    }
}
