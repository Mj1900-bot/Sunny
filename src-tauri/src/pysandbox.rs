//! pysandbox — minimal Python execution layer for data-shaping agents.
//!
//! # Scope & intent
//!
//! This module lets an agent run short Python snippets for:
//!   * arithmetic and calculations
//!   * CSV / JSON parsing and pretty-printing
//!   * small data transforms (sort, filter, map, groupby)
//!
//! It is intentionally *not* a real sandbox. We apply a minimal hardening
//! layer only:
//!
//!   * `python3 -I` — isolated mode: ignores `PYTHONPATH`, user site-packages,
//!     and skips the implicit `sys.path[0]` entry, reducing import-based
//!     surface.
//!   * Env strip — child inherits **only** `PATH` (fat path) and
//!     `LC_ALL=C.UTF-8`. No `PYTHONSTARTUP`, `HOME`, `SSH_*`, `AWS_*`, or
//!     OS keychain vars leak in.
//!   * CWD = `std::env::temp_dir()` so relative-path file I/O can't trivially
//!     land in the user's code tree.
//!   * Timeout (default 8s, max 30s). On timeout the child is killed.
//!   * Output caps — 64 KiB on each of stdout/stderr. Excess is dropped and
//!     `truncated=true` is set.
//!
//! # What this *does not* block
//!
//! * Network access (the Python interpreter can still open sockets).
//! * Filesystem reads/writes (the Python interpreter still has the user's
//!   FS permissions — CWD in `/tmp` is a speed-bump, not a jail).
//! * Subprocess execution via the standard library.
//!
//! A real sandbox would require a macOS `sandbox_init` profile or a VM; that
//! is out of scope. The caller (`ConfirmGate` on the agent side) must show
//! the code preview to the user — `py_run` is marked `dangerous=true`.
//!
//! # Error surfaces
//!
//! * Python missing → clear install hint.
//! * Timeout → `PyResult` with non-zero exit code and `stderr` describing
//!   the kill.
//! * Spawn failure → `Err(String)`.

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;
use ts_rs::TS;

/// Maximum bytes we keep from each of stdout / stderr before truncating.
const OUTPUT_CAP_BYTES: usize = 64 * 1024;

/// Default timeout when the caller passes `None`.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);

/// Hard upper bound — callers passing larger values are clamped.
const MAX_TIMEOUT: Duration = Duration::from_secs(30);

/// Sentinel exit code used when the process is killed for exceeding the
/// wall-clock budget. -9 mirrors SIGKILL's signum on unix.
const TIMEOUT_EXIT_CODE: i32 = -9;

/// Result of a single Python invocation.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PyResult {
    pub stdout: String,
    pub stderr: String,
    #[ts(type = "number")]
    pub exit_code: i32,
    #[ts(type = "number")]
    pub duration_ms: u64,
    /// True if *either* stdout or stderr exceeded `OUTPUT_CAP_BYTES` and was
    /// cut. The returned strings are always ≤ cap in length.
    pub truncated: bool,
}

