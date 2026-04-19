/**
 * F-055 Failure Mode · persona gate performance.
 *
 * ACCEPTANCE: Even under an extreme load (10,000 persona cards in the
 * active pool, simulating years of long-tail personal_preference growth
 * or a malicious paste-in), `filterPersonaByRelevance` must complete in
 * under 50ms so it never blocks an `awareness_init` MCP response.
 *
 * If this ever regresses, the fix is to degrade gracefully to the
 * confidence-only filter (skip BM25 search) once the candidate set
 * exceeds a configurable threshold.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterPersonaByRelevance } from '../src/daemon/helpers.mjs';

const BUDGET_MS = 50;
const CARD_COUNT = 10_000;

function makeCard(i) {
  return {
    id: `kc_perf_${i}`,
    category: i % 7 === 0
      ? 'personal_preference'
      : i % 7 === 1 ? 'activity_preference'
      : i % 7 === 2 ? 'important_detail'
      : i % 7 === 3 ? 'plan_intention'
      : i % 7 === 4 ? 'career_info'
      : i % 7 === 5 ? 'health_info'
      : 'custom_misc',
    title: `persona card ${i}`,
    summary: `this is persona card number ${i}, body text that simulates a real preference entry`,
    // Roughly 1 in 200 is a high-confidence persona that survives the
    // empty-query branch — this mirrors a realistic distribution where
    // a handful of long-term prefs dominate.
    confidence: i % 200 === 0 ? 0.95 : 0.6 + ((i % 30) / 100),
    status: 'active',
  };
}

function makeFastIndexer(matchedCount = 50) {
  // Simulates a BM25 indexer that returns `matchedCount` matches —
  // reasonable upper bound for FTS5 at 10k cards.
  return {
    searchKnowledge: (_focus, _opts) => {
      const out = [];
      for (let i = 0; i < matchedCount; i++) {
        out.push({ id: `kc_perf_${i * 13 % CARD_COUNT}` });
      }
      return out;
    },
  };
}

describe('F-055 failure mode · persona gate under 10k-card load', () => {
  const cards = Array.from({ length: CARD_COUNT }, (_, i) => makeCard(i));

  it(`focus-present path: 10k cards filter in under ${BUDGET_MS}ms`, () => {
    const indexer = makeFastIndexer(50);
    const t0 = process.hrtime.bigint();
    const result = filterPersonaByRelevance(cards, indexer, 'some focus query');
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    assert.ok(
      elapsedMs < BUDGET_MS,
      `persona gate took ${elapsedMs.toFixed(2)}ms on ${CARD_COUNT} cards — exceeded ${BUDGET_MS}ms budget`,
    );
    assert.ok(result.length <= 3, `result cap should hold under load (got ${result.length})`);
  });

  it(`empty-focus path: 10k cards confidence-filter in under ${BUDGET_MS}ms`, () => {
    const t0 = process.hrtime.bigint();
    const result = filterPersonaByRelevance(cards, null, '');
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    assert.ok(
      elapsedMs < BUDGET_MS,
      `empty-focus persona gate took ${elapsedMs.toFixed(2)}ms on ${CARD_COUNT} cards — exceeded ${BUDGET_MS}ms budget`,
    );
    assert.ok(result.length <= 3);
  });

  it('graceful fallback: broken indexer still returns under budget', () => {
    const broken = { searchKnowledge: () => { throw new Error('index offline'); } };
    const t0 = process.hrtime.bigint();
    const result = filterPersonaByRelevance(cards, broken, 'some query');
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    assert.ok(
      elapsedMs < BUDGET_MS,
      `fallback path took ${elapsedMs.toFixed(2)}ms on ${CARD_COUNT} cards — exceeded ${BUDGET_MS}ms budget`,
    );
    // On fallback, only high-confidence personas survive.
    for (const c of result) {
      assert.ok((c.confidence ?? 0) >= 0.9,
        `fallback must preserve only high-confidence personas, got confidence=${c.confidence}`);
    }
  });
});
