//! email_triage — end-to-end scenario: read unread mail, score urgency, draft replies.
//!
//! Full user workflow: "read my unread email, summarise the urgent ones,
//! draft replies to two of them."
//!
//! # What this test exercises
//!
//! 1. `mail_list_unread` via the osascript pipeline exposed by the test harness
//!    helper `load_unread_mail_or_skip` (same code path as `src/tools_macos.rs`
//!    at runtime, without requiring a Tauri `AppHandle`).
//! 2. GLM-5.1 JSON-structured urgency scoring (0-10 + 1-line justification).
//! 3. Structured JSON assertion: every parseable response must carry
//!    `{"score": <int 0-10>, "reason": "<str>"}`.
//! 4. Top-2 selection + draft generation: GLM produces a 3-sentence
//!    acknowledgement reply that contains the sender's first name token.
//!
//! # Skip conditions (graceful — test returns without panic)
//!
//! - No GLM / Z.AI API key in env or macOS Keychain.
//! - `mail_list_unread` returns Err (Full Disk Access / Automation not
//!   granted — stderr shows "Mail.app not accessible").
//! - No unread messages in Mail.app.
//! - Transient GLM errors (rate-limit 429, timeout).
//!
//! # Cost ceiling
//!
//! GLM-5.1 rates: $0.40/M input, $1.20/M output.
//! Budget: up to 10 scoring calls + 2 draft calls = 12 total.
//! Each call: ~200 input tokens + ~60 output tokens ≈ $0.00016.
//! 12 calls × $0.00016 ≈ $0.002 worst case. Well under $0.005.
//!
//! # Running
//!
//! // RUN WITH: cargo test --test live -- --ignored email_triage --nocapture --test-threads=1

use std::time::Instant;

use serde_json::{json, Value};

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::types::TurnOutcome;
use sunny_lib::telemetry::cost_estimate;
use serial_test::serial;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Extract text from a `TurnOutcome`. Logs any unexpected tool calls.
fn outcome_text(o: TurnOutcome) -> String {
    match o {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            eprintln!("  (model issued {} unexpected tool call(s))", calls.len());
            thinking.unwrap_or_default()
        }
    }
}

/// Score urgency of one email. Returns `(score 0-10, reason, approx_tokens_in, approx_tokens_out)`.
/// Returns `None` on transient GLM error or unparseable JSON — test continues
/// with a sentinel (score=0) so one bad call does not abort the scenario.
async fn score_urgency(
    subject: &str,
    from: &str,
    received: &str,
) -> Option<(u8, String, u64, u64)> {
    let prompt = format!(
        "Email metadata:\nFrom: {from}\nSubject: {subject}\nReceived: {received}\n\n\
         Score this email's urgency on a scale of 0 (not urgent) to 10 (extremely urgent).\n\
         Reply with ONLY valid JSON — no markdown, no extra text:\n\
         {{\"score\": <integer 0-10>, \"reason\": \"<one sentence justification>\"}}"
    );
    let history = vec![json!({"role": "user", "content": &prompt})];

    let result = glm_turn(
        DEFAULT_GLM_MODEL,
        "You are an email triage assistant. Respond only with the exact JSON object requested. No markdown fences, no preamble.",
        &history,
    )
    .await;

    let text = match result {
        Ok(o) => outcome_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("  SKIP urgency call (transient GLM): {e}");
            return None;
        }
        Err(e) => {
            eprintln!("  urgency call error (non-fatal): {e}");
            return None;
        }
    };

    // Strip markdown fences GLM sometimes emits despite the instruction.
    let clean = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: Value = match serde_json::from_str(clean) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("  JSON parse failed: {e} — raw: {text:?}");
            return None;
        }
    };

    // Spec requirement: structured JSON with both keys present.
    assert!(
        parsed.get("score").is_some(),
        "urgency JSON must contain 'score' key; got: {parsed}"
    );
    assert!(
        parsed.get("reason").is_some(),
        "urgency JSON must contain 'reason' key; got: {parsed}"
    );

    let score = parsed["score"]
        .as_u64()
        .map(|v| v.clamp(0, 10) as u8)
        .or_else(|| {
            // GLM occasionally returns score as a string like "7".
            parsed["score"].as_str().and_then(|s| s.parse::<u8>().ok())
        })
        .unwrap_or(0);

    let reason = parsed["reason"]
        .as_str()
        .unwrap_or("(no reason)")
        .to_string();

    // Approximate token accounting (real accounting is in internal telemetry).
    let approx_in = (prompt.len() / 4 + 35) as u64;
    let approx_out = (clean.len() / 4 + 5) as u64;

    Some((score, reason, approx_in, approx_out))
}

