/* Shared helpers for onboarding E2E specs. */

/** Reset onboarding localStorage state and force a locale before navigating. */
export async function freshSession(page, { locale = 'en' } = {}) {
  // Visit a benign URL first so localStorage is available for the origin.
  await page.goto('/healthz', { waitUntil: 'load' });
  await page.evaluate((loc) => {
    try {
      localStorage.removeItem('awareness_onboarding_completed_at');
      localStorage.removeItem('awareness_onboarding_step');
      localStorage.removeItem('awareness_onboarding_skipped_steps');
      localStorage.setItem('awareness_locale', loc);
    } catch {}
  }, locale);
}

/** Stub the device-auth REST endpoints so Step 5 can complete without a real cloud. */
export async function stubDeviceAuth(page) {
  await page.route('**/api/v1/cloud/auth/start', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        device_code: 'devcode-test',
        user_code: 'TEST-1234',
        verification_uri: 'https://awareness.market/auth/device',
        interval: 1,
      }),
    }),
  );
  // The daemon's /cloud/auth/poll is a long-poll — the client treats the
  // response as terminal, so we return an api_key immediately. Tests that
  // need to observe the pending UI should snapshot BEFORE awaiting any
  // downstream locator (see onboarding-device-auth.spec.mjs).
  await page.route('**/api/v1/cloud/auth/poll', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ api_key: 'testkey-abc' }),
    }),
  );
  await page.route('**/api/v1/cloud/memories**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', name: 'My Personal Memory' }]),
    }),
  );
  await page.route('**/api/v1/cloud/connect', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await page.route('**/api/v1/cloud/auth/open-browser', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
}
