//! Scenario tests — end-to-end user-workflow integration tests.
//!
//! Each file exercises a complete user interaction: tools → LLM → assertions.
//! All tests are `#[ignore]` and require real external services.
//!
//! Run with:
//!   cargo test --test live -- --ignored email_triage --nocapture

#[path = "email_triage.rs"]
pub mod email_triage;
