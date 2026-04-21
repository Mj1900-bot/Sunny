//! Settings snapshot for the ambient watcher.
//!
//! Read fresh on every tick so toggles take immediate effect without a restart.
//! All errors are swallowed; conservative defaults are used when parsing fails.

use crate::ambient_classifier::DEFAULT_AMBIENT_MODEL;
use crate::settings;

use super::rules::{COMPOUND_BATTERY_PCT, COMPOUND_FOCUS_BATTERY_PCT};

// ---------------------------------------------------------------------------
// Constants owned by settings (defaults / limits)
// ---------------------------------------------------------------------------

/// Default mail-unread threshold if no user override in settings.
pub(super) const MAIL_UNREAD_DEFAULT: i64 = 20;

// ---------------------------------------------------------------------------
// Struct
// ---------------------------------------------------------------------------

/// Settings snapshot, read fresh on every tick so toggles take immediate
/// effect without a restart. Swallows all errors; conservative defaults when
/// parsing fails.
#[derive(Clone, Debug)]
pub(super) struct AmbientSettings {
    pub(super) enabled: bool,
    pub(super) mail_threshold: i64,
    /// Battery % threshold for the **meeting+battery** compound rule. If the
    /// user hasn't set `ambient_battery_threshold` in settings we fall back
    /// to `COMPOUND_BATTERY_PCT` (25%) — the historical hardcoded value.
    pub(super) battery_threshold_pct: f64,
    /// Battery % threshold for the **focus+battery** compound rule. If the
    /// user hasn't set `ambient_focus_battery_threshold` in settings we fall
    /// back to `COMPOUND_FOCUS_BATTERY_PCT` (20%) — the historical hardcoded
    /// value.
    pub(super) focus_battery_threshold_pct: f64,
    /// When true, also fire the OS-native `notify::notify(...)` in addition
    /// to the in-HUD toast. Default is **false** — HUD-only — because the
    /// user's Calendar.app / Mail.app already emit their own native
    /// notifications; stacking a third native notification from us creates
    /// duplicate-surface spam. See the module-level doc.
    pub(super) native_notify: bool,
    /// Ollama model tag used for compound-signal intent classification.
    /// When absent from `settings.json::ambientModel` we fall back to
    /// `DEFAULT_AMBIENT_MODEL` — currently `qwen2.5:0.5b-instruct`. The
    /// model MUST already be pulled; a missing model surfaces as an
    /// Ollama error and the rule-based compound path takes over.
    pub(super) ambient_model: String,
}

impl Default for AmbientSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            mail_threshold: MAIL_UNREAD_DEFAULT,
            battery_threshold_pct: COMPOUND_BATTERY_PCT,
            focus_battery_threshold_pct: COMPOUND_FOCUS_BATTERY_PCT,
            native_notify: false,
            ambient_model: DEFAULT_AMBIENT_MODEL.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

