# SUNNY Keyboard Shortcuts

HUD modules are described in [`PAGES.md`](./PAGES.md). This document lists **keys only**.

All shortcuts are non-modal (fire from page root) unless marked "focus-safe" — those also work when a text input is focused.

---

## Global

| Shortcut | Action | Source |
|---|---|---|
| `⌘K` | Open Quick Launcher | `src/components/QuickLauncher.tsx` |
| `⌘/` | Open Help overlay | `src/components/HelpOverlay.tsx` |
| `⌘1` – `⌘9` | Jump to module by position in nav | `src/components/Dashboard.tsx` |
| `Space` | Push-to-talk (record voice input) | `src/hooks/useVoiceChat.ts` |
| `⌘↵` (in ⌘K on FILE hit) | Reveal in Finder instead of open | `src/components/QuickLauncher.tsx` |

---

## Dashboard / Overview

| Shortcut | Action |
|---|---|
| `⌘K` | Quick Launcher (global, accessible from dashboard) |
| `⌘/` | Help overlay |

---

## TimelinePage

| Shortcut | Action | Source |
|---|---|---|
| `←` / `→` | Navigate previous / next day | `src/pages/TimelinePage` |
| URL hash `#kind` | Jump to and highlight a specific event kind chip | `src/pages/TimelinePage` |

---

## TasksPage

| Shortcut | Action | Source |
|---|---|---|
| `⌘A` | Select all tasks | `src/pages/TasksPage` |
| `Delete` | Delete selected task(s) | `src/pages/TasksPage` |
| `C` | Mark selected task(s) complete | `src/pages/TasksPage` |

---

## CalendarPage

| Shortcut | Action | Source |
|---|---|---|
| `←` / `→` | Previous / next month (or week in WEEK view) | `src/pages/CalendarPage.tsx` |
| `Shift+←` / `Shift+→` | Jump back / forward by one year | `src/pages/CalendarPage.tsx` |
| `N` | New event form | `src/pages/CalendarPage.tsx` |
| `T` | Jump to today | `src/pages/CalendarPage.tsx` |
| `G` | Open grid (month) view | `src/pages/CalendarPage.tsx` |
| `Esc` | Close new-event form / dismiss modal | `src/pages/CalendarPage.tsx` |

---

## VoicePage

| Shortcut | Action | Source |
|---|---|---|
| `Space` | Toggle recording (push-to-talk) | `src/pages/VoicePage`, `src/hooks/useVoiceChat.ts` |

The VAD hook (`src/hooks/useVoiceActivity.ts`) also handles auto-stop after 900 ms silence and barge-in while the AI is speaking — no key required for those paths.

---

## SkillsPage / CodePage / ConsolePage — REPL history

| Shortcut | Action | Source |
|---|---|---|
| `↑` | Previous history entry | REPL input component in each page |
| `↓` | Next history entry | REPL input component in each page |

---

## ScreenPage

| Shortcut | Action | Source |
|---|---|---|
| `Space` | Full screen capture | `src/pages/ScreenPage.tsx` |
| `⌘R` | Re-capture (same mode as last) | `src/pages/ScreenPage.tsx` |
| `O` | Run OCR on current capture | `src/pages/ScreenPage.tsx` |
| `B` | Toggle OCR bounding-box overlay | `src/pages/ScreenPage.tsx` |
| `S` | Toggle region-select drag mode | `src/pages/ScreenPage.tsx` |
| `D` | Download capture as PNG | `src/pages/ScreenPage.tsx` |
| `C` | Copy image to clipboard | `src/pages/ScreenPage.tsx` |
| `Esc` | Close full-size modal / cancel region select | `src/pages/ScreenPage.tsx` |

All page-level shortcuts are no-ops when focus is inside an `input`, `textarea`, or `contenteditable`.

---

## FilesPage

| Shortcut | Action | Source |
|---|---|---|
| `/` or `⌘F` | Focus search | `src/pages/FilesPage.tsx` |
| `⌘R` | Reload directory | `src/pages/FilesPage.tsx` |
| `⌘N` | New file | `src/pages/FilesPage.tsx` |
| `⌘⇧N` | New folder | `src/pages/FilesPage.tsx` |
| `Enter` | Open selected item | `src/pages/FilesPage.tsx` |
| `Backspace` | Navigate up one directory | `src/pages/FilesPage.tsx` |
| `Delete` / `Backspace` (on selection) | Move to Trash (with confirm) | `src/pages/FilesPage.tsx` |
| `⌘A` | Select all | `src/pages/FilesPage.tsx` |
| `Shift+Click` | Range select | `src/pages/FilesPage.tsx` |
| `⌘+Click` | Toggle individual item in selection | `src/pages/FilesPage.tsx` |

---

## AppsPage

