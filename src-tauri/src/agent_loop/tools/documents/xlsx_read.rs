//! XLSX / XLS / ODS reader via `calamine`.
//!
//! `xlsx_read(path, sheet?, range?)` returns rows as a JSON array of arrays.
//! `sheet` is a sheet name or 0-based integer index (default: first sheet).
//! `range` is an A1-notation range like `"A1:D10"` (default: entire sheet).

use calamine::{open_workbook_auto, Data, Range, Reader};
use serde_json::{json, Value};

use super::path_util;

/// Read rows from an XLSX/XLS/ODS/CSV file.
///
/// * `sheet`  — sheet name or 0-based index as string, e.g. `"0"`, `"Products"`.
///              Defaults to the first sheet.
/// * `range`  — A1-notation range, e.g. `"A1:D20"`.  Defaults to entire used range.
pub fn read(raw_path: &str, sheet: Option<&str>, range: Option<&str>) -> Result<String, String> {
    let path = path_util::resolve_local(raw_path)?;

    let mut workbook: calamine::Sheets<_> = open_workbook_auto(&path)
        .map_err(|e| format!("failed to open `{}`: {e}", path.display()))?;

    let sheet_names = workbook.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err("workbook contains no sheets".to_string());
    }

    let target_name = resolve_sheet_name(&sheet_names, sheet)?;

    let ws: Range<Data> = workbook
        .worksheet_range(&target_name)
        .map_err(|e| format!("cannot read sheet `{target_name}`: {e}"))?;

    let rows = extract_rows(&ws, range)?;
    let sheet_names_json: Vec<Value> = sheet_names.iter().map(|s| json!(s)).collect();

    let out = json!({
        "sheet": target_name,
        "sheets": sheet_names_json,
        "rows": rows,
    });

    serde_json::to_string_pretty(&out)
        .map_err(|e| format!("json serialization error: {e}"))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Resolve a sheet specifier to a concrete name.
fn resolve_sheet_name(names: &[String], spec: Option<&str>) -> Result<String, String> {
    let spec = match spec {
        None | Some("") => return Ok(names[0].clone()),
        Some(s) => s,
    };

    // Try as 0-based integer index first.
    if let Ok(idx) = spec.parse::<usize>() {
        return names
            .get(idx)
            .cloned()
            .ok_or_else(|| format!("sheet index {idx} out of range (workbook has {} sheets)", names.len()));
    }

    // Try as name.
    names
        .iter()
        .find(|n| n.eq_ignore_ascii_case(spec))
        .cloned()
        .ok_or_else(|| {
            format!(
                "sheet `{spec}` not found — available: {}",
                names.join(", ")
            )
        })
}

/// Extract rows from a worksheet range, optionally filtered to an A1 range.
fn extract_rows(ws: &Range<Data>, range_spec: Option<&str>) -> Result<Vec<Value>, String> {
    let (start_row, start_col, end_row, end_col) = if let Some(spec) = range_spec {
        parse_a1_range(spec, ws)?
    } else {
        let (sr, sc) = ws.start().unwrap_or((0, 0));
        let (er, ec) = ws.end().unwrap_or((0, 0));
        (sr, sc, er, ec)
    };

    let mut rows: Vec<Value> = Vec::new();

    for row_idx in start_row..=end_row {
        let mut row: Vec<Value> = Vec::new();
        for col_idx in start_col..=end_col {
            let cell = ws.get_value((row_idx, col_idx));
            row.push(cell_to_json(cell));
        }
        rows.push(Value::Array(row));
    }

    Ok(rows)
}

/// Convert a calamine `Data` cell to a `serde_json::Value`.
fn cell_to_json(cell: Option<&Data>) -> Value {
    match cell {
        None | Some(Data::Empty) => Value::Null,
        Some(Data::String(s)) => json!(s),
        Some(Data::Float(f)) => json!(f),
        Some(Data::Int(i)) => json!(i),
        Some(Data::Bool(b)) => json!(b),
        Some(Data::Error(e)) => json!(format!("#ERR:{e:?}")),
        Some(Data::DateTime(dt)) => json!(dt.to_string()),
        Some(Data::DateTimeIso(s)) => json!(s),
        Some(Data::DurationIso(s)) => json!(s),
    }
}

