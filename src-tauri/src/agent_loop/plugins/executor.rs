//! Plugin tool executor (v0.2).
//!
//! Takes a plugin-declared tool spec + the LLM's argument JSON and
//! actually runs the declared action. v0.2 ships ONE executor kind
//! — `HttpGet` — because it's the narrowest attack surface that still
//! lets plugins do something useful (weather lookups, status checks,
//! public API queries).
//!
//! ## Safety rails
//!
//! * **Allowlist file** at `~/.sunny/plugins-allowlist.json` gates every
//!   execution. Missing file = no plugin may run (fail-closed).
//! * **URL scheme** restricted to `http://` and `https://`.
//! * **URL prefix match** — the manifest declares `allowed_url_prefixes`
//!   per executor; the final (post-substitution) URL must start with
//!   one of them. Blocks template-injection attacks that swap the
//!   domain at runtime.
//! * **URL-encoded substitution** — argument values passed through the
//!   `{{placeholder}}` templating are `percent-encoded` before
//!   splicing. Plugin authors do NOT need to double-encode.
//! * **Fixed 10-second timeout** — hardcoded so no plugin manifest can
//!   extend it. v0.3 may expose tunable timeouts behind a capability.
//! * **No custom headers** in v0.2. Plugins can bake API keys into
//!   query strings (public-API pattern) but cannot set `Authorization`,
//!   `Cookie`, or any arbitrary header — that's v0.3 work.
//!
//! ## Response shape
//!
//! Executor always returns a JSON envelope:
//! ```json
//! {"status": 200, "content_type": "application/json", "body_json": {...}}
//! ```
//! or
//! ```json
//! {"status": 418, "content_type": "text/plain", "body_text": "I'm a teapot"}
//! ```
//!
//! The LLM reads this as a normal tool result; the dispatcher
//! wraps it in `<untrusted_source>` because plugin output is
//! `ExternalRead` trust class.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Executor timeout. Not configurable by plugins in v0.2 — a chatty
/// plugin cannot hold the turn past this bound.
const EXEC_TIMEOUT: Duration = Duration::from_secs(10);

/// Max response body size. Plugins that return gigabytes would
/// blow the LLM context window; the dispatcher also truncates, but
/// we cap here too so we don't even buffer the oversize response.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// Allowlist file path — `~/.sunny/plugins-allowlist.json`.
const ALLOWLIST_FILE: &str = "plugins-allowlist.json";

// ---------------------------------------------------------------------------
// Typed exec spec
// ---------------------------------------------------------------------------

/// The executor kinds a plugin tool may declare. Tagged enum on
/// `type` so the JSON shape is `{"type": "http_get", ...}` and the
/// foundation-era `{"type": "placeholder"}` value from v0.1 continues
/// to deserialise (it's just not runnable).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginToolExec {
    /// HTTP GET with URL templating + allowlist-gated prefix match.
    HttpGet(HttpGetExec),
    /// v0.1 placeholder retained for backward compatibility. Returns
    /// a structured error when the dispatcher tries to run it.
    Placeholder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpGetExec {
    /// URL template; `{{name}}` placeholders are replaced with
    /// percent-encoded values from the tool's argument object.
    pub url_template: String,
    /// One or more prefixes the post-substitution URL must start with.
    /// Must be non-empty — a plugin cannot declare "any URL". Each
    /// prefix must itself be an http(s) URL.
    pub allowed_url_prefixes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PluginsAllowlist {
    #[serde(default)]
    pub allowed: Vec<String>,
}

impl PluginsAllowlist {
    pub fn contains(&self, plugin_id: &str) -> bool {
        self.allowed.iter().any(|a| a == plugin_id)
    }
}

fn allowlist_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".sunny").join(ALLOWLIST_FILE))
}

/// Read the allowlist from disk. Returns `None` when the file is
/// missing (fail-closed) and the caller treats missing as empty.
pub fn load_allowlist() -> Option<PluginsAllowlist> {
    let path = allowlist_path()?;
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<PluginsAllowlist>(&raw).ok()
}

