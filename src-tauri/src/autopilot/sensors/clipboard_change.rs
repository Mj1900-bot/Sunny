//! Clipboard-change sensor — detects clipboard content changes.
//!
//! Polls the macOS clipboard via `pbpaste` subprocess every 3 seconds.
//! On a delta, classifies the new content as TEXT | URL | CODE and
//! publishes `SunnyEvent::AutopilotSignal { source: "clipboard" }`.
//!
//! No panics: every subprocess error is caught; the loop continues.
//! `pbpaste` failures are silently skipped to avoid log noise on
//! sandboxed environments.

use chrono::Utc;

use crate::event_bus::{self, SunnyEvent};
use crate::supervise;

const POLL_INTERVAL_SECS: u64 = 3;
/// Maximum clipboard content length to keep in memory for delta comparison.
const MAX_SNAPSHOT_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardKind {
    Text,
    Url,
    Code,
}

impl ClipboardKind {
    fn as_str(&self) -> &'static str {
        match self {
            ClipboardKind::Text => "TEXT",
            ClipboardKind::Url => "URL",
            ClipboardKind::Code => "CODE",
        }
    }
}

/// Classify clipboard content heuristically.
pub fn classify(content: &str) -> ClipboardKind {
    let trimmed = content.trim();

    // URL: starts with http/https/ftp or is a bare domain-ish string.
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("ftp://")
    {
        return ClipboardKind::Url;
    }

    // Code heuristics: contains common code markers.
    let code_markers = [
        "fn ", "def ", "class ", "import ", "require(", "const ", "let ",
        "var ", "func ", "struct ", "enum ", "impl ", "=>", "->", "#!/",
        "{", "}", "()", "[]",
    ];
    let code_score = code_markers
        .iter()
        .filter(|&&m| trimmed.contains(m))
        .count();

    // If 3+ markers hit, treat as code.
    if code_score >= 3 || trimmed.lines().count() > 5 {
        return ClipboardKind::Code;
    }

    ClipboardKind::Text
}

/// Spawn the supervised sensor task.
pub fn spawn() {
    supervise::spawn_supervised("autopilot_sensor_clipboard", || async {
        run_clipboard_loop().await;
    });
}

async fn run_clipboard_loop() {
    let mut last_snapshot: Option<String> = None;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;

        let content = match read_clipboard().await {
            Ok(c) => c,
            Err(e) => {
                log::debug!("[autopilot/clipboard] pbpaste error: {e}");
                continue;
            }
        };

        // Truncate for comparison to bound memory.
        let snapshot: String = content.chars().take(MAX_SNAPSHOT_BYTES).collect();

        // Check for a meaningful change.
        let changed = match &last_snapshot {
            None => !snapshot.is_empty(),
            Some(prev) => *prev != snapshot && !snapshot.is_empty(),
        };

        if !changed {
            continue;
        }

        let kind = classify(&snapshot);
        let prev_len = last_snapshot.as_ref().map(|s| s.len()).unwrap_or(0);

        last_snapshot = Some(snapshot.clone());

        let payload = serde_json::json!({
            "kind": kind.as_str(),
            "length": snapshot.len(),
            "prev_length": prev_len,
            // First 120 chars for debugging; never log full content.
            "preview": snapshot.chars().take(120).collect::<String>(),
        })
        .to_string();

        event_bus::publish(SunnyEvent::AutopilotSignal {
            seq: 0,
            boot_epoch: 0,
            source: "clipboard".to_string(),
            payload,
            at: Utc::now().timestamp_millis(),
        });
    }
}

/// Read clipboard content via `pbpaste` subprocess.
async fn read_clipboard() -> Result<String, String> {
    let output = tokio::process::Command::new("pbpaste")
        .output()
        .await
        .map_err(|e| format!("pbpaste spawn: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "pbpaste exit {:?}",
            output.status.code()
        ));
    }

    String::from_utf8(output.stdout).map_err(|e| format!("pbpaste utf8: {e}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_http_url() {
        assert_eq!(classify("https://example.com/path"), ClipboardKind::Url);
        assert_eq!(classify("http://localhost:3000"), ClipboardKind::Url);
    }

    #[test]
    fn classify_ftp_url() {
        assert_eq!(classify("ftp://files.example.com/file.zip"), ClipboardKind::Url);
    }

    #[test]
    fn classify_rust_code() {
        let code = "fn main() {\n    let x = 42;\n    println!(\"{}\", x);\n}";
        assert_eq!(classify(code), ClipboardKind::Code);
    }

    #[test]
    fn classify_python_code() {
        let code = "def foo():\n    import os\n    return os.getcwd()\n\nclass Bar:\n    pass";
        assert_eq!(classify(code), ClipboardKind::Code);
    }

    #[test]
    fn classify_plain_text() {
        let text = "Hello, this is a normal sentence without code markers.";
        assert_eq!(classify(text), ClipboardKind::Text);
    }

    #[test]
    fn classify_empty_string_is_text() {
        assert_eq!(classify(""), ClipboardKind::Text);
    }

    #[test]
    fn kind_as_str_values() {
        assert_eq!(ClipboardKind::Text.as_str(), "TEXT");
        assert_eq!(ClipboardKind::Url.as_str(), "URL");
        assert_eq!(ClipboardKind::Code.as_str(), "CODE");
    }

    #[test]
    fn payload_json_shape_is_valid() {
        let payload = serde_json::json!({
            "kind": "CODE",
            "length": 100,
            "prev_length": 0,
            "preview": "fn main() {}",
        })
        .to_string();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["kind"], "CODE");
    }
}
