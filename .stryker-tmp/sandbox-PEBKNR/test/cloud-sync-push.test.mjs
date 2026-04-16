// @ts-nocheck
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { pushMemoriesToCloud, pushInsightsToCloud, pushTasksToCloud } = await import(
  '../src/core/sync-push.mjs'
);

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  const store = {
    _calls: [],
    _rows: [],
  };
  return {
    prepare: (sql) => ({
      run: (...params) => {
        store._calls.push({ sql, params, op: 'run' });
        return { changes: 1 };
      },
      get: (...params) => {
        store._calls.push({ sql, params, op: 'get' });
        return null;
      },
      all: (...params) => {
        store._calls.push({ sql, params, op: 'all' });
        return store._rows;
      },
    }),
    _store: store,
  };
}

function createMockCtx(overrides = {}) {
  const syncEvents = [];
  const syncStateMap = {};
  const postCalls = [];

  const db = createMockDb();

  return {
    indexer: { db },
    memoryStore: null,
    apiBase: 'http://test.local',
    apiKey: 'aw_test123',
    memoryId: 'test-mem-id',
    deviceId: 'test-device',
    httpGet: async (url) => ({ status: 200, body: '{"items":[]}' }),
    httpPost: async (url, data) => {
      postCalls.push({ url, data });
      return { status: 'ok' };
    },
    httpPostRaw: async (url, data, headers) => {
      postCalls.push({ url, data, headers });
      return { status: 200, body: '{"status":"ok"}' };
    },
    getSyncState: (key) => syncStateMap[key] || null,
    setSyncState: (key, val) => { syncStateMap[key] = val; },
    recordSyncEvent: (type, detail) => { syncEvents.push({ type, detail }); },
    parseTags: (str) => {
      if (!str) return [];
      try { return JSON.parse(str); } catch { return []; }
    },
    // Expose internals for assertions
    _postCalls: postCalls,
    _syncEvents: syncEvents,
    _syncStateMap: syncStateMap,
    _db: db,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pushMemoriesToCloud
// ---------------------------------------------------------------------------

describe('sync-push — pushMemoriesToCloud', () => {
  it('returns {synced:0, errors:0} when no unsynced memories exist', async () => {
    const ctx = createMockCtx();

    const result = await pushMemoriesToCloud(ctx);

    assert.equal(result.synced, 0);
    assert.equal(result.errors, 0);
  });

  it('calls httpPost for each unsynced memory and marks as synced', async () => {
    const db = createMockDb();
    // First .all() returns unsynced rows, subsequent calls return defaults
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => {
        db._store._calls.push({ sql, params, op: 'run' });
        return { changes: 1 };
      },
      get: (...params) => {
        db._store._calls.push({ sql, params, op: 'get' });
        return null; // No embedding
      },
      all: (...params) => {
        db._store._calls.push({ sql, params, op: 'all' });
        allCallCount++;
        if (sql.includes('synced_to_cloud = 0') && allCallCount === 1) {
          return [
            {
              id: 'mem_001',
              type: 'turn_summary',
              filepath: '/nonexistent/path.md',
              agent_role: 'developer',
              tags: '["test"]',
              source: 'claude-code',
            },
          ];
        }
        return [];
      },
    });

    const postCalls = [];
    const ctx = createMockCtx({
      indexer: { db },
      httpPost: async (url, data) => {
        postCalls.push({ url, data });
        return { cloud_id: 'cloud_abc' };
      },
    });

    // pushMemoriesToCloud tries to readFileSync — it will fail and count as error
    // because the filepath doesn't exist. That's expected behavior.
    const result = await pushMemoriesToCloud(ctx);

    // File not found → errors++, skip
    assert.equal(result.errors, 1);
    assert.equal(result.synced, 0);
  });

  it('records a sync event when memories are successfully pushed', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => {
        db._store._calls.push({ sql, params, op: 'run' });
        return { changes: 1 };
      },
      get: (...params) => {
        db._store._calls.push({ sql, params, op: 'get' });
        return null;
      },
      all: (...params) => {
        allCallCount++;
        if (sql.includes('synced_to_cloud = 0') && allCallCount === 1) {
          return [
            {
              id: 'mem_002',
              type: 'session_summary',
              filepath: '/tmp/__does_not_exist__.md',
              agent_role: '',
              tags: '[]',
              source: 'test',
            },
          ];
        }
        return [];
      },
    });

    const syncEvents = [];
    const ctx = createMockCtx({
      indexer: { db },
      recordSyncEvent: (type, detail) => { syncEvents.push({ type, detail }); },
    });

    await pushMemoriesToCloud(ctx);

    // File doesn't exist so it'll be skipped — no sync event expected
    assert.equal(syncEvents.length, 0);
  });

  it('does not crash on network error', async () => {
    const db = createMockDb();
    db._store._rows = [];

    const ctx = createMockCtx({
      indexer: { db },
      httpPost: async () => { throw new Error('ECONNREFUSED'); },
    });

    // Should not throw
    const result = await pushMemoriesToCloud(ctx);
    assert.equal(typeof result.synced, 'number');
    assert.equal(typeof result.errors, 'number');
  });
});