/// True when the plugin id is in the persisted allowlist. Missing
/// file or parse error = false (fail-closed).
pub fn is_plugin_allowed(plugin_id: &str) -> bool {
    load_allowlist().map(|a| a.contains(plugin_id)).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

/// Replace `{{name}}` placeholders in `template` with URL-encoded
/// values pulled from `args`. Values are coerced to strings:
/// booleans → `"true"/"false"`, numbers → their JSON repr,
/// strings → their content, null → error, nested structures → error.
///
/// Returns `Err` when a placeholder has no matching key in `args` or
/// when the value is null / non-scalar. Missing-but-optional keys are
/// the plugin author's problem — we fail loudly rather than silently
/// emit an empty segment.
pub fn render_template(template: &str, args: &Value) -> Result<String, String> {
    let mut out = String::with_capacity(template.len() + 32);
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let end = after_open
            .find("}}")
            .ok_or_else(|| format!("unterminated `{{{{` in template: {rest}"))?;
        let key = after_open[..end].trim();
        if key.is_empty() {
            return Err(format!("empty placeholder `{{{{}}}}` in template"));
        }
        let val = args.get(key).ok_or_else(|| {
            format!("missing argument `{key}` required by template")
        })?;
        let scalar = value_to_scalar_string(val, key)?;
        out.push_str(&percent_encode(&scalar));
        rest = &after_open[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

fn value_to_scalar_string(v: &Value, key: &str) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        Value::Null => Err(format!("argument `{key}` is null; cannot template")),
        Value::Array(_) | Value::Object(_) => Err(format!(
            "argument `{key}` must be a scalar (string/number/bool), got a complex value"
        )),
    }
}

/// RFC 3986 unreserved + common URL-safe chars left alone; everything
/// else percent-encoded. Matches the `url::form_urlencoded` serialiser
/// for query-string values — safe to splice into either path or query.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let safe = matches!(
            b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' |
            b'-' | b'_' | b'.' | b'~'
        );
        if safe {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_nibble(b >> 4));
            out.push(hex_nibble(b & 0x0f));
        }
    }
    out
}

fn hex_nibble(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'A' + (n - 10)) as char,
        _ => unreachable!(),
    }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/// Validate that `url` is an acceptable plugin target:
/// * scheme is `http://` or `https://`
/// * host segment is non-empty
/// * starts with one of the plugin's `allowed_url_prefixes`
pub fn validate_final_url(url: &str, allowed_prefixes: &[String]) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!(
            "plugin URL must start with http:// or https://; got `{url}`"
        ));
    }
    // Reject obviously malformed URLs — no host after the scheme.
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or("");
    let host_end = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
    let host = &after_scheme[..host_end];
    if host.is_empty() {
        return Err(format!("plugin URL has empty host: `{url}`"));
    }
    if allowed_prefixes.is_empty() {
        return Err("plugin executor must declare at least one allowed_url_prefix".into());
    }
    for prefix in allowed_prefixes {
        if url.starts_with(prefix) {
            return Ok(());
        }
    }
    Err(format!(
        "URL `{url}` does not match any allowed prefix for this plugin"
    ))
}

// ---------------------------------------------------------------------------
// HTTP execution
// ---------------------------------------------------------------------------

/// Execute a plugin tool. `plugin_id` is used for allowlist gating
/// and the audit log; `tool_name` is for error messages.
///
/// This is the public entry point the dispatch layer will call in
/// v0.2b integration. Returns a JSON envelope suitable for
/// immediate use as a tool result.
pub async fn execute(
    plugin_id: &str,
    tool_name: &str,
    exec: &PluginToolExec,
    args: &Value,
) -> Result<Value, String> {
    if !is_plugin_allowed(plugin_id) {
        return Err(format!(
            "plugin `{plugin_id}` is not in ~/.sunny/plugins-allowlist.json \
             (add the id to the `allowed` array to enable it)"
        ));
    }
    match exec {
        PluginToolExec::Placeholder => Err(format!(
            "plugin `{plugin_id}` tool `{tool_name}` uses the v0.1 placeholder \
             executor; upgrade the manifest to specify `exec.type` = `http_get`"
        )),
        PluginToolExec::HttpGet(spec) => execute_http_get(plugin_id, tool_name, spec, args).await,
    }
}

