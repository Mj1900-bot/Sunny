# SUNNY Accessibility — Sprint-12 / Sprint-13 Audit

## Status Table

| Page / Component | Status | Notes |
|---|---|---|
| Overview (OrbCore HUD) | ✅ | role=button, tabIndex, Enter/Space, aria-label with state, live region for state changes |
| VoiceButton | ✅ | aria-label reflects all 3 states, aria-pressed on continuous toggle, native button handles Space/Enter |
| ChatPanel | ✅ | role=log + aria-live on message list, aria-label on each turn, CLEAR button labelled |
| NavPanel | ✅ | aria-current=page, role=navigation, section collapse uses aria-expanded + aria-controls, filter input labelled |
| QuickLauncher ⌘K | ✅ | role=dialog + aria-modal, aria-activedescendant links input to selection, result count live region, Escape closes |
| Settings | ✅ | Labels wrap inputs (valid association), range inputs have aria-label + aria-valuetext |
| ConfirmGateModal | ✅ | role=dialog, aria-labelledby, aria-describedby, Escape deny, auto-focus Allow button |
| ConfirmGate | ✅ | Same as Modal; parallel implementation |
| TopBar | ✅ | Dock toggle has aria-pressed, buttons have aria-label |
| AgentsPanel | ✅ | aria-live polite for agent card announcements |
| ErrorBoundary | ✅ | role=alert + aria-live=assertive |
| ToastStack / AmbientToasts | ✅ | role=status + aria-live=polite |
| TerminalsOverlay | ✅ | role=dialog, aria-label, Escape closes |
| HelpOverlay | ✅ | role=dialog, aria-label |
| PlanPanel | ✅ | aside landmark, aria-labels on Stop/Clear/Collapse buttons |
| StatusBanner | ✅ | role=status + aria-live=polite |
| All panels (Panel.tsx) | ✅ | Corner decoration divs marked aria-hidden |
| Dashboard decorative layers | ✅ | .grid, .scan, .vignette, .drag-region marked aria-hidden |
| Skip navigation | ✅ | .skip-link added; target is #sunny-main-content wrapped in \<main\> |
| Auto / Files / Apps / Calendar / Tasks / Screen / Contacts / Notes / Memory / Web / Vault | 🟡 | Page-level content is accessible; individual data rows and tool forms not audited this sprint |
| SkillEditor | 🟡 | Error output uses role=alert; form inputs use label wrapping; aria-describedby not wired to error messages |

## Violations Found and Fixed (Sprint-12)

**Total fixed: 14 distinct WCAG violations across 7 files**