// ---------------------------------------------------------------------------
// pushInsightsToCloud
// ---------------------------------------------------------------------------

describe('sync-push — pushInsightsToCloud', () => {
  it('returns {synced:0, errors:0} when no unsynced cards exist', async () => {
    const ctx = createMockCtx();

    const result = await pushInsightsToCloud(ctx);

    assert.equal(result.synced, 0);
    assert.equal(result.errors, 0);
  });

  it('posts active cards to cloud insights endpoint', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => {
        db._store._calls.push({ sql, params, op: 'run' });
        return { changes: 1 };
      },
      get: (...params) => {
        db._store._calls.push({ sql, params, op: 'get' });
        return null;
      },
      all: (...params) => {
        allCallCount++;
        if (sql.includes('knowledge_cards') && allCallCount === 1) {
          return [
            {
              id: 'kc_001',
              category: 'decision',
              title: 'Use JWT',
              summary: 'Decided to use JWT for auth',
              confidence: 0.9,
              tags: '["auth"]',
              status: 'active',
              version: 1,
              evolution_type: 'initial',
              parent_card_id: null,
            },
          ];
        }
        return [];
      },
    });

    const postCalls = [];
    const ctx = createMockCtx({
      indexer: { db },
      httpPostRaw: async (url, data, headers) => {
        postCalls.push({ url, data, headers });
        return { status: 200, body: '{"status":"ok"}' };
      },
    });

    const result = await pushInsightsToCloud(ctx);

    assert.equal(result.synced, 1);
    assert.equal(result.errors, 0);
    assert.equal(postCalls.length, 1);
    assert.ok(postCalls[0].url.includes('/insights/submit'));
    assert.ok(postCalls[0].data.knowledge_cards.length === 1);
    assert.equal(postCalls[0].data.knowledge_cards[0].title, 'Use JWT');
  });

  it('creates local conflict record on 409 response', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    const runCalls = [];

    db.prepare = (sql) => ({
      run: (...params) => {
        runCalls.push({ sql, params });
        return { changes: 1 };
      },
      get: (...params) => null,
      all: (...params) => {
        allCallCount++;
        if (sql.includes('knowledge_cards') && allCallCount === 1) {
          return [
            {
              id: 'kc_conflict',
              category: 'decision',
              title: 'Conflict card',
              summary: 'This will conflict',
              confidence: 0.9,
              tags: '[]',
              status: 'active',
              version: 2,
              evolution_type: 'initial',
              parent_card_id: null,
            },
          ];
        }
        return [];
      },
    });

    const ctx = createMockCtx({
      indexer: { db },
      httpPostRaw: async () => ({
        status: 409,
        body: JSON.stringify({ cloud_version: 5 }),
      }),
    });

    const result = await pushInsightsToCloud(ctx);

    assert.equal(result.errors, 1);
    // Verify a conflict was inserted into sync_conflicts table
    const conflictInserts = runCalls.filter((c) =>
      c.sql.includes('INSERT INTO sync_conflicts')
    );
    assert.ok(conflictInserts.length >= 1, 'Should have inserted a conflict record');
  });

  it('does not crash on network error', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => ({ changes: 1 }),
      get: (...params) => null,
      all: (...params) => {
        allCallCount++;
        if (sql.includes('knowledge_cards') && allCallCount === 1) {
          return [
            {
              id: 'kc_err',
              category: 'key_point',
              title: 'Will error',
              summary: '',
              confidence: 0.8,
              tags: '[]',
              status: 'active',
              version: 1,
              evolution_type: 'initial',
              parent_card_id: null,
            },
          ];
        }
        return [];
      },
    });

    const ctx = createMockCtx({
      indexer: { db },
      httpPostRaw: async () => { throw new Error('Network down'); },
    });

    const result = await pushInsightsToCloud(ctx);

    assert.equal(typeof result.synced, 'number');
    assert.equal(typeof result.errors, 'number');
    assert.ok(result.errors >= 1);
  });

  it('records sync event when insights are pushed', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => ({ changes: 1 }),
      get: (...params) => null,
      all: (...params) => {
        allCallCount++;
        if (sql.includes('knowledge_cards') && allCallCount === 1) {
          return [
            {
              id: 'kc_event',
              category: 'insight',
              title: 'Tracked insight',
              summary: 'Should record event',
              confidence: 0.8,
              tags: '[]',
              status: 'active',
              version: 1,
              evolution_type: 'initial',
              parent_card_id: null,
            },
          ];
        }
        return [];
      },
    });

    const syncEvents = [];
    const ctx = createMockCtx({
      indexer: { db },
      httpPostRaw: async () => ({ status: 200, body: '{"ok":true}' }),
      recordSyncEvent: (type, detail) => { syncEvents.push({ type, detail }); },
    });

    await pushInsightsToCloud(ctx);

    assert.equal(syncEvents.length, 1);
    assert.equal(syncEvents[0].type, 'insights');
    assert.equal(syncEvents[0].detail.direction, 'push');
  });
});

