pub fn group_thousands(s: &str) -> String {
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => ("-", r),
        None => ("", s),
    };
    let (int_part, frac_part) = match rest.find('.') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };

    // Build the grouped integer part right-to-left.
    let mut grouped = String::with_capacity(int_part.len() + int_part.len() / 3);
    for (i, ch) in int_part.chars().rev().enumerate() {
        if i != 0 && i % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let grouped: String = grouped.chars().rev().collect();
    format!("{sign}{grouped}{frac_part}")
}

/// Format an `evalexpr` numeric result as a human-friendly string with
/// thousands separators and trimmed trailing zeros.
pub fn format_number_f64(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n.is_sign_negative() { "-∞".to_string() } else { "∞".to_string() };
    }
    // Integers print without a decimal point.
    if n.fract() == 0.0 && n.abs() < 1e18 {
        let i = n as i64;
        return group_thousands(&i.to_string());
    }
    // Floats: up to 12 significant decimals, then trim trailing zeros.
    let raw = format!("{n:.12}");
    let trimmed = raw.trim_end_matches('0').trim_end_matches('.').to_string();
    group_thousands(&trimmed)
}

fn format_number_i128(n: i128) -> String {
    group_thousands(&n.to_string())
}

// ---------------------------------------------------------------------------
// calc — arithmetic via the `evalexpr` crate.
// ---------------------------------------------------------------------------

/// Evaluate an arithmetic expression and return the result plus a short
/// human-readable breakdown. The expression is handed to `evalexpr`
/// (a sandboxed arithmetic parser — NOT a code evaluator) after a tiny
/// rewrite pass that maps user-friendly function names (`sqrt`, `sin`,
/// `ln`, ...) to evalexpr's namespaced built-ins (`math::sqrt`, ...) and
/// turns `^` into `math::pow` so it means exponentiation instead of XOR.
#[tauri::command]
pub async fn calc(expr: String) -> Result<String, String> {
    use evalexpr::Value;

    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err("calc: expression must be non-empty".into());
    }

    let rewritten = rewrite_caret(&rewrite_functions(trimmed));

    // `evalexpr::eval` is a pure math parser: + - * / %, parens, comparisons,
    // and namespaced built-ins like `math::sqrt`. No code execution.
    let value = evalexpr::eval(&rewritten).map_err(|e| format!("calc: {e}"))?;

    let rendered = match value {
        Value::Int(i) => format_number_i128(i as i128),
        Value::Float(f) => format_number_f64(f),
        Value::Boolean(b) => b.to_string(),
        Value::String(s) => s,
        Value::Tuple(_) | Value::Empty => {
            return Err("calc: expression produced no value".into());
        }
    };

    // Short breakdown: "expr = result" for readability.
    let display_expr = trimmed.replace('*', "×");
    if display_expr.len() <= 80 && display_expr != rendered {
        Ok(format!("{display_expr} = {rendered}"))
    } else {
        Ok(rendered)
    }
}

/// Translate bare function names like `sqrt(4)` into the `math::sqrt(4)`
/// form that evalexpr expects. We only rewrite identifiers that are
/// immediately followed by `(` so variables named `e`/`pi` stay alone.
fn rewrite_functions(input: &str) -> String {
    // Known mappings: user-facing name → evalexpr built-in.
    const MAP: &[(&str, &str)] = &[
        ("sqrt", "math::sqrt"),
        ("abs",  "math::abs"),
        ("sin",  "math::sin"),
        ("cos",  "math::cos"),
        ("tan",  "math::tan"),
        ("ln",   "math::ln"),
        ("log",  "math::log10"),
        ("exp",  "math::exp"),
        // `floor`, `ceil`, `round` exist unnamespaced in evalexpr — keep as-is.
    ];

    // Token-at-a-time pass: accumulate identifier chars, then when we hit
    // a non-identifier character check whether we should rewrite.
    let mut out = String::with_capacity(input.len() + 16);
    let mut ident = String::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_ascii_alphanumeric() || ch == '_' {
            ident.push(ch);
            i += 1;
            continue;
        }
        // End of identifier — decide whether to rewrite.
        if !ident.is_empty() {
            let replacement = if ch == '(' {
                MAP.iter()
                    .find(|(k, _)| *k == ident)
                    .map(|(_, v)| (*v).to_string())
            } else {
                None
            };
            // Also rewrite bare `pi` / `e` constants (not followed by '(').
            let const_repl = if ch != '(' {
                match ident.as_str() {
                    "pi" => Some(format!("{}", std::f64::consts::PI)),
                    "e" => Some(format!("{}", std::f64::consts::E)),
                    _ => None,
                }
            } else {
                None
            };
            out.push_str(&replacement.or(const_repl).unwrap_or(ident.clone()));
            ident.clear();
        }
        out.push(ch);
        i += 1;
    }
    if !ident.is_empty() {
        // Trailing identifier (e.g. "pi" at end of expression).
        let repl = match ident.as_str() {
            "pi" => format!("{}", std::f64::consts::PI),
            "e" => format!("{}", std::f64::consts::E),
            _ => ident.clone(),
        };
        out.push_str(&repl);
    }
    out
}

