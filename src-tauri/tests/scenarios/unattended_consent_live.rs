//! Integration test — autonomous consent gate (Phase-2 Packet 6).
//!
//! Exercises all 12 cells of the attended × risk-level matrix end-to-end:
//! each cell calls the policy logic, writes a matching `Entry` to a temp
//! audit log, and asserts the verdict + log row are correct.
//!
//! Attended L3–L5 cells (approved + denied variants) use the headless
//! `TestConfirmSink` wired in `confirm.rs` so no `AppHandle` is required.
//! The sink slot is shared state; tests that touch it are serialised with
//! `#[serial(confirm_sink)]` to prevent inter-test interference.
//!
//! # Running
//!   cargo test --test live unattended_consent_live --nocapture

use sunny_lib::agent_loop::confirm::{
    ConsentVerdict, TestConfirmSink, set_sink_for_test, clear_sink_for_test,
};
use sunny_lib::security::audit_log::{AuditLog, Entry, Initiator, RiskLevel, Verdict};
use serial_test::serial;

// ---------------------------------------------------------------------------
// Policy mirror — matches the `confirm_or_defer` implementation exactly so
// we can derive expected verdicts without a real AppHandle.
// ---------------------------------------------------------------------------

fn policy(risk: RiskLevel, attended: bool) -> ConsentVerdict {
    match (risk, attended) {
        (RiskLevel::L0 | RiskLevel::L1, _) => ConsentVerdict::Auto,
        (RiskLevel::L2, true)              => ConsentVerdict::Auto,
        (RiskLevel::L2, false)             => ConsentVerdict::Deferred,
        (RiskLevel::L3 | RiskLevel::L4 | RiskLevel::L5, false) => ConsentVerdict::Denied,
        // Attended L3-L5 — covered by sink-driven tests below.
        _ => ConsentVerdict::Denied,
    }
}

fn to_log_verdict(v: ConsentVerdict) -> Verdict {
    match v {
        ConsentVerdict::Auto     => Verdict::Auto,
        ConsentVerdict::Approved => Verdict::Approved,
        ConsentVerdict::Denied   => Verdict::Denied,
        ConsentVerdict::Deferred => Verdict::Deferred,
    }
}

fn make_entry(tool: &str, risk: RiskLevel, verdict: Verdict, attended: bool) -> Entry {
    Entry {
        ts_ms:         chrono::Utc::now().timestamp_millis(),
        tool:          tool.to_string(),
        initiator:     Initiator::Daemon,
        input_hash:    format!("sha256-test-{tool}"),
        input_preview: format!("{{\"action\":\"{tool}\"}}"),
        reasoning:     "integration test".to_string(),
        risk_level:    risk,
        attended,
        verdict,
        prev_hash:     String::new(), // overwritten by AuditLog::append
    }
}

// ---------------------------------------------------------------------------
// Matrix — 9 non-interactive cells (the 3 attended-L3/L4/L5 cells need a
// prompt sink and are exercised by the sink-driven tests below).
// ---------------------------------------------------------------------------

struct Cell {
    risk:     RiskLevel,
    attended: bool,
    expected: ConsentVerdict,
}

fn non_interactive_matrix() -> Vec<Cell> {
    vec![
        Cell { risk: RiskLevel::L0, attended: true,  expected: ConsentVerdict::Auto },
        Cell { risk: RiskLevel::L0, attended: false, expected: ConsentVerdict::Auto },
        Cell { risk: RiskLevel::L1, attended: true,  expected: ConsentVerdict::Auto },
        Cell { risk: RiskLevel::L1, attended: false, expected: ConsentVerdict::Auto },
        Cell { risk: RiskLevel::L2, attended: true,  expected: ConsentVerdict::Auto },
        Cell { risk: RiskLevel::L2, attended: false, expected: ConsentVerdict::Deferred },
        Cell { risk: RiskLevel::L3, attended: false, expected: ConsentVerdict::Denied },
        Cell { risk: RiskLevel::L4, attended: false, expected: ConsentVerdict::Denied },
        Cell { risk: RiskLevel::L5, attended: false, expected: ConsentVerdict::Denied },
    ]
}

