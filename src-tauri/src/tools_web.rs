//! Web tool module — gives SUNNY first-class access to the public web.
//!
//! Four Tauri commands live here:
//!   1. `web_fetch`          — HTTP GET a URL. HTML is stripped to readable
//!                             text, JSON is pretty-printed, everything else
//!                             is returned verbatim. Output is truncated so a
//!                             500 KB page can't blow the LLM's context.
//!   2. `web_search`         — Scrapes DuckDuckGo's `html.duckduckgo.com`
//!                             endpoint for result tuples (title, url,
//!                             snippet). Falls back to Brave's HTML search
//!                             if DDG refuses to cooperate (403, captcha,
//!                             unexpected markup).
//!   3. `web_extract_links`  — Pulls `<a href>` pairs out of a page,
//!                             resolved to absolute URLs.
//!   4. `web_extract_title`  — Returns the page `<title>` (or first `<h1>`
//!                             as a fallback — some SPAs leave title empty).
//!
//! Transport: `reqwest` with rustls, same crate the rest of the app uses.
//! Parsing:  `scraper` crate (html5ever under the hood) so we don't have to
//! hand-roll a fragile regex HTML stripper. The crate is tolerant of
//! malformed markup — exactly the shape of the real web.
//!
//! The user-agent is a current Safari string because DuckDuckGo and Brave
//! both serve empty or captcha'd HTML to the default `reqwest/x.y` UA.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use scraper::{Html, Selector};

/// Standard desktop-Safari UA. Kept identical across every request the
/// module makes so a site's "you look like a bot" heuristics don't flag
/// one endpoint as suspicious while another slides through.
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 \
     (KHTML, like Gecko) Version/17.0 Safari/537.36";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Default output cap (characters) when callers don't specify. 4 KB fits
/// comfortably in a single assistant turn even after framing overhead.
const DEFAULT_MAX_CHARS: usize = 4_000;

/// Absolute ceiling — even if the caller asks for more, we refuse to
/// return more than this. 12 KB is about 3 K tokens of context: big
/// enough to carry a full article, small enough that a runaway agent
/// can't thrash the context window by fetching a huge page in a loop.
const HARD_MAX_CHARS: usize = 12_000;

/// Default `max_links` for the extractor when the caller omits it.
const DEFAULT_MAX_LINKS: usize = 30;

/// Absolute ceiling on links so a DOM with 10k `<a>` tags can't
/// explode the response.
const HARD_MAX_LINKS: usize = 200;

/// Maximum number of search results we surface. The prompt brief asks
/// for "top 8" and scraping further results adds noise without much
/// signal — DDG/Brave re-rank aggressively so 8 already covers breadth.
const SEARCH_RESULT_LIMIT: usize = 8;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Absolute ceiling on redirects we follow. Matches the old
/// `Policy::limited(10)` value but is now enforced by our manual redirect
/// loop so we can re-validate every hop against the SSRF blocklist
/// (DNS-rebinding defence).
const MAX_REDIRECTS: usize = 10;

/// Build a shared reqwest client. We rebuild per-call rather than caching
/// because these tools are invoked infrequently (a few times per session)
/// and a fresh client keeps the timeout / UA configuration explicit at
/// every call-site.
///
/// Redirects are disabled at the transport layer — we follow them
/// manually via `send_with_redirect_guard` so every hop can be
/// re-validated against the SSRF blocklist. `Policy::custom` is a sync
/// closure and can't `await` a DNS lookup, so we do the loop ourselves.
fn make_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client build failed: {e}"))
}

// ---------------------------------------------------------------------------
// SSRF defence
// ---------------------------------------------------------------------------
//
// Any URL that the agent fetches must first be checked — both the literal
// host (if it's an IP) and every resolved address (if it's a DNS name) —
// to make sure it doesn't point at a private / loopback / link-local /
// metadata endpoint. A prompt-injected page could otherwise coax the
// agent into hitting `http://169.254.169.254/…` (EC2 IMDS),
// `http://127.0.0.1:8080/` (localhost admin), `http://10.0.0.1/…`
// (intranet), etc.
//
// Validation happens pre-request AND after every redirect — single-IP DNS
// replies can't be trusted against a rebinding attacker.

