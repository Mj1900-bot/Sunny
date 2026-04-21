//! macOS Notes.app bridge via AppleScript (`osascript`).
//!
//! Notes.app stores bodies as HTML internally, but AppleScript's `body of note`
//! returns a plain-text rendering which is what SUNNY wants for HUD display.
//!
//! Parsing strategy (important — Notes bodies routinely contain arbitrary
//! text including pipes, quotes, newlines, markdown tables):
//!
//!   - Records separated by `---SUNNY-RECSEP---` on its own line so embedded
//!     newlines inside bodies never confuse the record boundary.
//!   - Fields inside a record separated by `|||` (triple pipe). Natural text
//!     almost never contains a triple pipe, and unlike a single `|` it does
//!     not collide with markdown tables that the user may have written in
//!     their note bodies.
//!   - Field order: `id ||| name ||| folder ||| created ||| modified ||| body`
//!     (body last so even a stray `|||` in a body can't shift subsequent
//!     fields — we split with a bounded limit).
//!
//! Permissions: the first call that enumerates user notes triggers the
//! Automation prompt (Sunny → Notes). If the user clicks Don't Allow the
//! subsequent `osascript` exits non-zero with stderr mentioning `-1743`
//! and/or "not allowed" — we detect that and return a descriptive hint
//! pointing to the correct Settings pane.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(10);
const REC_SEP: &str = "---SUNNY-RECSEP---";
const FIELD_SEP: &str = "|||";
const BODY_TRUNCATE: usize = 2000;
const DEFAULT_LIST_LIMIT: usize = 50;
const DEFAULT_SEARCH_LIMIT: usize = 20;

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export)]
pub struct Note {
    pub id: String,
    pub name: String,
    /// Plain-text body. Notes stores HTML internally but `body of note` via
    /// AppleScript returns plain text. Truncated to `BODY_TRUNCATE` chars
    /// for list/search views.
    pub body: String,
    pub folder: String,
    pub created: Option<String>,
    pub modified: Option<String>,
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

pub async fn list_notes(
    folder: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<Note>, String> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, 500);
    let script = build_list_script(folder.as_deref(), limit);
    let out = run_osascript(&script).await?;
    Ok(parse_records(&out))
}

pub async fn list_folders() -> Result<Vec<String>, String> {
    let script = r#"
        set out to ""
        tell application "Notes"
            repeat with f in folders
                try
                    set out to out & (name of f) & linefeed
                end try
            end repeat
        end tell
        return out
    "#;
    let out = run_osascript(script).await?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

pub async fn create_note(
    title: String,
    body: String,
    folder: Option<String>,
) -> Result<Note, String> {
    let script = build_create_script(&title, &body, folder.as_deref());
    let out = run_osascript(&script).await?;
    parse_records(&out)
        .into_iter()
        .next()
        .ok_or_else(|| "create_note: no record returned from AppleScript".to_string())
}

pub async fn append_to_note(id: String, text: String) -> Result<(), String> {
    let script = build_append_script(&id, &text);
    let _ = run_osascript(&script).await?;
    Ok(())
}

pub async fn search_notes(query: String, limit: Option<usize>) -> Result<Vec<Note>, String> {
    let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 200);
    let script = build_search_script(&query, limit);
    let out = run_osascript(&script).await?;

    // AppleScript unions notes whose name contains q with notes whose body
    // contains q — we dedup by id here rather than in AppleScript because
    // list comparison across `notes` references is unreliable.
    let mut seen = std::collections::HashSet::new();
    let deduped: Vec<Note> = parse_records(&out)
        .into_iter()
        .filter(|n| seen.insert(n.id.clone()))
        .take(limit)
        .collect();
    Ok(deduped)
}

// --------------------------------------------------------------------------
// Script builders
// --------------------------------------------------------------------------

fn build_list_script(folder: Option<&str>, limit: usize) -> String {
    let target = match folder {
        Some(name) => format!("notes of folder \"{}\"", safe_quote(name)),
        None => "notes".to_string(),
    };
    format!(
        r#"
        set out to ""
        set lim to {limit}
        set cnt to 0
        tell application "Notes"
            repeat with n in {target}
                if cnt is greater than or equal to lim then exit repeat
                try
                    set nId to id of n
                    set nName to name of n
                    set nBody to body of n
                    set nCreated to (creation date of n) as string
                    set nModified to (modification date of n) as string
                    try
                        set nFolder to name of container of n
                    on error
                        set nFolder to ""
                    end try
                    set out to out & nId & "{FIELD_SEP}" & nName & "{FIELD_SEP}" & nFolder & "{FIELD_SEP}" & nCreated & "{FIELD_SEP}" & nModified & "{FIELD_SEP}" & nBody & linefeed & "{REC_SEP}" & linefeed
                    set cnt to cnt + 1
                end try
            end repeat
        end tell
        return out
    "#,
        limit = limit,
        target = target,
        FIELD_SEP = FIELD_SEP,
        REC_SEP = REC_SEP,
    )
}

