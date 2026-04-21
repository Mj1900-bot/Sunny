//! CSV reader via the `csv` crate (pure-Rust, RFC-4180).
//!
//! `csv_read(path, has_header?)` returns `{ "headers": [...], "rows": [[...]] }`.
//! When `has_header` is `false`, `headers` is an empty array and all rows are
//! in `rows`.

use serde_json::{json, Value};

use super::path_util;

/// Read a CSV file and return headers + rows as JSON.
///
/// * `has_header` — whether the first row is a header row (default `true`).
pub fn read(raw_path: &str, has_header: bool) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;

    let mut builder = csv::ReaderBuilder::new();
    builder.has_headers(has_header);

    let mut rdr = builder
        .from_path(&path)
        .map_err(|e| format!("cannot open CSV `{}`: {e}", path.display()))?;

    let headers: Vec<String> = if has_header {
        rdr.headers()
            .map_err(|e| format!("cannot read CSV headers: {e}"))?
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    };

    let mut rows: Vec<Value> = Vec::new();
    for result in rdr.records() {
        let record = result.map_err(|e| format!("CSV parse error: {e}"))?;
        let cells: Vec<Value> = record.iter().map(|field| json!(field)).collect();
        rows.push(Value::Array(cells));
    }

    let out = json!({
        "headers": headers,
        "rows": rows,
    });

    serde_json::to_string_pretty(&out)
        .map_err(|e| format!("json serialization error: {e}"))
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        format!("{manifest}/tests/fixtures/{name}")
    }

    #[test]
    fn test_csv_headers_parsed() {
        let out = read(&fixture("tiny.csv"), true).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let headers: Vec<&str> = v["headers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h.as_str().unwrap())
            .collect();
        assert_eq!(headers, vec!["name", "age", "city"]);
    }

    #[test]
    fn test_csv_row_count() {
        let out = read(&fixture("tiny.csv"), true).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // tiny.csv has 3 data rows
        assert_eq!(v["rows"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn test_csv_first_row_values() {
        let out = read(&fixture("tiny.csv"), true).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let row = &v["rows"][0];
        assert_eq!(row[0].as_str().unwrap(), "Alice");
        assert_eq!(row[1].as_str().unwrap(), "30");
        assert_eq!(row[2].as_str().unwrap(), "Vancouver");
    }

    #[test]
    fn test_csv_no_header_mode() {
        let out = read(&fixture("tiny.csv"), false).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["headers"].as_array().unwrap().is_empty());
        // All 4 lines (including header line) appear as data rows
        assert_eq!(v["rows"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn test_csv_nonexistent_returns_err() {
        assert!(read("/tmp/does_not_exist_sunny.csv", true).is_err());
    }
}
