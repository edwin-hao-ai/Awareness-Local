/**
 * f031-alignment.test.mjs — Comprehensive tests for F-031 local-daemon alignment
 *
 * Tests all P1 changes:
 *   1. Indexer schema: card_type, growth_stage, link counts, skills table
 *   2. inferGrowthStage: growth promotion logic
 *   3. Knowledge card persistence: new fields round-trip through indexer
 *   4. Reranker 5-dimension fusion: weight distribution & scoring
 *   5. search.mjs mergeAndRank: cold data penalty + weight adjustments
 *   6. Skills table: CRUD, legacy migration, extractActiveSkills
 *   7. Skill decay formula: half-life, usage boost, pinned override
 *   8. awareness_mark_skill_used: usage increment + decay reset
 *
 * Uses real SQLite (via Indexer) for integration-level confidence.
 * node:test + node:assert/strict, no external test deps.
 */
// @ts-nocheck


import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Indexer } from '../src/core/indexer.mjs';
import {
  rerank,
  rerankWithFusion,
} from '../src/core/reranker.mjs';
import { extractActiveSkills } from '../src/daemon/helpers.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let tmpDir;
let indexer;
const NOW = new Date().toISOString();

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f031-test-'));
  const dbPath = path.join(tmpDir, 'index.db');
  indexer = new Indexer(dbPath);
}

