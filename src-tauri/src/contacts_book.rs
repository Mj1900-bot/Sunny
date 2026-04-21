//! macOS Contacts / AddressBook lookup — phone / email → display name.
//!
//! The macOS AddressBook is a set of SQLite databases at:
//!
//!   ~/Library/Application Support/AddressBook/
//!     ├── AddressBook-v22.abcddb          (consolidated; iCloud users)
//!     └── Sources/<UUID>/AddressBook-v22.abcddb  (per-account)
//!
//! We read every `.abcddb` we can find, pull (name, phone) and (name, email)
//! pairs, and build an index keyed by normalised handle. This lets us show
//! "Sunny" in the Contacts panel instead of "+1 (604) 555-1234", and lets the
//! AI resolve `text Sunny` → that same handle.
//!
//! # Permissions
//!
//! Reading AddressBook requires the *Contacts* permission. Full Disk Access
//! (which we already ask for for iMessage) also covers it. We degrade silently
//! when neither is granted — the UI just keeps showing handles.
//!
//! # Caching
//!
//! The index is cached for 60s behind an async Mutex. Two iMessage list
//! refreshes in quick succession therefore cost one AddressBook scan, not two.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::Mutex;

const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct ContactIndex {
    /// Keyed by normalised handle (digits-only for phones, lower-case for
    /// emails). Value is the display name as it should appear in UI.
    by_handle: HashMap<String, String>,
}

impl ContactIndex {
    pub fn empty() -> Self {
        Self {
            by_handle: HashMap::new(),
        }
    }

    /// Test-only convenience — build a single-entry index so other modules
    /// don't have to poke at the internal map layout.
    #[cfg(test)]
    pub fn with_entry(handle: &str, name: &str) -> Self {
        let mut idx = Self::empty();
        idx.by_handle
            .insert(normalise_handle(handle), name.to_string());
        idx
    }

    /// Look up a display name for a raw handle. Returns `None` when we don't
    /// have a match — callers fall back to the prettified handle string.
    pub fn lookup(&self, handle: &str) -> Option<&str> {
        let key = normalise_handle(handle);
        if key.is_empty() {
            return None;
        }
        self.by_handle.get(&key).map(String::as_str)
    }

    /// All `(handle, name)` pairs currently indexed. Used by the frontend
    /// resolver so "text Mom" can find the matching phone.
    pub fn entries(&self) -> Vec<(String, String)> {
        self.by_handle
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Substring search by display name. Returns up to `limit` matches
    /// as `(name, handles)` pairs, where `handles` is every phone/email
    /// we've indexed for that person. Case-insensitive. Used by the
    /// `contacts_lookup` agent tool to answer "what's Niksa's number".
    pub fn search_by_name(&self, query: &str, limit: usize) -> Vec<(String, Vec<String>)> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        for (handle, name) in &self.by_handle {
            if name.to_lowercase().contains(&needle) {
                by_name.entry(name.clone()).or_default().push(handle.clone());
            }
        }
        let mut rows: Vec<(String, Vec<String>)> = by_name.into_iter().collect();
        rows.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        rows.truncate(limit);
        rows
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.by_handle.len()
    }
}

static CACHE: Mutex<Option<(Instant, ContactIndex)>> = Mutex::const_new(None);

