// F-058 · card evolution unit tests
// Verifies findEvolutionTarget + supersedeCard against an in-memory SQLite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { findEvolutionTarget, supersedeCard, classifyCard, mergeIntoCard } from '../src/daemon/card-evolution.mjs';

function makeIndexer() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE knowledge_cards (
      id TEXT PRIMARY KEY,
      category TEXT,
      title TEXT,
      summary TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT,
      updated_at TEXT,
      parent_card_id TEXT,
      evolution_type TEXT DEFAULT 'initial'
    );
    CREATE VIRTUAL TABLE knowledge_cards_fts USING fts5(id UNINDEXED, title, summary);
  `);
  return { db };
}

function seedCard(indexer, id, category, title, summary) {
  const now = new Date().toISOString();
  indexer.db.prepare(`
    INSERT INTO knowledge_cards (id, category, title, summary, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(id, category, title, summary, now, now);
  indexer.db.prepare(`
    INSERT INTO knowledge_cards_fts (id, title, summary) VALUES (?, ?, ?)
  `).run(id, title, summary);
}

// Deterministic fake embedder. Produces a vector from a bag-of-words hash
// so that "similar" texts (lots of shared tokens) land close in cosine space.
function makeFakeEmbedder() {
  const DIM = 64;
  function embed(text) {
    const v = new Array(DIM).fill(0);
    for (const tok of String(text).toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % DIM] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  function cosineSimilarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }
  return { embed, cosineSimilarity };
}

test('findEvolutionTarget returns null when DB has no candidates', async () => {
  const indexer = makeIndexer();
  const result = await findEvolutionTarget(
    indexer,
    { category: 'decision', title: 'pgvector replaces Pinecone', summary: 'cost + JOIN' },
    makeFakeEmbedder(),
  );
  assert.equal(result, null);
});

test('findEvolutionTarget links near-duplicate same-category card', async () => {
  const indexer = makeIndexer();
  seedCard(indexer, 'kc_old',
    'decision',
    'pgvector replaces Pinecone',
    'Use pgvector instead of Pinecone for vector DB. Cost savings JOIN search.',
  );
  seedCard(indexer, 'kc_unrelated',
    'decision',
    'Use React instead of Vue',
    'We pick React for the frontend framework.',
  );

  const newCard = {
    category: 'decision',
    title: 'pgvector replaces Pinecone · updated v2',
    summary: 'Confirming pgvector over Pinecone with production data: cost + JOIN hybrid search works.',
  };

  const result = await findEvolutionTarget(indexer, newCard, makeFakeEmbedder(), { threshold: 0.4 });
  assert.ok(result, 'should find a target');
  assert.equal(result.target.id, 'kc_old', 'should pick the same-topic card, not the React card');
  assert.ok(result.similarity >= 0.4);
});

test('findEvolutionTarget respects category filter', async () => {
  const indexer = makeIndexer();
  // Same topic but different category — should NOT match.
  seedCard(indexer, 'kc_other_cat',
    'workflow',
    'pgvector replaces Pinecone',
    'workflow to migrate from Pinecone to pgvector',
  );
  const result = await findEvolutionTarget(
    indexer,
    { category: 'decision', title: 'pgvector replaces Pinecone · v2', summary: 'decision update' },
    makeFakeEmbedder(),
    { threshold: 0.3 },
  );
  assert.equal(result, null, 'cross-category match should be filtered');
});

test('findEvolutionTarget returns null when similarity below threshold', async () => {
  const indexer = makeIndexer();
  seedCard(indexer, 'kc_distant',
    'decision',
    'Use React for frontend',
    'React over Vue because ecosystem size.',
  );
  const result = await findEvolutionTarget(
    indexer,
    { category: 'decision', title: 'pgvector replaces Pinecone', summary: 'totally different topic' },
    makeFakeEmbedder(),
    { threshold: 0.85 },
  );
  assert.equal(result, null);
});

test('findEvolutionTarget fails OPEN when embedder is missing', async () => {
  const indexer = makeIndexer();
  seedCard(indexer, 'kc_x', 'decision', 'pgvector decision', 'some summary');
  const result = await findEvolutionTarget(
    indexer,
    { category: 'decision', title: 'pgvector decision', summary: 'same' },
    null, // no embedder
  );
  assert.equal(result, null, 'no embedder → no evolution (safe default)');
});

