/**
 * User Journey — first-time-visit
 *
 * Acceptance: docs/features/onboarding-and-telemetry/ACCEPTANCE.md · Journey 1
 *
 * Walks a brand-new user landing on the dashboard for the first time.
 * Asserts the onboarding overlay appears, Welcome content is visible,
 * and the telemetry opt-in checkbox is pre-checked (default-on policy).
 *
 * Zero mocks — the daemon and its JS modules handle the real render.
 */

import { test, expect } from '@playwright/test';

test('first-time-visit: onboarding auto-launches with default-on telemetry checkbox', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon must be running on 37911');

  // Wipe prior state so this really is "first visit".
  await page.goto('http://127.0.0.1:37911/');
  await page.evaluate(() => {
    try {
      localStorage.removeItem('awareness_onboarding_completed_at');
      localStorage.removeItem('awareness_onboarding_step');
      localStorage.removeItem('awareness_onboarding_skipped_steps');
    } catch {}
  });
  await page.reload();

  // Overlay mounted
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });

  // Welcome copy (step 1 of 6)
  await expect(overlay.locator('.onb-header')).toContainText(/1.*6|Step 1/i);

  // Telemetry opt-in checkbox exists and is checked (default-on policy).
  const optIn = overlay.locator('#onb-telemetry-opt');
  await expect(optIn).toBeVisible();
  await expect(optIn).toBeChecked();

  // CTA present + wired (clicking advances to step 2 or farther; we
  // don't drive the whole flow here — that's a different journey).
  const nextBtn = overlay.locator('button[data-action="next"]');
  await expect(nextBtn).toBeVisible();
});
