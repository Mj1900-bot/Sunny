//! LLM-classified compound-signal synthesis for the ambient watcher.
//!
//! Sprint-12 θ: sprint-10 θ fixed narrow-chip starvation under the rule-based
//! compound path; this module upgrades compound synthesis itself from a
//! hand-coded rule set into a tiny local-model classifier pass. The model
//! picks ONE of a fixed intent-tag vocabulary (or NONE); a confidence
//! threshold gates whether we surface.
//!
//! Design goals (hard constraints from the sprint brief):
//!
//!   1. **Power**: the classifier must not run more than once per 60 s even
//!      if the ambient tick is faster. Rate gating lives in `ambient.rs`;
//!      this module is stateless w.r.t. time.
//!   2. **Latency**: a 2 s hard cap on the Ollama call. If the model is
//!      cold-loading or thinking, the ambient tick MUST not block on us —
//!      the caller falls back to the rule-based path.
//!   3. **Graceful fallback**: if Ollama is unreachable (daemon off, model
//!      not pulled, any network error), return `Err` so the caller can run
//!      the existing `synthesise_compound_signal` path exactly as sprint-8
//!      left it. Sprint-10 θ's narrow-chip decoupling invariants are
//!      preserved because we never touch the `AmbientDisk` in this module.
//!   4. **Determinism**: prompt construction and response parsing are pure
//!      functions so the whole pipeline is unit-testable without an LLM.
//!
//! The intent vocabulary is intentionally small — five tags plus NONE — so
//! the model has high recall on a 0.5B-1B parameter footprint. New tags
//! cost more prompt budget and dilute the model's confidence calibration;
//! adding one should be deliberate.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::world::WorldState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default local classifier model. Chosen because:
///   * 0.5 B params → loads in ~1 s cold, inferences in 200-500 ms warm
///     on the user's Mac, well inside our 2 s timeout.
///   * `-instruct` tuning means it reliably follows the "output JSON"
///     instruction without thinking-mode preamble.
///   * Already likely present if the user runs any qwen family model;
///     cheap to pull (~400 MB) otherwise.
///
/// Users can override via `settings.json::ambientModel` — the full model
/// tag string as `ollama list` would print it.
pub const DEFAULT_AMBIENT_MODEL: &str = "qwen2.5:0.5b-instruct";

/// Confidence floor — below this we treat the classifier result as a NONE
/// and emit nothing. 0.6 is a deliberate "more-likely-than-not plus a
/// margin" threshold — at 0.5 the model fires on coin-flips, at 0.7 it
/// misses legitimate single-signal intents.
pub const CONFIDENCE_THRESHOLD: f32 = 0.6;

/// Hard timeout on the Ollama call. The ambient tick is polled every few
/// seconds; we must never stall it. 2 s is enough for a warm 0.5 B model
/// to produce ~40 tokens of JSON.
pub const CLASSIFIER_TIMEOUT_SECS: u64 = 2;

/// Ollama's /api/generate endpoint — simpler than /api/chat for a
/// one-shot classifier. No message history, no tools.
const OLLAMA_GENERATE_URL: &str = "http://127.0.0.1:11434/api/generate";

/// Cap on the digest string we send to the model. Keeps prompt budget
/// small (→ fast inference) and removes the temptation to pack noisy
/// high-dimensional signals the 0.5 B model can't reason about anyway.
const DIGEST_MAX_LEN: usize = 300;

// ---------------------------------------------------------------------------
// Intent vocabulary
// ---------------------------------------------------------------------------

/// The closed set of intents the classifier may return. Hard-coded here
/// because (a) it IS the model's vocabulary and (b) adding a tag requires
/// a corresponding code path to render the surface body, so we want the
/// compile-time check.
///
/// Ordering matters only insofar as the enum's Debug/Display form is what
/// we serialise into the prompt — a stable order helps prompt caching
/// even though Ollama's generate endpoint doesn't expose it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IntentTag {
    /// Battery is low and/or trending low while the user is focused.
    /// Replaces the sprint-8 `meeting+battery` and `focus+battery`
    /// compound rules with a single, context-aware nudge.
    SuggestCharge,
    /// Long idle after a heavy-focus stretch — a natural break point.
    /// New in the LLM path; the rule-based synthesis had no equivalent.
    SuggestBreak,
    /// Next calendar event is close (5-15 min window) — the model decides
    /// whether the rest of the context justifies nudging (e.g. deep focus
    /// on a different task).
    SuggestTaskFollowup,
    /// Clipboard content looks actionable (URL, snippet, code) in a way
    /// the user may want to paste into SUNNY chat or a memory note.
    SuggestClipboardAction,
    /// The pattern of recent activity (screenshots, app switches) looks
    /// note-worthy — propose capturing a quick note/screenshot.
    SuggestCapture,
}

