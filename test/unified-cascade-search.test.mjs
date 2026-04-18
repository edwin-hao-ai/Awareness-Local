/**
 * F-053 Phase 1 · unifiedCascadeSearch — TDD harness
 *
 * Verifies the single-parameter entry point that wraps recall() with
 * sensible defaults and applies token-budget-driven result pulling.
 *
 * Scope: skeleton behaviour only. Real cascade (memories + cards + graph
 * into one RRF pool) is still provided by the existing recall() chain;
 * this file locks the public contract:
 *   1. Single-parameter API: `unifiedCascadeSearch(query, opts)`
 *   2. Empty / invalid query → `{ results: [] }`
 *   3. Delegates to recall() with fixed internal defaults
 *   4. Token-budget tiers pull different item counts
 *      - budget >= 50_000  → pulls >= 25 items (raw-heavy)
 *      - budget 20_000-49_999 → pulls >= 12 items (mixed)
 *      - budget <  20_000 → pulls `limit` items (card-only)
 *   5. Result items carry NO mode/channel field (opacity)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SearchEngine } from '../src/core/search.mjs';

function stubEngine(recallImpl) {
  const engine = Object.create(SearchEngine.prototype);
  engine.indexer = null;
  engine.store = null;
  engine.embedder = null;
  engine.cloud = null;
  engine.recall = recallImpl;
  return engine;
}

test('unifiedCascadeSearch returns empty results for empty query', async () => {
  const engine = stubEngine(async () => { throw new Error('recall should not be called'); });
  const out = await engine.unifiedCascadeSearch('');
  assert.deepEqual(out, { results: [] });
  const out2 = await engine.unifiedCascadeSearch('   ');
  assert.deepEqual(out2, { results: [] });
  const out3 = await engine.unifiedCascadeSearch(null);
  assert.deepEqual(out3, { results: [] });
});

test('unifiedCascadeSearch delegates to recall with hybrid + multi_level defaults', async () => {
  let capturedParams = null;
  const engine = stubEngine(async (params) => {
    capturedParams = params;
    return [{ id: 'mem_a', title: 'A', summary: 'a', score: 0.9 }];
  });

  const out = await engine.unifiedCascadeSearch('why did we choose pgvector');
  assert.equal(capturedParams.semantic_query, 'why did we choose pgvector');
  assert.equal(capturedParams.scope, 'all');
  assert.equal(capturedParams.recall_mode, 'hybrid');
  assert.equal(capturedParams.multi_level, true);
  assert.equal(capturedParams.cluster_expand, true);
  assert.equal(capturedParams.detail, 'summary');
  assert.equal(capturedParams.include_installed, true);
  assert.ok(capturedParams.token_budget > 0);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, 'mem_a');
});

test('unifiedCascadeSearch at budget >= 50K pulls raw-heavy (>= 25 items)', async () => {
  let capturedLimit = 0;
  const engine = stubEngine(async (params) => {
    capturedLimit = params.limit;
    return [];
  });
  await engine.unifiedCascadeSearch('query', { tokenBudget: 60_000, limit: 10 });
  assert.ok(capturedLimit >= 25, `expected limit >= 25, got ${capturedLimit}`);
});

test('unifiedCascadeSearch at budget 20-50K pulls mixed (>= 12 items)', async () => {
  let capturedLimit = 0;
  const engine = stubEngine(async (params) => {
    capturedLimit = params.limit;
    return [];
  });
  await engine.unifiedCascadeSearch('query', { tokenBudget: 30_000, limit: 10 });
  assert.ok(capturedLimit >= 12, `expected limit >= 12, got ${capturedLimit}`);
});

test('unifiedCascadeSearch at budget < 20K pulls exactly `limit` items', async () => {
  let capturedLimit = 0;
  const engine = stubEngine(async (params) => {
    capturedLimit = params.limit;
    return [];
  });
  await engine.unifiedCascadeSearch('query', { tokenBudget: 5_000, limit: 8 });
  assert.equal(capturedLimit, 8);
});

test('unifiedCascadeSearch default budget falls into card-only tier', async () => {
  let capturedBudget = 0;
  const engine = stubEngine(async (params) => {
    capturedBudget = params.token_budget;
    return [];
  });
  await engine.unifiedCascadeSearch('query');
  assert.ok(capturedBudget > 0 && capturedBudget < 20_000,
    `default budget should be card-tier (<20K), got ${capturedBudget}`);
});

test('unifiedCascadeSearch result items carry no mode/channel field (opacity)', async () => {
  const engine = stubEngine(async () => [
    { id: 'a', title: 'T', summary: 'S', type: 'memory', score: 0.9, source_channel: 'hidden' },
    { id: 'b', title: 'T', summary: 'S', type: 'knowledge_card', score: 0.8, cascade_layer: 'hidden' },
  ]);
  const out = await engine.unifiedCascadeSearch('query');
  for (const r of out.results) {
    assert.equal(r.source_channel, undefined, 'source_channel must not leak');
    assert.equal(r.cascade_layer, undefined, 'cascade_layer must not leak');
    assert.equal(r.recall_mode, undefined, 'recall_mode must not leak');
  }
});

test('unifiedCascadeSearch legacy-param deprecation: opts.limit is honored but no multi-param escape', async () => {
  // The function accepts ONLY (query, opts) — positional misuse falls back safely.
  const engine = stubEngine(async (params) => {
    // Forbid the function from passing anything beyond its fixed whitelist.
    const allowed = new Set([
      'semantic_query', 'scope', 'recall_mode', 'limit', 'detail',
      'multi_level', 'cluster_expand', 'include_installed', 'token_budget',
      'keyword_query', 'agent_role', 'current_source',
    ]);
    for (const key of Object.keys(params)) {
      assert.ok(allowed.has(key), `unexpected param leaked to recall(): ${key}`);
    }
    return [];
  });
  // Pass bogus extra opts — they should NOT leak through.
  await engine.unifiedCascadeSearch('query', { tokenBudget: 1000, limit: 5, scope: 'bogus', detail: 'bogus' });
});

// ----------------------------------------------------------------------------
// Phase 1b · 3-source cascade RRF (memory + card + graph)
// ----------------------------------------------------------------------------

function stubEngineWithGraph(recallImpl, graphImpl) {
  const engine = stubEngine(recallImpl);
  engine._searchGraphNodesFts = graphImpl;
  engine.buildFtsQuery = (sem, kw) => (sem || kw || '').trim() || '';
  return engine;
}

test('unifiedCascadeSearch fuses graph_nodes FTS results alongside memory/card', async () => {
  const engine = stubEngineWithGraph(
    async () => [
      { id: 'mem_1', title: 'Memory 1', summary: 's1', type: 'memory', score: 0.9 },
      { id: 'card_1', title: 'Card 1', summary: 's2', type: 'knowledge_card', score: 0.8 },
    ],
    (_q, _limit) => [
      { id: 'graph_1', title: 'File README.md', summary: 'contents', type: 'workspace_file', score: 0.7 },
    ],
  );
  const out = await engine.unifiedCascadeSearch('why pgvector');
  const ids = new Set(out.results.map((r) => r.id));
  assert.ok(ids.has('mem_1'), 'memory result must appear');
  assert.ok(ids.has('graph_1'), 'graph_nodes result must fuse into the pool');
  assert.equal(out.results.length, 3, 'no dedup collision on distinct ids');
});

test('unifiedCascadeSearch: items hit in BOTH recall and graph lists get higher fused rank', async () => {
  // graph_shared appears at rank 0 in graph list AND rank 2 in recall list;
  // mem_uniq only at rank 0 in recall. Fused: graph_shared > mem_uniq.
  const engine = stubEngineWithGraph(
    async () => [
      { id: 'mem_uniq', title: 'Unique mem', summary: 's', type: 'memory' },
      { id: 'mem_b', title: 'B', summary: 's', type: 'memory' },
      { id: 'graph_shared', title: 'Shared', summary: 's', type: 'workspace_file' },
    ],
    () => [
      { id: 'graph_shared', title: 'Shared', summary: 's', type: 'workspace_file' },
      { id: 'graph_other', title: 'Other', summary: 's', type: 'workspace_file' },
    ],
  );
  const out = await engine.unifiedCascadeSearch('q', { tokenBudget: 5000, limit: 4 });
  const sharedRank = out.results.findIndex((r) => r.id === 'graph_shared');
  const memUniqRank = out.results.findIndex((r) => r.id === 'mem_uniq');
  assert.ok(sharedRank >= 0 && memUniqRank >= 0, 'both must appear');
  assert.ok(sharedRank < memUniqRank,
    `dual-hit item should rank higher: graph_shared=${sharedRank} vs mem_uniq=${memUniqRank}`);
});

test('unifiedCascadeSearch strips retrieval-layer `source` field (opacity)', async () => {
  const engine = stubEngineWithGraph(
    async () => [
      { id: 'a', title: 'A', summary: 's', type: 'memory', source: 'local' },
    ],
    () => [
      { id: 'b', title: 'B', summary: 's', type: 'workspace_file', source: 'graph_fts' },
    ],
  );
  const out = await engine.unifiedCascadeSearch('q');
  for (const r of out.results) {
    assert.equal(r.source, undefined,
      `retrieval-layer 'source' field must be scrubbed (got ${r.source} on ${r.id})`);
  }
});

test('unifiedCascadeSearch survives graph FTS throwing', async () => {
  const engine = stubEngineWithGraph(
    async () => [{ id: 'mem_1', title: 'M', summary: 's', type: 'memory' }],
    () => { throw new Error('graph index corrupt'); },
  );
  const out = await engine.unifiedCascadeSearch('q');
  assert.equal(out.results.length, 1, 'should degrade to memory-only result');
  assert.equal(out.results[0].id, 'mem_1');
});

test('unifiedCascadeSearch survives recall throwing', async () => {
  const engine = stubEngineWithGraph(
    async () => { throw new Error('indexer down'); },
    () => [{ id: 'g', title: 'G', summary: 's', type: 'workspace_file' }],
  );
  const out = await engine.unifiedCascadeSearch('q');
  assert.equal(out.results.length, 1, 'should degrade to graph-only result');
  assert.equal(out.results[0].id, 'g');
});

test('unifiedCascadeSearch returns empty when both channels fail', async () => {
  const engine = stubEngineWithGraph(
    async () => { throw new Error('x'); },
    () => { throw new Error('y'); },
  );
  const out = await engine.unifiedCascadeSearch('q');
  assert.deepEqual(out.results, []);
});

// ----------------------------------------------------------------------------
// Phase 1c · Budget-tier shaping (raw vs card quotas)
// ----------------------------------------------------------------------------

/**
 * Build a synthetic pool of N cards + M raws, interleaved so that any top-K
 * slice contains both types — essential for testing bucket-split behaviour
 * under `_rrfFuseMany(lists, pull)` which only keeps the first `pull` items.
 */
