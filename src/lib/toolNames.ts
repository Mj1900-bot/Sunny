// Static list of SUNNY agent tool names mirrored from
// `src-tauri/src/agent_loop/catalog.rs`. Kept in sync manually — the
// catalog is a `const &[ToolSpec]` so we can't easily introspect it
// from the frontend at runtime. If a Tauri `agent_tools_list` command
// lands, prefer calling that; until then, this is the source the
// command palette uses to surface "/tool X" suggestions.
//
// Order matches the catalog for easy diffing.

export const AGENT_TOOL_NAMES: ReadonlyArray<string> = [
  // weather + time
  'weather_current',
  'weather_forecast',
  'time_in_city',
  'sunrise_sunset',
  // web
  'web_fetch',
  'web_search',
  'web_extract_links',
  // browser
  'browser_open',
  'browser_read_page_text',
  // macOS apps (read)
  'mail_list_unread',
  'mail_unread_count',
  'mail_search',
  'calendar_today',
  'calendar_upcoming',
  'reminders_add',
  'reminders_list',
  'notes_search',
  'notes_create',
  'notes_append',
  'app_launch',
  'shortcut_run',
  // mail + calendar (write)
  'mail_send',
  'imessage_send',
  'calendar_create_event',
  // python sandbox
  'py_run',
  // messaging (read + write)
  'messaging_send_sms',
  'messaging_list_chats',
  'messaging_fetch_conversation',
  'contacts_lookup',
  // media
  'media_now_playing',
  'media_play_pause',
  // perception / system
  'system_metrics',
  'battery_status',
  'focused_window',
  'screen_ocr',
  'screen_capture_full',
  'clipboard_history',
  // memory / scheduling
  'memory_recall',
  'memory_remember',
  'scheduler_add',
  // compute
  'calc',
  'timezone_now',
  'unit_convert',
  'stock_quote',
  // multi-agent
  'spawn_subagent',
  // composites
  'remember_screen',
  'analyze_messages',
  'deep_research',
  'claude_code_supervise',
];