/// Top-level entry point. Returns the shared cached index if fresh, otherwise
/// rebuilds by scanning every `.abcddb` file under the AddressBook root.
pub async fn get_index() -> ContactIndex {
    {
        let guard = CACHE.lock().await;
        if let Some((built_at, idx)) = guard.as_ref() {
            if built_at.elapsed() < CACHE_TTL {
                return idx.clone();
            }
        }
    }
    let fresh = build_index().await.unwrap_or_else(|e| {
        log::warn!("contacts_book: index build failed: {e}");
        ContactIndex::empty()
    });
    {
        let mut guard = CACHE.lock().await;
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

/// Force the next `get_index()` call to rebuild. Called after the user edits
/// a contact, though right now nothing in the UI triggers that.
#[allow(dead_code)]
pub async fn invalidate() {
    let mut guard = CACHE.lock().await;
    *guard = None;
}

async fn build_index() -> Result<ContactIndex, String> {
    let roots = address_book_roots()?;
    let mut by_handle: HashMap<String, String> = HashMap::new();
    for db_path in roots {
        match scan_database(&db_path).await {
            Ok(pairs) => {
                for (handle, name) in pairs {
                    // Don't clobber an existing entry with an emptier name.
                    let key = normalise_handle(&handle);
                    if key.is_empty() || name.trim().is_empty() {
                        continue;
                    }
                    by_handle.entry(key).or_insert(name);
                }
            }
            Err(e) => {
                log::debug!("contacts_book: scan {} failed: {e}", db_path.display());
                continue;
            }
        }
    }
    Ok(ContactIndex { by_handle })
}

fn address_book_roots() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no $HOME".to_string())?;
    let base = home.join("Library/Application Support/AddressBook");
    let mut out: Vec<PathBuf> = Vec::new();

    let consolidated = base.join("AddressBook-v22.abcddb");
    if consolidated.exists() {
        out.push(consolidated);
    }

    let sources = base.join("Sources");
    if let Ok(read_dir) = std::fs::read_dir(&sources) {
        for entry in read_dir.flatten() {
            let db = entry.path().join("AddressBook-v22.abcddb");
            if db.exists() {
                out.push(db);
            }
        }
    }

    Ok(out)
}

#[derive(Debug, Deserialize)]
struct PhoneRow {
    first: Option<String>,
    last: Option<String>,
    nickname: Option<String>,
    org: Option<String>,
    handle: Option<String>,
    // Deserialized from sqlite but not read — kept so the column order
    // matches the SELECT statement and serde doesn't choke on extra
    // fields.  Parked for future per-kind filtering.
    #[allow(dead_code)]
    kind: Option<String>,
}

// Single query that returns phone + email rows in one shot (unioned) so we
// only spawn sqlite3 once per db file.
const QUERY: &str = r#"
SELECT
  r.ZFIRSTNAME   AS first,
  r.ZLASTNAME    AS last,
  r.ZNICKNAME    AS nickname,
  r.ZORGANIZATION AS org,
  p.ZFULLNUMBER  AS handle,
  'phone'        AS kind
FROM ZABCDRECORD r
JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
WHERE p.ZFULLNUMBER IS NOT NULL AND p.ZFULLNUMBER <> ''
UNION ALL
SELECT
  r.ZFIRSTNAME,
  r.ZLASTNAME,
  r.ZNICKNAME,
  r.ZORGANIZATION,
  e.ZADDRESS,
  'email'
FROM ZABCDRECORD r
JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
WHERE e.ZADDRESS IS NOT NULL AND e.ZADDRESS <> '';
"#;

async fn scan_database(path: &Path) -> Result<Vec<(String, String)>, String> {
    let output = Command::new("sqlite3")
        .arg("-readonly")
        .arg("-cmd")
        .arg(".mode json")
        .arg(path)
        .arg(QUERY)
        .output()
        .await
        .map_err(|e| format!("sqlite3 spawn: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_rows(&stdout)
}

fn parse_rows(stdout: &str) -> Result<Vec<(String, String)>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let raw: Vec<PhoneRow> =
        serde_json::from_str(trimmed).map_err(|e| format!("abcddb parse: {e}"))?;
    Ok(raw
        .into_iter()
        .filter_map(|r| {
            let handle = r.handle?;
            let name = assemble_name(r.first, r.last, r.nickname, r.org)?;
            Some((handle, name))
        })
        .collect())
}

fn assemble_name(
    first: Option<String>,
    last: Option<String>,
    nickname: Option<String>,
    org: Option<String>,
) -> Option<String> {
    let first = first.unwrap_or_default();
    let last = last.unwrap_or_default();
    let nickname = nickname.unwrap_or_default();
    let org = org.unwrap_or_default();

    if !nickname.trim().is_empty() {
        return Some(nickname.trim().to_string());
    }
    let full = format!("{} {}", first.trim(), last.trim());
    let full = full.trim().to_string();
    if !full.is_empty() {
        return Some(full);
    }
    if !org.trim().is_empty() {
        return Some(org.trim().to_string());
    }
    None
}

/// Normalise a raw handle to an index key.
///
/// - Phone numbers: keep only digits. This is a cheap approximation of
///   "same number, different formatting" — +1 (604) 555-1234 and
///   16045551234 land on the same key (16045551234).
/// - Anything with `@` → lowercase the whole thing.
/// - Everything else → lowercase as-is.
pub fn normalise_handle(handle: &str) -> String {
    let trimmed = handle.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains('@') {
        return trimmed.to_ascii_lowercase();
    }
    let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return trimmed.to_ascii_lowercase();
    }
    // Drop a leading `1` on 11-digit NANP numbers so "6045551234" and
    // "+16045551234" produce the same key. This is a pragmatic North-American
    // choice — users outside NA who store their own + prefix won't collide
    // because we only strip when the length is exactly 11 and the digit is
    // `1`.
    if digits.len() == 11 && digits.starts_with('1') {
        return digits[1..].to_string();
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_handle_covers_phone_variants() {
        assert_eq!(normalise_handle("+1 (604) 555-1234"), "6045551234");
        assert_eq!(normalise_handle("16045551234"), "6045551234");
        assert_eq!(normalise_handle("6045551234"), "6045551234");
        assert_eq!(normalise_handle("(604) 555-1234"), "6045551234");
    }

    #[test]
    fn normalise_handle_covers_emails() {
        assert_eq!(normalise_handle(" Foo@Bar.COM "), "foo@bar.com");
    }

    #[test]
    fn normalise_handle_empty() {
        assert_eq!(normalise_handle(""), "");
        assert_eq!(normalise_handle("   "), "");
    }

    #[test]
    fn assemble_name_prefers_nickname() {
        let n = assemble_name(
            Some("Alex".into()),
            Some("Ng".into()),
            Some("Mom".into()),
            None,
        );
        assert_eq!(n.as_deref(), Some("Mom"));
    }

    #[test]
    fn assemble_name_falls_back_to_full_name() {
        let n = assemble_name(Some("Alex".into()), Some("Ng".into()), None, None);
        assert_eq!(n.as_deref(), Some("Alex Ng"));
    }

    #[test]
    fn assemble_name_falls_back_to_org() {
        let n = assemble_name(None, None, None, Some("Acme Inc.".into()));
        assert_eq!(n.as_deref(), Some("Acme Inc."));
    }

    #[test]
    fn assemble_name_none_when_empty() {
        assert!(assemble_name(None, None, None, None).is_none());
        assert!(assemble_name(Some("  ".into()), Some("".into()), None, None).is_none());
    }

    #[test]
    fn parse_rows_basic() {
        let sample = r#"[
          {"first":"Alex","last":"Ng","nickname":null,"org":null,"handle":"+16045551234","kind":"phone"},
          {"first":null,"last":null,"nickname":null,"org":"Acme Inc.","handle":"hi@acme.co","kind":"email"}
        ]"#;
        let rows = parse_rows(sample).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("+16045551234".to_string(), "Alex Ng".to_string()));
        assert_eq!(rows[1], ("hi@acme.co".to_string(), "Acme Inc.".to_string()));
    }

    #[test]
    fn contact_index_lookup_normalises() {
        let mut idx = ContactIndex::empty();
        idx.by_handle
            .insert("6045551234".to_string(), "Mom".to_string());
        assert_eq!(idx.lookup("+1 (604) 555-1234"), Some("Mom"));
        assert_eq!(idx.lookup("16045551234"), Some("Mom"));
        assert_eq!(idx.lookup("415-555-0000"), None);
    }
}