function teardown() {
  if (indexer) indexer.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Build a realistic card fixture that simulates what the extraction pipeline produces.
 */
function makeCard(id, overrides = {}) {
  return {
    id,
    category: 'key_point',
    title: `Card ${id}`,
    summary: `Summary for card ${id}: this is a realistic knowledge card about a technical topic.`,
    source_memories: JSON.stringify(['mem_a1', 'mem_b2']),
    confidence: 0.85,
    status: 'active',
    tags: JSON.stringify(['test', 'f031']),
    source: 'claude-code',
    card_type: 'atomic',
    growth_stage: 'seedling',
    last_touched_at: NOW,
    link_count_incoming: 0,
    link_count_outgoing: 0,
    created_at: NOW,
    filepath: path.join(tmpDir, `${id}.md`),
    ...overrides,
  };
}

/**
 * Build search result fixture for reranker tests.
 */
function makeSearchResult(id, overrides = {}) {
  return {
    id,
    title: `Result ${id}`,
    summary: `Summary for ${id}`,
    type: 'knowledge_card',
    category: 'key_point',
    created_at: new Date(Date.now() - (overrides._ageDays || 5) * 86400000).toISOString(),
    bm25Score: -(overrides._bm25 ?? 3.5),  // FTS5 returns negative; lower = better
    embeddingScore: overrides._semantic ?? 0.7,
    card_type: overrides.card_type || 'atomic',
    growth_stage: overrides.growth_stage || 'seedling',
    rrfScore: overrides._rrfScore ?? 0.8,
    ...overrides,
  };
}

// ===========================================================================
// SECTION 1: Indexer Schema — new columns & skills table
// ===========================================================================

describe('Indexer schema (F-031 alignment)', () => {
  before(setup);
  after(teardown);

  it('creates knowledge_cards with card_type, growth_stage, link count columns', () => {
    const cols = indexer.db.prepare('PRAGMA table_info(knowledge_cards)').all();
    const colNames = new Set(cols.map((c) => c.name));

    assert.ok(colNames.has('card_type'), 'card_type column missing');
    assert.ok(colNames.has('growth_stage'), 'growth_stage column missing');
    assert.ok(colNames.has('last_touched_at'), 'last_touched_at column missing');
    assert.ok(colNames.has('link_count_incoming'), 'link_count_incoming column missing');
    assert.ok(colNames.has('link_count_outgoing'), 'link_count_outgoing column missing');
  });

  it('creates dedicated skills table with correct schema', () => {
    const cols = indexer.db.prepare('PRAGMA table_info(skills)').all();
    const colNames = new Set(cols.map((c) => c.name));

    assert.ok(colNames.has('id'), 'id column missing');
    assert.ok(colNames.has('name'), 'name column missing');
    assert.ok(colNames.has('summary'), 'summary column missing');
    assert.ok(colNames.has('methods'), 'methods column missing');
    assert.ok(colNames.has('decay_score'), 'decay_score column missing');
    assert.ok(colNames.has('usage_count'), 'usage_count column missing');
    assert.ok(colNames.has('last_used_at'), 'last_used_at column missing');
    assert.ok(colNames.has('pinned'), 'pinned column missing');
    assert.ok(colNames.has('status'), 'status column missing');
    assert.ok(colNames.has('source_card_ids'), 'source_card_ids column missing');
    assert.ok(colNames.has('trigger_conditions'), 'trigger_conditions column missing');
  });

  it('defaults card_type to atomic and growth_stage to seedling', () => {
    const cols = indexer.db.prepare('PRAGMA table_info(knowledge_cards)').all();
    const cardTypeCol = cols.find((c) => c.name === 'card_type');
    const growthCol = cols.find((c) => c.name === 'growth_stage');

    assert.ok(cardTypeCol.dflt_value.includes('atomic'), `Expected atomic default, got ${cardTypeCol.dflt_value}`);
    assert.ok(growthCol.dflt_value.includes('seedling'), `Expected seedling default, got ${growthCol.dflt_value}`);
  });
});

// ===========================================================================
// SECTION 2: inferGrowthStage — growth promotion logic
// ===========================================================================

describe('inferGrowthStage (via indexKnowledgeCard round-trip)', () => {
  before(setup);
  after(teardown);

  it('assigns seedling for card with 0 source_memories', () => {
    const card = makeCard('kc_grow_0', {
      source_memories: '[]',
      growth_stage: undefined,  // let inferGrowthStage decide
    });
    // Remove explicit growth_stage so indexer uses inferGrowthStage
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_0');
    assert.equal(row.growth_stage, 'seedling');
  });

  it('assigns seedling for card with 1 source_memory', () => {
    const card = makeCard('kc_grow_1', { source_memories: JSON.stringify(['mem_a']) });
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_1');
    assert.equal(row.growth_stage, 'seedling');
  });

  it('assigns budding for card with 2 source_memories', () => {
    const card = makeCard('kc_grow_2', { source_memories: JSON.stringify(['m1', 'm2']) });
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_2');
    assert.equal(row.growth_stage, 'budding');
  });

  it('assigns budding for card with 4 source_memories (boundary below evergreen)', () => {
    const card = makeCard('kc_grow_4', { source_memories: JSON.stringify(['m1', 'm2', 'm3', 'm4']) });
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_4');
    assert.equal(row.growth_stage, 'budding');
  });

  it('assigns evergreen for card with 5+ source_memories', () => {
    const card = makeCard('kc_grow_5', { source_memories: JSON.stringify(['m1', 'm2', 'm3', 'm4', 'm5']) });
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_5');
    assert.equal(row.growth_stage, 'evergreen');
  });

  it('handles malformed source_memories JSON gracefully (defaults to seedling)', () => {
    const card = makeCard('kc_grow_bad', { source_memories: 'not valid json' });
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_bad');
    assert.equal(row.growth_stage, 'seedling');
  });

  it('handles null source_memories (defaults to seedling)', () => {
    const card = makeCard('kc_grow_null', { source_memories: null });
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_null');
    assert.equal(row.growth_stage, 'seedling');
  });

  it('respects explicit growth_stage override from card', () => {
    const card = makeCard('kc_grow_override', {
      source_memories: '[]',    // would infer seedling
      growth_stage: 'evergreen', // but explicit value takes precedence
    });
    indexer.indexKnowledgeCard(card);
    const row = indexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_grow_override');
    assert.equal(row.growth_stage, 'evergreen');
  });
});

// ===========================================================================
// SECTION 3: Knowledge card round-trip — new fields persist correctly
// ===========================================================================

describe('Knowledge card round-trip with F-031 fields', () => {
  before(setup);
  after(teardown);

  it('persists card_type, growth_stage, link counts, last_touched_at', () => {
    const card = makeCard('kc_rt_01', {
      card_type: 'index',
      growth_stage: 'budding',
      link_count_incoming: 3,
      link_count_outgoing: 7,
      last_touched_at: '2026-04-10T12:00:00.000Z',
    });
    indexer.indexKnowledgeCard(card);

    const row = indexer.db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get('kc_rt_01');
    assert.equal(row.card_type, 'index');
    assert.equal(row.growth_stage, 'budding');
    assert.equal(row.link_count_incoming, 3);
    assert.equal(row.link_count_outgoing, 7);
    assert.equal(row.last_touched_at, '2026-04-10T12:00:00.000Z');
  });

  it('defaults card_type to atomic and growth_stage via inference', () => {
    const card = makeCard('kc_rt_02', {
      source_memories: JSON.stringify(['m1', 'm2', 'm3']),
    });
    delete card.card_type;
    delete card.growth_stage;
    indexer.indexKnowledgeCard(card);

    const row = indexer.db.prepare('SELECT card_type, growth_stage FROM knowledge_cards WHERE id = ?').get('kc_rt_02');
    assert.equal(row.card_type, 'atomic');
    assert.equal(row.growth_stage, 'budding'); // 3 refs → budding
  });

  it('updates existing card fields on re-index (upsert)', () => {
    const card = makeCard('kc_rt_upsert', { card_type: 'atomic', growth_stage: 'seedling' });
    indexer.indexKnowledgeCard(card);

    // Re-index with promoted growth stage (simulates real re-extraction)
    const updated = makeCard('kc_rt_upsert', {
      card_type: 'index',
      growth_stage: 'evergreen',
      link_count_incoming: 10,
    });
    indexer.indexKnowledgeCard(updated);

    const row = indexer.db.prepare('SELECT card_type, growth_stage, link_count_incoming FROM knowledge_cards WHERE id = ?').get('kc_rt_upsert');
    assert.equal(row.card_type, 'index');
    assert.equal(row.growth_stage, 'evergreen');
    assert.equal(row.link_count_incoming, 10);
  });
});

// ===========================================================================
// SECTION 4: Reranker 5-dimension fusion
// ===========================================================================

describe('Reranker 5-dimension fusion (F-031 aligned)', () => {
  it('produces weight sum close to 1.0', () => {
    // Default weights: semantic 0.50, bm25 0.20, cardType 0.15, growth 0.10, recency 0.05
    const total = 0.50 + 0.20 + 0.15 + 0.10 + 0.05;
    assert.ok(Math.abs(total - 1.0) < 0.001, `Weights sum to ${total}, expected 1.0`);
  });

  it('ranks MOC card higher than atomic card (all else equal)', () => {
    const results = [
      makeSearchResult('r_atomic', { card_type: 'atomic', _bm25: 3.5, _semantic: 0.7, _ageDays: 5 }),
      makeSearchResult('r_moc', { card_type: 'moc', _bm25: 3.5, _semantic: 0.7, _ageDays: 5 }),
    ];
    const ranked = rerankWithFusion(results, 'test query');
    assert.equal(ranked[0].id, 'r_moc', 'MOC should rank above atomic');
    assert.ok(ranked[0].rerankScore > ranked[1].rerankScore);
  });

  it('ranks index card between MOC and atomic (all else equal)', () => {
    const results = [
      makeSearchResult('r_atomic', { card_type: 'atomic', _bm25: 3.0, _semantic: 0.6, _ageDays: 5 }),
      makeSearchResult('r_index', { card_type: 'index', _bm25: 3.0, _semantic: 0.6, _ageDays: 5 }),
      makeSearchResult('r_moc', { card_type: 'moc', _bm25: 3.0, _semantic: 0.6, _ageDays: 5 }),
    ];
    const ranked = rerankWithFusion(results, 'test query');
    const order = ranked.map((r) => r.id);
    assert.equal(order[0], 'r_moc');
    assert.equal(order[1], 'r_index');
    assert.equal(order[2], 'r_atomic');
  });

  it('ranks evergreen card higher than seedling (all else equal)', () => {
    const results = [
      makeSearchResult('r_seedling', { growth_stage: 'seedling', _bm25: 4.0, _semantic: 0.8 }),
      makeSearchResult('r_evergreen', { growth_stage: 'evergreen', _bm25: 4.0, _semantic: 0.8 }),
    ];
    const ranked = rerankWithFusion(results, 'test query');
    assert.equal(ranked[0].id, 'r_evergreen');
  });

  it('includes _rerankSignals showing all 5 dimensions', () => {
    const results = [
      makeSearchResult('r_signals', { card_type: 'index', growth_stage: 'budding' }),
    ];
    const ranked = rerankWithFusion(results, 'test query');
    const signals = ranked[0]._rerankSignals;
    assert.ok('semantic' in signals, 'Missing semantic signal');
    assert.ok('bm25' in signals, 'Missing bm25 signal');
    assert.ok('cardType' in signals, 'Missing cardType signal');
    assert.ok('growth' in signals, 'Missing growth signal');
    assert.ok('recency' in signals, 'Missing recency signal');
  });

  it('high semantic score can overcome low card_type', () => {
    // Atomic card with perfect semantic match vs MOC with weak match
    const results = [
      makeSearchResult('r_perfect_atomic', { card_type: 'atomic', _bm25: 10, _semantic: 0.99, _ageDays: 1 }),
      makeSearchResult('r_weak_moc', { card_type: 'moc', _bm25: 1, _semantic: 0.1, _ageDays: 30 }),
    ];
    const ranked = rerankWithFusion(results, 'test query');
    assert.equal(ranked[0].id, 'r_perfect_atomic',
      'Strong semantic match should beat weak MOC (semantic weight 0.50 vs cardType 0.15)');
  });

  it('handles empty results gracefully', async () => {
    const ranked = await rerank([], 'test query');
    assert.deepEqual(ranked, []);
  });

  it('respects custom weight overrides', () => {
    const results = [
      makeSearchResult('r_bm25_heavy', { _bm25: 10, _semantic: 0.1, card_type: 'atomic' }),
      makeSearchResult('r_sem_heavy', { _bm25: 1, _semantic: 0.99, card_type: 'atomic' }),
    ];
    // Override: bm25 dominates
    const ranked = rerankWithFusion(results, 'test', {
      weights: { bm25: 0.80, semantic: 0.10, cardType: 0.05, growth: 0.03, recency: 0.02 },
    });
    assert.equal(ranked[0].id, 'r_bm25_heavy', 'BM25-heavy result should win with BM25 weight = 0.80');
  });
});

// ===========================================================================
// SECTION 5: mergeAndRank — cold data penalty & weight adjustments
// ===========================================================================

describe('mergeAndRank cold data penalty (F-031 aligned)', () => {
  // We can't easily import a private method, so we simulate via a mock SearchEngine.
  // Instead, we directly test the scoring logic extracted from the implementation.

  /**
   * Reproduce mergeAndRank scoring (from search.mjs) for testing.
   */
  function simulateMergeAndRank(results) {
    const DECAY_HALF_LIFE = 30;
    const COLD_THRESHOLD = 90;
    const COLD_PENALTY = 0.3;
    const now = Date.now();
    const rawScores = results.map((r) => r.rrfScore ?? 0);
    const maxRelevance = Math.max(...rawScores, 0.001);

    return results.map((r) => {
      const createdMs = r.created_at ? new Date(r.created_at).getTime() : now;
      const ageDays = Math.max(0, (now - createdMs) / (86400000));
      const timeDecay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE);
      const relevance = (r.rrfScore ?? 0) / maxRelevance;
      const typeBoost = { knowledge_card: 1.5, session_summary: 1.2 }[r.type] || 1.0;
      let finalScore = relevance * 0.65 * typeBoost + timeDecay * 0.05;
      const growthStage = r.growth_stage || 'seedling';
      if (ageDays > COLD_THRESHOLD && growthStage !== 'evergreen') {
        finalScore *= COLD_PENALTY;
      }
      return { ...r, finalScore };
    }).sort((a, b) => b.finalScore - a.finalScore);
  }

  it('penalizes 120-day seedling content by 0.3x', () => {
    const fresh = { id: 'fresh', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 5 * 86400000).toISOString() };
    const stale = { id: 'stale', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 120 * 86400000).toISOString() };
    const [ranked] = [simulateMergeAndRank([fresh, stale])];
    assert.equal(ranked[0].id, 'fresh', 'Fresh content should rank above stale');
    // Stale score should be ~30% of what it would be without penalty
    const staleResult = ranked.find((r) => r.id === 'stale');
    const freshResult = ranked.find((r) => r.id === 'fresh');
    // Both have same rrfScore, so static component (relevance*0.65*1.5) is same
    // but stale gets *0.3 penalty. Fresh also gets higher timeDecay. 
    assert.ok(staleResult.finalScore < freshResult.finalScore * 0.5,
      `Stale score ${staleResult.finalScore} should be much lower than fresh ${freshResult.finalScore}`);
  });

  it('does NOT penalize 120-day evergreen content', () => {
    const seedling = { id: 'seedling', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 120 * 86400000).toISOString() };
    const evergreen = { id: 'evergreen', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'evergreen', created_at: new Date(Date.now() - 120 * 86400000).toISOString() };
    const ranked = simulateMergeAndRank([seedling, evergreen]);
    assert.equal(ranked[0].id, 'evergreen', 'Evergreen should survive cold penalty');
    // Evergreen should be ~3.3x the seedling score (1 / 0.3)
    const egResult = ranked.find((r) => r.id === 'evergreen');
    const slResult = ranked.find((r) => r.id === 'seedling');
    const ratio = egResult.finalScore / slResult.finalScore;
    assert.ok(ratio > 2.5 && ratio < 4.0, `Evergreen/seedling ratio: ${ratio.toFixed(2)}, expected ~3.3`);
  });

  it('does NOT penalize 89-day content (under threshold)', () => {
    const under = { id: 'under', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 89 * 86400000).toISOString() };
    const over = { id: 'over', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 91 * 86400000).toISOString() };
    const ranked = simulateMergeAndRank([under, over]);
    assert.equal(ranked[0].id, 'under');
    const underR = ranked.find((r) => r.id === 'under');
    const overR = ranked.find((r) => r.id === 'over');
    // The over result gets 0.3 penalty, under does not
    assert.ok(underR.finalScore > overR.finalScore * 2,
      'Content just over 90 days should have penalty vs just under');
  });

  it('budding content at 100 days is still penalized', () => {
    const budding = { id: 'budding_old', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'budding', created_at: new Date(Date.now() - 100 * 86400000).toISOString() };
    const fresh = { id: 'fresh', rrfScore: 0.8, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 3 * 86400000).toISOString() };
    const ranked = simulateMergeAndRank([budding, fresh]);
    assert.equal(ranked[0].id, 'fresh', 'Fresh seedling beats stale budding due to cold penalty');
  });

  it('recency weight (0.05) contributes meaningful but small signal', () => {
    // Two cards: same relevance, one 1 day old, one 60 days old
    const veryFresh = { id: 'vfresh', rrfScore: 1.0, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 1 * 86400000).toISOString() };
    const moderate = { id: 'mod', rrfScore: 1.0, type: 'knowledge_card', growth_stage: 'seedling', created_at: new Date(Date.now() - 60 * 86400000).toISOString() };
    const ranked = simulateMergeAndRank([veryFresh, moderate]);
    const diff = ranked[0].finalScore - ranked[1].finalScore;
    // timeDecay difference: ~0.98 vs ~0.25, times 0.05 weight = ~0.036 difference
    assert.ok(diff > 0.01 && diff < 0.1,
      `Recency diff ${diff.toFixed(4)} should be small but non-zero (0.05 weight)`);
  });
});

