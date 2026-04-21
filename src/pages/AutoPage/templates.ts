// Starter agent templates — one-tap recipes the user can install.
//
// Each template becomes a daemon when installed. Goals are written in
// natural English but *name the tools the ReAct loop should call*, in
// the exact shape the registry accepts, so the LLM doesn't have to
// improvise schemas. Every tool referenced here is registered at app
// boot (see `src/lib/tools/index.ts` + side-effect imports in
// `src/App.tsx`); if a template names a tool that isn't registered,
// the daemon will fail fast and that's a bug we want to see.
//
// Conventions used across goals:
//   • Absolute paths whenever a filesys tool is called. For moves that
//     need `~` expansion we use run_shell (which runs through
//     /bin/zsh -lc and expands tildes).
//   • memory_search takes only {query, limit} — the FTS index covers
//     both `text` and `tags`, so a bare query like "watchlist" hits
//     memories tagged #watchlist as well as ones that say the word.
//   • Dedupe / rate-limit via memory: write a marker tagged with a
//     per-template id, then memory_search that query before re-alerting.
//   • speak is the user-facing notification channel; daemons stay
//     silent unless the user actually needs to know something.
//   • Every long-running action (scan_start, deep_research) has an
//     explicit wait cap.

import type { DaemonKind, DaemonSpec } from '../../store/daemons';

export type Template = Readonly<{
  id: string;
  category:
    | 'MORNING'
    | 'FOCUS'
    | 'INBOX'
    | 'CLEANUP'
    | 'WATCHERS'
    | 'LEARN'
    | 'CODING'
    | 'RESEARCH'
    | 'WRITING'
    | 'LIFE'
    | 'MONEY'
    | 'HOME';
  title: string;
  icon: string; // single glyph
  summary: string;
  /** Kind + schedule preset. User can edit these after installing. */
  kind: DaemonKind;
  everySec?: number;
  /** Default goal the agent is asked to fulfill each fire. */
  goal: string;
}>;

