import { expect, test } from '@playwright/test';

/**
 * Smoke test — the HUD mounts cleanly against the Vite dev server.
 *
 * This is the minimum regression guard: if the entire webview fails to
 * bootstrap — broken import, runtime exception in `<App />`, Zustand
 * store init panic — this test fails before any feature-level spec
 * runs. Keeping it tight keeps the signal sharp.
 */

test.describe('SUNNY HUD smoke', () => {
  test('boots, renders the main surface, and exposes the accessibility skip-link', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');

    // Core mount anchor — `Dashboard.tsx` renders `<main id="sunny-main-content">`.
    const mainContent = page.locator('#sunny-main-content');
    await expect(mainContent).toBeVisible();

    // Keyboard-only affordance — the audit fixed label associations + the
    // SecurityLiveStrip button; this verifies the global skip-link is
    // still in the DOM so Tab-only users can reach the HUD.
    const skipLink = page.locator('.skip-link');
    await expect(skipLink).toBeAttached();

    // Zero uncaught exceptions during boot is a contract worth anchoring
    // — the `start*` crash isolation in App.tsx catches service failures,
    // but a synchronous render error would still surface here.
    expect(errors, 'uncaught exceptions during mount').toEqual([]);
  });

  test('presents the nav strip with at least one reachable module', async ({
    page,
  }) => {
    await page.goto('/');

    // Nav modules render with `role="button"` on their rows; the exact
    // count drifts as new modules are added, so we assert lower-bound
    // presence instead of equality. Ensures the nav didn't collapse to
    // zero during a refactor.
    const navButtons = page.locator('[role="button"]');
    await expect(navButtons.first()).toBeVisible();
    expect(await navButtons.count()).toBeGreaterThan(0);
  });
});