/// Parse an A1-notation range like `"B2:D5"` into (start_row, start_col,
/// end_row, end_col) as 0-based indices, clamped to the worksheet bounds.
fn parse_a1_range(
    spec: &str,
    ws: &Range<Data>,
) -> Result<(u32, u32, u32, u32), String> {
    let parts: Vec<&str> = spec.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("invalid range `{spec}` — expected A1:B2 format"));
    }

    let (sr, sc) = parse_a1_cell(parts[0])?;
    let (er, ec) = parse_a1_cell(parts[1])?;

    let (ws_sr, ws_sc) = ws.start().unwrap_or((0, 0));
    let (ws_er, ws_ec) = ws.end().unwrap_or((0, 0));

    // Clamp to worksheet bounds.
    Ok((
        sr.saturating_add(ws_sr).min(ws_er),
        sc.saturating_add(ws_sc).min(ws_ec),
        er.saturating_add(ws_sr).min(ws_er),
        ec.saturating_add(ws_sc).min(ws_ec),
    ))
}

/// Convert "B3" → (row=2, col=1) (0-based).
fn parse_a1_cell(cell: &str) -> Result<(u32, u32), String> {
    let upper = cell.trim().to_ascii_uppercase();
    let col_str: String = upper.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    let row_str: String = upper.chars().skip_while(|c| c.is_ascii_alphabetic()).collect();

    if col_str.is_empty() || row_str.is_empty() {
        return Err(format!("invalid cell reference `{cell}`"));
    }

    let col: u32 = col_str.chars().fold(0u32, |acc, c| {
        acc * 26 + (c as u32 - 'A' as u32 + 1)
    }) - 1;

    let row: u32 = row_str
        .parse::<u32>()
        .map_err(|_| format!("invalid row in `{cell}`"))?
        .saturating_sub(1);

    Ok((row, col))
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
    fn test_xlsx_read_first_sheet() {
        let out = read(&fixture("tiny.xlsx"), None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sheet"].as_str().unwrap(), "Products");
        let rows = v["rows"].as_array().unwrap();
        assert!(!rows.is_empty());
    }

    #[test]
    fn test_xlsx_sheet_names_listed() {
        let out = read(&fixture("tiny.xlsx"), None, None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let sheets: Vec<&str> = v["sheets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        assert!(sheets.contains(&"Products"));
        assert!(sheets.contains(&"Extra"));
    }

    #[test]
    fn test_xlsx_read_by_sheet_index() {
        let out = read(&fixture("tiny.xlsx"), Some("1"), None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sheet"].as_str().unwrap(), "Extra");
    }

    #[test]
    fn test_xlsx_read_by_sheet_name() {
        let out = read(&fixture("tiny.xlsx"), Some("Extra"), None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sheet"].as_str().unwrap(), "Extra");
    }

    #[test]
    fn test_xlsx_header_row_values() {
        let out = read(&fixture("tiny.xlsx"), Some("0"), None).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let first_row = &v["rows"][0];
        let cells: Vec<&str> = first_row
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c.as_str())
            .collect();
        assert!(cells.contains(&"Product"), "expected 'Product' header");
        assert!(cells.contains(&"Price"), "expected 'Price' header");
    }

    #[test]
    fn test_xlsx_invalid_sheet_name_returns_err() {
        assert!(read(&fixture("tiny.xlsx"), Some("NonExistent"), None).is_err());
    }

    #[test]
    fn test_xlsx_nonexistent_file_returns_err() {
        assert!(read("/tmp/does_not_exist_sunny.xlsx", None, None).is_err());
    }

    #[test]
    fn test_parse_a1_cell_basic() {
        assert_eq!(parse_a1_cell("A1").unwrap(), (0, 0));
        assert_eq!(parse_a1_cell("B2").unwrap(), (1, 1));
        assert_eq!(parse_a1_cell("Z1").unwrap(), (0, 25));
    }
}
