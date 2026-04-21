// Data helpers — all `#[tauri::command]` below are PARKED (not yet
// registered in `lib.rs::invoke_handler`). They're kept compiled so
// signature drift is caught early; wire them into the handler when
// the UI starts calling them.

#![allow(dead_code)]

// regex_match / regex_replace
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn regex_match(
    text: String,
    pattern: String,
    global: Option<bool>,
) -> Result<String, String> {
    let re = regex::Regex::new(&pattern)
        .map_err(|e| format!("regex_match: invalid pattern: {e}"))?;
    let want_all = global.unwrap_or(true);

    if want_all {
        let matches: Vec<String> = re
            .find_iter(&text)
            .map(|m| m.as_str().to_string())
            .collect();
        if matches.is_empty() {
            return Ok("no matches".to_string());
        }
        let rendered = matches
            .iter()
            .enumerate()
            .map(|(i, m)| format!("{}. {}", i + 1, m))
            .collect::<Vec<_>>()
            .join("\n");
        Ok(format!("{} match{}:\n{rendered}", matches.len(),
            if matches.len() == 1 { "" } else { "es" }))
    } else {
        match re.find(&text) {
            Some(m) => Ok(format!("1 match:\n1. {}", m.as_str())),
            None => Ok("no matches".to_string()),
        }
    }
}

#[tauri::command]
pub async fn regex_replace(
    text: String,
    pattern: String,
    replacement: String,
) -> Result<String, String> {
    let re = regex::Regex::new(&pattern)
        .map_err(|e| format!("regex_replace: invalid pattern: {e}"))?;
    // The public contract is "replace all", which is the common case; the
    // `regex_match` sibling exposes `global=false` for first-only matching.
    Ok(re.replace_all(&text, replacement.as_str()).into_owned())
}

// ---------------------------------------------------------------------------
// json_query — JSONPath-lite.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn json_query(json_str: String, path: String) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("json_query: invalid JSON: {e}"))?;
    let steps = parse_json_path(&path)
        .map_err(|e| format!("json_query: {e}"))?;

    let mut current = &value;
    for step in &steps {
        current = apply_step(current, step)
            .map_err(|e| format!("json_query: {e}"))?;
    }

    serde_json::to_string_pretty(current)
        .map_err(|e| format!("json_query: serialise result: {e}"))
}

#[derive(Debug)]
enum PathStep {
    Key(String),
    Index(usize),
}

fn parse_json_path(raw: &str) -> Result<Vec<PathStep>, String> {
    let mut p = raw.trim();
    // Leading `$` is optional; strip it if present.
    if let Some(rest) = p.strip_prefix('$') {
        p = rest;
    }
    // Leading dot is also optional: `.a.b` or `a.b` both work.
    let p = p.strip_prefix('.').unwrap_or(p);

    let mut steps: Vec<PathStep> = Vec::new();
    let mut buf = String::new();
    let mut chars = p.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '.' => {
                if !buf.is_empty() {
                    steps.push(PathStep::Key(std::mem::take(&mut buf)));
                }
            }
            '[' => {
                if !buf.is_empty() {
                    steps.push(PathStep::Key(std::mem::take(&mut buf)));
                }
                let mut idx = String::new();
                let mut closed = false;
                for d in chars.by_ref() {
                    if d == ']' {
                        closed = true;
                        break;
                    }
                    idx.push(d);
                }
                if !closed {
                    return Err(format!("unclosed '[' in path \"{raw}\""));
                }
                let idx_trim = idx.trim();
                // Bracket can wrap a quoted key or a non-negative integer.
                if (idx_trim.starts_with('"') && idx_trim.ends_with('"'))
                    || (idx_trim.starts_with('\'') && idx_trim.ends_with('\''))
                {
                    if idx_trim.len() < 2 {
                        return Err(format!("empty quoted key in \"{raw}\""));
                    }
                    steps.push(PathStep::Key(idx_trim[1..idx_trim.len() - 1].to_string()));
                } else {
                    let n: usize = idx_trim
                        .parse()
                        .map_err(|_| format!("invalid index \"{idx_trim}\" in path"))?;
                    steps.push(PathStep::Index(n));
                }
            }
            '*' | '?' | '@' => {
                return Err(format!(
                    "unsupported JSONPath feature '{ch}' in \"{raw}\" — only $.a.b[0].c is supported"
                ));
            }
            c => buf.push(c),
        }
    }
    if !buf.is_empty() {
        steps.push(PathStep::Key(buf));
    }
    Ok(steps)
}