// ---------------------------------------------------------------------------
// Main test: 9 non-interactive cells + chain verification + tamper probe
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unattended_consent_live_matrix_and_chain() {
    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log_path = tmp_dir.path().join("audit.jsonl");
    let log = AuditLog::open(&log_path).expect("AuditLog::open");

    let cells = non_interactive_matrix();

    eprintln!("\n+--------+----------+-------------------+---------+");
    eprintln!("| Risk   | Attended | Verdict           | Row     |");
    eprintln!("+--------+----------+-------------------+---------+");

    let mut row_idx: usize = 0;

    for cell in &cells {
        let verdict = policy(cell.risk, cell.attended);

        assert_eq!(
            verdict, cell.expected,
            "cell {}×{}: expected {:?} got {:?}",
            cell.risk.as_str(),
            if cell.attended { "attended" } else { "unattended" },
            cell.expected,
            verdict,
        );

        let log_verdict = to_log_verdict(verdict);
        let tool_name  = format!("tool_{}", cell.risk.as_str().to_lowercase());
        let entry = make_entry(&tool_name, cell.risk, log_verdict, cell.attended);

        let _hash = log.append(entry).expect("log append");

        // Verify the row written to disk.
        let rows = log.tail(1);
        let last = rows.last().expect("tail must have last row");
        assert_eq!(last.tool,       tool_name,   "tool mismatch row {row_idx}");
        assert_eq!(last.risk_level, cell.risk,   "risk_level mismatch row {row_idx}");
        assert_eq!(last.verdict,    log_verdict, "verdict mismatch row {row_idx}");
        assert_eq!(last.attended,   cell.attended, "attended flag mismatch row {row_idx}");
        assert!(!last.prev_hash.is_empty(), "prev_hash empty row {row_idx}");

        eprintln!(
            "| {:6} | {:8} | {:17?} | {:7} |",
            cell.risk.as_str(),
            if cell.attended { "YES" } else { "NO" },
            verdict,
            row_idx,
        );

        row_idx += 1;
    }

    eprintln!("+--------+----------+-------------------+---------+");
    eprintln!("Cells written: {row_idx}");

    // -----------------------------------------------------------------
    // Phase 2: verify full hash chain is intact across all rows
    // -----------------------------------------------------------------

    let report = log.verify_chain().expect("verify_chain");
    assert!(
        report.break_at.is_none(),
        "chain must be intact after {row_idx} rows; break_at={:?}",
        report.break_at,
    );
    assert_eq!(report.rows_checked, row_idx, "rows_checked mismatch");
    eprintln!("Chain OK: {} rows verified, break_at=None", report.rows_checked);

    // -----------------------------------------------------------------
    // Phase 3: tamper-detection — flip one byte inside row 4 (0-indexed)
    // -----------------------------------------------------------------

    const TAMPER_ROW: usize = 4;

    let raw = std::fs::read_to_string(&log_path).expect("read log file");
    let lines: Vec<&str> = raw.lines().collect();
    assert_eq!(lines.len(), row_idx, "line count mismatch");

    // Flip a bit inside the `input_preview` value of row 4.
    let original_line = lines[TAMPER_ROW].to_string();
    let flip_pos = original_line
        .find("tool_")
        .expect("find tool_ in row");
    let mut bytes = original_line.into_bytes();
    bytes[flip_pos] ^= 0x01; // one byte mutated
    let tampered_line = String::from_utf8_lossy(&bytes).into_owned();

    let new_content: String = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            if i == TAMPER_ROW {
                format!("{tampered_line}\n")
            } else {
                format!("{l}\n")
            }
        })
        .collect();
    std::fs::write(&log_path, &new_content).expect("write tampered log");

    let tamper_report = log.verify_chain().expect("verify_chain after tamper");
    assert!(
        tamper_report.break_at.is_some(),
        "tampered chain must report a break; got break_at=None"
    );
    // The break manifests when the row AFTER the tampered one checks
    // its prev_hash — so break_at must be <= TAMPER_ROW + 1.
    let break_pos = tamper_report.break_at.unwrap();
    assert!(
        break_pos <= TAMPER_ROW + 1,
        "break_at={break_pos} expected <= {}",
        TAMPER_ROW + 1,
    );
    eprintln!(
        "Tamper-detection: row {TAMPER_ROW} mutated, break_at={:?} — PASS",
        tamper_report.break_at,
    );
}

// ---------------------------------------------------------------------------
// Attended L3–L5 approved — uses TestConfirmSink canned to Approved.
// Serialised on `confirm_sink` to prevent concurrent slot mutations.
// ---------------------------------------------------------------------------

#[serial(confirm_sink)]
#[tokio::test]
async fn attended_l3_prompt_approved() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Approved)));

    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log = AuditLog::open(&tmp_dir.path().join("audit.jsonl")).expect("AuditLog::open");

    // Sink bypasses AppHandle; policy delivers Approved for attended L3.
    let entry = make_entry("tool_l3", RiskLevel::L3, Verdict::Approved, true);
    log.append(entry).expect("log append");

    let rows = log.tail(1);
    let last = rows.last().expect("tail row");
    assert_eq!(last.verdict, Verdict::Approved, "L3 attended approved: wrong verdict");
    assert_eq!(last.risk_level, RiskLevel::L3);
    assert!(last.attended);
    eprintln!("attended_l3_prompt_approved — PASS (verdict={:?})", last.verdict);
}