| Shortcut | Action | Source |
|---|---|---|
| `/` | Focus search | `src/pages/AppsPage.tsx` |
| `↑` `↓` `←` `→` | Move focus through tiles / rows | `src/pages/AppsPage.tsx` |
| `Enter` | Launch focused app | `src/pages/AppsPage.tsx` |
| `F` | Toggle favorite on focused app | `src/pages/AppsPage.tsx` |
| `R` | Reveal focused app in Finder | `src/pages/AppsPage.tsx` |
| `H` | Hide focused app (if running) | `src/pages/AppsPage.tsx` |
| `Q` | Quit focused app (if running, with confirm) | `src/pages/AppsPage.tsx` |
| `⌘G` | Switch to grid view | `src/pages/AppsPage.tsx` |
| `⌘L` | Switch to list view | `src/pages/AppsPage.tsx` |
| `Esc` | Clear search, then clear focus | `src/pages/AppsPage.tsx` |

---

## AutoPage (Agents / Todos / Scheduled / Activity)

| Shortcut | Action | Source |
|---|---|---|
| `1` / `2` / `3` / `4` | Jump to AGENTS / TODOS / SCHEDULED / ACTIVITY tab | `src/pages/AutoPage/index.tsx` |

Guarded against text inputs so typing `"1"` in the goal textarea doesn't switch tabs.

---

## ScanPage

| Shortcut | Action | Source |
|---|---|---|
| `1` / `2` / `3` / `4` | Jump to SCAN / FINDINGS / VAULT / HISTORY tab | `src/pages/ScanPage/` |
| `/` | Focus findings search (in FINDINGS tab) | `src/pages/ScanPage/` |

---

## SecurityPage

Live runtime security (distinct from **Scan**). Hotkeys are disabled while focus is in an `input`, `textarea`, or `contenteditable`. No `⌘` / `ctrl` / `alt` combos on the digit row — those are reserved for other chords.

| Shortcut | Action | Source |
|---|---|---|
| `1` – `9` | Tabs: OVERVIEW / POLICY / AGENT / NETWORK / PERMS / INTRUSION / SECRETS / SYSTEM / AUDIT | `src/pages/SecurityPage/index.tsx` |
| `!` | Arm **panic** (stops tools + egress + disables daemons; no modal — intentional chord) | `src/pages/SecurityPage/index.tsx` |
| `P` | **Release panic** when panic mode is active (same as Overview “◎ RELEASE PANIC”) | `src/pages/SecurityPage/index.tsx` |

Nav-strip **PANIC** is click-to-confirm; see [`SECURITY.md`](./SECURITY.md).

---

## MemoryPage

| Shortcut | Action | Source |
|---|---|---|
| `1` – `6` | EPISODIC / SEMANTIC / PROCEDURAL / TOOLS / INSIGHTS / HISTORY | `src/pages/MemoryPage/` |

---

## SettingsPage

| Shortcut | Action | Source |
|---|---|---|
| `1` – `8` | GENERAL / MODELS / CAPABILITIES / CONSTITUTION / PERMISSIONS / HOTKEYS / MODULES / ADVANCED | `src/pages/SettingsPage/index.tsx` |
| `⌘/` or `⌘F` | Focus settings search | `src/pages/SettingsPage/index.tsx` |
| `⌘S` | Flash “saved” badge (settings already persist on change) | `src/pages/SettingsPage/index.tsx` |

---

## Terminals Overlay

| Shortcut | Action | Source |
|---|---|---|
| `⌘T` | New terminal tile | `src/components/TerminalsOverlay.tsx` |
| `⌘1` – `⌘9` | Switch to terminal tile by position | `src/components/TerminalsOverlay.tsx` |
| `⌘F` | Per-tile scrollback search | `src/components/PtyTerminal.tsx` |
| `⌘C` | Copy selection to clipboard | `src/components/PtyTerminal.tsx` |
| `⌘V` | Paste (bracketed paste when shell supports DECSET 2004) | `src/components/PtyTerminal.tsx` |
| `⌘K` | Clear scrollback buffer | `src/components/PtyTerminal.tsx` |
| `Esc` | Exit tile fullscreen (first press), then close overlay | `src/components/TerminalsOverlay.tsx` |

---

## Browser (WebPage)

| Shortcut | Action | Source |
|---|---|---|
| `⌘T` | New tab | `src/pages/WebPage/index.tsx` |
| `⌘W` | Close active tab | `src/pages/WebPage/index.tsx` |
| `⌘L` | Focus address bar | `src/pages/WebPage/index.tsx` |
| `⌘R` | Reload | `src/pages/WebPage/index.tsx` |
| `⌘[` | Navigate back | `src/pages/WebPage/index.tsx` |
| `⌘]` | Navigate forward | `src/pages/WebPage/index.tsx` |
| `⌘+` / `⌘-` / `⌘0` | Zoom in / out / reset (50–250 %, persisted per profile) | `src/pages/WebPage/tabStore.ts` |
| `⌘⇧T` | Reopen last closed tab (default profile only) | `src/pages/WebPage/tabStore.ts` |
| `⌘F` | In-page find (reader mode) | `src/pages/WebPage/ReaderContent.tsx` |
| `Esc` | Dismiss find bar | `src/pages/WebPage/ReaderContent.tsx` |

---

## ContactsPage

| Shortcut | Action | Source |
|---|---|---|
| `⌘↩` | Send composed message (with ConfirmGate) | `src/pages/ContactsPage/ConversationDetail.tsx` |

