//! 24/7 job templates — curated defaults Sunny can opt into from the Auto page.
//!
//! Each template is a complete spec: a schedule (kind + every_sec), a first-fire
//! time computed via `next_local_at`, and an `AgentGoal` goal string that will
//! be routed through the tool-using ollama agent loop when the job fires.
//!
//! The list is intentionally small and curated — these are the five that pay
//! their keep on day one. More will arrive as Sunny's automation surface
//! grows. Templates are immutable `&'static str` — every install produces a
//! fresh `Job` via `JobTemplate::to_job`.

use std::time::{SystemTime, UNIX_EPOCH};

use ts_rs::TS;

use crate::scheduler::{Job, JobAction, JobKind};

// -------------------- data model --------------------

#[derive(serde::Serialize, Clone, Debug, TS)]
#[ts(export)]
pub struct JobTemplate {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// Human-readable cadence summary, e.g. `"Every weekday at 8 am"`.
    pub schedule_hint: &'static str,
    pub kind: JobKind,
    pub action: JobAction,
    /// Optional interval cadence, in seconds. Only meaningful when
    /// `kind == JobKind::Interval`.
    #[ts(type = "number | null")]
    pub every_sec: Option<u64>,
    /// Wall-clock target (local hour/minute) used to compute the first fire.
    /// `None` means "no wall-clock anchor" — the caller should let the
    /// scheduler use its default `now + every_sec`. Typical for short-interval
    /// watchdogs. `weekday` pins to a specific day of the week.
    pub next_hour: Option<u32>,
    pub next_minute: Option<u32>,
    /// chrono::Weekday serialises as `"Mon"` / `"Tue"` / ... — escape-hatch
    /// the TS emitter because ts-rs doesn't know that shape.
    #[ts(type = "string | null")]
    pub next_weekday: Option<chrono::Weekday>,
}

// -------------------- next_run helper --------------------

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Next local `hour:minute` strictly after now. When `weekday` is `Some`,
/// pins to that day of the week. Falls back to `now + 86_400` when chrono
/// can't materialise the candidate wall time (DST gaps etc).
pub fn next_local_at(hour: u32, minute: u32, weekday: Option<chrono::Weekday>) -> i64 {
    use chrono::{Datelike, Duration, Local, TimeZone};

    let now_local = Local::now();
    let today = Local
        .with_ymd_and_hms(
            now_local.year(),
            now_local.month(),
            now_local.day(),
            hour,
            minute,
            0,
        )
        .single();

    let Some(today_at) = today else {
        return now_unix() + 86_400;
    };

    match weekday {
        None => {
            // No weekday pin — roll forward by a day if we're past the target.
            let target = if now_local < today_at {
                today_at
            } else {
                today_at + Duration::days(1)
            };
            target.timestamp()
        }
        Some(wd) => {
            // Find the next occurrence of `wd` at hour:minute local.
            // `num_days_from_monday` is 0..=6, so this loop terminates in ≤7 steps.
            let mut candidate = today_at;
            let mut guard = 0;
            loop {
                if guard > 14 {
                    return now_unix() + 86_400;
                }
                if candidate.weekday() == wd && candidate > now_local {
                    return candidate.timestamp();
                }
                candidate += Duration::days(1);
                guard += 1;
            }
        }
    }
}

// -------------------- template → job conversion --------------------

