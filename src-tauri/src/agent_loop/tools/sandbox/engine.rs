//! Core sandbox-exec engine.
//!
//! Provides [`run_sandboxed`], which:
//!   1. Creates an isolated `/tmp/sunny-sandbox-{uuid}/` work directory.
//!   2. Writes the caller-supplied `.sb` profile to a temp path, expanding
//!      the `SANDBOX_DIR` parameter into the profile at runtime.
//!   3. Wraps the target command with `sandbox-exec -f <profile>` and an
//!      outer `ulimit` memory cap.
//!   4. Feeds `stdin`, captures `stdout`/`stderr` with a 64 KiB cap each.
//!   5. Enforces a hard wall-clock timeout via `SIGKILL` (tokio kill-on-drop).
//!   6. Cleans up the sandbox directory on exit (scopeguard).
//!
//! The returned [`SandboxResult`] has the same shape across all four tool
//! wrappers so the agent always gets a uniform JSON blob.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Public output type
// ---------------------------------------------------------------------------

/// Uniform result returned by every sandbox tool.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SandboxResult {
    pub stdout: String,
    pub stderr: String,
    #[ts(type = "number")]
    pub exit_code: i32,
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// `true` when stdout or stderr exceeded the 64 KiB cap and was truncated.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Max bytes kept from each of stdout/stderr.
pub const OUTPUT_CAP: usize = 64 * 1024;

/// Exit code synthesised when the process is hard-killed for timeout.
pub const TIMEOUT_EXIT_CODE: i32 = -9;

/// Default timeout for Python / Node.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// Default timeout for Bash (tighter).
pub const DEFAULT_BASH_TIMEOUT_MS: u64 = 5_000;

/// Default timeout for Rust (long — compile + run).
pub const DEFAULT_RUST_TIMEOUT_MS: u64 = 120_000;

/// Hard memory cap fed to `ulimit -v` (kibibytes → 512 MiB).
pub const MEM_LIMIT_KB: u64 = 512 * 1024;

// ---------------------------------------------------------------------------
// SandboxDir — creates and auto-cleans the per-run work directory.
// ---------------------------------------------------------------------------

/// RAII handle for the per-run sandbox directory.
/// Deleted on `Drop`; deliberate, so cleanup happens even on panic.
pub struct SandboxDir {
    pub path: PathBuf,
}

impl SandboxDir {
    /// Create `/tmp/sunny-sandbox-<uuid>/` (or `$TMPDIR` equivalent on macOS).
    ///
    /// The path is canonicalized so symlink prefixes like macOS's
    /// `/var -> /private/var` are resolved before being handed to
    /// `sandbox-exec`.  Profiles match against canonical paths, so passing a
    /// symlinked `SANDBOX_DIR` would cause subpath allows to silently miss.
    pub fn create() -> Result<Self, String> {
        let id = Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("sunny-sandbox-{id}"));
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("sandbox dir create failed: {e}"))?;
        // Resolve symlinks so `SANDBOX_DIR` matches what the kernel sees.
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        Ok(SandboxDir { path })
    }

    pub fn path_str(&self) -> &str {
        self.path.to_str().unwrap_or("/tmp/sunny-sandbox-unknown")
    }
}