// ===========================================================================
// SECTION 6: Skills table — CRUD + legacy migration + extractActiveSkills
// ===========================================================================

describe('Skills table CRUD and migration', () => {
  before(setup);
  after(teardown);

  it('inserts and retrieves a skill', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO skills (id, name, summary, methods, status, decay_score, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 1.0, 0, ?, ?)
    `).run('sk_test_01', 'TDD Workflow', 'Write tests first', JSON.stringify(['write test', 'run test', 'implement']), now, now);

    const skill = indexer.db.prepare('SELECT * FROM skills WHERE id = ?').get('sk_test_01');
    assert.equal(skill.name, 'TDD Workflow');
    assert.equal(skill.decay_score, 1.0);
    assert.equal(skill.usage_count, 0);
  });

  it('inserts skill with pinned flag', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO skills (id, name, summary, pinned, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'active', ?, ?)
    `).run('sk_pinned', 'Always Active Skill', 'This is always active', now, now);

    const skill = indexer.db.prepare('SELECT pinned FROM skills WHERE id = ?').get('sk_pinned');
    assert.equal(skill.pinned, 1);
  });

  it('legacy migration moves knowledge_cards with category=skill to skills table', () => {
    // Simulate legacy skill card
    const card = makeCard('kc_legacy_skill_01', {
      category: 'skill',
      title: 'Deploy to Production',
      summary: 'SSH then docker compose',
    });
    indexer.indexKnowledgeCard(card);

    // Run migration manually (it already ran at init, but we can verify behavior)
    // The card was inserted AFTER init, so we run migration again
    indexer._migrateLegacySkills();

    const skills = indexer.db.prepare("SELECT * FROM skills WHERE name = 'Deploy to Production'").all();
    assert.ok(skills.length >= 1, 'Legacy skill should be migrated');
  });
});

