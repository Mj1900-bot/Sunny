//! tools_shell — allowlist-gated sandboxed shell executor.
//!
//! # Scope & intent
//!
//! `shell_sandboxed` is a companion to the long-standing `run_shell`
//! Tauri command. Both coexist because they serve different contexts:
//!
//!   * `run_shell` (in `control.rs`) — the fully-powered gate that
//!     executes an arbitrary command line through `/bin/zsh -lc`. Useful
//!     from the HUD where the user is explicitly driving the machine,
//!     but it's *too* powerful to expose freely to the agent loop — the
//!     LLM could pipe `curl | sh`, `rm -rf ~`, etc.
//!
//!   * `shell_sandboxed` (this module) — a narrowed surface the agent
//!     can reach for without a per-call `ConfirmGate`. It exec-spawns
//!     a single binary from a fixed allowlist with no shell interpretation,
//!     no metacharacter expansion, env-scrubbed to a known-good PATH,
//!     and capped at 60 seconds wall-clock. The allowlist *is* the gate.
//!
//! # What's enforced
//!
//! 1. First token must be one of `ALLOWED_COMMANDS` — e.g. `ls`, `git`,
//!    `grep`, `find`, `jq`, `curl`. No Python, no shells, no `sudo`, no
//!    privilege-elevation binaries.
//! 2. No shell metacharacters survive anywhere in the command: `|`, `;`,
//!    `&`, `&&`, `||`, `>`, `<`, `>>`, backticks, `$(...)`, `>(...)`,
//!    `<(...)`, `..` (directory escape), `/etc`, `/private`, `~root`.
//! 3. No destructive/privileged sub-args: any token containing `rm`,
//!    `sudo`, `chmod 7…`, `chown`, `mv /`, `dd `, `mkfs` is rejected.
//! 4. `cwd` defaults to `$HOME`. Must exist and must not live under
//!    `/etc` or `/System`.
//! 5. Timeout default 15 s, max 60 s. Child is kill-on-drop.
//! 6. Execution goes through `tokio::process::Command` with `env_clear()`
//!    and a known-good `PATH` + `LC_ALL=C.UTF-8`. No shell wrapper — the
//!    first token is exec'd directly and subsequent tokens are passed
//!    as individual argv items, so there is no shell expansion phase
//!    for the caller to exploit.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::control::ShellResult;

/// Default wall-clock budget when the caller passes `None`.
const DEFAULT_TIMEOUT_SECS: u64 = 15;

/// Hard upper bound on the caller-supplied timeout.
const MAX_TIMEOUT_SECS: u64 = 60;

/// Binaries the agent is allowed to invoke. Chosen for observational
/// value (read/inspect, compute hashes, resolve DNS) with minimal risk
/// of side effects. `curl`/`wget` fetch external URLs but cannot, on
/// their own, elevate privileges or mutate the filesystem outside the
/// working directory; the token-rejection layer still refuses anything
/// that looks like `| sh` style chains.
const ALLOWED_COMMANDS: &[&str] = &[
    "ls", "pwd", "echo", "cat", "head", "tail", "grep", "find", "git",
    "wc", "sort", "uniq", "date", "uname", "which", "whoami", "hostname",
    "df", "du", "ps", "ping", "host", "dig", "curl", "wget", "jq",
    "awk", "sed", "cut", "tr", "sha1sum", "sha256sum", "md5", "file",
    "stat",
];

/// Substrings that, if they appear *anywhere* inside any token, reject
/// the command outright. Shell metacharacters, path-escape sentinels,
/// and a couple of sensitive directory prefixes. We walk tokens rather
/// than the raw string so a literal pipe inside single-quotes (which
/// the tokenizer preserves as a plain character) still trips this list.
const FORBIDDEN_TOKEN_SUBSTRINGS: &[&str] = &[
    "|", ">", "<", ">>", ";", "&", "&&", "||",
    "`", "$(", "$()", ">(", "<(",
    "..", "/etc", "/private", "~root",
];

/// Destructive / privileged argv tokens. Matched case-sensitively on a
/// substring basis so `rm`, `RM`-equivalents (none on macOS), `sudo`,
/// `chmod 700`/`chmod 777`, `chown`, `mv /`, `dd `, `mkfs` all trip.
const FORBIDDEN_ARG_SUBSTRINGS: &[&str] = &[
    "rm", "sudo", "chmod 7", "chown", "mv /", "dd ", "mkfs",
];

/// Directory prefixes the caller may not point `cwd` at. These are the
/// system-writable spaces macOS reserves for the OS itself; a shell
/// spawned inside them would be operating with surprising authority.
const FORBIDDEN_CWD_PREFIXES: &[&str] = &["/etc", "/System"];

