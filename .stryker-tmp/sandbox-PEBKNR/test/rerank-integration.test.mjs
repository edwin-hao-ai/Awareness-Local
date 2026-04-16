// @ts-nocheck
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Rerank integration tests — verify reranker is correctly wired into the search
 * pipeline, fallback on error, and RERANK_METHOD routing.
 *
 * Also covers CJK content handling and realistic multi-signal scenarios.
 */

// === Shared realistic data ===

function makeResult(id, opts = {}) {
  return {
    id,
    title: opts.title || `Card ${id}`,
    summary: opts.summary || `Summary for ${id}`,
    content: opts.content || `Content for ${id}`,
    score: opts.score ?? 0.5,
    bm25Score: opts.bm25Score ?? -2.5,
    semanticScore: opts.semanticScore ?? 0.7,
    salienceScore: opts.salienceScore ?? 0.3,
    created_at: opts.created_at || new Date().toISOString(),
    source: opts.source || 'test',
    ...opts,
  };
}

// ============================================================================
// Tests for reranker.mjs — realistic multi-signal scenarios
// ============================================================================

describe('reranker integration: realistic scenarios', () => {

  it('should rank technical decision card above tangential note', async () => {
    const { rerankWithFusion } = await import('../src/core/reranker.mjs');

    const results = [
      makeResult('tangential', {
        title: 'Meeting notes from 2026-03-15',
        summary: 'Discussed team lunch plans and Q2 roadmap.',
        bm25Score: -1.0,
        semanticScore: 0.3,
        salienceScore: 0.1,
        created_at: new Date(Date.now() - 90 * 86400000).toISOString(), // 90 days ago
      }),
      makeResult('relevant', {
        title: 'PostgreSQL jsonb vs json 性能决策',
        summary: 'jsonb is 5-10x faster for GIN index lookups. Use jsonb for read-heavy workloads.',
        bm25Score: -5.0, // Strong BM25 match (more negative = better in FTS5)
        semanticScore: 0.92,
        salienceScore: 0.8,
        created_at: new Date(Date.now() - 5 * 86400000).toISOString(), // 5 days ago
      }),
      makeResult('partial', {
        title: 'Database indexing strategies overview',
        summary: 'B-tree, GIN, BRIN indexes explained with trade-offs.',
        bm25Score: -3.0,
        semanticScore: 0.65,
        salienceScore: 0.5,
        created_at: new Date(Date.now() - 30 * 86400000).toISOString(), // 30 days ago
      }),
    ];

    const query = 'PostgreSQL jsonb performance';
    const ranked = rerankWithFusion(results, query);

    // Most relevant card should be ranked first
    assert.equal(ranked[0].id, 'relevant', 'PostgreSQL jsonb card should rank first');
    assert.ok(ranked[0].rerankScore > ranked[1].rerankScore, 'Top result should have highest score');
    // Tangential meeting notes should be last
    assert.equal(ranked[2].id, 'tangential', 'Meeting notes should rank last');
  });

  it('should correctly handle CJK query with mixed-language results', async () => {
    const { rerankWithFusion } = await import('../src/core/reranker.mjs');

    const results = [
      makeResult('cn', {
        title: '数据库索引优化策略',
        summary: 'PostgreSQL の B-tree インデックス is 最も汎用的',
        bm25Score: -4.0,
        semanticScore: 0.85,
        salienceScore: 0.6,
      }),
      makeResult('en', {
        title: 'Database optimization guide',
        summary: 'A comprehensive guide to optimizing database queries.',
        bm25Score: -2.0,
        semanticScore: 0.5,
        salienceScore: 0.4,
      }),
    ];

    const ranked = rerankWithFusion(results, '数据库索引');
    // Both should have valid rerankScores
    assert.ok(ranked[0].rerankScore > 0, 'First result should have positive score');
    assert.ok(ranked[1].rerankScore > 0, 'Second result should have positive score');
    // Chinese card should rank higher (better BM25 + semantic)
    assert.equal(ranked[0].id, 'cn');
  });

  it('should handle results with missing score fields gracefully', async () => {
    const { rerankWithFusion } = await import('../src/core/reranker.mjs');

    const results = [
      { id: 'minimal-1', title: 'Minimal', summary: 'No scores at all' },
      { id: 'minimal-2', title: 'Also minimal', summary: 'Missing everything' },
    ];

    // Should not throw
    const ranked = rerankWithFusion(results, 'test query');
    assert.equal(ranked.length, 2);
    // Both should get default scores (not NaN)
    for (const r of ranked) {
      assert.ok(!Number.isNaN(r.rerankScore), `Score for ${r.id} should not be NaN`);
    }
  });

  it('should respect RERANK_METHOD=none and pass through unmodified', async () => {
    const { rerank, getRerankMethod } = await import('../src/core/reranker.mjs');

    process.env.RERANK_METHOD = 'none';
    assert.equal(getRerankMethod(), 'none');

    const results = [
      makeResult('a', { score: 0.9 }),
      makeResult('b', { score: 0.1 }),
    ];

    const ranked = await rerank(results, 'test');
    // In none mode, results should pass through unchanged
    assert.equal(ranked[0].id, 'a');
    assert.equal(ranked[1].id, 'b');

    delete process.env.RERANK_METHOD;
  });

  it('should fallback to fusion when LLM rerank throws', async () => {
    const { rerank } = await import('../src/core/reranker.mjs');

    process.env.RERANK_METHOD = 'llm';

    const results = [
      makeResult('a', { bm25Score: -4, semanticScore: 0.9 }),
      makeResult('b', { bm25Score: -1, semanticScore: 0.3 }),
    ];

    // No llmInfer provided → should gracefully fallback to fusion
    const ranked = await rerank(results, 'test query');
    assert.equal(ranked.length, 2);
    // Result 'a' should still rank first via fusion fallback
    assert.equal(ranked[0].id, 'a');

    delete process.env.RERANK_METHOD;
  });
});

