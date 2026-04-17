/**
 * migration-forward-compat.test.mjs — L2 integration test for the
 * schema-migration forward-compat regression that broke 0.7.0/0.7.1.
 *
 * Scenario reproduced:
 *   1. User is on 0.6.x. Their index.db has knowledge_cards with the
 *      original 19-column layout (no `local_id`, no `updated_at`).
 *   2. User upgrades to 0.7.x. Daemon restarts, opens the same DB.
 *   3. cloud-sync runs _pushCardsV2 which does
 *      `SELECT ... local_id FROM knowledge_cards` → old DB has no such
 *      column → every sync tick logs an error.
 *   4. lifecycle-manager runs a GC pass which does
 *      `UPDATE knowledge_cards SET ... updated_at = ...` → same crash.
 *
 * The 0.7.2 migration adds an ALTER TABLE for both columns. This test
 * simulates the pre-0.7.2 schema, opens it with the post-0.7.2 Indexer,
 * and asserts that the two broken queries now succeed.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { Indexer } from '../src/core/indexer.mjs';

const LEGACY_SCHEMA = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  filepath TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT,
  session_id TEXT,
  agent_role TEXT DEFAULT 'builder_agent',
  source TEXT,
  status TEXT DEFAULT 'active',
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_hash TEXT,
  synced_to_cloud INTEGER DEFAULT 0
);
CREATE TABLE knowledge_cards (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source_memories TEXT,
  confidence REAL DEFAULT 0.8,
  status TEXT DEFAULT 'active',
  tags TEXT,
  created_at TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  synced_to_cloud INTEGER DEFAULT 0
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'medium',
  agent_role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  synced_to_cloud INTEGER DEFAULT 0
);
`;

describe('migration forward-compat (0.6.x → 0.7.2)', () => {
  let dbPath;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-fc-'));
    dbPath = path.join(tmpDir, 'index.db');

    // Write a legacy-style DB with the old 11-column knowledge_cards layout.
    const legacy = new Database(dbPath);
    legacy.exec(LEGACY_SCHEMA);
    legacy.prepare(`
      INSERT INTO knowledge_cards (id, category, title, summary, source_memories,
                                   confidence, status, tags, created_at, filepath)
      VALUES ('card-1', 'decision', 'Pick OAuth', 'Chose OAuth over API keys',
              NULL, 0.9, 'active', NULL, '2026-04-01T00:00:00Z',
              '/tmp/fake/card-1.md')
    `).run();
    legacy.close();
  });

  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('adds local_id and updated_at columns on first open', () => {
    const indexer = new Indexer(dbPath);
    const cols = indexer.db.prepare('PRAGMA table_info(knowledge_cards)').all();
    const names = new Set(cols.map((c) => c.name));
    assert.ok(names.has('local_id'), 'local_id column should be added by migration');
    assert.ok(names.has('updated_at'), 'updated_at column should be added by migration');
    indexer.close();
  });

  it('backfills local_id = id for existing rows', () => {
    const indexer = new Indexer(dbPath);
    const row = indexer.db
      .prepare('SELECT id, local_id FROM knowledge_cards WHERE id = ?')
      .get('card-1');
    assert.equal(row.local_id, 'card-1', 'local_id should be backfilled from id');
    indexer.close();
  });

  it('backfills updated_at from created_at for existing rows', () => {
    const indexer = new Indexer(dbPath);
    const row = indexer.db
      .prepare('SELECT created_at, updated_at FROM knowledge_cards WHERE id = ?')
      .get('card-1');
    assert.equal(row.updated_at, row.created_at, 'updated_at should be backfilled from created_at');
    indexer.close();
  });

  it('_pushCardsV2-shaped query runs without "no such column" errors', () => {
    const indexer = new Indexer(dbPath);
    assert.doesNotThrow(() => {
      indexer.db.prepare(
        `SELECT id, category, title, summary, confidence, status, tags,
                source_memories, parent_card_id, evolution_type,
                cloud_id, version, schema_version, local_id,
                COALESCE(recall_count, 0) AS recall_count
         FROM knowledge_cards
         WHERE synced_to_cloud = 0 AND status IN ('active', 'superseded')`
      ).all();
    });
    indexer.close();
  });

  it('lifecycle garbage-collector UPDATE using updated_at works', () => {
    const indexer = new Indexer(dbPath);
    assert.doesNotThrow(() => {
      indexer.db.prepare(
        `UPDATE knowledge_cards SET status = 'archived', updated_at = ?
         WHERE status = 'active'
           AND category IN ('pitfall', 'risk')
           AND confidence < 0.6
           AND updated_at < ?
           AND created_at < ?`
      ).run(new Date().toISOString(), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    });
    indexer.close();
  });

  it('migration is idempotent (second open is a no-op)', () => {
    const i1 = new Indexer(dbPath);
    i1.close();
    const i2 = new Indexer(dbPath);
    const cols = i2.db.prepare('PRAGMA table_info(knowledge_cards)').all();
    const localIdCount = cols.filter((c) => c.name === 'local_id').length;
    const updatedAtCount = cols.filter((c) => c.name === 'updated_at').length;
    assert.equal(localIdCount, 1, 'local_id should not be duplicated');
    assert.equal(updatedAtCount, 1, 'updated_at should not be duplicated');
    i2.close();
  });
});
