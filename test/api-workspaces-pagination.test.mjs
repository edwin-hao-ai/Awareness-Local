/**
 * P1 fix · `/api/v1/workspaces` pagination + filter
 *
 * Context: AwarenessClaw Memory tab was fetching the full workspace map on
 * every page load, which on real users accumulates to 2500+ entries / 450KB.
 * We now support `?limit=` + `?q=` query params, while keeping the legacy
 * map shape when neither is passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// The apiWorkspaces handler reads `~/.awareness/workspaces.json` via
// loadWorkspaces(). We can't easily redirect HOME, so we write into the real
// file (under a distinctive prefix) and clean up afterward.

const wsFile = path.join(os.homedir(), '.awareness', 'workspaces.json');

function backupWorkspaces() {
  if (!fs.existsSync(wsFile)) return null;
  return fs.readFileSync(wsFile, 'utf-8');
}
function restoreWorkspaces(snapshot) {
  if (snapshot == null) {
    try { fs.unlinkSync(wsFile); } catch { /* ok */ }
    return;
  }
  fs.writeFileSync(wsFile, snapshot, 'utf-8');
}

class MockRes {
  constructor() {
    this.status = null;
    this.headers = null;
    this.body = null;
  }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  end(body) { this.body = body; return this; }
}

test('P1 · apiWorkspaces returns legacy map shape when no query params', async () => {
  const { apiWorkspaces } = await import('../src/daemon/api-handlers.mjs');
  const snapshot = backupWorkspaces();
  try {
    fs.mkdirSync(path.dirname(wsFile), { recursive: true });
    fs.writeFileSync(wsFile, JSON.stringify({
      '/tmp/p1-ws-a': { memoryId: 'a', port: 37801, name: 'A', lastUsed: '2026-04-19T00:00:00Z' },
      '/tmp/p1-ws-b': { memoryId: 'b', port: 37802, name: 'B', lastUsed: '2026-04-18T00:00:00Z' },
    }));
    const res = new MockRes();
    await apiWorkspaces(res, new URL('http://localhost/api/v1/workspaces'));
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    // Legacy map shape: keys are paths
    assert.ok(parsed['/tmp/p1-ws-a'], 'expected legacy map keyed by path');
    assert.ok(parsed['/tmp/p1-ws-b']);
    assert.equal(parsed['/tmp/p1-ws-a'].name, 'A');
  } finally {
    restoreWorkspaces(snapshot);
  }
});

test('P1 · apiWorkspaces with ?limit= returns paginated array sorted by lastUsed desc', async () => {
  const { apiWorkspaces } = await import('../src/daemon/api-handlers.mjs');
  const snapshot = backupWorkspaces();
  try {
    const entries = {};
    for (let i = 0; i < 10; i++) {
      entries[`/tmp/p1-page-${i}`] = {
        memoryId: `m${i}`, port: 37800 + i, name: `W${i}`,
        lastUsed: `2026-04-${10 + i}T00:00:00Z`,
      };
    }
    fs.writeFileSync(wsFile, JSON.stringify(entries));

    const res = new MockRes();
    await apiWorkspaces(res, new URL('http://localhost/api/v1/workspaces?limit=3'));
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.workspaces.length, 3, 'should return 3 most-recent');
    assert.equal(parsed.total, 10, 'total should reflect full filtered count');
    // lastUsed desc → 2026-04-19 first (i=9)
    assert.equal(parsed.workspaces[0].path, '/tmp/p1-page-9');
    assert.equal(parsed.workspaces[0].name, 'W9');
    // Entries include path flattened in
    assert.equal(typeof parsed.workspaces[0].memoryId, 'string');
  } finally {
    restoreWorkspaces(snapshot);
  }
});

test('P1 · apiWorkspaces with ?q= filters by path substring', async () => {
  const { apiWorkspaces } = await import('../src/daemon/api-handlers.mjs');
  const snapshot = backupWorkspaces();
  try {
    fs.writeFileSync(wsFile, JSON.stringify({
      '/tmp/p1-alpha': { memoryId: 'a', port: 37801, lastUsed: '2026-04-19T00:00:00Z' },
      '/tmp/p1-beta':  { memoryId: 'b', port: 37802, lastUsed: '2026-04-18T00:00:00Z' },
      '/tmp/p1-gamma': { memoryId: 'c', port: 37803, lastUsed: '2026-04-17T00:00:00Z' },
    }));

    const res = new MockRes();
    await apiWorkspaces(res, new URL('http://localhost/api/v1/workspaces?q=beta'));
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.workspaces.length, 1);
    assert.equal(parsed.workspaces[0].path, '/tmp/p1-beta');
    assert.equal(parsed.total, 1);
  } finally {
    restoreWorkspaces(snapshot);
  }
});

test('P1 · apiWorkspaces caps limit at 500 to prevent DoS', async () => {
  const { apiWorkspaces } = await import('../src/daemon/api-handlers.mjs');
  const snapshot = backupWorkspaces();
  try {
    const entries = {};
    for (let i = 0; i < 5; i++) entries[`/tmp/p1-cap-${i}`] = { lastUsed: `2026-04-${10 + i}T00:00:00Z` };
    fs.writeFileSync(wsFile, JSON.stringify(entries));
    const res = new MockRes();
    await apiWorkspaces(res, new URL('http://localhost/api/v1/workspaces?limit=999999'));
    const parsed = JSON.parse(res.body);
    // With 5 total and cap 500 → return all 5
    assert.equal(parsed.workspaces.length, 5);
    assert.equal(parsed.total, 5);
  } finally {
    restoreWorkspaces(snapshot);
  }
});
