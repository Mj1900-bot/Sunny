//! Page-range parser for `pdf_extract_text` / `pdf_extract_tables`.
//!
//! Accepts: `"all"`, `"1-5"`, `"3,7,9"`, `"1-3,5,8-10"` (1-based).
//! Returns a sorted, deduplicated `Vec<u32>` of 1-based page numbers, or
//! `None` when the spec is `"all"` / absent.

/// Parse a page specification string into a sorted, dedup'd list of
/// 1-based page numbers.  Returns `None` for "all" / empty input.
pub fn parse(spec: &str) -> Result<Option<Vec<u32>>, String> {
    let s = spec.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("all") {
        return Ok(None);
    }

    let mut pages: Vec<u32> = Vec::new();

    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            let lo = parse_page_num(a)?;
            let hi = parse_page_num(b)?;
            if lo > hi {
                return Err(format!("invalid range `{part}`: start > end"));
            }
            pages.extend(lo..=hi);
        } else {
            pages.push(parse_page_num(part)?);
        }
    }

    if pages.is_empty() {
        return Ok(None);
    }

    pages.sort_unstable();
    pages.dedup();
    Ok(Some(pages))
}

fn parse_page_num(s: &str) -> Result<u32, String> {
    s.trim()
        .parse::<u32>()
        .map_err(|_| format!("invalid page number `{s}`"))
        .and_then(|n| {
            if n == 0 {
                Err("page numbers are 1-based; 0 is not valid".to_string())
            } else {
                Ok(n)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_returns_none() {
        assert_eq!(parse("all").unwrap(), None);
        assert_eq!(parse("ALL").unwrap(), None);
        assert_eq!(parse("").unwrap(), None);
    }

    #[test]
    fn test_single_page() {
        assert_eq!(parse("3").unwrap(), Some(vec![3]));
    }

    #[test]
    fn test_range() {
        assert_eq!(parse("1-3").unwrap(), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_csv_pages() {
        assert_eq!(parse("3,7,9").unwrap(), Some(vec![3, 7, 9]));
    }

    #[test]
    fn test_mixed() {
        assert_eq!(parse("1-3,5,8-10").unwrap(), Some(vec![1, 2, 3, 5, 8, 9, 10]));
    }

    #[test]
    fn test_dedup() {
        assert_eq!(parse("1,1,2-3,2").unwrap(), Some(vec![1, 2, 3]));
    }

    #[test]
    fn test_invalid_range() {
        assert!(parse("5-3").is_err());
    }

    #[test]
    fn test_zero_rejected() {
        assert!(parse("0").is_err());
    }
}
