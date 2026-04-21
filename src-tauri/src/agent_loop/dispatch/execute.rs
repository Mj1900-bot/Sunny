//! Tool execution — JSON-schema argument validation, the actual trait-registry
//! dispatch, and the retry loop that wraps every invocation.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use jsonschema::JSONSchema;
use once_cell::sync::Lazy;
use serde_json::Value;
use tauri::AppHandle;

use super::super::catalog::catalog_merged;
use super::super::types::ToolCall;
use super::classify::{classify_tool_error, ToolErrorClass};

// ---------------------------------------------------------------------------
// Retry policy constants (re-exported so mod.rs can read them)
// ---------------------------------------------------------------------------

/// Maximum dispatch attempts for a transient-eligible tool.
pub(super) const MAX_ATTEMPTS: u32 = 3;
/// Exponential backoff schedule between retry attempts (milliseconds).
pub(super) const RETRY_BACKOFFS_MS: &[u64] = &[200, 600];

// ---------------------------------------------------------------------------
// JSON-schema validation
//
// Every entry in `catalog_merged()` ships an `input_schema` JSON Schema
// fragment. We compile each schema once, cache it in a module-level
// `RwLock<HashMap>`, and validate `call.input` against it BEFORE the
// dispatch match runs. Failures surface as an `arg_validation:`
// prefixed error string that `classify_error` tags `retriable=true`,
// so the LLM can fix its call and try again instead of the Rust
// handler panicking on a downstream `string_arg` unwrap.
// ---------------------------------------------------------------------------

/// Compiled-schema cache, keyed by tool name. `JSONSchema` is
/// `Send + Sync` so a `RwLock` around the map is enough — readers
/// proceed in parallel, the single-writer-on-miss path is a compile
/// + insert.
static SCHEMA_CACHE: Lazy<RwLock<HashMap<&'static str, JSONSchema>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// `true` for schemas like `{"type":"object","properties":{}}` that
/// accept anything — rejecting against these is meaningless noise, so
/// per the R15-B brief we skip validation for empty schemas.
fn is_empty_schema(raw: &Value) -> bool {
    let Some(obj) = raw.as_object() else { return false };
    let ty = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let empty_props = obj
        .get("properties")
        .and_then(|v| v.as_object())
        .map(|m| m.is_empty())
        .unwrap_or(true);
    let no_required = obj
        .get("required")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    ty == "object" && empty_props && no_required
}

/// Validate `input` against the schema for `tool_name`. Returns an
/// error string prefixed with `arg_validation:` so `classify_error`
/// can route it to `retriable=true` (the LLM gets a second chance).
///
/// Validation is skipped for unknown tools (the dispatch match will
/// itself return `unknown tool:` which classifies as `fatal`) and
/// for schemas that are effectively empty.
pub fn validate_args(tool_name: &str, input: &Value) -> Result<(), String> {
    let merged = catalog_merged();
    let spec = match merged.iter().find(|t| t.name == tool_name) {
        Some(s) => *s,
        None => return Ok(()),
    };
    let raw: Value = match serde_json::from_str(spec.input_schema) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    if is_empty_schema(&raw) {
        return Ok(());
    }

    // Fast path: read-locked cache hit.
    {
        let guard = SCHEMA_CACHE
            .read()
            .map_err(|e| format!("arg_validation: cache poisoned: {e}"))?;
        if let Some(sch) = guard.get(tool_name) {
            return run_validation(tool_name, sch, input);
        }
    }

    // Slow path: compile + insert.
    let compiled = JSONSchema::compile(&raw)
        .map_err(|e| format!("arg_validation: schema compile failed for `{tool_name}`: {e}"))?;
    let result = run_validation(tool_name, &compiled, input);
    if let Ok(mut guard) = SCHEMA_CACHE.write() {
        guard.entry(spec.name).or_insert(compiled);
    }
    result
}

/// Run the actual `validate` call and format the first few errors
/// into a structured message naming the offending keys + the schema's
/// expectation. Capped at 3 so a broken call doesn't balloon the
/// tool-error envelope.
fn run_validation(tool_name: &str, sch: &JSONSchema, input: &Value) -> Result<(), String> {
    if sch.is_valid(input) {
        return Ok(());
    }
    let errs: Vec<String> = match sch.validate(input) {
        Ok(_) => return Ok(()),
        Err(it) => it
            .take(3)
            .map(|e| {
                let path = e.instance_path.to_string();
                let path = if path.is_empty() {
                    "<root>".to_string()
                } else {
                    path
                };
                format!("{path}: {e}")
            })
            .collect(),
    };
    Err(format!(
        "arg_validation: tool `{tool_name}` args do not match schema — {}",
        errs.join("; ")
    ))
}

