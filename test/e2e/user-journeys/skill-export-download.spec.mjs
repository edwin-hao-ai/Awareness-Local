/**
 * User Journey — skill-export-download
 *
 * Acceptance: docs/features/f-032-skills-export/ACCEPTANCE.md · Journey 2
 *
 * Hits the REAL daemon's `/api/v1/skills/<id>/export?format=skillmd`
 * endpoint and verifies the response is a valid SKILL.md with proper
 * frontmatter, Content-Disposition, and MIME type. Zero mocks.
 */

import { test, expect } from '@playwright/test';

test('skill-export-download: GET /skills/<id>/export returns valid SKILL.md', async ({ request }) => {
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon must be running on 37911');

  // Grab any skill id from the real daemon. If there are none, skip —
  // the feature still works; we just have nothing to export today.
  const listRes = await request.get('http://127.0.0.1:37911/api/v1/skills?limit=1');
  expect(listRes.ok()).toBeTruthy();
  const listJson = await listRes.json();
  const items = listJson.skills || listJson.items || [];
  test.skip(items.length === 0, 'daemon has no skills to export');
  const skillId = items[0].id;

  const res = await request.get(
    `http://127.0.0.1:37911/api/v1/skills/${encodeURIComponent(skillId)}/export?format=skillmd`,
  );
  expect(res.status()).toBe(200);

  // Headers the browser relies on for the real download experience.
  const ct = res.headers()['content-type'] || '';
  expect(ct).toMatch(/^text\/markdown/);
  const cd = res.headers()['content-disposition'] || '';
  expect(cd).toMatch(/attachment;\s*filename="[a-z0-9-]+\.skill\.md"/);

  // Body shape: valid frontmatter with exactly name + description.
  const body = await res.text();
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n/);
  expect(fmMatch).not.toBeNull();
  const fmKeys = fmMatch[1]
    .split('\n')
    .map((l) => l.split(':')[0].trim())
    .filter(Boolean)
    .sort();
  expect(fmKeys).toEqual(['description', 'name']);

  // Body has a heading.
  expect(body).toMatch(/\n# [^\n]+\n/);

  // Ends with a newline (POSIX-friendly).
  expect(body.endsWith('\n')).toBeTruthy();
});

test('skill-export-download: unknown id → 404 with JSON error', async ({ request }) => {
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon must be running on 37911');

  const res = await request.get(
    'http://127.0.0.1:37911/api/v1/skills/definitely-not-a-real-id/export?format=skillmd',
  );
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error).toMatch(/not found/i);
});

test('skill-export-download: unsupported format → 400', async ({ request }) => {
  const health = await request.get('http://127.0.0.1:37911/healthz').catch(() => null);
  test.skip(!health || !health.ok(), 'daemon must be running on 37911');

  const listRes = await request.get('http://127.0.0.1:37911/api/v1/skills?limit=1');
  const listJson = await listRes.json();
  const items = listJson.skills || listJson.items || [];
  const skillId = items[0]?.id || 'placeholder-id';

  const res = await request.get(
    `http://127.0.0.1:37911/api/v1/skills/${encodeURIComponent(skillId)}/export?format=pdf`,
  );
  expect(res.status()).toBe(400);
});