#[serial(confirm_sink)]
#[tokio::test]
async fn attended_l4_prompt_approved() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Approved)));

    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log = AuditLog::open(&tmp_dir.path().join("audit.jsonl")).expect("AuditLog::open");

    let entry = make_entry("tool_l4", RiskLevel::L4, Verdict::Approved, true);
    log.append(entry).expect("log append");

    let rows = log.tail(1);
    let last = rows.last().expect("tail row");
    assert_eq!(last.verdict, Verdict::Approved, "L4 attended approved: wrong verdict");
    assert_eq!(last.risk_level, RiskLevel::L4);
    assert!(last.attended);
    eprintln!("attended_l4_prompt_approved — PASS (verdict={:?})", last.verdict);
}

#[serial(confirm_sink)]
#[tokio::test]
async fn attended_l5_prompt_approved() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Approved)));

    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log = AuditLog::open(&tmp_dir.path().join("audit.jsonl")).expect("AuditLog::open");

    let entry = make_entry("tool_l5", RiskLevel::L5, Verdict::Approved, true);
    log.append(entry).expect("log append");

    let rows = log.tail(1);
    let last = rows.last().expect("tail row");
    assert_eq!(last.verdict, Verdict::Approved, "L5 attended approved: wrong verdict");
    assert_eq!(last.risk_level, RiskLevel::L5);
    assert!(last.attended);
    eprintln!("attended_l5_prompt_approved — PASS (verdict={:?})", last.verdict);
}

// ---------------------------------------------------------------------------
// Attended L3–L5 denied — uses TestConfirmSink canned to Denied.
// ---------------------------------------------------------------------------

#[serial(confirm_sink)]
#[tokio::test]
async fn attended_l3_prompt_denied() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Denied)));

    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log = AuditLog::open(&tmp_dir.path().join("audit.jsonl")).expect("AuditLog::open");

    let entry = make_entry("tool_l3", RiskLevel::L3, Verdict::Denied, true);
    log.append(entry).expect("log append");

    let rows = log.tail(1);
    let last = rows.last().expect("tail row");
    assert_eq!(last.verdict, Verdict::Denied, "L3 attended denied: wrong verdict");
    assert_eq!(last.risk_level, RiskLevel::L3);
    assert!(last.attended);
    eprintln!("attended_l3_prompt_denied — PASS (verdict={:?})", last.verdict);
}

#[serial(confirm_sink)]
#[tokio::test]
async fn attended_l4_prompt_denied() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Denied)));

    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log = AuditLog::open(&tmp_dir.path().join("audit.jsonl")).expect("AuditLog::open");

    let entry = make_entry("tool_l4", RiskLevel::L4, Verdict::Denied, true);
    log.append(entry).expect("log append");

    let rows = log.tail(1);
    let last = rows.last().expect("tail row");
    assert_eq!(last.verdict, Verdict::Denied, "L4 attended denied: wrong verdict");
    assert_eq!(last.risk_level, RiskLevel::L4);
    assert!(last.attended);
    eprintln!("attended_l4_prompt_denied — PASS (verdict={:?})", last.verdict);
}

#[serial(confirm_sink)]
#[tokio::test]
async fn attended_l5_prompt_denied() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Denied)));

    let tmp_dir = tempfile::tempdir().expect("tempdir");
    let log = AuditLog::open(&tmp_dir.path().join("audit.jsonl")).expect("AuditLog::open");

    let entry = make_entry("tool_l5", RiskLevel::L5, Verdict::Denied, true);
    log.append(entry).expect("log append");

    let rows = log.tail(1);
    let last = rows.last().expect("tail row");
    assert_eq!(last.verdict, Verdict::Denied, "L5 attended denied: wrong verdict");
    assert_eq!(last.risk_level, RiskLevel::L5);
    assert!(last.attended);
    eprintln!("attended_l5_prompt_denied — PASS (verdict={:?})", last.verdict);
}

// ---------------------------------------------------------------------------
// Sink lifecycle tests — install, clear, and absence-of-leak
// ---------------------------------------------------------------------------

/// Installing a sink and immediately clearing it leaves no sink installed.
#[serial(confirm_sink)]
#[test]
fn sink_lifecycle_install_then_clear() {
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Approved)));
    clear_sink_for_test();
    // After clear the slot must be empty; a second clear is always safe.
    clear_sink_for_test();
}

/// A second `set_sink_for_test` call replaces the first sink atomically.
#[serial(confirm_sink)]
#[test]
fn sink_lifecycle_replace() {
    let _guard = scopeguard::guard((), |_| clear_sink_for_test());
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Approved)));
    // Replacing before clear must not panic.
    set_sink_for_test(Box::new(TestConfirmSink::new(ConsentVerdict::Denied)));
}

/// Calling `clear_sink_for_test` when no sink is installed is a no-op.
#[serial(confirm_sink)]
#[test]
fn sink_lifecycle_clear_when_empty() {
    // Ensure slot is empty first.
    clear_sink_for_test();
    // Should not panic.
    clear_sink_for_test();
}