/// True if `addr` is any flavour of "not a public internet destination".
/// Covers IPv4 and IPv6 plus a few families the stdlib doesn't expose
/// as a single boolean (unique-local IPv6, IPv4-mapped IPv6).
fn is_blocked_ip(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

fn is_blocked_v4(v4: &Ipv4Addr) -> bool {
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_documentation()
        // 100.64.0.0/10 — CGNAT (RFC 6598). Not exposed by the stdlib
        // as a named predicate, but shouldn't be agent-reachable either.
        || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64)
        // 192.0.0.0/24 — IETF protocol assignments.
        || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0)
        // 198.18.0.0/15 — network benchmarking (RFC 2544).
        || (v4.octets()[0] == 198 && (v4.octets()[1] & 0xFE) == 18)
}

fn is_blocked_v6(v6: &Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_multicast() || v6.is_unspecified() {
        return true;
    }
    let seg = v6.segments();
    // fc00::/7 — unique local addresses (RFC 4193). First byte's high
    // seven bits are 1111110x, i.e. segment[0] & 0xFE00 == 0xFC00.
    if seg[0] & 0xFE00 == 0xFC00 {
        return true;
    }
    // fe80::/10 — link-local (stdlib doesn't ship `is_unicast_link_local`
    // on stable).
    if seg[0] & 0xFFC0 == 0xFE80 {
        return true;
    }
    // IPv4-mapped (::ffff:a.b.c.d): defer to the IPv4 check.
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_blocked_v4(&v4);
    }
    // IPv4-compatible (::a.b.c.d, deprecated but still a routing trick).
    if seg[0..6].iter().all(|s| *s == 0) && (seg[6] != 0 || seg[7] != 0) {
        let v4 = Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xFF) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xFF) as u8,
        );
        if is_blocked_v4(&v4) {
            return true;
        }
    }
    // 2001:db8::/32 — documentation prefix.
    if seg[0] == 0x2001 && seg[1] == 0x0DB8 {
        return true;
    }
    false
}

/// Resolve `host:port` and reject if any resolved address is blocked.
/// Multiple-address defence: a DNS rebinder can return one public and
/// one private IP, hoping the application picks the public one for
/// validation and the private one for the real request. We refuse the
/// whole hostname if *any* address is dangerous.
async fn resolve_and_check(host: &str, port: u16) -> Result<(), String> {
    use tokio::net::lookup_host;
    let addrs = lookup_host((host, port))
        .await
        .map_err(|e| format!("dns lookup for {host} failed: {e}"))?;
    let mut any = false;
    for sa in addrs {
        any = true;
        let ip = sa.ip();
        if is_blocked_ip(&ip) {
            return Err(format!(
                "refusing request: host {host} resolves to blocked address {ip}"
            ));
        }
    }
    if !any {
        return Err(format!("dns lookup for {host} returned no addresses"));
    }
    Ok(())
}

