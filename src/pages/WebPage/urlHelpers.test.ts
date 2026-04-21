import { describe, expect, it } from 'vitest';
import {
  hostOf,
  isExtractThin,
  looksLikeUrl,
  normalizeUrl,
  searchUrl,
} from './urlHelpers';
import type { BrowserFetchResult } from './types';

describe('looksLikeUrl', () => {
  it('accepts bare domains with common TLDs', () => {
    expect(looksLikeUrl('example.com')).toBe(true);
    expect(looksLikeUrl('google.ca')).toBe(true);
    expect(looksLikeUrl('sub.example.co.uk')).toBe(true);
    expect(looksLikeUrl('api.example.com/path')).toBe(true);
    expect(looksLikeUrl('example.com:8080')).toBe(true);
    expect(looksLikeUrl('example.com/path?q=1#frag')).toBe(true);
  });

  it('accepts explicit schemes', () => {
    expect(looksLikeUrl('https://example.com')).toBe(true);
    expect(looksLikeUrl('http://example.com')).toBe(true);
    expect(looksLikeUrl('ftp://example.com')).toBe(true);
    expect(looksLikeUrl('chrome://settings')).toBe(true);
  });

  it('accepts localhost variants', () => {
    expect(looksLikeUrl('localhost')).toBe(true);
    expect(looksLikeUrl('localhost:3000')).toBe(true);
    expect(looksLikeUrl('localhost:3000/foo')).toBe(true);
    expect(looksLikeUrl('LocalHost:8080')).toBe(true);
  });

  it('accepts IPv4 addresses', () => {
    expect(looksLikeUrl('192.168.1.1')).toBe(true);
    expect(looksLikeUrl('127.0.0.1:8000')).toBe(true);
    expect(looksLikeUrl('10.0.0.1/path')).toBe(true);
  });

  it('rejects free-text queries', () => {
    expect(looksLikeUrl('hello world')).toBe(false);
    expect(looksLikeUrl('best pasta recipes')).toBe(false);
    expect(looksLikeUrl('single-word')).toBe(false);
    expect(looksLikeUrl('how to center a div')).toBe(false);
    expect(looksLikeUrl('')).toBe(false);
    expect(looksLikeUrl('   ')).toBe(false);
  });

  it('rejects filesystem-style paths', () => {
    // Leading "/" is the "go to this path on my local server" shorthand
    // we intentionally do not auto-upgrade to a URL; the address bar
    // needs a host first.
    expect(looksLikeUrl('/home/user/file')).toBe(false);
    expect(looksLikeUrl('./relative')).toBe(false);
    expect(looksLikeUrl('../up')).toBe(false);
  });

  it('rejects single words without a dot', () => {
    // Important: "google" alone should become a search for "google",
    // not a navigation to https://google. This is the top address-bar
    // UX regression we're guarding against.
    expect(looksLikeUrl('google')).toBe(false);
    expect(looksLikeUrl('reddit')).toBe(false);
  });

  it('ignores surrounding whitespace', () => {
    expect(looksLikeUrl('  example.com  ')).toBe(true);
    expect(looksLikeUrl('\thttps://x.io\n')).toBe(true);
  });
});

describe('searchUrl', () => {
  it('produces a DuckDuckGo URL with the query percent-encoded', () => {
    expect(searchUrl('cats')).toBe('https://duckduckgo.com/?q=cats');
    expect(searchUrl('best pasta recipes')).toBe(
      'https://duckduckgo.com/?q=best%20pasta%20recipes',
    );
  });

  it('encodes special characters', () => {
    expect(searchUrl('C++ tutorial')).toBe(
      'https://duckduckgo.com/?q=C%2B%2B%20tutorial',
    );
    expect(searchUrl('q=1&x=2')).toBe(
      'https://duckduckgo.com/?q=q%3D1%26x%3D2',
    );
  });

  it('trims surrounding whitespace before encoding', () => {
    expect(searchUrl('  cats  ')).toBe('https://duckduckgo.com/?q=cats');
  });
});

describe('normalizeUrl', () => {
  it('passes explicit-scheme URLs through untouched', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://example.com/path?q=1')).toBe(
      'http://example.com/path?q=1',
    );
  });

  it('prepends https:// to URL-shaped bare input', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('google.ca')).toBe('https://google.ca');
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeUrl('192.168.1.1')).toBe('https://192.168.1.1');
  });

  it('routes free-text to a search URL', () => {
    expect(normalizeUrl('best pasta')).toBe(
      'https://duckduckgo.com/?q=best%20pasta',
    );
    // Single word without a dot → search, not navigation.
    expect(normalizeUrl('google')).toBe('https://duckduckgo.com/?q=google');
  });

  it('returns empty string for dangerous schemes so the caller can abort', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBe('');
    expect(normalizeUrl('JavaScript:alert(1)')).toBe('');
    expect(normalizeUrl('data:text/html,<script>')).toBe('');
    expect(normalizeUrl('vbscript:x')).toBe('');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
    expect(normalizeUrl('\t\n')).toBe('');
  });
});

describe('isExtractThin', () => {
  function result(text: string, html: string): BrowserFetchResult {
    return {
      status: 200,
      ok: true,
      final_url: 'https://example.com',
      url: 'https://example.com',
      extract: {
        title: 'T',
        description: '',
        body_html: html,
        text,
        favicon_url: '',
      },
    };
  }

  it('flags empty extracts as thin', () => {
    expect(isExtractThin(result('', ''))).toBe(true);
  });

  it('flags tiny extracts as thin (typical SPA shell)', () => {
    expect(isExtractThin(result('Sign In · Help · Privacy', '<div>.</div>'))).toBe(true);
  });

  it('does NOT flag short-but-complete articles as thin', () => {
    // A 500+ char text should pass even if body_html is small, and
    // vice versa. This prevents a blog tagline from escalating to
    // sandbox unnecessarily.
    const longText = 'x'.repeat(500);
    const longHtml = '<p>' + 'x'.repeat(700) + '</p>';
    expect(isExtractThin(result(longText, '<p>.</p>'))).toBe(false);
    expect(isExtractThin(result('short', longHtml))).toBe(false);
  });

  it('ignores leading/trailing whitespace when measuring', () => {
    // A page that returned 500 bytes of whitespace + 10 bytes of
    // content should still count as thin.
    expect(isExtractThin(result('   hi   ', '   <i>x</i>   '))).toBe(true);
  });

  it('uses an AND between text and html thresholds', () => {
    // Thin text + rich HTML → NOT thin (the image gallery case).
    const richHtml = '<p>' + 'y'.repeat(700) + '</p>';
    expect(isExtractThin(result('', richHtml))).toBe(false);
    // Rich text + thin HTML → NOT thin.
    expect(isExtractThin(result('z'.repeat(500), '<p>.</p>'))).toBe(false);
  });
});

describe('hostOf', () => {
  it('returns the hostname for a well-formed URL', () => {
    expect(hostOf('https://example.com')).toBe('example.com');
    expect(hostOf('https://example.com/path')).toBe('example.com');
    expect(hostOf('http://api.example.com:8080/x')).toBe('api.example.com');
  });

  it('strips the www. prefix', () => {
    expect(hostOf('https://www.example.com/x')).toBe('example.com');
    expect(hostOf('http://www.google.ca')).toBe('google.ca');
  });

  it('returns the raw input for anything un-parseable', () => {
    expect(hostOf('not a url')).toBe('not a url');
    expect(hostOf('')).toBe('');
  });
});
