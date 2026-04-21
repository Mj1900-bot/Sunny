//! `shell_sandboxed` — run a single allowlisted shell binary.

use serde_json::Value;

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::helpers::{optional_string_arg, string_arg};
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};

const CAPS: &[&str] = &["shell.sandbox"];

const SCHEMA: &str = r#"{"type":"object","properties":{"cmd":{"type":"string","description":"Shell-tokenised command line. First token must be on the allowlist."},"cwd":{"type":"string","description":"Working directory. Defaults to $HOME. ~/ expansion is honoured."},"timeout_sec":{"type":"integer","description":"Wall-clock budget in seconds. Default 15, max 60."}},"required":["cmd"]}"#;

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let cmd = string_arg(&input, "cmd")?;
        let cwd = optional_string_arg(&input, "cwd");
        let timeout_sec = input.get("timeout_sec").and_then(|v| v.as_u64());
        let result = crate::tools_shell::shell_sandboxed(cmd, cwd, timeout_sec).await?;
        serde_json::to_string(&result).map_err(|e| format!("shell_sandboxed encode: {e}"))
    })
}

inventory::submit! {
    ToolSpec {
        name: "shell_sandboxed",
        description: "Run a single allowlisted shell binary (ls, cat, head, tail, grep, find, git, jq, awk, sed, curl, etc.) with no shell interpretation, scrubbed env, and a 15 s (max 60 s) timeout. Use freely for read-only inspection of Sunny's machine — checking git status, counting lines, grepping config, fetching a URL, computing a hash. NOT a general shell: pipes, redirects, `;`, `&&`, backticks, `$(…)`, `..`, `/etc`, `/private`, and destructive verbs (rm, sudo, chmod 7…, chown, mv /, dd, mkfs) are rejected before spawn. If you need shell composition, run each stage as a separate tool call or fall back to run_shell (which is ConfirmGated). `cwd` defaults to $HOME; it must exist and must not be under /etc or /System.",
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalRead,
        dangerous: false,
        invoke,
    }
}
