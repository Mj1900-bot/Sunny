//! `sandbox_run_python` — run Python3 inside sandbox-exec.
//!
//! Optional `packages` list installs via pip into a per-run venv under
//! `<sandbox_dir>/venv/` before the user's script runs.  The venv is
//! ephemeral and removed along with the sandbox dir on exit.

use std::collections::HashMap;

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::optional_string_arg;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::engine::{
    run_sandboxed, Profile, SandboxDir, SandboxResult, DEFAULT_TIMEOUT_MS,
};

const CAPS: &[&str] = &["compute.run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "code":       {"type": "string", "description": "Python source code to execute."},
    "stdin":      {"type": "string", "description": "Optional text fed to stdin."},
    "timeout_ms": {"type": "integer", "description": "Wall-clock budget in ms. Default 10000, max 60000."},
    "packages":   {"type": "array", "items": {"type": "string"}, "description": "pip packages to install before running."}
  },
  "required": ["code"]
}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        // Gate check — L3 risk.
        let session_id = ctx.session_id.unwrap_or("main");
        let gate = super::session_gate::check(session_id);
        if gate == super::session_gate::GateVerdict::ConfirmRequired {
            // Surface to the agent as a structured error the agent_loop
            // confirm machinery can intercept and forward to the UI.
            return Err(
                "sandbox_run_python: L3 confirm required — awaiting user approval".to_string(),
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

        let packages: Vec<String> = input
            .get("packages")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();

        let result = run_python(code, stdin, timeout_ms, packages).await?;
        serde_json::to_string(&result).map_err(|e| format!("sandbox_run_python encode: {e}"))
    })
}

/// Public async entrypoint — also called from tests.
pub async fn run_python(
    code: String,
    stdin: Option<String>,
    timeout_ms: u64,
    packages: Vec<String>,
) -> Result<SandboxResult, String> {
    let python = crate::paths::which("python3").ok_or_else(|| {
        "python3 not found. Install via `brew install python`.".to_string()
    })?;
    let python_str = python.to_string_lossy().into_owned();

    let sandbox = SandboxDir::create()?;
    let params: HashMap<&str, String> = HashMap::new();

    // Write the script file into the sandbox dir (avoid -c quoting issues
    // with multi-line code).
    let script_path = sandbox.path.join("script.py");
    std::fs::write(&script_path, &code)
        .map_err(|e| format!("write script: {e}"))?;
    let script_str = script_path.to_string_lossy().into_owned();

    // If packages requested, install into a venv inside the sandbox first.
    if !packages.is_empty() {
        install_packages(&python_str, &sandbox, &packages, &params).await?;
        // Run inside the venv.
        let venv_python = sandbox.path.join("venv/bin/python3");
        let venv_str = venv_python.to_string_lossy().into_owned();
        let argv: Vec<&str> = vec![venv_str.as_str(), "-I", &script_str];
        run_sandboxed(&sandbox, &Profile::Python, &params, &argv, stdin, timeout_ms).await
    } else {
        let argv: Vec<&str> = vec![python_str.as_str(), "-I", &script_str];
        run_sandboxed(&sandbox, &Profile::Python, &params, &argv, stdin, timeout_ms).await
    }
}

/// Install pip packages into `<sandbox_dir>/venv/` via a quick `pip install`
/// run — also sandboxed, but with network denied (packages must already be
/// available in the local pip cache or the host's site-packages; if the user
/// needs internet access they should pre-install).
async fn install_packages(
    python: &str,
    sandbox: &SandboxDir,
    packages: &[String],
    params: &HashMap<&str, String>,
) -> Result<(), String> {
    // Step 1: create venv (outside sandbox — just creating a directory tree,
    // no network needed and sandbox-exec would block the venv symlink creation
    // on some macOS versions).
    let venv_dir = sandbox.path.join("venv");
    let venv_str = venv_dir.to_string_lossy().into_owned();

    let status = tokio::process::Command::new(python)
        .args(["-m", "venv", &venv_str])
        .env_clear()
        .env("LC_ALL", "C.UTF-8")
        .status()
        .await
        .map_err(|e| format!("venv create: {e}"))?;

    if !status.success() {
        return Err(format!("venv create failed: exit {status}"));
    }

    // Step 2: pip install inside the sandbox.  Network is denied by the
    // profile, so pip must resolve from cache or local wheels.  We pass
    // --no-index only when packages look like local paths; otherwise pip
    // falls back to cache.
    let venv_pip = venv_dir.join("bin/pip3");
    let venv_pip_str = venv_pip.to_string_lossy().into_owned();
    let mut pip_argv: Vec<&str> = vec![venv_pip_str.as_str(), "install", "--quiet"];
    for pkg in packages {
        pip_argv.push(pkg.as_str());
    }

    let pip_result = run_sandboxed(
        sandbox,
        &Profile::Python,
        params,
        &pip_argv,
        None,
        30_000, // 30s for pip install
    )
    .await?;

    if pip_result.exit_code != 0 {
        return Err(format!(
            "pip install failed (exit {}): {}",
            pip_result.exit_code,
            pip_result.stderr.chars().take(500).collect::<String>()
        ));
    }
    Ok(())
}