function buildInterleavedPool(numCards, numRaws) {
  const pool = [];
  const max = Math.max(numCards, numRaws);
  for (let i = 0; i < max; i++) {
    if (i < numCards) {
      pool.push({ id: `card_${i}`, title: `Card ${i}`, summary: 's', type: 'knowledge_card' });
    }
    if (i < numRaws) {
      pool.push({ id: `raw_${i}`, title: `Raw ${i}`, summary: 's', type: 'turn_summary' });
    }
  }
  return pool;
}

test('Phase 1c · mixed tier (20K-50K) returns Acceptance-literal 3:5 raw:card at limit=8', async () => {
  // pull=max(12, limit)=12 so fused pool has enough items to trigger bucket split.
  // Interleaved 20c+20r → fused top-12 = 6c + 6r → shape picks 3r + 5c.
  const engine = stubEngine(async () => buildInterleavedPool(20, 20));
  const out = await engine.unifiedCascadeSearch('q', { tokenBudget: 30_000, limit: 8 });
  assert.equal(out.results.length, 8);
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  const cardCount = out.results.filter((r) => r.type === 'knowledge_card').length;
  // Acceptance Journey 3: "top-3 raw + top-5 card" mixed tier.
  assert.equal(rawCount, 3, `mixed tier: 3 raws expected at limit=8, got ${rawCount}`);
  assert.equal(cardCount, 5, `mixed tier: 5 cards expected at limit=8, got ${cardCount}`);
});