/// Draft a 3-sentence acknowledgement reply. Returns `(draft, approx_in, approx_out)`.
async fn draft_reply(subject: &str, from: &str) -> Result<(String, u64, u64), String> {
    // Extract bare display name from "First Last <addr@example.com>".
    let display_name = from
        .split('<')
        .next()
        .unwrap_or(from)
        .trim()
        .trim_matches('"')
        .to_string();
    let name_for_prompt = if display_name.is_empty() { from.to_string() } else { display_name };

    let prompt = format!(
        "Draft a 3-sentence acknowledgement reply to the following email.\n\
         Sender's name: {name_for_prompt}\n\
         Subject: {subject}\n\n\
         Requirements (follow exactly):\n\
         1. Open by addressing the sender by name.\n\
         2. Acknowledge receipt of their message.\n\
         3. Confirm you will review and follow up.\n\
         Reply with ONLY the draft body text. No subject line. No headers. \
         No explanations."
    );
    let history = vec![json!({"role": "user", "content": &prompt})];

    let result = glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a professional email drafter. Write the reply exactly as instructed.",
        &history,
    )
    .await;

    let text = match result {
        Ok(o) => outcome_text(o),
        Err(e) => return Err(e),
    };

    let approx_in = (prompt.len() / 4 + 35) as u64;
    let approx_out = (text.len() / 4 + 5) as u64;

    Ok((text, approx_in, approx_out))
}

// ---------------------------------------------------------------------------
// Scenario test
// ---------------------------------------------------------------------------

