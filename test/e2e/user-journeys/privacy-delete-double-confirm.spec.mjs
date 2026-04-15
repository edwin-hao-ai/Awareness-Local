import { test, expect } from '@playwright/test';
import { freshSession } from '../_helpers.mjs';

async function openSettings(page) {
  await page.locator('#awareness-onboarding button[data-action="skip-all"]').first().click({ timeout: 5_000 }).catch(() => {});
  await page.locator('button.top-tab[data-tab="settings"]').click();
}

test('privacy-delete-double-confirm: deleting telemetry requires two confirmations and clears queued events', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon must be running on 37911');

  await request.post('http://127.0.0.1:37911/api/v1/telemetry/enable', {
    data: { enabled: true },
  });
  await request.post('http://127.0.0.1:37911/api/v1/telemetry/track', {
    data: { event_type: 'onboarding_step', properties: { step_number: 2 } },
  });

  const recentBefore = await request.get('http://127.0.0.1:37911/api/v1/telemetry/recent');
  const beforeJson = await recentBefore.json();
  expect(Array.isArray(beforeJson.events)).toBe(true);
  expect(beforeJson.events.length).toBeGreaterThan(0);

  await freshSession(page);
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.goto('http://127.0.0.1:37911/');
  await openSettings(page);

  const section = page.locator('#awareness-privacy-section');
  await expect(section).toBeVisible({ timeout: 6_000 });
  await page.locator('#awareness-privacy-delete').click();

  await expect(page.locator('#awareness-privacy-events')).toContainText(/Local queue cleared|Server-side delete requested/, {
    timeout: 5_000,
  });
  expect(dialogs.length).toBe(2);

  const recentAfter = await request.get('http://127.0.0.1:37911/api/v1/telemetry/recent');
  const afterJson = await recentAfter.json();
  expect(afterJson.events).toEqual([]);
});