fn apply_step<'a>(
    value: &'a serde_json::Value,
    step: &PathStep,
) -> Result<&'a serde_json::Value, String> {
    match step {
        PathStep::Key(k) => value
            .get(k)
            .ok_or_else(|| format!("no key \"{k}\" at this level")),
        PathStep::Index(i) => {
            let arr = value
                .as_array()
                .ok_or_else(|| format!("cannot index into non-array at [{i}]"))?;
            arr.get(*i)
                .ok_or_else(|| format!("index {i} out of bounds (len {})", arr.len()))
        }
    }
}

// ---------------------------------------------------------------------------
// hash_text
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hash_text(text: String, algo: String) -> Result<String, String> {
    use md5::{Digest as Md5Digest, Md5};
    use sha1::{Digest as Sha1Digest, Sha1};
    use sha2::{Digest as Sha2Digest, Sha256};

    let name = algo.trim().to_ascii_lowercase();
    let hex = match name.as_str() {
        "sha256" | "sha-256" => {
            let mut hasher = Sha256::new();
            Sha2Digest::update(&mut hasher, text.as_bytes());
            format!("{:x}", hasher.finalize())
        }
        "sha1" | "sha-1" => {
            let mut hasher = Sha1::new();
            Sha1Digest::update(&mut hasher, text.as_bytes());
            format!("{:x}", hasher.finalize())
        }
        "md5" | "md-5" => {
            let mut hasher = Md5::new();
            Md5Digest::update(&mut hasher, text.as_bytes());
            format!("{:x}", hasher.finalize())
        }
        other => {
            return Err(format!(
                "hash_text: unknown algo \"{other}\" (want sha256|sha1|md5)"
            ));
        }
    };
    Ok(hex)
}

// ---------------------------------------------------------------------------
// uuid_new
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn uuid_new() -> Result<String, String> {
    Ok(uuid::Uuid::new_v4().to_string())
}

// ---------------------------------------------------------------------------
// base64_encode / base64_decode
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn base64_encode(input: String) -> Result<String, String> {
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(input.as_bytes()))
}

#[tauri::command]
pub async fn base64_decode(input: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.trim().as_bytes())
        .map_err(|e| format!("base64_decode: invalid base64: {e}"))?;
    String::from_utf8(bytes)
        .map_err(|e| format!("base64_decode: not valid UTF-8: {e}"))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn regex_match_and_replace() {
        let out = regex_match(
            "foo123 bar456".into(),
            r"\d+".into(),
            Some(true),
        )
        .await
        .unwrap();
        assert!(out.contains("123") && out.contains("456"), "got {out}");

        let out = regex_replace(
            "foo123".into(),
            r"\d+".into(),
            "XXX".into(),
        )
        .await
        .unwrap();
        assert_eq!(out, "fooXXX");
    }

    #[tokio::test]
    async fn json_query_paths() {
        let blob = r#"{"a":{"b":[{"c":7},{"c":8}]}}"#.to_string();

        let out = json_query(blob.clone(), "$.a.b[0].c".into()).await.unwrap();
        assert_eq!(out.trim(), "7");

        let out = json_query(blob.clone(), "a.b[1].c".into()).await.unwrap();
        assert_eq!(out.trim(), "8");

        let err = json_query(blob, "$.a.nope".into()).await.unwrap_err();
        assert!(err.contains("no key"), "got {err}");
    }

    #[tokio::test]
    async fn hash_text_known_values() {
        let out = hash_text("abc".into(), "sha256".into()).await.unwrap();
        assert_eq!(
            out,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let out = hash_text("abc".into(), "sha1".into()).await.unwrap();
        assert_eq!(out, "a9993e364706816aba3e25717850c26c9cd0d89d");
        let out = hash_text("abc".into(), "md5".into()).await.unwrap();
        assert_eq!(out, "900150983cd24fb0d6963f7d28e17f72");
    }

    #[tokio::test]
    async fn uuid_new_is_valid() {
        let u = uuid_new().await.unwrap();
        assert_eq!(u.len(), 36);
        assert_eq!(u.as_bytes()[8], b'-');
    }

    #[tokio::test]
    async fn base64_roundtrip() {
        let enc = base64_encode("hello world".into()).await.unwrap();
        assert_eq!(enc, "aGVsbG8gd29ybGQ=");
        let dec = base64_decode(enc).await.unwrap();
        assert_eq!(dec, "hello world");
    }

}