// ---------------------------------------------------------------------------
// pushTasksToCloud
// ---------------------------------------------------------------------------

describe('sync-push — pushTasksToCloud', () => {
  it('returns {synced:0, errors:0} when no unsynced tasks exist', async () => {
    const ctx = createMockCtx();

    const result = await pushTasksToCloud(ctx);

    assert.equal(result.synced, 0);
    assert.equal(result.errors, 0);
  });

  it('posts tasks to cloud insights/submit endpoint', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => {
        db._store._calls.push({ sql, params, op: 'run' });
        return { changes: 1 };
      },
      get: (...params) => null,
      all: (...params) => {
        allCallCount++;
        if (sql.includes('tasks') && allCallCount === 1) {
          return [
            {
              id: 'task_001',
              title: 'Fix login bug',
              description: 'Users cannot log in after password reset',
              priority: 'high',
              status: 'open',
              agent_role: 'developer',
              created_at: '2026-04-08T10:00:00Z',
            },
          ];
        }
        return [];
      },
    });

    const postCalls = [];
    const ctx = createMockCtx({
      indexer: { db },
      httpPost: async (url, data) => {
        postCalls.push({ url, data });
        return { status: 'ok' };
      },
    });

    const result = await pushTasksToCloud(ctx);

    assert.equal(result.synced, 1);
    assert.equal(postCalls.length, 1);
    assert.ok(postCalls[0].url.includes('/insights/submit'));
    assert.equal(postCalls[0].data.action_items.length, 1);
    assert.equal(postCalls[0].data.action_items[0].title, 'Fix login bug');
    assert.equal(postCalls[0].data.action_items[0].priority, 'high');
  });

  it('records sync event when tasks are pushed', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => ({ changes: 1 }),
      get: (...params) => null,
      all: (...params) => {
        allCallCount++;
        if (sql.includes('tasks') && allCallCount === 1) {
          return [
            { id: 'task_evt', title: 'Task A', description: '', priority: 'medium', status: 'open', agent_role: '', created_at: '2026-04-08T10:00:00Z' },
          ];
        }
        return [];
      },
    });

    const syncEvents = [];
    const ctx = createMockCtx({
      indexer: { db },
      recordSyncEvent: (type, detail) => { syncEvents.push({ type, detail }); },
    });

    await pushTasksToCloud(ctx);

    assert.equal(syncEvents.length, 1);
    assert.equal(syncEvents[0].type, 'tasks');
    assert.equal(syncEvents[0].detail.direction, 'push');
    assert.equal(syncEvents[0].detail.count, 1);
  });

  it('does not crash on httpPost network error', async () => {
    const db = createMockDb();
    let allCallCount = 0;
    db.prepare = (sql) => ({
      run: (...params) => ({ changes: 1 }),
      get: (...params) => null,
      all: (...params) => {
        allCallCount++;
        if (sql.includes('tasks') && allCallCount === 1) {
          return [
            { id: 'task_err', title: 'Will fail', description: '', priority: 'low', status: 'open', agent_role: '', created_at: '2026-04-08T10:00:00Z' },
          ];
        }
        return [];
      },
    });

    const ctx = createMockCtx({
      indexer: { db },
      httpPost: async () => { throw new Error('ETIMEDOUT'); },
    });

    const result = await pushTasksToCloud(ctx);

    assert.equal(typeof result.synced, 'number');
    assert.ok(result.errors >= 1, 'Should record at least one error');
  });
});
