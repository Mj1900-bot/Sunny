//! Ambient watcher — proactively surfaces novel conditions from the world model.
//!
//! Subscribes to `sunny://world` and watches for three conservative triggers:
//!
//!   1. **Next meeting in 5-15 min window** — fires once when entering the
//!      window, gated to one fire per calendar-event id.
//!   2. **Battery < 15% AND discharging** — fires once per discharge cycle
//!      (resets after a charge event).
//!   3. **Mail unread crossed a user-configurable threshold upward** (default
//!      20) — fires once, re-arms when unread drops back below the threshold.
//!
//! Deliberately excludes focus-stable-on-new-app-for-10-min; too chatty for a
//! kill-switch rule set.
//!
//! On a trigger, we emit `sunny://ambient.notify` so frontend subscribers can
//! render a softer in-HUD chip (the unique-to-SUNNY surface). Whether we ALSO
//! fire the OS-native `notify::notify(...)` depends on:
//!
//!   - `settings.json::ambient_native_notify` (default **false**) — the user
//!     opt-in for duplicating into macOS Notification Center. Default is
//!     HUD-only because the user already has macOS Calendar/Mail.app firing
//!     their own reminders; stacking a second native notification just for
//!     our HUD toast creates triple-surface spam for the same event.
//!   - The `meeting` category is additionally **always HUD-only**, regardless
//!     of the setting, because Calendar.app fires its own alerts and we can't
//!     reliably detect whether it will (user's reminder offset could be any
//!     value, could be disabled per-calendar, etc.). HUD-only here means SUNNY
//!     adds signal rather than noise when Calendar.app is also nudging.
//!
//! Per-category cross-category floor of 10 minutes prevents stacking.
//!
//! Persistence: `~/.sunny/ambient.json` holds the last-surface timestamps and
//! last-known values across restarts so a quick app restart cannot double-fire
//! the same nudge. The file ALSO stores `last_revision` — the last
//! `WorldState.revision` we processed — so that on relaunch the bus-poller
//! path (which reads the last persisted `WorldTick` from the event bus) won't
//! re-process a tick we already surfaced last session. See the battery
//! "quit-on-battery → relaunch-on-battery" race note in `start()`.
//!
//! Kill switch: `settings.json::ambient_enabled` (default true). When false the
//! watcher still runs — it just drops every would-be surface silently so
//! toggling the setting at runtime takes effect on the next `sunny://world`
//! tick without a restart.
//!
//! ## Module layout (Phase 3 split)
//!
//! `ambient.rs` was a single flat module through Phase 2. Phase 3 split it into
//! four focused files, mirroring the `voice/` sub-module pattern introduced in
//! Phase 2. The split improved testability — `rules::evaluate` is now a pure
//! function with no I/O, so the test suite can exercise every rule branch
//! without touching disk or spawning Tauri handles.
//!
//! | File | Contents |
//! |------|----------|
//! | `mod.rs` | Daemon (`start`, `process_world`, `spawn_classifier`) + tests |
//! | `store.rs` | `AmbientDisk`, `DISK` static, `load_disk`, `save_disk`, `next_differs` |
//! | `settings.rs` | `AmbientSettings`, `load_settings`, per-setting constants |
//! | `rules.rs` | `evaluate`, `gap_ok`, `compound_gap_ok`, compound synthesis, `Surface` |

mod rules;
mod settings;
mod store;

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener};

use crate::ambient_classifier::{self, ClassifierOutcome};
use crate::event_bus::{self, SunnyEvent};
use crate::notify;
use crate::world;

use rules::{
    CAT_INTENT_PREFIX, CAT_MEETING, CLASSIFIER_COOLDOWN_SECS, INTENT_MIN_GAP_SECS,
    Surface, evaluate, now_secs,
};
use settings::load_settings;
use store::{AmbientDisk, DISK, load_disk, next_differs, save_disk};

// ---------------------------------------------------------------------------
// Revision gate (module-level static)
// ---------------------------------------------------------------------------

/// Last `WorldState.revision` we've processed via EITHER path (Tauri listener
/// or event-bus tail). Prevents double-processing when both paths deliver
/// the same tick — whichever arrives first wins, the other no-ops.
static LAST_REVISION: Mutex<u64> = Mutex::new(0);

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

