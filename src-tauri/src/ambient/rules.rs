//! Pure novelty-evaluation rules for the ambient watcher.
//!
//! All functions here are free of I/O and side-effects — they take
//! `&WorldState`, `&AmbientDisk`, `&AmbientSettings` and return new values.
//! This makes them straightforwardly unit-testable (the test module in
//! `mod.rs` exercises them via `evaluate()`).

use crate::world::WorldState;

use super::settings::AmbientSettings;
use super::store::AmbientDisk;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Minimum seconds between surfaces for the SAME category. A per-category
/// dedupe floor that applies on top of the category-specific "novelty"
/// checks below.
pub(super) const MIN_GAP_SECS: i64 = 10 * 60;

/// Meeting-imminent window: fire when `next_event.start` is this many minutes
/// ahead (inclusive of the lower bound, exclusive of the upper).
pub(super) const MEETING_WINDOW_LOW_SECS: i64 = 5 * 60;
pub(super) const MEETING_WINDOW_HIGH_SECS: i64 = 15 * 60;

/// Battery threshold — below this AND `battery_charging == Some(false)` fires
/// once per discharge cycle.
pub(super) const BATTERY_LOW_PCT: f64 = 15.0;

/// Category identifiers used for persistence + dedupe.
pub(super) const CAT_MEETING: &str = "meeting";
pub(super) const CAT_BATTERY: &str = "battery";
pub(super) const CAT_MAIL: &str = "mail";

// --- Compound (synthesised) categories --------------------------------------

pub(super) const CAT_MEETING_BATTERY: &str = "meeting+battery";
pub(super) const CAT_MEETING_MAIL: &str = "meeting+mail";
pub(super) const CAT_FOCUS_BATTERY: &str = "focus+battery";

/// Minimum seconds between surfaces for a COMPOUND category — deliberately
/// longer than `MIN_GAP_SECS` because a compound nudge is louder (it
/// synthesises two conditions) and re-firing it sooner would feel nag-y.
pub(super) const COMPOUND_MIN_GAP_SECS: i64 = 30 * 60;

/// Compound-trigger thresholds. Intentionally a bit more generous on the
/// meeting-window side than the bare meeting trigger so that a slightly-late
/// battery reading still qualifies.
pub(super) const COMPOUND_BATTERY_PCT: f64 = 25.0;
pub(super) const COMPOUND_FOCUS_BATTERY_PCT: f64 = 20.0;
pub(super) const COMPOUND_FOCUS_MIN_SECS: i64 = 30 * 60;

// --- LLM-classified intents -------------------------------------------------

pub(super) const CAT_INTENT_PREFIX: &str = "intent:";

/// Per-intent-tag dedupe floor.
pub(super) const INTENT_MIN_GAP_SECS: i64 = 10 * 60;

/// Minimum wall-clock gap between classifier invocations.
pub(super) const CLASSIFIER_COOLDOWN_SECS: i64 = 60;

