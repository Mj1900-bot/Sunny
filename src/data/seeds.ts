/**
 * Side-nav layout.
 *
 * The nav is now grouped into sections so it can scale past a dozen
 * items without turning into a wall of identical rows. Section headers
 * render as thin caps; each item is a compact 22px row with an icon
 * and label. Order matters — items appear top-to-bottom in list order.
 *
 * Keep this file pure data. The NavPanel component maps `label` →
 * ViewKey via LABEL_TO_VIEW and renders each section with a header.
 */
export type NavSection = 'CORE' | 'LIFE' | 'COMMS' | 'KNOW' | 'DO' | 'AI·SYS';

export type NavModule = {
  readonly label: string;
  readonly icon: string;
  readonly section: NavSection;
  /** Optional short caption rendered next to the label on wider nav. */
  readonly badge?: string;
};

export const NAV_MODULES: ReadonlyArray<NavModule> = [
  // CORE — the things Sunny greets you with.
  { label: 'OVERVIEW', icon: 'hub',      section: 'CORE' },
  { label: 'SECURITY', icon: 'security', section: 'CORE' },
  { label: 'TODAY',    icon: 'today',    section: 'CORE' },
  { label: 'TIMELINE', icon: 'timeline', section: 'CORE' },

  // LIFE — day-to-day work, attention, time.
  { label: 'TASKS',    icon: 'tasks',    section: 'LIFE' },
  { label: 'JOURNAL',  icon: 'journal',  section: 'LIFE' },
  { label: 'FOCUS',    icon: 'focus',    section: 'LIFE' },
  { label: 'CALENDAR', icon: 'calendar', section: 'LIFE' },

  // COMMS — people, messages, voice.
  { label: 'INBOX',    icon: 'inbox',    section: 'COMMS' },
  { label: 'PEOPLE',   icon: 'people',   section: 'COMMS' },
  { label: 'CONTACTS', icon: 'contacts', section: 'COMMS' },
  { label: 'VOICE',    icon: 'voice',    section: 'COMMS' },
  { label: 'NOTIFY',   icon: 'notify',   section: 'COMMS' },

  // KNOW — reference, artifacts, captured knowledge.
  { label: 'NOTES',    icon: 'notes',    section: 'KNOW' },
  { label: 'READING',  icon: 'reading',  section: 'KNOW' },
  { label: 'MEMORY',   icon: 'memory',   section: 'KNOW' },
  { label: 'PHOTOS',   icon: 'photos',   section: 'KNOW' },
  { label: 'FILES',    icon: 'files',    section: 'KNOW' },

  // DO — agents, tools, surfaces Sunny can act on.
  { label: 'AUTO',     icon: 'auto',     section: 'DO' },
  { label: 'SKILLS',   icon: 'skills',   section: 'DO' },
  { label: 'APPS',     icon: 'apps',     section: 'DO' },
  { label: 'WEB',      icon: 'web',      section: 'DO' },
  { label: 'CODE',     icon: 'code',     section: 'DO' },
  { label: 'CONSOLE',  icon: 'console',  section: 'DO' },
  { label: 'SCREEN',   icon: 'screen',   section: 'DO' },
  { label: 'SCAN',     icon: 'scan',     section: 'DO' },

  // AI·SYS — inside Sunny's head + machine plumbing.
  { label: 'WORLD',     icon: 'world',     section: 'AI·SYS' },
  { label: 'SOCIETY',   icon: 'society',   section: 'AI·SYS' },
  { label: 'BRAIN',     icon: 'brain',     section: 'AI·SYS' },
  { label: 'PERSONA',   icon: 'persona',   section: 'AI·SYS' },
  { label: 'INSPECTOR',   icon: 'inspector', section: 'AI·SYS' },
  { label: 'AUDIT',       icon: 'audit',     section: 'AI·SYS' },
  { label: 'DEVICES',     icon: 'devices',   section: 'AI·SYS' },
  { label: 'DIAGNOSTICS', icon: 'inspector', section: 'AI·SYS' },
  { label: 'VAULT',       icon: 'vault',     section: 'AI·SYS' },
  { label: 'SETTINGS',    icon: 'settings',  section: 'AI·SYS' },
] as const;