pub(super) fn load_settings() -> AmbientSettings {
    let defaults = AmbientSettings::default();
    let Ok(value) = settings::load() else { return defaults };
    let Some(obj) = value.as_object() else { return defaults };

    let enabled = obj
        .get("ambient_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(defaults.enabled);

    let mail_threshold = obj
        .get("ambient_mail_threshold")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .unwrap_or(defaults.mail_threshold);

    // Battery thresholds are optional (backward compat): if absent, keep the
    // historical hardcoded constants. Clamp to (0, 100] so a malformed 0 or
    // negative value can't disable the trigger entirely.
    let battery_threshold_pct = obj
        .get("ambient_battery_threshold")
        .and_then(|v| v.as_f64())
        .filter(|n| *n > 0.0 && *n <= 100.0)
        .unwrap_or(defaults.battery_threshold_pct);

    let focus_battery_threshold_pct = obj
        .get("ambient_focus_battery_threshold")
        .and_then(|v| v.as_f64())
        .filter(|n| *n > 0.0 && *n <= 100.0)
        .unwrap_or(defaults.focus_battery_threshold_pct);

    let native_notify = obj
        .get("ambient_native_notify")
        .and_then(|v| v.as_bool())
        .unwrap_or(defaults.native_notify);

    // Settings key is `ambientModel` (camelCase to match the existing
    // `~/.sunny/settings.json` convention for user-facing keys; compare
    // `pushToTalkKey`, `wakePhrase`, etc.). Snake_case `ambient_model`
    // is also accepted so power users who edited ambient_native_notify
    // next door don't get tripped up by the inconsistency.
    let ambient_model = obj
        .get("ambientModel")
        .or_else(|| obj.get("ambient_model"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(defaults.ambient_model);

    AmbientSettings {
        enabled,
        mail_threshold,
        battery_threshold_pct,
        focus_battery_threshold_pct,
        native_notify,
        ambient_model,
    }
}

/// Parse an `AmbientSettings` from a raw JSON `Value`. Extracted from
/// `load_settings` so tests can drive the parse logic without touching
/// `$HOME`. Production code calls `load_settings()` directly.
pub(super) fn parse_settings(value: serde_json::Value) -> AmbientSettings {
    let defaults = AmbientSettings::default();
    let Some(obj) = value.as_object() else { return defaults };

    let enabled = obj
        .get("ambient_enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(defaults.enabled);

    let mail_threshold = obj
        .get("ambient_mail_threshold")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .unwrap_or(defaults.mail_threshold);

    let battery_threshold_pct = obj
        .get("ambient_battery_threshold")
        .and_then(|v| v.as_f64())
        .filter(|n| *n > 0.0 && *n <= 100.0)
        .unwrap_or(defaults.battery_threshold_pct);

    let focus_battery_threshold_pct = obj
        .get("ambient_focus_battery_threshold")
        .and_then(|v| v.as_f64())
        .filter(|n| *n > 0.0 && *n <= 100.0)
        .unwrap_or(defaults.focus_battery_threshold_pct);

    let native_notify = obj
        .get("ambient_native_notify")
        .and_then(|v| v.as_bool())
        .unwrap_or(defaults.native_notify);

    let ambient_model = obj
        .get("ambientModel")
        .or_else(|| obj.get("ambient_model"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(defaults.ambient_model);

    AmbientSettings {
        enabled,
        mail_threshold,
        battery_threshold_pct,
        focus_battery_threshold_pct,
        native_notify,
        ambient_model,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ambient::rules::{COMPOUND_BATTERY_PCT, COMPOUND_FOCUS_BATTERY_PCT};
    use serde_json::json;

    // ── defaults when file is missing (Null value) ────────────────────────

    #[test]
    fn load_settings_defaults_when_value_is_null() {
        let s = parse_settings(serde_json::Value::Null);
        assert!(s.enabled, "kill-switch defaults to on");
        assert_eq!(s.mail_threshold, MAIL_UNREAD_DEFAULT);
        assert_eq!(s.battery_threshold_pct, COMPOUND_BATTERY_PCT);
        assert_eq!(s.focus_battery_threshold_pct, COMPOUND_FOCUS_BATTERY_PCT);
        assert!(!s.native_notify, "native notify defaults to false (HUD-only)");
        assert!(!s.ambient_model.is_empty(), "ambient model has a non-empty default");
    }

    #[test]
    fn load_settings_defaults_when_value_is_empty_object() {
        let s = parse_settings(json!({}));
        assert!(s.enabled);
        assert_eq!(s.mail_threshold, MAIL_UNREAD_DEFAULT);
    }

    // ── each known key is parsed ──────────────────────────────────────────

    #[test]
    fn parses_ambient_enabled_false() {
        let s = parse_settings(json!({ "ambient_enabled": false }));
        assert!(!s.enabled);
    }

    #[test]
    fn parses_ambient_enabled_true() {
        let s = parse_settings(json!({ "ambient_enabled": true }));
        assert!(s.enabled);
    }

    #[test]
    fn parses_ambient_mail_threshold() {
        let s = parse_settings(json!({ "ambient_mail_threshold": 5 }));
        assert_eq!(s.mail_threshold, 5);
    }

    #[test]
    fn parses_ambient_battery_threshold() {
        let s = parse_settings(json!({ "ambient_battery_threshold": 40.0 }));
        assert!((s.battery_threshold_pct - 40.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_ambient_focus_battery_threshold() {
        let s = parse_settings(json!({ "ambient_focus_battery_threshold": 15.0 }));
        assert!((s.focus_battery_threshold_pct - 15.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parses_ambient_native_notify_true() {
        let s = parse_settings(json!({ "ambient_native_notify": true }));
        assert!(s.native_notify);
    }

    #[test]
    fn parses_ambient_model_camel_case_key() {
        let s = parse_settings(json!({ "ambientModel": "qwen2.5:1.5b" }));
        assert_eq!(s.ambient_model, "qwen2.5:1.5b");
    }

    #[test]
    fn parses_ambient_model_snake_case_key() {
        let s = parse_settings(json!({ "ambient_model": "llama3.2:1b" }));
        assert_eq!(s.ambient_model, "llama3.2:1b");
    }

    #[test]
    fn camel_case_key_takes_priority_over_snake_case() {
        // `ambientModel` is tried first; if both keys exist camelCase wins.
        let s = parse_settings(json!({
            "ambientModel": "camel-model",
            "ambient_model": "snake-model"
        }));
        assert_eq!(s.ambient_model, "camel-model");
    }

    // ── battery threshold clamping to (0, 100] ────────────────────────────

    #[test]
    fn battery_threshold_zero_is_clamped_to_default() {
        let s = parse_settings(json!({ "ambient_battery_threshold": 0.0 }));
        assert_eq!(s.battery_threshold_pct, COMPOUND_BATTERY_PCT,
            "0 is not in (0, 100] and must fall back to default");
    }

    #[test]
    fn battery_threshold_negative_is_clamped_to_default() {
        let s = parse_settings(json!({ "ambient_battery_threshold": -5.0 }));
        assert_eq!(s.battery_threshold_pct, COMPOUND_BATTERY_PCT);
    }

    #[test]
    fn battery_threshold_100_is_accepted() {
        let s = parse_settings(json!({ "ambient_battery_threshold": 100.0 }));
        assert!((s.battery_threshold_pct - 100.0).abs() < f64::EPSILON,
            "100.0 is within (0, 100] and must be accepted");
    }

    #[test]
    fn battery_threshold_above_100_is_clamped_to_default() {
        let s = parse_settings(json!({ "ambient_battery_threshold": 101.0 }));
        assert_eq!(s.battery_threshold_pct, COMPOUND_BATTERY_PCT,
            ">100 is not in (0, 100] and must fall back to default");
    }

    #[test]
    fn focus_battery_threshold_zero_falls_back_to_default() {
        let s = parse_settings(json!({ "ambient_focus_battery_threshold": 0.0 }));
        assert_eq!(s.focus_battery_threshold_pct, COMPOUND_FOCUS_BATTERY_PCT);
    }

    // ── empty ambient_model string is rejected ────────────────────────────

    #[test]
    fn empty_ambient_model_string_falls_back_to_default() {
        let s = parse_settings(json!({ "ambientModel": "" }));
        // An empty string passes the `as_str()` coercion but then fails
        // `.filter(|s| !s.is_empty())`, so we fall back to the default.
        assert!(!s.ambient_model.is_empty(),
            "empty string must not override the default model");
    }

    #[test]
    fn whitespace_only_ambient_model_falls_back_to_default() {
        let s = parse_settings(json!({ "ambientModel": "   " }));
        // `.trim()` collapses whitespace-only strings to "", then the
        // `.filter(|s| !s.is_empty())` guard rejects it.
        assert!(!s.ambient_model.is_empty(),
            "whitespace-only string must not override the default model");
    }

    #[test]
    fn mail_threshold_zero_falls_back_to_default() {
        // The `.filter(|n| *n > 0)` guard on mail_threshold rejects 0.
        let s = parse_settings(json!({ "ambient_mail_threshold": 0 }));
        assert_eq!(s.mail_threshold, MAIL_UNREAD_DEFAULT);
    }

    #[test]
    fn mail_threshold_negative_falls_back_to_default() {
        let s = parse_settings(json!({ "ambient_mail_threshold": -1 }));
        assert_eq!(s.mail_threshold, MAIL_UNREAD_DEFAULT);
    }
}
