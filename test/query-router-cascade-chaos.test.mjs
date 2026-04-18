/**
 * F-053 Phase 3 · L3 chaos for query-router × unifiedCascadeSearch integration.
 *
 * Verifies that malformed strategies from a failed classifier never crash
 * `unifiedCascadeSearch` — the engine should silently fall back to the
 * Phase 1c budget-tier default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SearchEngine } from '../src/core/search.mjs';

function stubEngine(recall) {
  const e = Object.create(SearchEngine.prototype);
  e.indexer = null;
  e.store = null;
  e.embedder = null;
  e.cloud = null;
  e.recall = recall;
  return e;
}

// A pool with both types, 30 items — enough to trigger shaping under any ratio.
function buildMixedPool(numCards = 15, numRaws = 15) {
  const pool = [];
  const max = Math.max(numCards, numRaws);
  for (let i = 0; i < max; i++) {
    if (i < numCards) pool.push({ id: `c${i}`, title: 'C', summary: 's', type: 'knowledge_card' });
    if (i < numRaws) pool.push({ id: `r${i}`, title: 'R', summary: 's', type: 'turn_summary' });
  }
  return pool;
}

test('L3 strategy=null → Phase 1c budget-tier default still applies', async () => {
  const engine = stubEngine(async () => buildMixedPool());
  const out = await engine.unifiedCascadeSearch('q', {
    tokenBudget: 30_000, // mixed tier → rawRatio 0.375
    limit: 8,
    strategy: null,
  });
  assert.equal(out.results.length, 8);
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  // mixed tier at limit=8 → 3 raws + 5 cards
  assert.equal(rawCount, 3, 'null strategy falls back to Phase 1c mixed tier');
});

test('L3 strategy with NaN rawRatio → fallback, no throw', async () => {
  const engine = stubEngine(async () => buildMixedPool());
  const out = await engine.unifiedCascadeSearch('q', {
    tokenBudget: 30_000,
    limit: 8,
    strategy: { rawRatio: NaN, graphBoost: 0 },
  });
  assert.equal(out.results.length, 8);
  // NaN is not Finite → fallback to Phase 1c mixed tier (3 raws).
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  assert.equal(rawCount, 3);
});

test('L3 strategy with out-of-range rawRatio is clamped to [0,1]', async () => {
  // Use raw-heavy budget (pull=25) so pool has enough of each type to actually
  // demonstrate the clamp. Interleaved 30c+30r → top-25 has ≈12-13 of each.
  const engine = stubEngine(async () => buildMixedPool(30, 30));

  // rawRatio = 2.0 → clamped to 1.0 → all raws (plus backfill since raw pool
  // in top-25 caps at ~13 raws; shortage filled from remaining cards).
  const out = await engine.unifiedCascadeSearch('q', {
    tokenBudget: 60_000,
    limit: 10,
    strategy: { rawRatio: 2.0, graphBoost: 0 },
  });
  assert.equal(out.results.length, 10);
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  assert.ok(rawCount >= 10,
    `rawRatio 2.0 clamps to 1.0 and fills with 10 raws (plenty avail in pool-25): got ${rawCount}`);

  // rawRatio = -0.5 → clamped to 0 → all cards.
  const out2 = await engine.unifiedCascadeSearch('q', {
    tokenBudget: 60_000,
    limit: 10,
    strategy: { rawRatio: -0.5, graphBoost: 0 },
  });
  const cardCount2 = out2.results.filter((r) => r.type === 'knowledge_card').length;
  assert.ok(cardCount2 >= 10,
    `rawRatio -0.5 clamps to 0 and fills with 10 cards: got ${cardCount2}`);
});

test('L3 strategy with non-finite graphBoost falls back to base graph limit', async () => {
  let capturedGraphLimit = 0;
  const engine = stubEngine(async () => buildMixedPool());
  engine._searchGraphNodesFts = (_q, limit) => {
    capturedGraphLimit = limit;
    return [];
  };
  engine.buildFtsQuery = (q) => q;
  await engine.unifiedCascadeSearch('q', {
    tokenBudget: 5_000,
    limit: 10,
    strategy: { rawRatio: 0.5, graphBoost: Infinity },
  });
  // Infinity is not Finite → fallback to base graph limit (ceil(pull/3)=4 for pull=10).
  assert.ok(capturedGraphLimit >= 3 && capturedGraphLimit <= 10,
    `graph limit must fall back to base range, got ${capturedGraphLimit}`);
});

test('L3 strategy with valid graphBoost multiplies the graph limit', async () => {
  let capturedGraphLimit = 0;
  const engine = stubEngine(async () => buildMixedPool());
  engine._searchGraphNodesFts = (_q, limit) => {
    capturedGraphLimit = limit;
    return [];
  };
  engine.buildFtsQuery = (q) => q;
  await engine.unifiedCascadeSearch('q', {
    tokenBudget: 5_000, // card-only tier → pull=limit=10
    limit: 10,
    strategy: { rawRatio: 0.5, graphBoost: 1.0 }, // should roughly double graph limit
  });
  // base = ceil(pull/3) for pull=10 = 4; boosted = round(4 * (1+1.0)) = 8.
  assert.equal(capturedGraphLimit, 8,
    `graphBoost=1.0 should double graph limit from 4 to 8, got ${capturedGraphLimit}`);
});

test('L3 strategy={} (empty object) → fallback to Phase 1c default', async () => {
  const engine = stubEngine(async () => buildMixedPool());
  const out = await engine.unifiedCascadeSearch('q', {
    tokenBudget: 30_000,
    limit: 8,
    strategy: {},
  });
  assert.equal(out.results.length, 8);
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  assert.equal(rawCount, 3, 'empty strategy object falls back to Phase 1c mixed tier');
});

test('L3 strategy overrides Phase 1c tier (raw-heavy budget flipped to card-heavy via rawRatio 0.1)', async () => {
  // Use raw-heavy budget (pull=25) so the pool is big enough for shaping to
  // actually move the needle. buildMixedPool(20, 20) interleaved → top-25
  // has ≈13 raws + 12 cards. rawRatio=0.1 → rawQuota=1, cardQuota=9.
  const engine = stubEngine(async () => buildMixedPool(20, 20));
  const out = await engine.unifiedCascadeSearch('q', {
    tokenBudget: 60_000, // raw-heavy tier default = 0.70
    limit: 10,
    strategy: { rawRatio: 0.1, graphBoost: 0 }, // fact-what archetype flips it
  });
  assert.equal(out.results.length, 10);
  const cardCount = out.results.filter((r) => r.type === 'knowledge_card').length;
  const rawCount = out.results.filter((r) => r.type === 'turn_summary').length;
  assert.ok(cardCount >= 8,
    `strategy override must dominate: expected ≥8 cards, got ${cardCount} (${rawCount} raws)`);
});
