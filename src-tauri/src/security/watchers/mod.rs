//! Background watchers that feed the SecurityBus.
//!
//! Each watcher lives in its own file. `start_all` kicks them off at
//! boot from `startup::setup` — individual watchers log and skip if
//! their prerequisites are missing (no `osascript`, no LaunchAgents
//! dir, etc.) rather than panicking the setup hook.

pub mod codesign;
pub mod launch_agents;
pub mod login_items;
pub mod perm_poll;
pub mod process_tree;

use tauri::AppHandle;

/// Start every background watcher. Safe to call more than once — each
/// watcher guards itself behind a OnceLock.
pub fn start_all(app: AppHandle) {
    launch_agents::start(app.clone());
    login_items::start(app.clone());
    perm_poll::start(app.clone());
    process_tree::start(app);
}