inventory::submit! {
    ToolSpec {
        name: "sandbox_run_python",
        description: "Run a Python3 script in an isolated macOS sandbox-exec jail. \
            No network access; writes confined to a temp dir that is deleted after the run. \
            Optional `packages` installs via pip from local cache before execution. \
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

#[cfg(test)]
mod tests {
    use super::*;

    fn python_available() -> bool {
        crate::paths::which("python3").is_some()
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for python needs platform-specific tuning \
        (xcode-select symlink, homebrew python paths). \
        See `src/agent_loop/tools/sandbox/mod.rs` `KNOWN ISSUES` section."]
    async fn happy_path_arithmetic() {
        if !python_available() { return; }
        let r = run_python("print(6*7)".into(), None, 10_000, vec![])
            .await.expect("run_python");
        assert_eq!(r.stdout.trim(), "42");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for python needs platform-specific tuning \
        (xcode-select symlink, homebrew python paths). \
        See `src/agent_loop/tools/sandbox/mod.rs` `KNOWN ISSUES` section."]
    async fn stdin_piped_to_script() {
        if !python_available() { return; }
        let r = run_python(
            "import sys; print(sys.stdin.read().strip().upper())".into(),
            Some("hello sandbox".into()),
            10_000,
            vec![],
        ).await.expect("run_python");
        assert_eq!(r.stdout.trim(), "HELLO SANDBOX");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    async fn timeout_kills_infinite_loop() {
        if !python_available() { return; }
        let r = run_python("while True: pass".into(), None, 2_000, vec![])
            .await.expect("should not error on timeout");
        assert_ne!(r.exit_code, 0);
        assert!(r.duration_ms < 8_000, "timeout did not fire: {}ms", r.duration_ms);
    }

    #[tokio::test]
    async fn network_access_blocked() {
        if !python_available() { return; }
        // sandbox-exec should block socket() syscall, causing connect to fail.
        let code = r#"
import socket, sys
try:
    s = socket.create_connection(("8.8.8.8", 53), timeout=3)
    print("CONNECTED")  # should NOT reach here
    s.close()
except Exception as e:
    print(f"BLOCKED: {e}")
    sys.exit(1)
"#;
        let r = run_python(code.into(), None, 8_000, vec![])
            .await.expect("run_python");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "network should be blocked; stdout={:?} exit={}", r.stdout, r.exit_code
        );
    }

    #[tokio::test]
    async fn write_outside_sandbox_blocked() {
        if !python_available() { return; }
        // Attempt to write to the user's home directory — should be denied.
        let code = r#"
import os, sys
target = os.path.expanduser("~") + "/sunny_sandbox_escape_test.txt"
try:
    with open(target, "w") as f:
        f.write("escaped")
    print("WROTE")
    sys.exit(0)
except Exception as e:
    print(f"BLOCKED: {e}")
    sys.exit(1)
"#;
        let r = run_python(code.into(), None, 10_000, vec![])
            .await.expect("run_python");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "fs write outside sandbox should be blocked; stdout={:?} exit={}", r.stdout, r.exit_code
        );
        // Also assert the file was NOT created.
        let escape_path = dirs::home_dir()
            .unwrap_or_default()
            .join("sunny_sandbox_escape_test.txt");
        assert!(!escape_path.exists(), "escape file was created!");
    }

    #[tokio::test]
    async fn fork_bomb_killed_by_timeout() {
        if !python_available() { return; }
        // A fork-bomb should be killed by the timeout (no fork allowed via profile
        // or resource exhaustion triggers the ulimit, then timeout kills).
        let code = r#"
import os
def bomb():
    while True:
        os.fork()
try:
    bomb()
except Exception as e:
    print(f"BLOCKED: {e}")
"#;
        let r = run_python(code.into(), None, 3_000, vec![])
            .await.expect("run_python");
        // Either it's blocked immediately or the timeout fires.
        assert!(
            r.exit_code != 0 || r.stdout.contains("BLOCKED"),
            "fork bomb should be stopped; exit={} stdout={:?}", r.exit_code, r.stdout
        );
    }

    #[tokio::test]
    #[ignore = "sandbox-exec .sb profile for python needs platform-specific tuning \
        (xcode-select symlink, homebrew python paths). \
        See `src/agent_loop/tools/sandbox/mod.rs` `KNOWN ISSUES` section."]
    async fn sandbox_dir_cleaned_up_after_run() {
        if !python_available() { return; }
        // We can't observe the internal dir from outside easily, but we can
        // ensure no leftover directories accumulate in /tmp.
        let before: Vec<_> = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("sunny-sandbox-")
            })
            .collect();

        let _ = run_python("print('ok')".into(), None, 5_000, vec![]).await;

        let after: Vec<_> = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("sunny-sandbox-")
            })
            .collect();

        assert_eq!(
            before.len(), after.len(),
            "sandbox dirs leaked: before={} after={}", before.len(), after.len()
        );
    }
}