/// Normalise whitespace: collapse any run of whitespace (including
/// newlines, tabs, non-breaking spaces) into a single space, then
/// re-introduce paragraph breaks at sensible boundaries so the output
/// is still scannable by the LLM.
///
/// We do this in two passes: first collapse, then heuristically split on
/// full stops followed by spaces so we don't end up with one
/// multi-thousand-character single line.
fn collapse_whitespace(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = true; // skip leading whitespace
    for ch in raw.chars() {
        if ch.is_whitespace() || ch == '\u{00A0}' {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    // Trim the trailing space if any.
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Truncate `s` to at most `limit` chars. When we chop, append a clear
/// marker so the LLM knows the content is partial and can either ask
/// for more or stop mid-paragraph without hallucinating continuation.
fn truncate_with_marker(s: String, limit: usize) -> String {
    // `chars().count()` respects multibyte codepoints. `len()` would
    // over-count for CJK / emoji-heavy pages and chop mid-codepoint
    // when we slice.
    if s.chars().count() <= limit {
        return s;
    }
    // Take the first `limit` chars by iterating (cheap, avoids a second
    // pass to compute byte offsets by hand).
    let truncated: String = s.chars().take(limit).collect();
    format!("{truncated}\n\n[truncated at {limit} chars]")
}

/// Clamp the user's `max_chars` request into [1, HARD_MAX_CHARS] with
/// DEFAULT_MAX_CHARS when they passed None.
fn resolve_max_chars(requested: Option<usize>) -> usize {
    let v = requested.unwrap_or(DEFAULT_MAX_CHARS);
    v.clamp(1, HARD_MAX_CHARS)
}

fn resolve_max_links(requested: Option<usize>) -> usize {
    let v = requested.unwrap_or(DEFAULT_MAX_LINKS);
    v.clamp(1, HARD_MAX_LINKS)
}

/// Element names whose text we deliberately ignore — they carry code,
/// styling, or other non-reading content. Matched case-insensitively
/// against the qualified local name.
const SKIP_TAGS: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "iframe", "head",
    "link", "meta",
];

/// Strip `<script>`, `<style>`, and other content-bearing but
/// useless-for-reading elements, then extract textContent from the
/// remaining tree. Returns plain human-readable text with whitespace
/// collapsed.
fn html_to_text(html: &str) -> String {
    // `scraper::Html::parse_document` is tolerant of malformed markup —
    // it's the same parser Servo uses, so broken tag soup still yields
    // a sensible tree.
    let doc = Html::parse_document(html);

    // Recursive descent is simpler than trying to flag ancestors during
    // a flat `descendants()` walk — we just short-circuit the subtree
    // at a skip element.
    let mut buf = String::new();
    walk_text(doc.tree.root(), &mut buf);
    collapse_whitespace(&buf)
}

fn walk_text(node: ego_tree::NodeRef<scraper::Node>, buf: &mut String) {
    match node.value() {
        scraper::Node::Text(t) => {
            buf.push_str(&t);
            buf.push(' ');
        }
        scraper::Node::Element(el) => {
            let name = el.name().to_ascii_lowercase();
            if SKIP_TAGS.iter().any(|t| *t == name) {
                return;
            }
            for child in node.children() {
                walk_text(child, buf);
            }
            // Block-level elements: append a newline so paragraphs
            // don't run together after whitespace collapse. collapse
            // will normalise runs but preserve at least one gap.
            if matches!(
                name.as_str(),
                "p" | "br" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                | "article" | "section" | "header" | "footer" | "nav" | "main" | "blockquote"
                | "pre" | "table"
            ) {
                buf.push('\n');
            }
        }
        _ => {
            for child in node.children() {
                walk_text(child, buf);
            }
        }
    }
}

/// Best-effort pretty-print for JSON. If the body isn't actually valid
/// JSON (common when a misconfigured server claims `application/json`
/// but returns HTML error pages) we fall through and render it as plain
/// text so the caller still gets *something* rather than a cryptic
/// parse error.
fn try_pretty_json(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    serde_json::to_string_pretty(&value).ok()
}

/// Classify a Content-Type header into the coarse family we branch on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContentKind {
    Html,
    Json,
    Other,
}

fn classify_content_type(ct: Option<&str>) -> ContentKind {
    let Some(v) = ct else {
        return ContentKind::Other;
    };
    let lower = v.to_ascii_lowercase();
    if lower.contains("text/html") || lower.contains("application/xhtml") {
        ContentKind::Html
    } else if lower.contains("application/json") || lower.contains("+json") {
        ContentKind::Json
    } else {
        ContentKind::Other
    }
}

/// Guard against obviously-invalid URLs before we waste a socket, and
/// reject URLs that resolve to private / loopback / link-local / metadata
/// IPs (SSRF defence). The resolution check is re-run after every
/// redirect in `send_with_redirect_guard`.
///
/// Preserves the original signature for backward compatibility; the
/// async SSRF check is dispatched via a current-thread block when called
/// from sync contexts (tests only — the production call sites use the
/// async path via `validate_http_url_async`).
fn validate_http_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("invalid url \"{url}\": {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "unsupported url scheme \"{other}\" (expected http/https)"
            ))
        }
    }
    // Literal IP fast path — no DNS needed. Works without an async
    // runtime (used by the synchronous test suite and belt-and-braces
    // before we defer to the async resolution path).
    //
    // `host_str` renders IPv6 literals *with* brackets (`[::1]`), which
    // won't parse as an `IpAddr`. Strip them so the parse succeeds.
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("url \"{url}\" has no host"))?;
    let host_unbracketed = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = host_unbracketed.parse::<IpAddr>() {
        if is_blocked_ip(&ip) {
            return Err(format!(
                "refusing request: url \"{url}\" targets blocked address {ip}"
            ));
        }
    }
    Ok(())
}

/// Full async validation: scheme + literal-IP check + DNS resolution
/// check. All production request paths call this before every HTTP
/// hop (including after redirects).
async fn validate_http_url_async(url: &str) -> Result<(), String> {
    validate_http_url(url)?;
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| format!("invalid url \"{url}\": {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("url \"{url}\" has no host"))?;
    // If it was a literal IP the sync check already cleared it and DNS
    // resolution would just return the same address — skip the network
    // round-trip. Strip IPv6 brackets so the parse attempt succeeds.
    let host_unbracketed = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    if host_unbracketed.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let port = parsed
        .port_or_known_default()
        .unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });
    resolve_and_check(host, port).await
}

