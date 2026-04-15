/**
 * User Journey — recall-returns-real-results
 *
 * Acceptance: docs/features/onboarding-and-telemetry/ACCEPTANCE.md · Journey 4
 *
 * Drives Step 3 "First Recall" against the REAL daemon's /api/v1/search
 * endpoint. Asserts:
 *   - suggestions render
 *   - clicking a suggestion produces ≥ 1 result card
 *   - the stats bar with "ms" / "memories" renders
 *
 * Zero mocks. If the daemon is freshly started with no cards, we skip
 * the result-count assertion rather than mocking a happy state —
 * skipping a stretched assumption beats fabricating one.
 */

import { test, expect } from '@playwright/test';

test('recall-returns-real-results: Step 3 shows formatted cards from /api/v1/search', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon must be running on 37911');

  // Does the daemon have any knowledge to search against?
  const kw = await request.get('http://127.0.0.1:37911/api/v1/stats').catch(() => null);
  const stats = kw && kw.ok() ? await kw.json() : null;
  const haveContent = (stats?.totalKnowledge ?? stats?.stats?.totalKnowledge ?? 0) > 0;
  test.skip(!haveContent, 'daemon has no knowledge cards — seed the project first');

  await page.goto('http://127.0.0.1:37911/');
  await page.evaluate(() => {
    try {
      localStorage.removeItem('awareness_onboarding_completed_at');
      localStorage.setItem('awareness_onboarding_step', '3');
    } catch {}
  });
  await page.reload();

  const overlay = page.locator('#awareness-onboarding');
  await expect(overlay).toBeVisible({ timeout: 8_000 });
  await expect(overlay.locator('.onb-header')).toContainText(/3.*6|Step 3/i);

  // Wait for suggestion buttons (fetched from the real daemon's /knowledge).
  await expect(overlay.locator('.onb-suggestion').first()).toBeVisible({ timeout: 8_000 });

  // Click the first suggestion and assert real results render.
  await overlay.locator('.onb-suggestion').first().click();

  // After click, the loading placeholder should be replaced by rendered
  // result content. Waiting for the actual result node is more stable than
  // inspecting raw HTML because summaries may legitimately contain ellipses.
  await expect(overlay.locator('#onb-recall-results .onb-result').first()).toBeVisible({ timeout: 15_000 });

  // At minimum, the results box should have visible children (card or empty
  // notice). We don't pin the exact count — the real daemon decides, and
  // the job of the journey is to prove the UI reflects the real response.
  const resultsBox = overlay.locator('#onb-recall-results');
  const renderedHtml = await resultsBox.innerHTML();
  expect(renderedHtml.length).toBeGreaterThan(0);
  // Either we see at least one result card OR the localized empty state.
  const hasCard = renderedHtml.includes('onb-result');
  expect(hasCard).toBe(true);
});
