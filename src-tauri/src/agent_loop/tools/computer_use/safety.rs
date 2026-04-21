//! Safety gates for computer-use tools.
//!
//! Three layers of protection before any L3 action reaches `automation.rs`:
//!
//! 1. **Coordinate clamp** — reject coords that fall outside the primary
//!    display bounds.  Fetched once from `automation::get_screen_size()` and
//!    cached in an `OnceLock` so normal usage pays zero overhead after the
//!    first call.
//!
//! 2. **Dangerous-app block-list** — clicking/typing into Terminal, Keychain,
//!    Password managers, or System Settings is blocked unless the caller
//!    supplies an L5 confirmation token (`force: true`).
//!
//! 3. **Rate limiter** — max 10 click/type/drag events per 10 s, implemented
//!    with an `AtomicU64` timestamp window + `AtomicU32` count.  Prevents
//!    runaway agent loops from generating hundreds of automated actions.

use std::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Screen-bounds cache
// ---------------------------------------------------------------------------

// Atomic so callers (and tests) can re-set bounds if the display changes.
// `0` means "not yet populated"; `validate_coords` treats that as allow.
static SCREEN_W: AtomicI32 = AtomicI32::new(0);
static SCREEN_H: AtomicI32 = AtomicI32::new(0);

/// Populate the screen-bounds cache.  Called once by `screen_capture` before
/// any coordinate validation is needed; safe to call multiple times
/// (subsequent calls overwrite — useful for display changes and tests).
pub fn set_screen_bounds(w: i32, h: i32) {
    SCREEN_W.store(w, Ordering::Relaxed);
    SCREEN_H.store(h, Ordering::Relaxed);
}

