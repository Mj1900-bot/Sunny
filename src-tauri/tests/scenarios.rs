//! Scenario integration tests — end-to-end user workflows against live providers.
//!
//! All tests are `#[ignore]` — they require real network + API keys.
//!
//! # Running
//!
//!   # All scenario tests
//!   cargo test --test scenarios -- --ignored --nocapture
//!
//!   # Single scenario
//!   cargo test --test live -- --ignored build_utility --nocapture

#[path = "scenarios/build_utility.rs"]
mod build_utility;
