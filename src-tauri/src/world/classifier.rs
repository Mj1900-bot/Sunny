//! Activity classifier — pure function of focus + timing context.
//!
//! Maps a focused app to an activity bucket. This is the "what's the user
//! doing" signal the agent sees in its context pack. Exposed separately
//! from the updater so it's unit-testable without any runtime.

use super::model::{Activity, FocusSnapshot, WorldState};

// Activity is idle if no focus change in this window.
const IDLE_AFTER_SECS: i64 = 15 * 60;

/// Map a focused app to an activity bucket.
pub fn classify_activity(
    focus: Option<&FocusSnapshot>,
    now_s: i64,
    prev: &WorldState,
) -> Activity {
    // Idle heuristic: no focus change for IDLE_AFTER_SECS AND nothing that
    // implies active media consumption.
    if let Some(f) = focus {
        let dwell = now_s.saturating_sub(f.focused_since_secs);
        let by_focus = classify_by_focus(f);
        if dwell > IDLE_AFTER_SECS && !matches!(by_focus, Activity::Meeting | Activity::Media) {
            // Very long uninterrupted focus on a non-media app — user is
            // probably away from keyboard. (A multi-hour Xcode session
            // without Cmd-Tab is unusual enough to flag as idle.)
            Activity::Idle
        } else {
            by_focus
        }
    } else {
        // Fall back to previous activity rather than hard-resetting to
        // Unknown on a transient permission failure.
        if matches!(prev.activity, Activity::Unknown) {
            Activity::Unknown
        } else {
            prev.activity.clone()
        }
    }
}

