// @ts-nocheck
import { test, expect } from '@playwright/test';
import { freshSession } from './_helpers.mjs';

test('zh locale shows Chinese onboarding copy', async ({ page }) => {
  await freshSession(page, { locale: 'zh' });
  await page.goto('/');
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });
  // Welcome title in Chinese
  await expect(overlay.locator('.onb-modal')).toContainText('欢迎使用 Awareness');
  // Step indicator in Chinese
  await expect(overlay.locator('.onb-modal')).toContainText(/第 1 步/);
});

test('en locale shows English onboarding copy', async ({ page }) => {
  await freshSession(page, { locale: 'en' });
  await page.goto('/');
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });
  await expect(overlay.locator('.onb-modal')).toContainText(/Welcome to Awareness/);
  await expect(overlay.locator('.onb-modal')).toContainText(/Step 1 of/);
});
