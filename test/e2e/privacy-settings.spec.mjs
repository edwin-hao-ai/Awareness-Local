import { test, expect } from '@playwright/test';
import { freshSession } from './_helpers.mjs';

async function stubTelemetry(page, { enabled = false, recent = [] } = {}) {
  await page.route('**/api/v1/telemetry/status', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ enabled, installation_id: 'a'.repeat(64) }),
    }),
  );
  await page.route('**/api/v1/telemetry/recent', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ events: recent, installation_id: 'a'.repeat(64) }),
    }),
  );
  await page.route('**/api/v1/telemetry/enable', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true}' }),
  );
  await page.route('**/api/v1/telemetry/data', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
}

async function openSettings(page) {
  // Skip onboarding so the dashboard is visible.
  await page.locator('#awareness-onboarding button[data-action="skip-all"]').first().click({ timeout: 5_000 }).catch(() => {});
  // Click the Settings top tab.
  await page.locator('button.top-tab[data-tab="settings"]').click();
}

test('Privacy section appears in Settings panel and shows installation ID', async ({ page }) => {
  await stubTelemetry(page, { enabled: false });
  await freshSession(page);
  await page.goto('/');
  await openSettings(page);

  const section = page.locator('#awareness-privacy-section');
  await expect(section).toBeVisible({ timeout: 6_000 });
  await expect(section).toContainText(/Usage Analytics|使用统计|匿名/);
  // Installation ID first 16 chars rendered (we stubbed all-a hash)
  await expect(section.locator('code')).toContainText('aaaaaaaaaaaaaaaa');
});

test('Toggling Privacy switch posts to /telemetry/enable', async ({ page }) => {
  await stubTelemetry(page, { enabled: false });
  await freshSession(page);

  let enableBody = null;
  await page.route('**/api/v1/telemetry/enable', async (route) => {
    enableBody = await route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true}' });
  });

  await page.goto('/');
  await openSettings(page);
  await page.locator('#awareness-privacy-toggle').check();
  // Wait for the request to flush
  await page.waitForTimeout(500);
  expect(enableBody).toEqual({ enabled: true });
});

test('"View recent events" expands the events pane', async ({ page }) => {
  await stubTelemetry(page, {
    enabled: true,
    recent: [
      { event_type: 'daemon_started', timestamp: '2026-04-15T00:00:00Z', properties: { os: 'darwin' } },
    ],
  });
  await freshSession(page);
  await page.goto('/');
  await openSettings(page);

  const pane = page.locator('#awareness-privacy-events');
  await expect(pane).toBeHidden();
  await page.locator('#awareness-privacy-view').click();
  await expect(pane).toBeVisible();
  await expect(pane).toContainText('daemon_started');
});
