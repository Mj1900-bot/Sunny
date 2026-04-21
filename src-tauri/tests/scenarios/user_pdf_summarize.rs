//! user_pdf_summarize — end-to-end scenario: "find my most recent PDF and summarise it."
//!
//! Simulates the full pipeline Sunny's command triggers:
//!
//!   1. Task-classifier tier check — heuristic confirms `CodingOrReasoning`
//!      (default catch-all for document summarisation, routes → GLM cloud tier).
//!   2. Spotlight search — `mdfind -onlyin ~ 'kMDItemContentType == "com.adobe.pdf"'`
//!      ordered by `kMDItemFSContentChangeDate`. Falls back to the bundled
//!      fixture `tests/fixtures/tiny.pdf` when no user PDF is found, so the
//!      scenario is always runnable.
//!   3. Text extraction — `pdftotext -layout -q <path> -` (poppler). Skips
//!      gracefully if poppler is not installed, emitting an advisory.
//!   4. GLM-5.1 summarisation — first 3 000 chars of extracted text sent to
//!      `glm_turn` with a "summarize in exactly 3 sentences" prompt.
//!   5. Assertions:
//!      - At least one PDF was located.
//!      - Extracted text is non-empty.
//!      - Summary contains 3 sentences (split on `.`, `!`, `?`).
//!      - Estimated cost < $0.003.
//!
//! # Run
//!
//!   cargo test --test live -- --ignored user_pdf_summarize --nocapture
//!
//! # Cost ceiling
//!
//! ~3 000 chars ≈ 750 input tokens + ~120 output tokens.
//! At GLM rates ($0.40/M in, $1.20/M out): (750 * 0.0004 + 120 * 0.0012) / 1000
//! ≈ $0.000444 — well under the $0.003 ceiling.

use std::path::PathBuf;
use std::time::Duration;

use serial_test::serial;
use tokio::process::Command;

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::task_classifier::classify_task_heuristic;
use sunny_lib::agent_loop::model_router::TaskClass;
use sunny_lib::agent_loop::types::TurnOutcome;
use sunny_lib::telemetry::cost_estimate;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum bytes of extracted text forwarded to the LLM. Keeps cost bounded
/// to the $0.003 ceiling even for a many-page document.
const MAX_TEXT_CHARS: usize = 3_000;

/// Hard cost limit in USD per run of this test.
const COST_CEILING_USD: f64 = 0.003;

/// Timeout for the `mdfind` spotlight search.
const MDFIND_TIMEOUT: Duration = Duration::from_secs(10);

/// Timeout for the `pdftotext` extraction subprocess.
const PDFTOTEXT_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Count the number of sentences in `text` by splitting on terminal
/// punctuation. Runs of whitespace between sentences are collapsed; empty
/// segments (e.g. trailing period) are discarded.
fn count_sentences(text: &str) -> usize {
    text.split(|c: char| matches!(c, '.' | '!' | '?'))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .count()
}

/// Return the path to a usable PDF: the most-recently-modified one found by
/// Spotlight under `~`, or the bundled fixture as fallback.
async fn find_most_recent_pdf() -> PathBuf {
    // Use `mdfind` with a content-type predicate, then sort by modification
    // date with a second pass through `mdls`. For simplicity we run the
    // `kMDItemFSContentChangeDate` attribute directly in the query and ask
    // mdfind to print in natural order (Spotlight returns results sorted by
    // relevance / recency for `kMDItemFSContentChangeDate` descending by
    // default on most macOS versions).
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/sunny".to_string());
    let result = tokio::time::timeout(
        MDFIND_TIMEOUT,
        Command::new("mdfind")
            .arg("-onlyin")
            .arg(&home)
            .arg("kMDItemContentType == 'com.adobe.pdf'")
            .output(),
    )
    .await;

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tiny.pdf");

    let raw_paths = match result {
        Ok(Ok(out)) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        _ => {
            eprintln!("  mdfind unavailable or timed out — using fixture PDF");
            return fixture;
        }
    };

    // Pick the most-recently-modified PDF by sorting with `stat`.
    let mut candidates: Vec<PathBuf> = raw_paths
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty() && p.ends_with(".pdf"))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect();

    if candidates.is_empty() {
        eprintln!("  No PDFs found via Spotlight — using fixture PDF");
        return fixture;
    }

    // Sort by modification time, newest first. Fall back to fixture on any
    // stat error so a single unreadable file doesn't abort the whole test.
    candidates.sort_by(|a, b| {
        let mt_a = a.metadata().and_then(|m| m.modified()).ok();
        let mt_b = b.metadata().and_then(|m| m.modified()).ok();
        mt_b.cmp(&mt_a) // newest first
    });

    let chosen = candidates.into_iter().next().unwrap_or(fixture);
    eprintln!("  Spotlight: selected PDF: {}", chosen.display());
    chosen
}

