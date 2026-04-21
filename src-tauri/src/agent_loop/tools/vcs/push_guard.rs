//! Push guard — prevents accidental pushes to `main`/`master`.
//!
//! `git_push` calls `check_push_target` before touching the network.
//! Pushing to `main` or `master` is treated as L5 and requires the
//! caller to set `confirm_main_push` to the exact passphrase.

use serde_json::Value;

/// Passphrase the user must supply to push to a protected branch.
const REQUIRED_PASSPHRASE: &str = "I confirm push to main";

/// Protected branch names (case-insensitive).
const PROTECTED: &[&str] = &["main", "master"];

/// Returns `Ok(())` if the push is safe to proceed, `Err` with a
/// human-readable message if the user must supply explicit confirmation
/// (or if they supplied it incorrectly).
pub fn check_push_target(branch: &str, input: &Value) -> Result<(), String> {
    let branch_lower = branch.to_ascii_lowercase();
    let is_protected = PROTECTED
        .iter()
        .any(|p| branch_lower == *p);

    if !is_protected {
        return Ok(());
    }

    let passphrase = input
        .get("confirm_main_push")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if passphrase == REQUIRED_PASSPHRASE {
        Ok(())
    } else {
        Err(format!(
            "Pushing to `{branch}` requires explicit confirmation. \
             Set confirm_main_push to \"{REQUIRED_PASSPHRASE}\" to proceed. \
             Review the changes carefully before re-submitting."
        ))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_protected_branch_passes() {
        assert!(check_push_target("feature/my-thing", &json!({})).is_ok());
    }

    #[test]
    fn main_without_passphrase_denied() {
        assert!(check_push_target("main", &json!({})).is_err());
    }

    #[test]
    fn master_without_passphrase_denied() {
        assert!(check_push_target("master", &json!({})).is_err());
    }

    #[test]
    fn main_with_correct_passphrase_allowed() {
        let input = json!({ "confirm_main_push": "I confirm push to main" });
        assert!(check_push_target("main", &input).is_ok());
    }

    #[test]
    fn master_with_correct_passphrase_allowed() {
        let input = json!({ "confirm_main_push": "I confirm push to main" });
        assert!(check_push_target("master", &input).is_ok());
    }

    #[test]
    fn main_with_wrong_passphrase_denied() {
        let input = json!({ "confirm_main_push": "yes" });
        assert!(check_push_target("main", &input).is_err());
    }

    #[test]
    fn case_insensitive_main_check() {
        // "Main" and "MAIN" are also protected.
        assert!(check_push_target("Main", &json!({})).is_err());
        assert!(check_push_target("MASTER", &json!({})).is_err());
    }
}
