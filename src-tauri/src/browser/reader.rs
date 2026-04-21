//! Readable-mode HTML sanitizer. Moved here from `web.rs` so the browser
//! dispatcher can reuse the exact same pipeline — any future tightening of
//! the allow-list lands in one place.
//!
//! Behavior is identical to the original `web::fetch_readable` implementation
//! save for two changes:
//! 1. the network call is done by the caller and handed in as a string, so
//!    the dispatcher applies profile-scoped transport uniformly, and
//! 2. we also extract `<link rel="icon">` / `<meta name="description">` for
//!    the richer tab chrome the new UI can use.
//!
//! Everything lives behind the same tag/attr allow-list:
//!   h1-h6, p, pre, code, a[href], ul, ol, li, img[alt], blockquote, strong,
//!   em, br.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export)]
pub struct ReaderExtract {
    pub title: String,
    pub description: String,
    pub body_html: String,
    pub text: String,
    pub favicon_url: String,
}

pub fn extract(html: &str, base_url: &str) -> ReaderExtract {
    let title = extract_title(html);
    let description = extract_meta_description(html);
    let favicon = extract_favicon(html, base_url);
    let stripped = strip_blocks(html.to_string());
    let sanitized = sanitize(&stripped);
    let text = to_text(&sanitized);
    ReaderExtract {
        title,
        description,
        body_html: sanitized,
        text,
        favicon_url: favicon,
    }
}

// ---------- shared helpers (unchanged from web.rs) ----------

fn ascii_lower(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c })
        .collect()
}

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

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
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
    decode_entities(&rest[..close_rel]).trim().to_string()
}

fn extract_meta_description(html: &str) -> String {
    // Find <meta name="description" content="..."> in any order. We scan
    // forwards from every "<meta" open and pick whichever attribute pair
    // looks like a description meta.
    let mut cursor = 0usize;
    loop {
        let rel = find_ci(&html[cursor..], "<meta");
        let Some(open) = rel.map(|r| cursor + r) else {
            return String::new();
        };
        let Some(close) = html[open..].find('>') else {
            return String::new();
        };
        let tag = &html[open..open + close + 1];
        let low = ascii_lower(tag);
        if (low.contains("name=\"description\"") || low.contains("name='description'"))
            && (low.contains("content="))
        {
            if let Some(v) = attr_value(tag, "content") {
                return decode_entities(&v).trim().to_string();
            }
        }
        cursor = open + close + 1;
        if cursor >= html.len() {
            return String::new();
        }
    }
}

fn extract_favicon(html: &str, base_url: &str) -> String {
    // Prefer explicit <link rel="icon" href="...">; fall back to the
    // canonical /favicon.ico at the base origin.
    let mut cursor = 0usize;
    loop {
        let Some(open_rel) = find_ci(&html[cursor..], "<link") else {
            break;
        };
        let open = cursor + open_rel;
        let Some(close) = html[open..].find('>') else {
            break;
        };
        let tag = &html[open..open + close + 1];
        let low = ascii_lower(tag);
        let is_icon = low.contains("rel=\"icon\"")
            || low.contains("rel='icon'")
            || low.contains("rel=\"shortcut icon\"")
            || low.contains("rel='shortcut icon'");
        if is_icon {
            if let Some(href) = attr_value(tag, "href") {
                return resolve_url(&href, base_url);
            }
        }
        cursor = open + close + 1;
    }
    match url_origin(base_url) {
        Some(origin) => format!("{origin}/favicon.ico"),
        None => String::new(),
    }
}

fn attr_value(tag: &str, name: &str) -> Option<String> {
    let low = ascii_lower(tag);
    let needle = format!("{}=", name.to_ascii_lowercase());
    let idx = low.find(&needle)?;
    let start = idx + needle.len();
    let bytes = tag.as_bytes();
    let q = *bytes.get(start)?;
    if q == b'"' || q == b'\'' {
        let body = &tag[start + 1..];
        let end = body.find(q as char)?;
        Some(body[..end].to_string())
    } else {
        let body = &tag[start..];
        let end = body
            .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
            .unwrap_or(body.len());
        Some(body[..end].to_string())
    }
}

