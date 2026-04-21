//! World Model — a continuously-updated snapshot of the user's digital
//! environment, held in memory and broadcast to the frontend + read into
//! every agent context pack.
//!
//! This is the layer that turns "SUNNY can answer questions about your
//! Mac" into "SUNNY knows what you're doing right now without being
//! asked". Every agent turn pulls from here via `memory::pack::build_pack`,
//! so the model's system prompt always contains a concrete answer to:
//!
//!   - What's the user doing? (focus + activity classifier)
//!   - What's coming up? (next calendar event)
//!   - What needs attention? (mail unread count)
//!   - How's the machine? (battery, cpu, temp)
//!   - What just changed? (recent app switches)
//!
//! Architecture:
//!   * **State**: a `WorldState` struct behind a `Mutex<Arc<WorldState>>`
//!     so readers get a cheap clone-of-Arc and writers never block readers
//!     for more than a Mutex acquire.
//!   * **Updater**: a single tokio task on a 15-second ticker. Samples
//!     fast sources every tick; slow sources (calendar, mail) every 4th.
//!   * **Focus change detection**: when the frontmost bundle id changes,
//!     emit `sunny://world.focus` and write an episodic `perception` row
//!     into the memory DB so consolidation + retrieval can mine it later.
//!   * **Persistence**: atomic debounced write to `~/.sunny/world.json`
//!     every 2 minutes (and on focus change) so a cold restart still has
//!     the last-known world until the updater's first tick lands.
//!
//! Split into submodules (keep the crate root slim):
//!   - `model`         — data model (Activity, WorldState, …)
//!   - `state`         — process-wide state cell + `current()` / `start()`
//!   - `updater`       — tick loop, samplers, focus resolver
//!   - `classifier`    — activity classifier (pure, unit-testable)
//!   - `side_effects`  — focus-change episodic row + opt-in screen OCR
//!   - `persist`       — atomic JSON read/write to `~/.sunny/world.json`
//!   - `helpers`       — time/iso utilities

mod classifier;
mod helpers;
mod model;
mod persist;
mod side_effects;
mod state;
mod updater;

pub use model::WorldState;
pub use state::{current, start};

#[cfg(test)]
pub use state::set_idle_secs_for_test;

/// Tauri command wrapper — returns the current world snapshot.
#[tauri::command]
pub fn world_get() -> WorldState {
    current()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::classifier::{classify_activity, classify_by_focus};
    use super::helpers::{iso_to_unix, now_secs};
    use super::model::{Activity, FocusSnapshot, SCHEMA_VERSION, WorldState};
    use super::side_effects::should_log_focus_change;
    use super::updater::focus_matches;

    fn focus(name: &str, bundle: Option<&str>, title: &str, since: i64) -> FocusSnapshot {
        FocusSnapshot {
            app_name: name.into(),
            bundle_id: bundle.map(|s| s.into()),
            window_title: title.into(),
            focused_since_secs: since,
        }
    }

    fn empty_prev() -> WorldState {
        WorldState {
            schema_version: SCHEMA_VERSION,
            activity: Activity::Unknown,
            ..WorldState::default()
        }
    }

    #[test]
    fn classifier_maps_ides_to_coding() {
        for (bundle, name) in [
            ("com.microsoft.VSCode", "Code"),
            ("com.todesktop.230313mzl4w4u92", "Cursor"),
            ("com.apple.dt.Xcode", "Xcode"),
            ("com.jetbrains.intellij", "IntelliJ IDEA"),
        ] {
            let f = focus(name, Some(bundle), "hello.rs", 100);
            assert_eq!(classify_by_focus(&f), Activity::Coding, "{name}");
        }
    }

    #[test]
    fn classifier_maps_terminal_before_coding() {
        // "Terminal.app" bundle must NOT fall into Coding due to the
        // "term" substring in some IDE names.
        let f = focus("Terminal", Some("com.apple.terminal"), "zsh", 0);
        assert_eq!(classify_by_focus(&f), Activity::Terminal);
        let g = focus("iTerm", Some("com.googlecode.iterm2"), "ssh", 0);
        assert_eq!(classify_by_focus(&g), Activity::Terminal);
    }

    #[test]
    fn classifier_detects_meeting_by_browser_title() {
        let f = focus(
            "Chrome",
            Some("com.google.chrome"),
            "Calendar review - Meet · meet.google.com/abc-defg-hij",
            0,
        );
        assert_eq!(classify_by_focus(&f), Activity::Meeting);
    }

    #[test]
    fn classifier_returns_unknown_for_unknown_app() {
        let f = focus("SomeObscureApp", None, "", 0);
        assert_eq!(classify_by_focus(&f), Activity::Unknown);
    }

    #[test]
    fn classifier_idle_after_very_long_dwell_on_non_media() {
        let now = 10_000_000_i64;
        let f = focus("Xcode", Some("com.apple.dt.Xcode"), "hello.rs", now - 20 * 60 * 60);
        let mut prev = empty_prev();
        prev.activity = Activity::Coding;
        assert_eq!(classify_activity(Some(&f), now, &prev), Activity::Idle);
    }

    #[test]
    fn classifier_holds_media_through_long_dwell() {
        let now = 10_000_000_i64;
        let f = focus("Spotify", Some("com.spotify.client"), "", now - 20 * 60 * 60);
        let prev = empty_prev();
        assert_eq!(classify_activity(Some(&f), now, &prev), Activity::Media);
    }

    #[test]
    fn focus_matches_by_bundle_id_when_available() {
        let a = focus("Chrome", Some("com.google.chrome"), "A", 0);
        let b = focus("Google Chrome", Some("com.google.chrome"), "B — switched tab", 0);
        assert!(focus_matches(&a, &b), "same bundle, different title/name");
    }

    #[test]
    fn focus_matches_falls_back_to_name_when_bundle_missing() {
        let a = focus("Safari", None, "", 0);
        let b = focus("safari", None, "", 0);
        assert!(focus_matches(&a, &b));
        let c = focus("Other", None, "", 0);
        assert!(!focus_matches(&a, &c));
    }

    #[test]
    fn focus_change_rate_limiter_dedupes_within_60s() {
        // The limiter is a module-level singleton; run sequentially within
        // this test's scope. Two rapid calls with same pair → second is
        // dropped.
        assert!(should_log_focus_change("A", "B"));
        assert!(!should_log_focus_change("A", "B"));
        // Different pair is allowed.
        assert!(should_log_focus_change("A", "C"));
    }

    #[test]
    fn iso_to_unix_parses_local_t_format() {
        // Can't assert an absolute value without knowing the runner's TZ,
        // but we can verify it round-trips.
        let iso = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let t = iso_to_unix(&iso).expect("parse");
        assert!((t - now_secs()).abs() < 5);
    }
}
