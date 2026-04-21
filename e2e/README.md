# End-to-end tests

Playwright specs that exercise the SUNNY HUD against the Vite dev server
(not against the Tauri-wrapped production build). See the top of
[`../playwright.config.ts`](../playwright.config.ts) for the rationale
and the gaps this harness deliberately does not cover.

## Activate

Playwright + Chromium aren't in the default dev-deps (roughly 300 MB of
browser binaries). One-time:

```bash
pnpm add -D @playwright/test
npx playwright install chromium
```

## Run

```bash
pnpm test:e2e           # headless, single pass
pnpm test:e2e --headed  # watch the browser
pnpm test:e2e --ui      # Playwright's interactive UI mode
```

The `webServer` block in the config auto-spawns `pnpm dev` on port 5173
for each run (or reuses an existing dev server outside CI).

## What to write here

New specs should be **feature smoke tests**, not unit tests. Prefer

- "Scheduler: create a job, toggle enabled, delete it"
- "SECURITY → GRANTS tab renders denial rows from a mocked invoke"
- "Voice button responds to Space / Esc and CommandBar receives focus"

over anything the Rust unit tests already cover. The value of this
harness is exercising the integration between state, rendering, and
keyboard/aria contract — not re-testing pure logic.
