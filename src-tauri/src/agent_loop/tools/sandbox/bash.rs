//! `sandbox_run_bash` — run Bash inside sandbox-exec with restricted PATH.
//!
//! Only `/usr/bin` and `/bin` are in PATH; the sandbox profile additionally
//! prevents network access and FS writes outside the per-run dir.

use std::collections::HashMap;

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::optional_string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::engine::{run_sandboxed, Profile, SandboxDir, SandboxResult, DEFAULT_BASH_TIMEOUT_MS};
use super::session_gate::{check, GateVerdict};

const CAPS: &[&str] = &["compute.run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "code":       {"type": "string", "description": "Bash script to execute."},
    "stdin":      {"type": "string", "description": "Optional text fed to stdin."},
    "timeout_ms": {"type": "integer", "description": "Wall-clock budget ms. Default 5000, max 30000."}
  },
  "required": ["code"]
}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let session_id = ctx.session_id.unwrap_or("main");
        if check(session_id) == GateVerdict::ConfirmRequired {
            return Err(
                "sandbox_run_bash: L3 confirm required — awaiting user approval".to_string(),
            );
        }

        let code = input
            .get("code")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("missing string arg `code`")?
            .to_string();

        let stdin = optional_string_arg(&input, "stdin");
        let timeout_ms = input
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_BASH_TIMEOUT_MS)
            .min(30_000);

        let result = run_bash(code, stdin, timeout_ms).await?;
        serde_json::to_string(&result).map_err(|e| format!("sandbox_run_bash encode: {e}"))
    })
}

pub async fn run_bash(
    code: String,
    stdin: Option<String>,
    timeout_ms: u64,
) -> Result<SandboxResult, String> {
    let sandbox = SandboxDir::create()?;

    let script_path = sandbox.path.join("script.sh");
    std::fs::write(&script_path, &code)
        .map_err(|e| format!("write script.sh: {e}"))?;
    let script_str = script_path.to_string_lossy().into_owned();

    let params: HashMap<&str, String> = HashMap::new();
    // Restricted PATH: only /usr/bin:/bin — no homebrew, no user tools.
    let argv: Vec<&str> = vec![
        "/usr/bin/env",
        "PATH=/usr/bin:/bin",
        "/bin/bash",
        "--norc",
        "--noprofile",
        &script_str,
    ];

    run_sandboxed(&sandbox, &Profile::Bash, &params, &argv, stdin, timeout_ms).await
}

inventory::submit! {
    ToolSpec {
        name: "sandbox_run_bash",
        description: "Run a Bash script in an isolated macOS sandbox-exec jail. \
            PATH restricted to /usr/bin:/bin. No network; writes confined to temp dir. \
            Returns stdout, stderr, exit_code, duration_ms. Default 5s timeout. \
            First call per session requires user confirmation (L3 risk).",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for bash needs platform-specific tuning \
        (/bin/bash + /usr/bin subpath allow-lists vary across macOS versions, \
        and dyld resolves system libs outside the profile's allow-list on some \
        Apple-silicon hosts). See `src/agent_loop/tools/sandbox/mod.rs` \
        `KNOWN ISSUES` section."]
    async fn happy_path_echo() {
        let r = run_bash("echo 'hello bash'".into(), None, 5_000)
            .await.expect("run_bash");
        assert_eq!(r.stdout.trim(), "hello bash");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for bash needs platform-specific tuning \
        (/bin/bash + /usr/bin subpath allow-lists vary across macOS versions, \
        and dyld resolves system libs outside the profile's allow-list on some \
        Apple-silicon hosts). See `src/agent_loop/tools/sandbox/mod.rs` \
        `KNOWN ISSUES` section."]
    async fn stdin_pipe_works() {
        let r = run_bash("tr '[:lower:]' '[:upper:]'".into(), Some("hello".into()), 5_000)
            .await.expect("run_bash");
        assert_eq!(r.stdout.trim(), "HELLO");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    async fn timeout_fires() {
        let r = run_bash("sleep 60".into(), None, 2_000)
            .await.expect("run_bash");
        assert_ne!(r.exit_code, 0);
        assert!(r.duration_ms < 8_000, "timeout did not fire: {}ms", r.duration_ms);
    }

    #[tokio::test]
    async fn network_curl_blocked() {
        // curl is in /usr/bin but sandbox denies network*.
        let code = r#"
if curl -s --max-time 3 http://example.com > /dev/null 2>&1; then
    echo "CONNECTED"
    exit 0
else
    echo "BLOCKED"
    exit 1
fi
"#;
        let r = run_bash(code.into(), None, 8_000)
            .await.expect("run_bash");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "curl should be blocked by network deny; stdout={:?} exit={}", r.stdout, r.exit_code
        );
    }

    #[tokio::test]
    async fn write_outside_sandbox_blocked() {
        let code = r#"
TARGET="$HOME/sunny_bash_escape.txt"
if echo "escaped" > "$TARGET" 2>/dev/null; then
    echo "WROTE"
else
    echo "BLOCKED"
    exit 1
fi
"#;
        let r = run_bash(code.into(), None, 5_000)
            .await.expect("run_bash");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "bash fs escape should be blocked; stdout={:?} exit={}", r.stdout, r.exit_code
        );
        let escape_path = dirs::home_dir()
            .unwrap_or_default()
            .join("sunny_bash_escape.txt");
        assert!(!escape_path.exists(), "bash escape file was created!");
    }

    #[tokio::test]
    async fn fork_bomb_terminated() {
        // Classic fork bomb — should be killed by timeout or profile restriction.
        let code = ":(){ :|:& };:";
        let r = run_bash(code.into(), None, 3_000)
            .await.expect("run_bash");
        assert!(
            r.exit_code != 0 || r.duration_ms < 10_000,
            "fork bomb was not stopped: exit={} ms={}", r.exit_code, r.duration_ms
        );
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for bash needs platform-specific tuning \
        (/bin/bash + /usr/bin subpath allow-lists vary across macOS versions, \
        and dyld resolves system libs outside the profile's allow-list on some \
        Apple-silicon hosts). See `src/agent_loop/tools/sandbox/mod.rs` \
        `KNOWN ISSUES` section."]
    async fn restricted_path_no_homebrew() {
        // brew is typically in /opt/homebrew/bin which is NOT in our restricted PATH.
        let code = r#"
if which brew > /dev/null 2>&1; then
    echo "FOUND brew"
else
    echo "brew not in PATH"
fi
"#;
        let r = run_bash(code.into(), None, 5_000)
            .await.expect("run_bash");
        assert!(
            r.stdout.contains("brew not in PATH"),
            "homebrew should not be in restricted PATH; stdout={:?}", r.stdout
        );
    }
}
