/**
 * wiki-api.test.mjs — Tests for wiki UI REST API endpoints
 *
 * Tests all new endpoints added for the wiki dashboard:
 *   1. GET /api/v1/topics — list categories with card counts
 *   2. GET /api/v1/skills — list skills with status filter
 *   3. POST /api/v1/skills/:id/use — mark skill as used
 *   4. PUT /api/v1/skills/:id — update skill (pin/unpin, status)
 *   5. GET /api/v1/timeline — daily grouped memories
 *   6. GET /api/v1/search — hybrid search
 *   7. GET /api/v1/knowledge/:id — single card detail with related + evolution
 *
 * Uses real SQLite via Indexer for integration-level confidence.
 * node:test + node:assert/strict, no external test deps.
 */
// @ts-nocheck


import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Indexer } from '../src/core/indexer.mjs';
import {
  apiListTopics,
  apiListSkills,
  apiMarkSkillUsed,
  apiUpdateSkill,
  apiTimeline,
  apiGetKnowledgeCard,
  apiHybridSearch,
} from '../src/daemon/api-handlers.mjs';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 86400000).toISOString();
const WEEK_AGO = new Date(Date.now() - 7 * 86400000).toISOString();

/** Capture jsonResponse output — must match the signature helpers.mjs expects */
function mockRes() {
  let _status = 200;
  let _body = '';
  return {
    writeHead(status, _headers) { _status = status; },
    end(body) { _body = body; },
    get status() { return _status; },
    get json() { return JSON.parse(_body); },
  };
}

