//! Document extraction tools.
//!
//! Provides text and structured data extraction for the formats users
//! actually send to an AI assistant: PDF, DOCX, XLSX/XLS/ODS, and CSV.
//!
//! ## Tools registered (via `inventory::submit!`)
//!
//! | Tool name            | File           | What it does                         |
//! |----------------------|----------------|--------------------------------------|
//! | `pdf_extract_text`   | `tool_pdf.rs`  | Per-page text, optional page filter  |
//! | `pdf_extract_tables` | `tool_pdf.rs`  | Heuristic table rows from a page     |
//! | `pdf_metadata`       | `tool_pdf.rs`  | Title / author / date / page count   |
//! | `docx_extract_text`  | `tool_docx.rs` | Plain text from DOCX ZIP+XML         |
//! | `xlsx_read`          | `tool_xlsx.rs` | Rows from XLSX/XLS/ODS via calamine  |
//! | `csv_read`           | `tool_csv.rs`  | Headers + rows from CSV              |
//! | `document_summarize` | `tool_summarize.rs` | Route text through GLM-5.1      |
//!
//! ## Capabilities
//!
//! All file-read tools require `documents.read` (L0 for user-owned dirs).
//! `document_summarize` additionally requires `network.read` for GLM calls.
//! Network-path files (`smb://`, `afp://`) require `documents.network` (L1).
//!
//! ## Crates
//!
//! * `lopdf` (MIT) — pure-Rust PDF parser.
//! * `zip` (MIT/Apache-2.0) — ZIP archive reader for DOCX.
//! * `calamine` (MIT/Apache-2.0) — pure-Rust XLSX/XLS/ODS/CSV reader.
//! * `csv` (MIT/Apache-2.0) — pure-Rust RFC-4180 CSV parser.

pub(crate) mod csv_read;
pub(crate) mod doc_summarize;
pub(crate) mod docx_extract;
pub(crate) mod page_range;
pub(crate) mod path_util;
pub(crate) mod pdf_extract;
pub(crate) mod xlsx_read;

// Tool registrations — must be `pub mod` so `rustc` does not dead-code-strip
// the `inventory::submit!` call inside each file.
pub mod tool_csv;
pub mod tool_docx;
pub mod tool_pdf;
pub mod tool_summarize;
pub mod tool_xlsx;