/// Rewrite `a ^ b` to `math::pow(a, b)` so evalexpr's default XOR
/// interpretation doesn't silently produce wrong answers. We walk the
/// string once, tracking nesting depth of the left operand, and wrap
/// both sides in parentheses so precedence is preserved.
fn rewrite_caret(input: &str) -> String {
    // Fast path: no caret, nothing to do.
    if !input.contains('^') {
        return input.to_string();
    }

    // Walk character-by-character, finding the left operand (the longest
    // balanced suffix of the current accumulator ending at the caret) and
    // the right operand (the longest balanced prefix of the remainder).
    // This is a simple loop until no carets remain.
    let mut s = input.to_string();
    loop {
        let Some(caret_idx) = s.find('^') else { break };
        let left = extract_left_operand(&s[..caret_idx]);
        let right = extract_right_operand(&s[caret_idx + 1..]);

        let left_start = caret_idx - left.len();
        let right_end = caret_idx + 1 + right.len();
        // `math::pow(base, exp)` — each side wrapped in its own parens so
        // operator precedence across further rewrites is preserved.
        let new = format!(
            "{prefix}math::pow(({left}),({right})){suffix}",
            prefix = &s[..left_start],
            left = left.trim(),
            right = right.trim(),
            suffix = &s[right_end..],
        );
        if new == s { break; }
        s = new;
    }
    s
}

fn extract_left_operand(left: &str) -> String {
    // Trim trailing whitespace, then walk backwards collecting either a
    // balanced parenthesised expression or a run of identifier/digit/dot
    // characters.
    let trimmed_end = left.trim_end();
    let trailing_ws = &left[trimmed_end.len()..];
    let bytes: Vec<char> = trimmed_end.chars().collect();
    if bytes.is_empty() {
        return String::new();
    }

    if *bytes.last().unwrap() == ')' {
        // Walk back matching parens.
        let mut depth = 0i32;
        let mut start = bytes.len();
        for i in (0..bytes.len()).rev() {
            match bytes[i] {
                ')' => depth += 1,
                '(' => {
                    depth -= 1;
                    if depth == 0 {
                        start = i;
                        break;
                    }
                }
                _ => {}
            }
        }
        // Also absorb any identifier immediately to the left (for `sqrt(x)^2`).
        let mut ident_start = start;
        while ident_start > 0 {
            let ch = bytes[ident_start - 1];
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == ':' {
                ident_start -= 1;
            } else {
                break;
            }
        }
        return format!("{}{}", bytes[ident_start..].iter().collect::<String>(), trailing_ws);
    }

    // Walk back over digits, dots, and identifier chars.
    let mut start = bytes.len();
    for i in (0..bytes.len()).rev() {
        let ch = bytes[i];
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            start = i;
        } else {
            break;
        }
    }
    format!("{}{}", bytes[start..].iter().collect::<String>(), trailing_ws)
}

fn extract_right_operand(right: &str) -> String {
    let trimmed_start = right.trim_start();
    let leading_ws = &right[..right.len() - trimmed_start.len()];
    let bytes: Vec<char> = trimmed_start.chars().collect();
    if bytes.is_empty() {
        return String::new();
    }

    let mut i = 0;
    // Optional leading unary minus/plus.
    if bytes[i] == '-' || bytes[i] == '+' {
        i += 1;
    }
    if i >= bytes.len() {
        return format!("{leading_ws}{}", bytes[..i].iter().collect::<String>());
    }

    if bytes[i] == '(' {
        let mut depth = 0i32;
        while i < bytes.len() {
            match bytes[i] {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
        return format!("{leading_ws}{}", bytes[..i].iter().collect::<String>());
    }

    // identifier possibly followed by a call: `sqrt(x)`
    while i < bytes.len() {
        let ch = bytes[i];
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == ':' {
            i += 1;
        } else {
            break;
        }
    }
    if i < bytes.len() && bytes[i] == '(' {
        let mut depth = 0i32;
        while i < bytes.len() {
            match bytes[i] {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }
    format!("{leading_ws}{}", bytes[..i].iter().collect::<String>())
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn calc_basic_arithmetic() {
        let out = calc("2 + 2".into()).await.unwrap();
        assert!(out.ends_with("= 4"), "got {out}");

        let out = calc("100 * 1000".into()).await.unwrap();
        assert!(out.ends_with("= 100,000"), "got {out}");

        let out = calc("2^10".into()).await.unwrap();
        assert!(out.ends_with("= 1,024"), "got {out}");
    }

    #[tokio::test]
    async fn calc_functions() {
        let out = calc("sqrt(16)".into()).await.unwrap();
        assert!(out.ends_with("= 4"), "got {out}");

        let out = calc("round(3.7)".into()).await.unwrap();
        assert!(out.ends_with("= 4"), "got {out}");
    }

    #[tokio::test]
    async fn calc_big_multiplication() {
        let out = calc("123 * 456".into()).await.unwrap();
        assert!(out.contains("56,088"), "got {out}");
    }

    #[test]
    fn group_thousands_cases() {
        assert_eq!(group_thousands("1000"), "1,000");
        assert_eq!(group_thousands("-1234567"), "-1,234,567");
        assert_eq!(group_thousands("12.345678"), "12.345678");
        assert_eq!(group_thousands("-12345.6"), "-12,345.6");
    }
}