function makeUrl(path, params = {}) {
  const u = new URL('http://localhost:37800/api/v1' + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

/** Mock req object that readBody() can consume */
function mockReq(bodyStr) {
  return {
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(bodyStr));
      if (event === 'end') handler();
    },
    destroy() {},
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Wiki API endpoints', () => {
  let tmpDir;
  let indexer;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-api-test-'));
    indexer = new Indexer(path.join(tmpDir, 'index.db'));

    // Seed knowledge cards
    const cards = [
      { id: 'kc_001', category: 'decision', title: 'Use PostgreSQL', summary: 'Decided to use PG for persistence', confidence: 0.95, growth_stage: 'evergreen', card_type: 'atomic', created_at: NOW, tags: JSON.stringify(['database', 'architecture']) },
      { id: 'kc_002', category: 'decision', title: 'Use Redis for caching', summary: 'Redis chosen for session cache', confidence: 0.8, growth_stage: 'budding', card_type: 'atomic', created_at: YESTERDAY, tags: JSON.stringify(['database', 'caching']) },
      { id: 'kc_003', category: 'problem_solution', title: 'Fix CORS issue', summary: 'Added proper CORS headers', confidence: 0.9, growth_stage: 'seedling', card_type: 'atomic', created_at: WEEK_AGO, tags: JSON.stringify(['backend', 'security']) },
      { id: 'kc_004', category: 'workflow', title: 'Deploy via Docker', summary: 'Docker compose workflow for deployment', confidence: 0.85, growth_stage: 'budding', card_type: 'atomic', created_at: NOW, tags: JSON.stringify(['docker', 'deployment']) },
      { id: 'kc_005', category: 'pitfall', title: 'Never run prisma push', summary: 'Drops memory_vectors table', confidence: 0.95, growth_stage: 'evergreen', card_type: 'atomic', created_at: YESTERDAY, tags: JSON.stringify(['database', 'pitfall']) },
      { id: 'kc_006', category: 'personal_preference', title: 'Prefers dark mode', summary: 'User likes dark themes', confidence: 0.7, growth_stage: 'seedling', card_type: 'atomic', created_at: NOW, tags: JSON.stringify(['preferences']) },
      // MOC card for topic testing
      { id: 'kc_moc_001', category: 'decision', title: 'Database Architecture', summary: 'Overview of database decisions', confidence: 0.9, growth_stage: 'evergreen', card_type: 'moc', created_at: NOW, tags: JSON.stringify(['database']) },
    ];
    for (const c of cards) {
      indexer.indexKnowledgeCard({ ...c, status: 'active', tags: c.tags, source_memories: JSON.stringify([]), filepath: path.join(tmpDir, c.id + '.md') });
    }

    // Seed skills
    const skillInsert = indexer.db.prepare(
      `INSERT INTO skills (id, name, summary, methods, tags, decay_score, usage_count, pinned, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    skillInsert.run('sk_001', 'Docker Deploy', 'Deploy services via docker compose', '["build","push","deploy"]', '["docker"]', 0.8, 5, 0, 'active', NOW, NOW);
    skillInsert.run('sk_002', 'TDD Workflow', 'Write tests first', '["write test","implement","refactor"]', '["testing"]', 0.5, 2, 0, 'active', NOW, NOW);
    skillInsert.run('sk_003', 'Old Skill', 'Archived', '[]', '[]', 0.1, 0, 0, 'archived', NOW, NOW);

    // Seed memories
    const memories = [
      { id: 'mem_001', title: 'Session start', type: 'session_summary', created_at: NOW },
      { id: 'mem_002', title: 'Discussed caching strategy', type: 'turn_summary', created_at: NOW },
      { id: 'mem_003', title: 'Yesterday meeting notes', type: 'session_summary', created_at: YESTERDAY },
      { id: 'mem_004', title: 'Old event from last week', type: 'message', created_at: WEEK_AGO },
    ];
    for (const m of memories) {
      indexer.indexMemory(m.id, {
        filepath: path.join(tmpDir, m.id + '.md'),
        type: m.type,
        created_at: m.created_at,
        updated_at: m.created_at,
        source: 'claude-code',
        tags: '[]',
      }, m.title + '\n\nContent body for ' + m.title);
    }
  });

  after(() => {
    if (indexer) indexer.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function daemon() { return { indexer, search: null, awarenessDir: tmpDir, _loadConfig: () => ({}) }; }

  // ── Topics ──

  it('topics: returns MOC cards as primary topics', () => {
    const res = mockRes();
    apiListTopics(daemon(), null, res, makeUrl('/topics'));
    assert.equal(res.status, 200);
    const data = res.json;
    assert.ok(Array.isArray(data.items));
    // Should find the MOC card we seeded
    assert.ok(data.items.length >= 1, `expected >=1 topic, got ${data.items.length}`);
    const moc = data.items.find(t => t.source === 'moc');
    assert.ok(moc, 'MOC topic should exist');
    assert.equal(moc.title, 'Database Architecture');
    assert.equal(moc.id, 'kc_moc_001');
  });

  it('topics: MOC card_count is live-computed and matches GET /knowledge/:id members', () => {
    // Stale link_count_outgoing must NOT leak into the topics response.
    // Force the stored count to a bogus value and verify apiListTopics ignores it.
    indexer.db.prepare(
      `UPDATE knowledge_cards SET link_count_outgoing = 999 WHERE id = 'kc_moc_001'`
    ).run();

    const topicsRes = mockRes();
    apiListTopics(daemon(), null, topicsRes, makeUrl('/topics'));
    const moc = topicsRes.json.items.find(t => t.id === 'kc_moc_001');
    assert.ok(moc, 'kc_moc_001 should appear in topics');
    // 3 seeded cards (kc_001/002/005) share the 'database' tag with this MOC
    assert.equal(moc.card_count, 3, 'live count must recompute, not trust stored 999');

    const detailRes = mockRes();
    apiGetKnowledgeCard(daemon(), null, detailRes, 'kc_moc_001');
    assert.equal(detailRes.json.members.length, moc.card_count,
      'sidebar count must equal rendered members');

    // Cleanup
    indexer.db.prepare(
      `UPDATE knowledge_cards SET link_count_outgoing = 3 WHERE id = 'kc_moc_001'`
    ).run();
  });

  it('topics: empty MOC is dropped from results', () => {
    // A MOC with a tag nobody else has should be hidden (card_count === 0)
    indexer.db.prepare(
      `INSERT INTO knowledge_cards
         (id, category, title, summary, confidence, growth_stage, card_type,
          status, tags, created_at, source_memories, filepath)
       VALUES ('kc_moc_empty', 'decision', 'Empty MOC', 'No members',
               0.5, 'seedling', 'moc', 'active', '["nobody-has-this-tag-xyz"]',
               ?, '[]', '__moc__/kc_moc_empty')`
    ).run(NOW);

    const res = mockRes();
    apiListTopics(daemon(), null, res, makeUrl('/topics'));
    const emptyMoc = res.json.items.find(t => t.id === 'kc_moc_empty');
    assert.equal(emptyMoc, undefined, 'empty MOC must be dropped');

    indexer.db.prepare(`DELETE FROM knowledge_cards WHERE id = 'kc_moc_empty'`).run();
  });

  it('topics: falls back to tag grouping when no MOC cards', () => {
    // Delete the MOC card temporarily
    indexer.db.prepare("UPDATE knowledge_cards SET status = 'superseded' WHERE id = 'kc_moc_001'").run();
    const res = mockRes();
    apiListTopics(daemon(), null, res, makeUrl('/topics'));
    const data = res.json;
    assert.ok(data.items.length >= 1, 'should have tag-based topics');
    // 'database' tag appears on 3 cards, should be a topic
    const dbTopic = data.items.find(t => t.title.toLowerCase().includes('database'));
    assert.ok(dbTopic, 'database tag-topic should exist');
    assert.ok(dbTopic.card_count >= 2);
    assert.equal(dbTopic.source, 'tag');
    // Restore
    indexer.db.prepare("UPDATE knowledge_cards SET status = 'active' WHERE id = 'kc_moc_001'").run();
  });

  it('topics: total matches items length', () => {
    const res = mockRes();
    apiListTopics(daemon(), null, res, makeUrl('/topics'));
    assert.equal(res.json.total, res.json.items.length);
  });

  it('topics: graceful when no indexer', () => {
    const res = mockRes();
    apiListTopics({ indexer: null }, null, res, makeUrl('/topics'));
    assert.equal(res.json.items.length, 0);
  });

  // ── Skills List ──

  it('skills: lists active by default', () => {
    const res = mockRes();
    apiListSkills(daemon(), null, res, makeUrl('/skills'));
    const items = res.json.items;
    assert.equal(items.length, 2);
    assert.ok(items.every(s => s.status === 'active'));
    assert.ok(items[0].decay_score >= items[1].decay_score, 'should sort by decay DESC');
  });

  it('skills: filters by archived status', () => {
    const res = mockRes();
    apiListSkills(daemon(), null, res, makeUrl('/skills', { status: 'archived' }));
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.items[0].name, 'Old Skill');
  });

  it('skills: parses JSON fields', () => {
    const res = mockRes();
    apiListSkills(daemon(), null, res, makeUrl('/skills'));
    const s = res.json.items[0];
    assert.ok(Array.isArray(s.methods), 'methods should be array');
    assert.ok(Array.isArray(s.tags), 'tags should be array');
    assert.ok(s.methods.length > 0);
  });

  it('skills: graceful when no indexer', () => {
    const res = mockRes();
    apiListSkills({ indexer: null }, null, res, makeUrl('/skills'));
    assert.deepEqual(res.json, { items: [], total: 0 });
  });

  // ── Skill Mark Used ──

  it('skill use: increments count and resets decay', () => {
    const before = indexer.db.prepare('SELECT usage_count, decay_score FROM skills WHERE id = ?').get('sk_002');
    const res = mockRes();
    apiMarkSkillUsed(daemon(), null, res, 'sk_002');
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    const after = indexer.db.prepare('SELECT usage_count, decay_score FROM skills WHERE id = ?').get('sk_002');
    assert.equal(after.usage_count, before.usage_count + 1);
    assert.equal(after.decay_score, 1.0);
  });

  it('skill use: 404 for nonexistent', () => {
    const res = mockRes();
    apiMarkSkillUsed(daemon(), null, res, 'sk_missing');
    assert.equal(res.status, 404);
  });

  // ── Skill Update ──

  it('skill update: pins and sets decay 1.0', async () => {
    const res = mockRes();
    await apiUpdateSkill(daemon(), mockReq('{"pinned":true}'), res, 'sk_001');
    assert.equal(res.status, 200);
    assert.equal(res.json.skill.pinned, 1);
    assert.equal(res.json.skill.decay_score, 1.0);
  });

  it('skill update: changes status', async () => {
    const res = mockRes();
    await apiUpdateSkill(daemon(), mockReq('{"status":"archived"}'), res, 'sk_002');
    assert.equal(res.json.skill.status, 'archived');
    // Restore
    const res2 = mockRes();
    await apiUpdateSkill(daemon(), mockReq('{"status":"active"}'), res2, 'sk_002');
  });

  it('skill update: 404 for nonexistent', async () => {
    const res = mockRes();
    await apiUpdateSkill(daemon(), mockReq('{"pinned":true}'), res, 'sk_nope');
    assert.equal(res.status, 404);
  });

  it('skill update: 400 for empty body', async () => {
    const res = mockRes();
    await apiUpdateSkill(daemon(), mockReq('{}'), res, 'sk_001');
    assert.equal(res.status, 400);
  });

  // ── Timeline ──

  it('timeline: groups by day', () => {
    const res = mockRes();
    apiTimeline(daemon(), null, res, makeUrl('/timeline', { days: '30' }));
    const data = res.json;
    assert.ok(Array.isArray(data.by_day));
    assert.ok(data.by_day.length >= 1);
    for (const day of data.by_day) {
      assert.ok(day.date);
      assert.ok(Array.isArray(day.events));
      assert.equal(day.count, day.events.length);
    }
  });

  it('timeline: sorted days descending', () => {
    const res = mockRes();
    apiTimeline(daemon(), null, res, makeUrl('/timeline', { days: '30' }));
    const days = res.json.by_day;
    for (let i = 1; i < days.length; i++) {
      assert.ok(days[i - 1].date >= days[i].date);
    }
  });

  it('timeline: graceful when no indexer', () => {
    const res = mockRes();
    apiTimeline({ indexer: null }, null, res, makeUrl('/timeline'));
    assert.deepEqual(res.json.by_day, []);
  });

  // ── Knowledge Card Detail ──

  it('card detail: returns full data', () => {
    const res = mockRes();
    apiGetKnowledgeCard(daemon(), null, res, 'kc_001');
    assert.equal(res.status, 200);
    const c = res.json;
    assert.equal(c.id, 'kc_001');
    assert.equal(c.title, 'Use PostgreSQL');
    assert.equal(c.category, 'decision');
    assert.equal(c.growth_stage, 'evergreen');
    assert.ok(Array.isArray(c.tags));
    assert.ok(Array.isArray(c.source_memories));
    assert.ok(Array.isArray(c.related_cards));
    assert.ok(Array.isArray(c.evolution_chain));
    assert.ok(Array.isArray(c.members), 'members array must exist on every card');
    assert.equal(c.members.length, 0, 'non-MOC cards should have empty members');
  });

  it('card detail: MOC card returns members matched by shared tag', () => {
    const res = mockRes();
    apiGetKnowledgeCard(daemon(), null, res, 'kc_moc_001');
    assert.equal(res.status, 200);
    const c = res.json;
    assert.equal(c.card_type, 'moc');
    assert.ok(Array.isArray(c.members), 'members must be an array');
    // kc_moc_001 has tags=['database']; kc_001/kc_002/kc_005 all share 'database'
    const memberIds = c.members.map((m) => m.id).sort();
    assert.ok(memberIds.includes('kc_001'), 'kc_001 should be a member');
    assert.ok(memberIds.includes('kc_002'), 'kc_002 should be a member');
    assert.ok(memberIds.includes('kc_005'), 'kc_005 should be a member');
    // MOC cards themselves must be excluded
    assert.ok(!memberIds.includes('kc_moc_001'), 'MOC must not include itself');
    // Each member should expose essential display fields
    for (const m of c.members) {
      assert.ok(m.id && m.title, `member ${m.id || '?'} missing id/title`);
      assert.ok(Array.isArray(m.tags), 'member tags must be parsed');
    }
  });

  it('card detail: related cards are same category excluding self', () => {
    const res = mockRes();
    apiGetKnowledgeCard(daemon(), null, res, 'kc_001');
    const related = res.json.related_cards;
    assert.ok(related.length > 0);
    assert.ok(related.every(r => r.category === 'decision'));
    assert.ok(!related.find(r => r.id === 'kc_001'));
  });

  it('card detail: 404 for nonexistent', () => {
    const res = mockRes();
    apiGetKnowledgeCard(daemon(), null, res, 'kc_nope');
    assert.equal(res.status, 404);
  });

  it('card detail: 503 when no indexer', () => {
    const res = mockRes();
    apiGetKnowledgeCard({ indexer: null }, null, res, 'kc_001');
    assert.equal(res.status, 503);
  });

  // ── Hybrid Search ──

  it('search: returns results via FTS fallback', async () => {
    const res = mockRes();
    await apiHybridSearch(daemon(), null, res, makeUrl('/search', { q: 'PostgreSQL', limit: '10' }));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.items));
    assert.equal(res.json.query, 'PostgreSQL');
  });

  it('search: empty for empty query', async () => {
    const res = mockRes();
    await apiHybridSearch(daemon(), null, res, makeUrl('/search', { q: '' }));
    assert.equal(res.json.items.length, 0);
  });

  it('search: respects limit', async () => {
    const res = mockRes();
    await apiHybridSearch(daemon(), null, res, makeUrl('/search', { q: 'test', limit: '2' }));
    assert.ok(res.json.items.length <= 2);
  });

  // ── Incremental MOC ──

  it('autoMoc: creates MOC when 3+ cards share a tag', () => {
    // Create a fresh tag group: 3 cards all tagged "kubernetes"
    for (let i = 1; i <= 3; i++) {
      const card = {
        id: `kc_k8s_${i}`, category: 'workflow', title: `K8s pattern ${i}`,
        summary: `Kubernetes pattern number ${i}`, confidence: 0.9,
        growth_stage: 'seedling', card_type: 'atomic', created_at: NOW,
        status: 'active', tags: JSON.stringify(['kubernetes', 'devops']),
        source_memories: '[]', filepath: path.join(tmpDir, `kc_k8s_${i}.md`),
      };
      indexer.indexKnowledgeCard(card);
      indexer.tryAutoMoc(card);
    }

    // Should have created a MOC for "kubernetes"
    const moc = indexer.db.prepare(
      "SELECT * FROM knowledge_cards WHERE card_type = 'moc' AND LOWER(title) = 'kubernetes'"
    ).get();
    assert.ok(moc, 'MOC card for kubernetes should exist');
    assert.equal(moc.link_count_outgoing, 3);
    assert.ok(moc.summary.includes('K8s pattern'));
  });

  it('autoMoc: does not create MOC for < 3 cards', () => {
    // Only 2 cards with "rare-tag"
    for (let i = 1; i <= 2; i++) {
      const card = {
        id: `kc_rare_${i}`, category: 'insight', title: `Rare ${i}`,
        summary: 'Rare content', confidence: 0.8,
        growth_stage: 'seedling', card_type: 'atomic', created_at: NOW,
        status: 'active', tags: JSON.stringify(['rare-unique-tag']),
        source_memories: '[]', filepath: path.join(tmpDir, `kc_rare_${i}.md`),
      };
      indexer.indexKnowledgeCard(card);
      indexer.tryAutoMoc(card);
    }
    const moc = indexer.db.prepare(
      "SELECT * FROM knowledge_cards WHERE card_type = 'moc' AND LOWER(title) LIKE '%rare%'"
    ).get();
    assert.equal(moc, undefined, 'Should not create MOC for < 3 cards');
  });

  it('autoMoc: updates member count on existing MOC', () => {
    // Add a 4th kubernetes card
    const card = {
      id: 'kc_k8s_4', category: 'workflow', title: 'K8s pattern 4',
      summary: 'Fourth kubernetes pattern', confidence: 0.9,
      growth_stage: 'seedling', card_type: 'atomic', created_at: NOW,
      status: 'active', tags: JSON.stringify(['kubernetes']),
      source_memories: '[]', filepath: path.join(tmpDir, 'kc_k8s_4.md'),
    };
    indexer.indexKnowledgeCard(card);
    indexer.tryAutoMoc(card);

    const moc = indexer.db.prepare(
      "SELECT link_count_outgoing FROM knowledge_cards WHERE card_type = 'moc' AND LOWER(title) = 'kubernetes'"
    ).get();
    assert.equal(moc.link_count_outgoing, 4, 'MOC should have updated member count to 4');
  });

  it('autoMoc: skips MOC cards themselves', () => {
    const mocCard = {
      id: 'kc_moc_skip', card_type: 'moc', title: 'Test MOC',
      tags: JSON.stringify(['kubernetes']),
    };
    // Should not throw or create nested MOC
    indexer.tryAutoMoc(mocCard);
    const count = indexer.db.prepare(
      "SELECT COUNT(*) AS c FROM knowledge_cards WHERE card_type = 'moc' AND LOWER(title) = 'kubernetes'"
    ).get().c;
    assert.equal(count, 1, 'Should not create duplicate MOC');
  });
});
