/**
 * User Journey — switch-workspace
 *
 * Acceptance: docs/features/onboarding-and-telemetry/ACCEPTANCE.md · Journey 2
 *
 * Asserts a regression we shipped three times: clicking the sidebar
 * workspace picker used to jump to http://localhost:37802/ (a stale port
 * from ~/.awareness/workspaces.json). The fix is a single-daemon policy
 * that POSTs /workspace/switch to the CURRENT daemon.
 *
 * Zero mocks — the real daemon handles the real switch. If you feel
 * tempted to page.route(), stop and move the test out of user-journeys/.
 */
// @ts-nocheck


import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkTempProject(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aw-journey-${seed}-`));
  fs.mkdirSync(path.join(dir, '.awareness'), { recursive: true });
  // Drop a sentinel file so the user can tell which dir is active.
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${seed}\n`, 'utf-8');
  return dir;
}

test('switch-workspace: picking a different project keeps the same port and updates the header', async ({ page, request }) => {
  // Ensure the daemon is the one spawned by playwright.config.mjs (port 37911).
  // If not available, skip — we never fabricate a response.
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon not running on 37911 — playwright webServer should have started it');

  const dirB = mkTempProject('projectB');
  // Seed the workspaces registry with both the current project and B so
  // the picker actually offers a second option. We intentionally set B's
  // port to a STALE value (37802) to prove the UI no longer navigates
  // there on switch — this is the exact bug we are guarding against.
  const wsFile = path.join(os.homedir(), '.awareness', 'workspaces.json');
  const existing = fs.existsSync(wsFile) ? JSON.parse(fs.readFileSync(wsFile, 'utf-8')) : {};
  const updated = {
    ...existing,
    [dirB]: {
      memoryId: '',
      port: 37802, // DELIBERATELY stale — used to cause navigation to die.
      name: 'projectB',
      lastUsed: new Date().toISOString(),
    },
  };
  fs.writeFileSync(wsFile, JSON.stringify(updated, null, 2), 'utf-8');

  await page.goto('http://127.0.0.1:37911/');
  await expect(page).toHaveURL(/127\.0\.0\.1:37911/);

  // Dismiss onboarding if it auto-opens — we care about the dashboard chrome.
  await page.evaluate(() => {
    try {
      localStorage.setItem('awareness_onboarding_completed_at', new Date().toISOString());
    } catch {}
  });
  await page.reload();

  // Open the workspace picker by invoking switchWorkspace() directly.
  // We exercise the actual JS function the onClick handler invokes — no
  // mocks, the /workspace/switch POST hits the real daemon.
  await page.waitForFunction(() => typeof window.switchWorkspace === 'function', null, { timeout: 5_000 });

  await page.evaluate((dir) => window.switchWorkspace(dir, 37802), dirB);

  // Critical: URL must NOT change to 37802. That was the old buggy path.
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/127\.0\.0\.1:37911/, {
    timeout: 3_000,
  });
  expect(page.url()).not.toContain('37802');

  // Header should reflect the new project name within a few seconds.
  await expect(page.locator('#project-name-header')).toContainText('projectB', { timeout: 8_000 });

  // Daemon healthz should confirm the switch persisted.
  const healthAfter = await request.get('http://127.0.0.1:37911/healthz');
  const hj = await healthAfter.json();
  expect(hj.project_dir).toContain('projectB');

  // Cleanup: restore workspaces registry to avoid polluting other tests.
  fs.writeFileSync(wsFile, JSON.stringify(existing, null, 2), 'utf-8');
  fs.rmSync(dirB, { recursive: true, force: true });
});
