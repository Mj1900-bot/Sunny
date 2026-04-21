//! debug_failing_test — E2E scenario: "here's a failing Rust test, diagnose it and propose a fix"
//!
//! Three deliberate bug fixtures are embedded as raw strings:
//!   Bug A — wrong operator (`a - b` instead of `a + b`)
//!   Bug B — off-by-one (`a + b - 1` instead of `a + b`)
//!   Bug C — wrong return type cast (integer division that truncates)
//!
//! Each sub-test:
//!   1. Builds a prompt that includes the fixture code
//!   2. Calls GLM-5.1 via `glm_turn`
//!   3. Asserts the response identifies the specific bug (forgiving phrasing)
//!   4. Asserts the response proposes the correct fix
//!
//! Run:
//!   cargo test --test live -- --ignored debug_failing_test --nocapture
//!
//! Cost: ~3 short prompts × ~150 tokens each ≈ 450 tokens → < $0.001 at GLM rates.

use sunny_lib::agent_loop::providers::glm::{glm_turn, DEFAULT_GLM_MODEL};
use sunny_lib::agent_loop::types::TurnOutcome;
use serial_test::serial;

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

/// Bug A: wrong operator — `a - b` should be `a + b`.
/// Test expects add(2,3) == 5 but gets 2-3 = -1.
const FIXTURE_A: &str = r#"
fn add(a: i32, b: i32) -> i32 {
    a - b
}

#[test]
fn test_add() {
    assert_eq!(add(2, 3), 5);
}
"#;

/// Bug B: off-by-one — result is `a + b - 1` instead of `a + b`.
/// Test expects sum(4,5) == 9 but gets 8.
const FIXTURE_B: &str = r#"
fn sum(a: i32, b: i32) -> i32 {
    a + b - 1
}

#[test]
fn test_sum() {
    assert_eq!(sum(4, 5), 9);
}
"#;

/// Bug C: wrong return type narrowing — integer division truncates.
/// `half(7)` should return 3 (integer half), but the test expects
/// `half(6) == 3`, which passes — however `half(7) == 3` also passes
/// due to truncation. The *real* semantic bug: the function is named
/// `double` in the assertion but performs division.
/// Rephrased to be clearly broken: function is supposed to double its
/// input but divides instead.
const FIXTURE_C: &str = r#"
fn double(x: i32) -> i32 {
    x / 2
}

#[test]
fn test_double() {
    assert_eq!(double(3), 6);
}
"#;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_text(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Final { text, .. } => text,
        TurnOutcome::Tools { thinking, calls, .. } => {
            eprintln!("  (model issued {} tool call(s))", calls.len());
            thinking.unwrap_or_default()
        }
    }
}

fn build_prompt(fixture: &str) -> String {
    format!(
        "Here's a Rust function and a failing test. \
         Explain why it fails, and give the single-line fix.\n\n{}",
        fixture.trim()
    )
}

// ---------------------------------------------------------------------------
// Bug A — wrong operator
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn debug_failing_test_bug_a_wrong_operator() {
    if super::should_skip_glm().await {
        return;
    }

    let prompt = build_prompt(FIXTURE_A);
    let history = super::single_user_turn(&prompt);

    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a Rust debugging assistant. Be concise.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("SKIP: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM failed on bug-A: {e}"),
    };

    super::assert_reasonable_llm_response(&text, &prompt);
    let lower = text.to_lowercase();

    // Assert: model identified the subtraction bug
    let identified_bug = lower.contains("subtraction")
        || lower.contains("minus")
        || lower.contains("a - b")
        || lower.contains("subtracts");
    assert!(
        identified_bug,
        "bug-A: response must mention subtraction/minus/\"a - b\"; got: {text:?}"
    );

    // Assert: model proposes the addition fix
    let proposed_fix = lower.contains("a + b")
        || lower.contains("addition")
        || lower.contains("+ b")
        || lower.contains("change")
        || lower.contains("replace");
    assert!(
        proposed_fix,
        "bug-A: response must propose 'a + b' or describe operator change; got: {text:?}"
    );

    // Optional: if a code block is present, it should contain `a + b`
    if text.contains("```") {
        let in_block = text
            .split("```")
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .any(|(_, block)| block.contains("a + b"));
        assert!(
            in_block,
            "bug-A: code block in response must contain 'a + b'; got: {text:?}"
        );
    }

    eprintln!(
        "  bug=A latency={latency_ms}ms identified={identified_bug} fix={proposed_fix} \
         response={:?}",
        &text[..text.len().min(300)]
    );
}