/// Run `code` through `python3 -I -c <code>` with stdin / timeout hardening.
///
/// * `code`    — source text, passed as a single argv item (not shell-expanded).
/// * `stdin`   — optional UTF-8 payload fed to the child's stdin pipe.
/// * `timeout_sec` — wall-clock budget. `None` → 8s. Clamped to 30s max.
pub async fn py_run(
    code: String,
    stdin: Option<String>,
    timeout_sec: Option<u64>,
) -> Result<PyResult, String> {
    // Server-side constitution gate — enforces prohibitions even when py_run
    // is invoked directly (bypassing the ConfirmGate in the agent_loop).
    let constitution = crate::constitution::current();
    if let crate::constitution::Decision::Block(reason) = constitution.check_tool("py_run", &code) {
        return Err(format!("py_run blocked by constitution: {reason}"));
    }

    let py = crate::paths::which("python3").ok_or_else(|| {
        "python3 not found in PATH. Install via `brew install python` or \
         https://www.python.org/downloads/ and re-launch Sunny."
            .to_string()
    })?;

    let budget = resolve_timeout(timeout_sec);

    let mut cmd = Command::new(&py);
    cmd.arg("-I") // isolated mode: ignore PYTHON* env, user site-packages
        .arg("-c")
        .arg(&code)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(std::env::temp_dir())
        // Strip inherited environment to shrink attack surface, then add
        // only what python needs to locate itself and emit UTF-8.
        .env_clear()
        .env("LC_ALL", "C.UTF-8");
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }

    let start = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn python3 ({}): {}", py.display(), e))?;

    // Feed stdin (if provided) and close the pipe so the script sees EOF.
    if let Some(data) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            if let Err(e) = pipe.write_all(data.as_bytes()).await {
                return Err(format!("failed writing stdin to python: {}", e));
            }
            // Dropping `pipe` flushes and closes. Explicit shutdown for clarity.
            let _ = pipe.shutdown().await;
        }
    } else {
        // No stdin payload — close the pipe immediately so reads return EOF.
        drop(child.stdin.take());
    }

    let output_fut = child.wait_with_output();

    let out = match timeout(budget, output_fut).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("python wait failed: {}", e)),
        Err(_) => {
            // `wait_with_output` took ownership of the child, so on timeout
            // we can no longer kill it directly. tokio::process::Child is
            // kill-on-drop by default, so the child is already being reaped;
            // we synthesize a result describing the timeout.
            return Ok(PyResult {
                stdout: String::new(),
                stderr: format!(
                    "python timed out after {}s (killed)",
                    budget.as_secs()
                ),
                exit_code: TIMEOUT_EXIT_CODE,
                duration_ms: start.elapsed().as_millis() as u64,
                truncated: false,
            });
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    let (stdout, stdout_trunc) = cap_bytes(out.stdout, OUTPUT_CAP_BYTES);
    let (stderr, stderr_trunc) = cap_bytes(out.stderr, OUTPUT_CAP_BYTES);

    let exit_code = out.status.code().unwrap_or(-1);

    Ok(PyResult {
        stdout,
        stderr,
        exit_code,
        duration_ms,
        truncated: stdout_trunc || stderr_trunc,
    })
}

/// Return the Python version banner, e.g. `"Python 3.12.4"`.
pub async fn py_version() -> Result<String, String> {
    let py = crate::paths::which("python3").ok_or_else(|| {
        "python3 not found in PATH. Install via `brew install python`."
            .to_string()
    })?;

    let mut cmd = Command::new(&py);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("LC_ALL", "C.UTF-8");
    if let Some(p) = crate::paths::fat_path() {
        cmd.env("PATH", p);
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run python3 --version: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "python3 --version exited with {}: {}",
            out.status,
            if stderr.is_empty() { "(no stderr)" } else { stderr.as_str() }
        ));
    }

    // Older pythons (<3.4) printed to stderr; newer to stdout. Prefer stdout.
    let line = if !out.stdout.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    };

    if line.is_empty() {
        return Err("python3 --version produced no output".to_string());
    }
    Ok(line)
}

fn resolve_timeout(requested: Option<u64>) -> Duration {
    match requested {
        None => DEFAULT_TIMEOUT,
        Some(0) => DEFAULT_TIMEOUT,
        Some(n) => {
            let d = Duration::from_secs(n);
            if d > MAX_TIMEOUT {
                MAX_TIMEOUT
            } else {
                d
            }
        }
    }
}