/// Core processing step — shared by both the Tauri listener and the
/// event-bus tailer so the 3 surface conditions fire identically regardless
/// of which transport delivered the tick.
///
/// Returns `true` if the revision was new and was processed; `false` if it
/// was a duplicate (already handled by the other path).
fn process_world(world: &crate::world::WorldState, app: &AppHandle) -> bool {
    // Revision gate — whichever path delivers a revision first processes it;
    // the other path's later delivery is a silent no-op. `revision == 0`
    // is the pre-tick default and is not meaningful, so skip it.
    if world.revision == 0 {
        return false;
    }
    {
        let mut guard = match LAST_REVISION.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if world.revision <= *guard {
            return false;
        }
        *guard = world.revision;
    }

    let settings = load_settings();
    let now = now_secs();

    let prior = {
        let guard = match DISK.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.clone().unwrap_or_default()
    };

    let (surfaces, mut next) = evaluate(world, &prior, &settings, now);

    // Record the revision we just processed so a relaunch doesn't re-process
    // it via the bus-tail path. This is the race-fix for the battery
    // quit-on-battery → relaunch-on-battery double-fire case.
    next.last_revision = Some(world.revision);

    // --- Classifier rate gate + spawn ---------------------------------------
    //
    // The LLM-classified intent path runs asynchronously so the ambient
    // tick is NEVER blocked on Ollama. Eligibility check is
    // synchronous + cheap (one comparison) so we don't pay for the
    // classifier when it's still cooling down.
    //
    // We stamp `last_classifier_attempt = now` BEFORE spawning so a second
    // tick that arrives mid-inference sees the cooldown and skips — even
    // if the inference itself takes close to the 2 s timeout. This is the
    // key power invariant: at most one classifier future in flight.
    let classifier_eligible = settings.enabled
        && (now - prior.last_classifier_attempt) >= CLASSIFIER_COOLDOWN_SECS;
    if classifier_eligible {
        next.last_classifier_attempt = now;
    }

    // Persist state movement even when the kill switch is off so the
    // "re-arm" transitions (battery plugged in, mail dropped below) stay
    // accurate for the moment the user re-enables surfacing.
    let state_changed = next_differs(&prior, &next);
    if state_changed {
        if let Ok(mut guard) = DISK.lock() {
            *guard = Some(next.clone());
        }
        save_disk(&next);
    }

    // Spawn the classifier AFTER persisting the attempt-stamp bump so a
    // concurrent re-entry in the sibling bus-tail path sees the cooldown.
    // The spawn is fire-and-forget — its own dedupe + emit path runs
    // independently of the rule-based surfaces that were already pushed
    // above. If Ollama is unreachable, the task errors out and the rule
    // surfaces already queued below carry the day (exactly the fallback
    // contract the sprint brief calls for).
    if classifier_eligible {
        spawn_classifier(app.clone(), world.clone(), settings.ambient_model.clone());
    }

    // Kill switch — watcher runs, emits nothing.
    if !settings.enabled || surfaces.is_empty() {
        return true;
    }

    for surface in surfaces {
        // Emit the softer in-HUD event first; frontend can render a chip
        // without needing the native notification to land. This is the
        // baseline surface — unique to SUNNY, always fires when the
        // watcher is enabled.
        let _ = app.emit("sunny://ambient.notify", &surface);

        // Decide whether to ALSO fire the native OS notification. Three
        // gates:
        //   1. Kill switch already checked above.
        //   2. `ambient_native_notify` setting — default false (HUD-only)
        //      so we don't duplicate Calendar.app / Mail.app reminders.
        //   3. Meeting category is HARD-CODED HUD-only regardless of the
        //      setting: we can't reliably detect whether Calendar.app
        //      will also fire (user's reminder offset is per-event, could
        //      be any value, could be disabled). Defaulting to HUD-only
        //      guarantees no double-fire from OUR code.
        let fire_native =
            settings.native_notify && surface.category.as_str() != CAT_MEETING;
        if !fire_native {
            continue;
        }

        // Fire the native notification. Swallow errors — a failed
        // notification shouldn't block the next surface.
        let title = surface.title.clone();
        let body = surface.body.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = notify::notify(title, body, None).await {
                log::debug!("[ambient] notify failed: {e}");
            }
        });
    }

    true
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/// Subscribe to `sunny://world` and spawn the watcher. Safe to call once from
/// startup; calling twice would double-fire surfaces so don't.
///
/// Belt-and-braces: we keep the Tauri listener AND add a 30-second
/// `event_bus::tail_by_kind("WorldTick", 1)` poller. Either path processes a
/// given revision at most once, thanks to the `LAST_REVISION` gate inside
/// `process_world`. The Tauri listener can be dropped once every
/// `sunny://world` producer has been migrated to the bus.
pub fn start(app: AppHandle) {
    // Load the persisted disk state and use it to seed BOTH the in-memory
    // disk cell AND the `LAST_REVISION` gate. The revision seed is the
    // race-fix for the following scenario:
    //
    //   1. User is on battery at 10 %. We fire the "Battery low" surface
    //      and persist `last_revision = N`.
    //   2. User quits SUNNY immediately, still on battery.
    //   3. User relaunches SUNNY ~30 s later, still on battery.
    //   4. The event_bus WorldTick poller fires first, reads the LAST
    //      persisted `WorldTick` from the bus (revision N, same battery
    //      state). Without the persisted-revision seed, `LAST_REVISION`
    //      would be 0, so revision N would look "new" and we'd re-fire
    //      the same battery surface immediately — annoying dupe.
    //
    // Seeding `LAST_REVISION` from `disk.last_revision` prevents that. If
    // no prior session exists (fresh install / file missing), we seed from
    // `world::current().revision` so that whatever revision is already in
    // memory at startup is treated as "already surfaced" — conservative:
    // the cost of missing one surface is far lower than the cost of
    // spuriously re-firing on every relaunch.
    let disk = load_disk();
    let seed_revision = disk
        .last_revision
        .unwrap_or_else(|| world::current().revision);
    {
        let mut guard = match DISK.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if guard.is_none() {
            *guard = Some(disk);
        }
    }
    {
        let mut guard = match LAST_REVISION.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Only seed if still at the zero default — honour any revision the
        // module may have already seen (e.g. a test harness pre-initialised
        // it). Belt-and-braces: callers shouldn't start() twice anyway.
        if *guard == 0 {
            *guard = seed_revision;
        }
    }

    // --- Path 1: Tauri listener (legacy, kept as a fallback) ---------------
    let app_for_listener = app.clone();
    app.listen("sunny://world", move |ev| {
        let payload = ev.payload();
        let world: crate::world::WorldState = match serde_json::from_str(payload) {
            Ok(w) => w,
            Err(_) => return,
        };
        process_world(&world, &app_for_listener);
    });

    // --- Path 2: event_bus tailer (safety-net heartbeat) -------------------
    //
    // Every 30 s we pull the latest `WorldTick` from the persistent bus.
    // If its revision is newer than what we've already processed, we grab
    // the full `WorldState` from `world::current()` (the bus event carries
    // only a summary — revision/focus_app/activity/at) and run the same
    // pipeline.
    //
    // This ran at 5 s when the bus-tail was the primary defence against
    // a flaky Tauri listener; relaxed to 30 s once the direct listener
    // proved reliable in production. The Tauri listener above is the real
    // push path and delivers every world
    // tick in well under a second; a 5 s poll was burning ~6x the DB reads
    // for the same "catch hiccups" coverage. Keeping it as a 30 s
    // heartbeat preserves belt-and-braces safety (a stuck Tauri event loop
    // still self-heals within half a minute) without the noisy SELECT
    // cadence.
    let app_for_bus = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        // Skip the immediate first tick so we don't fire before the updater
        // has had a chance to populate the bus.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let events = event_bus::tail_by_kind("WorldTick", 1).await;
            let Some(SunnyEvent::WorldTick { revision, .. }) = events.into_iter().next() else {
                continue;
            };

            // Quick gate BEFORE the WorldState clone — avoids pulling the
            // full state every 5 s when nothing has changed.
            let already_processed = {
                let guard = match LAST_REVISION.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                revision <= *guard
            };
            if already_processed {
                continue;
            }

            let world = world::current();
            // Re-check against the live state — if its revision has leapt
            // past what the bus gave us (producer ticked again while we
            // were waiting), prefer the newer snapshot.
            process_world(&world, &app_for_bus);
        }
    });
}