// ---------------------------------------------------------------------------
// Trait-registry dispatch
// ---------------------------------------------------------------------------

/// Inner dispatch — separate function so we can wrap the whole thing in
/// `tokio::time::timeout` cleanly.
pub(super) async fn run_tool(
    app: AppHandle,
    call: ToolCall,
    parent_session_id: Option<String>,
    depth: u32,
    requesting_agent: Option<String>,
) -> Result<String, String> {
    let name = call.name.as_str();
    let input = &call.input;

    // Pre-dispatch JSON Schema check.
    validate_args(name, input)?;

    // Trait-registry dispatch — every tool lives in
    // `agent_loop::tools::*` and registers via `inventory::submit!`.
    if let Some(spec) = crate::agent_loop::tool_trait::find(name) {
        let initiator_owned = match requesting_agent.as_deref() {
            Some(sub) => format!("agent:{sub}"),
            None => "agent:main".to_string(),
        };

        use crate::agent_loop::tool_trait::{check_capabilities, CapabilityVerdict};
        if let CapabilityVerdict::Denied(reason) =
            check_capabilities(&initiator_owned, spec.name, spec.required_capabilities)
        {
            return Err(format!("capability_denied: {reason}"));
        }

        let ctx = crate::agent_loop::tool_trait::ToolCtx {
            app: &app,
            session_id: parent_session_id.as_deref(),
            initiator: &initiator_owned,
            depth,
        };
        return (spec.invoke)(&ctx, input.clone()).await;
    }

    Err(format!("unknown tool: {name}"))
}

// ---------------------------------------------------------------------------
// Retry loop
// ---------------------------------------------------------------------------