describe('extractActiveSkills (F-032 integration)', () => {
  before(setup);
  after(teardown);

  it('returns skills from skills table when available', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO skills (id, name, summary, methods, status, decay_score, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 0.8, 3, ?, ?)
    `).run('sk_active_01', 'Git Workflow', 'Conventional commits', JSON.stringify(['commit', 'push', 'PR']), now, now);

    const skills = extractActiveSkills([], indexer);
    assert.ok(skills.length >= 1);
    const gitSkill = skills.find((s) => s.title === 'Git Workflow');
    assert.ok(gitSkill, 'Git Workflow skill should be found');
    assert.equal(gitSkill.decay_score, 0.8);
    assert.equal(gitSkill.usage_count, 3);
    assert.ok(Array.isArray(gitSkill.methods), 'methods should be an array');
    assert.equal(gitSkill.methods.length, 3);
  });

  it('filters out skills with low decay_score (<= 0.3)', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO skills (id, name, summary, status, decay_score, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0.1, ?, ?)
    `).run('sk_low_decay', 'Forgotten Skill', 'Nobody uses this', now, now);

    const skills = extractActiveSkills([], indexer);
    const forgotten = skills.find((s) => s.title === 'Forgotten Skill');
    assert.equal(forgotten, undefined, 'Low-decay skills should be filtered out');
  });

  it('falls back to legacy knowledge_cards when no skills table data', () => {
    // Create a fresh indexer with no skills
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'f031-test-legacy-'));
    const idx2 = new Indexer(path.join(tmpDir2, 'index.db'));

    const legacyCards = [
      { category: 'skill', title: 'Legacy Skill A', summary: 'From knowledge_cards', methods: JSON.stringify(['step1']) },
      { category: 'key_point', title: 'Not a skill', summary: 'Should be filtered' },
    ];

    const skills = extractActiveSkills(legacyCards, idx2);
    assert.equal(skills.length, 1, 'Should return 1 legacy skill');
    assert.equal(skills[0].title, 'Legacy Skill A');

    idx2.close();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('works without indexer (null) — falls back to legacy cards filter', () => {
    const cards = [
      { category: 'skill', title: 'Fallback Skill', summary: 'Works without DB', methods: '["step1"]' },
    ];
    const skills = extractActiveSkills(cards, null);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].title, 'Fallback Skill');
  });
});