impl IntentTag {
    /// Canonical lowercase-snake string form. Used both in the prompt
    /// vocabulary sent to the model AND as the ambient surface category
    /// tag (so the frontend can route intent-backed compound chips
    /// distinctly from narrow chips and sprint-8 rule-compound chips).
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentTag::SuggestCharge => "suggest_charge",
            IntentTag::SuggestBreak => "suggest_break",
            IntentTag::SuggestTaskFollowup => "suggest_task_followup",
            IntentTag::SuggestClipboardAction => "suggest_clipboard_action",
            IntentTag::SuggestCapture => "suggest_capture",
        }
    }

    /// All supported tags, in the order they appear in the prompt. Kept
    /// as a `const fn`-friendly slice so callers can iterate without
    /// alloc.
    pub fn all() -> &'static [IntentTag] {
        &[
            IntentTag::SuggestCharge,
            IntentTag::SuggestBreak,
            IntentTag::SuggestTaskFollowup,
            IntentTag::SuggestClipboardAction,
            IntentTag::SuggestCapture,
        ]
    }

    /// Parse a tag string emitted by the model. Case-insensitive and
    /// whitespace-tolerant — a 0.5 B model may emit "Suggest_Charge" or
    /// " suggest_charge ".
    pub fn from_str(s: &str) -> Option<Self> {
        let normalised: String = s
            .trim()
            .to_ascii_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        match normalised.as_str() {
            "suggest_charge" => Some(IntentTag::SuggestCharge),
            "suggest_break" => Some(IntentTag::SuggestBreak),
            "suggest_task_followup" => Some(IntentTag::SuggestTaskFollowup),
            "suggest_clipboard_action" => Some(IntentTag::SuggestClipboardAction),
            "suggest_capture" => Some(IntentTag::SuggestCapture),
            _ => None,
        }
    }

    /// Human-readable surface title for the ambient chip. Deliberately
    /// short — the chip is a nudge, not a prose digest.
    pub fn title(&self) -> &'static str {
        match self {
            IntentTag::SuggestCharge => "Consider charging",
            IntentTag::SuggestBreak => "Time for a break?",
            IntentTag::SuggestTaskFollowup => "Task coming up",
            IntentTag::SuggestClipboardAction => "Clipboard ready",
            IntentTag::SuggestCapture => "Capture this?",
        }
    }
}

// ---------------------------------------------------------------------------
// Classifier result
// ---------------------------------------------------------------------------

/// Outcome of one classifier invocation. `None` means the model returned
/// NONE or the confidence was below the threshold — both are suppression
/// conditions from the caller's perspective.
#[derive(Clone, Debug, PartialEq)]
pub enum ClassifierOutcome {
    /// Nothing actionable. Caller suppresses; DOES NOT fall back to the
    /// rule-based compound path — if the classifier ran cleanly and said
    /// "no", we trust it.
    None,
    /// Fire a compound surface for this intent.
    Intent {
        tag: IntentTag,
        confidence: f32,
        rationale: String,
    },
}

// ---------------------------------------------------------------------------
// State digest — pure, testable
// ---------------------------------------------------------------------------