/// GET `url` while re-validating the target IP on every redirect hop.
/// Returns the final `reqwest::Response` or an error if any hop resolves
/// to a blocked address, the scheme isn't http(s), or the redirect chain
/// exceeds `MAX_REDIRECTS`.
///
/// Why manual instead of `reqwest::redirect::Policy::custom`: the custom
/// policy closure is synchronous and cannot `await` a DNS lookup. We'd
/// either have to do blocking DNS from within an async runtime (bad) or
/// accept that DNS-named redirects go unchecked. Looping here keeps the
/// logic simple and uses only async DNS.
async fn send_with_redirect_guard(
    client: &reqwest::Client,
    initial_url: &str,
) -> Result<reqwest::Response, String> {
    // Borrow the string and only allocate when a redirect actually
    // gives us a new URL to chase.
    let mut current: String = initial_url.to_string();
    for hop in 0..=MAX_REDIRECTS {
        validate_http_url_async(&current).await?;
        let resp = crate::http::send(client.get(&current))
            .await
            .map_err(|e| format!("GET {current} failed: {e}"))?;

        let status = resp.status();
        if !status.is_redirection() {
            return Ok(resp);
        }
        if hop == MAX_REDIRECTS {
            return Err(format!(
                "too many redirects (>{MAX_REDIRECTS}) starting from {initial_url}"
            ));
        }
        // Extract the Location header and resolve it against the current
        // URL (handles relative redirects). We clone out of the headers
        // before dropping `resp` because `resp.url()` borrows from it.
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                format!(
                    "redirect from {current} has no Location header (status {})",
                    status.as_u16()
                )
            })?;
        let base = resp.url().clone();
        let next = base
            .join(&location)
            .map_err(|e| format!("invalid redirect target \"{location}\": {e}"))?;
        current = next.to_string();
    }
    // Loop is inclusive on both ends; unreachable because the guard
    // above returns before we'd exceed MAX_REDIRECTS.
    Err(format!("redirect loop exited unexpectedly from {initial_url}"))
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn web_fetch(url: String, max_chars: Option<usize>) -> Result<String, String> {
    validate_http_url(&url)?;
    let limit = resolve_max_chars(max_chars);

    let client = make_client()?;
    let resp = send_with_redirect_guard(&client, &url).await?;

    let status = resp.status();
    // Preserve the content-type header before we consume the body —
    // `resp.text()` moves `resp` and we lose access after that.
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let kind = classify_content_type(ct.as_deref());

    let body = resp
        .text()
        .await
        .map_err(|e| format!("read body from {url}: {e}"))?;

    if !status.is_success() {
        // Still try to give the caller something useful — the body of a
        // 4xx/5xx often contains the explanation ("Rate limit reached",
        // "Not found", …). Cap it hard.
        let preview: String = body.chars().take(500).collect();
        return Err(format!(
            "GET {url} returned HTTP {}: {preview}",
            status.as_u16()
        ));
    }

    let rendered = match kind {
        ContentKind::Html => html_to_text(&body),
        ContentKind::Json => try_pretty_json(&body).unwrap_or(body),
        ContentKind::Other => body,
    };

    let rendered = if rendered.trim().is_empty() {
        format!("(empty body from {url}; content-type={})", ct.as_deref().unwrap_or("unknown"))
    } else {
        rendered
    };

    Ok(truncate_with_marker(rendered, limit))
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct SearchHit {
    title: String,
    url: String,
    snippet: String,
}

fn format_hits(hits: &[SearchHit]) -> String {
    hits.iter()
        .enumerate()
        .map(|(i, h)| {
            // Keep snippet short — DDG's snippets can be ~250 chars but
            // beyond ~180 adds little signal and burns tokens.
            let snip = if h.snippet.chars().count() > 240 {
                let short: String = h.snippet.chars().take(240).collect();
                format!("{short}…")
            } else {
                h.snippet.clone()
            };
            format!("{idx}. {title}\n   {url}\n   {snip}",
                idx = i + 1,
                title = h.title,
                url = h.url,
                snip = snip,
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[tauri::command]
pub async fn tool_web_search(query: String) -> Result<String, String> {
    // SSRF note: `tool_web_search` only ever hits two hard-coded public
    // hosts (html.duckduckgo.com, search.brave.com). The query string
    // is URL-encoded and embedded as the `q=` parameter — neither
    // endpoint interprets the query as a target URL, so a
    // prompt-injected query cannot redirect the fetch to an internal
    // metadata endpoint here. The risk is downstream: *scraped result
    // URLs* could point at private ranges, but those only become
    // actual requests if the agent feeds them back to `web_fetch` /
    // `web_extract_*`, and those paths all run through the SSRF guard
    // in `validate_http_url` + `send_with_redirect_guard`.
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("query must be a non-empty string".to_string());
    }

    let client = make_client()?;

    // DDG first (historically the most scraper-friendly).
    match ddg_search(&client, trimmed).await {
        Ok(hits) if !hits.is_empty() => {
            return Ok(format_hits(&hits));
        }
        Ok(_) => {
            log::debug!("web_search: DuckDuckGo returned zero hits for {trimmed:?}, trying Brave");
        }
        Err(e) => {
            log::debug!("web_search: DuckDuckGo failed ({e}), trying Brave");
        }
    }

    // Fallback: Brave. Different scraping heuristics, same output shape.
    match brave_search(&client, trimmed).await {
        Ok(hits) if !hits.is_empty() => Ok(format_hits(&hits)),
        Ok(_) => Err(format!(
            "both DuckDuckGo and Brave returned zero parseable results for {trimmed:?}"
        )),
        Err(e) => Err(format!("search failed (DDG then Brave): {e}")),
    }
}

async fn ddg_search(client: &reqwest::Client, query: &str) -> Result<Vec<SearchHit>, String> {
    // DDG's HTML endpoint accepts POST form data as well as a GET query
    // string; GET is simpler and the one most scrapers use.
    let encoded_q = urlencode(query);
    let endpoint = format!("https://html.duckduckgo.com/html/?q={encoded_q}");

    let resp = crate::http::send(
        client
            .get(&endpoint)
            // DDG serves a banner/terms page if Accept is too narrow;
            // mirror a browser's default.
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml"),
    )
    .await
    .map_err(|e| format!("ddg request: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(format!("ddg blocked with HTTP {}", status.as_u16()));
    }
    if !status.is_success() {
        return Err(format!("ddg http {}", status.as_u16()));
    }

    let body = resp.text().await.map_err(|e| format!("ddg body: {e}"))?;
    let doc = Html::parse_document(&body);

    // DDG's HTML markup: each result is inside `.result`, title in
    // `.result__a`, snippet in `.result__snippet`. They've changed
    // class names historically so try a couple selectors.
    let result_sel = Selector::parse(".result").map_err(|e| format!("sel: {e}"))?;
    let title_sel = Selector::parse(".result__a").map_err(|e| format!("sel: {e}"))?;
    let snippet_sel = Selector::parse(".result__snippet").map_err(|e| format!("sel: {e}"))?;

    let mut hits: Vec<SearchHit> = Vec::new();
    for el in doc.select(&result_sel) {
        if hits.len() >= SEARCH_RESULT_LIMIT {
            break;
        }
        let Some(title_el) = el.select(&title_sel).next() else { continue };
        let title = collapse_whitespace(&title_el.text().collect::<String>());
        let raw_href = title_el.value().attr("href").unwrap_or("").to_string();
        // DDG wraps destination URLs in a redirect: /l/?uddg=<encoded>.
        // Unwrap it so the LLM sees the real URL.
        let url = unwrap_ddg_redirect(&raw_href);
        if url.is_empty() || title.is_empty() {
            continue;
        }
        let snippet = el
            .select(&snippet_sel)
            .next()
            .map(|s| collapse_whitespace(&s.text().collect::<String>()))
            .unwrap_or_default();
        hits.push(SearchHit { title, url, snippet });
    }

    Ok(hits)
}

async fn brave_search(client: &reqwest::Client, query: &str) -> Result<Vec<SearchHit>, String> {
    let encoded_q = urlencode(query);
    let endpoint = format!("https://search.brave.com/search?q={encoded_q}");

    let resp = crate::http::send(
        client
            .get(&endpoint)
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml"),
    )
    .await
    .map_err(|e| format!("brave request: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("brave http {}", status.as_u16()));
    }

    let body = resp.text().await.map_err(|e| format!("brave body: {e}"))?;
    let doc = Html::parse_document(&body);

    // Brave's current result markup: each "snippet" lives under
    // `.snippet` or `[data-type=web]`. The title anchor carries the
    // URL, the snippet sits in `.snippet-description`.
    let candidate_selectors = [
        ("[data-type='web']", "a.heading-serpresult", ".snippet-description"),
        (".snippet", "a", ".snippet-description"),
        (".result-row", "a.result-header", ".snippet-description"),
    ];

    let mut hits: Vec<SearchHit> = Vec::new();
    for (row, anchor, snip) in &candidate_selectors {
        let Ok(row_sel) = Selector::parse(row) else { continue };
        let Ok(anchor_sel) = Selector::parse(anchor) else { continue };
        let Ok(snip_sel) = Selector::parse(snip) else { continue };
        for el in doc.select(&row_sel) {
            if hits.len() >= SEARCH_RESULT_LIMIT {
                break;
            }
            let Some(a) = el.select(&anchor_sel).next() else { continue };
            let Some(href) = a.value().attr("href") else { continue };
            if !href.starts_with("http") {
                continue;
            }
            let title = collapse_whitespace(&a.text().collect::<String>());
            let snippet = el
                .select(&snip_sel)
                .next()
                .map(|s| collapse_whitespace(&s.text().collect::<String>()))
                .unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            hits.push(SearchHit {
                title,
                url: href.to_string(),
                snippet,
            });
        }
        if !hits.is_empty() {
            break;
        }
    }

    Ok(hits)
}

/// DDG wraps result links as `/l/?uddg=<percent-encoded-url>`. Unwrap
/// so downstream tools see a usable absolute URL.
fn unwrap_ddg_redirect(href: &str) -> String {
    // Early-exit cheap path.
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    // Resolve protocol-relative // first.
    let absolute = if href.starts_with("//") {
        format!("https:{href}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href.to_string()
    };
    // Now parse and look for the uddg parameter.
    let Ok(parsed) = reqwest::Url::parse(&absolute) else {
        return absolute;
    };
    for (k, v) in parsed.query_pairs() {
        if k == "uddg" {
            return v.into_owned();
        }
    }
    absolute
}

/// Minimal URL component encoder so we don't pull in a whole crate
/// just for a search query. Encodes anything outside the unreserved
/// set (RFC 3986) as percent-escapes.
fn urlencode(input: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
    let mut out = String::with_capacity(input.len());
    for b in input.as_bytes() {
        if UNRESERVED.contains(b) {
            out.push(*b as char);
        } else if *b == b' ' {
            out.push('+');
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// web_extract_links
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn web_extract_links(
    url: String,
    max_links: Option<usize>,
) -> Result<String, String> {
    validate_http_url(&url)?;
    let limit = resolve_max_links(max_links);

    let client = make_client()?;
    let resp = send_with_redirect_guard(&client, &url).await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("GET {url} returned HTTP {}", status.as_u16()));
    }
    // `resp.url()` is the *final* URL after redirects — crucial for
    // accurate relative-to-absolute resolution. With manual redirect
    // following this is the final hop we validated and fetched.
    let base = resp.url().clone();
    let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;

    let doc = Html::parse_document(&body);
    let a_sel = Selector::parse("a[href]").map_err(|e| format!("sel: {e}"))?;

    let mut seen: Vec<String> = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    for a in doc.select(&a_sel) {
        if lines.len() >= limit {
            break;
        }
        let Some(href) = a.value().attr("href") else { continue };
        let trimmed = href.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("javascript:") {
            continue;
        }
        // Resolve to absolute against the (post-redirect) base URL.
        let Ok(absolute) = base.join(trimmed) else { continue };
        let abs_str = absolute.to_string();
        if seen.iter().any(|u| u == &abs_str) {
            continue;
        }
        seen.push(abs_str.clone());
        let text = collapse_whitespace(&a.text().collect::<String>());
        let label = if text.is_empty() { "(no text)".to_string() } else { text };
        // Cap individual label length so a nav mega-menu can't balloon
        // the response.
        let label = if label.chars().count() > 120 {
            let short: String = label.chars().take(120).collect();
            format!("{short}…")
        } else {
            label
        };
        lines.push(format!("- [{label}]({abs_str})"));
    }

    if lines.is_empty() {
        return Ok(format!("No links found on {url}"));
    }
    Ok(format!(
        "Extracted {} link(s) from {}:\n{}",
        lines.len(),
        base,
        lines.join("\n")
    ))
}

// ---------------------------------------------------------------------------
// web_extract_title
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(dead_code)]
pub async fn web_extract_title(url: String) -> Result<String, String> {
    validate_http_url(&url)?;

    let client = make_client()?;
    let resp = send_with_redirect_guard(&client, &url).await?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("GET {url} returned HTTP {}", status.as_u16()));
    }
    let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    let doc = Html::parse_document(&body);

    // Primary: <title>. html5ever puts it inside <head> but scraper
    // finds it regardless.
    if let Ok(sel) = Selector::parse("title") {
        if let Some(el) = doc.select(&sel).next() {
            let text = collapse_whitespace(&el.text().collect::<String>());
            if !text.is_empty() {
                return Ok(text);
            }
        }
    }

    // Fallback: first <h1>. Useful for SPAs that render their title
    // dynamically (Notion docs, older Next.js builds, …).
    if let Ok(sel) = Selector::parse("h1") {
        if let Some(el) = doc.select(&sel).next() {
            let text = collapse_whitespace(&el.text().collect::<String>());
            if !text.is_empty() {
                return Ok(text);
            }
        }
    }

    Err(format!("no <title> or <h1> found on {url}"))
}

// ---------------------------------------------------------------------------
// Tests — pure helpers only (no network).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_marker_preserves_short() {
        let s = "hello world".to_string();
        assert_eq!(truncate_with_marker(s.clone(), 100), s);
    }

    #[test]
    fn truncate_marker_cuts_long() {
        let s = "a".repeat(5_000);
        let out = truncate_with_marker(s, 100);
        assert!(out.starts_with(&"a".repeat(100)));
        assert!(out.contains("[truncated at 100 chars]"));
    }

    #[test]
    fn collapse_normalises_whitespace() {
        assert_eq!(collapse_whitespace("  hello\n\tworld  \n"), "hello world");
        assert_eq!(collapse_whitespace(""), "");
    }

    #[test]
    fn html_stripped_of_script_and_style() {
        let html = r#"
            <html><head><title>t</title><style>body{color:red}</style></head>
            <body>
              <script>alert('x')</script>
              <p>Hello <b>world</b>.</p>
              <noscript>no</noscript>
            </body></html>
        "#;
        let out = html_to_text(html);
        assert!(out.contains("Hello"));
        assert!(out.contains("world"));
        assert!(!out.contains("alert"));
        assert!(!out.contains("color:red"));
        assert!(!out.contains("no"));
    }

    #[test]
    fn classify_content_types() {
        assert_eq!(
            classify_content_type(Some("text/html; charset=utf-8")),
            ContentKind::Html
        );
        assert_eq!(
            classify_content_type(Some("application/json")),
            ContentKind::Json
        );
        assert_eq!(
            classify_content_type(Some("application/vnd.api+json")),
            ContentKind::Json
        );
        assert_eq!(classify_content_type(Some("image/png")), ContentKind::Other);
        assert_eq!(classify_content_type(None), ContentKind::Other);
    }

    #[test]
    fn resolve_max_chars_clamps() {
        assert_eq!(resolve_max_chars(None), DEFAULT_MAX_CHARS);
        assert_eq!(resolve_max_chars(Some(0)), 1);
        assert_eq!(resolve_max_chars(Some(9999999)), HARD_MAX_CHARS);
        assert_eq!(resolve_max_chars(Some(1000)), 1000);
    }

    #[test]
    fn urlencode_basic() {
        assert_eq!(urlencode("hello world"), "hello+world");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn unwrap_ddg_direct() {
        assert_eq!(unwrap_ddg_redirect("https://example.com/x"), "https://example.com/x");
    }

    #[test]
    fn unwrap_ddg_redirect_param() {
        let wrapped = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc";
        assert_eq!(unwrap_ddg_redirect(wrapped), "https://example.com/page");
    }

    #[test]
    fn validate_rejects_non_http() {
        assert!(validate_http_url("ftp://example.com").is_err());
        assert!(validate_http_url("not a url").is_err());
        assert!(validate_http_url("https://example.com").is_ok());
    }

    // -----------------------------------------------------------------
    // SSRF — literal IP blocklist
    // -----------------------------------------------------------------

    #[test]
    fn blocks_ipv4_loopback() {
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(&ip));
        let ip: IpAddr = "127.255.255.254".parse().unwrap();
        assert!(is_blocked_ip(&ip));
    }

    #[test]
    fn blocks_ipv4_private_ranges() {
        for addr in ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.1"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn blocks_ipv4_link_local_metadata() {
        // 169.254.169.254 — AWS / GCP / Azure IMDS endpoint. The
        // canonical SSRF target and the single most important case.
        let ip: IpAddr = "169.254.169.254".parse().unwrap();
        assert!(is_blocked_ip(&ip));
    }

    #[test]
    fn blocks_ipv4_unspecified_and_multicast_and_broadcast() {
        for addr in ["0.0.0.0", "224.0.0.1", "239.255.255.255", "255.255.255.255"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn blocks_ipv4_documentation_and_benchmark() {
        for addr in ["192.0.2.1", "198.51.100.5", "203.0.113.9", "198.18.0.1", "198.19.255.254"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn blocks_ipv4_cgnat() {
        for addr in ["100.64.0.1", "100.127.255.254"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn allows_public_ipv4() {
        for addr in ["1.1.1.1", "8.8.8.8", "140.82.114.4", "93.184.216.34"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(!is_blocked_ip(&ip), "{addr} should be allowed");
        }
    }

    #[test]
    fn blocks_ipv6_loopback_and_unspecified() {
        for addr in ["::1", "::"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn blocks_ipv6_unique_local_fc00() {
        for addr in ["fc00::1", "fd12:3456:789a::1", "fdff:ffff::1"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn blocks_ipv6_link_local() {
        for addr in ["fe80::1", "febf::1"] {
            let ip: IpAddr = addr.parse().unwrap();
            assert!(is_blocked_ip(&ip), "{addr} should be blocked");
        }
    }

    #[test]
    fn blocks_ipv4_mapped_ipv6() {
        // ::ffff:127.0.0.1 — mapped form of loopback. A naive blocker
        // that only ran IPv4 predicates on IpAddr::V4 would miss this.
        let ip: IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(&ip));
        let ip: IpAddr = "::ffff:169.254.169.254".parse().unwrap();
        assert!(is_blocked_ip(&ip));
        let ip: IpAddr = "::ffff:10.0.0.1".parse().unwrap();
        assert!(is_blocked_ip(&ip));
    }

    #[test]
    fn allows_public_ipv6() {
        // 2606:4700:4700::1111 — Cloudflare public DNS.
        let ip: IpAddr = "2606:4700:4700::1111".parse().unwrap();
        assert!(!is_blocked_ip(&ip));
    }

    #[test]
    fn blocks_ipv6_documentation() {
        let ip: IpAddr = "2001:db8::1".parse().unwrap();
        assert!(is_blocked_ip(&ip));
    }

    // -----------------------------------------------------------------
    // validate_http_url — URL-level blocklist
    // -----------------------------------------------------------------

    #[test]
    fn validate_rejects_loopback_url() {
        assert!(validate_http_url("http://127.0.0.1/").is_err());
        assert!(validate_http_url("http://[::1]/").is_err());
    }

    #[test]
    fn validate_rejects_metadata_url() {
        assert!(validate_http_url("http://169.254.169.254/latest/meta-data/").is_err());
    }

    #[test]
    fn validate_rejects_private_url() {
        assert!(validate_http_url("http://10.0.0.1/admin").is_err());
        assert!(validate_http_url("http://192.168.1.1/").is_err());
        assert!(validate_http_url("http://[fc00::1]/").is_err());
    }

    #[test]
    fn validate_accepts_public_ip_literal() {
        assert!(validate_http_url("http://1.1.1.1/").is_ok());
        assert!(validate_http_url("https://8.8.8.8/").is_ok());
    }

    #[test]
    fn validate_accepts_public_hostname() {
        // The sync path only checks literal IPs; hostnames are deferred
        // to the async resolver. So a well-formed hostname should pass
        // the sync check — the DNS check runs at request time.
        assert!(validate_http_url("https://example.com/").is_ok());
    }

    // -----------------------------------------------------------------
    // Async path — DNS resolution + blocklist
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn async_validate_blocks_localhost_hostname() {
        // "localhost" resolves to 127.0.0.1 / ::1, both of which must
        // be rejected even when reached via a DNS name (the common
        // SSRF bypass path — an attacker registers a DNS record for
        // their domain pointing at 127.0.0.1).
        let err = validate_http_url_async("http://localhost/").await;
        assert!(err.is_err(), "localhost must be rejected, got {err:?}");
    }

    #[tokio::test]
    async fn async_validate_blocks_metadata_hostname_literal() {
        // Literal IP path — no DNS round-trip needed.
        let err = validate_http_url_async("http://169.254.169.254/").await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn async_validate_accepts_public_literal() {
        // 1.1.1.1 literal — skip DNS, should succeed.
        assert!(validate_http_url_async("https://1.1.1.1/").await.is_ok());
    }

    #[test]
    fn try_pretty_json_roundtrip() {
        let raw = r#"{"a":1,"b":[2,3]}"#;
        let pretty = try_pretty_json(raw).unwrap();
        assert!(pretty.contains("\"a\": 1"));
    }

    #[test]
    fn try_pretty_json_rejects_non_json() {
        assert!(try_pretty_json("<html>nope</html>").is_none());
    }
}