pub(super) fn classify_by_focus(f: &FocusSnapshot) -> Activity {
    let id_lower = f.bundle_id.as_deref().unwrap_or("").to_ascii_lowercase();
    let name_lower = f.app_name.to_ascii_lowercase();
    let title_lower = f.window_title.to_ascii_lowercase();

    let any = |subs: &[&str]| -> bool {
        subs.iter()
            .any(|s| id_lower.contains(s) || name_lower.contains(s))
    };

    // Meeting — either a first-party conferencing app, or a browser tab
    // whose title contains a meeting signal.
    if any(&[
        "zoom.us",
        "us.zoom.xos",
        "us.zoom",
        "msteams",
        "microsoft teams",
        "facetime",
        "webex",
        "whereby",
        "around",
    ]) {
        return Activity::Meeting;
    }
    if title_lower.contains("meet.google.com")
        || title_lower.contains(" - zoom meeting")
        || title_lower.contains("jitsi meet")
    {
        return Activity::Meeting;
    }

    // Terminal first — some terminals (iTerm) pass "editor-ish" substring
    // checks if we aren't careful.
    if any(&[
        "iterm", "iterm2", "ghostty", "warp", "alacritty", "kitty",
        "apple.terminal", "term.app",
    ]) {
        return Activity::Terminal;
    }

    // Coding / IDE
    if any(&[
        "xcode",
        "cursor",
        "visualstudio",
        "vscode",
        "code",
        "sublime",
        "nova",
        "textmate",
        "jetbrains",
        "intellij",
        "pycharm",
        "webstorm",
        "android.studio",
        "rust-rover",
        "zed",
        "neovim",
    ]) {
        return Activity::Coding;
    }

    // Design
    if any(&[
        "figma",
        "sketch",
        "adobe",
        "blender",
        "procreate",
        "affinity",
        "omnigraffle",
    ]) {
        return Activity::Designing;
    }

    // Writing / notes
    if any(&[
        "pages",
        "word",
        "notion",
        "obsidian",
        "bear",
        "ia.writer",
        "typora",
        "ulysses",
        "scrivener",
        "logseq",
        "craft",
    ]) {
        return Activity::Writing;
    }

    // Communication
    if any(&[
        "messages",
        "mail.mailcli",
        "com.apple.mail",
        "slack",
        "discord",
        "telegram",
        "signal",
        "whatsapp",
        "mailmate",
        "airmail",
    ]) {
        return Activity::Communicating;
    }

    // Media
    if any(&[
        "spotify",
        "apple.music",
        "itunes",
        "apple.tv",
        "vlc",
        "quicktime",
        "infuse",
        "plex",
        "netflix",
    ]) {
        return Activity::Media;
    }

    // Browser — check LAST because lots of browser-hosted apps (Figma Web,
    // Linear, Gmail, GitHub) should be classified by their title, which
    // would require OCR / DOM access we don't have. Plain browser is the
    // fallback rather than the default.
    if any(&[
        "safari",
        "chrome",
        "arc",
        "firefox",
        "edgemac",
        "brave",
        "orion",
        "vivaldi",
    ]) {
        return Activity::Browsing;
    }

    Activity::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::model::{Activity, FocusSnapshot, WorldState};

    // Helper: build a minimal WorldState with the given activity.
    fn prev_state(activity: Activity) -> WorldState {
        WorldState {
            activity,
            ..WorldState::default()
        }
    }

    // Helper: build a FocusSnapshot focused on a given app since `focused_since_secs`.
    fn focus(app_name: &str, bundle_id: Option<&str>, focused_since_secs: i64) -> FocusSnapshot {
        FocusSnapshot {
            app_name: app_name.to_string(),
            bundle_id: bundle_id.map(String::from),
            window_title: String::new(),
            focused_since_secs,
        }
    }

    // -----------------------------------------------------------------------
    // classify_activity — idle / no-focus paths
    // -----------------------------------------------------------------------

    #[test]
    fn empty_world_no_focus_unknown_prev_stays_unknown() {
        // With no focus snapshot and prev=Unknown → Unknown (not Idle).
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(None, 1_000_000, &prev);
        assert_eq!(result, Activity::Unknown);
    }

    #[test]
    fn no_focus_with_non_unknown_prev_returns_prev() {
        // A transient focus-reading failure should fall back to the previous
        // activity rather than hard-resetting.
        let prev = prev_state(Activity::Coding);
        let result = classify_activity(None, 1_000_000, &prev);
        assert_eq!(result, Activity::Coding);
    }

    // -----------------------------------------------------------------------
    // classify_activity — Working (Coding / Terminal) paths
    // -----------------------------------------------------------------------

    #[test]
    fn vscode_focus_classifies_as_coding() {
        let f = focus("Visual Studio Code", Some("com.microsoft.vscode"), 1_000_000);
        let prev = prev_state(Activity::Unknown);
        // Use a now_s very close to focused_since_secs (dwell < IDLE_AFTER_SECS).
        let result = classify_activity(Some(&f), 1_000_000 + 60, &prev);
        assert_eq!(result, Activity::Coding);
    }

    #[test]
    fn xcode_focus_classifies_as_coding() {
        let f = focus("Xcode", Some("com.apple.dt.xcode"), 1_000_000);
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(Some(&f), 1_000_000 + 120, &prev);
        assert_eq!(result, Activity::Coding);
    }

    #[test]
    fn iterm2_focus_classifies_as_terminal() {
        let f = focus("iTerm2", Some("com.googlecode.iterm2"), 1_000_000);
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(Some(&f), 1_000_000 + 30, &prev);
        assert_eq!(result, Activity::Terminal);
    }

    // -----------------------------------------------------------------------
    // classify_activity — Media / Relaxing path
    // -----------------------------------------------------------------------

    #[test]
    fn spotify_focus_classifies_as_media() {
        let f = focus("Spotify", Some("com.spotify.client"), 1_000_000);
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(Some(&f), 1_000_000 + 300, &prev);
        assert_eq!(result, Activity::Media);
    }

    #[test]
    fn media_app_is_not_idle_even_after_long_dwell() {
        // Media is excluded from the idle-after-long-dwell heuristic.
        let f = focus("Spotify", Some("com.spotify.client"), 0);
        let prev = prev_state(Activity::Unknown);
        // now_s far beyond IDLE_AFTER_SECS (15 min = 900s).
        let result = classify_activity(Some(&f), 3600, &prev);
        assert_eq!(result, Activity::Media, "media should never be classified Idle");
    }

    // -----------------------------------------------------------------------
    // classify_activity — idle heuristic
    // -----------------------------------------------------------------------

    #[test]
    fn long_non_media_dwell_classifies_as_idle() {
        // A non-media app focused for > 15 minutes → Idle.
        let f = focus("Notes", Some("com.apple.Notes"), 0);
        let prev = prev_state(Activity::Unknown);
        // 16 minutes of dwell > IDLE_AFTER_SECS (15 min = 900 s).
        let result = classify_activity(Some(&f), 16 * 60, &prev);
        assert_eq!(result, Activity::Idle);
    }

    // -----------------------------------------------------------------------
    // classify_activity — Meeting path
    // -----------------------------------------------------------------------

    #[test]
    fn zoom_focus_classifies_as_meeting() {
        let f = focus("Zoom", Some("us.zoom.xos"), 1_000_000);
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(Some(&f), 1_000_000 + 600, &prev);
        assert_eq!(result, Activity::Meeting);
    }

    #[test]
    fn meeting_is_not_idle_after_long_dwell() {
        // Meeting is also excluded from the idle heuristic.
        let f = focus("Zoom", Some("us.zoom.xos"), 0);
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(Some(&f), 3600, &prev);
        assert_eq!(result, Activity::Meeting);
    }

    // -----------------------------------------------------------------------
    // classify_activity — unknown app
    // -----------------------------------------------------------------------

    #[test]
    fn unknown_app_classifies_as_unknown() {
        let f = focus("WidgetApp", Some("com.example.widget"), 1_000_000);
        let prev = prev_state(Activity::Unknown);
        let result = classify_activity(Some(&f), 1_000_000 + 30, &prev);
        assert_eq!(result, Activity::Unknown);
    }
}