export const AGENT_LOG: Array<{ who: 'USER' | 'SUNNY'; text: string }> = [
  { who: 'USER', text: "hey sunny, what's on my plate today?" },
  { who: 'SUNNY', text: '4 meetings, 12 tasks. Design sync in 8 min. Demo prep at 16:00 — not started.' },
  { who: 'USER', text: 'summarize the q2 roadmap in 3 bullets' },
  { who: 'SUNNY', text: '✓ Ship auto-scheduling · ✓ Rewrite sync engine · ⚠ Hardware integration slipped to Q3' },
];

export const CLIPBOARD_ITEMS = [
  { kind: 'TEXT', time: '10:42', text: 'https://research.notion.so/q2-plan' },
  { kind: 'IMG', time: '10:28', text: 'screenshot-2026-04-17.png' },
  { kind: 'CODE', time: '09:55', text: 'const api = new SunnyClient(...)' },
  { kind: 'TEXT', time: '09:22', text: '10.0.1.42' },
  { kind: 'TEXT', time: '08:17', text: 'Reservation confirmation #AX-9921' },
];

export const CALENDAR = [
  { tone: 'now' as const, time: 'NOW', title: 'Design sync — Jordan, Kai', sub: '1:1 · Zoom' },
  { tone: 'normal' as const, time: '14:30', title: 'Review Q2 roadmap', sub: 'Solo · 45 min' },
  { tone: 'amber' as const, time: '16:00', title: 'Demo prep with exec team', sub: 'Conf-A · 60 min' },
  { tone: 'normal' as const, time: '19:00', title: "Dinner — Sam's birthday", sub: 'Shizuoka · Reserved' },
];

export const FALLBACK_PROCS = [
  { name: 'sunny.core', cpu: 14, mem_mb: 1200 },
  { name: 'Chrome', cpu: 28, mem_mb: 3100 },
  { name: 'Figma', cpu: 9, mem_mb: 780 },
  { name: 'VS Code', cpu: 6, mem_mb: 1024 },
  { name: 'Spotify', cpu: 2, mem_mb: 240 },
  { name: 'docker.vm', cpu: 12, mem_mb: 2400 },
  { name: 'Mail', cpu: 1, mem_mb: 180 },
  { name: 'Slack', cpu: 4, mem_mb: 512 },
];

export const TRANSCRIPT_LINES = [
  '<em>waiting for wake word…</em>',
  'heard: "hey sunny"…',
  'heard: "summarize my emails"',
  'heard: "read me the top three"',
  'heard: "schedule 30 min with Jordan tomorrow"',
];

export const SHELL_SEED = [
  { html: true, text: `<span class="prompt">kingly</span><span class="dim">@</span><span class="cyan">sunny</span><span class="dim">:</span><span class="path">~/sunny</span><span class="dim">$</span> <span class="cmd">ls -lh</span>` },
  { html: true, text: `<span class="out">drwxr-xr-x  kingly  <span class="cyan">agents/</span></span>` },
  { html: true, text: `<span class="out">drwxr-xr-x  kingly  <span class="cyan">memory/</span></span>` },
  { html: true, text: `<span class="out">-rw-r--r--  kingly  config.yml  2.1K</span>` },
  { html: true, text: `<span class="out">-rw-r--r--  kingly  vault.enc  <span class="dim">🔒</span></span>` },
  { html: true, text: `<span class="prompt">kingly</span><span class="dim">@</span><span class="cyan">sunny</span><span class="dim">:</span><span class="path">~/sunny</span><span class="dim">$</span> <span class="cmd">sunny status</span>` },
  { html: true, text: `<span class="ok">● core.service</span> <span class="dim">active (running) · 4h 12m</span>` },
  { html: true, text: `<span class="ok">● voice.listener</span> <span class="dim">active (idle) · wake word armed</span>` },
  { html: true, text: `<span class="warn">● index.worker</span> <span class="dim">indexing ~/Documents (74%)</span>` },
];

export const SHELL_COMMANDS = [
  'sunny ask "what\'s blocking demo prep?"',
  'sunny schedule 30m jordan tomorrow 2pm',
  'open -a "Figma" ~/Design/q2.fig',
  'grep -r "TODO" ~/sunny/agents',
  'sunny mute 45m',
  'sunny memory save "jordan prefers mornings"',
];

