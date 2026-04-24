//! `http_request` — generic authenticated HTTP caller. DANGEROUS.
//!
//! Main-agent-only: NOT added to any sub-agent role allowlist in
//! `agent_loop::scope` on first ship. Widening requires safety-aligner
//! sign-off and an explicit entry in `scope.rs`.
//!
//! Every call:
//!   1. Passes through the SSRF gate shared with `web_fetch`
//!      (`crate::tools_web::validate_public_http_url`).
//!   2. Runs inside `crate::http::with_initiator("tool:http_request", ..)`
//!      so NetRequest audit events and egress-monitor counters tag
//!      the request with the tool name.
//!   3. Is sent via `crate::http::send` — NEVER `.send().await` directly.
//!      That wrapper owns the canary scanner, the enforcement allowlist,
//!      the panic-mode short-circuit, and the post-response egress
//!      correlator.
//!
//! `auth_profile` resolves a named profile on disk under
//! `~/.sunny/secrets/<name>.json` via `crate::secrets::get_profile`.
//! If the user's `headers` already carries an `Authorization` value,
//! the profile-derived Authorization is dropped — that's the signal
//! the model is trying to do something custom this run.

use serde_json::{json, Value};

use crate::agent_loop::catalog::TrustClass;
use crate::agent_loop::tool_trait::{ToolCtx, ToolFuture, ToolSpec};
use crate::security;

const CAPS: &[&str] = &["web:fetch"];

const DEFAULT_MAX_RESPONSE_BYTES: usize = 64 * 1024;
const HARD_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const HARD_MAX_TIMEOUT_MS: u64 = 60_000;

const SCHEMA: &str = r#"{"type":"object","properties":{"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"],"description":"HTTP verb. Uppercase."},"url":{"type":"string","description":"Absolute http:// or https:// URL. Public internet only — private / loopback / link-local / metadata addresses are refused pre-flight AND after every redirect."},"headers":{"type":"object","description":"Optional request headers as { name: value }. Values must be strings.","additionalProperties":{"type":"string"}},"body":{"description":"Optional request body. If a string, sent verbatim. If an object/array, JSON-encoded and Content-Type defaulted to application/json (headers.Content-Type wins if present). Ignored for GET."},"auth_profile":{"type":"string","description":"Optional name of an auth profile stored at ~/.sunny/secrets/<name>.json. Adds Authorization / x-api-key header only if the user did not already set one in `headers`."},"max_response_bytes":{"type":"integer","minimum":1,"maximum":1048576,"description":"Cap on response body bytes returned to the LLM. Default 65536, hard max 1 MiB. Over-cap responses are truncated and `truncated: true`."},"timeout_ms":{"type":"integer","minimum":1,"maximum":60000,"description":"Per-request timeout in milliseconds. Default 15000, hard max 60000."}},"required":["method","url"]}"#;

const DESCRIPTION: &str = "Make an authenticated HTTP(S) request to a public API and return { status, headers, body, truncated }. Use for JSON / REST / GraphQL endpoints that don't have a dedicated tool. Method must be GET|POST|PUT|PATCH|DELETE (uppercase). `body` can be a string (sent verbatim) or an object (JSON-encoded; Content-Type auto-set unless you override it). `auth_profile` injects Authorization (or provider-specific header) from ~/.sunny/secrets/<name>.json but only if you did not already set Authorization yourself. The URL is SSRF-filtered — private / loopback / link-local / cloud-metadata addresses are refused. Responses larger than max_response_bytes (default 64 KiB, cap 1 MiB) are truncated and the response reports truncated=true. Do NOT use for web page scraping (use web_fetch — it parses HTML to text and scrubs prompt injection) and do NOT use for search (use web_search / deep_research). Use web_fetch for HTML, http_request for JSON APIs.";

fn invoke<'a>(_ctx: &'a ToolCtx<'a>, input: Value) -> ToolFuture<'a> {
    // The `agent:` prefix is required by `security::enforcement::is_agent_initiator`
    // — without it the egress allowlist, canary, and monitor heuristics
    // all short-circuit on `non_agent` and skip their checks. Do NOT
    // drop the `agent:` prefix.
    Box::pin(async move {
        crate::http::with_initiator("agent:tool:http_request", run(input)).await
    })
}

