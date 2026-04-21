use serde::Serialize;
use crate::scan::types::Verdict;

// ---------------------------------------------------------------------------
// Public types (serialized to the frontend — outbound only, no Deserialize
// because the table types borrow `&'static str` which doesn't round-trip)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SignatureCategory {
    MalwareFamily,
    MaliciousScript,
    PromptInjection,
    AgentExfil,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignatureEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub category: SignatureCategory,
    pub year_seen: u16,
    pub platforms: &'static [&'static str],
    pub description: &'static str,
    pub references: &'static [&'static str],
    pub weight: Verdict,
}

#[derive(Clone, Debug)]
pub struct SignatureHit {
    pub entry: &'static SignatureEntry,
    pub excerpt: String,
    pub offset: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignatureCatalog {
    pub version: &'static str,
    pub updated: &'static str,
    pub total: usize,
    /// Size of the offline SHA-256 prefix table — displayed in the
    /// THREAT DATABASE panel so users can see how many known-bad
    /// samples we can recognise without hitting the network.
    pub offline_hash_prefixes: usize,
    pub by_category: Vec<CategoryCount>,
    pub entries: Vec<SignatureEntry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCount {
    pub category: SignatureCategory,
    pub count: usize,
}

