import { test, expect } from '@playwright/test';
import { freshSession, stubDeviceAuth } from './_helpers.mjs';

test('Step 5 device-auth flow displays user_code and confirms via mocked API', async ({ page }) => {
  await freshSession(page);
  await stubDeviceAuth(page);
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

  // user_code shown
  await expect(overlay.locator('.onb-code-display')).toContainText('TEST-1234');
  // Verification link uses our stubbed verification_uri (must be https — our XSS guard)
  const href = await overlay.locator('a.onb-link').getAttribute('href');
  expect(href).toMatch(/^https:\/\/awareness\.market\/auth\/device\?code=TEST-1234$/);

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