// ---------------------------------------------------------------------------
// Surface payload
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize)]
pub(super) struct Surface {
    /// Surface category — fixed strings for narrow (e.g. `"battery"`) and
    /// rule-compound (e.g. `"meeting+battery"`) chips, and `intent:<tag>`
    /// for LLM-classified chips. Stored as `String` (not `&'static str`)
    /// because the intent variants are built at runtime from the
    /// classifier's tag output.
    pub(super) category: String,
    pub(super) title: String,
    pub(super) body: String,
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

pub(super) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(super) fn iso_to_unix(iso: &str) -> Option<i64> {
    use chrono::TimeZone;
    let naive = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S").ok())?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp())
}

// ---------------------------------------------------------------------------
// Core evaluation (pure — no I/O)
// ---------------------------------------------------------------------------

/// Evaluate all three triggers against the new world state. Returns any
/// surfaces to fire AND the mutated disk state. Pure — no I/O.
pub(super) fn evaluate(
    world: &WorldState,
    prior: &AmbientDisk,
    settings: &AmbientSettings,
    now: i64,
) -> (Vec<Surface>, AmbientDisk) {
    let mut next = prior.clone();
    let mut surfaces: Vec<Surface> = Vec::new();

    // --- Meeting imminent --------------------------------------------------
    if let Some(ev) = world.next_event.as_ref() {
        if let Some(start_unix) = iso_to_unix(&ev.start) {
            let secs_until = start_unix - now;
            let in_window = (MEETING_WINDOW_LOW_SECS..MEETING_WINDOW_HIGH_SECS)
                .contains(&secs_until);
            let is_novel_event = prior.last_meeting_event_id.as_deref() != Some(ev.id.as_str());
            let gap_ok = gap_ok(prior, CAT_MEETING, now);

            if in_window && is_novel_event && gap_ok {
                let mins = (secs_until + 59) / 60; // round up
                let title = "Meeting soon".to_string();
                let body = format!("Next meeting in {} min: {}", mins, ev.title);
                surfaces.push(Surface { category: CAT_MEETING.to_string(), title, body });
                next.last_meeting_event_id = Some(ev.id.clone());
                next.last_surface.insert(CAT_MEETING.to_string(), now);
            }
        }
    }

    // --- Battery low + discharging -----------------------------------------
    let charging = world.battery_charging.unwrap_or(true);
    if !charging {
        if let Some(pct) = world.battery_pct {
            if pct < BATTERY_LOW_PCT
                && !prior.battery_fired_this_cycle
                && gap_ok(prior, CAT_BATTERY, now)
            {
                let title = "Battery low".to_string();
                let body = format!("Battery at {}%, not charging", pct.round() as i64);
                surfaces.push(Surface { category: CAT_BATTERY.to_string(), title, body });
                next.battery_fired_this_cycle = true;
                next.last_surface.insert(CAT_BATTERY.to_string(), now);
            }
        }
    } else {
        // Plugged in — re-arm for the next discharge cycle.
        next.battery_fired_this_cycle = false;
    }

    // --- Mail unread crossed threshold -------------------------------------
    if let Some(unread) = world.mail_unread {
        if unread >= settings.mail_threshold {
            if !prior.mail_over_threshold && gap_ok(prior, CAT_MAIL, now) {
                let title = "Inbox climbing".to_string();
                let body = format!("Inbox is up to {}", unread);
                surfaces.push(Surface { category: CAT_MAIL.to_string(), title, body });
                next.last_surface.insert(CAT_MAIL.to_string(), now);
            }
            next.mail_over_threshold = true;
        } else {
            // Dropped back below — re-arm for the next crossing.
            next.mail_over_threshold = false;
        }
    }

    // --- Compound synthesis -----------------------------------------------
    //
    // Runs AFTER per-category evaluation. If a compound condition holds we
    // (a) push a single synthesised surface, and (b) suppress the individual
    // per-category surfaces we rolled up — otherwise the user would see
    // both the compound chip AND the narrow ones (triple-surface spam).
    synthesise_compound_signal(world, prior, settings, &mut next, &mut surfaces, now);

    (surfaces, next)
}

pub(super) fn gap_ok(prior: &AmbientDisk, cat: &str, now: i64) -> bool {
    match prior.last_surface.get(cat) {
        Some(last) => now - *last >= MIN_GAP_SECS,
        None => true,
    }
}

/// Returns true if enough time has passed since we last fired the given
/// compound category. Uses the longer `COMPOUND_MIN_GAP_SECS` because
/// compound nudges are, by design, louder than the narrow ones.
pub(super) fn compound_gap_ok(prior: &AmbientDisk, cat: &str, now: i64) -> bool {
    match prior.last_compound_surface.get(cat) {
        Some(last) => now - *last >= COMPOUND_MIN_GAP_SECS,
        None => true,
    }
}

/// Round up to the nearest whole minute. `(secs + 59) / 60` matches the
/// meeting trigger's convention so the compound nudges speak in the same
/// units as the per-category ones.
pub(super) fn mins_round_up(secs: i64) -> i64 {
    (secs + 59) / 60
}

/// Look for coincidences across the raw world signals and, when any of the
/// three compound conditions hold, push a single synthesised surface and
/// suppress the per-category surfaces it rolls up.
///
/// Rules — a toast only earns its keep when it shows something
/// calendar/mail/battery alone couldn't:
///
///   1. **meeting + battery**:   next meeting in 5-15 min AND battery < 25%
///                               AND discharging. Suppress meeting + battery
///                               singles.
///   2. **meeting + mail**:      next meeting in 5-15 min AND
///                               mail_unread >= threshold. Suppress the mail
///                               single. Meeting single is kept, because the
///                               meeting-imminent reminder is the primary
///                               signal and the mail count is the rider.
///                               (We phrase the compound as a richer meeting
///                               nudge, so the plain one would duplicate.)
///                               Implementation suppresses meeting too to
///                               avoid the dupe.
///   3. **focus + battery**:     activity = Coding for > 30 min AND
///                               battery < 20% AND discharging. Suppress the
///                               battery single.
///
/// If two compound rules match the same tick (e.g. meeting+battery AND
/// meeting+mail both valid) we prefer the battery one — power is more
/// time-critical than inbox depth. This is a deliberate priority choice;
/// change only if you have a reason.
pub(super) fn synthesise_compound_signal(
    world: &WorldState,
    prior: &AmbientDisk,
    settings: &AmbientSettings,
    next: &mut AmbientDisk,
    surfaces: &mut Vec<Surface>,
    now: i64,
) {
    // Snapshot the raw conditions once — the three rules each read a subset.
    let meeting_mins: Option<i64> = world.next_event.as_ref().and_then(|ev| {
        let start_unix = iso_to_unix(&ev.start)?;
        let secs_until = start_unix - now;
        if (MEETING_WINDOW_LOW_SECS..MEETING_WINDOW_HIGH_SECS).contains(&secs_until) {
            Some(mins_round_up(secs_until))
        } else {
            None
        }
    });
    let meeting_title: Option<String> =
        world.next_event.as_ref().map(|ev| ev.title.clone());

    let charging = world.battery_charging.unwrap_or(true);
    let battery_pct = world.battery_pct;

    let mail_unread = world.mail_unread.unwrap_or(0);
    // Thread the user's configured threshold through instead of silently
    // falling back to MAIL_UNREAD_DEFAULT (20). Before this, a user who
    // set ambient_mail_threshold=5 would never see the compound fire for
    // unread counts 5-19 because 5-19 < 20.
    let mail_threshold = settings.mail_threshold;

    // Rule 1: meeting + battery -------------------------------------------
    let meeting_battery_match = match (meeting_mins, battery_pct) {
        (Some(mins), Some(pct))
            if !charging
                && pct < settings.battery_threshold_pct
                && compound_gap_ok(prior, CAT_MEETING_BATTERY, now) =>
        {
            Some((mins, pct))
        }
        _ => None,
    };

    // Rule 2: meeting + mail spike ----------------------------------------
    let meeting_mail_match = match meeting_mins {
        Some(mins)
            if mail_unread >= mail_threshold
                && compound_gap_ok(prior, CAT_MEETING_MAIL, now) =>
        {
            Some((mins, mail_unread))
        }
        _ => None,
    };

    // Rule 3: focus + battery ---------------------------------------------
    //
    // We compare `activity.as_str()` instead of constructing the enum
    // variant directly because the `model` submodule is private to the
    // `world` crate; the enum's string form is the stable public contract
    // (it's the same string the frontend and memory pack use).
    let focus_battery_match = match battery_pct {
        Some(pct)
            if world.activity.as_str() == "coding"
                && world.focused_duration_secs >= COMPOUND_FOCUS_MIN_SECS
                && !charging
                && pct < settings.focus_battery_threshold_pct
                && compound_gap_ok(prior, CAT_FOCUS_BATTERY, now) =>
        {
            Some((world.focused_duration_secs, pct))
        }
        _ => None,
    };

    // Priority: meeting+battery > meeting+mail > focus+battery. Only ONE
    // compound surface fires per tick — two compound chips at once would be
    // the same stacking problem we're trying to solve.
    if let Some((mins, pct)) = meeting_battery_match {
        let title_source = meeting_title.unwrap_or_else(|| "meeting".to_string());
        let body = format!(
            "Next meeting in {} min ({}) and you're at {}%. Plug in?",
            mins,
            title_source,
            pct.round() as i64,
        );
        surfaces.push(Surface {
            category: CAT_MEETING_BATTERY.to_string(),
            title: "Meeting soon — plug in?".to_string(),
            body,
        });
        next.last_compound_surface
            .insert(CAT_MEETING_BATTERY.to_string(), now);
        suppress_category(surfaces, next, prior, CAT_MEETING);
        suppress_category(surfaces, next, prior, CAT_BATTERY);
        return;
    }

    if let Some((mins, unread)) = meeting_mail_match {
        let body = format!(
            "Next meeting in {} min — {} unread emails. Skim them?",
            mins, unread,
        );
        surfaces.push(Surface {
            category: CAT_MEETING_MAIL.to_string(),
            title: "Meeting soon — inbox heavy".to_string(),
            body,
        });
        next.last_compound_surface
            .insert(CAT_MEETING_MAIL.to_string(), now);
        // Suppress the mail single (primary source of the duplicate).
        suppress_category(surfaces, next, prior, CAT_MAIL);
        // Suppress the meeting single too: the compound already includes
        // "meeting in N min", so keeping the plain meeting nudge alongside
        // would be the exact duplication we're trying to avoid.
        suppress_category(surfaces, next, prior, CAT_MEETING);
        return;
    }

    if let Some((focus_secs, pct)) = focus_battery_match {
        let mins = focus_secs / 60;
        let body = format!(
            "On battery for {} min of coding — you're at {}%. Plug in?",
            mins,
            pct.round() as i64,
        );
        surfaces.push(Surface {
            category: CAT_FOCUS_BATTERY.to_string(),
            title: "Coding on low battery".to_string(),
            body,
        });
        next.last_compound_surface
            .insert(CAT_FOCUS_BATTERY.to_string(), now);
        suppress_category(surfaces, next, prior, CAT_BATTERY);
    }
}

/// Remove any surface for `cat` from the pending list AND rewind the
/// per-category side-effects `evaluate()` already recorded so we don't
/// accidentally leave a "we fired" footprint when in fact the compound
/// nudge rolled it up.
///
/// DECOUPLING INVARIANT (κ v9 latent #2 fix):
///   A compound fire MUST NOT write into narrow categories' dedupe state.
///   Narrow `last_surface` keys track ONLY narrow fires; compound fires
///   live exclusively in `last_compound_surface` with their own 30-min
///   gap. Without this, the user sees the compound once and then nothing
///   for 30 min because the narrow chip mistakenly thinks itself recently
///   fired.
///
/// Rewind semantics:
///   - `last_surface[cat]` is restored to whatever was in `prior` (absent if
///     it was absent, else the old timestamp). A compound fire NEVER leaves
///     a `now` stamp in a narrow key.
///   - `last_meeting_event_id` is restored to `prior.last_meeting_event_id`
///     when suppressing the meeting single — otherwise a future tick
///     entering the window again would mis-dedupe.
///   - `battery_fired_this_cycle` is restored for `CAT_BATTERY` suppression.
///     The narrow battery path sets this to `true` as a per-cycle arm; if
///     we leave it set after rolling the single into a compound, the narrow
///     battery chip is starved for the rest of the discharge cycle even if
///     battery drops further. The re-arm normally only happens on a charge
///     event (line ~338), which may be hours away. Restoring from `prior`
///     means the cycle-arm reflects only NARROW fires, matching the
///     decoupling invariant above.
///   - `mail_over_threshold` is intentionally NOT restored: it mirrors raw
///     world state (is unread >= threshold right now?) rather than "did
///     we fire", so it tracks correctly regardless of compound rollups.
pub(super) fn suppress_category(
    surfaces: &mut Vec<Surface>,
    next: &mut AmbientDisk,
    prior: &AmbientDisk,
    cat: &'static str,
) {
    surfaces.retain(|s| s.category.as_str() != cat);

    match prior.last_surface.get(cat) {
        Some(ts) => {
            next.last_surface.insert(cat.to_string(), *ts);
        }
        None => {
            next.last_surface.remove(cat);
        }
    }

    if cat == CAT_MEETING {
        next.last_meeting_event_id = prior.last_meeting_event_id.clone();
    }

    if cat == CAT_BATTERY {
        // Decouple the narrow battery cycle-arm from compound rollups. See
        // the DECOUPLING INVARIANT above. We restore from `prior` rather
        // than hardcoding `false` because the arm may legitimately have
        // been `true` before this tick (e.g. the narrow chip fired earlier
        // in the same discharge cycle on its own, then a later tick is
        // rolling a compound). Restoring from `prior` preserves that
        // narrow-only history exactly.
        next.battery_fired_this_cycle = prior.battery_fired_this_cycle;
    }
}