export const SHELL_REPLIES = [
  `<span class="out">↪ Demo prep blocked on: <span class="warn">slides v2</span>, <span class="warn">exec dry-run</span></span>`,
  `<span class="ok">✓ Scheduled — invite sent to jordan@</span>`,
  `<span class="out">Launching Figma…</span>`,
  `<span class="out">agents/planner.py:42: <span class="warn">TODO</span> replan on interrupt</span>`,
  `<span class="ok">✓ Focus mode on — 45 min</span>`,
  `<span class="ok">✓ Saved to memory · vec#A3F7</span>`,
];

export const AGENT_SEED = [
  `<span class="dim">sunny-cli · v4.21 · session 0x7F3A</span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">plan: review emails</span>`,
  `<span class="out">  ├─ tool: <span class="cyan">mail.read_inbox</span>(unread=true)</span>`,
  `<span class="out">  │   <span class="ok">✓ 14 msgs</span> · 3 important · 2 calendar invites</span>`,
  `<span class="out">  ├─ tool: <span class="cyan">llm.summarize</span>(msgs, top=3)</span>`,
  `<span class="out">  │   <span class="ok">✓ 240 tokens</span></span>`,
  `<span class="out">  └─ <span class="ok">done</span> · 1.82s</span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">plan: book flight SFO→JFK Fri</span>`,
  `<span class="out">  ├─ tool: <span class="cyan">flights.search</span>(SFO, JFK, 04-25)</span>`,
  `<span class="out">  ├─ tool: <span class="cyan">user.prefs</span>() <span class="dim">aisle, morning</span></span>`,
  `<span class="out">  ├─ tool: <span class="cyan">calendar.hold</span>(9am–8pm)</span>`,
  `<span class="out">  └─ <span class="warn">⎇ needs confirm:</span> UA 432 · 06:15 · $389</span>`,
];

export const AGENT_FEED = [
  `<span class="prompt">&gt;</span> <span class="cmd">tool: <span class="cyan">vault.unlock</span>("github_token")</span>`,
  `<span class="out">  └─ <span class="ok">✓ granted</span> · expires 15m</span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">tool: <span class="cyan">screen.read_active</span>()</span>`,
  `<span class="out">  └─ VS Code · index.html · line 412</span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">tool: <span class="cyan">fs.index</span>("~/Documents/Research")</span>`,
  `<span class="out">  └─ 1,284 files · <span class="dim">embedding…</span></span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">memory.recall("jordan")</span>`,
  `<span class="out">  └─ 12 memories · prefers 1:1 mornings, pescatarian</span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">tool: <span class="cyan">llm.complete</span>(n=128)</span>`,
  `<span class="out">  └─ <span class="ok">✓</span> · 82ms · $0.0004</span>`,
  `<span class="prompt">&gt;</span> <span class="cmd">guardrail: <span class="warn">confirm payment &gt; $100</span></span>`,
  `<span class="out">  └─ awaiting user approval</span>`,
];

export const SYSLOG_POOL = [
  `<span class="ok">[OK]</span> wake.listener armed · threshold -32dB`,
  `<span class="out">[INF]</span> fs.watch ~/Desktop · 3 changes`,
  `<span class="out">[INF]</span> net.probe 10.0.1.1 · rtt 2.3ms`,
  `<span class="warn">[WRN]</span> gpu.thermal 74°C · throttle engaged`,
  `<span class="ok">[OK]</span> llm.cache hit · saved 1,240 tok`,
  `<span class="out">[INF]</span> calendar.sync 4 events · +1 amended`,
  `<span class="err">[ERR]</span> bluetooth.peripheral airpods-pro · disconnect`,
  `<span class="ok">[OK]</span> bluetooth.reconnect airpods-pro · 120ms`,
  `<span class="out">[INF]</span> clipboard.capture type=url len=42`,
  `<span class="ok">[OK]</span> vault.seal · 256-bit · key#A3F7`,
  `<span class="out">[INF]</span> screen.capture display=1 · 120fps`,
  `<span class="warn">[WRN]</span> mail.spam filter skipped 1 (lbl=work)`,
  `<span class="out">[INF]</span> pipeline.plan created · 3 steps`,
  `<span class="ok">[OK]</span> backup.incremental 4.2GB · NAS`,
  `<span class="out">[INF]</span> web.search q="q2 oss trends" · 12 hits`,
];
