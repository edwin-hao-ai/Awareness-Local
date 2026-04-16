// @ts-nocheck
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Dynamic import to handle ESM
const { MemoryStore } = await import('../src/core/memory-store.mjs');

describe('MemoryStore backward compatibility', () => {
  let tempDir;
  let store;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'awareness-test-'));
    store = new MemoryStore(tempDir);
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses old markdown without sync fields and applies defaults', () => {
    const oldMarkdown = [
      '---',
      'id: mem_20260408_test',
      'type: turn_summary',
      'session_id: ses_123',
      'agent_role: builder_agent',
      'tags: []',
      'created_at: 2026-04-08T10:00:00Z',
      'updated_at: 2026-04-08T10:00:00Z',
      'source: manual',
      'status: active',
      'related: []',
      '---',
      'Test content here',
    ].join('\n');

    const { metadata, content } = store.parseMarkdown(oldMarkdown);

    assert.equal(metadata.id, 'mem_20260408_test');
    assert.equal(metadata.cloud_id, null);
    assert.equal(metadata.version, 1);
    assert.equal(metadata.schema_version, 1);
    assert.equal(metadata.sync_status, 'pending_push');
    assert.equal(metadata.last_pushed_at, null);
    assert.equal(metadata.last_pulled_at, null);
    assert.ok(content.includes('Test content'));
  });

  it('round-trips new markdown with sync fields', async () => {
    const memory = {
      type: 'turn_summary',
      content: 'Test with sync fields',
      session_id: 'ses_456',
      cloud_id: 'cloud_abc123',
      version: 3,
      schema_version: 2,
      sync_status: 'synced',
      last_pushed_at: '2026-04-08T12:00:00Z',
      last_pulled_at: '2026-04-08T11:00:00Z',
    };

    const { id, filepath } = await store.write(memory);
    const raw = readFileSync(filepath, 'utf-8');
    const { metadata } = store.parseMarkdown(raw);

    assert.equal(metadata.cloud_id, 'cloud_abc123');
    assert.equal(metadata.version, 3);
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.sync_status, 'synced');
    assert.equal(metadata.last_pushed_at, '2026-04-08T12:00:00Z');
    assert.equal(metadata.last_pulled_at, '2026-04-08T11:00:00Z');
  });

  it('omits null sync fields from YAML output', () => {
    const id = store.generateId();
    const memory = {
      type: 'turn_summary',
      content: 'No sync fields',
    };
    const md = store.toMarkdown(id, memory);

    assert.ok(!md.includes('cloud_id:'));
    assert.ok(!md.includes('last_pushed_at:'));
    assert.ok(!md.includes('last_pulled_at:'));
    assert.ok(!md.includes('sync_status:'));
  });

  it('preserves sync fields through updateStatus()', async () => {
    const memory = {
      type: 'turn_summary',
      content: 'Will be archived',
      cloud_id: 'cloud_xyz',
      version: 2,
      schema_version: 1,
      sync_status: 'synced',
      last_pushed_at: '2026-04-08T09:00:00Z',
    };

    const { id } = await store.write(memory);
    const updated = await store.updateStatus(id, 'archived');
    assert.ok(updated);

    const entry = await store.read(id);
    assert.equal(entry.metadata.status, 'archived');
    assert.equal(entry.metadata.cloud_id, 'cloud_xyz');
    assert.equal(entry.metadata.version, 2);
    assert.equal(entry.metadata.sync_status, 'synced');
  });
});

