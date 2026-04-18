/**
 * F-053 Phase 2 · Single-parameter MCP surface — integration contract.
 *
 * Locks the new `query` → unifiedCascadeSearch route while verifying legacy
 * multi-parameter clients still work and get a deprecation warning logged.
 *
 * Scope: contract only — uses a stub search engine, not the full daemon.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecallResult } from '../src/daemon/mcp-handlers.mjs';

/** Build a stub search engine that records which path was invoked. */
function stubSearch({ recall, unifiedCascadeSearch, getFullContent } = {}) {
  return {
    recall: recall || (async () => []),
    unifiedCascadeSearch: unifiedCascadeSearch || (async () => ({ results: [] })),
    getFullContent: getFullContent || (async () => []),
  };
}

/** Capture console.warn output so we can assert on deprecation messages. */
function captureWarnings(run) {
  const original = console.warn;
  const captured = [];
  console.warn = (...parts) => { captured.push(parts.join(' ')); };
  return Promise.resolve(run()).finally(() => { console.warn = original; });
}

test('Phase 2 · single-param { query } routes to unifiedCascadeSearch', async () => {
  let unifiedCalls = 0;
  let legacyCalls = 0;
  const search = stubSearch({
    unifiedCascadeSearch: async (q, opts) => {
      unifiedCalls += 1;
      assert.equal(q, 'why pgvector');
      assert.equal(opts.tokenBudget, 5000);
      assert.equal(opts.limit, 10);
      return { results: [{ id: 'a', title: 'A', summary: 'sum', type: 'knowledge_card', score: 0.9 }] };
    },
    recall: async () => { legacyCalls += 1; return []; },
  });

  const out = await buildRecallResult({ search, args: { query: 'why pgvector' } });
  assert.equal(unifiedCalls, 1, 'unifiedCascadeSearch should be called');
  assert.equal(legacyCalls, 0, 'legacy recall() must not be invoked for single-param');
  assert.ok(out.content?.[0]?.text?.includes('A'), 'summary content should include the result');
});

test('Phase 2 · custom token_budget + limit propagate to unifiedCascadeSearch', async () => {
  let captured = null;
  const search = stubSearch({
    unifiedCascadeSearch: async (q, opts) => {
      captured = { q, ...opts };
      return { results: [{ id: 'x', title: 'X', summary: 's', score: 1 }] };
    },
  });
  await buildRecallResult({
    search,
    args: { query: 'q', token_budget: 60_000, limit: 20 },
  });
  assert.equal(captured.q, 'q');
  assert.equal(captured.tokenBudget, 60_000);
  assert.equal(captured.limit, 20);
});

test('Phase 2 · legacy { semantic_query } still works via old recall() path', async () => {
  let unifiedCalls = 0;
  let legacyCalls = 0;
  const search = stubSearch({
    unifiedCascadeSearch: async () => { unifiedCalls += 1; return { results: [] }; },
    recall: async (args) => {
      legacyCalls += 1;
      assert.equal(args.semantic_query, 'legacy');
      return [{ id: 'b', title: 'B', summary: 'old', score: 0.7 }];
    },
  });

  const out = await buildRecallResult({ search, args: { semantic_query: 'legacy' } });
  assert.equal(unifiedCalls, 0, 'unified path must not handle legacy params');
  assert.equal(legacyCalls, 1, 'legacy recall() should handle the call');
  assert.ok(out.content?.[0]?.text?.includes('B'));
});

test('Phase 2 · legacy params emit a deprecation warning (any of the tracked params)', async () => {
  // The warning is rate-limited globally (once per hour per param name),
  // so earlier tests in this file may have consumed the `semantic_query`
  // slot. Assert that *at least one* deprecated-param warning fires for
  // this legacy call — the rate-limit window is shared across all calls.
  const search = stubSearch({
    recall: async () => [{ id: 'b', title: 'B', summary: 'old' }],
  });
  const captured = [];
  const original = console.warn;
  console.warn = (...parts) => { captured.push(parts.join(' ')); };
  try {
    // Mix of params — at least one of these should still have an open window.
    await buildRecallResult({
      search,
      args: { semantic_query: 'x', scope: 'all', recall_mode: 'hybrid', multi_level: true, cluster_expand: true },
    });
  } finally {
    console.warn = original;
  }
  const hasAnyDeprecationWarn = captured.some((m) => m.includes('[deprecated param used]'));
  assert.ok(
    hasAnyDeprecationWarn,
    `expected at least one deprecation warning to fire, got: ${captured.join(' | ') || '<none>'}`,
  );
});

test('Phase 2 · empty query with no legacy fallback returns the "no query" message', async () => {
  const search = stubSearch();
  const out = await buildRecallResult({ search, args: {} });
  const text = out.content?.[0]?.text || '';
  assert.ok(text.length > 0, 'must return non-empty guidance');
  assert.ok(
    /query/i.test(text) || /provide/i.test(text) || /search/i.test(text),
    `expected prompt to mention query/search, got: ${text}`,
  );
});

test('Phase 2 · detail=full + ids still routes to getFullContent (legacy progressive disclosure)', async () => {
  let fullCalls = 0;
  const search = stubSearch({
    getFullContent: async (ids) => {
      fullCalls += 1;
      assert.deepEqual(ids, ['a', 'b']);
      return [{ id: 'a', content: 'full-a' }, { id: 'b', content: 'full-b' }];
    },
  });
  const out = await buildRecallResult({
    search,
    args: { detail: 'full', ids: ['a', 'b'] },
  });
  assert.equal(fullCalls, 1, 'getFullContent should be invoked');
  assert.ok(out.content?.[0]?.text?.length > 0);
});