fn resolve_url(href: &str, base: &str) -> String {
    if href.is_empty() {
        return String::new();
    }
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("data:") {
        return href.to_string();
    }
    let Some(origin) = url_origin(base) else {
        return href.to_string();
    };
    if href.starts_with("//") {
        // scheme-relative
        let scheme = base.split("://").next().unwrap_or("https");
        return format!("{scheme}:{href}");
    }
    if href.starts_with('/') {
        return format!("{origin}{href}");
    }
    format!("{origin}/{href}")
}

fn url_origin(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let end = rest
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    Some(format!("{}{}", &url[..scheme_end + 3], &rest[..end]))
}

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

fn strip_blocks(mut html: String) -> String {
    for tag in STRIP_BLOCK_TAGS {
        let open_needle = format!("<{}", tag);
        let close_needle = format!("</{}>", tag);
        loop {
            let Some(open_idx) = find_ci(&html, &open_needle) else { break; };
            let after = open_idx + open_needle.len();
            let follow = html.as_bytes().get(after).copied().unwrap_or(b' ');
            if !(follow == b' ' || follow == b'>' || follow == b'/' ||
                 follow == b'\t' || follow == b'\n' || follow == b'\r') {
                let rest = &html[open_idx + 1..];
                match find_ci(rest, &open_needle) {
                    Some(_) => {
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
    loop {
        let Some(start) = html.find("<!--") else { break; };
        match html[start..].find("-->") {
            Some(rel) => { html.replace_range(start..start + rel + 3, ""); }
            None => { html.truncate(start); break; }
        }
    }
    html
}

fn sanitize(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'<' {
            let Some(rel) = html[i..].find('>') else { break; };
            let tag_raw = &html[i + 1..i + rel];
            i += rel + 1;
            if tag_raw.starts_with('!') || tag_raw.starts_with('?') {
                continue;
            }
            let (is_close, name_body) = if let Some(stripped) = tag_raw.strip_prefix('/') {
                (true, stripped)
            } else {
                (false, tag_raw)
            };
            let name_end = name_body
                .find(|c: char| c.is_ascii_whitespace() || c == '/')
                .unwrap_or(name_body.len());
            let name = &name_body[..name_end];
            if name.is_empty() {
                continue;
            }
            let Some(void) = is_allowed(name) else {
                continue;
            };
            let lower = ascii_lower(name);
            if is_close {
                if !void {
                    out.push_str(&format!("</{}>", lower));
                }
                continue;
            }
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
        let before_ok = idx == 0 || lower.as_bytes()[idx - 1].is_ascii_whitespace();
        let after = idx + needle.len();
        let bytes = attrs.as_bytes();
        if !before_ok {
            search_from = idx + 1;
            continue;
        }
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
    !(lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("vbscript:"))
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_pulls_title_description_favicon() {
        let html = r#"
            <html><head>
              <title>Hello</title>
              <meta name="description" content="a short blurb" />
              <link rel="icon" href="/icon.png" />
            </head><body><p>hi</p></body></html>
        "#;
        let r = extract(html, "https://example.com/page");
        assert_eq!(r.title, "Hello");
        assert_eq!(r.description, "a short blurb");
        assert_eq!(r.favicon_url, "https://example.com/icon.png");
        assert!(r.body_html.contains("<p>"));
    }

    #[test]
    fn sanitize_drops_script_tags() {
        let html = "<p>ok</p><script>alert(1)</script><p>still ok</p>";
        let r = extract(html, "https://x.com/");
        assert!(!r.body_html.contains("alert"));
        assert!(r.body_html.contains("<p>"));
    }

    #[test]
    fn anchor_rejects_javascript_scheme() {
        let html = "<a href=\"javascript:void(0)\">x</a>";
        let r = extract(html, "https://x.com/");
        assert!(!r.body_html.contains("javascript"));
    }
}
