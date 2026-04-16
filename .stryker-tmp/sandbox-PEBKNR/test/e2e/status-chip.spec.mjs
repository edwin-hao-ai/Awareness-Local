// @ts-nocheck
import { test, expect } from '@playwright/test';
import { freshSession } from './_helpers.mjs';

test('status chip mounts on dashboard load and shows local mode', async ({ page }) => {
  // Stub /api/v1/cloud/status to return disabled (so chip enters local mode + CTA).
  await page.route('**/api/v1/cloud/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' }),
  );
  await freshSession(page);
  await page.goto('/');
  const chip = page.locator('#awareness-status-chip');
  await expect(chip).toBeVisible({ timeout: 8_000 });
  await expect(chip).toContainText(/Local|本地/);
  // CTA visible in local mode
  const cta = chip.locator('button[data-cta]');
  await expect(cta).toBeVisible();
  await expect(cta).toContainText(/Connect|连接/);
});

test('status chip flips to cloud-synced state when /cloud/status reports enabled', async ({ page }) => {
  await page.route('**/api/v1/cloud/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true,"connected":true}' }),
  );
  await freshSession(page);
  await page.goto('/');
  const chip = page.locator('#awareness-status-chip');
  await expect(chip).toBeVisible({ timeout: 8_000 });
  await expect(chip).toContainText(/Cloud|云端/);
  // CTA hidden when cloud is on
  const cta = chip.locator('button[data-cta]');
  await expect(cta).toBeHidden();
});

test('clicking the chip CTA re-launches onboarding', async ({ page }) => {
  await page.route('**/api/v1/cloud/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":false}' }),
  );
  await freshSession(page);
  await page.goto('/');
  // Skip onboarding first so it is in completed state
  await page.locator('#awareness-onboarding button[data-action="skip-all"]').first().click();
  await expect(page.locator('#awareness-onboarding')).toHaveCount(0);

  // Now click chip CTA
  await page.locator('#awareness-status-chip button[data-cta]').click();
  // Onboarding overlay should reopen
  await expect(page.locator('#awareness-onboarding')).toBeVisible({ timeout: 4_000 });
});
