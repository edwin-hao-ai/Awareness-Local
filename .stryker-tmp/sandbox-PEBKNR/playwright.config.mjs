// @ts-nocheck
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.AWARENESS_E2E_PORT || '37911';
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: BASE,
    headless: true,
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `node bin/awareness-local.mjs --foreground --port ${PORT}`,
    url: `${BASE}/healthz`,
    timeout: 90_000,
    reuseExistingServer: !process.env.CI,
  },
});
