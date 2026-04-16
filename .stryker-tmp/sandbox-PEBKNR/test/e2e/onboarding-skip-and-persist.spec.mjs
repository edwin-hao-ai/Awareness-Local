// @ts-nocheck
import { test, expect } from '@playwright/test';
import { freshSession } from './_helpers.mjs';

test('skip-all from Welcome marks completion immediately', async ({ page }) => {
  await freshSession(page);
  await page.goto('/');
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });

  // Welcome has TWO skip-all buttons (header + bottom). Click the visible one.
  await overlay.locator('button[data-action="skip-all"]').first().click();
  await expect(overlay).toHaveCount(0);

  const completed = await page.evaluate(() =>
    localStorage.getItem('awareness_onboarding_completed_at'),
  );
  expect(completed).toBeTruthy();
});

test('after completion, reload does not re-open onboarding', async ({ page }) => {
  await freshSession(page);
  await page.goto('/');
  await page.locator('#awareness-onboarding button[data-action="skip-all"]').first().click();
  await expect(page.locator('#awareness-onboarding')).toHaveCount(0);

  // Reload — should NOT re-launch
  await page.reload();
  await page.waitForLoadState('load');
  // Wait briefly to give onboarding a chance to mistakenly mount
  await page.waitForTimeout(800);
  await expect(page.locator('#awareness-onboarding')).toHaveCount(0);
});

test('AwarenessOnboarding.reset() re-launches the flow', async ({ page }) => {
  await freshSession(page);
  await page.goto('/');
  await page.locator('#awareness-onboarding button[data-action="skip-all"]').first().click();
  await expect(page.locator('#awareness-onboarding')).toHaveCount(0);

  await page.evaluate(() => window.AwarenessOnboarding?.reset?.());
  await expect(page.locator('#awareness-onboarding')).toBeVisible({ timeout: 4_000 });
});