fn build_create_script(title: &str, body: &str, folder: Option<&str>) -> String {
    // Notes expects HTML-ish body. We build a <div><h1>title</h1><br>body</div>
    // with minimal escaping so line breaks survive.
    let body_html = body.replace('\n', "<br>");
    let q_title = safe_quote(title);
    let q_body = safe_quote(&body_html);

    let make_clause = match folder {
        Some(f) => format!(
            r#"make new note at folder "{}" with properties {{name:"{}", body:"{}"}}"#,
            safe_quote(f),
            q_title,
            q_body,
        ),
        None => format!(
            r#"make new note with properties {{name:"{}", body:"{}"}}"#,
            q_title, q_body,
        ),
    };

    format!(
        r#"
        set out to ""
        tell application "Notes"
            set n to {make_clause}
            set nId to id of n
            set nName to name of n
            set nBody to body of n
            set nCreated to (creation date of n) as string
            set nModified to (modification date of n) as string
            try
                set nFolder to name of container of n
            on error
                set nFolder to ""
            end try
            set out to nId & "{FIELD_SEP}" & nName & "{FIELD_SEP}" & nFolder & "{FIELD_SEP}" & nCreated & "{FIELD_SEP}" & nModified & "{FIELD_SEP}" & nBody & linefeed & "{REC_SEP}" & linefeed
        end tell
        return out
    "#,
        make_clause = make_clause,
        FIELD_SEP = FIELD_SEP,
        REC_SEP = REC_SEP,
    )
}

fn build_append_script(id: &str, text: &str) -> String {
    // Notes `body` is HTML — appending raw text nukes formatting. We append
    // an HTML fragment: <br>+text (with line breaks).
    let html = format!("<br>{}", text.replace('\n', "<br>"));
    format!(
        r#"
        tell application "Notes"
            set target to note id "{id}"
            set existing to body of target
            set body of target to existing & "{appended}"
        end tell
    "#,
        id = safe_quote(id),
        appended = safe_quote(&html),
    )
}

fn build_search_script(query: &str, limit: usize) -> String {
    let q = safe_quote(query);
    format!(
        r#"
        set out to ""
        set lim to {limit}
        set cnt to 0
        tell application "Notes"
            set byName to notes whose name contains "{q}"
            set byBody to notes whose body contains "{q}"
            set combined to byName & byBody
            repeat with n in combined
                if cnt is greater than or equal to lim then exit repeat
                try
                    set nId to id of n
                    set nName to name of n
                    set nBody to body of n
                    set nCreated to (creation date of n) as string
                    set nModified to (modification date of n) as string
                    try
                        set nFolder to name of container of n
                    on error
                        set nFolder to ""
                    end try
                    set out to out & nId & "{FIELD_SEP}" & nName & "{FIELD_SEP}" & nFolder & "{FIELD_SEP}" & nCreated & "{FIELD_SEP}" & nModified & "{FIELD_SEP}" & nBody & linefeed & "{REC_SEP}" & linefeed
                    set cnt to cnt + 1
                end try
            end repeat
        end tell
        return out
    "#,
        limit = limit,
        q = q,
        FIELD_SEP = FIELD_SEP,
        REC_SEP = REC_SEP,
    )
}

// --------------------------------------------------------------------------
// osascript runner
// --------------------------------------------------------------------------

