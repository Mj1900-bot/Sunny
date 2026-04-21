//! Deep research orchestrator.
//!
//! Takes a user question, runs a DuckDuckGo HTML search through the active
//! profile's transport, fans out parallel readable fetches of the top hits,
//! de-duplicates by canonical URL, and returns a structured brief the UI
//! (and the agent loop) can render with inline citations.
//!
//! What this module *is not*:
//! - An LLM. We don't call the model here. We hand back a `ResearchBrief`
//!   with `sources: Vec<Source>` — the caller (AutoPage / the React side)
//!   feeds that into whichever provider is configured. Keeping the LLM
//!   out of Rust lets the existing tools.ts wiring stay untouched.
//! - A search engine. We lean on DDG's HTML endpoint for the same reason
//!   [`web::search`] already does.

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browser::dispatcher;
use crate::browser::profile::ProfileId;
use crate::browser::reader;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Source {
    pub title: String,
    pub url: String,
    pub final_url: String,
    pub snippet: String,
    pub text: String,
    pub favicon_url: String,
    pub fetched_ok: bool,
    #[ts(type = "number")]
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResearchBrief {
    pub query: String,
    pub profile_id: String,
    pub sources: Vec<Source>,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

pub async fn run(
    profile_id: ProfileId,
    query: String,
    max_sources: usize,
) -> Result<ResearchBrief, String> {
    let started = std::time::Instant::now();
    let ddg_query = format!("https://html.duckduckgo.com/html/?q={}", urlencode(&query));
    let disp = dispatcher::global();
    let (_status, _final, body) = disp
        .fetch_text(&profile_id, &ddg_query, None)
        .await
        .map_err(|e| format!("search: {e}"))?;

    let hits = crate::web::parse_search_results_for_research(&body);
    let limit = max_sources.clamp(1, 20);
    let picks: Vec<_> = hits.into_iter().take(limit).collect();

    // Parallel fetch the reader extract for each pick. Dispatcher respects
    // the kill switch + tracker blocklist + profile route, so this is safe
    // to fan out wide.
    let fetches = picks.into_iter().map(|hit| {
        let disp = disp.clone();
        let pid = profile_id.clone();
        async move {
            let t0 = std::time::Instant::now();
            match disp.fetch_text(&pid, &hit.url, None).await {
                Ok((_s, final_url, body)) => {
                    let r = reader::extract(&body, &final_url);
                    let trimmed_text = truncate_words(&r.text, 1500);
                    Source {
                        title: if r.title.trim().is_empty() {
                            hit.title.clone()
                        } else {
                            r.title
                        },
                        url: hit.url,
                        final_url,
                        snippet: hit.snippet,
                        text: trimmed_text,
                        favicon_url: r.favicon_url,
                        fetched_ok: true,
                        ms: t0.elapsed().as_millis() as u64,
                    }
                }
                Err(_) => Source {
                    title: hit.title,
                    url: hit.url.clone(),
                    final_url: hit.url,
                    snippet: hit.snippet,
                    text: String::new(),
                    favicon_url: String::new(),
                    fetched_ok: false,
                    ms: t0.elapsed().as_millis() as u64,
                },
            }
        }
    });
    let sources = join_all(fetches).await;
    let sources = dedupe_by_final_url(sources);

    Ok(ResearchBrief {
        query,
        profile_id: profile_id.as_str().to_string(),
        sources,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn dedupe_by_final_url(mut v: Vec<Source>) -> Vec<Source> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|s| {
        let key = canonicalize(&s.final_url);
        seen.insert(key)
    });
    v
}

fn canonicalize(url: &str) -> String {
    // Strip common tracking params + trailing slash.
    let mut out = url.to_string();
    for junk in &[
        "utm_source=",
        "utm_medium=",
        "utm_campaign=",
        "utm_term=",
        "utm_content=",
        "fbclid=",
        "gclid=",
    ] {
        while let Some(i) = out.find(junk) {
            let end = out[i..]
                .find('&')
                .map(|r| i + r + 1)
                .unwrap_or(out.len());
            out.replace_range(i..end, "");
        }
    }
    out.trim_end_matches('/').to_string()
}

fn truncate_words(text: &str, max_words: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    for w in text.split_whitespace() {
        if n >= max_words {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
        n += 1;
    }
    out
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || "-_.~".contains(ch) {
            out.push(ch);
        } else {
            for b in ch.to_string().bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_strips_utm() {
        assert_eq!(
            canonicalize("https://x.com/a?utm_source=twitter&q=1"),
            "https://x.com/a?q=1"
        );
    }

    #[test]
    fn truncate_words_respects_budget() {
        let t = truncate_words("a b c d e f g h i j", 3);
        assert_eq!(t, "a b c");
    }

    #[test]
    fn urlencode_escapes_spaces() {
        assert_eq!(urlencode("hello world"), "hello%20world");
    }
}
