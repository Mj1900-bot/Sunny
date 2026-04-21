use super::types::{CategoryCount, SignatureCatalog, SignatureCategory, SignatureEntry};
use super::patterns::{ALL_ENTRIES, HASH_PREFIX_TABLE};

// ---------------------------------------------------------------------------
// Version & public catalog API
// ---------------------------------------------------------------------------

pub const CATALOG_VERSION: &str = "2026.06";
pub const CATALOG_UPDATED: &str = "2026-04-19";

pub fn catalog() -> SignatureCatalog {
    let entries: Vec<SignatureEntry> = ALL_ENTRIES.to_vec();
    let mut counts: std::collections::HashMap<SignatureCategory, usize> =
        std::collections::HashMap::new();
    for e in &entries {
        *counts.entry(e.category).or_insert(0) += 1;
    }
    let mut by_category: Vec<CategoryCount> = counts
        .into_iter()
        .map(|(category, count)| CategoryCount { category, count })
        .collect();
    by_category.sort_by_key(|c| match c.category {
        SignatureCategory::MalwareFamily => 0,
        SignatureCategory::MaliciousScript => 1,
        SignatureCategory::PromptInjection => 2,
        SignatureCategory::AgentExfil => 3,
    });
    SignatureCatalog {
        version: CATALOG_VERSION,
        updated: CATALOG_UPDATED,
        total: entries.len(),
        offline_hash_prefixes: HASH_PREFIX_TABLE.len(),
        by_category,
        entries,
    }
}