export const TEMPLATES: ReadonlyArray<Template> = [
  // ── MORNING ──────────────────────────────────────────────────
  {
    id: 'morning-brief',
    category: 'MORNING',
    title: 'Morning briefing',
    icon: '☀',
    summary:
      "At 8am, a 4-block briefing: calendar, top priorities, urgent mail, weather — spoken headline + full note.",
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Produce this morning's briefing in four numbered blocks, each ≤3 lines:\n" +
      "1) AGENDA — call calendar_today; list every event as 'HH:MM <title>' sorted by time. If empty, write 'No events.'\n" +
      "2) PRIORITIES — call memory_search query:'priority' limit:5. Pick the 3 most recent; one line each; if none, say 'No #priority memories stored.'\n" +
      "3) MAIL — call mail_list_unread limit:10. Pick up to 3 that (a) come from someone I emailed in the last week or (b) contain 'urgent', 'deadline', 'today', or 'asap' (case-insensitive). One line each: 'From <name>: <subject>'. Otherwise write 'Inbox clear.'\n" +
      "4) WEATHER — call memory_search query:'home location' limit:3 to resolve my city (fall back to 'San Francisco' if nothing is stored). Call weather_current with that city and condense to one sentence.\n" +
      "After building the briefing: speak ONLY the 1-sentence headline (e.g. 'Three meetings today, top priority is <X>, <weather>'). Then notes_create title:'Morning briefing — <YYYY-MM-DD>' folder:'Briefings' body:<the full 4-block text>.",
  },
  {
    id: 'end-of-day',
    category: 'MORNING',
    title: 'End-of-day wrap',
    icon: '☾',
    summary:
      'Each evening, wrap the day: what closed, what slipped, top 3 for tomorrow — saved as a note.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Wrap today in a structured note. Gather inputs:\n" +
      "• reminders_today — open reminders still pending (these are the 'slipped' candidates).\n" +
      "• calendar_today — the events I actually had.\n" +
      "• memory_search query:'standup OR done OR shipped' limit:20 — anything I logged during the day.\n" +
      "• calendar_upcoming days:1 — what's already on the books for tomorrow.\n" +
      "Build a 300-word markdown note with headings:\n" +
      "  ### Shipped — concrete things I finished (from memory + reminders you infer are done).\n" +
      "  ### Slipped — items still open from reminders_today, with best-guess reason each.\n" +
      "  ### Tomorrow — exactly 3 bullets, ordered, grounded in the calendar or open reminders.\n" +
      "Persist via notes_create title:'EOD — <YYYY-MM-DD>' folder:'End of Day' body:<markdown>. Also memory_add tags:['#eod', '<YYYY-MM-DD>'] text:<the Tomorrow bullets>. Do not speak; this runs quietly.",
  },

  // ── FOCUS ────────────────────────────────────────────────────
  {
    id: 'focus-checkin',
    category: 'FOCUS',
    title: 'Focus check-in',
    icon: '◎',
    summary:
      'During work hours every 90 min, speak a check-in and log the foreground window to memory.',
    kind: 'interval',
    everySec: 5400,
    goal:
      "Call timezone_now tz:'America/Los_Angeles' (if memory_search query:'timezone' returns a different IANA zone, prefer that). Parse the weekday and HH from the output. If weekday is Saturday/Sunday OR HH < 9 OR HH >= 18, return 'skipped — outside work hours' and do nothing else.\n" +
      "Otherwise: screen_capture_active_window. From its `data` pull the foreground app and window title. Speak text:'Focus check — what are you working on right now?' Then memory_add tags:['#focus'] text:'<HH:MM> · <app> — <title>'. Don't wait for a reply; the check-in is one-shot.",
  },
  {
    id: 'standup-notes',
    category: 'FOCUS',
    title: 'Auto-generated standup',
    icon: '⊡',
    summary:
      "Each weekday, draft a Yesterday / Today / Blockers standup from yesterday's calendar, memory, and reminders.",
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Only run on weekdays: timezone_now tz:'America/Los_Angeles'; if the output's weekday is Saturday or Sunday, stop.\n" +
      "Gather: memory_search query:'shipped OR done OR focus' limit:30 for activity, calendar_upcoming days:1 for today's agenda, reminders_today for open items.\n" +
      "Compose a three-section standup:\n" +
      "  **Yesterday** — up to 4 concrete achievements from memory timestamped in the last 24h.\n" +
      "  **Today** — up to 4 bullets tied to calendar events or top reminders_today entries.\n" +
      "  **Blockers** — open reminders older than 48h that look stuck; empty list is fine.\n" +
      "Persist: notes_create title:'Standup — <YYYY-MM-DD>' folder:'Standups' body:<markdown>, and memory_add tags:['#standup'] text:<the standup>. Silent — no speak.",
  },

  // ── INBOX ────────────────────────────────────────────────────
  {
    id: 'inbox-triage',
    category: 'INBOX',
    title: 'Inbox triage',
    icon: '✉',
    summary:
      'Every 30 min, flag unread mail that looks urgent — de-duped so you only hear each one once.',
    kind: 'interval',
    everySec: 1800,
    goal:
      "Call mail_list_unread limit:30. For each line, extract the sender and subject. An item is URGENT iff ANY of these hold: (a) subject contains 'urgent', 'asap', 'today', 'deadline', 'overdue', or a time expression like 'by 5pm' (case-insensitive); (b) sender appears in memory_search query:'vip' limit:20; (c) subject contains a direct question mark.\n" +
      "For each urgent item, build a dedupe key 'mail-seen:<sender>|<subject>'. memory_search query:<that key> limit:1 — if a hit exists, skip. Otherwise memory_add tags:['#inbox-seen'] text:<the key>, and accumulate it for the alert.\n" +
      "If the accumulated list is non-empty, speak ONE sentence: '<N> urgent: <first sender> about <first subject>, plus <N-1> more.' If nothing urgent or nothing new, return 'clean' without speaking.",
  },
  {
    id: 'imessage-wake',
    category: 'INBOX',
    title: 'iMessage digest',
    icon: '◉',
    summary:
      'Every hour, summarise unread iMessages into one sentence per person and save them as a note.',
    kind: 'interval',
    everySec: 3600,
    goal:
      "Call list_chats. From its `data`, pick chats whose unread_count ≥ 1. For each such chat (max 8), call fetch_conversation for that chat with a limit of 10 messages. Compose one sentence per chat in the form '<other person>: <core point, ≤18 words>'. Skip system chats ('SMS', unnamed group chats with only your handle). If zero chats qualify, stop quietly.\n" +
      "Otherwise notes_create title:'iMessage digest — <YYYY-MM-DD HH:MM>' folder:'Digests' body:<bulleted list>, and memory_add tags:['#imessage-digest'] text:<same bullets>. Do not speak.",
  },

  // ── CLEANUP ──────────────────────────────────────────────────
  {
    id: 'downloads-sweep',
    category: 'CLEANUP',
    title: 'Downloads auto-sort',
    icon: '⇩',
    summary:
      'Every 6 hours, sort ~/Downloads by type, archive anything older than 7 days — never touches fresh files.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "Plan first, move second. Enumerate with run_shell cmd:'find ~/Downloads -maxdepth 1 -mindepth 1 -not -path \"*/Archive*\" -not -path \"*/Images*\" -not -path \"*/PDFs*\" -not -path \"*/Installers*\" -not -path \"*/Archives*\" -print0 | xargs -0 stat -f \"%m|%z|%N\"'.\n" +
      "Parse lines as 'mtime_epoch|size_bytes|absolute_path'. Ignore anything where (now_epoch - mtime) < 86400 (touched in the last 24h). For the remainder, bucket by extension:\n" +
      "  .png .jpg .jpeg .heic .gif .webp → ~/Downloads/Images/\n" +
      "  .pdf                                → ~/Downloads/PDFs/\n" +
      "  .dmg .pkg .iso .app                 → ~/Downloads/Installers/\n" +
      "  .zip .tar .tgz .gz .rar .7z         → ~/Downloads/Archives/\n" +
      "  mtime > 7d regardless of ext        → ~/Downloads/Archive/<YYYY-MM>/\n" +
      "Execute each move with run_shell cmd:'mkdir -p <dest> && mv <src> <dest>/'. Track counts. At the end, memory_add tags:['#downloads-sweep'] text:'Moved N files: images=A pdfs=B installers=C archives=D aged=E'. Do not speak — this is background hygiene.",
  },
  {
    id: 'desktop-zero',
    category: 'CLEANUP',
    title: 'Desktop zero',
    icon: '▱',
    summary:
      'Every morning, archive Desktop files older than 3 days into a dated folder — hidden files untouched.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Read timezone_now tz:'America/Los_Angeles' and extract YYYY-MM-DD.\n" +
      "run_shell cmd:'mkdir -p ~/Desktop/Archive/<YYYY-MM-DD> && find ~/Desktop -maxdepth 1 -mindepth 1 -not -name \".*\" -not -path \"~/Desktop/Archive*\" -mtime +3 -print' to list archive candidates.\n" +
      "If the list is empty, memory_add tags:['#desktop-zero'] text:'Desktop already clean.' and stop.\n" +
      "Otherwise run_shell cmd:'for f in <each path, shell-quoted>; do mv \"$f\" ~/Desktop/Archive/<YYYY-MM-DD>/; done'. Confirm with run_shell cmd:'ls ~/Desktop/Archive/<YYYY-MM-DD> | wc -l'. memory_add tags:['#desktop-zero'] text:'Archived <N> files into Archive/<YYYY-MM-DD>.' Silent run.",
  },

  // ── WATCHERS ─────────────────────────────────────────────────
  {
    id: 'security-sweep',
    category: 'WATCHERS',
    title: 'Security sweep',
    icon: '⛨',
    summary:
      'Every 6 hours, scan Downloads + LaunchAgents with online hash lookup and alert only on malicious hits.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "FAN OUT with spawn_parallel wait:true timeout_sec:180 — the two scans are independent and can run in parallel. Use these two goals:\n" +
      "  goal 1: 'Scan ~/Downloads for malware. Call scan_start target:\"~/Downloads\" recursive:true online_lookup:true deep:false wait_seconds:90. If data.progress shows malicious>0 OR suspicious>0, also call scan_findings scan_id:<the id> limit:10 and collect the top 3 paths + verdicts. Return EXACTLY: \"target=Downloads malicious=<N> suspicious=<M> top=<path1|verdict1>; <path2|verdict2>; <path3|verdict3>\" (omit top=... if clean).'\n" +
      "  goal 2: 'Scan ~/Library/LaunchAgents for malware. Same shape but target:\"~/Library/LaunchAgents\" deep:true wait_seconds:60. Return the same single-line format with target=LaunchAgents.'\n" +
      "labels:['security:Downloads','security:LaunchAgents'].\n" +
      "Parse both children's one-line answers. Aggregate totals.\n" +
      "If total malicious=0 AND suspicious=0, memory_add tags:['#security-sweep'] text:'clean <ISO>' and stop silently.\n" +
      "Otherwise speak ONE sentence: '<N_total> suspicious, <M_total> malicious — open SCAN to triage <first top path>.' memory_add tags:['#security-sweep','#hit'] text:<both children's lines joined by newline>.",
  },
  {
    id: 'process-audit',
    category: 'WATCHERS',
    title: 'Running process audit',
    icon: '⚙',
    summary:
      'Once a day, hash every running binary against MalwareBazaar and alert if anything lights up.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "run_shell cmd:'ps -Axo comm | sort -u | grep \"^/\" | head -80' to collect unique executable paths that are full file paths (ignores shorthand names). Pick up to 20 distinct paths.\n" +
      "For each path: scan_start target:<path> recursive:false online_lookup:true deep:true wait_seconds:20. Record the scanId and whether malicious/suspicious > 0.\n" +
      "If any scan flagged a hit, scan_findings for each flagged scanId limit:5, aggregate into a bullet list, and speak ONE sentence: '<N> running binaries flagged — <top binary name>.' Then memory_add tags:['#process-audit','#hit'] text:<findings>.\n" +
      "If everything clean, memory_add tags:['#process-audit'] text:'<ISO> audit clean, N=<count>' and stay silent.",
  },

  // ── LEARN ────────────────────────────────────────────────────
  {
    id: 'weekly-review',
    category: 'LEARN',
    title: 'Weekly review',
    icon: '↻',
    summary:
      'Every Sunday, synthesise the past 7 days from memory + calendar into a 300-word reflection.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "Gather material: memory_search query:'standup' limit:20, memory_search query:'focus' limit:30, memory_search query:'eod' limit:10, calendar_upcoming days:7 (used only to reason about what WAS on last week's books if the user runs this mid-week).\n" +
      "Write a 300-word markdown reflection with exactly these four H3 sections:\n" +
      "  ### Wins — 3 concrete accomplishments with dates.\n" +
      "  ### Patterns — 2 themes I kept hitting (good or bad), grounded in the memory entries.\n" +
      "  ### Friction — 2 things that slowed me, each with a likely cause.\n" +
      "  ### Next week — 3 experiments to try, each a single imperative sentence.\n" +
      "Persist: notes_create title:'Weekly review — <YYYY-MM-DD>' folder:'Weekly reviews' body:<markdown>, and memory_add tags:['#weekly-review'] text:<the Next-week bullets only — they're small and searchable>. Do not speak.",
  },
  {
    id: 'knowledge-rotator',
    category: 'LEARN',
    title: 'Knowledge rotator',
    icon: '✦',
    summary:
      'Every 4 hours, pick a stored fact and speak it as a recall question — spaced-repetition style.',
    kind: 'interval',
    everySec: 14_400,
    goal:
      "memory_search query:'fact' limit:40. Filter to entries that contain the word 'fact' or were tagged with '#fact' (both will surface from the same FTS query). If fewer than 3 results, fall back to memory_list limit:40 and pick any 1.\n" +
      "Choose ONE entry at random. Rephrase it as a single recall question ≤20 words that doesn't leak the answer (e.g. if the fact is 'SUNNY uses SQLite FTS5 for memory search', ask 'Which indexing engine does SUNNY use for memory search?').\n" +
      "speak text:<that question>. memory_add tags:['#flashcard-asked'] text:'asked <ISO> · id <first 8 of fact id> · <the question>' so the next run can avoid immediate repeats (optional: skip ids present in the last 24h of '#flashcard-asked').",
  },

  // ── MORNING · extended ───────────────────────────────────────
  {
    id: 'weather-commute',
    category: 'MORNING',
    title: 'Weather & commute',
    icon: '☁',
    summary:
      "Every morning, rain or wind-worthy heads-up based on today's forecast — speaks only when it matters.",
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Resolve my city: memory_search query:'home location' limit:3. Pick the most recent entry that looks like a city name; fall back to 'San Francisco' if nothing matches. Use that city for every downstream call.\n" +
      "Call weather_current city:<city>, weather_forecast city:<city> days:1, and sunrise_sunset city:<city>.\n" +
      "Scan the returned text blobs (they're natural language) for these triggers in order:\n" +
      "  • rain / showers / thunderstorm → say 'Take an umbrella — <forecast condition> expected.'\n" +
      "  • wind > 30 km/h / gusts / gale → say 'Windy day — secure anything loose.'\n" +
      "  • temperature > 32°C or < 0°C   → say 'Extreme temp — high <N>, low <M>.'\n" +
      "  • sunset before 17:30            → say 'Sunset at <HH:MM> — plan the evening.'\n" +
      "Speak only the first trigger that matches, with a 12-word cap. If nothing matches, memory_add tags:['#weather'] text:<weather_current output> and stay silent.",
  },
  {
    id: 'news-digest',
    category: 'MORNING',
    title: 'News digest',
    icon: '⊞',
    summary:
      'Every morning, pull a fresh story for each topic I follow and file a cited 2-sentence summary.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "memory_search query:'interest topic' limit:10. Extract up to 3 distinct topic strings. If the search returns nothing, fall back to ['world news', 'technology', 'artificial intelligence'].\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:360. Build one goal per topic:\n" +
      "  'Find one fresh news story on \"<topic>\". Call web_search query:\"<topic> today\" limit:5. Skip any URL whose domain already appears in memory_search query:\"news-digest <domain>\" limit:1 with an ISO timestamp newer than 48h — move to the next hit. Take the first fresh result and web_fetch_readable it. Return EXACTLY: \"TITLE::<title>\\nURL::<url>\\nSUMMARY::<sentence 1, the fact, ≤45 words>\\n<sentence 2, why it matters, ≤45 words>\". No preamble.'\n" +
      "labels:['news:<topic>', ...].\n" +
      "Parse each successful child's 3-line answer (TITLE / URL / SUMMARY). Skip any child with status=error.\n" +
      "Persist: notes_create title:'News digest — <YYYY-MM-DD>' folder:'News' body:<markdown: one H3 per topic with the title as a link, the URL on its own line, then the 2-sentence summary>. memory_add tags:['#news-digest'] text:'<topic>|<url>' per story (one call per story for clean dedupe). Do not speak.",
  },
  {
    id: 'portfolio-ping',
    category: 'MORNING',
    title: 'Portfolio ping',
    icon: '△',
    summary:
      'On weekday mornings, price + daily move for each ticker in #watchlist — one spoken sentence.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Weekday gate: timezone_now tz:'America/New_York'; if weekday is Sat/Sun, stop.\n" +
      "memory_search query:'watchlist' limit:10. Parse ticker symbols from the text (3-5 uppercase letters or crypto like BTC, ETH). Stop with speak text:'No watchlist — tag memories with #watchlist to use this daemon.' if you find zero.\n" +
      "For each ticker (max 5): web_search query:'<ticker> stock price today' limit:3 for equities, or query:'<ticker> price today' for crypto. Take the first result from finance.yahoo.com, google.com/finance, bloomberg.com, coingecko.com, or coinmarketcap.com. web_fetch_readable url:<that url>. Parse the current price and daily % change; if unparseable, mark the ticker as 'n/a'.\n" +
      "Build one line like 'AAPL 213.40 +0.8% · BTC 68.2k -1.2% · NVDA 127.9 +2.1%'. speak text:<that line>. memory_add tags:['#portfolio-snapshot'] text:<same line with ISO timestamp prefix>.",
  },

  // ── FOCUS · extended ─────────────────────────────────────────
  {
    id: 'pomodoro',
    category: 'FOCUS',
    title: 'Pomodoro companion',
    icon: '⏲',
    summary:
      'Every 25 minutes during work hours, speak a 2-minute rest cue and log the foreground window.',
    kind: 'interval',
    everySec: 1500,
    goal:
      "timezone_now tz:'America/Los_Angeles' (override with whatever memory_search query:'timezone' returns). If the output's HH < 9 or ≥ 18, or weekday is Sat/Sun, stop.\n" +
      "screen_capture_active_window. From `data` read the foreground app + window title (or describe what's on screen if the capture didn't include them). Pick ONE of three rest cues based on minute-of-hour (use timezone_now's MM):\n" +
      "  MM < 20: 'Pomodoro mark — look 20 feet away for two minutes.'\n" +
      "  20 ≤ MM < 40: 'Pomodoro mark — stand up, roll your shoulders.'\n" +
      "  MM ≥ 40: 'Pomodoro mark — sip water, then a deep breath.'\n" +
      "speak text:<cue>. memory_add tags:['#pomodoro'] text:'<HH:MM> · <app> — <title>' so the weekly review can see your focus surface.",
  },
  {
    id: 'meeting-prep',
    category: 'FOCUS',
    title: 'Meeting prep',
    icon: '⌘',
    summary:
      'Every 15 min, if a meeting starts in ≤10 min, compile a prep brief from notes, memory, and calendar context.',
    kind: 'interval',
    everySec: 900,
    goal:
      "Call calendar_upcoming days:1. Parse each line of the form 'HH:MM – HH:MM <title> (<calendar>)'. timezone_now tz:'America/Los_Angeles' to get the local now-HH:MM. Find the NEXT event whose start is ≥ now and ≤ now+10min; if none, stop silently.\n" +
      "Dedupe: the prep key is 'meeting-prep:<YYYY-MM-DD>|<HH:MM>|<title>'. memory_search query:<that key> limit:1 — if a hit exists, stop (we already briefed for this one).\n" +
      "Gather context: notes_search query:<meeting title, first 3 words> limit:5; memory_search query:<meeting title> limit:10; memory_search query:<first named attendee, if any> limit:5.\n" +
      "Write a compact brief with these bullets (≤8 lines total):\n" +
      "  • Agenda guess (one line, from the title + prior notes)\n" +
      "  • Last context (one bullet per recent memory/notes hit, up to 3)\n" +
      "  • Open questions (exactly 2 — drawn from context)\n" +
      "  • Suggested next step (1 sentence)\n" +
      "Persist: notes_create title:'Prep — <meeting title>' folder:'Meeting Prep' body:<markdown>. memory_add tags:['#meeting-prep'] text:<the prep key>. speak text:'Prep note ready — <title> at <HH:MM>.'",
  },
  {
    id: 'distraction-buster',
    category: 'FOCUS',
    title: 'Distraction buster',
    icon: '⎋',
    summary:
      'Every 5 min during work hours, nudge me gently if YouTube / Twitter / TikTok / Reddit is on screen.',
    kind: 'interval',
    everySec: 300,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless weekday is Mon-Fri AND 9 ≤ HH < 18.\n" +
      "Rate-limit: memory_search query:'distraction-nudge' limit:1. If the most recent hit is within 30 minutes of now (compare the ISO timestamp you stored), stop — we just nudged.\n" +
      "Detect: try each domain in order with find_text_on_screen text:<term>. Terms: 'YouTube', 'X — ', 'Twitter', 'TikTok', 'reddit.com', 'Instagram'. Stop at the first term that returns ≥1 match. If no matches, return 'focused' silently.\n" +
      "If a match fires: speak text:'Heads up — <matched term> is on screen. Back to it?' memory_add tags:['#distraction-nudge'] text:'<ISO> · <matched term>'. Never more than 2 nudges per hour; that's enforced by the rate-limit check above.",
  },
  {
    id: 'focus-journal',
    category: 'FOCUS',
    title: 'Deep work journal',
    icon: '▦',
    summary:
      'Every hour, log a foreground-window snapshot to memory as raw material for the weekly review.',
    kind: 'interval',
    everySec: 3600,
    goal:
      "screen_capture_active_window. Pull app + window title from `data` (fallback to a terse description of what's visible if the capture lacks metadata).\n" +
      "timezone_now tz:'America/Los_Angeles' for the local timestamp.\n" +
      "memory_add tags:['#focus-log'] text:'<YYYY-MM-DD HH:MM> · <app> — <title>'. That's the whole job — single memory entry, no speak, no notes. The weekly-review and standup daemons read this tag.",
  },

  // ── INBOX · extended ─────────────────────────────────────────
  {
    id: 'vip-radar',
    category: 'INBOX',
    title: 'VIP radar',
    icon: '★',
    summary:
      'Every 15 min, speak a heads-up the moment a VIP emails — de-duped per subject line.',
    kind: 'interval',
    everySec: 900,
    goal:
      "memory_search query:'vip' limit:20. Build a case-insensitive list of VIP names / email substrings from those entries. If empty, stop silently.\n" +
      "mail_list_unread limit:30. For each line of the format 'N. From <sender> (<date>): <subject>', normalise sender + subject. An item is a VIP hit if any VIP substring appears in the sender (case-insensitive).\n" +
      "Dedupe: for each VIP hit, the key is 'vip-seen:<sender>|<subject>'. memory_search query:<that key> limit:1; if a hit exists, skip. Otherwise memory_add tags:['#vip-seen'] text:<the key>, and accumulate into an alert list.\n" +
      "If the alert list is non-empty: speak text:'VIP mail — <first sender> about <first subject>' + (list.length > 1 ? ' plus <N-1> more.' : ''). Silent otherwise.",
  },
  {
    id: 'thread-catchup',
    category: 'INBOX',
    title: 'Thread catch-up',
    icon: '⌬',
    summary:
      "Every 2h, summarise any iMessage chat with 3+ unreads into a one-line digest per person.",
    kind: 'interval',
    everySec: 7200,
    goal:
      "list_chats. From `data`, pick chats where unread_count ≥ 3. Cap at 8 chats.\n" +
      "If zero qualifying chats, return 'quiet' silently.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:180. One goal per qualifying chat:\n" +
      "  'Summarise the unread thread for chat id \"<chat_id>\" (\"<chat_name>\"). Call fetch_conversation chat_id:\"<chat_id>\" limit:20. Return EXACTLY one line: \"<chat_name>: <who sent it + one-sentence gist, ≤22 words>\". If the chat is mostly your own outgoing messages with no reply, return \"SKIP::<chat_name>\".'\n" +
      "labels:['thread:<chat_name>', ...].\n" +
      "Collect every child finalAnswer not starting with SKIP:: or in error. If none pass, return 'quiet' silently.\n" +
      "Otherwise: notes_create title:'Thread catch-up — <YYYY-MM-DD HH:MM>' folder:'Digests' body:<bulleted list of child lines>. memory_add tags:['#thread-catchup'] text:<same bullets — search can find which threads you've caught up on>. Do not speak.",
  },
  {
    id: 'invite-triage',
    category: 'INBOX',
    title: 'Invite triage',
    icon: '⊠',
    summary:
      'Every hour, spot new calendar events in the next 7 days, flag conflicts, and stage a prep note.',
    kind: 'interval',
    everySec: 3600,
    goal:
      "calendar_upcoming days:7. Parse each line ('HH:MM – HH:MM <title> (<calendar>)') into (start, end, title, calendar). Use the date context from the output's section headers; if absent, pair each entry with 'today + offset N' by line order — it's good enough for dedupe.\n" +
      "For each event, build key 'invite-seen:<YYYY-MM-DD>|<HH:MM>|<title>'. memory_search query:<that key> limit:1; if seen, skip.\n" +
      "For each NEW event: detect conflicts — any other upcoming event whose time window overlaps by ≥5 minutes. Compose a prep note body:\n" +
      "  ## <title>\n" +
      "  When: <YYYY-MM-DD HH:MM – HH:MM> (<calendar>)\n" +
      "  Conflict: <conflicting event or 'none'>\n" +
      "  Prep: 3 bullet questions an attendee might ask.\n" +
      "Persist: notes_create title:'Invite — <title>' folder:'Meeting Prep' body:<markdown>. memory_add tags:['#invite-seen'] text:<the key>.\n" +
      "If any NEW event has a conflict, speak text:'Heads up — <first conflicting title> overlaps <other title>.' Otherwise silent.",
  },

  // ── CLEANUP · extended ───────────────────────────────────────
  {
    id: 'screenshot-sorter',
    category: 'CLEANUP',
    title: 'Screenshot sorter',
    icon: '▥',
    summary:
      'Every 6h, move Desktop screenshots into ~/Pictures/Screenshots/<YYYY-MM>/ by the month they were taken.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "Enumerate candidates: run_shell cmd:'find ~/Desktop -maxdepth 1 -type f \\( -iname \"Screenshot*.png\" -o -iname \"Screen Shot*.png\" -o -iname \"CleanShot*.png\" \\) -mmin +60 -print'.\n" +
      "Skip anything modified in the last hour (the -mmin +60 already excludes those).\n" +
      "For each path, derive <YYYY-MM> via run_shell cmd:'date -r $(stat -f %m \"<path>\") +%Y-%m'. Then run_shell cmd:'mkdir -p ~/Pictures/Screenshots/<YYYY-MM> && mv \"<path>\" ~/Pictures/Screenshots/<YYYY-MM>/'.\n" +
      "Count successes and failures. memory_add tags:['#screenshot-sort'] text:'Moved <N> screenshots; last folder ~/Pictures/Screenshots/<latest YYYY-MM>.' No speak.",
  },
  {
    id: 'trash-size',
    category: 'CLEANUP',
    title: 'Trash size check',
    icon: '⌫',
    summary:
      'Once a day, gently remind me when ~/.Trash grows past 1 GB — advisory only, never empties.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "run_shell cmd:'du -sk ~/.Trash 2>/dev/null | awk \"{print \\$1}\"' — stdout is KB as an integer. Parse it.\n" +
      "If KB ≤ 1048576 (1 GB), memory_add tags:['#trash-size'] text:'<KB> KB · within budget' and stop. No speak.\n" +
      "Otherwise run_shell cmd:'du -sh ~/.Trash' for a human-readable size, then speak text:'Trash holds <that size>. Empty it when convenient.' memory_add tags:['#trash-size','#over-budget'] text:<same, with timestamp>. NEVER run `rm -rf` or `osascript 'empty trash'` — this daemon is strictly advisory.",
  },
  {
    id: 'dup-hunter',
    category: 'CLEANUP',
    title: 'Duplicate hunter',
    icon: '⊟',
    summary:
      'Weekly, hash ~/Downloads and file a report of duplicate groups + reclaimable space — never deletes.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "run_shell cmd:'find ~/Downloads -type f -size +1M -not -path \"*/Archive/*\" -print0 | xargs -0 shasum -a 256 2>/dev/null | sort'. The output is '<hex64>  <path>' lines, already sorted by hash.\n" +
      "Group adjacent lines by the hex hash. For each group with ≥2 members, capture the hash, the paths, and one size (via run_shell cmd:'stat -f %z <first path>' — all members are the same size by definition).\n" +
      "Compute reclaimable bytes = sum over groups of size × (count - 1). Pick the top 10 groups by (size × count).\n" +
      "notes_create title:'Duplicate report — <YYYY-MM-DD>' folder:'Reports' body:<markdown: reclaimable total in MB/GB, then one H3 per top group listing size, count, and paths>. memory_add tags:['#dup-report'] text:'Reclaimable: <total> · Groups: <N>'. Do not delete anything. Do not speak.",
  },
  {
    id: 'screen-recordings-sweep',
    category: 'CLEANUP',
    title: 'Screen recordings sweep',
    icon: '⏵',
    summary:
      'Daily, archive .mov screen recordings older than 14 days into ~/Movies/Archive/<YYYY>/.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Enumerate: run_shell cmd:'find ~/Movies -maxdepth 2 -type f \\( -name \"Screen Recording*.mov\" -o -name \"Screen Recording*.mp4\" \\) -mtime +14 -not -path \"*/Archive/*\" -print'.\n" +
      "For each path, derive <YYYY> via run_shell cmd:'date -r $(stat -f %m \"<path>\") +%Y', then run_shell cmd:'mkdir -p ~/Movies/Archive/<YYYY> && mv \"<path>\" ~/Movies/Archive/<YYYY>/'.\n" +
      "Sum bytes moved (stat -f %z before the move). memory_add tags:['#recordings-sweep'] text:'Archived <N> recordings, <total GB> GB reclaimed.' Silent run.",
  },

  // ── WATCHERS · extended ──────────────────────────────────────
  {
    id: 'disk-sentinel',
    category: 'WATCHERS',
    title: 'Disk space sentinel',
    icon: '⌽',
    summary:
      'Every 2h, alert when / has less than 10% free OR under 10 GB available.',
    kind: 'interval',
    everySec: 7200,
    goal:
      "run_shell cmd:'df -k / | tail -1 | awk \"{print \\$2, \\$4, \\$5}\"' — output is 'total_kb avail_kb use%'. Parse the three fields.\n" +
      "Compute avail_gb = avail_kb / 1048576 (round to 1 decimal). Strip the trailing '%' from use%.\n" +
      "memory_add tags:['#disk-sample'] text:'<ISO> · avail <avail_gb> GB · use <use%>%' (always — trend data is valuable).\n" +
      "Alert condition: use% > 90 OR avail_gb < 10. If true, rate-limit against memory_search query:'disk-alert' limit:1 — skip if the most recent hit is within 6h. Otherwise speak text:'Low disk — <avail_gb> GB free (<use%>% used).' and memory_add tags:['#disk-alert'] text:<same>.",
  },
  {
    id: 'launchagent-watchdog',
    category: 'WATCHERS',
    title: 'LaunchAgent watchdog',
    icon: '⚷',
    summary:
      'Hourly, diff ~/Library/LaunchAgents and /Library/LaunchAgents against a baseline — alert on new entries.',
    kind: 'interval',
    everySec: 3600,
    goal:
      "Snapshot: run_shell cmd:'ls -1 ~/Library/LaunchAgents 2>/dev/null; echo ===; ls -1 /Library/LaunchAgents 2>/dev/null; echo ===; ls -1 /Library/LaunchDaemons 2>/dev/null'. Split on '===' into three filename lists.\n" +
      "Load baseline: memory_search query:'launchagent-baseline' limit:1. If the most recent entry exists, parse its stored snapshot (it's JSON we wrote last run).\n" +
      "If no baseline exists, memory_add tags:['#launchagent-baseline'] text:<JSON.stringify({user, system, daemons}) of the current snapshot> and stop — this is seeding.\n" +
      "If baseline exists, diff each list. Collect any NEW entries not in the prior snapshot. If empty, memory_add tags:['#launchagent-baseline'] text:<new JSON snapshot> (refresh) and stop silently.\n" +
      "If new entries exist: speak text:'<N> new LaunchAgent(s): <first filename>.' memory_add tags:['#launchagent-new'] text:<JSON of new entries, with which bucket>. Also refresh the baseline memory with the new full snapshot. Do NOT memory_delete the old one — we want a history trail.",
  },
  {
    id: 'cpu-hog',
    category: 'WATCHERS',
    title: 'CPU hog alert',
    icon: '⚡',
    summary:
      'Every 10 min, alert when a non-system process burns >80% CPU across two consecutive samples.',
    kind: 'interval',
    everySec: 600,
    goal:
      "Sample: run_shell cmd:'ps -Aceo pcpu,comm -r | head -6'. First line is a header; parse rows as (pcpu, comm). Exclude 'kernel_task', 'WindowServer', 'launchd', 'mds_stores', 'coreaudiod' — system noise.\n" +
      "Top row after filtering is the candidate. If its pcpu ≤ 80, memory_add tags:['#cpu-last-top'] text:'<ISO>|<comm>|<pcpu>' and stop silently (we refresh the marker every run so the next comparison is valid).\n" +
      "If pcpu > 80: memory_search query:'cpu-last-top' limit:1. If the most recent entry is within the last 15 minutes AND its comm matches the current candidate, that's two samples in a row — speak text:'<comm> burning <pcpu>% CPU for a while.'\n" +
      "Regardless, memory_add tags:['#cpu-last-top'] text:'<ISO>|<comm>|<pcpu>' so next run has fresh data.",
  },
  {
    id: 'clipboard-secrets',
    category: 'WATCHERS',
    title: 'Clipboard secrets scanner',
    icon: '⊘',
    summary:
      'Every 5 min, scan the clipboard for API keys / tokens / private keys — warns without logging the secret.',
    kind: 'interval',
    everySec: 300,
    goal:
      "get_clipboard_history. From `data` take the most recent 3 entries (newest first).\n" +
      "For each entry.text, run regex_match pattern:<see list below> global:false. Test in order; stop at the first match.\n" +
      "Patterns (Rust regex, no lookaround):\n" +
      "  'AKIA[0-9A-Z]{16}'              → AWS access key\n" +
      "  'sk-[A-Za-z0-9]{20,}'           → OpenAI-style key\n" +
      "  'ghp_[A-Za-z0-9]{36}'           → GitHub PAT\n" +
      "  'xox[abp]-[A-Za-z0-9-]{10,}'    → Slack token\n" +
      "  '-----BEGIN [A-Z ]*PRIVATE KEY-----' → PEM private key\n" +
      "If any matches: rate-limit against memory_search query:'clipboard-secret' limit:1 — if the most recent hit is within 10 minutes, stay silent. Otherwise speak text:'Heads up — a credential is sitting in your clipboard. Clear it when you can.' memory_add tags:['#clipboard-secret'] text:'<ISO> · pattern=<pattern name>'. NEVER log the matched substring itself.",
  },

  // ── LEARN · extended ─────────────────────────────────────────
  {
    id: 'research-digest',
    category: 'LEARN',
    title: 'Research digest',
    icon: '◊',
    summary:
      'Every 3 days, deep-research each topic in my #interest list — 3 cited briefs per run, never duplicates.',
    kind: 'interval',
    everySec: 259_200,
    goal:
      "memory_search query:'interest topic' limit:10. Extract up to 5 candidate topics (free text). If zero results, speak text:'No #interest memories — tag some to use this daemon.' and stop.\n" +
      "For each candidate: memory_search query:'research-digest <topic>' limit:1. Skip if the most recent hit is within the last 7 days (fresh enough). Keep at most 3 after the filter.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:1500 — deep_research is minutes per topic; sequential runs blow the step budget. Build one goal per topic:\n" +
      "  'Produce a cited research brief on \"<topic>\" covering the latest 2026 developments. Call deep_research query:\"<topic> latest 2026 research\" profile_id:\"default\" max_sources:6. Take the returned markdown brief VERBATIM as your final answer — do not paraphrase; keep every source URL intact.'\n" +
      "labels:['research:<topic>', ...].\n" +
      "For each child where status=done: notes_create title:'Research digest — <topic>' folder:'Research' body:<child.finalAnswer>. memory_add tags:['#research-digest', topic] text:'<ISO> · <topic> · <first source URL>' so next run's dedupe works. Children that timed out get memory_add tags:['#research-digest','#timeout'] text:'<topic>' so the next scheduled run can retry them first.\n" +
      "Silent run — briefs live in Notes for later reading.",
  },
  {
    id: 'flashcard-burst',
    category: 'LEARN',
    title: 'Flashcard burst',
    icon: '✎',
    summary:
      'Every 6h, pick 3 random stored facts and speak them as recall questions — spaced-repetition friendly.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "memory_search query:'fact' limit:30. Take the 30 hits. If fewer than 3, memory_list limit:40 and mix in whichever look fact-like.\n" +
      "Filter out anything asked recently: memory_search query:'flashcard-asked' limit:20. Exclude any fact whose first 8 chars of id appear in the most recent 15 '#flashcard-asked' entries.\n" +
      "Pick 3 at random from the remaining pool. For each, rephrase as a one-line question ≤20 words that DOESN'T leak the answer. Join with ' ... ' between.\n" +
      "speak text:<the joined question string>. memory_add tags:['#flashcard-asked'] text:'<ISO> · <fact1 id8> · <fact2 id8> · <fact3 id8>' so next run skips these for a while.",
  },

  // ── CODING ───────────────────────────────────────────────────
  {
    id: 'git-hygiene',
    category: 'CODING',
    title: 'Git hygiene',
    icon: '⎇',
    summary:
      'Every 2h during work hours, nudge me when a tracked repo has stale uncommitted changes.',
    kind: 'interval',
    everySec: 7200,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless weekday is Mon-Fri AND 9 ≤ HH < 19.\n" +
      "Resolve repos: memory_search query:'repo path' limit:10 — each result's text should contain an absolute path. If zero results, fall back to run_shell cmd:'ls -d ~/code/*/.git 2>/dev/null | xargs -n1 dirname'. Cap at 8 repos.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:120. One goal per repo:\n" +
      "  'Check git hygiene for the repo at <absolute path>. Run `git -C <repo> status --porcelain=v1 | wc -l` for the modified+untracked count, and `git -C <repo> log -1 --format=%ct 2>/dev/null` for the newest-commit epoch. Also capture `git -C <repo> rev-parse --abbrev-ref HEAD` for the branch. Return EXACTLY one line: \"repo=<basename> branch=<name> dirty=<N> last_commit_epoch=<T>\" (dirty=0 and last_commit_epoch=0 both fine).'\n" +
      "labels:['git:<basename>', ...].\n" +
      "For each child's line: parse dirty, last_commit_epoch. A repo is STALE if dirty > 0 AND (now_epoch - last_commit_epoch) > 28800 (8h).\n" +
      "Dedupe: key 'git-hygiene-nudged:<repo>|<YYYY-MM-DD>'. memory_search query:<key> limit:1; skip repos already nudged today.\n" +
      "If any new stale repos: speak text:'<N> repo<s> with stale changes — <first repo basename> has <K> dirty files.' memory_add tags:['#git-hygiene'] text:<the key> per repo. Silent otherwise.",
  },
  {
    id: 'pr-review',
    category: 'CODING',
    title: 'Open PR review',
    icon: '⇄',
    summary:
      'Every morning, list open PRs across my repos where I\'m author or requested reviewer.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Require the gh CLI: run_shell cmd:'command -v gh'. If empty, memory_add tags:['#pr-review','#missing-tool'] text:'gh not installed' and speak text:'Install gh CLI to use PR review.' then stop.\n" +
      "Authored PRs: run_shell cmd:'gh search prs --state=open --author=@me --json repository,number,title,url,updatedAt --limit 20'.\n" +
      "Review-requested: run_shell cmd:'gh search prs --state=open --review-requested=@me --json repository,number,title,url,updatedAt --limit 20'.\n" +
      "If both commands error (auth issue), speak text:'gh CLI not authenticated — run `gh auth login`.' and stop.\n" +
      "Merge both arrays. For each PR, build a bullet '[<repo>#<num>] <title> — <url>'. Split into two sections: ## Mine (authored) and ## Awaiting my review (review-requested).\n" +
      "notes_create title:'Open PRs — <YYYY-MM-DD>' folder:'PR Review' body:<markdown>. memory_add tags:['#pr-review'] text:'Mine=<A> review=<B>'. If review-requested count > 0, speak text:'<B> PR<s> waiting on your review.'",
  },
  {
    id: 'commit-summary',
    category: 'CODING',
    title: 'Commit summary',
    icon: '⌇',
    summary:
      'End of day, summarise today\'s commits across tracked repos into a standup-ready paragraph.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Resolve repos: memory_search query:'repo path' limit:10, else run_shell cmd:'ls -d ~/code/*/.git 2>/dev/null | xargs -n1 dirname'.\n" +
      "For each repo (max 10), run_shell cmd:'git -C <repo> log --author=\"$(git -C <repo> config user.email)\" --since=midnight --pretty=format:\"%h %s\" 2>/dev/null'. These are fast so no fan-out needed — just do them sequentially.\n" +
      "Capture per-repo commit lines. If the combined commit count is 0, memory_add tags:['#commit-summary'] text:'No commits today.' and stop.\n" +
      "Build a single paragraph ≤120 words: group by repo, one sentence per repo synthesising the THEME implied by the commit subjects (don't echo them — abstract up one level). Example: 'In sunny: wired tool auto-registration and expanded the Auto templates. In web: added the pricing page skeleton.'\n" +
      "notes_create title:'Commits — <YYYY-MM-DD>' folder:'Standups' body:<paragraph + raw commit list as appendix>. memory_add tags:['#standup','#commit-summary'] text:<paragraph>. Do not speak.",
  },
  {
    id: 'test-watcher',
    category: 'CODING',
    title: 'Test watcher',
    icon: '◆',
    summary:
      'Every 30 min during work hours, run tests on the active repo and alert on the first failure.',
    kind: 'interval',
    everySec: 1800,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless weekday is Mon-Fri AND 9 ≤ HH < 19.\n" +
      "Pick the active repo: memory_search query:'active repo' limit:1 → take the stored path. If nothing, stop silently (the user hasn't opted a repo in).\n" +
      "Detect toolchain via run_shell cmd:'test -f <repo>/package.json && echo node; test -f <repo>/Cargo.toml && echo rust; test -f <repo>/pyproject.toml && echo python'. Build the test command:\n" +
      "  node   → 'cd <repo> && (pnpm test --run 2>&1 || npm test --silent 2>&1 || yarn test --run 2>&1) | tail -40'\n" +
      "  rust   → 'cd <repo> && cargo test --no-fail-fast --color=never 2>&1 | tail -40'\n" +
      "  python → 'cd <repo> && (pytest -x --no-header 2>&1 || python -m pytest -x 2>&1) | tail -40'\n" +
      "run_shell cmd:<that command>. Parse the output for FAIL / failed / error patterns.\n" +
      "Dedupe: key 'test-watcher-last:<repo>'. If the current result matches the prior stored signature (pass/fail + first failing test), stop — no repeat speak.\n" +
      "If transitioning to failing: speak text:'Tests broke in <repo basename> — <first failing test name>.' If recovering to green: speak text:'Tests green in <repo basename>.' memory_add tags:['#test-watcher'] text:'<ISO> · <repo> · <pass|fail> · <signature>'.",
  },
  {
    id: 'dep-audit',
    category: 'CODING',
    title: 'Dependency audit',
    icon: '⚠',
    summary:
      'Weekly, audit Node / Rust / Python dependencies for critical CVEs and file a report.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "Resolve repos: memory_search query:'repo path' limit:10, else run_shell cmd:'ls -d ~/code/*/.git 2>/dev/null | xargs -n1 dirname'. Cap at 8 repos.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:900. For each repo build one goal string:\n" +
      "  'Audit dependencies for the repo at <absolute path>. Detect toolchain: if package.json exists run `cd <repo> && (pnpm audit --json 2>/dev/null || npm audit --json 2>/dev/null) | head -c 200000`; if Cargo.toml run `cd <repo> && cargo audit 2>&1 | tail -80`; if pyproject.toml run `cd <repo> && (pip-audit --format json 2>/dev/null || pip-audit 2>&1 | tail -80)`. Parse for severity high/critical, count advisories, and return EXACTLY this single line as your final answer: \"repo=<basename> toolchain=<node|rust|python|none> critical=<N> high=<M> top=<title1>; <title2>; <title3>\". ≤300 chars.'\n" +
      "labels:['dep-audit:<basename>', ...] (one per repo).\n" +
      "The tool returns data.results — one entry per repo, same order. Parse each finalAnswer line.\n" +
      "notes_create title:'Dep audit — <YYYY-MM-DD>' folder:'Reports' body:<markdown: H3 per repo with critical/high counts and top 3 advisory titles>. If total critical > 0, speak text:'<N> critical CVEs across <M> repos — see Dep audit note.' memory_add tags:['#dep-audit'] text:'critical=<A> high=<B>'. Anything with status=error or timedOut=true goes under a 'Failed audits' section and doesn't count toward totals.",
  },
  {
    id: 'todo-miner',
    category: 'CODING',
    title: 'TODO miner',
    icon: '▤',
    summary:
      'Daily, grep tracked repos for TODO / FIXME / HACK comments and file a prioritized list.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Resolve repos: memory_search query:'repo path' limit:10, else run_shell cmd:'ls -d ~/code/*/.git 2>/dev/null | xargs -n1 dirname'. Cap at 10 repos.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:480. Build one goal per repo:\n" +
      "  'Find TODO/FIXME/HACK/XXX markers in the repo at <absolute path>. Run `cd <repo> && (rg --no-heading -n \"(TODO|FIXME|HACK|XXX)[:(]\" --glob \"!*/node_modules/*\" --glob \"!*/target/*\" --glob \"!*/dist/*\" -m 200 2>/dev/null || grep -RnE \"(TODO|FIXME|HACK|XXX)[:(]\" --include=\"*.{ts,tsx,js,jsx,py,rs,go,java,rb}\" . 2>/dev/null | head -200)`. Count P1 (FIXME/HACK/XXX) and P2 (TODO). Return EXACTLY: \"repo=<basename> p1=<N> p2=<M>\\nTOP\\n<up to 10 P1 lines, each formatted \"<path>:<line>: <trimmed comment ≤100 chars>\">\". If fewer than 10 P1 exist, fill with highest-priority TODOs.'\n" +
      "labels:['todo-mine:<basename>', ...].\n" +
      "Parse each child's two-section response. Merge all TOP blocks, pick the 10 highest-priority lines overall. For each line, dedupe key 'todo:<repo basename>:<path>:<line>' via memory_search query:<key> limit:1 — if the stored entry is older than 30 days, mark it STALE in the report.\n" +
      "notes_create title:'TODO mine — <YYYY-MM-DD>' folder:'TODO Mine' body:<markdown: summary counts, then H3 'P1 highlights' (top 10), then H3 'Stale >30d' (anything flagged)>. memory_add tags:['#todo-mine'] text:'P1=<A> P2=<B> stale=<C>'. Also memory_add one entry per new P1 hit so future runs can track age. Silent run.",
  },
  {
    id: 'claude-refactor',
    category: 'CODING',
    title: 'Claude codebase review',
    icon: '◈',
    summary:
      'Weekly, drive Claude Code in my active repo to surface the top 3 refactor opportunities.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "Pick the repo: memory_search query:'active repo' limit:1; if empty, stop silently.\n" +
      "claude_code_run cwd:<repo path> timeout_sec:600 prompt:'You are reviewing this codebase for refactor opportunities. Do NOT make changes. Produce exactly three items in markdown: for each, (a) a one-line diagnosis, (b) 2-3 specific file references with line numbers, (c) a 3-step proposed refactor. Prioritize by blast radius (code paths touched × reader confusion), not by lines-of-code saved. Keep each item under 200 words. End with a one-line summary.'\n" +
      "The tool returns the transcript; extract the Claude response body (strip shell prompt noise — anything before the first line starting with '1.' or '##').\n" +
      "notes_create title:'Refactor review — <repo basename> — <YYYY-MM-DD>' folder:'Code Review' body:<extracted markdown>. memory_add tags:['#refactor-review', <repo basename>] text:<first sentence of the summary>. Silent — the note is the deliverable.",
  },
  {
    id: 'build-health',
    category: 'CODING',
    title: 'Build health',
    icon: '◉',
    summary:
      'Every 4h during work hours, run typecheck + lint on the active repo and alert on new errors.',
    kind: 'interval',
    everySec: 14_400,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless weekday is Mon-Fri AND 9 ≤ HH < 19.\n" +
      "Pick the repo: memory_search query:'active repo' limit:1; if empty, stop silently.\n" +
      "Detect toolchain + run:\n" +
      "  package.json  → run_shell cmd:'cd <repo> && (pnpm tsc --noEmit 2>&1 || npx tsc --noEmit 2>&1) | tail -40 && echo ===LINT=== && (pnpm lint 2>&1 || npm run lint 2>&1 || true) | tail -40'\n" +
      "  Cargo.toml    → run_shell cmd:'cd <repo> && cargo check --color=never 2>&1 | tail -40 && echo ===LINT=== && cargo clippy --color=never -- -D warnings 2>&1 | tail -40'\n" +
      "Count error lines in each section (tsc 'error TS', eslint 'error', cargo 'error:'/'warning:').\n" +
      "Dedupe: compare against memory_search query:'build-health-sig' limit:1 — stored format 'tsc=<N> lint=<M>'. If identical, skip speak.\n" +
      "If new errors appeared (counts increased in either bucket), speak text:'Build regressed in <repo>: <N> type errors, <M> lint issues.' memory_add tags:['#build-health-sig'] text:'<ISO> · tsc=<N> lint=<M>'. On first fully-clean run after failures, speak text:'Build green in <repo>.'",
  },

  // ── RESEARCH ─────────────────────────────────────────────────
  {
    id: 'arxiv-daily',
    category: 'RESEARCH',
    title: 'arXiv daily',
    icon: '⌘',
    summary:
      'Every morning, pull the top new arXiv papers matching my #interest topics and file 3 with abstracts.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "memory_search query:'interest topic' limit:10. Extract up to 4 topic strings (e.g. 'agents', 'retrieval', 'diffusion'). If empty, stop silently with memory_add tags:['#arxiv-daily','#no-topics'] text:'No #interest topics set.'\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:480. One goal per topic:\n" +
      "  'Find the single freshest arXiv paper on \"<topic>\". Call web_search query:\"site:arxiv.org <topic> 2026\" limit:5. Pick the top result whose URL contains \"/abs/\". Extract the arxiv id from the URL path. Skip it if memory_search query:\"arxiv-seen <id>\" limit:1 has a hit; try the next result. Once you have a fresh URL, web_fetch_readable it and return EXACTLY: \"ID::<arxiv id>\\nTITLE::<title>\\nAUTHORS::<comma-separated names>\\nURL::<url>\\nABSTRACT::<verbatim abstract, ≤1000 chars>\". Preserve the abstract text — do not paraphrase. If no fresh paper can be found, return \"SKIP::<topic>\".'\n" +
      "labels:['arxiv:<topic>', ...].\n" +
      "For each child whose finalAnswer starts with 'ID::': parse the five fields. Skip children that returned SKIP:: or errored.\n" +
      "Persist: notes_create title:'arXiv daily — <YYYY-MM-DD>' folder:'Research' body:<markdown: H2 topic, H3 paper title with link, authors line, blockquoted abstract>. memory_add tags:['#arxiv-seen'] text:'<arxiv id> | <topic>' per paper. Do not speak.",
  },
  {
    id: 'hn-pulse',
    category: 'RESEARCH',
    title: 'Hacker News pulse',
    icon: '◬',
    summary:
      'Every 2h during work hours, top HN stories matching my interests — spoken headline, full list in a note.',
    kind: 'interval',
    everySec: 7200,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless 9 ≤ HH < 19 (fires on weekends too — HN doesn't sleep).\n" +
      "Fetch the front page: web_fetch_readable url:'https://news.ycombinator.com'. Extract up to 20 story titles + their discussion URLs (pattern 'item?id=<num>').\n" +
      "Topic filter: memory_search query:'interest topic' limit:10 to build a set of keywords. Case-insensitive substring match each title against keywords. If zero interests set, take the top 5 stories unfiltered.\n" +
      "Dedupe each matched story by HN id: memory_search query:'hn-seen <item_id>' limit:1; drop hits.\n" +
      "If zero new matches, stop silently.\n" +
      "Otherwise take top 3 new matches. notes_create title:'HN pulse — <YYYY-MM-DD HH:MM>' folder:'HN Pulse' body:<markdown list with title as link>. memory_add tags:['#hn-seen'] text:'<item_id> | <title>' per story. If any story's title contains a keyword from memory_search query:'vip topic' limit:5, speak text:'HN: <that title>.' Otherwise silent.",
  },
  {
    id: 'competitor-watch',
    category: 'RESEARCH',
    title: 'Competitor watch',
    icon: '◎',
    summary:
      'Daily, fetch the homepage of each competitor in memory and alert when it changes meaningfully.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "memory_search query:'competitor url' limit:10. Extract http/https URLs. If none, stop silently.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:240. One goal per URL (max 8):\n" +
      "  'Fetch <url> with web_fetch_readable, hash the returned text with hash_text algo:\"sha256\", and return EXACTLY: \"HASH::<hex>\\nTEXT::<first 3000 chars of readable output>\". Do not summarise — the parent will.'\n" +
      "labels:['competitor:<hostname>', ...] (derive hostname from URL).\n" +
      "For each successful child: parse HASH and TEXT. Compare HASH against memory_search query:'competitor-hash <hostname>' limit:1. If no baseline, seed memory_add tags:['#competitor-hash', <hostname>] text:'<hash> | <ISO>' AND memory_add tags:['#competitor-text', <hostname>] text:<TEXT> — stop for that competitor.\n" +
      "If a baseline exists and differs: fetch the prior TEXT via memory_search query:'competitor-text <hostname>' limit:1. Compare old vs new in-prompt and produce a 3-bullet diff (headline / hero / CTA).\n" +
      "For each changed hostname: notes_create title:'Competitor change — <hostname> — <YYYY-MM-DD>' folder:'Competitor Watch' body:<markdown: URL, old/new digests, 3-bullet diff>. Refresh baseline: memory_add tags:['#competitor-hash', <hostname>] text:'<new hash> | <ISO>' AND memory_add tags:['#competitor-text', <hostname>] text:<new TEXT>. speak text:'<N> competitor<s> changed today.' (one spoken line total, regardless of count).",
  },
  {
    id: 'bookmark-dive',
    category: 'RESEARCH',
    title: 'Bookmark deep-dive',
    icon: '◆',
    summary:
      'Every 3 days, pick the oldest #bookmark I saved and run deep_research on its topic — produces a brief.',
    kind: 'interval',
    everySec: 259_200,
    goal:
      "memory_search query:'bookmark' limit:20. Sort by created_at ascending (oldest first). Filter to entries not yet dived — skip those whose id8 appears in memory_search query:'bookmark-dived' limit:50.\n" +
      "If the filtered list is empty, stop silently with memory_add tags:['#bookmark-dive'] text:'No pending bookmarks.'\n" +
      "Pick the oldest remaining bookmark. Extract the URL and any saved title/context from its text.\n" +
      "First, web_fetch_readable url:<bookmark url> to remember why you saved it. Then deep_research query:'<title or URL + \"what matters in this\">' profile_id:'default' max_sources:6 to expand context.\n" +
      "notes_create title:'Deep-dive — <page title>' folder:'Deep Dives' body:<markdown: the original bookmark URL + saved context on top, then a H2 'Why it matters' 2-sentence synthesis you write, then the deep_research brief verbatim>. memory_add tags:['#bookmark-dived'] text:'<bookmark id8> | <page title>'. Silent.",
  },
  {
    id: 'price-watch',
    category: 'RESEARCH',
    title: 'Price drop watcher',
    icon: '⇩',
    summary:
      'Every 6h, check tracked product URLs for discounts vs baseline and alert on drops ≥10%.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "memory_search query:'track price' limit:10. Each hit should contain a URL + product name. If zero, stop silently.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:180. One goal per (url, product_name) pair (max 6):\n" +
      "  'Fetch <url> with web_fetch_readable, find the current price with regex_match pattern:\"\\\\$[0-9]{1,6}(?:\\\\.[0-9]{2})?\" global:false on the text, and return EXACTLY: \"PRODUCT::<product name>\\nURL::<url>\\nPRICE::<number with no dollar sign or commas>\" — or \"PRICE::n/a\" if nothing parses. No other text.'\n" +
      "labels:['price:<short product name>', ...].\n" +
      "For each child with a parseable PRICE: lookup baseline via memory_search query:'price-baseline <url_hash>' limit:1 where url_hash is the first 8 chars of hash_text algo:'sha256' text:<url>. If no baseline, memory_add tags:['#price-baseline', <url_hash>] text:'<price> | <product> | <ISO>' and move on.\n" +
      "If a baseline exists, drop = (baseline - current) / baseline. If drop ≥ 0.10, accumulate an alert line. Regardless, memory_add tags:['#price-baseline', <url_hash>] text:'<price> | <product> | <ISO>' — trend continuity.\n" +
      "If alerts non-empty: speak text:'<N> price drop<s> — <first product> at $<price> (-<pct>%).' notes_create title:'Price drops — <YYYY-MM-DD HH:MM>' folder:'Price Watch' body:<markdown bullet list>.",
  },

  // ── WRITING ──────────────────────────────────────────────────
  {
    id: 'journal-prompt',
    category: 'WRITING',
    title: 'Journal prompt',
    icon: '✐',
    summary:
      "Every evening, speak a fresh journaling prompt and stage a Notes skeleton for me to fill in.",
    kind: 'interval',
    everySec: 86_400,
    goal:
      "timezone_now tz:'America/Los_Angeles'. Use the current date as part of the seed so a given day always gets one prompt.\n" +
      "Pick a prompt from this set, rotating by day-of-year mod 10: ['What surprised you today?', 'What would make tomorrow a 9/10?', 'What did you avoid today — and why?', 'Which conversation mattered most?', 'What did you learn about yourself?', 'Where did you give up too early?', 'What did you notice that others missed?', 'What would past-you find amazing about today?', 'What boundary held? Which one slipped?', 'What\\'s one small thing you\\'re proud of?'].\n" +
      "Optionally enrich: memory_search query:'journal' limit:3 to recall yesterday's themes; if recurrent, note 'You wrote about <theme> yesterday — does that thread continue?'\n" +
      "notes_create title:'Journal — <YYYY-MM-DD>' folder:'Journal' body:'# Prompt\\n\\n<the prompt>\\n\\n# Thoughts\\n\\n_(your entry here)_\\n\\n# One thing to try tomorrow\\n\\n_____'. memory_add tags:['#journal-prompt'] text:<the prompt>. speak text:<the prompt>.",
  },
  {
    id: 'blog-ideas',
    category: 'WRITING',
    title: 'Blog idea miner',
    icon: '✎',
    summary:
      'Weekly, synthesise my #idea memories into 3 concrete blog post drafts with outlines.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "memory_search query:'idea' limit:50. Cluster entries by theme (group by overlapping keywords — do this in-head, no tool needed).\n" +
      "Pick the 3 largest clusters (≥2 entries). For each cluster, synthesise a blog post draft with this structure:\n" +
      "  ## Working title (punchy, ≤8 words)\n" +
      "  **Hook** — one-sentence tension (≤25 words)\n" +
      "  **Outline** — exactly 5 numbered section headers, no prose\n" +
      "  **Key evidence** — bullet list pulled from the cluster's memory entries (quote-style)\n" +
      "  **Ending** — one-sentence takeaway\n" +
      "Combine into one markdown document, H1 = 'Blog mine — <YYYY-MM-DD>'.\n" +
      "notes_create title:'Blog mine — <YYYY-MM-DD>' folder:'Writing' body:<that markdown>. memory_add tags:['#blog-mine'] text:'Drafted: <title1> / <title2> / <title3>'. Do not speak.",
  },
  {
    id: 'writing-streak',
    category: 'WRITING',
    title: 'Writing streak',
    icon: '⌁',
    summary:
      'Each evening, nudge me if nothing got written today — checks journal, blog, and #writing memories.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "timezone_now tz:'America/Los_Angeles'. Compute today's YYYY-MM-DD.\n" +
      "Check for today's activity across three signals:\n" +
      "  a) memory_search query:'journal-prompt' limit:3 — look for an entry whose text or ISO prefix matches today.\n" +
      "  b) memory_search query:'writing' limit:10 — same check.\n" +
      "  c) notes_search query:'Journal' limit:5 then notes_search query:<today's YYYY-MM-DD> limit:5 to see if a dated Journal note exists.\n" +
      "If ANY signal fires for today → memory_add tags:['#writing-streak'] text:'<YYYY-MM-DD> · kept streak' and stop silently.\n" +
      "If NONE → consult prior streak length: memory_search query:'writing-streak' limit:10. Count how many consecutive prior days have 'kept streak' entries → streak_length.\n" +
      "Speak text:'Streak at <N> days — want to write one sentence before bed?' memory_add tags:['#writing-streak','#missed'] text:'<YYYY-MM-DD> · missed after <N> days'.",
  },
  {
    id: 'thread-draft',
    category: 'WRITING',
    title: 'Thread draft',
    icon: '⇶',
    summary:
      'Twice a day, pull #tweet-idea memories into a draft thread I can post or discard.',
    kind: 'interval',
    everySec: 43_200,
    goal:
      "memory_search query:'tweet idea' limit:30. Skip entries already drafted: memory_search query:'thread-drafted' limit:30 and exclude any id8 listed there.\n" +
      "If fewer than 3 eligible ideas, stop silently.\n" +
      "Pick 5-7 ideas that share a thematic thread (you decide the through-line). Draft them as numbered tweets:\n" +
      "  1/ <Hook — the tension or surprising claim, ≤240 chars>\n" +
      "  2/ <Setup or first evidence, ≤240 chars>\n" +
      "  … up to 7/ <Payoff / actionable takeaway>\n" +
      "Each tweet ≤240 chars. Number them N/total. End with a one-line CTA in its own tweet.\n" +
      "notes_create title:'Thread draft — <YYYY-MM-DD HH:MM>' folder:'Threads' body:<the numbered tweets, blank line between>. memory_add tags:['#thread-drafted'] text:<comma-joined id8s>. Silent.",
  },

  // ── LIFE ─────────────────────────────────────────────────────
  {
    id: 'hydration',
    category: 'LIFE',
    title: 'Hydration ping',
    icon: '◌',
    summary:
      'Every 90 min during work hours, a gentle hydration reminder — skipped if you already logged water today.',
    kind: 'interval',
    everySec: 5400,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless 9 ≤ HH < 19 on any day.\n" +
      "Count today's pings: memory_search query:'hydration' limit:20. Filter to entries whose text starts with today's YYYY-MM-DD. If the count is ≥5, stop — you're already on it.\n" +
      "Rate-limit: memory_search query:'hydration' limit:1. If the most recent entry's ISO is within 60 minutes of now, stop.\n" +
      "speak text:'Water break.' memory_add tags:['#hydration'] text:'<YYYY-MM-DD HH:MM> · nudged'.",
  },
  {
    id: 'walk-break',
    category: 'LIFE',
    title: 'Walk break',
    icon: '⇢',
    summary:
      'Every 2h during work hours, if my foreground window hasn\'t changed in two samples, suggest a walk.',
    kind: 'interval',
    everySec: 7200,
    goal:
      "Gate: timezone_now tz:'America/Los_Angeles'; stop unless weekday is Mon-Fri AND 9 ≤ HH < 18.\n" +
      "Sample current focus: screen_capture_active_window → read app + title from `data`. Sig = '<app>|<title>'.\n" +
      "Compare: memory_search query:'walk-break-sig' limit:1. If most-recent stored sig matches AND its ISO is within the last 2.5h, that's two consecutive identical samples — speak text:'Been glued to <app> for a while — quick walk?' memory_add tags:['#walk-break','#nudged'] text:'<ISO> · <sig>'.\n" +
      "Otherwise just memory_add tags:['#walk-break-sig'] text:'<ISO> · <sig>' to set up the next comparison. Silent.",
  },
  {
    id: 'sleep-countdown',
    category: 'LIFE',
    title: 'Sleep countdown',
    icon: '☾',
    summary:
      'At 10pm, count down to bedtime based on my configured wake time — speak the math.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "timezone_now tz:'America/Los_Angeles'. Only run when HH is between 21 and 23; otherwise stop.\n" +
      "Resolve wake time: memory_search query:'wake time' limit:1. Expect format like '06:30' or '7am'. Fall back to '07:00' if missing.\n" +
      "Resolve desired sleep duration: memory_search query:'sleep hours' limit:1, else default 7.5.\n" +
      "Compute latest-bedtime = wake_time - duration. Compute minutes_until = (latest_bedtime - current_time) rendered as '<M> min' or '<H>h <M>m'.\n" +
      "If minutes_until > 0: speak text:'For a <duration>h night waking at <wake>, bed by <latest_bedtime>. That's <minutes_until> away.' Otherwise: speak text:'Already past optimal bedtime — every minute costs. Wind down.' memory_add tags:['#sleep-countdown'] text:'<ISO> · bedtime <latest_bedtime> · delta <minutes_until>'.",
  },
  {
    id: 'birthday-watch',
    category: 'LIFE',
    title: 'Birthday watch',
    icon: '❁',
    summary:
      'Every morning, check #birthday memories for anyone in the next 7 days and draft a message.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "memory_search query:'birthday' limit:50. Each hit should contain a name + a date (MM-DD or YYYY-MM-DD).\n" +
      "timezone_now tz:'America/Los_Angeles'. Compute today's MM-DD. For each entry, parse its MM-DD. Compute days_until (wrap around year-end). Keep those with 0 ≤ days_until ≤ 7.\n" +
      "If empty, stop silently.\n" +
      "For each upcoming birthday, build a block:\n" +
      "  **<Name> — <days_until> day<s>** (on <weekday> <YYYY-MM-DD>)\n" +
      "  Draft: '<warm one-line message in your voice, referencing any stored context like \"who mentors me at work\">'.\n" +
      "Dedupe: key 'birthday-nudged:<name>|<YYYY>'. Skip ones already nudged this year.\n" +
      "notes_create title:'Birthdays this week — <YYYY-MM-DD>' folder:'Birthdays' body:<markdown>. memory_add tags:['#birthday-nudged'] text:<the key> per person. If days_until ≤ 1, speak text:'<Name>\\'s birthday <today|tomorrow> — draft in Notes.'",
  },
  {
    id: 'habit-checkin',
    category: 'LIFE',
    title: 'Habit check-in',
    icon: '◉',
    summary:
      'Every evening, ask me which daily habits I hit today and log the status.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "timezone_now tz:'America/Los_Angeles'. Only fire if 20 ≤ HH < 23; otherwise stop.\n" +
      "Resolve habits: memory_search query:'habit' limit:20. Each hit should describe one habit (e.g. 'exercise 20 min', 'read 30 min', 'meditate 10 min'). If zero hits, stop silently.\n" +
      "Build a short question: 'Habits for <YYYY-MM-DD>: <habit1>, <habit2>, <habit3>. Which did you hit?' Cap at 5 habits in the spoken version.\n" +
      "speak text:<that question>. Then notes_create title:'Habits — <YYYY-MM-DD>' folder:'Habits' body:<markdown checklist with '[ ] <habit>' lines + a 'Notes:' section>. memory_add tags:['#habit-checkin'] text:'<ISO> · asked <N> habits'. The user fills the checklist in Notes later.",
  },

  // ── MONEY ────────────────────────────────────────────────────
  {
    id: 'subscription-audit',
    category: 'MONEY',
    title: 'Subscription audit',
    icon: '⊛',
    summary:
      'Monthly, scan Mail for recurring receipts and flag new or unexpected subscriptions.',
    kind: 'interval',
    everySec: 2_592_000,
    goal:
      "mail_list_unread limit:200. That's often too small — also run run_shell cmd:'osascript -e \\'tell application \"Mail\" to get subject of (messages of mailbox \"INBOX\" whose date sent > (current date) - 30 * days)\\'' to grab the last 30 days of subject lines, fall back to mail_list_unread alone if the AppleScript errors.\n" +
      "Pattern-match subjects case-insensitively against: /(receipt|invoice|subscription|renewal|auto.?pay|your.*(charge|payment))/ plus known vendors (Netflix, Spotify, YouTube Premium, iCloud, Dropbox, Notion, Figma, GitHub, AWS, Vercel, OpenAI, Anthropic, Adobe, etc.).\n" +
      "Group matches by sender domain. Count occurrences. For each sender with ≥2 matches in 30 days: this is a subscription candidate.\n" +
      "Load baseline: memory_search query:'subscription-baseline' limit:1. Compare to current candidate set. Identify NEW senders (not in baseline) and DROPPED senders (in baseline, not current).\n" +
      "notes_create title:'Subscriptions — <YYYY-MM>' folder:'Money' body:<markdown: H3 Current (table of sender|count), H3 New this month, H3 Dropped>. memory_add tags:['#subscription-baseline'] text:<JSON.stringify({senders, asOf})>. If any NEW senders, speak text:'<N> new subscription<s> this month — <first sender>.' Else silent.",
  },
  {
    id: 'charge-scan',
    category: 'MONEY',
    title: 'Large charge alert',
    icon: '$',
    summary:
      'Daily, scan bank alert emails for charges over my threshold and speak unexpected ones.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Resolve threshold: memory_search query:'charge threshold' limit:1. Parse first dollar value (e.g. '$200' → 200). Default to 200 if missing.\n" +
      "mail_list_unread limit:100. Filter to senders whose email contains 'alerts@', 'chase.com', 'bofa.com', 'americanexpress.com', 'wellsfargo.com', 'capitalone.com', 'citi.com', 'apple.com/card' (extend via memory_search query:'bank sender' limit:10).\n" +
      "For each matching message, regex_match the subject text:<subject> pattern:'\\$([0-9]{1,6}(?:\\.[0-9]{2})?)' global:false. Parse amount. If amount > threshold, add to the alert list with sender + subject snippet + amount.\n" +
      "Dedupe: key 'charge-alert:<amount>|<subject first 30 chars>'. Skip duplicates via memory_search.\n" +
      "If alert list is non-empty: speak text:'<N> large charge<s> today — biggest $<amount> via <sender short name>.' notes_create title:'Charges — <YYYY-MM-DD>' folder:'Money' body:<bullet list>. memory_add tags:['#charge-alert'] text:<the key> per alert.",
  },

  // ── HOME ─────────────────────────────────────────────────────
  {
    id: 'package-tracker',
    category: 'HOME',
    title: 'Package tracker',
    icon: '⊡',
    summary:
      'Every 6h, scan Mail for shipping updates and surface delivery ETAs.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "mail_list_unread limit:80. Filter to senders/subjects matching: /(shipped|out for delivery|delivered|tracking|your order|package)/ OR sender contains 'amazon', 'ups', 'fedex', 'usps', 'dhl', 'shopify'. Also include senders matching memory_search query:'retailer' limit:10.\n" +
      "For each hit, extract: retailer (sender), status (shipped / out-for-delivery / delivered / in-transit), best-guess ETA phrase (regex_match for 'arriving <day>', 'expected <date>', 'by <day>').\n" +
      "Dedupe per tracking reference: hash the subject + first 80 chars of text with hash_text algo:'sha1' to make a key. Skip via memory_search query:'package-seen <key>' limit:1.\n" +
      "Build a digest. notes_create title:'Packages — <YYYY-MM-DD HH:MM>' folder:'Home' body:<markdown bullets: retailer · status · ETA>. memory_add tags:['#package-seen'] text:<key> per hit.\n" +
      "If any item is 'out for delivery' today, speak text:'<retailer> out for delivery today.' Otherwise silent.",
  },
  {
    id: 'backup-health',
    category: 'HOME',
    title: 'Backup health',
    icon: '⎘',
    summary:
      "Daily, verify Time Machine ran recently and warn if the latest backup is older than 24 hours.",
    kind: 'interval',
    everySec: 86_400,
    goal:
      "run_shell cmd:'tmutil latestbackup 2>&1'. Output is a backup path like '/Volumes/Backups/Backups.backupdb/<host>/<timestamp>' OR an error like 'No backups have completed'.\n" +
      "If output contains 'No backups' or 'not configured' or 'Unable to locate', speak text:'Time Machine: no recent backup detected.' memory_add tags:['#backup','#missing'] text:<output> and stop.\n" +
      "If output is a path, extract the final directory segment (e.g. '2026-04-18-143022'). Parse as YYYY-MM-DD-HHMMSS. timezone_now tz:'America/Los_Angeles' → current epoch. Compute age_hours.\n" +
      "Always memory_add tags:['#backup-sample'] text:'<ISO> · latest <timestamp> · <age_hours>h'.\n" +
      "If age_hours > 24: rate-limit via memory_search query:'backup-alert' limit:1 (skip if alerted in last 6h). Otherwise speak text:'Last Time Machine backup is <age_hours>h old — check the drive.' memory_add tags:['#backup-alert'] text:'<ISO> · <age_hours>h'.\n" +
      "If age_hours ≤ 24, stay silent.",
  },
  {
    id: 'battery-health',
    category: 'HOME',
    title: 'Battery health',
    icon: '⌬',
    summary:
      'Weekly, log cycle count and maximum capacity so you can track degradation over time.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "run_shell cmd:'ioreg -rn AppleSmartBattery | grep -E \"CycleCount|DesignCapacity|MaxCapacity|AppleRawMaxCapacity\" | head -10'. Parse values.\n" +
      "If output is empty (no battery — desktop Mac), memory_add tags:['#battery','#na'] text:'no battery found' and stop.\n" +
      "Otherwise compute health_pct = MaxCapacity / DesignCapacity × 100 (use AppleRawMaxCapacity if DesignCapacity missing).\n" +
      "memory_add tags:['#battery-sample'] text:'<ISO> · cycles=<N> · health=<pct>%'.\n" +
      "Trend: memory_search query:'battery-sample' limit:10. If most recent prior sample shows cycles same as now (no recent use), skip alert. Otherwise if health_pct < 80 AND this is the first time it crossed that line (no prior #battery-low entry), speak text:'Battery at <pct>% of design capacity (<N> cycles) — consider a service check.' memory_add tags:['#battery-low'] text:'<ISO> · <pct>%'.",
  },

  // ── Fan-out showcase templates that exercise the full delegation API.
  // These are the ones that justify the whole sub-agent infrastructure:
  // tens of parallel tool calls collapsed into a single spawn_parallel.
  {
    id: 'project-pulse',
    category: 'CODING',
    title: 'Project pulse',
    icon: '◈',
    summary:
      'Daily, fan out a full health check (git + tests + deps + TODOs) across every tracked repo and file one digest.',
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Resolve repos: memory_search query:'repo path' limit:10, else run_shell cmd:'ls -d ~/code/*/.git 2>/dev/null | xargs -n1 dirname'. Cap at 6 repos so each child has headroom.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:900. One goal per repo — each child does a mini end-to-end audit:\n" +
      "  'Run a full pulse check on the repo at <absolute path>. Execute these four checks sequentially (you do NOT need to delegate further):\\n" +
      "    1) Git status: run_shell cmd:\"git -C <repo> status --porcelain=v1 | wc -l\" → dirty count. Also git log since midnight count via run_shell cmd:\"git -C <repo> log --since=midnight --oneline 2>/dev/null | wc -l\".\\n" +
      "    2) Tests: detect toolchain and run one test command. Node → \"cd <repo> && (pnpm test --run 2>&1 || npm test --silent 2>&1) | tail -20\". Rust → \"cd <repo> && cargo test --no-fail-fast --color=never 2>&1 | tail -20\". Python → \"cd <repo> && pytest -x --no-header 2>&1 | tail -20\". Count FAIL/failed tokens.\\n" +
      "    3) Deps: audit quickly. Node → \"cd <repo> && (pnpm audit --json 2>/dev/null || npm audit --json 2>/dev/null) | head -c 10000\". Rust → \"cd <repo> && cargo audit 2>&1 | tail -20\". Python → \"cd <repo> && pip-audit 2>&1 | tail -20\". Count critical advisories.\\n" +
      "    4) TODOs: run_shell cmd:\"cd <repo> && rg -c \\\"(TODO|FIXME|HACK)[:(]\\\" --glob \\\"!*/node_modules/*\\\" --glob \\\"!*/target/*\\\" --glob \\\"!*/dist/*\\\" 2>/dev/null | wc -l\" → rough TODO count.\\n" +
      "  Return EXACTLY as your final answer: \"repo=<basename> dirty=<N> commits_today=<T> tests=<pass|fail> fails=<F> critical=<C> todos=<K>\". ≤200 chars.'\n" +
      "labels:['pulse:<basename>', ...].\n" +
      "Parse every child's line. Aggregate totals. Build a dashboard note: notes_create title:'Project pulse — <YYYY-MM-DD>' folder:'Reports' body:<markdown table with one row per repo and columns for each metric, plus a summary line>. memory_add tags:['#project-pulse'] text:'<ISO> · repos=<N> dirty_total=<A> tests_failing=<B> critical_total=<C>'. If any tests=fail OR critical>0, speak text:'<N> repo<s> unhealthy — tests failing in <first>, critical deps in <other>.' Otherwise silent — the digest is the deliverable.",
  },
  {
    id: 'topic-deep-pack',
    category: 'RESEARCH',
    title: 'Topic deep-pack',
    icon: '❋',
    summary:
      'Weekly, pick one #interest topic and fan out across arXiv + HN + Reddit + web to build a full briefing.',
    kind: 'interval',
    everySec: 604_800,
    goal:
      "Pick ONE topic: memory_search query:'interest topic' limit:5. Deterministic pick — sort results by id and take the one whose id8 hashed to (week_of_year mod count) — that way each topic gets a rotation across the year.\n" +
      "If zero topics, stop silently.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:1200. Four goals covering four sources of truth:\n" +
      "  1) 'Find the 3 freshest arXiv papers on \"<topic>\". web_search query:\"site:arxiv.org <topic> 2026\" limit:8. For each top /abs/ URL, web_fetch_readable it and capture title+authors+abstract (≤600 chars). Return a markdown block with H3 per paper, URL under the title, italicised abstract.'\n" +
      "  2) 'Find recent Hacker News discussions on \"<topic>\". web_search query:\"site:news.ycombinator.com <topic> 2026\" limit:5. For each result, web_fetch_readable. Return a markdown bullet list: \"- [<title>](<url>) — <one-sentence thread gist>\".'\n" +
      "  3) 'Do a broad web_search query:\"<topic> 2026 state of the art\" limit:6 and deep_research query:\"<topic> latest 2026 developments\" profile_id:\"default\" max_sources:5. Return the deep_research markdown brief verbatim as your final answer, prefixed with \"## Web synthesis\\n\".'\n" +
      "  4) 'Find community reddit-like discussion on \"<topic>\". web_search query:\"site:reddit.com <topic> 2026\" limit:5. For each, web_fetch_readable. Return a markdown bullet list: \"- [r/<sub>: <title>](<url>) — <one-line takeaway>\".'\n" +
      "labels:['pack:arxiv','pack:hn','pack:web','pack:reddit'].\n" +
      "Combine all four successful children (skip errors/timeouts) into one doc: H1 = 'Deep pack — <topic> — <YYYY-MM-DD>', then H2 'arXiv' / 'Hacker News' / 'Web synthesis' / 'Community' using each child's markdown verbatim. Prepend a 3-sentence executive summary YOU synthesize by reading the first 500 chars of every child.\n" +
      "Persist: notes_create title:'Deep pack — <topic> — <YYYY-MM-DD>' folder:'Research' body:<the combined markdown>. memory_add tags:['#topic-deep-pack', topic] text:'<ISO> · <topic> · sections=<count>'. Silent run.",
  },
  {
    id: 'daemon-health',
    category: 'WATCHERS',
    title: 'Daemon health',
    icon: '◐',
    summary:
      'Every 6h, audit recent daemon runs and investigate any daemon that has failed 3+ times in the last 24h.',
    kind: 'interval',
    everySec: 21_600,
    goal:
      "Use subagent_list status:'error' limit:50 to find recent failed sub-agent runs. Also subagent_list status:'max_steps' limit:30. Combine and filter to entries whose createdAt is within the last 24h.\n" +
      "Group by parent label prefix (extract the leading 'daemon:<id>' segment; skip 'agent'-rooted runs). Count failures per daemon. A daemon is UNHEALTHY if count ≥ 3.\n" +
      "If zero unhealthy daemons, memory_add tags:['#daemon-health'] text:'<ISO> · all daemons healthy' and stop silently.\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:600 to investigate each unhealthy daemon in parallel. Cap at 5 investigations. One goal per unhealthy daemon:\n" +
      "  'Investigate why daemon <daemon_id> has failed <N> times in the last 24h. Use subagent_list parent:\"daemon:<daemon_id>\" limit:10 to see the recent runs. Read the finalAnswer of the 3 most recent failed runs (use subagent_status id:<id> for each). Classify the failure mode as ONE of: TIMEOUT, TOOL_ERROR, GOAL_AMBIGUOUS, EXTERNAL_DEPENDENCY_DOWN, LOOP_CAP, OTHER. Return EXACTLY: \"daemon=<id> failures=<N> classification=<one of the above> evidence=<1-sentence pattern across the failures, ≤200 chars> suggestion=<one concrete fix to try, ≤100 chars>\".'\n" +
      "labels:['daemon-health:<id>', ...].\n" +
      "Combine children's single-line verdicts into a markdown diagnosis report. notes_create title:'Daemon health — <YYYY-MM-DD HH:MM>' folder:'Reports' body:<markdown: H3 per daemon with its classification / evidence / suggestion, plus an 'All failures' section listing the raw counts>. memory_add tags:['#daemon-health','#unhealthy'] text:<comma-joined daemon ids>.\n" +
      "Speak ONE sentence: '<N> daemon<s> unhealthy — <first daemon title if resolvable, else first id> (<classification>).'",
  },
  {
    id: 'morning-concierge',
    category: 'MORNING',
    title: 'Morning concierge',
    icon: '❂',
    summary:
      "Premium morning: a concierge that fans out weather, calendar, mail, news, and tasks in parallel then synthesises one spoken headline.",
    kind: 'interval',
    everySec: 86_400,
    goal:
      "Resolve city: memory_search query:'home location' limit:3 (fall back to 'San Francisco').\n" +
      "FAN OUT with spawn_parallel wait:true timeout_sec:300. Five independent gathers, all returning tight structured lines:\n" +
      "  1) 'Get the day overview for <city>. Call weather_current city:\"<city>\" and sunrise_sunset city:\"<city>\". Return EXACTLY: \"WEATHER::<one-sentence weather summary>\\nSUN::<sunrise HH:MM → sunset HH:MM>\".'\n" +
      "  2) 'Get today\\'s calendar. Call calendar_today. Return EXACTLY: \"CAL::<count> events\\n<first 3 events, one per line, format \"HH:MM <title>\">\".'\n" +
      "  3) 'Get urgent mail. Call mail_list_unread limit:15. Filter to senders in memory_search query:\"vip\" limit:10 OR subjects with URGENT/DEADLINE/TODAY keywords. Return EXACTLY: \"MAIL::<count> urgent\\n<first 3 urgent, one per line, format \"<sender>: <subject trimmed to 80 chars>\">\". If none urgent, return \"MAIL::0 urgent\".'\n" +
      "  4) 'Get top priorities. Call memory_search query:\"priority\" limit:5. Return EXACTLY: \"PRIO::<count>\\n<up to 3 priority lines, one per line>\". If none, return \"PRIO::0\".'\n" +
      "  5) 'Get open reminders for today. Call reminders_today. Return EXACTLY: \"REM::<count>\\n<up to 3 reminder titles, one per line>\". If none, return \"REM::0\".'\n" +
      "labels:['conc:weather','conc:calendar','conc:mail','conc:priorities','conc:reminders'].\n" +
      "Parse all five children. Build a two-tier output:\n" +
      "  A) Full briefing markdown (for the Notes app): H2 Weather, Calendar, Mail, Priorities, Reminders, each using the child's block.\n" +
      "  B) Spoken headline (≤30 words): ONE sentence that distils the urgent signals. Template: 'Good morning. <weather one-line>. <N> events, <M> urgent mail<s>, top priority <first priority or reminder>.'\n" +
      "Persist: notes_create title:'Concierge — <YYYY-MM-DD>' folder:'Briefings' body:<the full briefing>. memory_add tags:['#concierge'] text:<the spoken headline>. speak text:<the spoken headline>.",
  },
];

/**
 * Convert a template into a DaemonSpec ready for `daemons_add`. The caller
 * can override any field (e.g. schedule cadence, title) before submission.
 */
export function specFromTemplate(t: Template, overrides?: Partial<DaemonSpec>): DaemonSpec {
  const base: DaemonSpec = {
    title: t.title,
    kind: t.kind,
    every_sec: t.kind === 'interval' ? (t.everySec ?? null) : null,
    goal: t.goal,
  };
  return { ...base, ...overrides };
}

export const CATEGORY_ORDER: ReadonlyArray<Template['category']> = [
  'MORNING',
  'FOCUS',
  'INBOX',
  'CODING',
  'RESEARCH',
  'WRITING',
  'CLEANUP',
  'WATCHERS',
  'LEARN',
  'LIFE',
  'MONEY',
  'HOME',
];
