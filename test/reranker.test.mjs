/**
 * Tests for reranker.mjs — F-031 Phase 1 Task 5
 *
 * Covers:
 * - Method A: Signal fusion (BM25 + semantic + recency + salience)
 * - Method B: LLM rerank skeleton (mock LLM)
 * - Feature flag routing
 * - Edge cases: empty results, uniform scores, missing signals
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { rerank, rerankWithFusion, rerankWithLLM, getRerankMethod } from '../src/core/reranker.mjs';

// ---- Test Data ----

function makeResults() {
  return [
    {
      id: 'r1', title: 'JWT rotation', summary: 'How to rotate JWT tokens',
      rank: -10, embeddingScore: 0.9, salience_score: 1.5, created_at: new Date().toISOString(),
      type: 'knowledge_card',
    },
    {
      id: 'r2', title: 'Redis caching', summary: 'Redis caching patterns',
      rank: -5, embeddingScore: 0.7, salience_score: 1.0, created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
      type: 'knowledge_card',
    },
    {
      id: 'r3', title: 'Old deployment note', summary: 'Deployment from last month',
      rank: -2, embeddingScore: 0.4, salience_score: 0.6, created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
      type: 'session_summary',
    },
    {
      id: 'r4', title: 'Docker compose', summary: 'Docker compose setup',
      rank: -8, embeddingScore: 0.85, salience_score: 1.2, created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      type: 'decision',
    },
  ];
}

// ---- Method A: Signal Fusion ----

describe('rerankWithFusion', () => {
  it('returns results sorted by rerankScore', () => {
    const results = makeResults();
    const ranked = rerankWithFusion(results, 'JWT tokens');

    assert.ok(ranked.length === 4);
    // Results should be sorted descending by rerankScore
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].rerankScore >= ranked[i].rerankScore,
        `Result ${i-1} (${ranked[i-1].rerankScore.toFixed(3)}) should >= result ${i} (${ranked[i].rerankScore.toFixed(3)})`);
    }
  });

  it('adds rerankScore and _rerankSignals to each result', () => {
    const results = makeResults();
    const ranked = rerankWithFusion(results, 'test');

    for (const r of ranked) {
      assert.ok(typeof r.rerankScore === 'number');
      assert.ok(r._rerankSignals);
      assert.ok(typeof r._rerankSignals.bm25 === 'number');
      assert.ok(typeof r._rerankSignals.semantic === 'number');
      assert.ok(typeof r._rerankSignals.recency === 'number');
      assert.ok(typeof r._rerankSignals.cardType === 'number');
      assert.ok(typeof r._rerankSignals.growth === 'number');
    }
  });

  it('respects topK parameter', () => {
    const results = makeResults();
    const ranked = rerankWithFusion(results, 'test', { topK: 2 });
    assert.equal(ranked.length, 2);
  });

  it('handles empty results', () => {
    const ranked = rerankWithFusion([], 'test');
    assert.equal(ranked.length, 0);
  });

  it('handles single result', () => {
    const ranked = rerankWithFusion([makeResults()[0]], 'test');
    assert.equal(ranked.length, 1);
    assert.ok(typeof ranked[0].rerankScore === 'number');
  });

  it('handles results with missing scores gracefully', () => {
    const results = [
      { id: 'r1', title: 'No scores', created_at: new Date().toISOString() },
      { id: 'r2', title: 'Also no scores' },
    ];
    const ranked = rerankWithFusion(results, 'test');
    assert.equal(ranked.length, 2);
    // Should not throw
    for (const r of ranked) {
      assert.ok(typeof r.rerankScore === 'number');
      assert.ok(!isNaN(r.rerankScore));
    }
  });

  it('custom weights are applied', () => {
    const results = makeResults();
    // All weight on BM25 — should favor r1 (highest BM25)
    const bm25Heavy = rerankWithFusion(results, 'test', {
      weights: { bm25: 1.0, semantic: 0, recency: 0, salience: 0 },
    });
    assert.equal(bm25Heavy[0].id, 'r1');

    // All weight on semantic — should also favor r1 (highest embedding score)
    const semanticHeavy = rerankWithFusion(results, 'test', {
      weights: { bm25: 0, semantic: 1.0, recency: 0, salience: 0 },
    });
    assert.equal(semanticHeavy[0].id, 'r1');
  });
});

// ---- Method B: LLM Rerank ----

describe('rerankWithLLM', () => {
  it('calls LLM and applies scores', async () => {
    const results = makeResults();
    // LLM returns scores for pre-filtered results (order determined by fusion pre-filter)
    const mockLLM = mock.fn(async () => '[0.9, 0.3, 0.1, 0.7]');

    const ranked = await rerankWithLLM(results, 'test query', {
      llmInfer: mockLLM,
    });

    assert.ok(mockLLM.mock.calls.length === 1);
    // First result should have score 0.9 (highest LLM score)
    assert.equal(ranked[0].rerankScore, 0.9);
    assert.equal(ranked[0]._rerankMethod, 'llm');
    // All results should have LLM method tag
    for (const r of ranked) {
      assert.equal(r._rerankMethod, 'llm');
    }
  });

  it('handles LLM returning markdown-fenced JSON', async () => {
    const results = makeResults().slice(0, 2);
    const mockLLM = mock.fn(async () => '```json\n[0.8, 0.2]\n```');

    const ranked = await rerankWithLLM(results, 'test', { llmInfer: mockLLM });
    assert.equal(ranked[0].id, 'r1');
  });

  it('falls back to 0.5 on invalid LLM output', async () => {
    const results = makeResults().slice(0, 2);
    const mockLLM = mock.fn(async () => 'not valid json');

    const ranked = await rerankWithLLM(results, 'test', { llmInfer: mockLLM });
    assert.equal(ranked.length, 2);
    // All should get 0.5 default
    for (const r of ranked) {
      assert.equal(r.rerankScore, 0.5);
    }
  });
});

// ---- Feature Flag Routing ----

describe('rerank (main entry)', () => {
  const originalEnv = process.env.RERANK_METHOD;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RERANK_METHOD;
    } else {
      process.env.RERANK_METHOD = originalEnv;
    }
  });

  it('default is "none" (post-F-053 flip) — results pass through untouched', async () => {
    // F-053 flipped the default from 'fusion' to 'none' after a 20Q
    // benchmark showed fusion dropping LongMemEval R@5 from 90% to 60%.
    // Users who want fusion must explicitly set RERANK_METHOD=fusion.
    delete process.env.RERANK_METHOD;
    const results = makeResults();
    const ranked = await rerank(results, 'test');
    assert.equal(ranked.length, results.length);
    assert.equal(ranked[0].rerankScore, undefined,
      'default path must NOT attach rerankScore — it is the passthrough');
  });

  it('uses fusion when RERANK_METHOD=fusion is set explicitly', async () => {
    process.env.RERANK_METHOD = 'fusion';
    try {
      const results = makeResults();
      const ranked = await rerank(results, 'test');
      assert.ok(ranked.length > 0);
      assert.ok(ranked[0].rerankScore !== undefined);
    } finally {
      delete process.env.RERANK_METHOD;
    }
  });

  it('returns unmodified results when method is none', async () => {
    process.env.RERANK_METHOD = 'none';
    const results = makeResults();
    const ranked = await rerank(results, 'test');
    assert.equal(ranked.length, results.length);
    assert.equal(ranked[0].id, results[0].id); // Same order
  });

  it('falls back to fusion when llm method but no llmInfer', async () => {
    process.env.RERANK_METHOD = 'llm';
    const results = makeResults();
    const ranked = await rerank(results, 'test');
    // Should fall back to fusion (no llmInfer provided)
    assert.ok(ranked.length > 0);
    assert.ok(ranked[0].rerankScore !== undefined);
  });
});

// ---- LLM rerank error fallback ----

describe('rerankWithLLM — error fallback', () => {
  const originalEnv = process.env.RERANK_METHOD;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RERANK_METHOD;
    } else {
      process.env.RERANK_METHOD = originalEnv;
    }
  });

  it('LLM rerank falls back to fusion on llmInfer error', async () => {
    process.env.RERANK_METHOD = 'llm';
    const results = makeResults();
    const throwingLLM = mock.fn(async () => { throw new Error('LLM service unavailable'); });

    // rerank() catches the error from rerankWithLLM and falls back to fusion
    const ranked = await rerank(results, 'JWT tokens', { llmInfer: throwingLLM });

    assert.ok(throwingLLM.mock.calls.length === 1);
    assert.equal(ranked.length, 4);
    // Should be sorted descending by rerankScore (fusion fallback)
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].rerankScore >= ranked[i].rerankScore,
        `Result ${i-1} should have score >= result ${i}`);
    }
    // Should have rerankScore from fusion (not LLM _rerankMethod tag)
    for (const r of ranked) {
      assert.ok(typeof r.rerankScore === 'number');
      assert.ok(!isNaN(r.rerankScore));
    }
  });
});

// ---- parseLLMScores padding (indirect) ----

describe('rerankWithLLM — parseLLMScores pads short arrays', () => {
  it('parseLLMScores pads short arrays with 0.5', async () => {
    // 5 items but LLM returns only 3 scores
    const results = [
      { id: 'a1', title: 'Item 1', summary: 'First item', rank: -10, embeddingScore: 0.9, salience_score: 1.0, created_at: new Date().toISOString() },
      { id: 'a2', title: 'Item 2', summary: 'Second item', rank: -8, embeddingScore: 0.8, salience_score: 0.9, created_at: new Date().toISOString() },
      { id: 'a3', title: 'Item 3', summary: 'Third item', rank: -6, embeddingScore: 0.7, salience_score: 0.8, created_at: new Date().toISOString() },
      { id: 'a4', title: 'Item 4', summary: 'Fourth item', rank: -4, embeddingScore: 0.6, salience_score: 0.7, created_at: new Date().toISOString() },
      { id: 'a5', title: 'Item 5', summary: 'Fifth item', rank: -2, embeddingScore: 0.5, salience_score: 0.6, created_at: new Date().toISOString() },
    ];
    // LLM returns only 3 scores — remaining 2 should be padded to 0.5
    const mockLLM = mock.fn(async () => '[0.9, 0.1, 0.7]');

    const ranked = await rerankWithLLM(results, 'test query', { llmInfer: mockLLM });

    assert.equal(ranked.length, 5);
    // Collect all scores: 3 from LLM (0.9, 0.1, 0.7) + 2 padded (0.5, 0.5)
    const scores = ranked.map(r => r.rerankScore);
    const paddedCount = scores.filter(s => s === 0.5).length;
    assert.ok(paddedCount >= 2, `Expected at least 2 items padded to 0.5, got ${paddedCount}`);
    // All items should have _rerankMethod = 'llm'
    for (const r of ranked) {
      assert.equal(r._rerankMethod, 'llm');
    }
  });
});

// ---- All-zero scores ----

describe('rerankWithFusion — all-zero scores', () => {
  it('all-zero scores normalize to 0.5', () => {
    const results = [
      { id: 'z1', title: 'Zero A', bm25Score: 0, embeddingScore: 0, salience_score: 0, created_at: new Date().toISOString() },
      { id: 'z2', title: 'Zero B', bm25Score: 0, embeddingScore: 0, salience_score: 0, created_at: new Date().toISOString() },
      { id: 'z3', title: 'Zero C', bm25Score: 0, embeddingScore: 0, salience_score: 0, created_at: new Date().toISOString() },
    ];
    const ranked = rerankWithFusion(results, 'test');

    assert.equal(ranked.length, 3);
    for (const r of ranked) {
      assert.ok(typeof r.rerankScore === 'number');
      assert.ok(!isNaN(r.rerankScore));
      // BM25, semantic all-zero → minMaxNormalize returns 0.5 for each
      assert.equal(r._rerankSignals.bm25, 0.5, 'BM25 should normalize to 0.5 when all equal');
      assert.equal(r._rerankSignals.semantic, 0.5, 'Semantic should normalize to 0.5 when all equal');
    }
  });
});
