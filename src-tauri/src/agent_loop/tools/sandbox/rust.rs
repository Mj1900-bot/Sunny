//! `sandbox_run_rust` — compile and run Rust inside sandbox-exec.
//!
//! Wraps user code in a minimal Cargo crate (`main.rs` + `Cargo.toml`),
//! runs `cargo run --release --offline` inside the sandbox.
//!
//! Dependencies listed in `deps` are injected into `Cargo.toml` as
//! `[dependencies]` entries.  Because network is denied in the profile,
//! all crates must already be in `~/.cargo/registry`; the `--offline` flag
//! prevents cargo from attempting a network fetch.
//!
//! Typical cold compile time: 10-30s.  Default timeout: 120s.

use std::collections::HashMap;

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

use super::engine::{run_sandboxed, Profile, SandboxDir, SandboxResult, DEFAULT_RUST_TIMEOUT_MS};
use super::session_gate::{check, GateVerdict};

const CAPS: &[&str] = &["compute.run"];

const SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "code": {"type": "string", "description": "Rust source (fn main() entry point)."},
    "deps": {
      "type": "array",
      "items": {"type": "string"},
      "description": "Cargo dependency lines, e.g. [\"serde = \\\"1\\\"\", \"rand = \\\"0.8\\\"\"]"
    },
    "timeout_ms": {"type": "integer", "description": "Wall-clock budget ms. Default 120000, max 300000."}
  },
  "required": ["code"]
}"#;

fn invoke<'a>(ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let session_id = ctx.session_id.unwrap_or("main");
        if check(session_id) == GateVerdict::ConfirmRequired {
            return Err(
                "sandbox_run_rust: L3 confirm required — awaiting user approval".to_string(),
            );
        }

        let code = input
            .get("code")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("missing string arg `code`")?
            .to_string();

        let deps: Vec<String> = input
            .get("deps")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.to_string())
                    .collect()
            })
            .unwrap_or_default();

        let timeout_ms = input
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_RUST_TIMEOUT_MS)
            .min(300_000);

        let result = run_rust(code, deps, timeout_ms).await?;
        serde_json::to_string(&result).map_err(|e| format!("sandbox_run_rust encode: {e}"))
    })
}

pub async fn run_rust(
    code: String,
    deps: Vec<String>,
    timeout_ms: u64,
) -> Result<SandboxResult, String> {
    let cargo = crate::paths::which("cargo").ok_or_else(|| {
        "cargo not found. Install rustup: https://rustup.rs".to_string()
    })?;

    let sandbox = SandboxDir::create()?;

    // Build the temp crate structure.
    let src_dir = sandbox.path.join("src");
    std::fs::create_dir_all(&src_dir)
        .map_err(|e| format!("create src/: {e}"))?;

    std::fs::write(src_dir.join("main.rs"), &code)
        .map_err(|e| format!("write main.rs: {e}"))?;

    let deps_section = deps.join("\n");

    let cargo_toml = format!(
        r#"[package]
name = "sunny_sandbox_run"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "sunny_sandbox_run"
path = "src/main.rs"

[dependencies]
{deps_section}

[profile.release]
opt-level = 1
"#
    );
    std::fs::write(sandbox.path.join("Cargo.toml"), &cargo_toml)
        .map_err(|e| format!("write Cargo.toml: {e}"))?;

    // Resolve rustup / cargo home for sandbox profile params.
    let home_dir = dirs::home_dir().unwrap_or_default();
    let rustup_home = std::env::var("RUSTUP_HOME")
        .unwrap_or_else(|_| home_dir.join(".rustup").to_string_lossy().into_owned());
    let cargo_home = std::env::var("CARGO_HOME")
        .unwrap_or_else(|_| home_dir.join(".cargo").to_string_lossy().into_owned());

    // All owned strings — no borrow-after-move issues.
    let cargo_bin = cargo.to_string_lossy().into_owned();
    let target_dir = sandbox.path.join("target").to_string_lossy().into_owned();
    let manifest_path = sandbox.path.join("Cargo.toml").to_string_lossy().into_owned();
    let sandbox_home = sandbox.path_str().to_string();

    // argv: /usr/bin/env KEY=VAL ... cargo run ...
    // We use `env` to inject env vars because sandbox-exec -D only sets
    // profile params, not process environment.
    let argv: Vec<String> = vec![
        "/usr/bin/env".into(),
        format!("RUSTUP_HOME={rustup_home}"),
        format!("CARGO_HOME={cargo_home}"),
        format!("HOME={sandbox_home}"),
        "CARGO_NET_OFFLINE=true".into(),
        "TERM=dumb".into(),
        cargo_bin,
        "run".into(),
        "--release".into(),
        "--offline".into(),
        "--target-dir".into(),
        target_dir,
        "--manifest-path".into(),
        manifest_path,
    ];

    let argv_refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();

    let mut params: HashMap<&str, String> = HashMap::new();
    params.insert("RUSTUP_HOME", rustup_home);
    params.insert("CARGO_HOME", cargo_home);

    run_sandboxed(&sandbox, &Profile::Rust, &params, &argv_refs, None, timeout_ms).await
}

inventory::submit! {
    ToolSpec {
        name: "sandbox_run_rust",
        description: "Compile and run Rust code in an isolated macOS sandbox-exec jail. \
            Wraps code in a temp Cargo crate and runs `cargo run --release --offline`. \
            Network denied; writes confined to temp dir. Slow (10-30s compile). \
            Optional `deps` injects Cargo.toml dependencies from local registry cache. \
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

    fn cargo_available() -> bool {
        crate::paths::which("cargo").is_some()
    }

    #[tokio::test]
    #[ignore = "slow: requires cargo compile (~30s)"]
    async fn happy_path_hello_world() {
        if !cargo_available() { return; }
        let code = r#"fn main() { println!("hello from rust sandbox"); }"#;
        let r = run_rust(code.into(), vec![], 120_000)
            .await.expect("run_rust");
        assert_eq!(r.stdout.trim(), "hello from rust sandbox");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    #[ignore = "slow: requires cargo compile (~30s)"]
    async fn network_blocked_in_rust() {
        if !cargo_available() { return; }
        let code = r#"
use std::net::TcpStream;
fn main() {
    match TcpStream::connect("8.8.8.8:53") {
        Ok(_) => { println!("CONNECTED"); std::process::exit(0); }
        Err(e) => { println!("BLOCKED: {}", e); std::process::exit(1); }
    }
}
"#;
        let r = run_rust(code.into(), vec![], 120_000)
            .await.expect("run_rust");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "network should be blocked in rust sandbox; stdout={:?} exit={}", r.stdout, r.exit_code
        );
    }

    #[tokio::test]
    #[ignore = "slow: requires cargo compile (~30s)"]
    async fn write_outside_sandbox_blocked() {
        if !cargo_available() { return; }
        let code = r#"
use std::fs;
fn main() {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let path = format!("{}/sunny_rust_escape.txt", home);
    match fs::write(&path, "escaped") {
        Ok(_) => { println!("WROTE"); std::process::exit(0); }
        Err(e) => { println!("BLOCKED: {}", e); std::process::exit(1); }
    }
}
"#;
        let r = run_rust(code.into(), vec![], 120_000)
            .await.expect("run_rust");
        assert!(
            r.stdout.contains("BLOCKED") || r.exit_code != 0,
            "fs escape should be blocked; stdout={:?} exit={}", r.stdout, r.exit_code
        );
    }
}