// ---------------------------------------------------------------------------
// Bug B — off-by-one
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn debug_failing_test_bug_b_off_by_one() {
    if super::should_skip_glm().await {
        return;
    }

    let prompt = build_prompt(FIXTURE_B);
    let history = super::single_user_turn(&prompt);

    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a Rust debugging assistant. Be concise.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("SKIP: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM failed on bug-B: {e}"),
    };

    super::assert_reasonable_llm_response(&text, &prompt);
    let lower = text.to_lowercase();

    // Assert: model identified the off-by-one (the spurious `- 1`)
    let identified_bug = lower.contains("- 1")
        || lower.contains("-1")
        || lower.contains("off by one")
        || lower.contains("off-by-one")
        || lower.contains("subtract")
        || lower.contains("one less");
    assert!(
        identified_bug,
        "bug-B: response must mention '- 1' or off-by-one; got: {text:?}"
    );

    // Assert: model proposes removing the `- 1`
    let proposed_fix = lower.contains("a + b")
        || lower.contains("remove")
        || lower.contains("delete")
        || lower.contains("without")
        || lower.contains("just")
        || lower.contains("simply");
    assert!(
        proposed_fix,
        "bug-B: response must propose removing '- 1'; got: {text:?}"
    );

    eprintln!(
        "  bug=B latency={latency_ms}ms identified={identified_bug} fix={proposed_fix} \
         response={:?}",
        &text[..text.len().min(300)]
    );
}

// ---------------------------------------------------------------------------
// Bug C — wrong operation (division instead of multiplication)
// ---------------------------------------------------------------------------

#[tokio::test]
#[serial(live_llm)]
#[ignore = "live — requires Z.AI key; opt-in with --ignored"]
async fn debug_failing_test_bug_c_wrong_operation() {
    if super::should_skip_glm().await {
        return;
    }

    let prompt = build_prompt(FIXTURE_C);
    let history = super::single_user_turn(&prompt);

    let (result, latency_ms) = super::timed(glm_turn(
        DEFAULT_GLM_MODEL,
        "You are a Rust debugging assistant. Be concise.",
        &history,
    ))
    .await;

    let text = match result {
        Ok(o) => extract_text(o),
        Err(ref e) if super::is_transient_glm_error(e) => {
            eprintln!("SKIP: transient GLM error: {e}");
            return;
        }
        Err(e) => panic!("GLM failed on bug-C: {e}"),
    };

    super::assert_reasonable_llm_response(&text, &prompt);
    let lower = text.to_lowercase();

    // Assert: model identified division / wrong operator
    let identified_bug = lower.contains("divid")
        || lower.contains("/ 2")
        || lower.contains("/2")
        || lower.contains("division")
        || lower.contains("halv");
    assert!(
        identified_bug,
        "bug-C: response must mention division or '/ 2'; got: {text:?}"
    );

    // Assert: model proposes multiplication as the fix
    let proposed_fix = lower.contains("* 2")
        || lower.contains("*2")
        || lower.contains("multipl")
        || lower.contains("x * 2")
        || lower.contains("x*2");
    assert!(
        proposed_fix,
        "bug-C: response must propose '* 2' or multiplication; got: {text:?}"
    );

    eprintln!(
        "  bug=C latency={latency_ms}ms identified={identified_bug} fix={proposed_fix} \
         response={:?}",
        &text[..text.len().min(300)]
    );
}