test('Phase 1c · raw-heavy tier (≥50K) is raw-dominant (≥60% raws)', async () => {
  // pull=max(25, limit)=25. Interleaved 30c+30r → fused top-25 has 12-13 raws.
  // Shape rawQuota=14 (round(20*0.7)), cardQuota=6. Backfill resolves the
  // shortfall from remaining cards — final raws floor = 12, ceiling = 13.
  const engine = stubEngine(async () => buildInterleavedPool(30, 30));
  const out = await engine.unifiedCascadeSearch('q', { tokenBudget: 60_000, limit: 20 });
  assert.equal(out.results.length, 20);
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  assert.ok(rawCount >= 12,
    `raw-heavy must keep ≥12 raws at limit=20, got ${rawCount}`);
  assert.ok(rawCount / out.results.length >= 0.6,
    `raw-heavy must be raw-dominant (≥60%), got ${rawCount}/${out.results.length}`);
});

test('Phase 1c · mixed tier backfills from cards when raws are scarce', async () => {
  // Only 2 raws available, mixed tier wants 3 raws at limit=8 → backfill 1 card.
  const engine = stubEngine(async () => buildInterleavedPool(20, 2));
  const out = await engine.unifiedCascadeSearch('q', { tokenBudget: 30_000, limit: 8 });
  assert.equal(out.results.length, 8, 'backfill must fill up to limit');
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  const cardCount = out.results.filter((r) => r.type === 'knowledge_card').length;
  assert.equal(rawCount, 2, 'all available raws must be taken');
  assert.equal(cardCount, 6, 'remaining slot filled from cards (5 quota + 1 backfill)');
});

test('Phase 1c · pool <= limit short-circuit preserves RRF order (no bucket split)', async () => {
  // pool size (3) < limit (10) → no bucket split, maintains dual-hit ordering.
  const engine = stubEngineWithGraph(
    async () => [
      { id: 'raw_a', title: 'A', summary: 's', type: 'turn_summary' },
      { id: 'card_x', title: 'X', summary: 's', type: 'knowledge_card' },
    ],
    () => [{ id: 'graph_g', title: 'G', summary: 's', type: 'workspace_file' }],
  );
  const out = await engine.unifiedCascadeSearch('q', { tokenBudget: 5_000, limit: 10 });
  assert.equal(out.results.length, 3, 'pool<=limit returns all items (no quota-forced drop)');
});