/// Tokenise `raw` into argv-style strings, respecting single- and
/// double-quoted spans. Backslash escapes are honoured outside quotes
/// and inside double quotes; inside single quotes everything is literal.
/// This is a deliberately simple parser — we do *not* expand variables,
/// globs, command substitutions, or tildes, and we do not interpret
/// any of the metacharacters our rejection list catches.
fn tokenize(raw: &str) -> Result<Vec<String>, String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;

    for ch in raw.chars() {
        if escape {
            current.push(ch);
            escape = false;
            in_token = true;
            continue;
        }
        if ch == '\\' && !in_single {
            escape = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            in_token = true;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            in_token = true;
            continue;
        }
        if ch.is_whitespace() && !in_single && !in_double {
            if in_token {
                tokens.push(std::mem::take(&mut current));
                in_token = false;
            }
            continue;
        }
        current.push(ch);
        in_token = true;
    }

    if in_single || in_double {
        return Err("unterminated quoted string".into());
    }
    if escape {
        return Err("trailing backslash escape".into());
    }
    if in_token {
        tokens.push(current);
    }
    Ok(tokens)
}

/// Validate a tokenized command against the allowlist / forbidden-token
/// rules. Returns `Ok(())` when every check passes, `Err(reason)` as
/// soon as one fails. Pulled out of the async run path so the unit
/// tests can exercise it without spawning real processes.
pub(crate) fn validate_tokens(tokens: &[String]) -> Result<(), String> {
    let first = tokens
        .first()
        .ok_or_else(|| "empty command".to_string())?;
    if !ALLOWED_COMMANDS.iter().any(|a| a == first) {
        return Err(format!(
            "command `{first}` not on allowlist ({} binaries permitted)",
            ALLOWED_COMMANDS.len()
        ));
    }

    // Every token — including the command itself — must be free of
    // shell metacharacters / escape sentinels.
    for t in tokens {
        for bad in FORBIDDEN_TOKEN_SUBSTRINGS {
            if t.contains(bad) {
                return Err(format!(
                    "token `{t}` contains forbidden substring `{bad}`"
                ));
            }
        }
    }

    // Destructive-verb scan. Matches either inside a single argv slot
    // (e.g. `rm`, `sudo`, `mkfs`) OR across the argv joined by spaces
    // (e.g. `chmod 777` tokenises as `chmod` + `777`, but the dangerous
    // signature is `chmod 7…`). We skip the command token itself — `rm`
    // is already off the allowlist; this pass is about *arguments* that
    // smuggle a dangerous verb into a permitted binary (classic
    // `find . -exec rm {}` pattern).
    let joined: String = tokens
        .iter()
        .skip(1)
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    for bad in FORBIDDEN_ARG_SUBSTRINGS {
        if joined.contains(bad) {
            return Err(format!(
                "arguments contain forbidden pattern `{bad}`"
            ));
        }
    }

    Ok(())
}

/// Resolve the caller's `cwd` request to an absolute, existing, allowed
/// directory. `None` → `$HOME`. Errors cover missing directory, the
/// path not being a directory, and blocked prefixes. Pulled out of the
/// async path for testability.
pub(crate) fn resolve_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = match cwd {
        None | Some("") => dirs::home_dir()
            .ok_or_else(|| "cannot resolve user home directory".to_string())?,
        Some(p) => {
            let expanded = if let Some(rest) = p.strip_prefix("~/") {
                let home = dirs::home_dir()
                    .ok_or_else(|| "cannot resolve ~ — no home directory".to_string())?;
                home.join(rest)
            } else if p == "~" {
                dirs::home_dir()
                    .ok_or_else(|| "cannot resolve ~ — no home directory".to_string())?
            } else {
                PathBuf::from(p)
            };
            expanded
        }
    };

    // Reject obviously-dangerous prefixes *before* we touch the
    // filesystem. Keeps the validator behaviour deterministic under
    // test without needing the actual dir to exist.
    let as_str = path.to_string_lossy();
    for bad in FORBIDDEN_CWD_PREFIXES {
        if as_str.starts_with(bad) {
            return Err(format!("cwd `{as_str}` is under forbidden prefix `{bad}`"));
        }
    }

    if !path.exists() {
        return Err(format!("cwd `{}` does not exist", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("cwd `{}` is not a directory", path.display()));
    }

    Ok(path)
}

/// Clamp `requested` into `[1, MAX_TIMEOUT_SECS]`, falling back to
/// `DEFAULT_TIMEOUT_SECS` when the caller passes `None` or `0`.
fn resolve_timeout(requested: Option<u64>) -> Duration {
    let secs = match requested {
        None | Some(0) => DEFAULT_TIMEOUT_SECS,
        Some(n) => n.min(MAX_TIMEOUT_SECS),
    };
    Duration::from_secs(secs)
}