describe('Indexer SQLite migration', () => {
  let tempDir;

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('migrates sync fields on fresh DB without error', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'awareness-idx-'));
    const dbPath = join(tempDir, 'test.db');

    // Dynamic import to handle native module
    let Indexer;
    try {
      ({ Indexer } = await import('../src/core/indexer.mjs'));
    } catch {
      // better-sqlite3 not available in this environment
      return;
    }

    const indexer = new Indexer(dbPath);

    // Verify new columns exist by querying PRAGMA
    const memCols = indexer.db.pragma('table_info(memories)').map(c => c.name);
    assert.ok(memCols.includes('cloud_id'), 'memories should have cloud_id');
    assert.ok(memCols.includes('version'), 'memories should have version');
    assert.ok(memCols.includes('schema_version'), 'memories should have schema_version');
    assert.ok(memCols.includes('sync_status'), 'memories should have sync_status');
    assert.ok(memCols.includes('last_pushed_at'), 'memories should have last_pushed_at');
    assert.ok(memCols.includes('last_pulled_at'), 'memories should have last_pulled_at');

    const kcCols = indexer.db.pragma('table_info(knowledge_cards)').map(c => c.name);
    assert.ok(kcCols.includes('cloud_id'), 'knowledge_cards should have cloud_id');
    assert.ok(kcCols.includes('version'), 'knowledge_cards should have version');
    assert.ok(kcCols.includes('schema_version'), 'knowledge_cards should have schema_version');
    assert.ok(kcCols.includes('sync_status'), 'knowledge_cards should have sync_status');
    assert.ok(kcCols.includes('last_pushed_at'), 'knowledge_cards should have last_pushed_at');
    assert.ok(kcCols.includes('last_pulled_at'), 'knowledge_cards should have last_pulled_at');

    indexer.close();
  });

  it('runs migration twice without error (idempotent)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'awareness-idx2-'));
    const dbPath = join(tempDir, 'test.db');

    let Indexer;
    try {
      ({ Indexer } = await import('../src/core/indexer.mjs'));
    } catch {
      return;
    }

    // First init creates schema + migrates
    const indexer1 = new Indexer(dbPath);
    indexer1.close();

    // Second init should not fail
    const indexer2 = new Indexer(dbPath);
    const memCols = indexer2.db.pragma('table_info(memories)').map(c => c.name);
    assert.ok(memCols.includes('cloud_id'));
    assert.ok(memCols.includes('sync_status'));
    indexer2.close();
  });

  it('indexes memory with sync fields and reads them back', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'awareness-idx3-'));
    const dbPath = join(tempDir, 'test.db');

    let Indexer;
    try {
      ({ Indexer } = await import('../src/core/indexer.mjs'));
    } catch {
      return;
    }

    const indexer = new Indexer(dbPath);

    indexer.indexMemory('mem_test_001', {
      filepath: '/tmp/test.md',
      type: 'turn_summary',
      created_at: '2026-04-08T10:00:00Z',
      updated_at: '2026-04-08T10:00:00Z',
      cloud_id: 'cloud_sync_abc',
      version: 5,
      schema_version: 2,
      sync_status: 'synced',
      last_pushed_at: '2026-04-08T12:00:00Z',
    }, 'Test content for sync fields');

    const row = indexer.db.prepare('SELECT cloud_id, version, schema_version, sync_status, last_pushed_at FROM memories WHERE id = ?').get('mem_test_001');
    assert.equal(row.cloud_id, 'cloud_sync_abc');
    assert.equal(row.version, 5);
    assert.equal(row.schema_version, 2);
    assert.equal(row.sync_status, 'synced');
    assert.equal(row.last_pushed_at, '2026-04-08T12:00:00Z');

    indexer.close();
  });

  it('indexes knowledge card with sync fields', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'awareness-idx4-'));
    const dbPath = join(tempDir, 'test.db');

    let Indexer;
    try {
      ({ Indexer } = await import('../src/core/indexer.mjs'));
    } catch {
      return;
    }

    const indexer = new Indexer(dbPath);

    indexer.indexKnowledgeCard({
      id: 'kc_test_001',
      category: 'decision',
      title: 'Use JWT for auth',
      summary: 'Decided to use JWT tokens',
      filepath: '/tmp/kc.md',
      cloud_id: 'cloud_kc_xyz',
      version: 3,
      schema_version: 1,
      sync_status: 'synced',
      last_pushed_at: '2026-04-08T14:00:00Z',
      last_pulled_at: '2026-04-08T13:00:00Z',
    });

    const row = indexer.db.prepare('SELECT cloud_id, version, schema_version, sync_status, last_pushed_at, last_pulled_at FROM knowledge_cards WHERE id = ?').get('kc_test_001');
    assert.equal(row.cloud_id, 'cloud_kc_xyz');
    assert.equal(row.version, 3);
    assert.equal(row.sync_status, 'synced');
    assert.equal(row.last_pushed_at, '2026-04-08T14:00:00Z');
    assert.equal(row.last_pulled_at, '2026-04-08T13:00:00Z');

    indexer.close();
  });
});
