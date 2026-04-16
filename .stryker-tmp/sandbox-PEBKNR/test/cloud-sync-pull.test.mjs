// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { pullCardsSince } = await import('../src/core/sync-pull.mjs');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  const store = {
    _calls: [],
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
        return [];
      },
    }),
    _store: store,
  };
}

function createMockCtx(overrides = {}) {
  const syncStateMap = {};
  const syncEvents = [];
  const getCalls = [];
  const db = createMockDb();

  return {
    indexer: { db },
    memoryStore: null,
    apiBase: 'http://test.local',
    apiKey: 'aw_test123',
    memoryId: 'test-mem-id',
    deviceId: 'test-device',
    httpGet: async (endpoint) => {
      getCalls.push(endpoint);
      return null;
    },
    getSyncState: (key) => syncStateMap[key] || null,
    setSyncState: (key, val) => { syncStateMap[key] = val; },
    recordSyncEvent: (type, detail) => { syncEvents.push({ type, detail }); },
    // Expose internals for assertions
    _getCalls: getCalls,
    _syncEvents: syncEvents,
    _syncStateMap: syncStateMap,
    _db: db,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pullCardsSince
// ---------------------------------------------------------------------------

describe('sync-pull — pullCardsSince', () => {
  it('returns {pulled:0} when httpGet returns null (offline)', async () => {
    const ctx = createMockCtx();

    const result = await pullCardsSince(ctx);

    assert.equal(result.pulled, 0);
  });

  it('returns {pulled:0} when API returns empty cards array', async () => {
    const syncStateMap = {};
    const ctx = createMockCtx({
      httpGet: async () => ({ cards: [], sync_timestamp: '2026-04-08T12:00:00Z' }),
      getSyncState: (key) => syncStateMap[key] || null,
      setSyncState: (key, val) => { syncStateMap[key] = val; },
    });

    const result = await pullCardsSince(ctx);

    assert.equal(result.pulled, 0);
  });

  it('inserts new cards from cloud into local SQLite', async () => {
    const db = createMockDb();
    const syncStateMap = {};
    const runCalls = [];

    db.prepare = (sql) => ({
      run: (...params) => {
        runCalls.push({ sql, params });
        return { changes: 1 };
      },
      get: (...params) => null,
      all: (...params) => [],
    });

    const cloudCards = [
      {
        id: 'cloud_kc_100',
        title: 'Use Redis for caching',
        summary: 'Decided to use Redis instead of Memcached',
        category: 'decision',
        confidence: 0.95,
        status: 'active',
        tags: ['cache', 'infra'],
        evolution_type: 'initial',
        metadata: { device_id: 'other-device' },
      },
    ];

    const ctx = createMockCtx({
      indexer: { db },
      httpGet: async () => ({
        cards: cloudCards,
        sync_timestamp: '2026-04-08T14:00:00Z',
      }),
      getSyncState: (key) => syncStateMap[key] || null,
      setSyncState: (key, val) => { syncStateMap[key] = val; },
    });

    const result = await pullCardsSince(ctx);

    assert.equal(result.pulled, 1);

    // Verify an INSERT was issued for knowledge_cards
    const inserts = runCalls.filter((c) => c.sql.includes('INSERT') && c.sql.includes('knowledge_cards'));
    assert.ok(inserts.length >= 1, 'Should have inserted a new knowledge card');

    // Verify the cloud <-> local mapping was stored
    assert.ok(syncStateMap['cloud_kc:cloud_kc_100'], 'Should store cloud-to-local mapping');
    const localId = syncStateMap['cloud_kc:cloud_kc_100'];
    assert.ok(syncStateMap[`local_kc_to_cloud:${localId}`], 'Should store local-to-cloud mapping');
    assert.equal(syncStateMap[`local_kc_to_cloud:${localId}`], 'cloud_kc_100');
  });

  it('updates existing card when cloud-to-local mapping exists', async () => {
    const db = createMockDb();
    const syncStateMap = { 'cloud_kc:cloud_kc_200': 'kc_local_existing' };
    const runCalls = [];

    db.prepare = (sql) => ({
      run: (...params) => {
        runCalls.push({ sql, params });
        return { changes: 1 };
      },
      get: (...params) => null,
      all: (...params) => [],
    });

    const cloudCards = [
      {
        id: 'cloud_kc_200',
        title: 'Updated title from cloud',
        summary: 'Updated summary',
        category: 'decision',
        confidence: 0.9,
        status: 'active',
        tags: ['updated'],
        metadata: { device_id: 'other-device' },
      },
    ];

    const ctx = createMockCtx({
      indexer: { db },
      httpGet: async () => ({
        cards: cloudCards,
        sync_timestamp: '2026-04-08T15:00:00Z',
      }),
      getSyncState: (key) => syncStateMap[key] || null,
      setSyncState: (key, val) => { syncStateMap[key] = val; },
    });

    const result = await pullCardsSince(ctx);

    assert.equal(result.pulled, 1);

    // Verify an UPDATE was issued (not INSERT) for the existing card
    const updates = runCalls.filter(
      (c) => c.sql.includes('UPDATE knowledge_cards') && c.sql.includes('title')
    );
    assert.ok(updates.length >= 1, 'Should have updated the existing card');

    // Check the local ID was passed as the WHERE param (last param)
    const updateCall = updates[0];
    assert.equal(updateCall.params[updateCall.params.length - 1], 'kc_local_existing');
  });

  it('passes since param to API when cards_last_pulled_at is set', async () => {
    const syncStateMap = { cards_last_pulled_at: '2026-04-07T00:00:00Z' };
    const getCalls = [];

    const ctx = createMockCtx({
      httpGet: async (endpoint) => {
        getCalls.push(endpoint);
        return { cards: [] };
      },
      getSyncState: (key) => syncStateMap[key] || null,
      setSyncState: (key, val) => { syncStateMap[key] = val; },
    });

    await pullCardsSince(ctx);

    assert.equal(getCalls.length, 1);
    assert.ok(
      getCalls[0].includes('since=2026-04-07'),
      `Expected endpoint to include since param, got: ${getCalls[0]}`
    );
  });

  it('passes device_id to API for anti-loop filtering', async () => {
    const getCalls = [];

    const ctx = createMockCtx({
      deviceId: 'my-laptop',
      httpGet: async (endpoint) => {
        getCalls.push(endpoint);
        return { cards: [] };
      },
    });

    await pullCardsSince(ctx);

    assert.equal(getCalls.length, 1);
    assert.ok(
      getCalls[0].includes('device_id=my-laptop'),
      `Expected endpoint to include device_id param, got: ${getCalls[0]}`
    );
  });

  it('skips cards pushed by the same device (anti-loop)', async () => {
    const db = createMockDb();
    const runCalls = [];
    db.prepare = (sql) => ({
      run: (...params) => { runCalls.push({ sql, params }); return { changes: 1 }; },
      get: (...params) => null,
      all: (...params) => [],
    });

    const cloudCards = [
      {
        id: 'cloud_kc_self',
        title: 'My own card',
        summary: 'Pushed by this device',
        category: 'key_point',
        metadata: { device_id: 'test-device' }, // same as ctx.deviceId
      },
    ];

    const ctx = createMockCtx({
      indexer: { db },
      deviceId: 'test-device',
      httpGet: async () => ({
        cards: cloudCards,
        sync_timestamp: '2026-04-08T16:00:00Z',
      }),
    });

    const result = await pullCardsSince(ctx);

    // Card from same device should be skipped
    assert.equal(result.pulled, 0);
    const inserts = runCalls.filter((c) => c.sql.includes('INSERT'));
    assert.equal(inserts.length, 0, 'Should not insert cards from same device');
  });

  it('updates cards_last_pulled_at after successful pull', async () => {
    const syncStateMap = {};

    const ctx = createMockCtx({
      httpGet: async () => ({
        cards: [
          {
            id: 'cloud_kc_ts',
            title: 'Timestamp test',
            summary: '',
            category: 'key_point',
            metadata: { device_id: 'other' },
          },
        ],
        sync_timestamp: '2026-04-08T18:00:00Z',
      }),
      getSyncState: (key) => syncStateMap[key] || null,
      setSyncState: (key, val) => { syncStateMap[key] = val; },
    });

    await pullCardsSince(ctx);

    assert.equal(
      syncStateMap.cards_last_pulled_at,
      '2026-04-08T18:00:00Z',
      'Should advance the pull cursor to sync_timestamp'
    );
  });

  it('does not crash on httpGet network error', async () => {
    const ctx = createMockCtx({
      httpGet: async () => { throw new Error('ECONNREFUSED'); },
    });

    const result = await pullCardsSince(ctx);

    assert.equal(result.pulled, 0);
  });
});
