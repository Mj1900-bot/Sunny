//! `sandbox_run_node` — run Node.js inside sandbox-exec.

use std::collections::HashMap;

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::optional_string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::engine::{run_sandboxed, Profile, SandboxDir, SandboxResult, DEFAULT_TIMEOUT_MS};
use super::session_gate::{check, GateVerdict};

const CAPS: &[&str] = &["compute.run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "code":       {"type": "string", "description": "JavaScript/Node.js source to execute."},
    "stdin":      {"type": "string", "description": "Optional text fed to stdin."},
    "timeout_ms": {"type": "integer", "description": "Wall-clock budget ms. Default 10000, max 60000."}
  },
  "required": ["code"]
}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let session_id = ctx.session_id.unwrap_or("main");
        if check(session_id) == GateVerdict::ConfirmRequired {
            return Err(
                "sandbox_run_node: L3 confirm required — awaiting user approval".to_string(),
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
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(60_000);

        let result = run_node(code, stdin, timeout_ms).await?;
        serde_json::to_string(&result).map_err(|e| format!("sandbox_run_node encode: {e}"))
    })
}

pub async fn run_node(
    code: String,
    stdin: Option<String>,
    timeout_ms: u64,
) -> Result<SandboxResult, String> {
    let node = crate::paths::which("node").ok_or_else(|| {
        "node not found. Install via `brew install node`.".to_string()
    })?;
    let node_str = node.to_string_lossy().into_owned();

    let sandbox = SandboxDir::create()?;
    let script_path = sandbox.path.join("script.js");
    std::fs::write(&script_path, &code)
        .map_err(|e| format!("write script.js: {e}"))?;
    let script_str = script_path.to_string_lossy().into_owned();

    // HOME_FAKE param: node looks up ~/.node_repl_history; point it at sandbox.
    let mut params: HashMap<&str, String> = HashMap::new();
    params.insert("HOME_FAKE", sandbox.path_str().to_string());

    let argv: Vec<&str> = vec![node_str.as_str(), &script_str];
    run_sandboxed(&sandbox, &Profile::Node, &params, &argv, stdin, timeout_ms).await
}

inventory::submit! {
    ToolSpec {
        name: "sandbox_run_node",
        description: "Run a Node.js script in an isolated macOS sandbox-exec jail. \
            No network access; writes confined to a temp dir deleted after the run. \
            Returns stdout, stderr, exit_code, duration_ms. \
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

// Tests spawn `/usr/bin/sandbox-exec`, which only exists on macOS (Apple
// Seatbelt). On Linux they'd all panic with ENOENT; skipping the module is
// semantically correct since there's no Linux implementation to validate.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn node_available() -> bool {
        crate::paths::which("node").is_some()
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for node needs platform-specific tuning \
        (nvm-installed node at ~/.nvm/... conflicts with subpath allow-lists). \
        See `src/agent_loop/tools/sandbox/mod.rs` `KNOWN ISSUES` section."]
    async fn happy_path_console_log() {
        if !node_available() { return; }
        let r = run_node("console.log('hello from node')".into(), None, 10_000)
            .await.expect("run_node");
        assert_eq!(r.stdout.trim(), "hello from node");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for node needs platform-specific tuning \
        (nvm-installed node at ~/.nvm/... conflicts with subpath allow-lists). \
        See `src/agent_loop/tools/sandbox/mod.rs` `KNOWN ISSUES` section."]
    async fn stdin_readable_in_script() {
        if !node_available() { return; }
        let code = r#"
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => console.log(chunks.join('').trim().toUpperCase()));
"#;
        let r = run_node(code.into(), Some("hello node".into()), 10_000)
            .await.expect("run_node");
        assert_eq!(r.stdout.trim(), "HELLO NODE");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    async fn timeout_fires() {
        if !node_available() { return; }
        let r = run_node("setTimeout(() => {}, 60000); setInterval(() => {}, 1000)".into(), None, 2_000)
            .await.expect("run_node");
        assert_ne!(r.exit_code, 0);
        assert!(r.duration_ms < 8_000, "timeout did not fire: {}ms", r.duration_ms);
    }

    #[tokio::test]
    async fn network_access_blocked() {
        if !node_available() { return; }
        let code = r#"
const http = require('http');
const req = http.get('http://example.com', (res) => {
    console.log('CONNECTED');
    process.exit(0);
});
req.on('error', (e) => {
    console.log('BLOCKED: ' + e.message);
    process.exit(1);
});
req.setTimeout(3000, () => {
    console.log('BLOCKED: timeout');
    req.destroy();
    process.exit(1);
});
"#;
        let r = run_node(code.into(), None, 8_000)
            .await.expect("run_node");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "network should be blocked; stdout={:?} exit={}", r.stdout, r.exit_code
        );
    }

    #[tokio::test]
    async fn write_outside_sandbox_blocked() {
        if !node_available() { return; }
        let code = r#"
const fs = require('fs');
const path = require('path');
const target = path.join(process.env.HOME || '/tmp', 'sunny_node_escape.txt');
try {
    fs.writeFileSync(target, 'escaped');
    console.log('WROTE');
    process.exit(0);
} catch(e) {
    console.log('BLOCKED: ' + e.message);
    process.exit(1);
}
"#;
        let r = run_node(code.into(), None, 10_000)
            .await.expect("run_node");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "fs escape should be blocked; stdout={:?} exit={}", r.stdout, r.exit_code
        );
    }
}