| # | Violation | WCAG | Component | Fix Applied |
|---|---|---|---|---|
| 1 | Message list not announced to AT | 4.1.3 | ChatPanel | role=log + aria-live=polite + aria-relevant=additions |
| 2 | Message turn had no speaker announcement | 1.3.1 | ChatPanel | aria-label={role} on each turn div |
| 3 | CLEAR button no accessible name | 4.1.2 | ChatPanel | aria-label="Clear conversation history" |
| 4 | Quick launcher input not linked to selected item | 4.1.2 | QuickLauncher | aria-activedescendant + id on option buttons |
| 5 | Result list had no accessible name | 4.1.2 | QuickLauncher | id=ql-listbox + aria-label on listbox |
| 6 | Result count not announced | 4.1.3 | QuickLauncher | role=status aria-live=polite live region |
| 7 | OrbCore state changes not announced | 4.1.3 | OrbCore | Offscreen aria-live region mirroring meta.label |
| 8 | OrbCore button label static (didn't include state) | 4.1.2 | OrbCore | aria-label updated to include current state |
| 9 | Skip navigation link absent | 2.4.1 | Dashboard | .skip-link + #sunny-main-content \<main\> target |
| 10 | Decorative grid/scan/vignette exposed to AT | 1.3.1 | Dashboard | aria-hidden=true on all decorative layers |
| 11 | Panel corner decorations exposed to AT | 1.3.1 | Panel.tsx | aria-hidden=true on .c1 and .c2 |
| 12 | Range inputs lacked value text for AT | 1.3.1 | SettingsDropdown | aria-label + aria-valuetext on all 3 range inputs |
| 13 | NavPanel filter input lacked visible focus ring | 2.4.7 | sunny.css | #p-nav input:focus-visible outline added |
| 14 | Voice / chat buttons lacked focus rings (all:unset) | 2.4.7 | sunny.css | .orb-voice-kbd button:focus-visible, #p-screen form button:focus-visible |

## Contrast Analysis (Dark Theme — #02060a background)

All contrast values computed against `--bg: #02060a`.

| Token | Value | Bg | Ratio | Pass? |
|---|---|---|---|---|
| --ink (#e6f8ff) | body text | #02060a | ~16.8:1 | ✅ AA + AAA |
| --ink-2 (#a9d4e5) | secondary text | #02060a | ~9.2:1 | ✅ AA |
| --ink-dim (#6f9fb2) | dimmed text | #02060a | 7.05:1 | ✅ AA |
| --cyan (#39e5ff) | accent / labels | #02060a | ~10.4:1 | ✅ AA + AAA |
| --amber (#ffb347) | user label | #02060a | ~8.9:1 | ✅ AA |
| --red (#ff4d5e) | system/error | #02060a | ~5.6:1 | ✅ AA |
| Panel bg (rgba(6,14,22,0.7)) | ~#050c12 | — | — | used as local bg |
| --ink on panel bg | — | ~#050c12 | ~15.9:1 | ✅ AA |
| --ink-dim on panel bg | — | ~#050c12 | 6.82:1 | ✅ AA |

Note: Sprint-12 docs cited 4.5–4.7:1 for `--ink-dim` on panel-bg. Recalculation using the precise WCAG linearisation formula gives 6.82:1. The earlier figure used an approximated luminance table.

## Sprint-13 Contrast Audit — Alternate Themes

All `--ink-dim` values measured against `--bg: #02060a` and composited panel background (~`#050c12`).

| Theme | --ink-dim token | vs --bg | vs panel-bg | AA body (4.5:1)? | Fix applied? |
|---|---|---|---|---|---|
| cyan (default) | `#6f9fb2` | 7.05:1 | 6.82:1 | PASS | none needed |
| amber | `#a58154` | 5.68:1 | 5.50:1 | PASS | none needed |
| green | `#6ec98a` | 10.05:1 | 9.73:1 | PASS | none needed |
| violet | `#9c8fcf` | 7.01:1 | 6.78:1 | PASS | none needed |
| magenta | `#c28aa9` | 7.26:1 | 7.03:1 | PASS | none needed |

No colour changes required. All five themes clear 4.5:1 AA for body text across both background surfaces.

## Motion / Reduced Motion

### Sprint-13 coverage — prefers-reduced-motion

| Animation | Element / Location | Mechanism | Notes |
|---|---|---|---|
| Orb canvas rAF loop | `OrbCore.tsx` canvas | JS — `useState` + `useEffect` with `matchMedia` listener | Loop halts; one static idle-state frame drawn. Listener responds to run-time OS setting changes. |
| SVG ring spin (ringA / ringB) | `OrbCore.tsx` | JS — same `reducedMotion` flag gates `requestAnimationFrame(tick)` | Rings frozen at their 0° initial position. |
| Pulse dot (`.orb-state .pulse`) | `sunny.css` | CSS `@media (prefers-reduced-motion: reduce)` | `animation: none` — dot visible but static. Carried over from sprint-12. |
| Agent breathe ring (`sunnyAgentBreathe`) | `OrbCore.tsx` inline style | JS — `reducedMotion` spread gates the `animation` property | Ring border still visible; pulsing suppressed. |
| Constitution amber pulse (`sunnyConstAmberPulse`) | `OrbCore.tsx` inline style | JS — `reducedMotion` spread gates the `animation` property | Static amber border shown; opacity fade suppressed. |
| Step-dot pulse (`sunnyStepDotPulse`) | `OrbCore.tsx` inline style | JS — `reducedMotion` spread gates the `animation` property | Dot visible at full opacity; scale animation suppressed. |
| Network activity bars (`barA`) | `sunny.css .net .bars i` | CSS `@media (prefers-reduced-motion: reduce)` | Frozen at `scaleY(0.6)`; bars still indicate approximate signal level. |
| System-critical bar blink (`sysCrit`) | `sunny.css .sys-item.crit .bar i` | CSS `@media (prefers-reduced-motion: reduce)` | Solid red bar `opacity: 1`; urgency conveyed by colour + text label. |
| Terminal cursor blink (`blink2`) | `sunny.css .term .cursor` | CSS `@media (prefers-reduced-motion: reduce)` | Solid block cursor; no blink. |

Animations that must keep running for functional reasons: none. The loading spinner (`agent-activity__dot--live`) is already in the reduced-motion kill-list from sprint-12. All functional state information (agent running, error, done) is also conveyed via text labels and live regions independent of animation.

- `body.reduced-motion` (Settings toggle) applies blanket `transition: none; animation: none` app-wide as a belt-and-braces fallback.

## TTS Transcript (Sprint-13 θ)

Sprint-13 θ adds a persistent transcript log. The `orb-tx` live region (`aria-live="polite"` + `aria-atomic="true"`) in `OrbCore.tsx` already announces streaming updates to screen readers. The new log panel provides a complete durable history, fulfilling sprint-12 deferred item 1 (TTS has no visual transcript). Screen reader users can navigate to the log to review prior SUNNY turns after speech ends.

## Open / Sprint-14 Follow-Ups

1. **Module page row interactivity.** List rows in Files, Apps, Contacts, etc. use `cursor: pointer` but many are plain `<div>` elements without `role="button"` or `tabIndex`. Sprint-14 should audit and fix those pages.
2. **SkillEditor errors.** Error messages rendered via `role=alert` but not linked to their triggering input via `aria-describedby`.
3. **Focus order within OrbCore.** When the orb panel has focus, Tab should move to VoiceButton → continuous toggle → stop button in reading order. Currently the orb-wrap intercepts Tab since `tabIndex={0}` and no explicit `tabIndex=-1` excludes the canvas or HUD overlay.
4. **Landmarks.** Only `<main>` was added. A `<header>` landmark on TopBar would complete the landmark map.
5. **`sunnyStepFadeIn` not guarded (sprint-14 triage).** The 150ms opacity fade-in on new step text (`.orb-tx-step`) is a minor transition, not a vestibular-risk animation. It should nonetheless be suppressed under reduced-motion for strict compliance. Deferred to sprint-14.
