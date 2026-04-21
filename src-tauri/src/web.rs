//! Lightweight WebView fetch helper — the legacy single-URL reader path.
//!
//! This module is **not** the multi-profile hardened browser. It is a thin
//! `reqwest`-based fetcher used by the legacy `browser_open` / `web_fetch`
//! osascript path that pre-dates `src-tauri/src/browser/`. The two are
//! completely separate:
//!
//! * `web.rs` — plain clearnet `reqwest::Client`, 15 s timeout, 4 MiB body
//!   cap, no profiles, no dispatcher, no audit log, no kill switch. Used by
//!   the older `web_fetch_readable` agent tool (preserved for backwards
//!   compatibility with existing tool callers).
//! * `browser/` — full multi-profile dispatcher with Tor/proxy/DoH routing,
//!   per-tab ephemeral WebView sandboxes, fingerprint hardening, tracker
//!   blocking, and the audit log at `~/.sunny/browser/audit.sqlite`. All new
//!   code should use the `browser_*` commands so every call picks up the
//!   active profile's posture.
//!
//! The `FetchResult` type is `#[ts(export)]`-derived and lives in
//! `src/bindings/FetchResult.ts`.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use ts_rs::TS;

const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/17.0 Safari/605.1.15 SUNNY/0.1";

const MAX_BODY_BYTES: usize = 4 * 1024 * 1024; // 4 MiB cap

#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FetchResult {
    pub ok: bool,
    #[ts(type = "number")]
    pub status: u16,
    pub title: String,
    pub body_html: String,
    pub text: String,
    pub url: String,
    pub final_url: String,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("client build failed: {}", e))
}

async fn fetch_html(url: &str) -> Result<(u16, String, String), String> {
    let client = build_client()?;
    let req = client.get(url);
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read body failed: {}", e))?;

    let slice = if bytes.len() > MAX_BODY_BYTES {
        &bytes[..MAX_BODY_BYTES]
    } else {
        &bytes[..]
    };
    let body = String::from_utf8_lossy(slice).to_string();
    Ok((status, final_url, body))
}

// ----- Regex-free HTML helpers (byte-level scans, case-insensitive) -----

fn ascii_lower(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c })
        .collect()
}