async fn run_osascript(script: &str) -> Result<String, String> {
    // kill_on_drop so a timeout doesn't leave a zombie behind.
    let fut = Command::new("osascript").arg("-e").arg(script).kill_on_drop(true).output();

    let result = match timeout(OSASCRIPT_TIMEOUT, fut).await {
        Ok(r) => r,
        Err(_) => {
            return Err(format!(
                "Notes osascript timed out after {}s — Notes.app may be enumerating a large library",
                OSASCRIPT_TIMEOUT.as_secs()
            ))
        }
    };

    let output = result.map_err(|e| format!("osascript spawn failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(classify_osascript_error(&stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn classify_osascript_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    if lower.contains("-1743")
        || lower.contains("not allowed")
        || lower.contains("not authorized")
    {
        "Notes access required — System Settings → Privacy & Security → Automation → Sunny → Notes".to_string()
    } else {
        format!("Notes osascript error: {}", stderr.trim())
    }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/// Escape a string for safe embedding inside an AppleScript double-quoted
/// literal. Order matters — backslashes first, then the double quote.
fn safe_quote(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn truncate_body(raw: &str) -> String {
    if raw.chars().count() > BODY_TRUNCATE {
        let cut: String = raw.chars().take(BODY_TRUNCATE).collect();
        format!("{cut}…")
    } else {
        raw.to_string()
    }
}

fn parse_records(stdout: &str) -> Vec<Note> {
    stdout
        .split(REC_SEP)
        .filter_map(parse_record)
        .collect()
}

fn parse_record(chunk: &str) -> Option<Note> {
    let trimmed = chunk.trim_matches(|c: char| c == '\n' || c == '\r' || c == ' ' || c == '\t');
    if trimmed.is_empty() {
        return None;
    }
    // splitn with a bound of 6 guarantees any stray `|||` inside a body ends
    // up in the body field, not shifting other fields.
    let parts: Vec<&str> = trimmed.splitn(6, FIELD_SEP).collect();
    if parts.len() < 6 {
        return None;
    }
    let id = parts[0].trim().to_string();
    let name = parts[1].trim().to_string();
    let folder = parts[2].trim().to_string();
    let created_raw = parts[3].trim();
    let modified_raw = parts[4].trim();
    let body = truncate_body(parts[5].trim());

    if id.is_empty() {
        return None;
    }

    let created = if created_raw.is_empty() {
        None
    } else {
        Some(created_raw.to_string())
    };
    let modified = if modified_raw.is_empty() {
        None
    } else {
        Some(modified_raw.to_string())
    };

    Some(Note {
        id,
        name,
        body,
        folder,
        created,
        modified,
    })
}

// --------------------------------------------------------------------------
// Tests — parser only (no osascript spawning under cargo test).
// --------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_record_with_triple_pipe_fields() {
        let id = "x-coredata://abc/ICNote/p1";
        let sample = format!(
            "{id}|||My Title|||Notes|||Tuesday, 1 April 2026 at 10:00:00|||Tuesday, 1 April 2026 at 11:00:00|||hello body\n{REC_SEP}\n",
        );
        let notes = parse_records(&sample);
        assert_eq!(notes.len(), 1);
        let n = &notes[0];
        assert_eq!(n.id, id);
        assert_eq!(n.name, "My Title");
        assert_eq!(n.folder, "Notes");
        assert_eq!(n.body, "hello body");
        assert!(n.created.as_deref().unwrap().contains("April"));
        assert!(n.modified.as_deref().unwrap().contains("April"));
    }

    #[test]
    fn record_separator_splits_multiple_records_with_embedded_newlines() {
        // Body contains linefeeds and even a stray `|||` — record sep must
        // still cleanly split two records, and splitn(6) must keep the `|||`
        // inside the body of the first record.
        let a = format!(
            "id-1|||Alpha|||Inbox|||t1|||t2|||line one\nline two ||| stray triple pipe\n{REC_SEP}",
        );
        let b = format!(
            "id-2|||Beta|||Inbox|||t3|||t4|||just a body\n{REC_SEP}",
        );
        let combined = format!("{a}\n{b}\n");
        let notes = parse_records(&combined);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, "id-1");
        assert!(notes[0].body.contains("line one"));
        assert!(notes[0].body.contains("line two"));
        assert!(notes[0].body.contains("stray triple pipe"));
        assert_eq!(notes[1].id, "id-2");
        assert_eq!(notes[1].body, "just a body");
    }

    #[test]
    fn truncates_long_body_with_ellipsis() {
        let long = "a".repeat(BODY_TRUNCATE + 500);
        let out = truncate_body(&long);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), BODY_TRUNCATE + 1);

        let short = "short body";
        assert_eq!(truncate_body(short), "short body");
    }
}

// === REGISTER IN lib.rs ===
// mod notes_app;
// #[tauri::command]s: notes_app_list, notes_app_folders, notes_app_create, notes_app_append, notes_app_search
// invoke_handler: notes_app_list, notes_app_folders, notes_app_create, notes_app_append, notes_app_search
// No new deps.
// === END REGISTER ===