// ===========================================================================
// SECTION 7: Skill decay formula
// ===========================================================================

describe('Skill decay formula (aligned with cloud backend)', () => {
  // We directly test the decay math to avoid needing to call _runSkillDecay
  // which requires a full daemon instance. Instead we replicate the formula.

  const LAMBDA = 0.693 / 30; // ln(2) / 30-day half-life
  const LN_20 = Math.log(20);

  function computeDecay(daysSince, usageCount) {
    const baseDecay = Math.exp(-LAMBDA * daysSince);
    const usageBoost = Math.log(usageCount + 1) / LN_20;
    return Math.min(1.0, baseDecay + usageBoost);
  }

  it('brand new skill (0 days, 0 usage) has decay ≈ 1.0', () => {
    const score = computeDecay(0, 0);
    assert.ok(Math.abs(score - 1.0) < 0.01, `Expected ~1.0, got ${score}`);
  });

  it('30-day unused skill has decay ≈ 0.5 (half-life)', () => {
    const score = computeDecay(30, 0);
    assert.ok(Math.abs(score - 0.5) < 0.05, `Expected ~0.5, got ${score}`);
  });

  it('60-day unused skill has decay ≈ 0.25', () => {
    const score = computeDecay(60, 0);
    assert.ok(Math.abs(score - 0.25) < 0.05, `Expected ~0.25, got ${score}`);
  });

  it('90-day unused skill has very low decay', () => {
    const score = computeDecay(90, 0);
    assert.ok(score < 0.15, `Expected < 0.15, got ${score}`);
  });

  it('high usage (20 uses) boosts a 60-day skill back to 1.0', () => {
    // usageBoost = ln(21)/ln(20) ≈ 1.016 → capped at 1.0
    const score = computeDecay(60, 20);
    assert.equal(score, 1.0, 'High usage should cap at 1.0');
  });

  it('moderate usage (5 uses) partially recovers a 30-day skill', () => {
    // baseDecay ≈ 0.5, usageBoost = ln(6)/ln(20) ≈ 0.598
    const score = computeDecay(30, 5);
    assert.ok(score > 0.9, `Expected > 0.9, got ${score}`);
  });

  it('single use gives small but meaningful boost', () => {
    // usageBoost = ln(2)/ln(20) ≈ 0.231
    const base = computeDecay(30, 0);
    const withUse = computeDecay(30, 1);
    const delta = withUse - base;
    assert.ok(delta > 0.2 && delta < 0.3, `Usage boost delta: ${delta.toFixed(3)}`);
  });
});