/// Resolve the binary path for `cmd` via `paths::which`, returning a
/// structured error when the binary is missing. Used in lieu of letting
/// `Command::new` rely on `$PATH` — we're about to scrub the env, so
/// we need an absolute path in hand *before* the spawn.
fn resolve_binary(cmd: &str) -> Result<PathBuf, String> {
    crate::paths::which(cmd).ok_or_else(|| {
        format!("binary `{cmd}` not found on PATH — install it or remove from the allowlist")
    })
}

/// Entry point for the `shell_sandboxed` Tauri command. Tokenise →
/// validate → spawn → wait with timeout → return structured result.
pub async fn shell_sandboxed(
    cmd: String,
    cwd: Option<String>,
    timeout_sec: Option<u64>,
) -> Result<ShellResult, String> {
    if cmd.trim().is_empty() {
        return Err("shell_sandboxed blocked: empty command".into());
    }

    let tokens = tokenize(&cmd).map_err(|e| format!("shell_sandboxed blocked: {e}"))?;
    validate_tokens(&tokens)
        .map_err(|e| format!("shell_sandboxed blocked: {e}"))?;
    let work_dir = resolve_cwd(cwd.as_deref())
        .map_err(|e| format!("shell_sandboxed blocked: {e}"))?;
    let budget = resolve_timeout(timeout_sec);

    // tokens is guaranteed non-empty by validate_tokens
    let (program, args) = tokens.split_first().expect("non-empty after validation");
    let program_path = resolve_binary(program)?;

    // Known-good PATH. We do NOT honour the caller's `PATH` — the point
    // of this tool is that the agent can't smuggle a spoofed binary in
    // by prepending a rogue dir.
    let fat = crate::paths::fat_path()
        .ok_or_else(|| "shell_sandboxed blocked: failed to build PATH".to_string())?;

    let mut command = Command::new(&program_path);
    command
        .args(args)
        .current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", fat)
        .env("LC_ALL", "C.UTF-8")
        .kill_on_drop(true);

    let fut = command.output();
    let output = match timeout(budget, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("shell_sandboxed spawn failed: {e}")),
        Err(_) => {
            return Err(format!(
                "shell_sandboxed timed out after {}s",
                budget.as_secs()
            ))
        }
    };

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

