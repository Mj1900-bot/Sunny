// Pure URL + extract helpers used by the Web module. Kept in their own
// file with zero Tauri/zustand dependencies so they can be unit-tested
// under vitest without booting a browser environment.

import type { BrowserFetchResult } from './types';

// A best-effort URL heuristic. Treat something as a URL when it could
// plausibly resolve as a hostname; everything else falls through to
// search. Covers the common cases a user actually types:
// "example.com", "localhost:3000", "192.168.1.1",
// "https://example.com/x". Whitespace, leading "?", or no dot + no
// colon makes it a search query.
export function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0) return false;
  if (/\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return true;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return false;
  // Any token with a dot and a plausible TLD-ish tail.
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?(\?.*)?(#.*)?$/.test(s)) return true;
  return false;
}

/// Build the search URL for a free-text query. DuckDuckGo is the default
/// because it doesn't require a session cookie and honors POST-free
/// navigation — both help the tor/private profiles stay low-signal.
export function searchUrl(query: string): string {
  const q = encodeURIComponent(query.trim());
  return `https://duckduckgo.com/?q=${q}`;
}

/// The omnibar routing function. Returns an empty string for dangerous
/// schemes (so the caller aborts the navigation), passes explicit-scheme
/// URLs through unchanged, prepends `https://` to URL-shaped input, and
/// falls back to a search URL for free-text queries.
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:')
  ) {
    return '';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (looksLikeUrl(trimmed)) return `https://${trimmed}`;
  return searchUrl(trimmed);
}

/// Heuristic: a reader extract is "thin" when it's clearly a JS-rendered
/// shell with no real article body. Tolerate short-but-complete pages
/// (like a small blog post) by requiring BOTH the plain-text and the
/// rendered HTML to be tiny. Thresholds chosen empirically: Google's
/// homepage lands around ~180 chars of text, a Wikipedia stub is 1k+.
export function isExtractThin(result: BrowserFetchResult): boolean {
  const text = result.extract.text.trim();
  const html = result.extract.body_html.trim();
  return text.length < 400 && html.length < 600;
}

/// hostname without the `www.` prefix, or the raw input if it doesn't
/// parse as a URL. Kept stable across pure + effectful call sites so
/// history/bookmark lookups render the same host the tab strip shows.
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
