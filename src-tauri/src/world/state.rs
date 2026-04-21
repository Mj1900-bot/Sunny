//! Process-wide world-state cell + the public `current()` / `start()` API.

use std::sync::{Arc, Mutex, OnceLock};

use tauri::AppHandle;

use super::model::{SCHEMA_VERSION, WorldState};
use super::persist::load_from_disk;
use super::updater::run_updater;

fn state_cell() -> &'static Mutex<Arc<WorldState>> {
    static CELL: OnceLock<Mutex<Arc<WorldState>>> = OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(Arc::new(WorldState {
            schema_version: SCHEMA_VERSION,
            ..WorldState::default()
        }))
    })
}

pub(super) fn set_state(s: WorldState) {
    if let Ok(mut guard) = state_cell().lock() {
        *guard = Arc::new(s);
    }
}

pub(super) fn get_arc() -> Arc<WorldState> {
    state_cell().lock().map(|g| g.clone()).unwrap_or_else(|p| p.into_inner().clone())
}

/// Current snapshot. Cheap — returns a clone of the Arc. If the updater
/// hasn't run yet, returns a default state so callers never see None.
pub fn current() -> WorldState {
    let arc = state_cell().lock().map(|g| g.clone()).unwrap_or_else(|p| p.into_inner().clone());
    (*arc).clone()
}

/// Tracks whether `start` has been invoked. The OnceLock inside
/// `state_cell()` only guards the state singleton — without this separate
/// guard, every call to `start` would spawn another `run_updater` task
/// (racing writes, duplicate events, duplicate disk persist). Re-init
/// paths (tests, soft reload) rely on this to stay idempotent.
static STARTED: OnceLock<()> = OnceLock::new();

/// Try to claim the right to spawn the updater. Returns `true` exactly
/// once per process; every subsequent caller gets `false`. Extracted so
/// tests can exercise the guard without constructing a real `AppHandle`.
fn claim_start_slot() -> bool {
    STARTED.set(()).is_ok()
}

/// Start the background updater. Idempotent — the first call spawns the
/// ticker; subsequent calls return early because `STARTED` has been set.
/// Call from `tauri::Builder::setup`.
pub fn start(app: AppHandle) {
    // Guard: only the first caller proceeds past this line.
    if !claim_start_slot() {
        return;
    }

    // Trigger the OnceLock init (creates the empty state) so `current()`
    // returns something sensible before the first tick lands.
    let _ = state_cell();

    // Restore last-known world from disk if present — makes the first few
    // seconds after launch feel "warm" (focused app / upcoming event /
    // unread count appear before the updater finishes its first poll).
    if let Some(prev) = load_from_disk() {
        set_state(prev);
    }

    tauri::async_runtime::spawn(async move {
        run_updater(app).await;
    });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/// Overwrite just the  field in the process-global world state.
/// Only compiled in test builds. Lets integration tests drive the
/// attended / unattended distinction without starting the full Tauri stack.
#[cfg(test)]
pub fn set_idle_secs_for_test(secs: i64) {
    let prev = current();
    set_state(WorldState { idle_secs: secs, ..prev });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The guard should allow exactly one `start()` call per process to
    /// proceed to the `run_updater` spawn. We exercise the guard directly
    /// because constructing a real `AppHandle` in a unit test is awkward
    /// and the spawn branch is unreachable in unit-test context anyway.
    #[test]
    fn start_spawns_updater_at_most_once() {
        // The STARTED cell is process-wide, so other tests in this binary
        // may have already claimed the slot. Either way, only one caller
        // in the entire process can observe `true` — hence at most one
        // `tauri::async_runtime::spawn(run_updater)` ever fires.
        let first = claim_start_slot();
        let second = claim_start_slot();
        let third = claim_start_slot();

        // Count how many "winners" we saw. If another test won earlier,
        // all three are false. If we won the race, exactly one is true.
        let winners = [first, second, third].iter().filter(|b| **b).count();
        assert!(
            winners <= 1,
            "claim_start_slot() returned true more than once ({} winners)",
            winners
        );

        // And the slot must now be permanently claimed — a fresh attempt
        // after our three calls must be false, proving the guard is
        // sticky across the entire process lifetime.
        assert!(
            !claim_start_slot(),
            "STARTED slot is not sticky — a fourth attempt succeeded"
        );
    }
}
