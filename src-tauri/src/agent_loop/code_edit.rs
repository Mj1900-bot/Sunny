//! `code_edit` — read a source file, send it to a `coder` sub-agent with
//! an instruction, and write the sub-agent's output back to disk.
//!
//! Canonical use: Sunny says "SUNNY, change the header in
//! ~/Projects/foo/src/nav.tsx to use the new logo". The composite:
//!   1. Reads the current file via `control::fs_read_text` (with
//!      safety-path checks + binary detection).
//!   2. Hands `{instruction, current contents}` to a coder sub-agent with
//!      a strict "return the FULL new file contents, nothing else" prompt.
//!   3. Strips any markdown fences the model wrapped around the output
//!      and writes the result back to the same path via `std::fs::write`
//!      gated on `safety_paths::assert_write_allowed`.
//!   4. Emits `sunny://code.edit.diff` with the before/after so an HUD
//!      panel can show a diff if wired up.
//!
//! This tool is **dangerous** — it mutates files on disk. It is registered
//! on `catalog::is_dangerous` so the ConfirmGate prompts Sunny before the
//! sub-agent runs.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::helpers::string_arg;
use super::subagents::spawn_subagent;

/// Wall-clock ceiling for the coder sub-agent. Large files can produce
/// slow responses on smaller models; 120s matches the reflexion per-step cap.
const CODER_TIMEOUT_SECS: u64 = 120;

/// Cap on file size we will read and rewrite. Larger files tend to blow
/// the sub-agent's context window anyway. 256 KB matches the default
/// `fs_read_text` cap.
const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Serialize, Debug, Clone)]
struct DiffEvent<'a> {
    path: &'a str,
    before: &'a str,
    after: &'a str,
    before_chars: usize,
    after_chars: usize,
}

pub async fn code_edit(
    app: &AppHandle,
    file_path: &str,
    instruction: &str,
    parent_session_id: Option<&str>,
    depth: u32,
) -> Result<String, String> {
    let path_trim = file_path.trim();
    if path_trim.is_empty() {
        return Err("code_edit: 'file_path' is empty".to_string());
    }
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("code_edit: 'instruction' is empty".to_string());
    }

    // 1. Read current contents. fs_read_text enforces safety_paths and
    //    refuses binary input — exactly what we want before letting the
    //    coder sub-agent loose on it.
    let read = crate::control::fs_read_text(path_trim.to_string(), Some(MAX_FILE_BYTES))
        .map_err(|e| format!("code_edit: read {path_trim}: {e}"))?;
    if read.is_binary {
        return Err(format!(
            "code_edit: refusing to edit binary file: {path_trim}"
        ));
    }
    if read.truncated {
        return Err(format!(
            "code_edit: file larger than {} bytes — refusing to edit partial content",
            MAX_FILE_BYTES
        ));
    }
    let before = read.content;

    // 2. Validate we can write to this path BEFORE spending sub-agent
    //    tokens. expand_home + assert_write_allowed catches system paths
    //    up-front so a refused write doesn't waste the coder run.
    let expanded = crate::safety_paths::expand_home(path_trim)?;
    crate::safety_paths::assert_write_allowed(&expanded)?;

    // 3. Ask the coder sub-agent for the full rewritten file. The prompt
    //    is strict about format — we need raw contents back, not a diff
    //    or explanation.
    let task = format!(
        "You are editing a single source file for Sunny. Apply the \
         instruction to the CURRENT CONTENTS below and return the FULL \
         new file contents.\n\n\
         CRITICAL FORMATTING RULES — read these twice:\n\
         • Return the ENTIRE new file, not a diff, not a patch, not an excerpt.\n\
         • No preamble (\"Here is the updated file:\"), no trailing commentary.\n\
         • Do NOT wrap the output in ``` code fences. Raw text only.\n\
         • Preserve the existing trailing newline convention.\n\
         • If the instruction is ambiguous or unsafe, return the file \
           UNCHANGED — do not guess.\n\n\
         FILE PATH: {file_path}\n\
         INSTRUCTION: {instruction}\n\n\
         <current_contents>\n{before}\n</current_contents>\n\n\
         Return the new file contents now.",
    );

    let raw = tokio::time::timeout(
        Duration::from_secs(CODER_TIMEOUT_SECS),
        spawn_subagent(
            app,
            "coder",
            &task,
            None,
            parent_session_id.map(String::from),
            depth,
        ),
    )
    .await
    .map_err(|_| format!("code_edit: coder sub-agent timed out after {CODER_TIMEOUT_SECS}s"))?
    .map_err(|e| format!("code_edit: coder sub-agent failed: {e}"))?;

    // 4. Clean up the response — strip spawn_subagent's prefix plus any
    //    fenced-code wrappers the model may have emitted despite the
    //    prompt.
    let after = clean_subagent_code(&raw);
    if after.trim().is_empty() {
        return Err(
            "code_edit: sub-agent returned empty content — refusing to clobber file"
                .to_string(),
        );
    }

    // 5. Write back via std::fs::write through safety_paths. Using the
    //    lower-level primitive (not fs_new_file) because the target
    //    already exists — new_file errors if present.
    if let Some(parent) = expanded.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("code_edit: mkdir parent: {e}"))?;
        }
    }
    std::fs::write(&expanded, after.as_bytes())
        .map_err(|e| format!("code_edit: write {}: {e}", expanded.display()))?;

    // 6. Emit diff event. Failure to emit is non-fatal.
    let _ = app.emit(
        "sunny://code.edit.diff",
        DiffEvent {
            path: &expanded.to_string_lossy(),
            before: &before,
            after: &after,
            before_chars: before.chars().count(),
            after_chars: after.chars().count(),
        },
    );
    // Also log a shorter breadcrumb for operators watching logs.
    log::info!(
        "[code_edit] wrote {} ({} → {} chars)",
        expanded.display(),
        before.chars().count(),
        after.chars().count()
    );

    Ok(format!(
        "Edited {} — {} chars → {} chars. Diff emitted on sunny://code.edit.diff.",
        expanded.display(),
        before.chars().count(),
        after.chars().count()
    ))
}