/// Render the relevant world signals into a compact human-readable digest
/// that fits in `DIGEST_MAX_LEN` characters. The 0.5 B classifier is not
/// great at parsing structured JSON — a prose digest with clear key/value
/// pairs reliably outperforms JSON on small models.
///
/// Format: `key=value; key=value; ...` — semicolon-separated, with units
/// embedded in the value so the model doesn't have to infer them.
///
/// Signals included (intentionally conservative — more fields don't help
/// a 0.5 B model and dilute its confidence):
///   * battery pct + charging state
///   * focused-app activity + duration in minutes
///   * next calendar event distance in minutes + title
///   * mail unread count
///   * recent app switches count (proxy for churn)
///   * idle duration when available
pub fn build_digest(world: &WorldState) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(8);

    // Battery: always include both pct and charging because the model
    // keys charge-suggestion decisions on the combination.
    if let Some(pct) = world.battery_pct {
        let charging = world.battery_charging.unwrap_or(true);
        parts.push(format!(
            "battery={}% {}",
            pct.round() as i64,
            if charging { "charging" } else { "discharging" }
        ));
    }

    // Focus / activity. `focused_duration_secs` is the canonical duration
    // sprint-8 compound rules used — keep the same unit basis so the
    // model sees apples-to-apples values if we ever compare paths.
    let mins = world.focused_duration_secs / 60;
    parts.push(format!(
        "activity={} {}min",
        world.activity.as_str(),
        mins
    ));

    // Calendar: surface only if there IS a next event and it's within a
    // reasonable horizon (120 min). Beyond that it's not actionable by a
    // nudge and just burns prompt budget.
    if let Some(ev) = world.next_event.as_ref() {
        if let Some(start_unix) = parse_iso_to_unix(&ev.start) {
            let now = now_secs();
            let secs_until = start_unix - now;
            if (0..120 * 60).contains(&secs_until) {
                let mins_until = (secs_until + 59) / 60;
                // Title may be long + noisy; truncate hard. The model
                // needs the time more than the title.
                let title = truncate_title(&ev.title, 40);
                parts.push(format!("next_event_in={}min ({})", mins_until, title));
            }
        }
    }

    // Mail: optional — None is different from 0 (the collector hasn't
    // reported). Include only when we have a number.
    if let Some(unread) = world.mail_unread {
        parts.push(format!("mail_unread={}", unread));
    }

    // App switches: the raw count in the recent window is a cheap proxy
    // for "churn" that the model can factor into break suggestions.
    let switches = world.recent_switches.len();
    if switches > 0 {
        parts.push(format!("recent_switches={}", switches));
    }

    // Join + enforce the 300-char cap. We DON'T truncate mid-field — if
    // we're over budget we drop trailing fields (calendar/mail/switches
    // before focus/battery) because the earlier fields are the ones the
    // compound rules ever cared about.
    let mut digest = parts.join("; ");
    if digest.len() > DIGEST_MAX_LEN {
        // Drop fields from the end until we fit. Safe because `parts`
        // retains the priority order above.
        while digest.len() > DIGEST_MAX_LEN && !parts.is_empty() {
            parts.pop();
            digest = parts.join("; ");
        }
        // Last-ditch: hard-truncate on a char boundary if a single field
        // exceeds the cap. find_char_boundary walks backward from the
        // cap, so this never splits a multibyte code point.
        if digest.len() > DIGEST_MAX_LEN {
            let cut = floor_char_boundary(&digest, DIGEST_MAX_LEN);
            digest.truncate(cut);
        }
    }
    digest
}

// ---------------------------------------------------------------------------
// Prompt construction — pure, testable
// ---------------------------------------------------------------------------

/// Build the full prompt sent to /api/generate. Kept as a pure function
/// so tests can assert the exact wire text (the prompt IS part of the
/// contract — changing it can shift model behaviour).
///
/// Strict output shape is requested because free-form prose responses
/// from a 0.5 B model on a classification task are ~30 % malformed; JSON
/// lets us parse deterministically and reject anything else as a NONE.
pub fn build_prompt(digest: &str) -> String {
    let tags: Vec<&'static str> = IntentTag::all().iter().map(|t| t.as_str()).collect();
    let vocab = tags.join(", ");
    format!(
        "You observe signals from a desktop assistant. Based on the signals below, \
return EXACTLY ONE of:\n\
- `NONE` (nothing actionable right now)\n\
- A JSON object: {{\"intent_tag\": \"<tag>\", \"confidence\": <0.0-1.0>, \"rationale\": \"<one sentence>\"}}\n\
\n\
Valid intent_tag values: {vocab}\n\
\n\
Rules:\n\
- Output ONLY the word NONE or the JSON object. No prose, no markdown, no code fences.\n\
- Pick NONE aggressively — only fire when a signal is clearly actionable now.\n\
- Confidence below 0.6 will be suppressed; don't guess.\n\
\n\
Signals: {digest}"
    )
}

// ---------------------------------------------------------------------------
// Response parsing — pure, testable
// ---------------------------------------------------------------------------