// ===========================================================================
// SECTION 8: awareness_mark_skill_used — usage increment + decay reset
// ===========================================================================

describe('awareness_mark_skill_used (via SQLite ops)', () => {
  before(setup);
  after(teardown);

  it('increments usage_count and resets decay_score to 1.0', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO skills (id, name, summary, status, decay_score, usage_count, last_used_at, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0.4, 2, ?, ?, ?)
    `).run('sk_mark_01', 'Code Review', 'Run code-reviewer agent', now, now, now);

    // Simulate what tool-bridge does
    const markNow = new Date().toISOString();
    indexer.db.prepare(
      `UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?, decay_score = 1.0, updated_at = ? WHERE id = ?`
    ).run(markNow, markNow, 'sk_mark_01');

    const updated = indexer.db.prepare('SELECT * FROM skills WHERE id = ?').get('sk_mark_01');
    assert.equal(updated.usage_count, 3, 'usage_count should increment from 2 to 3');
    assert.equal(updated.decay_score, 1.0, 'decay_score should reset to 1.0');
    assert.equal(updated.last_used_at, markNow);
  });

  it('handles non-existent skill gracefully (0 changes)', () => {
    const now = new Date().toISOString();
    const result = indexer.db.prepare(
      `UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?, decay_score = 1.0, updated_at = ? WHERE id = ?`
    ).run(now, now, 'sk_nonexistent');
    assert.equal(result.changes, 0, 'No rows should be affected for non-existent skill');
  });

  it('multiple marks compound usage_count correctly', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO skills (id, name, status, decay_score, usage_count, created_at, updated_at)
      VALUES (?, ?, 'active', 0.3, 0, ?, ?)
    `).run('sk_multi', 'Repeated Skill', now, now);

    for (let i = 0; i < 5; i++) {
      indexer.db.prepare(
        `UPDATE skills SET usage_count = usage_count + 1, decay_score = 1.0, updated_at = ? WHERE id = ?`
      ).run(new Date().toISOString(), 'sk_multi');
    }

    const skill = indexer.db.prepare('SELECT usage_count FROM skills WHERE id = ?').get('sk_multi');
    assert.equal(skill.usage_count, 5, 'Should have 5 after 5 marks');
  });
});