// ---------------------------------------------------------------------------
// Classifier spawn
// ---------------------------------------------------------------------------

/// Fire-and-forget classifier task. Runs in a detached tokio future so
/// the ambient tick's critical path never blocks on Ollama. On success
/// with an intent + confidence >= threshold AND passing the 10 min
/// per-intent dedupe, emits `sunny://ambient.notify`. Any error — Ollama
/// daemon down, model not pulled, 2 s timeout — is a silent log and the
/// rule-based compound path (already queued by `evaluate()` upstream)
/// carries the surface workload.
///
/// The shape of the intent surface mirrors the existing narrow +
/// rule-compound surfaces (category / title / body) so the frontend
/// doesn't need a separate render path — it can style on the
/// `intent:` prefix if desired, but a plain chip works out of the box.
fn spawn_classifier(app: AppHandle, world: crate::world::WorldState, model: String) {
    tauri::async_runtime::spawn(async move {
        // Build the digest on the task side — cheap but avoids holding
        // the upstream sync path for even a few microseconds of string
        // formatting.
        let digest = ambient_classifier::build_digest(&world);
        let outcome = match ambient_classifier::classify(&model, &digest).await {
            Ok(o) => o,
            Err(e) => {
                // Debug-level: a missing model or offline daemon is a
                // common operating state, not a warning. The rule-based
                // compound path is the primary surface regardless of
                // whether this task succeeds.
                log::debug!("[ambient] classifier skipped: {e}");
                return;
            }
        };

        let (tag, confidence, rationale) = match outcome {
            ClassifierOutcome::Intent {
                tag,
                confidence,
                rationale,
            } => (tag, confidence, rationale),
            ClassifierOutcome::None => {
                // Model actively said NONE — the rule-based path already
                // ran. Nothing to do.
                return;
            }
        };

        let category = format!("{}{}", CAT_INTENT_PREFIX, tag.as_str());
        let now = now_secs();

        // Dedupe + persist — must go through DISK lock so concurrent
        // classifier tasks (shouldn't happen under the 60 s cooldown,
        // but belt-and-braces) don't double-fire the same intent.
        let fire = {
            let mut guard = match DISK.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let disk = guard.get_or_insert_with(AmbientDisk::default);
            let gap_ok = match disk.last_intent_surface.get(tag.as_str()) {
                Some(last) => now - *last >= INTENT_MIN_GAP_SECS,
                None => true,
            };
            if gap_ok {
                disk.last_intent_surface
                    .insert(tag.as_str().to_string(), now);
                let snapshot = disk.clone();
                // Drop the lock before the slow I/O of save_disk.
                drop(guard);
                save_disk(&snapshot);
                true
            } else {
                false
            }
        };

        if !fire {
            log::debug!(
                "[ambient] intent {} suppressed by 10-min dedupe",
                tag.as_str()
            );
            return;
        }

        // Build a surface using the intent's canned title + the model's
        // one-sentence rationale as the body. If rationale is empty we
        // fall back to a generic body so the chip still reads cleanly.
        let body = if rationale.is_empty() {
            format!("{} (confidence {:.0}%)", tag.title(), confidence * 100.0)
        } else {
            rationale
        };
        let surface = Surface {
            category: category.clone(),
            title: tag.title().to_string(),
            body,
        };

        log::info!(
            "[ambient] intent fired: {} (confidence {:.2})",
            tag.as_str(),
            confidence
        );
        let _ = app.emit("sunny://ambient.notify", &surface);
        // Native notification intentionally suppressed for intent surfaces:
        // they're inherently nuanced nudges; an OS banner is too loud for
        // the confidence margin we're operating in.
    });
}