// ============================================================================
// Tests for recency decay behavior (tested indirectly via rerankWithFusion)
// ============================================================================

describe('recency score behavior', () => {
  it('should rank recent items higher when other signals are equal', async () => {
    const { rerankWithFusion } = await import('../src/core/reranker.mjs');

    const now = new Date();
    // Two cards with identical BM25, semantic, and salience scores
    // — only recency differs
    const results = [
      makeResult('old', {
        title: 'Old card about testing',
        summary: 'Testing strategies for Node.js applications.',
        bm25Score: -3.0,
        semanticScore: 0.7,
        salienceScore: 0.5,
        created_at: new Date(now - 365 * 86400000).toISOString(), // 1 year ago
      }),
      makeResult('recent', {
        title: 'Recent card about testing',
        summary: 'Testing strategies for Node.js applications.',
        bm25Score: -3.0,
        semanticScore: 0.7,
        salienceScore: 0.5,
        created_at: new Date(now - 1 * 86400000).toISOString(), // yesterday
      }),
    ];

    const ranked = rerankWithFusion(results, 'Node.js testing');
    // Recent card should rank higher due to recency signal
    assert.equal(ranked[0].id, 'recent', 'Recent card should rank first');
    assert.ok(ranked[0].rerankScore > ranked[1].rerankScore, 'Recent should score higher');
  });

  it('should handle results with missing or invalid dates without crashing', async () => {
    const { rerankWithFusion } = await import('../src/core/reranker.mjs');

    const results = [
      makeResult('no-date', { title: 'No date', created_at: undefined }),
      makeResult('bad-date', { title: 'Bad date', created_at: 'not-a-date' }),
      makeResult('null-date', { title: 'Null date', created_at: null }),
    ];

    // Should not throw, and all scores should be valid numbers
    const ranked = rerankWithFusion(results, 'test');
    assert.equal(ranked.length, 3);
    for (const r of ranked) {
      assert.ok(!Number.isNaN(r.rerankScore), `Score for ${r.id} should not be NaN`);
      assert.ok(r.rerankScore > 0, `Score for ${r.id} should be positive`);
    }
  });
});