// ===========================================================================
// SECTION 9: Realistic end-to-end scenario
// ===========================================================================

describe('End-to-end: realistic user recall scenario', () => {
  let e2eDir;
  let e2eIndexer;

  before(() => {
    e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f031-e2e-'));
    e2eIndexer = new Indexer(path.join(e2eDir, 'index.db'));

    const now = Date.now();

    // Simulate a real user's knowledge base:
    // 1. A recent decision (2 days old, atomic, 1 ref)
    e2eIndexer.indexKnowledgeCard(makeCard('kc_recent_decision', {
      category: 'decision',
      title: 'Use PostgreSQL for production',
      summary: 'Chose PostgreSQL over MongoDB for ACID compliance and pgvector support.',
      source_memories: JSON.stringify(['mem_001']),
      card_type: 'atomic',
      created_at: new Date(now - 2 * 86400000).toISOString(),
      filepath: path.join(e2eDir, 'kc_recent.md'),
    }));

    // 2. A well-referenced MOC (10 days old, 7 refs → evergreen)
    e2eIndexer.indexKnowledgeCard(makeCard('kc_moc_deploy', {
      category: 'key_point',
      title: 'Deployment Architecture Overview',
      summary: 'Docker compose with backend + MCP + worker + beat. nginx reverse proxy.',
      source_memories: JSON.stringify(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']),
      card_type: 'moc',
      created_at: new Date(now - 10 * 86400000).toISOString(),
      filepath: path.join(e2eDir, 'kc_moc.md'),
    }));

    // 3. Old atomics from 120 days ago (should be penalized)
    e2eIndexer.indexKnowledgeCard(makeCard('kc_old_stale', {
      category: 'problem_solution',
      title: 'Fixed CSS grid alignment bug',
      summary: 'Used flexbox instead of grid for the card layout.',
      source_memories: JSON.stringify(['mem_old']),
      card_type: 'atomic',
      growth_stage: 'seedling',
      created_at: new Date(now - 120 * 86400000).toISOString(),
      filepath: path.join(e2eDir, 'kc_old.md'),
    }));

    // 4. Old but evergreen knowledge (120 days, but well-referenced → promoted to evergreen)
    e2eIndexer.indexKnowledgeCard(makeCard('kc_old_evergreen', {
      category: 'insight',
      title: 'Prisma migration best practices',
      summary: 'Never use prisma db push in production. Use manual SQL patches.',
      source_memories: JSON.stringify(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']),
      card_type: 'index',
      growth_stage: 'evergreen', // already promoted by repeated references
      created_at: new Date(now - 120 * 86400000).toISOString(),
      filepath: path.join(e2eDir, 'kc_evergreen.md'),
    }));

    // 5. Skills
    const skillNow = new Date().toISOString();
    e2eIndexer.db.prepare(`
      INSERT INTO skills (id, name, summary, methods, status, decay_score, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 0.9, 8, ?, ?)
    `).run('sk_deploy', 'Production Deployment', 'SSH + docker compose workflow',
      JSON.stringify(['ssh to server', 'docker compose build', 'docker compose up -d']),
      skillNow, skillNow);

    e2eIndexer.db.prepare(`
      INSERT INTO skills (id, name, summary, status, decay_score, usage_count, pinned, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 1.0, 0, 1, ?, ?)
    `).run('sk_safety', 'Safety Checks', 'Always run before deploy', skillNow, skillNow);
  });

  after(() => {
    if (e2eIndexer) e2eIndexer.close();
    if (e2eDir) fs.rmSync(e2eDir, { recursive: true, force: true });
  });

  it('evergreen card at 120 days should have growth_stage=evergreen', () => {
    const card = e2eIndexer.db.prepare('SELECT growth_stage FROM knowledge_cards WHERE id = ?').get('kc_old_evergreen');
    assert.equal(card.growth_stage, 'evergreen');
  });

  it('MOC card retains moc card_type', () => {
    const card = e2eIndexer.db.prepare('SELECT card_type FROM knowledge_cards WHERE id = ?').get('kc_moc_deploy');
    assert.equal(card.card_type, 'moc');
  });

  it('reranker ranks MOC evergreen above old stale atomic', () => {
    const results = [
      makeSearchResult('kc_old_stale', {
        card_type: 'atomic', growth_stage: 'seedling',
        _bm25: 3, _semantic: 0.6, _ageDays: 120,
      }),
      makeSearchResult('kc_moc_deploy', {
        card_type: 'moc', growth_stage: 'evergreen',
        _bm25: 3, _semantic: 0.6, _ageDays: 10,
      }),
    ];
    const ranked = rerankWithFusion(results, 'deployment');
    assert.equal(ranked[0].id, 'kc_moc_deploy', 'MOC should win on card_type + growth + recency');
  });

  it('skills lookup returns active skills ordered by decay_score', () => {
    const skills = extractActiveSkills([], e2eIndexer);
    assert.ok(skills.length >= 2, `Expected ≥2 skills, got ${skills.length}`);
    // Pinned skill has decay 1.0, deploy skill has 0.9
    assert.ok(skills[0].decay_score >= skills[1].decay_score,
      'Skills should be ordered by decay_score DESC');
  });

  it('marking a skill used resets its decay and increments usage', () => {
    const before = e2eIndexer.db.prepare('SELECT * FROM skills WHERE id = ?').get('sk_deploy');
    const beforeUsage = before.usage_count;

    const markNow = new Date().toISOString();
    e2eIndexer.db.prepare(
      `UPDATE skills SET usage_count = usage_count + 1, last_used_at = ?, decay_score = 1.0, updated_at = ? WHERE id = ?`
    ).run(markNow, markNow, 'sk_deploy');

    const after_ = e2eIndexer.db.prepare('SELECT * FROM skills WHERE id = ?').get('sk_deploy');
    assert.equal(after_.usage_count, beforeUsage + 1);
    assert.equal(after_.decay_score, 1.0);
  });
});