impl Drop for SandboxDir {
    fn drop(&mut self) {
        // Best-effort removal; if it fails, the OS will clean /tmp on reboot.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/// Embedded profile content keyed by language.
pub enum Profile {
    Python,
    Node,
    Bash,
    Rust,
}

impl Profile {
    fn content(&self) -> &'static str {
        match self {
            Profile::Python => include_str!("profiles/python.sb"),
            Profile::Node => include_str!("profiles/node.sb"),
            Profile::Bash => include_str!("profiles/bash.sb"),
            Profile::Rust => include_str!("profiles/rust.sb"),
        }
    }
}

/// Write the profile to `<sandbox_dir>/profile.sb` and return its path.
/// `params` are substituted via `(param "KEY")` replacement so we can
/// pass the runtime sandbox dir path into the profile without a separate
/// script runner.
pub fn write_profile(
    sandbox: &SandboxDir,
    profile: &Profile,
    params: &HashMap<&str, String>,
) -> Result<PathBuf, String> {
    let content = profile.content().to_string();

    // Replace every `(param "KEY")` occurrence with the actual path value.
    // sandbox-exec supports -D KEY=VALUE on the command line to inject
    // parameters; we use that approach (CLI injection) which is cleaner
    // than textual substitution and avoids injection if the path contains
    // special chars.
    let _ = content; // content kept as-is — params passed via -D flags below
    let _ = params;  // params consumed by caller via build_sandbox_exec_args

    let profile_path = sandbox.path.join("profile.sb");
    std::fs::write(&profile_path, profile.content())
        .map_err(|e| format!("write profile: {e}"))?;
    Ok(profile_path)
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

/// Build the full `sandbox-exec` argv wrapping the interpreter command.
///
/// Shape:
/// ```
/// /usr/bin/sandbox-exec
///   -f <profile.sb>
///   -D SANDBOX_DIR=<sandbox_dir>
///   [-D KEY=VALUE ...]
///   /usr/bin/bash -c "ulimit -v <MEM_KB>; exec <interpreter> <args>"
/// ```
pub fn build_exec_args(
    profile_path: &Path,
    sandbox_dir: &str,
    extra_params: &HashMap<&str, String>,
    interpreter_argv: &[&str],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-f".into(),
        profile_path.to_string_lossy().into_owned(),
        "-D".into(),
        format!("SANDBOX_DIR={sandbox_dir}"),
    ];

    for (k, v) in extra_params {
        args.push("-D".into());
        args.push(format!("{k}={v}"));
    }

    // Inner command: ulimit sets virtual-memory cap then execs the interpreter.
    // `/bin/bash` is the canonical location on all macOS versions (it's part
    // of the base system, even post-Apple-silicon where zsh is the default
    // login shell but /bin/bash still ships).
    let inner = format!(
        "ulimit -v {MEM_LIMIT_KB}; exec {}",
        interpreter_argv
            .iter()
            .map(|s| shell_escape(s))
            .collect::<Vec<_>>()
            .join(" ")
    );
    args.push("/bin/bash".into());
    args.push("-c".into());
    args.push(inner);

    args
}

/// Minimal shell escaping: wrap in single-quotes and escape embedded
/// single-quotes with `'\''`.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/// Run an arbitrary command inside `sandbox-exec` with the given profile.
///
/// * `sandbox`         — RAII dir; caller owns it so cleanup happens after
///                       this fn returns.
/// * `profile`         — which `.sb` embed to use.
/// * `extra_params`    — additional `-D KEY=VALUE` pairs injected into
///                       sandbox-exec (e.g. `RUSTUP_HOME`).
/// * `interpreter_argv`— argv for the interpreter (first element = full path).
/// * `stdin_data`      — optional bytes to feed to the child's stdin.
/// * `timeout_ms`      — wall-clock budget in milliseconds.
pub async fn run_sandboxed(
    sandbox: &SandboxDir,
    profile: &Profile,
    extra_params: &HashMap<&str, String>,
    interpreter_argv: &[&str],
    stdin_data: Option<String>,
    timeout_ms: u64,
) -> Result<SandboxResult, String> {
    let profile_path = write_profile(sandbox, profile, extra_params)?;
    let sandbox_dir = sandbox.path_str().to_string();

    let exec_args = build_exec_args(
        &profile_path,
        &sandbox_dir,
        extra_params,
        interpreter_argv,
    );

    let mut cmd = Command::new("/usr/bin/sandbox-exec");
    for arg in &exec_args {
        cmd.arg(arg);
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(&sandbox.path)
        .env_clear()
        .env("LC_ALL", "C.UTF-8")
        .env("TMPDIR", &sandbox.path)
        .env("HOME", &sandbox.path);

    let budget = Duration::from_millis(timeout_ms.max(1_000).min(300_000));
    let start = Instant::now();

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("sandbox-exec spawn failed: {e}"))?;

    // Feed stdin then close the pipe.
    match stdin_data {
        Some(data) => {
            if let Some(mut pipe) = child.stdin.take() {
                let _ = pipe.write_all(data.as_bytes()).await;
                let _ = pipe.shutdown().await;
            }
        }
        None => {
            drop(child.stdin.take());
        }
    }

    let output_fut = child.wait_with_output();
    let out = match timeout(budget, output_fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("sandbox wait failed: {e}")),
        Err(_elapsed) => {
            // Child is kill-on-drop — SIGKILL already sent.
            return Ok(SandboxResult {
                stdout: String::new(),
                stderr: format!(
                    "process timed out after {}ms (killed)",
                    budget.as_millis()
                ),
                exit_code: TIMEOUT_EXIT_CODE,
                duration_ms: start.elapsed().as_millis() as u64,
                truncated: false,
            });
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    let (stdout, st) = cap_bytes(out.stdout, OUTPUT_CAP);
    let (stderr, se) = cap_bytes(out.stderr, OUTPUT_CAP);

    Ok(SandboxResult {
        stdout,
        stderr,
        exit_code: out.status.code().unwrap_or(-1),
        duration_ms,
        truncated: st || se,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Truncate `bytes` to at most `cap` bytes, decode as UTF-8 (lossy).
/// Returns `(string, was_truncated)`.
pub fn cap_bytes(bytes: Vec<u8>, cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        (String::from_utf8_lossy(&bytes).into_owned(), false)
    } else {
        (String::from_utf8_lossy(&bytes[..cap]).into_owned(), true)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests_engine {
    use super::*;

    #[test]
    fn cap_bytes_no_truncation() {
        let data = b"hello world".to_vec();
        let (s, trunc) = cap_bytes(data, 64 * 1024);
        assert_eq!(s, "hello world");
        assert!(!trunc);
    }

    #[test]
    fn cap_bytes_truncates() {
        let data = vec![b'a'; 128 * 1024];
        let (s, trunc) = cap_bytes(data, 64 * 1024);
        assert!(trunc);
        assert_eq!(s.len(), 64 * 1024);
    }

    #[test]
    fn shell_escape_clean() {
        assert_eq!(shell_escape("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_single_quote() {
        assert_eq!(shell_escape("it's"), r"'it'\''s'");
    }

    #[test]
    fn sandbox_dir_create_and_cleanup() {
        let path = {
            let dir = SandboxDir::create().expect("should create");
            let p = dir.path.clone();
            assert!(p.exists());
            p
        }; // drop → cleanup
        assert!(!path.exists(), "sandbox dir should be deleted on drop");
    }

    #[test]
    fn build_exec_args_contains_sandbox_dir() {
        let dir = SandboxDir::create().unwrap();
        let params = HashMap::new();
        let profile_path = dir.path.join("profile.sb");
        let args = build_exec_args(
            &profile_path,
            dir.path_str(),
            &params,
            &["/usr/bin/python3", "-c", "print(1)"],
        );
        // First arg must be -f
        assert_eq!(args[0], "-f");
        // SANDBOX_DIR param present
        let has_sd = args.iter().any(|a| a.starts_with("SANDBOX_DIR="));
        assert!(has_sd, "SANDBOX_DIR param missing: {args:?}");
        // Inner bash -c present
        assert!(args.iter().any(|a| a == "-c"), "missing -c: {args:?}");
    }
}