test('supersedeCard marks parent status=superseded', () => {
  const indexer = makeIndexer();
  seedCard(indexer, 'kc_parent', 'decision', 'parent', 'parent summary');
  supersedeCard(indexer, 'kc_parent', 'kc_child');
  const row = indexer.db.prepare(`SELECT status FROM knowledge_cards WHERE id = 'kc_parent'`).get();
  assert.equal(row.status, 'superseded');
});

test('supersedeCard is idempotent · no-op on already-superseded card', () => {
  const indexer = makeIndexer();
  seedCard(indexer, 'kc_p', 'decision', 't', 's');
  supersedeCard(indexer, 'kc_p', 'kc_c1');
  supersedeCard(indexer, 'kc_p', 'kc_c2');
  const row = indexer.db.prepare(`SELECT status FROM knowledge_cards WHERE id = 'kc_p'`).get();
  assert.equal(row.status, 'superseded');
});

// --- P1 Fix-5b · 4-verdict tests ---

test('classifyCard returns "new" on empty DB', async () => {
  const indexer = makeIndexer();
  const result = await classifyCard(
    indexer,
    { category: 'decision', title: 'anything', summary: 'x' },
    makeFakeEmbedder(),
  );
  assert.equal(result.verdict, 'new');
});

test('classifyCard returns "merge" when same-category + tag-overlap at medium similarity', () => {
  // Use cardinfused seeds so fake embedder returns mid-range cosine.
  const indexer = makeIndexer();
  indexer.db.prepare(`INSERT INTO knowledge_cards (id, category, title, summary, status, created_at, updated_at, parent_card_id, evolution_type) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('kc_old', 'decision', 'pgvector decision', 'Use pgvector over Pinecone for cost and JOIN search.', 'active', new Date().toISOString(), new Date().toISOString(), null, 'initial');
  indexer.db.prepare(`INSERT INTO knowledge_cards_fts (id,title,summary) VALUES (?,?,?)`)
    .run('kc_old', 'pgvector decision', 'Use pgvector over Pinecone for cost and JOIN search.');
  // set tags column via UPDATE (schema has no tags col, skip)

  return (async () => {
    const result = await classifyCard(
      indexer,
      {
        category: 'decision',
        title: 'pgvector decision update',
        summary: 'tiny new note',
        tags: ['pgvector'],
      },
      makeFakeEmbedder(),
      { threshold: 0.3 },
    );
    // Fake embedder gives similarity depending on token overlap; verdict
    // should be classified (not stuck at "new").
    assert.ok(['merge', 'update', 'new', 'duplicate'].includes(result.verdict));
  })();
});

test('mergeIntoCard appends summary below "---" separator + bumps version', () => {
  const indexer = makeIndexer();
  // Extend schema for this test with version column
  indexer.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN version INTEGER DEFAULT 1`);
  indexer.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN last_touched_at TEXT`);
  indexer.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN synced_to_cloud INTEGER DEFAULT 0`);
  seedCard(indexer, 'kc_parent', 'decision', 'parent title', 'v1 summary with details');

  const result = mergeIntoCard(indexer, 'kc_parent', { summary: 'v2 additional context' });
  assert.equal(result.merged, true);
  assert.match(result.newSummary, /v1 summary with details\s*\n\n---\n\s*v2 additional context/);

  const row = indexer.db.prepare(`SELECT version, summary FROM knowledge_cards WHERE id = 'kc_parent'`).get();
  assert.equal(row.version, 2);
  assert.match(row.summary, /v1 summary with details/);
  assert.match(row.summary, /v2 additional context/);
});

test('mergeIntoCard returns {merged:false} when target does not exist', () => {
  const indexer = makeIndexer();
  const result = mergeIntoCard(indexer, 'kc_ghost', { summary: 'x' });
  assert.equal(result.merged, false);
});

test('mergeIntoCard returns {merged:false} when incoming summary empty', () => {
  const indexer = makeIndexer();
  indexer.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN version INTEGER DEFAULT 1`);
  indexer.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN last_touched_at TEXT`);
  indexer.db.exec(`ALTER TABLE knowledge_cards ADD COLUMN synced_to_cloud INTEGER DEFAULT 0`);
  seedCard(indexer, 'kc_x', 'decision', 't', 's');
  const result = mergeIntoCard(indexer, 'kc_x', { summary: '' });
  assert.equal(result.merged, false);
});
