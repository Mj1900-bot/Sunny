//! Agent-loop scheduler tools.
//!
//! Provides five LLM-facing tools that let the agent schedule future and
//! recurring agent turns — on top of `crate::daemons` (the persistent daemon
//! store) rather than duplicating it.
//!
//! ## Tool overview
//!
//! | Tool               | L-level  | What it does                              |
//! |--------------------|----------|-------------------------------------------|
//! | `schedule_once`    | L3       | One-shot run at absolute/relative time    |
//! | `schedule_recurring` | L3     | Repeating run from cron/NL expression     |
//! | `schedule_list`    | L2       | List pending + recent schedules           |
//! | `schedule_cancel`  | L2       | Remove a schedule + its daemon            |
//! | `schedule_history` | L2       | Last N completed run summaries            |
//!
//! ## Trust-level interaction
//!
//! `SunnySettings.trust_level` is consulted at schedule-creation time:
//! - `ConfirmAll` → `requires_confirm=true` is stored on the entry.  The
//!   frontend checks this flag when the daemon fires and pauses the agent run
//!   at any L3+ tool, emitting a push-notification confirmation request.
//! - `Smart` / `Autonomous` → `requires_confirm=false`; runs execute within
//!   the daily cost cap and unattended consent rules as normal.
//!
//! ## Dead-letter queue
//!
//! Each `ScheduleEntry` tracks `fail_count`.  Three consecutive failures set
//! `dead_letter=true`, clear `next_fire`, and disable the entry so it stops
//! retrying.  `schedule_list` surfaces the flag so the user (or agent) can
//! inspect and reschedule.
//!
//! ## Persistence
//!
//! `~/.sunny/schedules.json` — atomic tmp-rename write, 0600 permissions.
//! Each write goes through `store::save_schedules` which holds a process-
//! global `Mutex<()>` so concurrent tool invocations never race.

pub mod parse_time;
pub mod store;

mod schedule_once;
mod schedule_recurring;
mod schedule_list;
mod schedule_cancel;
mod schedule_history;
