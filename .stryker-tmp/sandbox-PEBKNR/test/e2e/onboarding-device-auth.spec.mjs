// @ts-nocheck
import { test, expect } from '@playwright/test';
import { freshSession, stubDeviceAuth } from './_helpers.mjs';

test('Step 5 device-auth flow displays user_code and confirms via mocked API', async ({ page }) => {
  await freshSession(page);
  await stubDeviceAuth(page);
  // Delay the poll by 1.5s so the renderAuthPending UI is inspectable before
  // memory-select takes over. Overrides the generic helper's immediate
  // response. Placed BEFORE the page.goto so it wins route resolution.
  await page.route('**/api/v1/cloud/auth/poll', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ api_key: 'testkey-abc' }),
    });
  });
  await page.goto('/');
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });

  // Jump straight to Step 5
  await page.evaluate(() => {
    localStorage.setItem('awareness_onboarding_step', '5');
  });
  await page.evaluate(() => window.AwarenessOnboarding?.launch?.());

  await expect(overlay.locator('.onb-modal')).toContainText(/Want to unlock more/);
  await overlay.locator('button[data-action="connect"]').click();

  // Snapshot both at once — the pending UI lasts only one poll tick before
  // memory-select takes over. Using toPass avoids flakiness under load.
  const snapshot = await expect.poll(async () => {
    return page.evaluate(() => {
      const code = document.querySelector('.onb-code-display')?.textContent?.trim() || null;
      const href = document.querySelector('a.onb-link')?.getAttribute('href') || null;
      return { code, href };
    });
  }, { timeout: 5_000 }).toMatchObject({
    code: 'TEST-1234',
    href: expect.stringMatching(/^https:\/\/awareness\.market\/auth\/device\?code=TEST-1234$/),
  });

  // Memory selection appears after poll resolves
  await expect(overlay.locator('.onb-memory-option')).toContainText('My Personal Memory', {
    timeout: 8_000,
  });

  await overlay.locator('button[data-action="confirm"]').click();

  // Step 6 Done with cloud check shown
  await expect(overlay.locator('.onb-modal')).toContainText(/all set/i);
});

test('javascript: in verification_uri is defanged (XSS regression)', async ({ page }) => {
  // Drive the renderAuthPending function directly in the browser to avoid
  // polling-flow timing flakiness. We're testing the protocol filter, not the wiring.
  await freshSession(page);
  await page.goto('/');
  // Wait for onboarding modules to load.
  await page.waitForFunction(() => !!window.AwarenessOnboardingSteps?.renderAuthPending, null, {
    timeout: 8_000,
  });

  const href = await page.evaluate(() => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    window.AwarenessOnboardingSteps.renderAuthPending(root, {
      user_code: 'XXXX',
      verification_uri: 'javascript:alert(1)',
      onCancel() {},
      onReopen() {},
    });
    const a = root.querySelector('a.onb-link');
    return a ? a.getAttribute('href') : null;
  });

  expect(href).toBeTruthy();
  expect(href.startsWith('javascript:')).toBe(false);
  expect(href).toMatch(/^about:blank/);
});

test('Step 5 shows retry UI on 502 auth-start and does not open an undefined verification URL', async ({ page }) => {
  await freshSession(page);

  let openBrowserCalls = 0;
  await page.route('**/api/v1/cloud/auth/start', async (route) => {
    await route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<html><body>502 Bad Gateway</body></html>',
    });
  });
  await page.route('**/api/v1/cloud/auth/open-browser', async (route) => {
    openBrowserCalls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('/');
  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });

  await page.evaluate(() => {
    localStorage.setItem('awareness_onboarding_step', '5');
  });
  await page.evaluate(() => window.AwarenessOnboarding?.launch?.());

  await overlay.locator('button[data-action="connect"]').click();

  await expect(overlay.locator('.onb-modal')).toContainText(/authorization failed|retry/i, {
    timeout: 5_000,
  });
  await expect(overlay.locator('[data-retry]')).toBeVisible();
  await expect(overlay.locator('a.onb-link')).toHaveCount(0);
  expect(openBrowserCalls).toBe(0);
});

test('Sync panel device-auth uses verification_url safely and defangs javascript URLs', async ({ page }) => {
  await freshSession(page);

  let openBrowserPayload = null;
  await page.route('**/api/v1/sync/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cloud_enabled: false, history: [] }),
    });
  });
  await page.route('**/api/v1/sync/recent', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/v1/cloud/auth/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user_code: 'SYNC-1234',
        verification_uri: 'javascript:alert(1)',
        device_code: 'sync-dev',
        interval: 30,
      }),
    });
  });
  await page.route('**/api/v1/cloud/auth/open-browser', async (route) => {
    openBrowserPayload = await route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/v1/cloud/auth/poll', async (route) => {
    await route.fulfill({ status: 408, contentType: 'application/json', body: '{"status":"pending"}' });
  });

  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('awareness_onboarding_completed_at', new Date().toISOString());
  });
  await page.reload();

  await page.locator('button.top-tab[data-tab="sync"]').click();
  await page.locator('.sync-status-box button.btn').click();
  await page.getByText('Start Connection', { exact: true }).click();

  await expect(page.locator('#auth-link')).toHaveAttribute('href', /^about:blank/);
  expect(openBrowserPayload).toEqual({ url: 'about:blank' });
});