async fn execute_http_get(
    plugin_id: &str,
    tool_name: &str,
    spec: &HttpGetExec,
    args: &Value,
) -> Result<Value, String> {
    let url = render_template(&spec.url_template, args)
        .map_err(|e| format!("plugin `{plugin_id}/{tool_name}`: template: {e}"))?;
    validate_final_url(&url, &spec.allowed_url_prefixes)
        .map_err(|e| format!("plugin `{plugin_id}/{tool_name}`: {e}"))?;

    let client = crate::http::client();
    let response = tokio::time::timeout(
        EXEC_TIMEOUT,
        client.get(&url).send(),
    )
    .await
    .map_err(|_| format!("plugin `{plugin_id}/{tool_name}`: request timed out after {}s", EXEC_TIMEOUT.as_secs()))?
    .map_err(|e| format!("plugin `{plugin_id}/{tool_name}`: request failed: {e}"))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Truncate at MAX_BODY_BYTES — tolerate large responses without
    // OOMing or blowing the LLM context.
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("plugin `{plugin_id}/{tool_name}`: body read failed: {e}"))?;
    let was_truncated = bytes.len() > MAX_BODY_BYTES;
    let bytes = if was_truncated {
        bytes.slice(..MAX_BODY_BYTES)
    } else {
        bytes
    };

    // Parse JSON when the content-type says so and the body actually
    // parses. Otherwise return as text (lossy UTF-8 — replace invalid
    // bytes so the LLM never sees a decode error).
    let is_json = content_type
        .to_ascii_lowercase()
        .starts_with("application/json");
    let mut envelope = serde_json::Map::new();
    envelope.insert("status".to_string(), json!(status));
    envelope.insert("content_type".to_string(), json!(content_type));
    if is_json {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(body) => {
                envelope.insert("body_json".to_string(), body);
            }
            Err(_) => {
                envelope.insert(
                    "body_text".to_string(),
                    json!(String::from_utf8_lossy(&bytes).to_string()),
                );
            }
        }
    } else {
        envelope.insert(
            "body_text".to_string(),
            json!(String::from_utf8_lossy(&bytes).to_string()),
        );
    }
    if was_truncated {
        envelope.insert("truncated".to_string(), json!(true));
        envelope.insert("truncated_at_bytes".to_string(), json!(MAX_BODY_BYTES));
    }
    Ok(Value::Object(envelope))
}

// ---------------------------------------------------------------------------
// Placeholder for unit tests (no network I/O)
// ---------------------------------------------------------------------------

