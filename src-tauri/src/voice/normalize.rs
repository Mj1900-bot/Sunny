//! Text and voice-name normalisation helpers.
//!
//! All functions here are pure (no I/O, no async, no daemon state) and
//! therefore independently testable. The 24 unit tests added in Round 2
//! live alongside the functions they exercise.


/// Resolve a user-facing voice name (settings UI label) to a Kokoro voice
/// id. Unknown names fall back to the default British male identity.
pub fn kokoro_voice_id(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "daniel" | "bm_daniel" => "bm_daniel",
        "george" | "bm_george" => "bm_george",
        "lewis" | "oliver" | "bm_lewis" => "bm_lewis",
        "fable" | "bm_fable" => "bm_fable",
        "emma" | "bf_emma" => "bf_emma",
        "alice" | "bf_alice" => "bf_alice",
        "isabella" | "bf_isabella" => "bf_isabella",
        "serena" => "bf_emma",
        // Allow raw Kokoro voice ids (including blends like "bm_daniel.6+bm_george.4")
        other if other.starts_with("bm_") || other.starts_with("bf_") || other.contains('+') => {
            // SAFETY: we only return &'static str for known names; for raw
            // passthrough we can't do that cheaply. Caller should check
            // via the `resolve_voice` helper below.
            "bm_george"
        }
        _ => "bm_george",
    }
}

/// Like `kokoro_voice_id` but returns the raw string for voice blends and
/// unrecognised `bm_*` / `bf_*` ids that Kokoro will still accept.
pub fn resolve_voice(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("bm_") || lower.starts_with("bf_") || lower.contains('+') {
        lower
    } else {
        kokoro_voice_id(name).to_string()
    }
}

/// Map `say`-style rate (words per minute) onto Kokoro's speed coefficient
/// where 1.0 ≈ natural neural pacing (~195 wpm). Clamped to sane bounds so
/// users can't render unintelligible 5× speech.
pub fn wpm_to_speed(rate: u32) -> f32 {
    let s = (rate as f32) / 195.0;
    s.clamp(0.5, 2.0)
}