/// Validate that `(x, y)` is inside the cached screen bounds.
///
/// Returns `Err` with a descriptive message on failure.  If the cache has not
/// been populated yet we allow the coords and rely on the OS to reject out-
/// of-range input events gracefully — this avoids a chicken-and-egg startup
/// issue.
pub fn validate_coords(x: i32, y: i32) -> Result<(), String> {
    let w = SCREEN_W.load(Ordering::Relaxed);
    let h = SCREEN_H.load(Ordering::Relaxed);
    if w <= 0 || h <= 0 {
        return Ok(()); // bounds not yet known — allow and let the OS clamp
    }
    if x < 0 || y < 0 || x >= w || y >= h {
        return Err(format!(
            "coordinates ({x},{y}) are outside screen bounds ({w}x{h})"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dangerous-app block-list
// ---------------------------------------------------------------------------

/// Apps where computer-use actions are blocked without an explicit L5 override
/// (`force: true`).  Matched case-insensitively against the frontmost app name
/// or bundle-id returned by `ax::focused_app`.
const DANGEROUS_APPS: &[&str] = &[
    // Terminal emulators
    "terminal",
    "iterm",
    "iterm2",
    "alacritty",
    "warp",
    "kitty",
    "hyper",
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "dev.warp.warp-stable",
    // Keychain / secrets
    "keychain access",
    "com.apple.keychainaccess",
    "1password",
    "com.agilebits.onepassword",
    "bitwarden",
    "com.bitwarden.desktop",
    "dashlane",
    "lastpass",
    "keeper",
    // System Settings
    "system settings",
    "system preferences",
    "com.apple.systempreferences",
    // Security & privacy
    "security agent",
    "com.apple.securityagent",
];

/// Return `true` if `app_name` or `bundle_id` matches a dangerous app and no
/// `force` override is present.
pub fn is_blocked_app(app_name: &str, bundle_id: Option<&str>, force: bool) -> bool {
    if force {
        return false;
    }
    let name_lower = app_name.to_ascii_lowercase();
    let bid_lower = bundle_id
        .unwrap_or("")
        .to_ascii_lowercase();

    DANGEROUS_APPS
        .iter()
        .any(|&blocked| name_lower.contains(blocked) || bid_lower.contains(blocked))
}

// ---------------------------------------------------------------------------
// Rate limiter — max 10 interactive actions per 10 s
// ---------------------------------------------------------------------------

const RATE_WINDOW_SECS: u64 = 10;
const RATE_MAX_ACTIONS: u32 = 10;

/// Epoch-second timestamp of the start of the current rate window.
static RATE_WINDOW_START: AtomicU64 = AtomicU64::new(0);
/// Count of interactive actions taken in the current window.
static RATE_COUNTER: AtomicU32 = AtomicU32::new(0);

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Attempt to consume one slot in the rate-limit window.
///
/// Returns `Ok(())` if within budget, `Err(…)` if the window is exhausted.
/// Thread-safe via relaxed atomic operations — individual window boundaries
/// may be off by one action under concurrent access, which is acceptable.
pub fn rate_limit_check() -> Result<(), String> {
    let now = epoch_secs();
    let window_start = RATE_WINDOW_START.load(Ordering::Relaxed);

    if now >= window_start + RATE_WINDOW_SECS {
        // New window — reset.  A tiny race here is acceptable.
        RATE_WINDOW_START.store(now, Ordering::Relaxed);
        RATE_COUNTER.store(1, Ordering::Relaxed);
        return Ok(());
    }

    let prev = RATE_COUNTER.fetch_add(1, Ordering::Relaxed);
    if prev >= RATE_MAX_ACTIONS {
        // Undo the increment so the count doesn't drift past the cap.
        RATE_COUNTER.fetch_sub(1, Ordering::Relaxed);
        return Err(format!(
            "rate limit: max {RATE_MAX_ACTIONS} interactive actions per {RATE_WINDOW_SECS}s \
             — wait {} s and try again",
            RATE_WINDOW_SECS - (now - window_start)
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests — pure helpers, no I/O, no display required
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Coordinate tests mutate shared global atomics (`SCREEN_W` / `SCREEN_H`).
    // Rust runs tests in parallel, so without serialization one test's
    // `set_screen_bounds` can race with another's `validate_coords` call and
    // produce false pass/fail results.  This mutex funnels all coord tests
    // through a single critical section.
    static COORD_TEST_LOCK: Mutex<()> = Mutex::new(());

    // ------------------------------------------------------------------
    // Coordinate validation
    // ------------------------------------------------------------------

    #[test]
    fn valid_coords_pass_when_bounds_set() {
        let _guard = COORD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_screen_bounds(2560, 1440);
        assert!(validate_coords(0, 0).is_ok());
        assert!(validate_coords(2559, 1439).is_ok());
        assert!(validate_coords(1280, 720).is_ok());
    }

    #[test]
    fn negative_coords_are_rejected() {
        let _guard = COORD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_screen_bounds(2560, 1440);
        assert!(validate_coords(-1, 0).is_err());
        assert!(validate_coords(0, -1).is_err());
        assert!(validate_coords(-100, -200).is_err());
    }

    #[test]
    fn coords_at_or_beyond_screen_edge_are_rejected() {
        let _guard = COORD_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_screen_bounds(1920, 1080);
        assert!(validate_coords(1920, 0).is_err());
        assert!(validate_coords(0, 1080).is_err());
        assert!(validate_coords(2000, 900).is_err());
    }

    // ------------------------------------------------------------------
    // Dangerous-app detection
    // ------------------------------------------------------------------

    #[test]
    fn terminal_is_blocked_by_name() {
        assert!(is_blocked_app("Terminal", None, false));
        assert!(is_blocked_app("iTerm2", None, false));
        assert!(is_blocked_app("Warp", None, false));
    }

    #[test]
    fn terminal_is_blocked_by_bundle_id() {
        assert!(is_blocked_app("Some App", Some("com.apple.Terminal"), false));
        assert!(is_blocked_app("App", Some("com.googlecode.iTerm2"), false));
    }

    #[test]
    fn password_manager_is_blocked() {
        assert!(is_blocked_app("1Password", None, false));
        assert!(is_blocked_app("Bitwarden", None, false));
        assert!(is_blocked_app("Keychain Access", None, false));
    }

    #[test]
    fn system_settings_is_blocked() {
        assert!(is_blocked_app("System Settings", None, false));
        assert!(is_blocked_app("System Preferences", None, false));
    }

    #[test]
    fn safe_apps_are_not_blocked() {
        assert!(!is_blocked_app("Safari", Some("com.apple.Safari"), false));
        assert!(!is_blocked_app("Finder", None, false));
        assert!(!is_blocked_app("TextEdit", None, false));
    }

    #[test]
    fn force_flag_bypasses_block() {
        assert!(!is_blocked_app("Terminal", None, true));
        assert!(!is_blocked_app("1Password", None, true));
    }

    // ------------------------------------------------------------------
    // Rate limiter
    // ------------------------------------------------------------------

    #[test]
    fn rate_limiter_allows_up_to_max_actions() {
        // Reset rate state to a fresh window by advancing the clock offset.
        // We can't mock time, so we reset the counters directly via the
        // atomics — the functions are private, so we use the public API and
        // accept a thin coupling here.
        RATE_WINDOW_START.store(epoch_secs(), Ordering::Relaxed);
        RATE_COUNTER.store(0, Ordering::Relaxed);

        for _ in 0..RATE_MAX_ACTIONS {
            assert!(rate_limit_check().is_ok());
        }
        // 11th action should be rejected.
        assert!(rate_limit_check().is_err());
    }
}
