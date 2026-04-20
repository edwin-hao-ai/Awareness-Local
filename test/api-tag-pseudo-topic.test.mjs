/**
 * Wiki tag pseudo-topic endpoint (`GET /api/v1/knowledge/tag_<tag>`).
 *
 * Context: the sidebar lists tag aggregations with ids of the form
 * `tag_<name>`. The AwarenessClaw client used to client-side-filter the
 * preloaded 50-card list for matching members, which broke when the tag's
 * members lived outside the top-50 (older cards). Users saw
 * "Daemon is building the tag index…" then a blank page.
 *
 * Fix: apiGetKnowledgeCard now handles `tag_*` cardIds by running the same
 * SQL tag-LIKE query as _countMocMembers and returning members[]. The
 * client falls through to this endpoint when client-side match yields 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const { apiGetKnowledgeCard } = await import('../src/daemon/api-handlers.mjs');
const { Indexer } = await import('../src/core/indexer.mjs');

class MockRes {
  constructor() { this.status = 0; this.body = null; }
  writeHead(status) { this.status = status; }
  end(body) { this.body = body; return this; }
}

function makeDaemon(dbPath) {
  const indexer = new Indexer(dbPath);
  return { daemon: { indexer }, cleanup: () => indexer.db.close() };
}

test('apiGetKnowledgeCard returns members for tag_<name> pseudo-id', async () => {
  const tmp = path.join(os.tmpdir(), `awareness-tag-topic-${Date.now()}.db`);
  const { daemon, cleanup } = makeDaemon(tmp);
  try {
    // Seed 3 cards: two share the tag "pgvector", one doesn't
    const now = new Date().toISOString();
    for (const [id, title, tags] of [
      ['c1', 'pgvector adoption', JSON.stringify(['pgvector', 'vector-db'])],
      ['c2', 'Pinecone rejected', JSON.stringify(['pgvector', 'cost'])],
      ['c3', 'Irrelevant card', JSON.stringify(['other'])],
    ]) {
      daemon.indexer.db.prepare(
        `INSERT INTO knowledge_cards (id, title, summary, category, status, confidence, tags, created_at, updated_at, filepath)
         VALUES (?, ?, ?, ?, 'active', 0.7, ?, ?, ?, ?)`
      ).run(id, title, title, 'decision', tags, now, now, `/tmp/seed-${id}.md`);
    }

    const res = new MockRes();
    await apiGetKnowledgeCard(daemon, null, res, 'tag_pgvector');
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, 'tag_pgvector');
    assert.equal(parsed.card_type, 'tag');
    assert.equal(parsed.members.length, 2, `expected 2 members, got ${parsed.members.length}`);
    const ids = parsed.members.map((m) => m.id).sort();
    assert.deepEqual(ids, ['c1', 'c2']);
  } finally {
    cleanup();
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
  }
});

test('apiGetKnowledgeCard case-insensitive tag match', async () => {
  const tmp = path.join(os.tmpdir(), `awareness-tag-case-${Date.now()}.db`);
  const { daemon, cleanup } = makeDaemon(tmp);
  try {
    const now = new Date().toISOString();
    daemon.indexer.db.prepare(
      `INSERT INTO knowledge_cards (id, title, summary, category, status, confidence, tags, created_at, updated_at, filepath)
       VALUES ('u1', 'Upper', 'Upper', 'decision', 'active', 0.7, ?, ?, ?, '/tmp/seed-u1.md')`
    ).run(JSON.stringify(['PgVector']), now, now);

    const res = new MockRes();
    // Sidebar produces lowercase id; daemon lowercases before LIKE search
    await apiGetKnowledgeCard(daemon, null, res, 'tag_pgvector');
    const parsed = JSON.parse(res.body);
    // SQLite LIKE is case-insensitive for ASCII — this passes without
    // extra work on the daemon side, but the test locks the behaviour.
    assert.equal(parsed.members.length, 1);
  } finally {
    cleanup();
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
  }
});

test('apiGetKnowledgeCard rejects empty tag', async () => {
  const tmp = path.join(os.tmpdir(), `awareness-tag-empty-${Date.now()}.db`);
  const { daemon, cleanup } = makeDaemon(tmp);
  try {
    const res = new MockRes();
    await apiGetKnowledgeCard(daemon, null, res, 'tag_');
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body);
    assert.match(parsed.error || '', /empty tag/i);
  } finally {
    cleanup();
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
  }
});

test('apiGetKnowledgeCard MOC multi-tag uses single OR-of-LIKEs scan (0.9.12 perf fix)', async () => {
  // Regression for the user-reported "click topic → click card → very slow"
  // wiki bug. Pre-0.9.12 ran one full-table LIKE scan per MOC tag; for a
  // 5-tag MOC over a non-trivial table this blocked the event loop for
  // hundreds of ms. The new path runs ONE scan with OR-of-LIKEs and a JS
  // intersect filter. This test asserts: (a) result set unchanged for the
  // 5-tag case, (b) defensive intersect rejects substring false positives
  // (e.g. tag "go" must not match card tagged "google" via the LIKE).
  const tmp = path.join(os.tmpdir(), `awareness-moc-multi-${Date.now()}.db`);
  const { daemon, cleanup } = makeDaemon(tmp);
  try {
    const now = new Date().toISOString();
    daemon.indexer.db.prepare(
      `INSERT INTO knowledge_cards (id, title, summary, category, status, confidence, tags, card_type, created_at, updated_at, filepath)
       VALUES ('moc1', 'Cluster MOC', 'summary', 'decision', 'active', 0.7, ?, 'moc', ?, ?, '/tmp/seed-moc1.md')`
    ).run(JSON.stringify(['rust', 'tokio', 'axum', 'serde', 'go']), now, now);

    // 4 real members (each shares at least one MOC tag), 1 substring decoy
    const seed = [
      ['m1', JSON.stringify(['rust', 'web'])],          // matches rust
      ['m2', JSON.stringify(['tokio'])],                // matches tokio
      ['m3', JSON.stringify(['axum', 'serde'])],        // matches axum + serde
      ['m4', JSON.stringify(['go', 'concurrency'])],    // matches go
      ['m5', JSON.stringify(['google', 'cloud'])],      // substring "go" inside "google" — must NOT match
      ['m6', JSON.stringify(['unrelated'])],            // matches nothing
    ];
    for (const [id, tags] of seed) {
      daemon.indexer.db.prepare(
        `INSERT INTO knowledge_cards (id, title, summary, category, status, confidence, tags, created_at, updated_at, filepath)
         VALUES (?, ?, 'body', 'decision', 'active', 0.7, ?, ?, ?, ?)`
      ).run(id, `Card ${id}`, tags, now, now, `/tmp/seed-${id}.md`);
    }

    const res = new MockRes();
    await apiGetKnowledgeCard(daemon, null, res, 'moc1');
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    const ids = parsed.members.map((m) => m.id).sort();
    assert.deepEqual(
      ids, ['m1', 'm2', 'm3', 'm4'],
      `expected the 4 real members only — substring decoy "google" must be filtered out by defensive JS intersect, got ${JSON.stringify(ids)}`,
    );
  } finally {
    cleanup();
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
  }
});

test('apiGetKnowledgeCard MOC path still works (regression)', async () => {
  const tmp = path.join(os.tmpdir(), `awareness-moc-${Date.now()}.db`);
  const { daemon, cleanup } = makeDaemon(tmp);
  try {
    const now = new Date().toISOString();
    daemon.indexer.db.prepare(
      `INSERT INTO knowledge_cards (id, title, summary, category, status, confidence, tags, card_type, created_at, updated_at, filepath)
       VALUES ('moc1', 'MOC card', 'moc summary', 'decision', 'active', 0.7, ?, 'moc', ?, ?, '/tmp/seed-moc1.md')`
    ).run(JSON.stringify(['moc-tag']), now, now);
    daemon.indexer.db.prepare(
      `INSERT INTO knowledge_cards (id, title, summary, category, status, confidence, tags, created_at, updated_at, filepath)
       VALUES ('m1', 'member 1', 'body', 'decision', 'active', 0.7, ?, ?, ?, '/tmp/seed-m1.md')`
    ).run(JSON.stringify(['moc-tag']), now, now);

    const res = new MockRes();
    await apiGetKnowledgeCard(daemon, null, res, 'moc1');
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, 'moc1');
    assert.equal(parsed.members.length, 1);
  } finally {
    cleanup();
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
  }
});