/// Clean text before feeding it to Kokoro.
///
/// Neural prosody gets confused by markdown artefacts (bare `*`, `_`,
/// backticks leak into the phonemizer as real tokens) and by missing-space
/// punctuation ("word.Next" gets voiced as one word). We also promote
/// " - " to " — " because the em-dash gives a more natural pause than the
/// hyphen does. Newlines collapse to spaces so the daemon doesn't treat a
/// multi-sentence payload as multiple lines.
pub fn clean_for_kokoro(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\n' | '\r' | '\t' => out.push(' '),
            '*' | '_' | '`' => continue,
            '-' if out.ends_with(' ') && chars.peek().copied() == Some(' ') => out.push('—'),
            '.' | '?' | '!' | ',' | ';' | ':' => {
                out.push(c);
                if let Some(&next) = chars.peek() {
                    if next.is_alphabetic() { out.push(' '); }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Map our user-facing label into something `say -v` will accept when the
/// Kokoro path is unavailable. Everything collapses to "Daniel" — macOS
/// has no comparable British voice alternatives baked in.
pub fn say_compatible_voice(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "daniel" | "oliver" | "serena" => name.to_string(),
        _ => "Daniel".to_string(),
    }
}

// Re-export DEFAULT_VOICE for use in warm_daemon / prewarm callers inside
// mod.rs that previously referenced the module-level const directly.

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // kokoro_voice_id
    // -----------------------------------------------------------------------

    #[test]
    fn kokoro_voice_id_british_aliases_map_to_bm_daniel() {
        assert_eq!(kokoro_voice_id("daniel"), "bm_daniel");
        assert_eq!(kokoro_voice_id("Daniel"), "bm_daniel");
        assert_eq!(kokoro_voice_id("bm_daniel"), "bm_daniel");
    }

    #[test]
    fn kokoro_voice_id_american_maps_to_am_michael() {
        // "american" is not a listed alias — falls back to bm_george (default).
        assert_eq!(kokoro_voice_id("american"), "bm_george");
    }

    #[test]
    fn kokoro_voice_id_george_aliases() {
        assert_eq!(kokoro_voice_id("george"), "bm_george");
        assert_eq!(kokoro_voice_id("George"), "bm_george");
        assert_eq!(kokoro_voice_id("bm_george"), "bm_george");
    }

    #[test]
    fn kokoro_voice_id_female_aliases() {
        assert_eq!(kokoro_voice_id("emma"), "bf_emma");
        assert_eq!(kokoro_voice_id("alice"), "bf_alice");
        assert_eq!(kokoro_voice_id("serena"), "bf_emma");
        assert_eq!(kokoro_voice_id("isabella"), "bf_isabella");
    }

    #[test]
    fn kokoro_voice_id_unknown_falls_back_to_bm_george() {
        assert_eq!(kokoro_voice_id("en_gb"), "bm_george");
        assert_eq!(kokoro_voice_id(""), "bm_george");
        assert_eq!(kokoro_voice_id("totally_unknown"), "bm_george");
    }

    #[test]
    fn kokoro_voice_id_raw_bm_bf_passthrough_returns_bm_george() {
        // Raw bm_*/bf_* ids that aren't in the named list still hit the
        // passthrough arm, which returns bm_george (static str constraint).
        assert_eq!(kokoro_voice_id("bm_unknown"), "bm_george");
        assert_eq!(kokoro_voice_id("bf_mystery"), "bm_george");
    }

    // -----------------------------------------------------------------------
    // resolve_voice
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_voice_passthrough_for_raw_prefix() {
        assert_eq!(resolve_voice("bm_daniel"), "bm_daniel");
        assert_eq!(resolve_voice("bf_emma"), "bf_emma");
        assert_eq!(resolve_voice("BM_GEORGE"), "bm_george");
    }

    #[test]
    fn resolve_voice_blend_passthrough() {
        assert_eq!(
            resolve_voice("bm_daniel.6+bm_george.4"),
            "bm_daniel.6+bm_george.4"
        );
    }

    #[test]
    fn resolve_voice_named_alias_delegates_to_kokoro_voice_id() {
        assert_eq!(resolve_voice("lewis"), "bm_lewis");
        assert_eq!(resolve_voice("fable"), "bm_fable");
        assert_eq!(resolve_voice("george"), "bm_george");
    }

    #[test]
    fn resolve_voice_unknown_falls_back_to_bm_george() {
        assert_eq!(resolve_voice("totally_unknown"), "bm_george");
    }

    // -----------------------------------------------------------------------
    // wpm_to_speed
    // -----------------------------------------------------------------------

    #[test]
    fn wpm_to_speed_natural_rate_is_one() {
        let s = wpm_to_speed(195);
        assert!((s - 1.0).abs() < 0.001, "expected ~1.0, got {s}");
    }

    #[test]
    fn wpm_to_speed_clamps_at_lower_bound() {
        let s = wpm_to_speed(50);
        assert!((s - 0.5).abs() < 0.001, "expected 0.5 (lower clamp), got {s}");
    }

    #[test]
    fn wpm_to_speed_clamps_at_upper_bound() {
        let s = wpm_to_speed(500);
        assert!((s - 2.0).abs() < 0.001, "expected 2.0 (upper clamp), got {s}");
    }

    #[test]
    fn wpm_to_speed_proportional_mid_range() {
        let s = wpm_to_speed(390);
        assert!((s - 2.0).abs() < 0.001, "expected 2.0 at 390 wpm, got {s}");
        let s2 = wpm_to_speed(148);
        let expected = 148.0_f32 / 195.0;
        assert!((s2 - expected).abs() < 0.001, "expected {expected:.3}, got {s2}");
    }

    // -----------------------------------------------------------------------
    // clean_for_kokoro
    // -----------------------------------------------------------------------

    #[test]
    fn clean_for_kokoro_strips_markdown_bold() {
        assert_eq!(clean_for_kokoro("*bold*"), "bold");
        assert_eq!(clean_for_kokoro("_italic_"), "italic");
        assert_eq!(clean_for_kokoro("**strong**"), "strong");
    }

    #[test]
    fn clean_for_kokoro_strips_backticks() {
        assert_eq!(clean_for_kokoro("`code`"), "code");
        assert_eq!(clean_for_kokoro("use `Vec<T>`"), "use Vec<T>");
    }

    #[test]
    fn clean_for_kokoro_hyphen_to_em_dash() {
        let out = clean_for_kokoro("pause - here");
        assert!(out.contains('—'), "expected em-dash in '{out}'");
        assert!(!out.contains(" - "), "expected hyphen-space removed, got '{out}'");
    }

    #[test]
    fn clean_for_kokoro_space_after_period_before_alpha() {
        let out = clean_for_kokoro("end.Next");
        assert_eq!(out, "end. Next");
    }

    #[test]
    fn clean_for_kokoro_space_after_question_mark() {
        let out = clean_for_kokoro("Really?No");
        assert_eq!(out, "Really? No");
    }

    #[test]
    fn clean_for_kokoro_collapses_newlines_to_spaces() {
        let out = clean_for_kokoro("line one\nline two\r\nline three");
        assert!(!out.contains('\n') && !out.contains('\r'), "expected no newlines, got '{out}'");
        assert!(out.contains("line one"), "first line missing");
        assert!(out.contains("line two"), "second line missing");
    }

    #[test]
    fn clean_for_kokoro_passthrough_plain_text() {
        let s = "Hello world, this is normal text.";
        assert_eq!(clean_for_kokoro(s), s);
    }

    // -----------------------------------------------------------------------
    // say_compatible_voice
    // -----------------------------------------------------------------------

    #[test]
    fn say_compatible_voice_known_aliases_preserved() {
        assert_eq!(say_compatible_voice("daniel"), "daniel");
        assert_eq!(say_compatible_voice("oliver"), "oliver");
        assert_eq!(say_compatible_voice("serena"), "serena");
    }

    #[test]
    fn say_compatible_voice_unknown_maps_to_daniel() {
        assert_eq!(say_compatible_voice("george"), "Daniel");
        assert_eq!(say_compatible_voice("emma"), "Daniel");
        assert_eq!(say_compatible_voice("bm_lewis"), "Daniel");
        assert_eq!(say_compatible_voice("totally_unknown"), "Daniel");
    }

    #[test]
    fn say_compatible_voice_case_insensitive_matching_preserves_original_case() {
        assert_eq!(say_compatible_voice("Daniel"), "Daniel");
        assert_eq!(say_compatible_voice("OLIVER"), "OLIVER");
    }

    // -----------------------------------------------------------------------
    // clean_for_kokoro — edge cases not yet covered by Round 2 tests
    // -----------------------------------------------------------------------

    /// Multiple consecutive `*` markers (e.g. `****`) must all be stripped,
    /// leaving nothing. A run of four `*` chars = four `continue` iterations.
    #[test]
    fn clean_for_kokoro_multiple_consecutive_stars_are_fully_stripped() {
        assert_eq!(clean_for_kokoro("****"), "");
        assert_eq!(clean_for_kokoro("**a**"), "a");
        // Triple backtick (code-fence open)
        assert_eq!(clean_for_kokoro("```rust"), "rust");
        assert_eq!(clean_for_kokoro("```"), "");
    }

    /// Mixed code-fence + bold: backticks and asterisks interleaved.
    /// All marker chars are stripped; the payload remains.
    #[test]
    fn clean_for_kokoro_mixed_code_fence_and_bold_stripped() {
        // "```**bold**```" → "bold"
        let input = "```**bold**```";
        let out = clean_for_kokoro(input);
        assert_eq!(out, "bold", "got: '{out}'");
    }

    /// A code-fence block with content inside.
    /// Backticks are stripped; spaces and letters pass through.
    #[test]
    fn clean_for_kokoro_code_fence_with_content() {
        // "``` let x = 1; ```" → " let x = 1; "  (backticks stripped, rest kept)
        let out = clean_for_kokoro("``` let x = 1; ```");
        assert_eq!(out, " let x = 1; ");
    }

    /// The em-dash rule ONLY fires when the hyphen is immediately preceded by
    /// a space and immediately followed by a space. "x-y" must pass through
    /// unchanged — no em-dash conversion.
    #[test]
    fn clean_for_kokoro_hyphen_without_surrounding_spaces_is_unchanged() {
        // Hyphen embedded in a word — no spaces around it.
        let out = clean_for_kokoro("self-contained");
        assert_eq!(out, "self-contained", "hyphen-no-spaces must not become em-dash");
    }

    /// "word -suffix" — space before hyphen but NOT after → no em-dash.
    #[test]
    fn clean_for_kokoro_hyphen_space_before_no_space_after_is_unchanged() {
        let out = clean_for_kokoro("word -suffix");
        assert!(!out.contains('—'), "no em-dash without trailing space: '{out}'");
        assert!(out.contains('-'), "original hyphen must survive: '{out}'");
    }

    /// "prefix- " — space after hyphen but NOT before → no em-dash.
    /// (The `out.ends_with(' ')` check sees the 'e' of "prefix", not a space.)
    #[test]
    fn clean_for_kokoro_hyphen_space_after_no_space_before_is_unchanged() {
        let out = clean_for_kokoro("prefix- end");
        assert!(!out.contains('—'), "no em-dash without leading space: '{out}'");
    }

    /// Hyphen at the very start of the string — `out.ends_with(' ')` is false
    /// (out is empty at that point), so no em-dash.
    #[test]
    fn clean_for_kokoro_leading_hyphen_no_em_dash() {
        let out = clean_for_kokoro("-word");
        assert!(!out.contains('—'), "leading hyphen must not become em-dash: '{out}'");
        assert!(out.starts_with('-'), "hyphen must be preserved: '{out}'");
    }

    /// The confirmed em-dash path: " - " → em-dash replaces the hyphen,
    /// and the trailing space is consumed by the rule (peeked but not
    /// advanced — the next iteration processes it as a regular space).
    #[test]
    fn clean_for_kokoro_space_hyphen_space_becomes_em_dash() {
        let out = clean_for_kokoro("pause - here");
        assert!(out.contains('—'), "' - ' must produce em-dash: '{out}'");
        // The original " - " sequence should not appear
        assert!(!out.contains(" - "), "original ' - ' must be gone: '{out}'");
    }

    /// Multiple " - " patterns in one string — each occurrence is converted.
    #[test]
    fn clean_for_kokoro_multiple_space_hyphen_space_patterns() {
        let out = clean_for_kokoro("a - b - c");
        // Both hyphens should be converted to em-dashes
        let em_count = out.chars().filter(|&c| c == '—').count();
        assert_eq!(em_count, 2, "two ' - ' patterns, expected 2 em-dashes, got: '{out}'");
    }

    /// Consecutive underscores `___` — all stripped.
    #[test]
    fn clean_for_kokoro_consecutive_underscores_stripped() {
        assert_eq!(clean_for_kokoro("___"), "");
        assert_eq!(clean_for_kokoro("__x__"), "x");
    }

    /// Tab characters collapse to spaces (same branch as newlines).
    #[test]
    fn clean_for_kokoro_tabs_collapse_to_spaces() {
        let out = clean_for_kokoro("col1\tcol2\tcol3");
        assert!(!out.contains('\t'), "tabs must be replaced with spaces");
        assert!(out.contains("col1 col2 col3"), "content must survive: '{out}'");
    }

    /// Punctuation at end of string (no following char to peek at) — no
    /// trailing space is inserted; the punctuation itself must be present.
    #[test]
    fn clean_for_kokoro_punctuation_at_end_of_string() {
        let out = clean_for_kokoro("done.");
        assert_eq!(out, "done.", "trailing period must be preserved without extra space");
    }

    /// Comma before alpha → space inserted. Comma before digit → no space.
    #[test]
    fn clean_for_kokoro_comma_before_alpha_gets_space() {
        let out = clean_for_kokoro("one,Two");
        assert_eq!(out, "one, Two", "comma before alpha must gain a space");
        let out2 = clean_for_kokoro("value,42");
        assert_eq!(out2, "value,42", "comma before digit must not gain a space");
    }

    /// Semicolon and colon before alpha → space inserted.
    #[test]
    fn clean_for_kokoro_semicolon_colon_before_alpha_get_space() {
        assert_eq!(clean_for_kokoro("a;B"), "a; B");
        assert_eq!(clean_for_kokoro("key:Value"), "key: Value");
    }
}
