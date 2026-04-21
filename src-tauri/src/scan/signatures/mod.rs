//! Curated 2024–2026 threat database — IoC (Indicators of Compromise)
//! patterns for known macOS malware families, malicious-script behaviours,
//! and LLM prompt-injection attacks.
//!
//! This is deliberately not a full AV engine. It complements the online
//! MalwareBazaar / VirusTotal hash lookups with fast local pattern checks
//! so the scanner can name families (Atomic Stealer, Banshee, XCSSET,
//! Cthulhu…) and flag prompt-injection payloads found in text files, PDFs,
//! markdown, and source code — even when offline.
//!
//! Sources are public research:
//!   - Objective-See "Mac Malware of the Year" series (Patrick Wardle).
//!   - SentinelLabs, Jamf Threat Labs, Elastic Security, Palo Alto Unit 42.
//!   - MalwareBazaar family tags (abuse.ch).
//!   - OWASP LLM Top-10 2025 (LLM01 — Prompt Injection).
//!   - HackAPrompt competition corpus, Simon Willison's prompt-injection
//!     notebook, and the classic DAN/STAN/AIM jailbreak family.
//!
//! Every entry here documents *why* it fires and cites the family it
//! targets. The catalog is exposed to the UI via `scan_signature_catalog`
//! so the user can see exactly what their scanner knows about.

pub mod types;
pub mod catalog;
pub mod entries;
pub mod patterns;
pub mod matcher;

pub use types::*;
pub use catalog::catalog;
pub use matcher::{match_filename, match_content, hits_to_signal, match_hash_prefix};

#[cfg(test)]
mod tests;