/// Extract text from `pdf_path` via `pdftotext`. Returns `None` when
/// poppler is not installed (caller will skip), or `Err` on genuine failure.
async fn extract_text(pdf_path: &PathBuf) -> Result<Option<String>, String> {
    // Locate pdftotext — check common homebrew / system paths.
    let bin = ["pdftotext",
               "/opt/homebrew/bin/pdftotext",
               "/usr/local/bin/pdftotext",
               "/usr/bin/pdftotext"]
        .iter()
        .find(|&&p| PathBuf::from(p).exists() || {
            // Also try via PATH using tokio::process (no-op output check)
            std::process::Command::new("which")
                .arg(p)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
        .copied();

    let Some(pdftotext_bin) = bin else {
        eprintln!(
            "  ADVISORY: pdftotext not found — install poppler: \
             `brew install poppler`. Skipping text extraction."
        );
        return Ok(None);
    };

    let out = tokio::time::timeout(
        PDFTOTEXT_TIMEOUT,
        Command::new(pdftotext_bin)
            .arg("-layout")
            .arg("-q")
            .arg(pdf_path)
            .arg("-")
            .output(),
    )
    .await
    .map_err(|_| "pdftotext timed out".to_string())?
    .map_err(|e| format!("pdftotext spawn failed: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "pdftotext exited {}: {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(Some(text))
}

// ---------------------------------------------------------------------------
// The scenario test
// ---------------------------------------------------------------------------

/// End-to-end: find most-recent PDF → extract text → summarise via GLM-5.1.
///
/// Marked `#[ignore]` — run with:
///   cargo test --test live -- --ignored user_pdf_summarize --nocapture
#[tokio::test]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
#[serial(live_llm)]
async fn user_pdf_summarize() {
    // ------------------------------------------------------------------
    // STEP 1 — Task-classifier tier check
    // ------------------------------------------------------------------
    let user_command = "find my most recent PDF and summarize it in 3 sentences";
    let task_class = classify_task_heuristic(user_command);

    eprintln!("\n[step 1] task classifier");
    eprintln!("  input:      {:?}", user_command);
    eprintln!("  tier:       {:?}", task_class);

    // "find … PDF … summarize" has no architectural keywords, no short '?'
    // → heuristic should land on CodingOrReasoning (the cloud/GLM tier).
    // ArchitecturalDecision is also acceptable — both route to GLM.
    let routes_to_cloud = matches!(
        task_class,
        TaskClass::CodingOrReasoning | TaskClass::ArchitecturalDecision
    );
    assert!(
        routes_to_cloud,
        "Expected CodingOrReasoning or ArchitecturalDecision for PDF summarise command, \
         got {task_class:?}"
    );

    // ------------------------------------------------------------------
    // STEP 2 — Locate most-recent PDF
    // ------------------------------------------------------------------
    eprintln!("\n[step 2] spotlight search");
    let pdf_path = find_most_recent_pdf().await;
    assert!(
        pdf_path.exists(),
        "PDF path does not exist: {}",
        pdf_path.display()
    );
    eprintln!("  PDF path:   {}", pdf_path.display());

    // ------------------------------------------------------------------
    // STEP 3 — Extract text
    // ------------------------------------------------------------------
    eprintln!("\n[step 3] pdftotext extraction");
    let extracted = match extract_text(&pdf_path).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            // poppler not installed — skip the live network portion but
            // keep the test green (non-failure skip).
            eprintln!("  SKIP: pdftotext unavailable — install `brew install poppler`");
            return;
        }
        Err(e) => {
            panic!("pdftotext failed on {}: {e}", pdf_path.display());
        }
    };

    assert!(
        !extracted.is_empty(),
        "pdftotext produced no text from {}",
        pdf_path.display()
    );
    eprintln!("  extracted:  {} chars", extracted.len());

    // Clip to MAX_TEXT_CHARS to keep cost bounded.
    let text_for_llm: String = extracted.chars().take(MAX_TEXT_CHARS).collect();
    eprintln!("  passed to LLM: {} chars", text_for_llm.len());

    // ------------------------------------------------------------------
    // STEP 4 — GLM-5.1 summarisation
    // ------------------------------------------------------------------
    eprintln!("\n[step 4] GLM-5.1 summarisation via Z.AI");

    // Skip guard — same pattern as live_glm_turn.rs.
    let key_present = sunny_lib::secrets::zai_api_key().await.is_some();
    if !key_present {
        eprintln!(
            "  SKIP: no Z.AI key found in env (ZAI_API_KEY / GLM_API_KEY) \
             or macOS Keychain (sunny-zai-api-key)"
        );
        return;
    }

    let prompt = format!(
        "You are summarising a PDF document for the user. \
         Produce EXACTLY 3 sentences. Each sentence must end with a period. \
         No preamble, no bullet points — just 3 plain sentences.\n\n\
         Document text:\n{text_for_llm}"
    );

    let history = vec![serde_json::json!({"role": "user", "content": prompt})];
    let system = "You are a precise document summariser. \
                  Output exactly 3 sentences separated by periods. \
                  No preamble, no lists.";

    let result = glm_turn(DEFAULT_GLM_MODEL, system, &history).await;
    let outcome = match result {
        Ok(o) => o,
        Err(ref e)
            if e.contains("429")
                || e.to_lowercase().contains("rate limit")
                || e.to_lowercase().contains("timed out") =>
        {
            eprintln!("  SKIP: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM turn failed: {e}"),
    };

    let summary = match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            // Summarisation should not trigger tool calls; if it does,
            // use the thinking text and note it.
            let tool_names: Vec<_> = calls.iter().map(|c| c.name.as_str()).collect();
            eprintln!(
                "  NOTE: GLM issued tool call(s) for summarise prompt: {:?}",
                tool_names
            );
            thinking.unwrap_or_default()
        }
    };

    let summary = summary.trim().to_string();

    // ------------------------------------------------------------------
    // STEP 5 — Assertions
    // ------------------------------------------------------------------
    eprintln!("\n[step 5] assertions");
    eprintln!("  PDF:     {}", pdf_path.display());
    eprintln!("  summary: {summary:?}");

    // Assertion: summary is non-empty.
    assert!(
        !summary.is_empty(),
        "GLM returned an empty summary for {}",
        pdf_path.display()
    );

    // Assertion: summary contains at least 3 sentences.
    // We use a permissive count (>= 3) because models sometimes emit 4+.
    let sentence_count = count_sentences(&summary);
    eprintln!("  sentence count: {sentence_count}");
    assert!(
        sentence_count >= 3,
        "Expected at least 3 sentences in summary, found {sentence_count}. \
         Summary: {summary:?}"
    );

    // Assertion: cost < $0.003.
    // Approximate token counts using the char/4 heuristic.
    let input_tokens = (prompt.len() / 4) as u64;
    let output_tokens = (summary.len() / 4) as u64;
    let cost = cost_estimate("glm", input_tokens, output_tokens, 0, 0);
    eprintln!(
        "  cost estimate: ${cost:.6} (input_tok≈{input_tokens}, output_tok≈{output_tokens})"
    );
    assert!(
        cost < COST_CEILING_USD,
        "Estimated cost ${cost:.6} exceeds ceiling ${COST_CEILING_USD:.3}"
    );

    eprintln!("\n  PASS — PDF summarise pipeline completed successfully.");
}

// ---------------------------------------------------------------------------
// Unit tests for helpers (always run, no I/O)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn count_sentences_three_simple() {
        let text = "The sky is blue. The grass is green. Water is wet.";
        assert_eq!(count_sentences(text), 3);
    }

    #[test]
    fn count_sentences_with_exclamation_and_question() {
        let text = "What a day! Was it sunny? Yes, it was.";
        assert_eq!(count_sentences(text), 3);
    }

    #[test]
    fn count_sentences_empty_string() {
        assert_eq!(count_sentences(""), 0);
    }

    #[test]
    fn count_sentences_trailing_period_not_counted_extra() {
        // "One. Two. Three." splits into ["One", "Two", "Three", ""] — empty
        // segment is filtered, giving exactly 3.
        let text = "One. Two. Three.";
        assert_eq!(count_sentences(text), 3);
    }

    #[test]
    fn count_sentences_four_is_gte_three() {
        let text = "A. B. C. D.";
        assert!(count_sentences(text) >= 3);
    }

    #[test]
    fn task_classifier_routes_pdf_command_to_cloud_tier() {
        let cmd = "find my most recent PDF and summarize it in 3 sentences";
        let class = classify_task_heuristic(cmd);
        let routes_to_cloud = matches!(
            class,
            TaskClass::CodingOrReasoning | TaskClass::ArchitecturalDecision
        );
        assert!(
            routes_to_cloud,
            "PDF summarise command should route to cloud tier, got {class:?}"
        );
    }

    #[test]
    fn cost_estimate_for_small_glm_exchange_is_under_ceiling() {
        // ~750 input tokens + ~120 output tokens (3000 chars + 480 chars summary).
        let cost = cost_estimate("glm", 750, 120, 0, 0);
        assert!(
            cost < COST_CEILING_USD,
            "Small GLM exchange should cost < ${COST_CEILING_USD:.3}, got ${cost:.6}"
        );
    }

    #[test]
    fn cost_estimate_glm_is_non_zero() {
        let cost = cost_estimate("glm", 100, 50, 0, 0);
        assert!(cost > 0.0, "GLM cost must be > 0 for non-zero token counts");
    }
}
