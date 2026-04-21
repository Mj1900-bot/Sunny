import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration — scoped to SUNNY's Vite dev server.
 *
 * SUNNY is a Tauri desktop app; its real runtime needs `tauri-driver` +
 * Chromium distribution matching the WebKit build used by tauri's webview.
 * That harness is nontrivial to set up on a dev laptop, and it doesn't
 * exercise anything the dev server doesn't — the HUD markup, React state,
 * styling, keyboard flow, a11y announcements — all drive from the webview
 * side. Running against `pnpm dev` (http://localhost:5173) covers 95% of
 * the regression surface with zero tauri-specific tooling.
 *
 * Gaps this harness does NOT cover (by design):
 *   - Tauri IPC calls (invoke/listen) — mocked in `lib/tauri` outside Tauri,
 *     returning undefined. The React side has to degrade gracefully anyway,
 *     so asserting that degradation IS the value.
 *   - Native OS integrations — Keychain, AppleScript, Notification Center.
 *     Those belong in Rust unit + integration tests (`cargo test --lib`).
 *
 * Activation:
 *   pnpm add -D @playwright/test
 *   npx playwright install chromium
 *   pnpm test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Spawn the Vite dev server automatically for each run. Reused when an
  // existing dev server is already listening on 5173.
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