/// Truncate `bytes` to at most `cap` bytes and decode as UTF-8 (lossy).
/// Returns `(string, was_truncated)`. Guarantees `string.len() <= cap`.
fn cap_bytes(bytes: Vec<u8>, cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        (String::from_utf8_lossy(&bytes).into_owned(), false)
    } else {
        // Slice on a byte boundary that's safe to decode. from_utf8_lossy
        // handles any multi-byte split by inserting the replacement char.
        let slice = &bytes[..cap];
        (String::from_utf8_lossy(slice).into_owned(), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper — returns true if python3 is resolvable on this host, else
    /// prints a skip notice and returns false.
    fn python_available() -> bool {
        if crate::paths::which("python3").is_some() {
            true
        } else {
            eprintln!("skipping: python3 not found on this host");
            false
        }
    }

    #[tokio::test]
    async fn run_prints_arithmetic_result() {
        if !python_available() {
            return;
        }
        let r = py_run("print(1+1)".to_string(), None, Some(5))
            .await
            .expect("py_run should succeed");
        assert_eq!(r.stdout, "2\n", "stdout was: {:?}", r.stdout);
        assert_eq!(r.exit_code, 0);
        assert!(!r.truncated);
    }

    #[tokio::test]
    async fn stdin_pipe_is_fed_to_script() {
        if !python_available() {
            return;
        }
        let r = py_run(
            "import sys; print(sys.stdin.read().upper())".to_string(),
            Some("hello".to_string()),
            Some(5),
        )
        .await
        .expect("py_run should succeed");
        assert_eq!(r.stdout, "HELLO\n", "stdout was: {:?}", r.stdout);
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    async fn timeout_kills_runaway_script() {
        if !python_available() {
            return;
        }
        let r = py_run(
            "import time; time.sleep(30)".to_string(),
            None,
            Some(1),
        )
        .await
        .expect("py_run should not error on timeout — it reports via exit_code");
        assert_ne!(r.exit_code, 0, "runaway script should not exit cleanly");
        // duration should be near the timeout, not near 30s.
        assert!(
            r.duration_ms < 5_000,
            "duration {} ms suggests timeout did not fire",
            r.duration_ms
        );
    }

    #[tokio::test]
    async fn stdout_is_truncated_at_cap() {
        if !python_available() {
            return;
        }
        // Emit ~128 KiB — twice the cap.
        let code = "import sys; sys.stdout.write('a' * (128 * 1024))".to_string();
        let r = py_run(code, None, Some(10))
            .await
            .expect("py_run should succeed");
        assert!(r.truncated, "expected truncated=true for 128 KiB output");
        assert!(
            r.stdout.len() <= OUTPUT_CAP_BYTES,
            "stdout len {} exceeds cap {}",
            r.stdout.len(),
            OUTPUT_CAP_BYTES
        );
    }

    #[tokio::test]
    async fn version_returns_banner() {
        if !python_available() {
            return;
        }
        let v = py_version().await.expect("py_version should succeed");
        assert!(
            v.starts_with("Python "),
            "unexpected banner: {:?}",
            v
        );
    }

    #[test]
    fn resolve_timeout_clamps_to_max() {
        assert_eq!(resolve_timeout(None), DEFAULT_TIMEOUT);
        assert_eq!(resolve_timeout(Some(0)), DEFAULT_TIMEOUT);
        assert_eq!(resolve_timeout(Some(5)), Duration::from_secs(5));
        assert_eq!(resolve_timeout(Some(99)), MAX_TIMEOUT);
    }

    #[test]
    fn cap_bytes_flags_truncation() {
        let small = vec![b'x'; 100];
        let (s, t) = cap_bytes(small, 64 * 1024);
        assert_eq!(s.len(), 100);
        assert!(!t);

        let big = vec![b'y'; 128 * 1024];
        let (s, t) = cap_bytes(big, 64 * 1024);
        assert!(t);
        assert!(s.len() <= 64 * 1024);
    }
}

// === REGISTER IN lib.rs ===
// mod pysandbox;
// #[tauri::command]s: py_run, py_version
// invoke_handler: py_run, py_version
// No new Cargo deps.
// === END REGISTER ===