async fn run(input: Value) -> Result<String, String> {
    // ---- parse + validate --------------------------------------------------
    let method_str = input
        .get("method")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "http_request: missing string arg `method`".to_string())?
        .to_ascii_uppercase();
    let method = match method_str.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => {
            return Err(format!(
                "http_request: method `{other}` not allowed (expected GET|POST|PUT|PATCH|DELETE)"
            ))
        }
    };

    let url = input
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "http_request: missing string arg `url`".to_string())?;

    // SSRF gate — shared with web_fetch.
    crate::tools_web::validate_public_http_url(&url).await?;

    let max_response_bytes = input
        .get("max_response_bytes")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_RESPONSE_BYTES)
        .min(HARD_MAX_RESPONSE_BYTES)
        .max(1);

    let timeout_ms = input
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(HARD_MAX_TIMEOUT_MS)
        .max(1);

    // ---- build request -----------------------------------------------------
    let client = crate::http::client();
    let mut req = client
        .request(method.clone(), &url)
        .timeout(std::time::Duration::from_millis(timeout_ms));

    // User-supplied headers first — they win over auth_profile.
    let mut user_has_authorization = false;
    let mut user_set_content_type = false;
    if let Some(headers) = input.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in headers.iter() {
            let value = v.as_str().ok_or_else(|| {
                format!("http_request: header `{k}` must be a string (got {v:?})")
            })?;
            if k.eq_ignore_ascii_case("authorization") {
                user_has_authorization = true;
            }
            if k.eq_ignore_ascii_case("content-type") {
                user_set_content_type = true;
            }
            req = req.header(k, value);
        }
    }

    // Auth profile — strictly additive.
    if let Some(profile_name) = input
        .get("auth_profile")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        match crate::secrets::get_profile(profile_name).await {
            Ok(profile) => {
                req = apply_auth(req, &profile, user_has_authorization);
            }
            Err(e) => {
                return Err(format!(
                    "http_request: auth_profile `{profile_name}` unavailable: {e}"
                ));
            }
        }
    }

    // Body handling. GET with body is technically legal per RFC but
    // most proxies mishandle it — drop quietly rather than 400 upstream.
    if let Some(body_val) = input.get("body") {
        if method != reqwest::Method::GET {
            if let Some(s) = body_val.as_str() {
                req = req.body(s.to_string());
            } else if !body_val.is_null() {
                let encoded = serde_json::to_vec(body_val)
                    .map_err(|e| format!("http_request: encode body as JSON: {e}"))?;
                req = req.body(encoded);
                if !user_set_content_type {
                    req = req.header("content-type", "application/json");
                }
            }
        }
    }

    // ---- send through the audited wrapper ---------------------------------
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("http_request: {e}"))?;

    let status = resp.status().as_u16();
    let mut header_map = serde_json::Map::new();
    for (k, v) in resp.headers().iter() {
        if let Ok(s) = v.to_str() {
            header_map.insert(k.as_str().to_string(), Value::String(s.to_string()));
        }
    }

    let full = resp
        .bytes()
        .await
        .map_err(|e| format!("http_request: read body: {e}"))?;
    let truncated = full.len() > max_response_bytes;
    let slice: &[u8] = if truncated {
        &full[..max_response_bytes]
    } else {
        &full[..]
    };
    let raw_body = String::from_utf8_lossy(slice).to_string();

    // Ingress scan — the URL was model-chosen, so the response body is
    // attacker-controllable. Mirror `web_fetch`'s post-fetch pipeline:
    // audit suspicious patterns, then scrub invisible-Unicode / prompt-
    // injection markers before the body re-enters LLM context.
    let host = security::url_host(&url);
    security::ingress::inspect(&format!("http_request:{host}"), &raw_body);
    let body_string = security::ingress::scrub_for_context(&raw_body);

    let out = json!({
        "status": status,
        "headers": Value::Object(header_map),
        "body": body_string,
        "truncated": truncated,
    });

    serde_json::to_string(&out).map_err(|e| format!("http_request: serialise response: {e}"))
}

/// Apply an auth profile to the request builder. Never overwrites a
/// user-supplied Authorization header — if `user_has_authorization` is
/// true, profile-derived Authorization is dropped; other header-based
/// profiles (api_key, custom) still apply because those don't collide
/// unless the profile explicitly names the `authorization` header.
fn apply_auth(
    mut req: reqwest::RequestBuilder,
    profile: &crate::secrets::AuthProfile,
    user_has_authorization: bool,
) -> reqwest::RequestBuilder {
    use crate::secrets::AuthProfile::*;
    match profile {
        Bearer { token } => {
            if !user_has_authorization {
                req = req.header("authorization", format!("Bearer {token}"));
            }
        }
        Basic { username, password } => {
            if !user_has_authorization {
                req = req.basic_auth(username, Some(password));
            }
        }
        ApiKey { header, value } => {
            if header.eq_ignore_ascii_case("authorization") && user_has_authorization {
                // user's Authorization wins
            } else {
                req = req.header(header, value);
            }
        }
        Custom { headers } => {
            for (k, v) in headers.iter() {
                if k.eq_ignore_ascii_case("authorization") && user_has_authorization {
                    continue;
                }
                req = req.header(k, v);
            }
        }
    }
    req
}

// Main-agent-only: NOT referenced in any role allowlist in
// `agent_loop::scope`. Widening requires safety-aligner sign-off.
inventory::submit! {
    ToolSpec {
        name: "http_request",
        description: DESCRIPTION,
        input_schema: SCHEMA,
        required_capabilities: CAPS,
        trust_class: TrustClass::ExternalWrite,
        dangerous: true,
        invoke,
    }
}