/// Parse the model's raw text response into a `ClassifierOutcome`.
///
/// Accepts:
///   * The literal string `NONE` (with optional surrounding whitespace,
///     trailing punctuation, markdown fences) → `ClassifierOutcome::None`.
///   * A JSON object with `intent_tag`, `confidence`, `rationale` fields
///     → `ClassifierOutcome::Intent` iff the tag parses AND confidence
///     meets the threshold.
///   * Anything else (malformed JSON, unknown tag, missing fields, or a
///     confidence below `CONFIDENCE_THRESHOLD`) → `ClassifierOutcome::None`.
///     A silent None is safer than a spurious intent surface.
///
/// The parser is forgiving by design — a 0.5 B model occasionally wraps
/// its JSON in ```json fences or prepends "Here is my answer:". We strip
/// those defensively rather than letting valid-enough outputs reject.
pub fn parse_response(raw: &str) -> ClassifierOutcome {
    let cleaned = strip_response_noise(raw);

    if cleaned.trim().eq_ignore_ascii_case("NONE")
        || cleaned.trim().trim_end_matches('.').eq_ignore_ascii_case("NONE")
    {
        return ClassifierOutcome::None;
    }

    // Try to extract a JSON object — the model may still have prepended
    // prose. Find the first `{` and last `}` and parse the slice.
    let Some(json_slice) = extract_json_object(&cleaned) else {
        return ClassifierOutcome::None;
    };

    let Ok(value): Result<Value, _> = serde_json::from_str(json_slice) else {
        return ClassifierOutcome::None;
    };

    let tag_str = match value.get("intent_tag").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return ClassifierOutcome::None,
    };
    let Some(tag) = IntentTag::from_str(tag_str) else {
        return ClassifierOutcome::None;
    };

    // Confidence: accept f64 or integer-encoded f64 (the model sometimes
    // emits `"confidence": 1` instead of `1.0`).
    let confidence: f32 = match value.get("confidence") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) as f32,
        _ => 0.0,
    };
    if !confidence.is_finite() || confidence < CONFIDENCE_THRESHOLD || confidence > 1.0 {
        return ClassifierOutcome::None;
    }

    let rationale = value
        .get("rationale")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    ClassifierOutcome::Intent {
        tag,
        confidence,
        rationale,
    }
}

/// Strip the most common noise patterns a small instruct model wraps
/// around its structured output — markdown code fences, stray "Output:"
/// prefixes, trailing explanation paragraphs.
fn strip_response_noise(raw: &str) -> String {
    let mut s = raw.trim().to_string();

    // Remove code fences — ```json ... ``` or plain ``` ... ```.
    if s.starts_with("```") {
        if let Some(first_nl) = s.find('\n') {
            s = s[first_nl + 1..].to_string();
        }
        if let Some(fence_idx) = s.rfind("```") {
            s.truncate(fence_idx);
        }
        s = s.trim().to_string();
    }

    // Drop a leading "Output:" / "Response:" / "Answer:" label.
    for prefix in ["Output:", "Response:", "Answer:", "output:", "response:", "answer:"]
    {
        if let Some(stripped) = s.strip_prefix(prefix) {
            s = stripped.trim().to_string();
            break;
        }
    }

    s
}

/// Find the first balanced `{...}` span in `s` and return it as a slice.
/// Handles one level of JSON string escape so `"}"` inside a rationale
/// doesn't prematurely close the object.
fn extract_json_object(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0u32;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes[start..].iter().enumerate() {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=start + i]);
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Ollama call — the I/O shell
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GenerateResponse {
    #[serde(default)]
    response: String,
}

/// Hit Ollama's /api/generate with the classifier prompt. Returns a
/// parsed outcome or an error. Errors are the caller's signal to run the
/// rule-based fallback path.
///
/// This function owns the 2 s timeout — the caller does NOT need to wrap
/// us in another timer. Uses `http::client()` so we share the shared
/// connection pool / tracing config with the rest of the app.
pub async fn classify(model: &str, digest: &str) -> Result<ClassifierOutcome, String> {
    let prompt = build_prompt(digest);
    let body = json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        // Keep a tiny keep-alive: we run at most once per 60 s, and a
        // 0.5 B model reloads in ~1 s anyway — holding it in VRAM longer
        // would steal memory from the main chat model the user actually
        // cares about.
        "keep_alive": "5m",
        // Deterministic-leaning sampling. Classification isn't creative
        // writing; the model should converge on the same tag for the
        // same digest across ticks.
        "options": {
            "temperature": 0.1,
            "num_predict": 120,
        }
    });

    let client = crate::http::client();
    let req = client.post(OLLAMA_GENERATE_URL).json(&body);
    let resp = tokio::time::timeout(
        Duration::from_secs(CLASSIFIER_TIMEOUT_SECS),
        crate::http::send(req),
    )
    .await
    .map_err(|_| "classifier timed out".to_string())?
    .map_err(|e| format!("classifier connect: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("classifier http {}", resp.status()));
    }

    let parsed: GenerateResponse = resp
        .json()
        .await
        .map_err(|e| format!("classifier decode: {e}"))?;

    Ok(parse_response(&parsed.response))
}