/// 16 lowercase hex chars from nanos + a process-local counter. Matches the
/// scheduler's own `new_id` shape (but lives here to avoid leaking the
/// scheduler's private helper). Parked — `to_job` below is the only
/// caller and it is itself currently unused.
#[allow(dead_code)]
fn new_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mixed = nanos
        ^ ((std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        ^ seq.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    format!("{mixed:016x}")
}

impl JobTemplate {
    /// Build a fresh, enabled `Job` from this template. Always a new id —
    /// installing the same template twice yields two independent jobs. When
    /// the template has no wall-clock anchor (`next_hour` is `None`) we fall
    /// back to `now + every_sec` for the next fire. Parked — the current
    /// install path (`commands::scheduler_install_template`) goes through
    /// `scheduler::scheduler_add` directly.
    #[allow(dead_code)]
    pub fn to_job(&self) -> Job {
        let now = now_unix();
        let next_run = match (self.next_hour, self.next_minute) {
            (Some(h), Some(m)) => Some(next_local_at(h, m, self.next_weekday)),
            _ => self.every_sec.map(|s| now + s as i64),
        };
        Job {
            id: new_id(),
            title: self.title.to_string(),
            kind: self.kind.clone(),
            at: None,
            every_sec: self.every_sec,
            action: self.action.clone(),
            enabled: true,
            last_run: None,
            next_run,
            last_error: None,
            last_output: None,
            created_at: now,
        }
    }
}

// -------------------- curated templates --------------------

const MORNING_BRIEF_GOAL: &str = "Morning brief: combine mail_unread_count, \
    calendar_today, and weather_current for Sunny's location (use memory_recall \
    to look up, default Vancouver). One spoken brief, ≤4 sentences, start \
    'Morning, Sunny', end 'Have a good day.'";

const MIDDAY_INBOX_GOAL: &str = "It's noon. Use mail_list_unread with limit 10, \
    group by sender priority, speak a one-sentence overview: how many unread, \
    who's most important to respond to, any action items.";

const EVENING_RECAP_GOAL: &str = "It's evening. Use calendar_today to read \
    today's completed events, memory_search for any notes created today, \
    summarise what Sunny did in 3 sentences. Append to a note titled \
    'Daily Recap YYYY-MM-DD'.";

const COMPETITOR_WATCH_GOAL: &str = "Weekly competitor scan. Spawn a \
    researcher sub-agent to search 'Frey Market competitors news last week' \
    and 'FounderLink competitors news last week', compile a 500-word \
    briefing, write to a note.";

const STOCK_WATCHDOG_GOAL: &str = "Quick check: call stock_quote for NVDA. \
    If price crossed 200, speak an alert. Otherwise stay silent.";

const END_OF_DAY_GOAL: &str = "Wrap today in a structured note. Gather inputs:\n\
• reminders_today — open reminders still pending (these are the 'slipped' candidates).\n\
• calendar_today — the events I actually had.\n\
• memory_search query:'standup OR done OR shipped' limit:20 — anything I logged during the day.\n\
• calendar_upcoming days:1 — what's already on the books for tomorrow.\n\
Build a 300-word markdown note with headings:\n\
  ### Shipped — concrete things I finished (from memory + reminders you infer are done).\n\
  ### Slipped — items still open from reminders_today, with best-guess reason each.\n\
  ### Tomorrow — exactly 3 bullets, ordered, grounded in the calendar or open reminders.\n\
Persist via notes_create title:'EOD — <YYYY-MM-DD>' folder:'End of Day' body:<markdown>. Also memory_add tags:['#eod', '<YYYY-MM-DD>'] text:<the Tomorrow bullets>. Do not speak; this runs quietly.";

const WEATHER_COMMUTE_GOAL: &str = "Resolve my city: memory_search query:'home location' limit:3. Pick the most recent entry that looks like a city name; fall back to 'San Francisco' if nothing matches. Use that city for every downstream call.\n\
Call weather_current city:<city>, weather_forecast city:<city> days:1, and sunrise_sunset city:<city>.\n\
Scan the returned text blobs (they're natural language) for these triggers in order:\n\
  • rain / showers / thunderstorm → say 'Take an umbrella — <forecast condition> expected.'\n\
  • wind > 30 km/h / gusts / gale → say 'Windy day — secure anything loose.'\n\
  • temperature > 32°C or < 0°C   → say 'Extreme temp — high <N>, low <M>.'\n\
  • sunset before 17:30            → say 'Sunset at <HH:MM> — plan the evening.'\n\
Speak only the first trigger that matches, with a 12-word cap. If nothing matches, memory_add tags:['#weather'] text:<weather_current output> and stay silent.";

const FOCUS_CHECKIN_GOAL: &str = "Call timezone_now tz:'America/Los_Angeles' (if memory_search query:'timezone' returns a different IANA zone, prefer that). Parse the weekday and HH from the output. If weekday is Saturday/Sunday OR HH < 9 OR HH >= 18, return 'skipped — outside work hours' and do nothing else.\n\
Otherwise: screen_capture_active_window. From its `data` pull the foreground app and window title. Speak text:'Focus check — what are you working on right now?' Then memory_add tags:['#focus'] text:'<HH:MM> · <app> — <title>'. Don't wait for a reply; the check-in is one-shot.";

const INBOX_TRIAGE_GOAL: &str = "Call mail_list_unread limit:30. For each line, extract the sender and subject. An item is URGENT iff ANY of these hold: (a) subject contains 'urgent', 'asap', 'today', 'deadline', 'overdue', or a time expression like 'by 5pm' (case-insensitive); (b) sender appears in memory_search query:'vip' limit:20; (c) subject contains a direct question mark.\n\
For each urgent item, build a dedupe key 'mail-seen:<sender>|<subject>'. memory_search query:<that key> limit:1 — if a hit exists, skip. Otherwise memory_add tags:['#inbox-seen'] text:<the key>, and accumulate it for the alert.\n\
If the accumulated list is non-empty, speak ONE sentence: '<N> urgent: <first sender> about <first subject>, plus <N-1> more.' If nothing urgent or nothing new, return 'clean' without speaking.";

const IMESSAGE_DIGEST_GOAL: &str = "Call list_chats. From its `data`, pick chats whose unread_count ≥ 1. For each such chat (max 8), call fetch_conversation for that chat with a limit of 10 messages. Compose one sentence per chat in the form '<other person>: <core point, ≤18 words>'. Skip system chats ('SMS', unnamed group chats with only your handle). If zero chats qualify, stop quietly.\n\
Otherwise notes_create title:'iMessage digest — <YYYY-MM-DD HH:MM>' folder:'Digests' body:<bulleted list>, and memory_add tags:['#imessage-digest'] text:<same bullets>. Do not speak.";

const MEETING_PREP_GOAL: &str = "Call calendar_upcoming days:1. Parse each line of the form 'HH:MM – HH:MM <title> (<calendar>)'. timezone_now tz:'America/Los_Angeles' to get the local now-HH:MM. Find the NEXT event whose start is ≥ now and ≤ now+10min; if none, stop silently.\n\
Dedupe: the prep key is 'meeting-prep:<YYYY-MM-DD>|<HH:MM>|<title>'. memory_search query:<that key> limit:1 — if a hit exists, stop (we already briefed for this one).\n\
Gather context: notes_search query:<meeting title, first 3 words> limit:5; memory_search query:<meeting title> limit:10; memory_search query:<first named attendee, if any> limit:5.\n\
Write a compact brief with these bullets (≤8 lines total):\n\
  • Agenda guess (one line, from the title + prior notes)\n\
  • Last context (one bullet per recent memory/notes hit, up to 3)\n\
  • Open questions (exactly 2 — drawn from context)\n\
  • Suggested next step (1 sentence)\n\
Persist: notes_create title:'Prep — <meeting title>' folder:'Meeting Prep' body:<markdown>. memory_add tags:['#meeting-prep'] text:<the prep key>. speak text:'Prep note ready — <title> at <HH:MM>.'";

const POMODORO_GOAL: &str = "timezone_now tz:'America/Los_Angeles' (override with whatever memory_search query:'timezone' returns). If the output's HH < 9 or ≥ 18, or weekday is Sat/Sun, stop.\n\
screen_capture_active_window. From `data` read the foreground app + window title (or describe what's on screen if the capture didn't include them). Pick ONE of three rest cues based on minute-of-hour (use timezone_now's MM):\n\
  MM < 20: 'Pomodoro mark — look 20 feet away for two minutes.'\n\
  20 ≤ MM < 40: 'Pomodoro mark — stand up, roll your shoulders.'\n\
  MM ≥ 40: 'Pomodoro mark — sip water, then a deep breath.'\n\
speak text:<cue>. memory_add tags:['#pomodoro'] text:'<HH:MM> · <app> — <title>' so the weekly review can see your focus surface.";

const MEMORY_CONSOLIDATE_GOAL: &str = "Review episodic memory entries from the last 7 days. \
    Use memory_search query='' limit=100 to pull recent rows. Identify 3-5 durable facts about \
    Sunny (preferences, recurring topics, people in their life, routines) and write each one via \
    memory_remember with tags=['auto-consolidated','consolidated-YYYY-MM-DD']. Return a one-line summary.";

const MEMORY_COMPACT_GOAL: &str = "Run memory_compact with the default threshold (0.85) to \
    dedupe near-duplicate semantic facts. The compactor clusters facts by embedding cosine \
    similarity, keeps the highest-confidence representative per cluster, unions the losing \
    rows' tags into it, and soft-deletes the rest (they remain physically present so a bad \
    compaction is reversible). Return a one-line summary of the form \
    'compacted N facts → M clusters (D soft-deleted)'. If deleted is 0, say 'no duplicates found'. \
    Do not speak; this is quiet maintenance.";

const AGENT_SELF_REFLECT_GOAL: &str = "Call agent_reflect with default window_size. This \
    pulls the last 20 agent_step episodic rows and 20 tool_usage rows, runs a critic sub-agent \
    (cheap qwen2.5:7b) to identify 3-5 lessons about tool-call errors, user corrections, and \
    awkward answers, and writes each lesson to semantic memory tagged \
    ['self-reflection','lesson',<severity>]. Do not speak. Return the one-line summary that \
    agent_reflect produces.";

const HEARTBEAT_REFRESH_GOAL: &str = "Refresh SUNNY's HEARTBEAT. Call memory_search query:'' \
    limit:50 to pull the last day or two of episodic rows. Skim them for emotional tone, \
    recurring themes, and anything worth carrying into tomorrow.\n\
    Compose exactly three paragraphs, markdown-bolded headings, no code fences:\n\
      **TONE.** <2–3 sentences on how SUNNY feels today — calm, stretched, playful, \
      reflective, etc.>\n\
      **FOCUS.** <2–3 sentences on what's been most prominent — projects, people, \
      problems.>\n\
      **NOTES.** <2–3 sentences of threads to carry forward — unresolved loops, promises, \
      things to notice.>\n\
    Then call persona_update_heartbeat body:<the three paragraphs exactly, nothing else>. \
    Do not speak. Do not write a note — the HEARTBEAT file IS the output. Under 800 words \
    total. If memory_search returns nothing, write a short honest body about the quiet day.";

const NEWS_DIGEST_GOAL: &str = "memory_search query:'interest topic' limit:10. Extract up to 3 distinct topic strings. If the search returns nothing, fall back to ['world news', 'technology', 'artificial intelligence'].\n\
FAN OUT with spawn_parallel wait:true timeout_sec:360. Build one goal per topic:\n\
  'Find one fresh news story on \"<topic>\". Call web_search query:\"<topic> today\" limit:5. Skip any URL whose domain already appears in memory_search query:\"news-digest <domain>\" limit:1 with an ISO timestamp newer than 48h — move to the next hit. Take the first fresh result and web_fetch_readable it. Return EXACTLY: \"TITLE::<title>\\nURL::<url>\\nSUMMARY::<sentence 1, the fact, ≤45 words>\\n<sentence 2, why it matters, ≤45 words>\". No preamble.'\n\
labels:['news:<topic>', ...].\n\
Parse each successful child's 3-line answer (TITLE / URL / SUMMARY). Skip any child with status=error.\n\
Persist: notes_create title:'News digest — <YYYY-MM-DD>' folder:'News' body:<markdown: one H3 per topic with the title as a link, the URL on its own line, then the 2-sentence summary>. memory_add tags:['#news-digest'] text:'<topic>|<url>' per story (one call per story for clean dedupe). Do not speak.";

fn morning_brief() -> JobTemplate {
    JobTemplate {
        id: "morning-brief",
        title: "Morning brief",
        description: "Mail + calendar + weather combined into one spoken brief at 8 am.",
        schedule_hint: "Every day at 8:00 am",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(8),
        next_minute: Some(0),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: MORNING_BRIEF_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn midday_inbox() -> JobTemplate {
    JobTemplate {
        id: "midday-inbox",
        title: "Midday inbox triage",
        description: "One-sentence unread-mail overview at noon — counts, priorities, action items.",
        schedule_hint: "Every day at 12:00 pm",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(12),
        next_minute: Some(0),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: MIDDAY_INBOX_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn evening_recap() -> JobTemplate {
    JobTemplate {
        id: "evening-recap",
        title: "Evening recap",
        description: "Three-sentence summary of today's events and notes, written to Apple Notes.",
        schedule_hint: "Every day at 6:00 pm",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(18),
        next_minute: Some(0),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: EVENING_RECAP_GOAL.to_string(),
            speak_answer: false,
            write_note: Some("Daily Recap".to_string()),
        },
    }
}

fn competitor_watch() -> JobTemplate {
    JobTemplate {
        id: "competitor-watch",
        title: "Weekly competitor scan",
        description: "Researcher sub-agent pulls last week's news on Frey Market and FounderLink competitors.",
        schedule_hint: "Every Monday at 9:00 am",
        kind: JobKind::Interval,
        every_sec: Some(604_800),
        next_hour: Some(9),
        next_minute: Some(0),
        next_weekday: Some(chrono::Weekday::Mon),
        action: JobAction::AgentGoal {
            goal: COMPETITOR_WATCH_GOAL.to_string(),
            speak_answer: false,
            write_note: Some("Competitor Weekly".to_string()),
        },
    }
}

fn stock_watchdog() -> JobTemplate {
    JobTemplate {
        id: "stock-watchdog",
        title: "Stock watchdog (NVDA)",
        description: "Every 5 minutes, checks NVDA. Silent unless price crosses 200 — then a spoken alert.",
        schedule_hint: "Every 5 minutes",
        kind: JobKind::Interval,
        every_sec: Some(300),
        next_hour: None,
        next_minute: None,
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: STOCK_WATCHDOG_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn end_of_day() -> JobTemplate {
    JobTemplate {
        id: "end-of-day",
        title: "End-of-day wrap",
        description: "Each evening, wrap the day: what closed, what slipped, top 3 for tomorrow — saved as a note.",
        schedule_hint: "Every day at 6:30 pm",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(18),
        next_minute: Some(30),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: END_OF_DAY_GOAL.to_string(),
            speak_answer: false,
            write_note: Some("End of Day".to_string()),
        },
    }
}

fn weather_commute() -> JobTemplate {
    JobTemplate {
        id: "weather-commute",
        title: "Weather & commute",
        description: "Every morning, rain or wind-worthy heads-up based on today's forecast — speaks only when it matters.",
        schedule_hint: "Every day at 7:30 am",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(7),
        next_minute: Some(30),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: WEATHER_COMMUTE_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn focus_checkin() -> JobTemplate {
    JobTemplate {
        id: "focus-checkin",
        title: "Focus check-in",
        description: "During work hours every 90 min, speak a check-in and log the foreground window to memory.",
        schedule_hint: "Every 90 minutes",
        kind: JobKind::Interval,
        every_sec: Some(5_400),
        next_hour: None,
        next_minute: None,
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: FOCUS_CHECKIN_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn inbox_triage() -> JobTemplate {
    JobTemplate {
        id: "inbox-triage",
        title: "Inbox triage",
        description: "Every 30 min, flag unread mail that looks urgent — de-duped so you only hear each one once.",
        schedule_hint: "Every 30 minutes",
        kind: JobKind::Interval,
        every_sec: Some(1_800),
        next_hour: None,
        next_minute: None,
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: INBOX_TRIAGE_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn imessage_digest() -> JobTemplate {
    JobTemplate {
        id: "imessage-digest",
        title: "iMessage digest",
        description: "Every hour, summarise unread iMessages into one sentence per person and save them as a note.",
        schedule_hint: "Every hour",
        kind: JobKind::Interval,
        every_sec: Some(3_600),
        next_hour: None,
        next_minute: None,
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: IMESSAGE_DIGEST_GOAL.to_string(),
            speak_answer: false,
            write_note: Some("Digests".to_string()),
        },
    }
}

fn meeting_prep() -> JobTemplate {
    JobTemplate {
        id: "meeting-prep",
        title: "Meeting prep",
        description: "Every 15 min, if a meeting starts in ≤10 min, compile a prep brief from notes, memory, and calendar context.",
        schedule_hint: "Every 15 minutes",
        kind: JobKind::Interval,
        every_sec: Some(900),
        next_hour: None,
        next_minute: None,
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: MEETING_PREP_GOAL.to_string(),
            speak_answer: true,
            write_note: Some("Meeting Prep".to_string()),
        },
    }
}

fn pomodoro() -> JobTemplate {
    JobTemplate {
        id: "pomodoro",
        title: "Pomodoro companion",
        description: "Every 25 minutes during work hours, speak a 2-minute rest cue and log the foreground window.",
        schedule_hint: "Every 25 minutes",
        kind: JobKind::Interval,
        every_sec: Some(1_500),
        next_hour: None,
        next_minute: None,
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: POMODORO_GOAL.to_string(),
            speak_answer: true,
            write_note: None,
        },
    }
}

fn news_digest() -> JobTemplate {
    JobTemplate {
        id: "news-digest",
        title: "News digest",
        description: "Every morning, pull a fresh story for each topic I follow and file a cited 2-sentence summary.",
        schedule_hint: "Every day at 7:00 am",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(7),
        next_minute: Some(0),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: NEWS_DIGEST_GOAL.to_string(),
            speak_answer: false,
            write_note: Some("News".to_string()),
        },
    }
}

fn memory_consolidate() -> JobTemplate {
    JobTemplate {
        id: "memory-consolidate",
        title: "Memory consolidation",
        description: "Nightly at 3 am, distil the last week of episodic memory into durable semantic facts.",
        schedule_hint: "Every day at 3:00 am",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(3),
        next_minute: Some(0),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: MEMORY_CONSOLIDATE_GOAL.to_string(),
            speak_answer: false,
            write_note: None,
        },
    }
}

/// Runs 30 minutes after `memory-consolidate` so any freshly-added
/// semantic facts have time to be embedded (the backfill loop ticks
/// every 30 s) before the compactor starts clustering. Compaction is a
/// cheap pure-SQL + cosine pass — no LLM round — so running it nightly
/// keeps memory sharp without burning tokens.
fn memory_compact() -> JobTemplate {
    JobTemplate {
        id: "memory-compact",
        title: "Memory compaction",
        description: "Nightly at 3:30 am, cluster near-duplicate semantic facts and keep the strongest representative per cluster.",
        schedule_hint: "Every day at 3:30 am",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(3),
        next_minute: Some(30),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: MEMORY_COMPACT_GOAL.to_string(),
            speak_answer: false,
            write_note: None,
        },
    }
}

/// Nightly 23:00 refresh of `~/.sunny/HEARTBEAT.md`. Pulls the last ~day
/// of episodic rows, asks the agent loop to compose a TONE / FOCUS /
/// NOTES body, and writes it via the DANGEROUS `persona_update_heartbeat`
/// tool. Keeps SUNNY's heartbeat file reflective of actual recent
/// behaviour instead of a static doc.
fn heartbeat_refresh() -> JobTemplate {
    JobTemplate {
        id: "heartbeat-refresh",
        title: "Heartbeat refresh",
        description: "Nightly at 11 pm, distil the day's episodic memory into a fresh TONE / FOCUS / NOTES block in ~/.sunny/HEARTBEAT.md.",
        schedule_hint: "Every day at 11:00 pm",
        kind: JobKind::Interval,
        every_sec: Some(86_400),
        next_hour: Some(23),
        next_minute: Some(0),
        next_weekday: None,
        action: JobAction::AgentGoal {
            goal: HEARTBEAT_REFRESH_GOAL.to_string(),
            speak_answer: false,
            write_note: None,
        },
    }
}

/// Weekly self-reflection — Sundays at 22:00. Reviews the last 20 agent
/// steps + tool usage rows and writes durable lessons into semantic
/// memory. Cheap (cheap critic model, ≤60 s) and safe (only writes to
/// memory, never side effects).
fn agent_self_reflect() -> JobTemplate {
    JobTemplate {
        id: "agent-self-reflect",
        title: "Agent self-reflect",
        description: "Weekly self-review — pulls the last 20 agent steps + tool calls, distils 3-5 lessons into semantic memory tagged 'self-reflection'.",
        schedule_hint: "Every Sunday at 10:00 pm",
        kind: JobKind::Interval,
        every_sec: Some(604_800),
        next_hour: Some(22),
        next_minute: Some(0),
        next_weekday: Some(chrono::Weekday::Sun),
        action: JobAction::AgentGoal {
            goal: AGENT_SELF_REFLECT_GOAL.to_string(),
            speak_answer: false,
            write_note: None,
        },
    }
}

/// Return every curated template. Order is the canonical order used by the
/// Auto-page picker — keep it stable.
pub fn all_templates() -> Vec<JobTemplate> {
    vec![
        morning_brief(),
        midday_inbox(),
        evening_recap(),
        competitor_watch(),
        stock_watchdog(),
        end_of_day(),
        weather_commute(),
        focus_checkin(),
        inbox_triage(),
        imessage_digest(),
        meeting_prep(),
        pomodoro(),
        news_digest(),
        memory_consolidate(),
        memory_compact(),
        heartbeat_refresh(),
        agent_self_reflect(),
    ]
}

/// Look up a single template by its stable id. Returns `None` for unknown ids
/// so the caller can surface a structured error rather than panicking.
pub fn template_by_id(id: &str) -> Option<JobTemplate> {
    all_templates().into_iter().find(|t| t.id == id)
}

// -------------------- tests --------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_templates_has_five_unique_ids() {
        let templates = all_templates();
        assert_eq!(templates.len(), 17);
        let mut ids: Vec<&str> = templates.iter().map(|t| t.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 17, "template ids must be unique");
    }

    #[test]
    fn agent_self_reflect_template_present_and_serialises() {
        let t = template_by_id("agent-self-reflect")
            .expect("agent-self-reflect must exist");
        assert_eq!(t.title, "Agent self-reflect");
        // Weekly cadence.
        assert_eq!(t.every_sec, Some(604_800));
        // Sunday 22:00.
        assert_eq!(
            (t.next_hour, t.next_minute, t.next_weekday),
            (Some(22), Some(0), Some(chrono::Weekday::Sun))
        );
        let JobAction::AgentGoal { goal, speak_answer, write_note } = &t.action else {
            panic!("agent-self-reflect must use AgentGoal");
        };
        // The goal must instruct the agent to call the new tool.
        assert!(goal.contains("agent_reflect"));
        assert!(goal.contains("self-reflection"));
        // Quiet maintenance — no speaking, no note.
        assert!(!*speak_answer && write_note.is_none());
        let serialised = serde_json::to_string(&t.action).expect("serialise");
        let _round_trip: JobAction = serde_json::from_str(&serialised).expect("deserialise");
    }

    #[test]
    fn heartbeat_refresh_template_present_and_serialises() {
        let t = template_by_id("heartbeat-refresh")
            .expect("heartbeat-refresh must exist");
        assert_eq!(t.title, "Heartbeat refresh");
        assert_eq!(t.every_sec, Some(86_400));
        assert_eq!((t.next_hour, t.next_minute, t.next_weekday), (Some(23), Some(0), None));
        let JobAction::AgentGoal { goal, speak_answer, write_note } = &t.action else {
            panic!("heartbeat-refresh must use AgentGoal");
        };
        assert!(goal.contains("persona_update_heartbeat"));
        assert!(goal.contains("memory_search"));
        assert!(goal.contains("TONE") && goal.contains("FOCUS") && goal.contains("NOTES"));
        assert!(!*speak_answer && write_note.is_none());
        let serialised = serde_json::to_string(&t.action).expect("serialise");
        let _round_trip: JobAction = serde_json::from_str(&serialised).expect("deserialise");
    }

    #[test]
    fn memory_compact_template_runs_after_consolidate() {
        let consolidate = template_by_id("memory-consolidate")
            .expect("memory-consolidate must exist");
        let compact = template_by_id("memory-compact")
            .expect("memory-compact must exist");
        assert_eq!(compact.title, "Memory compaction");
        assert_eq!(compact.every_sec, Some(86_400));
        // Compaction runs 30 minutes after consolidation so freshly
        // embedded facts are eligible for clustering.
        assert_eq!(
            (consolidate.next_hour, consolidate.next_minute),
            (Some(3), Some(0))
        );
        assert_eq!(
            (compact.next_hour, compact.next_minute),
            (Some(3), Some(30))
        );
        let JobAction::AgentGoal { goal, speak_answer, write_note } = &compact.action
        else {
            panic!("memory-compact must use AgentGoal");
        };
        assert!(goal.contains("memory_compact"));
        assert!(!*speak_answer && write_note.is_none());
    }

    #[test]
    fn memory_consolidate_template_present_and_serialises() {
        let t = template_by_id("memory-consolidate").expect("memory-consolidate must exist");
        assert_eq!(t.title, "Memory consolidation");
        assert_eq!(t.every_sec, Some(86_400));
        assert_eq!((t.next_hour, t.next_minute, t.next_weekday), (Some(3), Some(0), None));
        let JobAction::AgentGoal { goal, speak_answer, write_note } = &t.action else {
            panic!("memory-consolidate must use AgentGoal");
        };
        assert!(goal.contains("episodic memory") && goal.contains("memory_remember"));
        assert!(goal.contains("auto-consolidated"));
        assert!(!*speak_answer && write_note.is_none());
        let serialised = serde_json::to_string(&t.action).expect("serialise");
        let _round_trip: JobAction = serde_json::from_str(&serialised).expect("deserialise");
    }

    #[test]
    fn template_by_id_finds_each_template() {
        for t in all_templates() {
            let looked_up = template_by_id(t.id).expect("known id should resolve");
            assert_eq!(looked_up.id, t.id);
            assert_eq!(looked_up.title, t.title);
        }
        assert!(template_by_id("does-not-exist").is_none());
    }

    #[test]
    fn templates_round_trip_through_json() {
        // If a template's action won't serialise/deserialise cleanly we'd
        // never be able to persist the resulting job — catch it here.
        for t in all_templates() {
            let serialised = serde_json::to_string(&t.action).expect("serialize action");
            let action: JobAction =
                serde_json::from_str(&serialised).expect("deserialize action");
            match (&t.action, &action) {
                (
                    JobAction::AgentGoal { goal: g1, speak_answer: s1, write_note: n1 },
                    JobAction::AgentGoal { goal: g2, speak_answer: s2, write_note: n2 },
                ) => {
                    assert_eq!(g1, g2);
                    assert_eq!(s1, s2);
                    assert_eq!(n1, n2);
                }
                _ => panic!("all curated templates use AgentGoal"),
            }
        }
    }

    #[test]
    fn to_job_yields_enabled_job_with_future_next_run() {
        let now = now_unix();
        for t in all_templates() {
            let job = t.to_job();
            assert!(job.enabled, "{} should be enabled after install", t.id);
            assert_eq!(job.title, t.title);
            assert_eq!(job.every_sec, t.every_sec);
            assert_eq!(job.kind, t.kind);
            let next = job.next_run.expect("next_run set");
            // Stock watchdog resolves to midnight which may be ≥ a few hours
            // out but always ≥ now. All others are specific wall-clock times
            // strictly in the future.
            assert!(next >= now, "{}: next_run {} must be >= now {}", t.id, next, now);
        }
    }

    #[test]
    fn to_job_produces_distinct_ids_on_repeat_install() {
        let t = morning_brief();
        let a = t.to_job();
        let b = t.to_job();
        assert_ne!(a.id, b.id, "each install should mint a unique id");
    }

    #[test]
    fn next_local_at_weekday_lands_on_that_weekday() {
        use chrono::{Datelike, Local, TimeZone};
        let ts = next_local_at(9, 0, Some(chrono::Weekday::Mon));
        let dt = Local.timestamp_opt(ts, 0).single().expect("valid ts");
        assert_eq!(dt.weekday(), chrono::Weekday::Mon);
        assert_eq!(dt.hour(), 9);
        assert_eq!(dt.minute(), 0);
        use chrono::Timelike;
        assert_eq!(dt.second(), 0);
    }

    #[test]
    fn next_local_at_without_weekday_is_within_24h() {
        let now = now_unix();
        let ts = next_local_at(8, 0, None);
        assert!(ts > now);
        assert!(ts <= now + 86_400 + 60, "next 8am should be within ~24h");
    }
}