// ---------------------------------------------------------------------------
// Tests — pure evaluate() coverage. No Tauri, no I/O.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use super::*;
    use crate::calendar::CalendarEvent;

    // Re-export the types/fns the test bodies reference directly.
    use rules::{
        CAT_BATTERY, CAT_FOCUS_BATTERY, CAT_MAIL, CAT_MEETING, CAT_MEETING_BATTERY,
        CAT_MEETING_MAIL, MIN_GAP_SECS, evaluate, now_secs,
    };
    use settings::AmbientSettings;
    use store::AmbientDisk;

    fn base_world() -> crate::world::WorldState {
        crate::world::WorldState::default()
    }

    fn event_starting_in(secs: i64) -> CalendarEvent {
        let start = chrono::Local::now() + chrono::Duration::seconds(secs);
        CalendarEvent {
            id: "evt-1".into(),
            title: "Team Sync".into(),
            start: start.format("%Y-%m-%dT%H:%M:%S").to_string(),
            end: start.format("%Y-%m-%dT%H:%M:%S").to_string(),
            location: "".into(),
            notes: "".into(),
            calendar: "Home".into(),
            all_day: false,
        }
    }

    #[test]
    fn meeting_in_window_fires_once() {
        let mut w = base_world();
        w.next_event = Some(event_starting_in(10 * 60));
        let prior = AmbientDisk::default();
        let settings = AmbientSettings::default();
        let now = now_secs();

        let (surfaces, next) = evaluate(&w, &prior, &settings, now);
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].category, CAT_MEETING);
        assert!(surfaces[0].body.contains("Team Sync"));
        assert_eq!(next.last_meeting_event_id.as_deref(), Some("evt-1"));

        // Second tick with identical state — dedupe by event id.
        let (again, _) = evaluate(&w, &next, &settings, now + 30);
        assert!(again.is_empty(), "same event id must not re-fire");
    }

    #[test]
    fn meeting_outside_window_does_not_fire() {
        let mut w = base_world();
        w.next_event = Some(event_starting_in(30 * 60)); // 30 min out
        let (surfaces, _) =
            evaluate(&w, &AmbientDisk::default(), &AmbientSettings::default(), now_secs());
        assert!(surfaces.is_empty());
    }

    #[test]
    fn battery_low_discharging_fires_once_per_cycle() {
        let mut w = base_world();
        w.battery_pct = Some(10.0);
        w.battery_charging = Some(false);
        let prior = AmbientDisk::default();
        let settings = AmbientSettings::default();
        let now = now_secs();

        let (surfaces, next) = evaluate(&w, &prior, &settings, now);
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].category, CAT_BATTERY);
        assert!(next.battery_fired_this_cycle);

        let (again, _) = evaluate(&w, &next, &settings, now + 3600);
        assert!(again.is_empty(), "must not re-fire on same discharge cycle");
    }

    #[test]
    fn battery_charging_re_arms_trigger() {
        let mut w = base_world();
        w.battery_pct = Some(50.0);
        w.battery_charging = Some(true);
        let prior = AmbientDisk {
            battery_fired_this_cycle: true,
            ..AmbientDisk::default()
        };
        let (_, next) = evaluate(&w, &prior, &AmbientSettings::default(), now_secs());
        assert!(!next.battery_fired_this_cycle, "plug in should re-arm");
    }

    #[test]
    fn mail_crosses_threshold_fires_once() {
        let mut w = base_world();
        w.mail_unread = Some(25);
        let settings = AmbientSettings { mail_threshold: 20, ..AmbientSettings::default() };
        let now = now_secs();

        let (surfaces, next) = evaluate(&w, &AmbientDisk::default(), &settings, now);
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].category, CAT_MAIL);
        assert!(next.mail_over_threshold);

        let (again, _) = evaluate(&w, &next, &settings, now + MIN_GAP_SECS + 1);
        assert!(again.is_empty(), "still over threshold — no re-fire");
    }

    #[test]
    fn mail_drops_below_then_crosses_again_re_fires() {
        let mut w = base_world();
        w.mail_unread = Some(5);
        let settings = AmbientSettings { mail_threshold: 20, ..AmbientSettings::default() };
        let prior = AmbientDisk {
            mail_over_threshold: true,
            last_surface: HashMap::from([(CAT_MAIL.to_string(), now_secs() - MIN_GAP_SECS - 1)]),
            ..AmbientDisk::default()
        };

        let (_, mid) = evaluate(&w, &prior, &settings, now_secs());
        assert!(!mid.mail_over_threshold, "drop below re-arms");

        w.mail_unread = Some(30);
        let (surfaces, _) = evaluate(&w, &mid, &settings, now_secs());
        assert_eq!(surfaces.len(), 1);
    }

    #[test]
    fn gap_floor_blocks_rapid_re_fires_across_categories() {
        // Even if a trigger's internal "novelty" flag says go, the per-category
        // MIN_GAP_SECS floor must refuse when the last surface is recent.
        let now = 1_000_000;
        let prior = AmbientDisk {
            last_surface: HashMap::from([(CAT_BATTERY.to_string(), now - 60)]),
            ..AmbientDisk::default()
        };
        let mut w = base_world();
        w.battery_pct = Some(10.0);
        w.battery_charging = Some(false);
        let (surfaces, _) = evaluate(&w, &prior, &AmbientSettings::default(), now);
        assert!(surfaces.is_empty(), "gap floor must suppress");
    }

    #[test]
    fn kill_switch_via_settings_is_respected_by_caller() {
        // evaluate() is pure; the kill switch lives in the listener. We test
        // here only that evaluate still produces surfaces — the listener is
        // responsible for dropping them. This documents the contract.
        let mut w = base_world();
        w.battery_pct = Some(5.0);
        w.battery_charging = Some(false);
        let (surfaces, _) = evaluate(&w, &AmbientDisk::default(), &AmbientSettings::default(), now_secs());
        assert_eq!(surfaces.len(), 1);
    }

    #[test]
    fn native_notify_setting_defaults_to_hud_only() {
        // The new `ambient_native_notify` flag defaults to false so we don't
        // duplicate macOS Calendar/Mail notifications.
        let s = AmbientSettings::default();
        assert!(!s.native_notify, "default must be HUD-only");
        assert!(s.enabled, "kill-switch default is on");
    }

    // -----------------------------------------------------------------
    // Compound synthesis
    // -----------------------------------------------------------------

    #[test]
    fn compound_meeting_plus_battery_fires_single_nudge() {
        let mut w = base_world();
        w.next_event = Some(event_starting_in(12 * 60)); // 12 min
        w.battery_pct = Some(18.0);
        w.battery_charging = Some(false);

        let (surfaces, next) = evaluate(
            &w,
            &AmbientDisk::default(),
            &AmbientSettings::default(),
            now_secs(),
        );

        assert_eq!(surfaces.len(), 1, "exactly one synthesised surface");
        assert_eq!(surfaces[0].category, CAT_MEETING_BATTERY);
        assert!(surfaces[0].body.contains("18%"));
        assert!(surfaces[0].body.contains("Plug in"));
        // Per-category footprints for the rolled-up categories must be
        // rewound so they aren't mis-deduped later.
        assert!(next.last_surface.get(CAT_MEETING).is_none());
        assert!(next.last_surface.get(CAT_BATTERY).is_none());
        assert!(next.last_compound_surface.contains_key(CAT_MEETING_BATTERY));
    }

    #[test]
    fn compound_meeting_plus_mail_fires_single_nudge() {
        let mut w = base_world();
        w.next_event = Some(event_starting_in(10 * 60)); // 10 min
        w.mail_unread = Some(23);

        let settings = AmbientSettings {
            mail_threshold: 20,
            ..AmbientSettings::default()
        };

        let (surfaces, next) =
            evaluate(&w, &AmbientDisk::default(), &settings, now_secs());

        assert_eq!(surfaces.len(), 1, "compound rolls both singles into one");
        assert_eq!(surfaces[0].category, CAT_MEETING_MAIL);
        assert!(surfaces[0].body.contains("23 unread"));
        assert!(next.last_surface.get(CAT_MAIL).is_none());
        assert!(next.last_compound_surface.contains_key(CAT_MEETING_MAIL));
    }

    /// Regression for kappa v8 latent #1: the meeting+mail compound rule used
    /// the hardcoded `MAIL_UNREAD_DEFAULT` (20) instead of
    /// `settings.mail_threshold`. A user who set threshold=5 with inbox=7
    /// and a meeting in 10 min would never see the compound fire because
    /// 7 < 20. After the fix the compound MUST fire because 7 >= 5.
    #[test]
    fn compound_meeting_plus_mail_honours_user_threshold() {
        let mut w = base_world();
        w.next_event = Some(event_starting_in(10 * 60)); // 10 min
        w.mail_unread = Some(7);

        let settings = AmbientSettings {
            mail_threshold: 5,
            ..AmbientSettings::default()
        };

        let (surfaces, next) =
            evaluate(&w, &AmbientDisk::default(), &settings, now_secs());

        // With the bug (hardcoded default=20) this would be empty because
        // 7 < 20 would fail the compound rule AND 7 < 20 would fail the mail
        // single. After the fix the user's threshold=5 lets the compound fire.
        assert_eq!(
            surfaces.len(),
            1,
            "compound must fire when unread >= user threshold"
        );
        assert_eq!(surfaces[0].category, CAT_MEETING_MAIL);
        assert!(
            surfaces[0].body.contains("7 unread"),
            "body should reflect actual unread count"
        );
        assert!(next.last_compound_surface.contains_key(CAT_MEETING_MAIL));
    }

    #[test]
    fn compound_focus_plus_battery_fires_single_nudge() {
        // `Activity` is defined in a crate-private `world::model` submodule,
        // so we can't name the enum variant directly from this test. We
        // round-trip through JSON with the `snake_case` serde rename that
        // the type already uses — that's the stable wire shape.
        let mut w: crate::world::WorldState = serde_json::from_str(
            r#"{
                "schema_version": 1,
                "timestamp_ms": 0,
                "local_iso": "",
                "host": "",
                "os_version": "",
                "focus": null,
                "focused_duration_secs": 2700,
                "activity": "coding",
                "recent_switches": [],
                "next_event": null,
                "events_today": 0,
                "mail_unread": null,
                "cpu_pct": 0.0,
                "temp_c": 0.0,
                "mem_pct": 0.0,
                "battery_pct": null,
                "battery_charging": null,
                "revision": 0
            }"#,
        )
        .expect("world state fixture must parse");
        w.battery_pct = Some(17.0);
        w.battery_charging = Some(false);

        let (surfaces, next) = evaluate(
            &w,
            &AmbientDisk::default(),
            &AmbientSettings::default(),
            now_secs(),
        );

        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].category, CAT_FOCUS_BATTERY);
        assert!(surfaces[0].body.contains("45 min"));
        assert!(surfaces[0].body.contains("17%"));
        assert!(next.last_surface.get(CAT_BATTERY).is_none());
        assert!(next.last_compound_surface.contains_key(CAT_FOCUS_BATTERY));
    }

    #[test]
    fn no_synthesis_falls_back_to_per_category() {
        // Only battery fires — no meeting, no mail, not coding. Must behave
        // exactly like the per-category path.
        let mut w = base_world();
        w.battery_pct = Some(10.0);
        w.battery_charging = Some(false);

        let (surfaces, _) = evaluate(
            &w,
            &AmbientDisk::default(),
            &AmbientSettings::default(),
            now_secs(),
        );

        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].category, CAT_BATTERY);
    }

    #[test]
    fn compound_respects_30_minute_dedupe_gap() {
        // `event_starting_in` is anchored on wall-clock `Local::now()`, so
        // the `now` we pass into evaluate() has to be real time too — else
        // `start_unix - now` isn't in the meeting window.
        let now = now_secs();
        let mut w = base_world();
        w.next_event = Some(event_starting_in(12 * 60));
        // 10% — below BOTH the compound (25%) and the narrow (15%) battery
        // thresholds, so the per-category battery trigger can still fire
        // once the compound is gated.
        w.battery_pct = Some(10.0);
        w.battery_charging = Some(false);

        let prior = AmbientDisk {
            last_compound_surface: HashMap::from([(
                CAT_MEETING_BATTERY.to_string(),
                now - 60, // fired 1 minute ago — well inside the 30-min gap
            )]),
            ..AmbientDisk::default()
        };

        let (surfaces, _) = evaluate(&w, &prior, &AmbientSettings::default(), now);
        // Compound gap blocks the compound path. With meeting-battery
        // suppressed the per-category triggers should STILL be allowed to
        // fire their narrow nudges (the fallback path) — that's the whole
        // point of "fall back to per-category if no synthesis applies".
        assert!(
            surfaces.iter().all(|s| s.category != CAT_MEETING_BATTERY),
            "compound must not re-fire within 30 min"
        );
        assert!(
            surfaces.iter().any(|s| s.category == CAT_MEETING),
            "meeting single should still fire when compound is gated"
        );
        assert!(
            surfaces.iter().any(|s| s.category == CAT_BATTERY),
            "battery single should still fire when compound is gated"
        );
    }

    /// Regression for kappa v9 latent #2: "compound surface starvation".
    ///
    /// Scenario:
    ///   - T: meeting in 12 min AND battery at 18% discharging -> compound
    ///     meeting+battery fires, narrow meeting + narrow battery singles
    ///     are suppressed.
    ///   - T+5 min: user plugs in (battery_charging=true). The narrow battery
    ///     condition no longer holds, but the meeting is STILL imminent
    ///     (~7 min out). The narrow meeting chip MUST be allowed to fire
    ///     because (a) its per-category `last_surface` was never stamped
    ///     by the compound fire, and (b) the 30-min compound gap should
    ///     NOT starve the independent narrow chip.
    ///
    /// Before the fix, compound firing could leak its `last_surface` write
    /// into the narrow category keys (epsilon's regression), causing the narrow
    /// meeting chip to see itself as "just fired" and stay quiet for 30 min
    /// — even as battery plugged in. After the fix, narrow `last_surface`
    /// is completely decoupled from compound fires.
    #[test]
    fn narrow_meeting_not_starved_by_prior_compound_fire() {
        let t = now_secs();

        // --- T: compound fires, singles get suppressed --------------------
        let mut w_t = base_world();
        w_t.next_event = Some(event_starting_in(12 * 60)); // 12 min out
        w_t.battery_pct = Some(18.0);
        w_t.battery_charging = Some(false);

        let (surfaces_t, after_t) =
            evaluate(&w_t, &AmbientDisk::default(), &AmbientSettings::default(), t);
        assert_eq!(surfaces_t.len(), 1);
        assert_eq!(surfaces_t[0].category, CAT_MEETING_BATTERY);

        // Post-compound invariants: narrow keys must NOT carry a "just
        // fired" footprint, compound key must.
        assert!(
            after_t.last_surface.get(CAT_MEETING).is_none(),
            "compound fire must not stamp narrow meeting last_surface"
        );
        assert!(
            after_t.last_surface.get(CAT_BATTERY).is_none(),
            "compound fire must not stamp narrow battery last_surface"
        );
        assert!(
            after_t.last_meeting_event_id.is_none(),
            "compound fire must not consume the meeting event id"
        );
        assert!(after_t.last_compound_surface.contains_key(CAT_MEETING_BATTERY));

        // --- T+5 min: battery resolved, meeting still imminent ------------
        let t_plus_5 = t + 5 * 60;
        let mut w_t5 = base_world();
        // Re-compute the meeting event so `start - (t + 5*60)` still lands
        // in the 5-15 min window. The event was 12 min out at T; at T+5
        // it's 7 min out, still in window.
        w_t5.next_event = w_t.next_event.clone();
        w_t5.battery_pct = Some(80.0);
        w_t5.battery_charging = Some(true); // PLUGGED IN

        let (surfaces_t5, _after_t5) =
            evaluate(&w_t5, &after_t, &AmbientSettings::default(), t_plus_5);

        // Compound rule 1 fails (charging). No other compound applies.
        assert!(
            surfaces_t5.iter().all(|s| s.category != CAT_MEETING_BATTERY),
            "compound must not re-fire within 30 min"
        );
        // CRITICAL: narrow meeting MUST fire even though a compound fired
        // 5 min ago — the 30-min compound gap belongs to the compound key
        // alone, not the narrow chip's key.
        assert!(
            surfaces_t5.iter().any(|s| s.category == CAT_MEETING),
            "narrow meeting chip must fire — starvation bug regression"
        );
    }

    /// Regression for kappa v9 latent #2 (battery variant): after a compound
    /// meeting+battery fire rolls up the narrow battery single, the
    /// cycle-arm (`battery_fired_this_cycle`) must NOT remain set —
    /// otherwise the narrow battery chip is starved for the rest of the
    /// discharge cycle even as battery drops further.
    #[test]
    fn narrow_battery_not_starved_by_prior_compound_fire() {
        let t = now_secs();

        let mut w_t = base_world();
        w_t.next_event = Some(event_starting_in(12 * 60));
        w_t.battery_pct = Some(22.0); // below compound 25%, above narrow 15%
        w_t.battery_charging = Some(false);

        let (surfaces_t, after_t) =
            evaluate(&w_t, &AmbientDisk::default(), &AmbientSettings::default(), t);
        assert_eq!(surfaces_t.len(), 1);
        assert_eq!(surfaces_t[0].category, CAT_MEETING_BATTERY);

        // Cycle-arm MUST be decoupled from compound fires. If the compound
        // rolled up the narrow battery single, the narrow arm must reflect
        // only narrow-path history (still false here).
        assert!(
            !after_t.battery_fired_this_cycle,
            "compound fire must not arm the narrow battery cycle-gate"
        );

        // --- Later: battery keeps dropping past narrow threshold, meeting
        // has passed / compound no longer applies.
        let t_plus_20 = t + 20 * 60; // past the meeting window
        let mut w_late = base_world();
        w_late.battery_pct = Some(10.0); // now below narrow 15%
        w_late.battery_charging = Some(false);
        // No next_event — meeting has passed. Compound rule 1 won't match.

        // Shift the compound `last_surface` far enough into the past for
        // the narrow gap floor to be clear (gap is 10 min; 20 min is fine).
        let (surfaces_late, _) =
            evaluate(&w_late, &after_t, &AmbientSettings::default(), t_plus_20);

        assert!(
            surfaces_late.iter().any(|s| s.category == CAT_BATTERY),
            "narrow battery must fire when it drops further — starvation regression"
        );
    }

    #[test]
    fn ambient_disk_new_field_defaults_cleanly() {
        // Old ~/.sunny/ambient.json files predate `last_compound_surface`.
        // `#[serde(default)]` must let them parse without error.
        let legacy = r#"{
            "last_surface": {},
            "last_meeting_event_id": null,
            "battery_fired_this_cycle": false,
            "mail_over_threshold": false
        }"#;
        let parsed: AmbientDisk =
            serde_json::from_str(legacy).expect("legacy shape must parse");
        assert!(parsed.last_compound_surface.is_empty());
        assert_eq!(parsed.last_revision, None);
    }

    /// Reproduces the "quit-on-battery -> relaunch-on-battery" race:
    ///
    ///   1. Session A: WorldState{revision=42, battery 10%, discharging}.
    ///      evaluate() fires the battery surface and returns a next-state
    ///      with `battery_fired_this_cycle = true` and `last_revision =
    ///      Some(42)`. That state is persisted to disk.
    ///   2. User quits, still on battery. Same WorldTick (revision=42) is
    ///      the last event on the persistent bus.
    ///   3. Session B starts. load_disk() returns the state from (1). The
    ///      bus poller reads WorldTick{revision=42} first. Because we
    ///      seeded LAST_REVISION from `disk.last_revision`, revision 42
    ///      is <= the gate and process_world() no-ops.
    ///
    /// We verify BOTH guards in this test:
    ///   (a) `last_revision` persists via the disk round-trip.
    ///   (b) even if the revision gate were bypassed, evaluate() still
    ///       refuses to re-fire because `battery_fired_this_cycle` was
    ///       persisted true.
    #[test]
    fn battery_relaunch_does_not_re_fire_same_tick() {
        // --- Session A: first fire ----------------------------------------
        let mut world_a = base_world();
        world_a.revision = 42;
        world_a.battery_pct = Some(10.0);
        world_a.battery_charging = Some(false);

        let settings = AmbientSettings::default();
        let now = now_secs();

        let (surfaces_a, mut after_a) =
            evaluate(&world_a, &AmbientDisk::default(), &settings, now);
        assert_eq!(surfaces_a.len(), 1, "session A should fire once");
        assert!(after_a.battery_fired_this_cycle);
        // process_world() stamps the revision after evaluate(); mirror that
        // here so the round-trip reflects what the production path persists.
        after_a.last_revision = Some(world_a.revision);

        // --- Disk round-trip ----------------------------------------------
        let serialized = serde_json::to_string(&after_a).expect("serialize disk");
        let persisted: AmbientDisk =
            serde_json::from_str(&serialized).expect("parse disk");
        assert_eq!(
            persisted.last_revision,
            Some(42),
            "last_revision must survive restart"
        );
        assert!(
            persisted.battery_fired_this_cycle,
            "battery-armed flag must survive restart"
        );

        // --- Session B: same tick, same battery state ---------------------
        // Guard (a): if the bus poller delivers revision 42, the seed from
        // disk means LAST_REVISION >= 42, so process_world() no-ops at the
        // gate. Simulate that gate check directly.
        let seeded_last_revision = persisted
            .last_revision
            .expect("seeded from disk");
        assert!(
            world_a.revision <= seeded_last_revision,
            "revision gate must reject a tick we already processed"
        );

        // Guard (b): even if the gate were bypassed, evaluate() must still
        // refuse because the cycle-arm survives.
        let (surfaces_b, _) = evaluate(&world_a, &persisted, &settings, now + 30);
        assert!(
            surfaces_b.is_empty(),
            "battery surface must NOT re-fire after restart on same discharge cycle"
        );
    }
}