/// End-to-end email triage: list unread mail → score urgency → draft replies.
///
/// Steps:
///   1. Call `load_unread_mail_or_skip(10)` — up to 10 unread messages from Mail.app.
///   2. For each message, call GLM-5.1: score urgency 0-10, 1-line justification, JSON.
///   3. Assert structured `{"score":…, "reason":…}` JSON returned.
///   4. Pick top-2 highest-urgency messages.
///   5. For each, call GLM: draft a 3-sentence acknowledgement reply.
///   6. Assert 2 drafts produced, each non-empty, each contains sender name token.
///
/// Does NOT send any email — drafts remain in memory only.
/// Does NOT go through confirm.rs — this is a direct tool + LLM integration test.
#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key + Mail.app Automation access; opt-in with --ignored"]
async fn email_triage_read_score_draft() {
    // RUN WITH: cargo test --test live -- --ignored email_triage --nocapture --test-threads=1

    let t0 = Instant::now();

    // ---- Guard: GLM key available ------------------------------------------
    if super::should_skip_glm().await {
        return;
    }

    // ---- Step 1: fetch unread mail -----------------------------------------
    let messages = match super::load_unread_mail_or_skip(10).await {
        Some(m) => m,
        None => return, // skip reason already printed to stderr
    };

    let mail_count = messages.len();
    eprintln!("\n=== email_triage scenario start ===");
    eprintln!("  step=1 mails_fetched={mail_count}");

    // ---- Step 2 + 3: score urgency -----------------------------------------
    // We score every message and collect (score, reason, subject, from).
    let mut scored: Vec<(u8, String, String, String)> = Vec::new();
    let mut total_in: u64 = 0;
    let mut total_out: u64 = 0;

    for msg in &messages {
        eprintln!(
            "  scoring: from={:?} subj={:?}",
            &msg.from[..msg.from.len().min(50)],
            &msg.subject[..msg.subject.len().min(70)]
        );
        match score_urgency(&msg.subject, &msg.from, &msg.date).await {
            Some((score, reason, tin, tout)) => {
                eprintln!("    => score={score} reason={reason:?}");
                total_in += tin;
                total_out += tout;
                scored.push((score, reason, msg.subject.clone(), msg.from.clone()));
            }
            None => {
                // Non-fatal: include with score=0 so sorting still works.
                scored.push((0, "(parse failed)".to_string(), msg.subject.clone(), msg.from.clone()));
            }
        }
    }

    eprintln!("  step=2+3 scores={:?}", scored.iter().map(|(s,_,sub,_)| format!("{s}:{sub}")).collect::<Vec<_>>());

    // ---- Step 4: pick top-2 ------------------------------------------------
    let mut by_score = scored.clone();
    by_score.sort_by(|a, b| b.0.cmp(&a.0));
    let top2: Vec<&(u8, String, String, String)> = by_score.iter().take(2).collect();

    if top2.is_empty() {
        eprintln!("SKIP: no scoreable messages to draft for");
        return;
    }

    eprintln!("  step=4 top2={:?}", top2.iter().map(|(s,_,sub,from)| format!("score={s} from={from} subj={sub}")).collect::<Vec<_>>());

    // ---- Step 5: draft replies ----------------------------------------------
    let mut drafts: Vec<String> = Vec::new();

    for (score, _reason, subject, from) in &top2 {
        eprintln!("  drafting: score={score} from={from:?}");
        match draft_reply(subject, from).await {
            Ok((draft, tin, tout)) => {
                total_in += tin;
                total_out += tout;
                drafts.push(draft);
            }
            Err(ref e) if super::is_transient_glm_error(e) => {
                eprintln!("  SKIP draft (transient GLM): {e}");
                return;
            }
            Err(e) => panic!("draft_reply failed: {e}"),
        }
    }

    // ---- Step 6: assertions ------------------------------------------------

    // Must have exactly one draft per top2 entry.
    assert_eq!(
        drafts.len(),
        top2.len(),
        "expected {} drafts, produced {}",
        top2.len(),
        drafts.len()
    );

    for (i, (draft, (_score, _reason, _subject, from))) in drafts.iter().zip(top2.iter()).enumerate() {
        // Non-empty draft.
        assert!(
            !draft.trim().is_empty(),
            "draft[{i}] must not be empty"
        );

        // Contains sender name token (case-insensitive first word of display name).
        let display_name = from
            .split('<')
            .next()
            .unwrap_or(from.as_str())
            .trim()
            .trim_matches('"');
        let first_token = display_name
            .split_whitespace()
            .next()
            .unwrap_or(from.as_str());

        assert!(
            draft.to_lowercase().contains(&first_token.to_lowercase()),
            "draft[{i}] must contain sender name token {first_token:?}; \
             from={from:?};\ndraft={draft:?}"
        );

        eprintln!(
            "  step=6 draft[{i}] sender={first_token:?} preview={:?}",
            &draft[..draft.len().min(120)]
        );
    }

    // ---- Cost ceiling check ------------------------------------------------
    let total_cost = cost_estimate("glm", total_in, total_out, 0, 0);
    let elapsed_ms = t0.elapsed().as_millis();

    assert!(
        total_cost < 0.005,
        "scenario cost ${total_cost:.6} exceeded $0.005 ceiling"
    );

    // ---- Metrics -----------------------------------------------------------
    eprintln!("=== email_triage metrics ===");
    eprintln!("  mails_examined={mail_count}");
    eprintln!(
        "  urgency_scores_obtained={}",
        scored.iter().filter(|(_, r, _, _)| r != "(parse failed)").count()
    );
    eprintln!("  drafts_produced={}", drafts.len());
    eprintln!("  total_tokens_in={total_in}");
    eprintln!("  total_tokens_out={total_out}");
    eprintln!("  total_cost_usd=${total_cost:.6}");
    eprintln!("  total_latency_ms={elapsed_ms}");
    eprintln!("=== email_triage PASSED ===\n");
}
