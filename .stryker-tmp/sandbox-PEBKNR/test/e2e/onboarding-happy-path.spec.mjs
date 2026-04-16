// @ts-nocheck
import { test, expect } from '@playwright/test';
import { freshSession, stubDeviceAuth } from './_helpers.mjs';

test('onboarding auto-launches on first visit and shows Welcome step', async ({ page }) => {
  await freshSession(page);
  await page.goto('/');
  // Onboarding overlay appears
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });
  await expect(overlay.locator('.onb-modal')).toContainText(/Welcome to Awareness/i);
  await expect(overlay.locator('button[data-action="next"]')).toBeVisible();
});

test('walking through all six steps marks onboarding complete', async ({ page }) => {
  await freshSession(page);
  await stubDeviceAuth(page);
  await page.goto('/');
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });

  // Step 1 → Step 2
  await overlay.locator('button[data-action="next"]').first().click();
  await expect(overlay.locator('.onb-modal')).toContainText(/Step 2/i);

  // Step 2: skip the actual scan to avoid waiting on the indexer
  await overlay.locator('button[data-action="skip-step"]').first().click();
  await expect(overlay.locator('.onb-modal')).toContainText(/Step 3/i);

  // Step 3 → Step 4 (skip suggestions, just advance)
  await overlay.locator('button[data-action="next"]').first().click();
  await expect(overlay.locator('.onb-modal')).toContainText(/Step 4/i);

  // Step 4 → Step 5
  await overlay.locator('button[data-action="next"]').first().click();
  await expect(overlay.locator('.onb-modal')).toContainText(/Step 5/i);

  // Step 5: choose "Maybe later" to avoid the device-auth dance in this happy path test
  await overlay.locator('button[data-action="later"]').click();

  // Step 6: Done
  await expect(overlay.locator('.onb-modal')).toContainText(/all set/i);
  await overlay.locator('button[data-action="finish"]').click();
  await expect(overlay).toHaveCount(0);

  const completed = await page.evaluate(() =>
    localStorage.getItem('awareness_onboarding_completed_at'),
  );
  expect(completed).toBeTruthy();
});