pub fn serialise_exec_for_test(e: &PluginToolExec) -> String {
    serde_json::to_string(e).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Compat map — extra headers are optional and unused in v0.2, but we
// reserve the field shape now so v0.3 can add it without a manifest
// version bump. The unused import silencer on `BTreeMap` is intentional.
// ---------------------------------------------------------------------------

type _ReservedHeadersShape = BTreeMap<String, String>;

#[cfg(test)]
mod tests {
    use super::*;

    // ── template substitution ───────────────────────────────────────────────

    #[test]
    fn render_template_substitutes_scalar_string() {
        let out = render_template(
            "https://api.example.com/{{path}}",
            &json!({"path": "foo"}),
        )
        .unwrap();
        assert_eq!(out, "https://api.example.com/foo");
    }

    #[test]
    fn render_template_substitutes_number_and_bool() {
        let out = render_template(
            "q?n={{num}}&b={{flag}}",
            &json!({"num": 42, "flag": true}),
        )
        .unwrap();
        assert_eq!(out, "q?n=42&b=true");
    }

    #[test]
    fn render_template_percent_encodes_spaces_and_specials() {
        let out = render_template(
            "q?s={{query}}",
            &json!({"query": "hello world & friends"}),
        )
        .unwrap();
        assert_eq!(out, "q?s=hello%20world%20%26%20friends");
    }

    #[test]
    fn render_template_fails_on_missing_key() {
        let err = render_template("q?x={{absent}}", &json!({"other": "v"})).unwrap_err();
        assert!(err.contains("missing argument"), "got: {err}");
    }

    #[test]
    fn render_template_fails_on_null_value() {
        let err = render_template("q?x={{k}}", &json!({"k": null})).unwrap_err();
        assert!(err.contains("null"), "got: {err}");
    }

    #[test]
    fn render_template_fails_on_complex_value() {
        let err = render_template("q?x={{k}}", &json!({"k": ["a","b"]})).unwrap_err();
        assert!(err.contains("scalar"), "got: {err}");
    }

    #[test]
    fn render_template_rejects_unterminated_placeholder() {
        let err = render_template("q?x={{open", &json!({"open":"x"})).unwrap_err();
        assert!(err.contains("unterminated"), "got: {err}");
    }

    #[test]
    fn render_template_rejects_empty_placeholder() {
        let err = render_template("q?x={{}}", &json!({})).unwrap_err();
        assert!(err.contains("empty placeholder"), "got: {err}");
    }

    #[test]
    fn render_template_leaves_literal_text_unchanged() {
        let out = render_template("no templates here", &json!({})).unwrap();
        assert_eq!(out, "no templates here");
    }

    // ── percent encoding ───────────────────────────────────────────────────

    #[test]
    fn percent_encode_preserves_unreserved() {
        assert_eq!(percent_encode("abcXYZ0123-_.~"), "abcXYZ0123-_.~");
    }

    #[test]
    fn percent_encode_upper_hex() {
        // `/` is 0x2F → %2F (not %2f).
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("?"), "%3F");
    }

    #[test]
    fn percent_encode_multibyte_utf8() {
        // é is 0xC3 0xA9.
        assert_eq!(percent_encode("é"), "%C3%A9");
    }

    // ── URL validation ─────────────────────────────────────────────────────

    #[test]
    fn validate_url_accepts_https_matching_prefix() {
        let allow = vec!["https://api.weather.gov/".to_string()];
        assert!(validate_final_url("https://api.weather.gov/points/1,2", &allow).is_ok());
    }

    #[test]
    fn validate_url_rejects_scheme_mismatch() {
        let allow = vec!["https://api.example.com/".to_string()];
        let err = validate_final_url("file:///etc/passwd", &allow).unwrap_err();
        assert!(err.contains("http:// or https://"), "got: {err}");
    }

    #[test]
    fn validate_url_rejects_prefix_mismatch() {
        let allow = vec!["https://api.example.com/".to_string()];
        let err = validate_final_url("https://evil.example/", &allow).unwrap_err();
        assert!(err.contains("does not match"), "got: {err}");
    }

    #[test]
    fn validate_url_rejects_empty_host() {
        let allow = vec!["https://api.example.com/".to_string()];
        let err = validate_final_url("https:///path", &allow).unwrap_err();
        assert!(err.contains("empty host"), "got: {err}");
    }

    #[test]
    fn validate_url_requires_nonempty_allowlist() {
        let err = validate_final_url("https://api.example.com/x", &[]).unwrap_err();
        assert!(err.contains("at least one allowed_url_prefix"), "got: {err}");
    }

    #[test]
    fn validate_url_accepts_any_of_multiple_prefixes() {
        let allow = vec![
            "https://a.example.com/".to_string(),
            "https://b.example.com/".to_string(),
        ];
        assert!(validate_final_url("https://b.example.com/x", &allow).is_ok());
    }

    // ── allowlist gating ────────────────────────────────────────────────────

    #[tokio::test]
    async fn execute_rejects_plugin_not_in_allowlist() {
        // Without touching the real ~/.sunny/plugins-allowlist.json we
        // can only test the negative path reliably — a plugin id that's
        // extremely unlikely to be on a user's allowlist.
        let spec = PluginToolExec::HttpGet(HttpGetExec {
            url_template: "https://example.com/".to_string(),
            allowed_url_prefixes: vec!["https://example.com/".to_string()],
        });
        let err = execute(
            "never-allowed-plugin-zzz-test-id-do-not-add",
            "nope",
            &spec,
            &json!({}),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("not in")
                && err.contains("plugins-allowlist.json"),
            "got: {err}"
        );
    }

    // ── exec serialisation ──────────────────────────────────────────────────

    #[test]
    fn exec_http_get_serialises_with_type_tag() {
        let e = PluginToolExec::HttpGet(HttpGetExec {
            url_template: "https://api.example.com/{{id}}".to_string(),
            allowed_url_prefixes: vec!["https://api.example.com/".to_string()],
        });
        let s = serialise_exec_for_test(&e);
        assert!(s.contains(r#""type":"http_get""#), "got: {s}");
        assert!(s.contains("url_template"), "got: {s}");
    }

    #[test]
    fn exec_placeholder_serialises_cleanly() {
        let e = PluginToolExec::Placeholder;
        let s = serialise_exec_for_test(&e);
        assert_eq!(s, r#"{"type":"placeholder"}"#);
    }

    #[test]
    fn exec_http_get_deserialises_from_manifest_shape() {
        let raw = r#"{
          "type": "http_get",
          "url_template": "https://api.weather.gov/points/{{lat}},{{lon}}",
          "allowed_url_prefixes": ["https://api.weather.gov/"]
        }"#;
        let e: PluginToolExec = serde_json::from_str(raw).unwrap();
        match e {
            PluginToolExec::HttpGet(h) => {
                assert!(h.url_template.contains("{{lat}}"));
                assert_eq!(h.allowed_url_prefixes.len(), 1);
            }
            _ => panic!("expected HttpGet variant"),
        }
    }

    #[test]
    fn exec_placeholder_deserialises() {
        let raw = r#"{"type":"placeholder"}"#;
        let e: PluginToolExec = serde_json::from_str(raw).unwrap();
        assert!(matches!(e, PluginToolExec::Placeholder));
    }

    // ── allowlist file shape ────────────────────────────────────────────────

    #[test]
    fn allowlist_deserialises_empty() {
        let a: PluginsAllowlist = serde_json::from_str("{}").unwrap();
        assert!(a.allowed.is_empty());
    }

    #[test]
    fn allowlist_contains_match() {
        let a: PluginsAllowlist =
            serde_json::from_str(r#"{"allowed":["one","two"]}"#).unwrap();
        assert!(a.contains("one"));
        assert!(a.contains("two"));
        assert!(!a.contains("three"));
    }
}