// ---------------------------------------------------------------------------
// Tests — cover tokenizer, allowlist, forbidden tokens, forbidden args,
// cwd resolution, timeout clamp, and an end-to-end run through a known
// allowed binary.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_splits_on_whitespace_and_respects_quotes() {
        let t = tokenize("ls -la 'my dir' \"other dir\"").unwrap();
        assert_eq!(
            t,
            vec!["ls".to_string(), "-la".to_string(), "my dir".to_string(), "other dir".to_string()]
        );
    }

    #[test]
    fn tokenize_rejects_unterminated_quote() {
        assert!(tokenize("echo 'unterminated").is_err());
    }

    #[test]
    fn allowlist_accepts_known_binaries() {
        // A plain `ls` invocation is the baseline.
        let tokens = tokenize("ls -la").unwrap();
        validate_tokens(&tokens).expect("ls should be allowed");

        // `git status` — multi-token command that must pass validation.
        let tokens = tokenize("git status").unwrap();
        validate_tokens(&tokens).expect("git should be allowed");
    }

    #[test]
    fn allowlist_rejects_unknown_binary() {
        let tokens = tokenize("python3 -c 'print(1)'").unwrap();
        let err = validate_tokens(&tokens).expect_err("python3 must not be allowed");
        assert!(err.contains("not on allowlist"), "got: {err}");
    }

    #[test]
    fn forbidden_tokens_reject_shell_metacharacters() {
        // Pipe, redirect, append-redirect, semicolon, backtick, command
        // substitution — each should trip validate_tokens via its bad
        // substring even though the tokenizer itself preserves them as
        // literal characters inside a single token.
        let cases = [
            "echo hi | cat",
            "ls > /tmp/out",
            "ls >> /tmp/out",
            "echo hi ; ls",
            "echo `whoami`",
            "echo $(whoami)",
            "cat <(echo hi)",
            "ls && pwd",
            "ls || pwd",
        ];
        for raw in cases {
            let tokens = tokenize(raw).unwrap();
            let err = validate_tokens(&tokens).expect_err(&format!("should reject: {raw}"));
            assert!(
                err.contains("forbidden"),
                "raw={raw} err={err}"
            );
        }
    }

    #[test]
    fn forbidden_tokens_reject_path_traversal_and_system_dirs() {
        let tokens = tokenize("cat ../../etc/passwd").unwrap();
        assert!(validate_tokens(&tokens).is_err());

        let tokens = tokenize("ls /etc").unwrap();
        assert!(validate_tokens(&tokens).is_err());

        let tokens = tokenize("ls /private/var").unwrap();
        assert!(validate_tokens(&tokens).is_err());
    }

    #[test]
    fn forbidden_args_reject_destructive_verbs() {
        // `find` is on the allowlist, but a flag that smuggles `rm`,
        // `sudo`, `chmod 7…`, `chown`, `mv /`, `dd`, or `mkfs` into an
        // argv slot should still be refused.
        let cases = [
            "find . -exec rm {}",                 // literal rm as arg
            "echo sudo",                          // literal sudo as arg
            "echo chmod 777",                     // chmod 7… substring
            "echo chown",                         // chown substring
            "echo mv /",                          // mv / substring
            "echo dd if=/dev/zero",               // leading "dd "
            "echo mkfs",                          // mkfs substring
        ];
        for raw in cases {
            let tokens = tokenize(raw).unwrap();
            let err = validate_tokens(&tokens).expect_err(&format!("should reject: {raw}"));
            assert!(err.contains("forbidden"), "raw={raw} err={err}");
        }
    }

    #[test]
    fn cwd_defaults_to_home_when_none() {
        let home = dirs::home_dir().expect("test host must have $HOME");
        let resolved = resolve_cwd(None).expect("home dir should resolve");
        assert_eq!(resolved, home);
    }

    #[test]
    fn cwd_expands_tilde_prefix() {
        let home = dirs::home_dir().expect("test host must have $HOME");
        let resolved = resolve_cwd(Some("~")).expect("bare tilde should resolve");
        assert_eq!(resolved, home);
    }

    #[test]
    fn cwd_rejects_forbidden_prefixes() {
        assert!(resolve_cwd(Some("/etc")).is_err());
        assert!(resolve_cwd(Some("/System/Library")).is_err());
    }

    #[test]
    fn cwd_rejects_missing_directory() {
        let err =
            resolve_cwd(Some("/tmp/does-not-exist-sunny-sandbox-42")).expect_err("should not exist");
        assert!(err.contains("does not exist"), "got: {err}");
    }

    #[test]
    fn cwd_rejects_non_directory() {
        // Create a temp file and point cwd at it.
        let tmp = std::env::temp_dir().join("sunny-shell-sandbox-test-file");
        std::fs::write(&tmp, b"x").expect("write temp file");
        let err = resolve_cwd(Some(tmp.to_str().unwrap()))
            .expect_err("file path should not be accepted as cwd");
        assert!(err.contains("not a directory"), "got: {err}");
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn timeout_clamps_to_max() {
        let d = resolve_timeout(Some(9_999));
        assert_eq!(d, Duration::from_secs(MAX_TIMEOUT_SECS));
    }

    #[test]
    fn timeout_defaults_when_none_or_zero() {
        assert_eq!(resolve_timeout(None), Duration::from_secs(DEFAULT_TIMEOUT_SECS));
        assert_eq!(resolve_timeout(Some(0)), Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    }

    #[test]
    fn empty_command_is_refused() {
        let err = futures_executor_block_on(shell_sandboxed("   ".into(), None, None));
        assert!(err.unwrap_err().contains("empty command"));
    }

    /// End-to-end — `echo hello` through the real pipeline. Skipped if
    /// the host is missing /bin/echo for some reason.
    #[tokio::test]
    async fn echo_roundtrips_through_real_spawn() {
        if crate::paths::which("echo").is_none() {
            eprintln!("skipping: echo not on PATH");
            return;
        }
        let out = shell_sandboxed("echo hello".into(), None, Some(5))
            .await
            .expect("echo should succeed");
        assert_eq!(out.code, 0, "stderr: {}", out.stderr);
        assert!(out.stdout.contains("hello"), "stdout: {:?}", out.stdout);
    }

    /// End-to-end refusal path — a disallowed command is blocked *before*
    /// we spawn anything. The error string names the offending binary.
    #[tokio::test]
    async fn disallowed_command_is_blocked_before_spawn() {
        let err = shell_sandboxed("python3 -c 'print(1)'".into(), None, Some(5))
            .await
            .expect_err("python3 must be blocked");
        assert!(err.contains("not on allowlist"), "got: {err}");
    }

    // ---- helpers -----------------------------------------------------

    /// Minimal sync-on-async for the one test that wants to assert on an
    /// error path without paying for a full tokio runtime annotation.
    /// Uses the current thread runtime under the hood.
    fn futures_executor_block_on<F: std::future::Future>(
        f: F,
    ) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(f)
    }

}
