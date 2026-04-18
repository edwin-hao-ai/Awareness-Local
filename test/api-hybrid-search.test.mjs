/**
 * api-hybrid-search.test.mjs — L2 integration tests for REST search handlers.
 *
 * Problem these tests lock down (F-053 Phase 3 Web UI alignment):
 *   The REST endpoints `/api/v1/search` (apiHybridSearch) and
 *   `/api/v1/memories/search` (apiSearchMemories) are consumed by:
 *     - Web UI main memory search (index.html line 1972)
 *     - Web UI Cmd+K panel (index.html line 2891)
 *     - Onboarding recall suggestions (recall-suggestions.js line 103)
 *
 *   Before the alignment fix these handlers called `daemon.search.recall({...})`
 *   with the old multi-parameter shape, bypassing Phase 3 query-type routing,
 *   recency channel, budget-tier bucket shaping, and cross-encoder rerank.
 *
 *   After the fix: primary path calls `daemon.search.unifiedCascadeSearch(q, { tokenBudget, limit })`
 *   and falls back to `daemon.search.recall(...)` if the new API is missing
 *   (pre-Phase-3 daemons), and to FTS-only if `daemon.search` is entirely absent.
 *
 * These tests verify all 3 tiers + the empty-query short circuit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiHybridSearch,
  apiSearchMemories,
} from '../src/daemon/api-handlers.mjs';

function mockRes() {
  let _status = 200;
  let _body = '';
  return {
    writeHead(status) { _status = status; },
    end(body) { _body = body; },
    get status() { return _status; },
    get json() { return JSON.parse(_body); },
  };
}

function makeUrl(pathPart, params = {}) {
  const u = new URL('http://localhost:37800/api/v1' + pathPart);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

describe('apiHybridSearch — F-053 Phase 3 Web UI alignment', () => {
  it('primary path: calls unifiedCascadeSearch when available', async () => {
    const calls = [];
    const daemon = {
      search: {
        unifiedCascadeSearch: async (q, opts) => {
          calls.push({ fn: 'unifiedCascadeSearch', q, opts });
          return {
            results: [
              { id: 'r1', title: 'Recent Phase 3 result', type: 'knowledge_card', score: 0.9 },
              { id: 'r2', title: 'Older doc', type: 'workspace_file', score: 0.7 },
            ],
          };
        },
        recall: async () => { throw new Error('recall must NOT be called when unifiedCascadeSearch is available'); },
      },
      indexer: { search: () => { throw new Error('indexer.search must NOT be called'); } },
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: 'recent phase 3', limit: '5' }));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'unifiedCascadeSearch');
    assert.equal(calls[0].q, 'recent phase 3');
    assert.equal(calls[0].opts.limit, 5);
    assert.ok(calls[0].opts.tokenBudget > 0, 'tokenBudget must be forwarded with a positive default');
    assert.equal(res.json.items.length, 2);
    assert.equal(res.json.items[0].id, 'r1');
    assert.equal(res.json.query, 'recent phase 3');
  });

  it('primary path: accepts budget query param and forwards as tokenBudget', async () => {
    let captured = null;
    const daemon = {
      search: {
        unifiedCascadeSearch: async (_q, opts) => { captured = opts; return { results: [] }; },
      },
      indexer: { search: () => [] },
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: 'x', limit: '3', budget: '50000' }));
    assert.equal(res.status, 200);
    assert.equal(captured.tokenBudget, 50000, 'budget query param must map to tokenBudget');
    assert.equal(captured.limit, 3);
  });

  it('primary path: unwraps results whether unifiedCascadeSearch returns {results} or a bare array', async () => {
    const daemon = {
      search: {
        unifiedCascadeSearch: async () => [{ id: 'bare1', title: 'Bare array result', type: 'knowledge_card' }],
      },
      indexer: { search: () => [] },
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: 'bare' }));
    assert.equal(res.json.items.length, 1);
    assert.equal(res.json.items[0].id, 'bare1');
  });

  it('legacy fallback: uses search.recall when unifiedCascadeSearch is missing (pre-Phase-3 daemon)', async () => {
    const calls = [];
    const daemon = {
      search: {
        // No unifiedCascadeSearch — simulate an older daemon build.
        recall: async (args) => {
          calls.push({ fn: 'recall', args });
          return [{ id: 'legacy1', title: 'Legacy recall hit', type: 'turn_summary' }];
        },
      },
      indexer: { search: () => { throw new Error('indexer.search must NOT be called when recall succeeds'); } },
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: 'legacy query', limit: '4' }));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'recall');
    assert.equal(calls[0].args.semantic_query, 'legacy query');
    assert.equal(calls[0].args.keyword_query, 'legacy query');
    assert.equal(calls[0].args.limit, 4);
    assert.equal(res.json.items[0].id, 'legacy1');
  });

  it('L3 chaos: falls back to recall when unifiedCascadeSearch throws', async () => {
    const calls = [];
    const daemon = {
      search: {
        unifiedCascadeSearch: async () => { throw new Error('simulated cascade failure'); },
        recall: async (args) => { calls.push(args); return [{ id: 'fallback1', title: 'Recall fallback', type: 'message' }]; },
      },
      indexer: null,
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: 'chaos' }));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1, 'recall must be invoked as fallback when cascade throws');
    assert.equal(res.json.items[0].id, 'fallback1');
  });

  it('last-resort fallback: uses FTS indexer when daemon.search is absent', async () => {
    const ftsCalls = [];
    const daemon = {
      search: null,
      indexer: {
        search: (q, opts) => { ftsCalls.push({ q, opts }); return [{ id: 'fts1', title: 'FTS hit', type: 'message' }]; },
        searchKnowledge: () => [{ id: 'kc_fts', title: 'Knowledge FTS hit', category: 'decision' }],
      },
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: 'fts only', limit: '10' }));
    assert.equal(res.status, 200);
    assert.equal(ftsCalls.length, 1);
    assert.ok(res.json.items.length >= 1);
  });

  it('empty query short-circuits before touching search', async () => {
    const daemon = {
      search: { unifiedCascadeSearch: async () => { throw new Error('should not be called for empty q'); } },
      indexer: { search: () => { throw new Error('should not be called for empty q'); } },
    };
    const res = mockRes();
    await apiHybridSearch(daemon, null, res, makeUrl('/search', { q: '' }));
    assert.equal(res.json.items.length, 0);
    assert.equal(res.json.total, 0);
    assert.equal(res.json.query, '');
  });
});

describe('apiSearchMemories — F-053 Phase 3 Web UI alignment', () => {
  it('primary path: calls unifiedCascadeSearch when available', async () => {
    const calls = [];
    const daemon = {
      search: {
        unifiedCascadeSearch: async (q, opts) => {
          calls.push({ q, opts });
          return { results: [{ id: 'm1', title: 'Memory match', type: 'turn_summary' }] };
        },
      },
      indexer: { search: () => { throw new Error('indexer.search must NOT be called when cascade succeeds'); } },
    };
    const res = mockRes();
    await apiSearchMemories(daemon, null, res, makeUrl('/memories/search', { q: 'memory query', limit: '8' }));
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].q, 'memory query');
    assert.equal(calls[0].opts.limit, 8);
    assert.equal(res.json.items[0].id, 'm1');
  });

  it('fallback: uses indexer.search when daemon.search is absent', () => {
    const ftsCalls = [];
    const daemon = {
      search: null,
      indexer: { search: (q, opts) => { ftsCalls.push({ q, opts }); return [{ id: 'fts_m', title: 'FTS memory hit' }]; } },
    };
    const res = mockRes();
    apiSearchMemories(daemon, null, res, makeUrl('/memories/search', { q: 'q', limit: '5' }));
    assert.equal(ftsCalls.length, 1);
    assert.equal(res.json.items[0].id, 'fts_m');
  });

  it('empty query short-circuits', () => {
    const daemon = {
      search: { unifiedCascadeSearch: async () => { throw new Error('should not be called'); } },
      indexer: { search: () => { throw new Error('should not be called'); } },
    };
    const res = mockRes();
    apiSearchMemories(daemon, null, res, makeUrl('/memories/search', { q: '' }));
    assert.equal(res.json.items.length, 0);
  });
});