// ---------------------------------------------------------------------------
// Helpers (local — kept private so the public surface stays tiny)
// ---------------------------------------------------------------------------

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_iso_to_unix(iso: &str) -> Option<i64> {
    use chrono::TimeZone;
    let naive = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S").ok())?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp())
}

fn truncate_title(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut = floor_char_boundary(s, max);
    format!("{}…", &s[..cut])
}

/// Return the largest index ≤ `idx` that falls on a UTF-8 char boundary.
/// Stable alternative to the nightly-only `str::floor_char_boundary`.
fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let upper = idx.min(s.len());
    let mut i = upper;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// ---------------------------------------------------------------------------
// Tests — pure pipeline coverage. No Ollama, no network.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::CalendarEvent;

    fn base_world() -> WorldState {
        WorldState::default()
    }

    #[test]
    fn intent_tag_roundtrip_is_stable() {
        for tag in IntentTag::all() {
            let s = tag.as_str();
            assert_eq!(IntentTag::from_str(s), Some(*tag));
        }
    }

    #[test]
    fn intent_tag_from_str_tolerates_whitespace_and_case() {
        assert_eq!(
            IntentTag::from_str(" Suggest_Charge "),
            Some(IntentTag::SuggestCharge)
        );
        assert_eq!(
            IntentTag::from_str("SUGGEST_BREAK"),
            Some(IntentTag::SuggestBreak)
        );
        assert_eq!(IntentTag::from_str("unknown"), None);
        assert_eq!(IntentTag::from_str(""), None);
    }

    #[test]
    fn build_digest_basic_battery_focus() {
        let mut w = base_world();
        w.battery_pct = Some(42.0);
        w.battery_charging = Some(false);
        w.focused_duration_secs = 30 * 60;
        let d = build_digest(&w);
        assert!(d.contains("battery=42%"));
        assert!(d.contains("discharging"));
        assert!(d.contains("activity=unknown 30min"));
    }

    #[test]
    fn build_digest_includes_calendar_when_in_window() {
        let mut w = base_world();
        let start = chrono::Local::now() + chrono::Duration::minutes(10);
        w.next_event = Some(CalendarEvent {
            id: "evt-1".into(),
            title: "Standup".into(),
            start: start.format("%Y-%m-%dT%H:%M:%S").to_string(),
            end: start.format("%Y-%m-%dT%H:%M:%S").to_string(),
            location: "".into(),
            notes: "".into(),
            calendar: "Home".into(),
            all_day: false,
        });
        let d = build_digest(&w);
        assert!(d.contains("next_event_in="));
        assert!(d.contains("Standup"));
    }

    #[test]
    fn build_digest_respects_max_length() {
        // Round-trip through JSON with the wire shape so we don't need
        // direct access to the crate-private `world::model::AppSwitch`.
        let mut switches_json = String::from("[");
        for i in 0..50 {
            if i > 0 {
                switches_json.push(',');
            }
            switches_json.push_str(&format!(
                "{{\"from_app\":\"App{}\",\"to_app\":\"App{}\",\"at_secs\":0}}",
                i,
                i + 1
            ));
        }
        switches_json.push(']');

        let world_json = format!(
            r#"{{
                "schema_version": 1,
                "timestamp_ms": 0,
                "local_iso": "",
                "host": "",
                "os_version": "",
                "focus": null,
                "focused_duration_secs": 3600,
                "activity": "writing",
                "recent_switches": {switches_json},
                "next_event": null,
                "events_today": 0,
                "mail_unread": 99999999,
                "cpu_pct": 0.0,
                "temp_c": 0.0,
                "mem_pct": 0.0,
                "battery_pct": 88.0,
                "battery_charging": true,
                "revision": 0
            }}"#
        );
        let w: WorldState =
            serde_json::from_str(&world_json).expect("world state fixture must parse");
        let d = build_digest(&w);
        assert!(
            d.len() <= DIGEST_MAX_LEN,
            "digest exceeded cap: {} chars — {}",
            d.len(),
            d
        );
    }

    #[test]
    fn build_prompt_includes_all_intent_tags() {
        let p = build_prompt("battery=10% discharging");
        for tag in IntentTag::all() {
            assert!(
                p.contains(tag.as_str()),
                "prompt missing tag {}: {}",
                tag.as_str(),
                p
            );
        }
        assert!(p.contains("battery=10% discharging"));
        assert!(p.contains("NONE"));
    }

    #[test]
    fn parse_response_none_literal() {
        assert_eq!(parse_response("NONE"), ClassifierOutcome::None);
        assert_eq!(parse_response("  NONE  "), ClassifierOutcome::None);
        assert_eq!(parse_response("none."), ClassifierOutcome::None);
    }

    #[test]
    fn parse_response_valid_intent_above_threshold() {
        let raw = r#"{"intent_tag": "suggest_charge", "confidence": 0.82, "rationale": "Battery low while discharging on a meeting day"}"#;
        match parse_response(raw) {
            ClassifierOutcome::Intent {
                tag,
                confidence,
                rationale,
            } => {
                assert_eq!(tag, IntentTag::SuggestCharge);
                assert!((confidence - 0.82).abs() < 1e-3);
                assert!(rationale.contains("discharging"));
            }
            other => panic!("expected Intent, got {:?}", other),
        }
    }

    #[test]
    fn parse_response_below_threshold_is_none() {
        let raw = r#"{"intent_tag": "suggest_break", "confidence": 0.42, "rationale": "weak"}"#;
        assert_eq!(parse_response(raw), ClassifierOutcome::None);
    }

    #[test]
    fn parse_response_unknown_tag_is_none() {
        let raw = r#"{"intent_tag": "suggest_magic", "confidence": 0.9, "rationale": "meh"}"#;
        assert_eq!(parse_response(raw), ClassifierOutcome::None);
    }

    #[test]
    fn parse_response_malformed_json_is_none() {
        assert_eq!(parse_response("not json at all"), ClassifierOutcome::None);
        assert_eq!(parse_response("{intent_tag: broken}"), ClassifierOutcome::None);
        assert_eq!(parse_response(""), ClassifierOutcome::None);
    }

    #[test]
    fn parse_response_strips_code_fences() {
        let raw = "```json\n{\"intent_tag\": \"suggest_capture\", \"confidence\": 0.75, \"rationale\": \"screenshot-heavy\"}\n```";
        match parse_response(raw) {
            ClassifierOutcome::Intent { tag, .. } => {
                assert_eq!(tag, IntentTag::SuggestCapture);
            }
            other => panic!("expected Intent, got {:?}", other),
        }
    }

    #[test]
    fn parse_response_tolerates_output_label_and_trailing_prose() {
        let raw = "Output: {\"intent_tag\": \"suggest_task_followup\", \"confidence\": 0.91, \"rationale\": \"Meeting in 6 min\"}\n\nReason: model thinks it's useful.";
        match parse_response(raw) {
            ClassifierOutcome::Intent { tag, confidence, .. } => {
                assert_eq!(tag, IntentTag::SuggestTaskFollowup);
                assert!(confidence > 0.9);
            }
            other => panic!("expected Intent, got {:?}", other),
        }
    }

    #[test]
    fn parse_response_confidence_out_of_range_is_none() {
        let raw_neg =
            r#"{"intent_tag": "suggest_charge", "confidence": -0.5, "rationale": ""}"#;
        let raw_over =
            r#"{"intent_tag": "suggest_charge", "confidence": 1.5, "rationale": ""}"#;
        assert_eq!(parse_response(raw_neg), ClassifierOutcome::None);
        assert_eq!(parse_response(raw_over), ClassifierOutcome::None);
    }

    #[test]
    fn extract_json_object_handles_string_braces() {
        // A rationale containing `}` must not prematurely close the JSON.
        let raw = r#"Reasoning: {"intent_tag": "suggest_charge", "confidence": 0.8, "rationale": "she said }) oops"}"#;
        let slice = extract_json_object(raw).expect("should find object");
        let parsed: Value = serde_json::from_str(slice).expect("valid json slice");
        assert_eq!(parsed["intent_tag"], "suggest_charge");
    }

    #[test]
    fn floor_char_boundary_never_splits_utf8() {
        let s = "battery=42%; activity=writing 15min; title=café résumé";
        let cut = floor_char_boundary(s, 30);
        // Must be a valid boundary — indexing should succeed.
        let _ = &s[..cut];
        assert!(cut <= 30);
    }
}
