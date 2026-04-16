// @ts-nocheck
import { test, expect } from '@playwright/test';
import { freshSession, stubDeviceAuth } from './_helpers.mjs';

/**
 * Deep click-path coverage for F-040 onboarding.
 *
 * Every step has at least two buttons (next/skip-step + primary action).
 * Regressions in this suite = "a button renders but does nothing".
 * Primary regression guarded here: Step 5 header "skip, finish" button
 * that was orphaned (rendered with no click wiring) until fixed in this PR.
 */

async function gotoStep(page, step) {
  await freshSession(page);
  // Seed onboarding state to land directly on the desired step.
  await page.evaluate((s) => {
    localStorage.setItem('awareness_onboarding_step', String(s));
  }, step);
  await page.goto('/');
  await expect(page.locator('#awareness-onboarding')).toBeVisible({ timeout: 8_000 });
}

async function stubRecallEndpoints(page) {
  await page.route('**/api/v1/stats', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalMemories: 100, totalKnowledge: 25 }) }));
  await page.route('**/api/v1/scan/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'idle', total_files: 50, total_symbols: 500, total_wiki: 3, has_readme: true, has_docs: true, top_language: 'Python' }) }));
  await page.route('**/api/v1/scan/trigger', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"started"}' }));
  await page.route('**/api/v1/scan/files**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{ title: 'dedup', relativePath: 'docs/dedup.md' }], total: 1 }) }));
  await page.route('**/api/v1/knowledge**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'k1', category: 'decision', title: 'Why RRF fusion', tags: '["search","ranking"]' }] }) }));
  await page.route('**/api/v1/search**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 8, items: [{ id: 'k1', type: 'decision', title: 'Dedup architecture', summary: 'Two-stage verification with cheap phase 1.', score: 0.92, created_at: new Date().toISOString() }] }) }));
  await page.route('**/api/v1/telemetry/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

test.describe('F-040 button wiring — every clickable element on every step', () => {
  test.beforeEach(async ({ page }) => {
    await stubRecallEndpoints(page);
  });

  test('Step 1 Welcome: Next button advances to Step 2', async ({ page }) => {
    await gotoStep(page, 1);
    await page.click('button[data-action="next"]');
    await expect(page.locator('.onb-header')).toContainText(/Step 2/i);
  });

  test('Step 1 Welcome: bottom "skip setup" completes onboarding', async ({ page }) => {
    await gotoStep(page, 1);
    await page.locator('button[data-action="skip-all"]').first().click();
    await expect(page.locator('#awareness-onboarding')).toHaveCount(0);
    const completed = await page.evaluate(() =>
      localStorage.getItem('awareness_onboarding_completed_at'));
    expect(completed).not.toBeNull();
  });

  test('Step 2 Scan: skip-step button advances to Step 3', async ({ page }) => {
    await gotoStep(page, 2);
    await page.click('.onb-header button[data-action="skip-step"]');
    await expect(page.locator('.onb-header')).toContainText(/Step 3/i);
  });

  test('Step 3 Recall: clicking a suggestion populates the result box with formatted cards', async ({ page }) => {
    await gotoStep(page, 3);
    // Wait for at least one suggestion button (comes from getSuggestions())
    await expect(page.locator('.onb-suggestion').first()).toBeVisible({ timeout: 5_000 });
    await page.locator('.onb-suggestion').first().click();
    await expect(page.locator('#onb-recall-results .onb-result').first())
      .toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#onb-recall-results .onb-result').first())
      .toContainText('Dedup architecture');
    // Stats bar renders
    await expect(page.locator('.onb-recall-stats')).toBeVisible();
  });

  test('Step 3 Recall: skip-step goes to Step 4', async ({ page }) => {
    await gotoStep(page, 3);
    await page.locator('[data-action="skip-step"]').first().click();
    await expect(page.locator('.onb-header')).toContainText(/Step 4/i);
  });

  test('Step 3 Recall: Next button goes to Step 4', async ({ page }) => {
    await gotoStep(page, 3);
    await page.locator('button[data-action="next"]').click();
    await expect(page.locator('.onb-header')).toContainText(/Step 4/i);
  });

  test('Step 4 Wiki: Next button goes to Step 5 (Cloud)', async ({ page }) => {
    await gotoStep(page, 4);
    await page.locator('button[data-action="next"]').click();
    await expect(page.locator('.onb-header')).toContainText(/Step 5/i);
  });

  test('Step 5 Cloud: header "skip, finish" button works (regression for F-040 bug)', async ({ page }) => {
    await gotoStep(page, 5);
    // The header right-side button is the one that was orphaned.
    await page.locator('.onb-header button[data-action="skip-all"]').click();
    // It should advance to Step 6 (Done) and be wired to onLater.
    await expect(page.locator('.onb-modal')).toContainText(/🎉/i, { timeout: 5_000 });
  });

  test('Step 5 Cloud: "Later" button goes to Step 6', async ({ page }) => {
    await gotoStep(page, 5);
    await page.locator('button[data-action="later"]').click();
    await expect(page.locator('.onb-modal')).toContainText(/🎉/i, { timeout: 5_000 });
  });

  test('Step 5 Cloud: "Connect" button opens device-auth flow', async ({ page }) => {
    // Delay poll so the pending UI with the user_code renders before
    // the mock grants an api_key and skips straight to memory-select.
    await page.route('**/api/v1/cloud/auth/start', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        device_code: 'devcode-test', user_code: 'TEST-1234',
        verification_uri: 'https://awareness.market/cli-auth', interval: 1,
      }) }));
    await page.route('**/api/v1/cloud/auth/poll', async (r) => {
      await new Promise((res) => setTimeout(res, 2000));
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending"}' });
    });
    await page.route('**/api/v1/cloud/auth/open-browser', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    await gotoStep(page, 5);
    await page.locator('button[data-action="connect"]').click();
    await expect(page.locator('.onb-code-display')).toContainText('TEST-1234', { timeout: 5_000 });
  });

  test('Step 6 Done: finish button closes the overlay', async ({ page }) => {
    await gotoStep(page, 6);
    await page.locator('button[data-action="finish"]').click();
    await expect(page.locator('#awareness-onboarding')).toHaveCount(0);
  });
});
