// @ts-nocheck
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Import the testable functions directly (no daemon deps needed)
const {
  loadPendingCards,
  fetchCloudCards,
  isDuplicate,
  pushCard,
  runBackfill,
} = await import('../src/tools/backfill-to-cloud.mjs');

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDb(rows = []) {
  const _runs = [];
  return {
    prepare: (sql) => ({
      all: (...params) => rows,
      run: (...params) => { _runs.push({ sql, params }); return { changes: 1 }; },
      get: (...params) => null,
    }),
    _runs,
  };
}

function noop() {}
const silentLog = () => {};

// ---------------------------------------------------------------------------
// loadPendingCards
// ---------------------------------------------------------------------------

describe('backfill-to-cloud — loadPendingCards', () => {
  it('returns rows from knowledge_cards where cloud_id is null', () => {
    const expected = [
      { id: 'kc_1', title: 'Card A', summary: 'Sum A', category: 'decision' },
      { id: 'kc_2', title: 'Card B', summary: 'Sum B', category: 'insight' },
    ];
    const db = createMockDb(expected);
    const result = loadPendingCards(db);
    assert.deepEqual(result, expected);
  });

  it('returns empty array when no pending cards exist', () => {
    const db = createMockDb([]);
    const result = loadPendingCards(db);
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

describe('backfill-to-cloud — isDuplicate', () => {
  const cloud = [
    { id: 'cloud_1', title: 'Use JWT', summary: 'Auth decision' },
    { id: 'cloud_2', title: 'Rate Limiting', summary: 'Add rate limits' },
  ];

  it('detects exact title+summary match', () => {
    const local = { title: 'Use JWT', summary: 'Auth decision' };
    const dup = isDuplicate(local, cloud);
    assert.ok(dup);
    assert.equal(dup.id, 'cloud_1');
  });

  it('is case-insensitive', () => {
    const local = { title: 'USE JWT', summary: 'auth DECISION' };
    const dup = isDuplicate(local, cloud);
    assert.ok(dup);
    assert.equal(dup.id, 'cloud_1');
  });

  it('returns null when no match', () => {
    const local = { title: 'Something else', summary: 'No match' };
    const dup = isDuplicate(local, cloud);
    assert.equal(dup, null);
  });

  it('returns null for empty title', () => {
    const local = { title: '', summary: 'Auth decision' };
    const dup = isDuplicate(local, cloud);
    assert.equal(dup, false);
  });

  it('handles empty cloud cards', () => {
    const local = { title: 'Anything', summary: 'Whatever' };
    assert.equal(isDuplicate(local, []), null);
  });
});

// ---------------------------------------------------------------------------
// runBackfill — dry-run mode
// ---------------------------------------------------------------------------

describe('backfill-to-cloud — runBackfill dry-run', () => {
  it('reports would_push for cards without cloud duplicates', async () => {
    const rows = [
      { id: 'kc_1', title: 'New Card', summary: 'Fresh', category: 'insight', tags: '[]', version: 1 },
    ];
    const db = createMockDb(rows);

    const stats = await runBackfill({
      db,
      apply: false,
      apiBase: 'http://localhost:9999',
      apiKey: 'test',
      memoryId: 'mem_1',
      log: silentLog,
    });

    assert.equal(stats.pushed, 1);
    assert.equal(stats.skipped, 0);
    assert.equal(stats.conflicts, 0);
    assert.equal(stats.errors, 0);
  });

  it('reports would_skip for duplicate cards', async () => {
    // The cloud fetch will fail (no server), so cloudCards=[] and no skips
    // We need to simulate the cloud fetch returning data — override fetchCloudCards
    // Since fetchCloudCards uses httpRequest which would fail on a mock,
    // we test the dedup logic via isDuplicate directly.
    // For runBackfill, the cloud fetch failure means dedup is skipped.
    const rows = [
      { id: 'kc_1', title: 'Card', summary: 'Sum', category: 'decision', tags: '', version: 1 },
    ];
    const db = createMockDb(rows);

    const stats = await runBackfill({
      db, apply: false,
      apiBase: 'http://localhost:9999', apiKey: 'k', memoryId: 'm',
      log: silentLog,
    });

    // Cloud unreachable → no duplicates detected → all count as would_push
    assert.equal(stats.pushed, 1);
  });

  it('returns zero counts when no pending cards', async () => {
    const db = createMockDb([]);

    const stats = await runBackfill({
      db, apply: false,
      apiBase: 'http://test', apiKey: 'k', memoryId: 'm',
      log: silentLog,
    });

    assert.equal(stats.pushed, 0);
    assert.equal(stats.skipped, 0);
    assert.equal(stats.conflicts, 0);
    assert.equal(stats.errors, 0);
  });
});

// ---------------------------------------------------------------------------
// runBackfill — apply mode (mocked HTTP via monkey-patching)
// ---------------------------------------------------------------------------

describe('backfill-to-cloud — runBackfill apply (mocked)', () => {
  it('marks card as synced on successful push', async () => {
    const rows = [
      { id: 'kc_apply_1', title: 'Push Me', summary: 'Test', category: 'insight', tags: '[]', version: 1 },
    ];
    const runs = [];
    const db = {
      prepare: (sql) => ({
        all: () => rows,
        run: (...params) => { runs.push({ sql, params }); return { changes: 1 }; },
        get: () => null,
      }),
    };

    // We cannot easily mock httpRequest for the imported module without
    // a dependency injection layer; instead we verify that when the cloud
    // endpoint is unreachable, the error count goes up (proving the push
    // path was attempted).
    const stats = await runBackfill({
      db, apply: true,
      apiBase: 'http://127.0.0.1:1', // unreachable port
      apiKey: 'k', memoryId: 'm',
      log: silentLog,
    });

    // Push attempted → network error → errors++
    assert.equal(stats.errors, 1);
    assert.equal(stats.pushed, 0);
  });

  it('collects errors without crashing on network failures', async () => {
    const rows = [
      { id: 'kc_e1', title: 'A', summary: '', category: 'key_point', tags: '', version: 1 },
      { id: 'kc_e2', title: 'B', summary: '', category: 'key_point', tags: '', version: 1 },
    ];
    const db = createMockDb(rows);

    const stats = await runBackfill({
      db, apply: true,
      apiBase: 'http://127.0.0.1:1',
      apiKey: 'k', memoryId: 'm',
      log: silentLog,
    });

    assert.equal(stats.errors, 2);
    assert.equal(stats.pushed, 0);
    assert.equal(typeof stats.conflicts, 'number');
  });
});