/// Retry driver used by `dispatch_tool`. Runs `op(attempt)` up to
/// `MAX_ATTEMPTS` times, retrying only when the inner error is
/// classified `Transient` and `retry_eligible` is true (dangerous
/// tools get one shot — the user approved that exact action once and
/// re-running could duplicate a side effect).
///
/// The outer `Result<_, tokio::time::error::Elapsed>` mirrors the
/// `dispatch_tool` call site: an `Err(_)` means the per-tool timeout
/// tripped, which is itself a transient failure mode.
///
/// Returns `(final_result, attempts_made)` so the caller can tag an
/// "N attempts exhausted" suffix on the final error surfaced to the LLM.
pub async fn run_with_retry<F, Fut>(
    retry_eligible: bool,
    mut op: F,
    tool_name: &str,
) -> (
    Result<Result<String, String>, tokio::time::error::Elapsed>,
    u32,
)
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<
        Output = Result<Result<String, String>, tokio::time::error::Elapsed>,
    >,
{
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let this_result = op(attempt).await;

        let (should_retry, class_label) = match &this_result {
            Ok(Ok(_)) => (false, "ok"),
            Ok(Err(e)) => match classify_tool_error(e) {
                ToolErrorClass::Transient => (retry_eligible, "transient"),
                ToolErrorClass::Permanent => (false, "permanent"),
                ToolErrorClass::Unknown => (false, "unknown"),
            },
            // tokio timeout — treat as transient.
            Err(_) => (retry_eligible, "transient"),
        };

        if should_retry && attempt < MAX_ATTEMPTS {
            let backoff_ms = RETRY_BACKOFFS_MS
                .get((attempt - 1) as usize)
                .copied()
                .unwrap_or(600);
            log::info!(
                "[dispatch] tool `{tool_name}` attempt {attempt}/{MAX_ATTEMPTS} \
                 failed (class={class_label}), retrying in {backoff_ms} ms"
            );
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            continue;
        }

        if attempt > 1 {
            log::info!(
                "[dispatch] tool `{tool_name}` final attempt \
                 {attempt}/{MAX_ATTEMPTS} (class={class_label})"
            );
        }
        return (this_result, attempt);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[test]
    fn dispatch_validate_args_accepts_good_input() {
        let input = json!({"city": "Vancouver", "days": 3});
        assert!(validate_args("weather_forecast", &input).is_ok());
    }

    #[test]
    fn dispatch_validate_args_rejects_missing_required() {
        let input = json!({"days": 3});
        let err = validate_args("weather_forecast", &input).unwrap_err();
        assert!(err.starts_with("arg_validation:"), "got: {err}");
        assert!(
            err.contains("city"),
            "expected to mention the missing `city` key, got: {err}"
        );
    }

    #[test]
    fn dispatch_validate_args_rejects_wrong_type() {
        let input = json!({"city": "Vancouver", "days": "three"});
        let err = validate_args("weather_forecast", &input).unwrap_err();
        assert!(err.starts_with("arg_validation:"), "got: {err}");
        assert!(
            err.to_ascii_lowercase().contains("integer"),
            "expected type-mismatch mention, got: {err}"
        );
    }

    #[test]
    fn dispatch_validate_args_rejects_enum_violation() {
        let input = json!({"role": "not-a-role", "task": "x"});
        let err = validate_args("spawn_subagent", &input).unwrap_err();
        assert!(err.starts_with("arg_validation:"), "got: {err}");
    }

    #[test]
    fn dispatch_validate_args_skips_empty_schema() {
        assert!(validate_args("calendar_today", &json!({})).is_ok());
        assert!(validate_args("system_metrics", &json!({"unrelated": 1})).is_ok());
    }

    #[test]
    fn dispatch_validate_args_skips_unknown_tool() {
        assert!(validate_args("no_such_tool", &json!({})).is_ok());
    }

    #[test]
    fn dispatch_validate_args_is_cached() {
        let input = json!({"city": "Vancouver"});
        assert!(validate_args("weather_current", &input).is_ok());
        assert!(validate_args("weather_current", &input).is_ok());
    }

    // Retry loop tests

    fn fake_op(
        counter: Arc<AtomicU32>,
        err_msg: &'static str,
    ) -> impl FnMut(
        u32,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        Result<String, String>,
                        tokio::time::error::Elapsed,
                    >,
                > + Send,
        >,
    > {
        move |_attempt: u32| {
            let c = counter.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(Err(err_msg.to_string()))
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_transient_retries_twice() {
        let counter = Arc::new(AtomicU32::new(0));
        let op = fake_op(counter.clone(), "HTTP 503 service unavailable");
        let (result, attempts) = run_with_retry(true, op, "fake_tool").await;
        assert_eq!(counter.load(Ordering::SeqCst), 3, "3 total attempts");
        assert_eq!(attempts, 3);
        assert!(matches!(result, Ok(Err(_))));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_permanent_no_retry() {
        let counter = Arc::new(AtomicU32::new(0));
        let op = fake_op(counter.clone(), "file not found: /tmp/x");
        let (result, attempts) = run_with_retry(true, op, "fake_tool").await;
        assert_eq!(counter.load(Ordering::SeqCst), 1, "permanent → 1 attempt");
        assert_eq!(attempts, 1);
        assert!(matches!(result, Ok(Err(_))));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_dangerous_no_retry_on_transient() {
        let counter = Arc::new(AtomicU32::new(0));
        let op = fake_op(counter.clone(), "connection refused");
        let (result, attempts) = run_with_retry(false, op, "fake_dangerous").await;
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "dangerous tool on transient error → 1 attempt"
        );
        assert_eq!(attempts, 1);
        assert!(matches!(result, Ok(Err(_))));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_unknown_no_retry() {
        let counter = Arc::new(AtomicU32::new(0));
        let op = fake_op(counter.clone(), "something weird at layer 7");
        let (_result, attempts) = run_with_retry(true, op, "fake_tool").await;
        assert_eq!(attempts, 1, "unknown classification → no retry");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_success_first_try() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let op = move |_attempt: u32| {
            let c = c.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(Ok::<String, String>("ok".to_string()))
            })
                as std::pin::Pin<
                    Box<
                        dyn std::future::Future<
                                Output = Result<
                                    Result<String, String>,
                                    tokio::time::error::Elapsed,
                                >,
                            > + Send,
                    >,
                >
        };
        let (result, attempts) = run_with_retry(true, op, "fake_tool").await;
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(attempts, 1);
        assert!(matches!(result, Ok(Ok(_))));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_recovers_on_second_attempt() {
        let counter = Arc::new(AtomicU32::new(0));
        let c = counter.clone();
        let op = move |_attempt: u32| {
            let c = c.clone();
            Box::pin(async move {
                let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                if n == 1 {
                    Ok(Err::<String, String>("HTTP 503 bad gateway".to_string()))
                } else {
                    Ok(Ok::<String, String>("recovered".to_string()))
                }
            })
                as std::pin::Pin<
                    Box<
                        dyn std::future::Future<
                                Output = Result<
                                    Result<String, String>,
                                    tokio::time::error::Elapsed,
                                >,
                            > + Send,
                    >,
                >
        };
        let (result, attempts) = run_with_retry(true, op, "fake_tool").await;
        assert_eq!(attempts, 2);
        match result {
            Ok(Ok(s)) => assert_eq!(s, "recovered"),
            other => panic!("expected success, got {other:?}"),
        }
    }
}