/// Find the first occurrence of `needle` inside `hay` (case-insensitive
/// ASCII match on the needle; hay is scanned as-is with ASCII lowercase
/// folding). Returns byte offset in original `hay`.
fn find_ci(hay: &str, needle_lower: &str) -> Option<usize> {
    let hb = hay.as_bytes();
    let nb = needle_lower.as_bytes();
    if nb.is_empty() || hb.len() < nb.len() {
        return None;
    }
    'outer: for i in 0..=hb.len() - nb.len() {
        for j in 0..nb.len() {
            let mut c = hb[i + j];
            if c.is_ascii_uppercase() {
                c += 32;
            }
            if c != nb[j] {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

fn extract_title(html: &str) -> String {
    let Some(start) = find_ci(html, "<title") else {
        return String::new();
    };
    let after_open = &html[start..];
    let Some(gt) = after_open.find('>') else {
        return String::new();
    };
    let content_start = start + gt + 1;
    let rest = &html[content_start..];
    let Some(close_rel) = find_ci(rest, "</title>") else {
        return String::new();
    };
    let raw = &rest[..close_rel];
    decode_entities(raw).trim().to_string()
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Allow-list of tag names that survive sanitization. Void tags marked true.
const ALLOWED: &[(&str, bool)] = &[
    ("h1", false), ("h2", false), ("h3", false), ("h4", false),
    ("h5", false), ("h6", false),
    ("p", false), ("pre", false), ("code", false),
    ("a", false), ("ul", false), ("ol", false), ("li", false),
    ("img", true),
    ("blockquote", false), ("strong", false), ("em", false),
    ("br", true),
];

fn is_allowed(name: &str) -> Option<bool> {
    let lower = ascii_lower(name);
    ALLOWED.iter().find(|(n, _)| *n == lower.as_str()).map(|(_, v)| *v)
}

const STRIP_BLOCK_TAGS: &[&str] = &[
    "script", "style", "iframe", "noscript", "template", "svg", "canvas",
];

/// Remove full `<tag>...</tag>` regions for dangerous elements.
fn strip_blocks(mut html: String) -> String {
    for tag in STRIP_BLOCK_TAGS {
        let open_needle = format!("<{}", tag);
        let close_needle = format!("</{}>", tag);
        loop {
            let Some(open_idx) = find_ci(&html, &open_needle) else { break; };
            // Confirm next char after tag name is whitespace, `>` or `/`.
            let after = open_idx + open_needle.len();
            let follow = html.as_bytes().get(after).copied().unwrap_or(b' ');
            if !(follow == b' ' || follow == b'>' || follow == b'/' ||
                 follow == b'\t' || follow == b'\n' || follow == b'\r') {
                // Not a real match (e.g. <scripted>). Advance past this spot.
                let rest = &html[open_idx + 1..];
                match find_ci(rest, &open_needle) {
                    Some(_) => {
                        // shift window: replace first byte with space to move on
                        let mut bytes = html.into_bytes();
                        bytes[open_idx] = b' ';
                        html = String::from_utf8_lossy(&bytes).into_owned();
                        continue;
                    }
                    None => break,
                }
            }
            match find_ci(&html[open_idx..], &close_needle) {
                Some(rel) => {
                    let end = open_idx + rel + close_needle.len();
                    html.replace_range(open_idx..end, "");
                }
                None => {
                    html.truncate(open_idx);
                    break;
                }
            }
        }
    }
    // Also strip <link ...> and <meta ...> self-closing/void tags entirely.
    for void_tag in &["link", "meta"] {
        let needle = format!("<{}", void_tag);
        loop {
            let Some(idx) = find_ci(&html, &needle) else { break; };
            let after = idx + needle.len();
            let follow = html.as_bytes().get(after).copied().unwrap_or(b'>');
            if !(follow == b' ' || follow == b'>' || follow == b'/' ||
                 follow == b'\t' || follow == b'\n') {
                let mut bytes = html.into_bytes();
                bytes[idx] = b' ';
                html = String::from_utf8_lossy(&bytes).into_owned();
                continue;
            }
            match html[idx..].find('>') {
                Some(rel) => {
                    html.replace_range(idx..idx + rel + 1, "");
                }
                None => {
                    html.truncate(idx);
                    break;
                }
            }
        }
    }
    // Strip HTML comments.
    loop {
        let Some(start) = html.find("<!--") else { break; };
        match html[start..].find("-->") {
            Some(rel) => { html.replace_range(start..start + rel + 3, ""); }
            None => { html.truncate(start); break; }
        }
    }
    html
}

/// Walk the HTML, emit only allowed tags, strip attributes except `href` on
/// anchors and `alt` on images. Never emits `<img src=...>` — alt only.
fn sanitize(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'<' {
            // Locate end of tag
            let Some(rel) = html[i..].find('>') else {
                break;
            };
            let tag_raw = &html[i + 1..i + rel]; // without < and >
            i += rel + 1;

            // Skip DOCTYPE, processing instructions, bogus comments.
            if tag_raw.starts_with('!') || tag_raw.starts_with('?') {
                continue;
            }

            let (is_close, name_body) = if let Some(stripped) = tag_raw.strip_prefix('/') {
                (true, stripped)
            } else {
                (false, tag_raw)
            };

            // Extract tag name (up to whitespace or /).
            let name_end = name_body
                .find(|c: char| c.is_ascii_whitespace() || c == '/')
                .unwrap_or(name_body.len());
            let name = &name_body[..name_end];
            if name.is_empty() {
                continue;
            }
            let Some(void) = is_allowed(name) else {
                continue; // drop tag entirely
            };
            let lower = ascii_lower(name);
            if is_close {
                if !void {
                    out.push_str(&format!("</{}>", lower));
                }
                continue;
            }

            // Opening tag — whitelist attributes.
            let attrs = &name_body[name_end..];
            let mut safe_attrs = String::new();

            if lower == "a" {
                if let Some(href) = extract_attr(attrs, "href") {
                    if is_safe_url(&href) {
                        safe_attrs.push_str(&format!(" href=\"{}\"", escape_attr(&href)));
                        safe_attrs.push_str(" target=\"_blank\" rel=\"noreferrer noopener\"");
                    }
                }
            } else if lower == "img" {
                // Strip src entirely; keep alt text only.
                if let Some(alt) = extract_attr(attrs, "alt") {
                    safe_attrs.push_str(&format!(" alt=\"{}\"", escape_attr(&alt)));
                }
            }

            if void {
                out.push_str(&format!("<{}{} />", lower, safe_attrs));
            } else {
                out.push_str(&format!("<{}{}>", lower, safe_attrs));
            }
        } else {
            // Text content — copy verbatim; strip on* handlers already
            // impossible here since they live in attributes.
            let ch_end = html[i..].find('<').map(|r| i + r).unwrap_or(bytes.len());
            out.push_str(&html[i..ch_end]);
            i = ch_end;
        }
    }
    out
}

fn extract_attr(attrs: &str, name: &str) -> Option<String> {
    let lower = ascii_lower(attrs);
    let needle = name.to_ascii_lowercase();
    let mut search_from = 0usize;
    while search_from < lower.len() {
        let idx = lower[search_from..].find(&needle).map(|r| search_from + r)?;
        // Must be preceded by whitespace (or start) and followed by `=`
        let before_ok = idx == 0
            || lower.as_bytes()[idx - 1].is_ascii_whitespace();
        let after = idx + needle.len();
        let bytes = attrs.as_bytes();
        if !before_ok {
            search_from = idx + 1;
            continue;
        }
        // Skip whitespace after name
        let mut k = after;
        while k < bytes.len() && bytes[k].is_ascii_whitespace() { k += 1; }
        if k >= bytes.len() || bytes[k] != b'=' {
            search_from = idx + 1;
            continue;
        }
        k += 1;
        while k < bytes.len() && bytes[k].is_ascii_whitespace() { k += 1; }
        if k >= bytes.len() { return None; }
        let q = bytes[k];
        if q == b'"' || q == b'\'' {
            let start = k + 1;
            let close = attrs[start..].find(q as char)?;
            return Some(decode_entities(&attrs[start..start + close]));
        }
        // Unquoted value
        let start = k;
        let end = bytes[start..]
            .iter()
            .position(|c| c.is_ascii_whitespace() || *c == b'>' || *c == b'/')
            .map(|r| start + r)
            .unwrap_or(bytes.len());
        return Some(decode_entities(&attrs[start..end]));
    }
    None
}

fn is_safe_url(u: &str) -> bool {
    let lower = u.trim().to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("vbscript:")
    {
        return false;
    }
    true
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Very rough plaintext: strip all tags from sanitized HTML and collapse ws.
fn to_text(sanitized: &str) -> String {
    let mut out = String::with_capacity(sanitized.len());
    let mut in_tag = false;
    for ch in sanitized.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => { in_tag = false; out.push(' '); }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub async fn fetch_readable(url: String) -> Result<FetchResult, String> {
    let (status, final_url, body) = fetch_html(&url).await?;
    let title = extract_title(&body);
    let stripped = strip_blocks(body);
    let sanitized = sanitize(&stripped);
    let text = to_text(&sanitized);
    Ok(FetchResult {
        ok: (200..400).contains(&status),
        status,
        title,
        body_html: sanitized,
        text,
        url,
        final_url,
    })
}

pub async fn fetch_title(url: String) -> Result<String, String> {
    let (_status, _final_url, body) = fetch_html(&url).await?;
    let t = extract_title(&body);
    Ok(t)
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------
//
// Uses DuckDuckGo's HTML endpoint (https://html.duckduckgo.com/html). No API
// key required, no rate-limit auth, and the page structure has been stable
// enough to extract {title, url, snippet} tuples with plain regexes.
//
// DDG wraps each result URL in a redirect: `/l/?uddg=<encoded-real-url>`.
// We decode that to hand the agent a clickable canonical URL it can feed
// straight back into `web_fetch_readable`.
//
// If the DDG HTML structure changes, `parse_ddg_results` returns an empty
// list rather than erroring — callers then see "0 results" and can fall
// through to other strategies (e.g. ask the user to refine the query). The
// tests lock down the extraction against a fixture so drift is caught early.

/// One search result, normalized for agent consumption.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

const DDG_SEARCH_URL: &str = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SEARCH_RESULTS: usize = 20;
const DEFAULT_SEARCH_RESULTS: usize = 8;

pub async fn search(query: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("search: query is empty".into());
    }
    let k = limit.unwrap_or(DEFAULT_SEARCH_RESULTS).clamp(1, MAX_SEARCH_RESULTS);

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(SEARCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|e| format!("search client: {e}"))?;

    // DDG accepts either GET `?q=` or POST with form-encoded body. POST
    // avoids some of the "enhanced referrer tracking" redirects.
    let form = [("q", q), ("kl", "us-en"), ("kp", "-2")]; // -2 = safe search moderate
    let req = client
        .post(DDG_SEARCH_URL)
        .form(&form)
        .header("Referer", "https://duckduckgo.com/");
    let resp = crate::http::send(req)
        .await
        .map_err(|e| format!("search request: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("search http {status}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("search body: {e}"))?;
    let slice = if bytes.len() > MAX_BODY_BYTES {
        &bytes[..MAX_BODY_BYTES]
    } else {
        &bytes[..]
    };
    let html = String::from_utf8_lossy(slice);

    let mut results = parse_ddg_results(&html);
    results.truncate(k);
    Ok(results)
}

/// Extract search results from DDG HTML. Returns an empty vec rather than
/// erroring on layout drift — the agent will see "no hits" and can retry
/// or pivot. Expects three standard selectors:
///
///   * `<a class="result__a" href="/l/?uddg=...">Title text</a>`
///   * `<a class="result__snippet" …>Snippet text</a>`
///
/// The `/l/?uddg=<encoded>` redirect is decoded to the canonical URL.
/// Public re-export used by [`crate::browser::research`] so the research
/// orchestrator can share the same DDG HTML parser without pulling a second
/// copy into `browser/`. The function itself remains private below.
pub fn parse_search_results_for_research(html: &str) -> Vec<SearchResult> {
    parse_ddg_results(html)
}

fn parse_ddg_results(html: &str) -> Vec<SearchResult> {
    // Each organic hit sits inside `<div class="result results_links…">`. We
    // split on that boundary so a regex doesn't have to match across blocks.
    let mut out: Vec<SearchResult> = Vec::new();
    for block in html.split("class=\"result results_links").skip(1) {
        let Some(a_open) = block.find("class=\"result__a\"") else { continue };
        let a_slice = &block[a_open..];
        let Some(href_start) = a_slice.find("href=\"") else { continue };
        let href_from = &a_slice[href_start + 6..];
        let Some(href_end) = href_from.find('"') else { continue };
        let href = &href_from[..href_end];

        // Title is the inner text of the `result__a` anchor.
        let after_href = &href_from[href_end + 1..];
        let Some(gt) = after_href.find('>') else { continue };
        let title_slice = &after_href[gt + 1..];
        let Some(close) = title_slice.find("</a>") else { continue };
        let title_html = &title_slice[..close];
        let title = to_text(title_html).trim().to_string();

        // Snippet (optional — some DDG rows don't have one, keep empty).
        let snippet = match block.find("class=\"result__snippet\"") {
            Some(s_open) => {
                let s_slice = &block[s_open..];
                if let Some(gt_s) = s_slice.find('>') {
                    let after_gt = &s_slice[gt_s + 1..];
                    if let Some(end) = after_gt.find("</a>") {
                        to_text(&after_gt[..end]).trim().to_string()
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            }
            None => String::new(),
        };

        let url = decode_ddg_redirect(href);
        if url.is_empty() || title.is_empty() {
            continue;
        }
        out.push(SearchResult { title, url, snippet });
    }
    out
}

/// DDG wraps every result in `/l/?uddg=<encoded-url>`. Strip the wrapper
/// and percent-decode so the agent gets a direct clickable URL. Non-wrapped
/// absolute URLs (rare) pass through unchanged.
fn decode_ddg_redirect(raw: &str) -> String {
    // Absolute-URL fast path.
    if raw.starts_with("http://") || raw.starts_with("https://") {
        if !raw.contains("duckduckgo.com/l/") {
            return raw.to_string();
        }
    }
    // Find the `uddg=` param regardless of leading host.
    let key = "uddg=";
    let Some(k_start) = raw.find(key) else {
        return String::new();
    };
    let after_key = &raw[k_start + key.len()..];
    let end = after_key.find('&').unwrap_or(after_key.len());
    let encoded = &after_key[..end];
    percent_decode(encoded)
}

/// Minimal percent decoder for the `uddg=` payload. URLs rarely contain
/// non-UTF-8, so any malformed byte stays as-is (prefix-preserving).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                hex_digit(bytes[i + 1]),
                hex_digit(bytes[i + 2]),
            ) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn percent_decode_handles_plus_and_hex() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%2F%2F"), "//");
        // Malformed sequences pass through.
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
    }

    #[test]
    fn decode_ddg_redirect_extracts_target_url() {
        let raw = "//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=abc";
        assert_eq!(decode_ddg_redirect(raw), "https://rust-lang.org/");
    }

    #[test]
    fn decode_passes_absolute_non_wrapped_urls() {
        assert_eq!(
            decode_ddg_redirect("https://example.com/direct"),
            "https://example.com/direct"
        );
    }

    #[test]
    fn parse_extracts_title_url_snippet_from_fixture() {
        // Compact fixture modeled on html.duckduckgo.com's current layout —
        // just enough structure to exercise the parser. The real page has
        // dozens of other wrappers around each result we don't care about.
        // NOTE: raw-string delimiter must be `r##"..."##` because the fixture
        // contains `href="#"`, which would otherwise close a `r#"..."#` block.
        let html = r##"
<div class="result results_links_deep web-result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsqlite.org%2Ffts5.html&rut=1">SQLite FTS5 Extension</a>
  </h2>
  <a class="result__snippet" href="#">FTS5 is an SQLite virtual table module that provides full-text search functionality.</a>
</div>
<div class="result results_links_deep web-result">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fasg017%2Fsqlite-vec&rut=2">asg017/sqlite-vec</a>
  </h2>
  <a class="result__snippet" href="#">A vector search SQLite extension that runs anywhere!</a>
</div>
"##;
        let hits = parse_ddg_results(html);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "SQLite FTS5 Extension");
        assert_eq!(hits[0].url, "https://sqlite.org/fts5.html");
        assert!(hits[0].snippet.contains("FTS5"));
        assert_eq!(hits[1].url, "https://github.com/asg017/sqlite-vec");
    }

    #[test]
    fn parse_handles_missing_snippet_gracefully() {
        let html = r##"
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">Title Only</a>
</div>
"##;
        let hits = parse_ddg_results(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Title Only");
        assert_eq!(hits[0].snippet, "");
    }

    #[test]
    fn parse_returns_empty_on_layout_change() {
        // Some other HTML that has no DDG result blocks → must not error,
        // must return empty.
        let html = "<html><body><h1>nothing here</h1></body></html>";
        assert!(parse_ddg_results(html).is_empty());
    }

    #[test]
    fn parse_skips_result_with_empty_title_or_url() {
        let html = r##"
<div class="result results_links_deep">
  <a class="result__a" href="//duckduckgo.com/l/?uddg="></a>
</div>
"##;
        assert!(parse_ddg_results(html).is_empty());
    }
}