/// Strip `[sub-agent coder answer] ` prefix + any leading/trailing markdown
/// fences the model may have added despite instructions. When no prefix or
/// fence is present, the input is returned unchanged so trailing newline
/// conventions are preserved.
fn clean_subagent_code(raw: &str) -> String {
    let had_prefix = raw.trim_start().starts_with("[sub-agent coder answer]");
    let mut body = if had_prefix {
        raw.trim_start()
            .strip_prefix("[sub-agent coder answer]")
            .map(str::trim_start)
            .unwrap_or(raw)
            .to_string()
    } else {
        raw.to_string()
    };

    // Detect a leading ```lang line. If present, drop everything from
    // the first fence's closing newline through the matching trailing
    // ```.
    if body.trim_start().starts_with("```") {
        // Drop any leading whitespace before the fence line.
        body = body.trim_start().to_string();
        // Remove the opening fence line (```rust, ```ts, etc).
        if let Some(idx) = body.find('\n') {
            body = body[idx + 1..].to_string();
        } else {
            // Edge case: single-line fence — nothing useful inside.
            return String::new();
        }
        // Trim a trailing fence if present.
        if let Some(stripped) = body.trim_end().strip_suffix("```") {
            body = stripped.trim_end_matches('\n').to_string();
            body.push('\n');
        }
    }

    body
}

pub fn parse_input(input: &Value) -> Result<(String, String), String> {
    let file_path = string_arg(input, "file_path")?;
    let instruction = string_arg(input, "instruction")?;
    Ok((file_path, instruction))
}

// keep `json!` import alive in case future additions emit richer events
#[allow(dead_code)]
fn _assert_json_used() {
    let _ = json!({});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_sub_agent_prefix() {
        let raw = "[sub-agent coder answer]fn main() {}\n";
        let cleaned = clean_subagent_code(raw);
        assert_eq!(cleaned.trim(), "fn main() {}");
    }

    #[test]
    fn strips_markdown_fence() {
        let raw = "```rust\nfn main() {}\n```\n";
        let cleaned = clean_subagent_code(raw);
        assert!(cleaned.contains("fn main"));
        assert!(!cleaned.contains("```"));
    }

    #[test]
    fn strips_prefix_and_fence_together() {
        let raw = "[sub-agent coder answer] ```ts\nconst x = 1;\n```";
        let cleaned = clean_subagent_code(raw);
        assert!(cleaned.contains("const x = 1"));
        assert!(!cleaned.contains("```"));
    }

    #[test]
    fn leaves_plain_code_alone() {
        // When there is no [sub-agent prefix] and no markdown fence,
        // `clean_subagent_code` is an identity so trailing-newline
        // conventions are preserved verbatim on write-back.
        let raw = "fn greet() { println!(\"hi\"); }\n";
        let cleaned = clean_subagent_code(raw);
        assert_eq!(cleaned, raw);
    }

    #[test]
    fn parse_requires_both_args() {
        assert!(parse_input(&json!({})).is_err());
        assert!(parse_input(&json!({"file_path":"/tmp/x"})).is_err());
        assert!(parse_input(&json!({"instruction":"do stuff"})).is_err());
        let ok = parse_input(&json!({"file_path":"/tmp/x","instruction":"rename"})).unwrap();
        assert_eq!(ok.0, "/tmp/x");
        assert_eq!(ok.1, "rename");
    }
}
