/**
 * F-053 · L3 chaos / failure-mode suite for the unified cascade.
 *
 * Maps to ACCEPTANCE.md §Failure Modes:
 *   F1  daemon embedder outage → fallback to BM25/FTS single-channel
 *   F2  SQLite lock on one channel → partial result, no crash
 *   F3  query pathologies (empty, whitespace, 10K+ chars, null, number, object)
 *
 * Scope: pure search.mjs integration — no daemon, no network. Every failure
 * surface is injected via stubbed SearchEngine channels so the test runs
 * deterministically in CI (no timing flake).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SearchEngine } from '../src/core/search.mjs';

function stubEngine({ recall, graph, ftsQuery = (q) => q } = {}) {
  const engine = Object.create(SearchEngine.prototype);
  engine.indexer = null;
  engine.store = null;
  engine.embedder = null;
  engine.cloud = null;
  engine.recall = recall || (async () => []);
  engine._searchGraphNodesFts = graph || (() => []);
  engine.buildFtsQuery = ftsQuery;
  return engine;
}

// ---------------------------------------------------------------------------
// F1 · Embedder outage
// ---------------------------------------------------------------------------

test('L3·F1 embedder throwing inside recall() still returns graph results', async () => {
  // recall() is the channel that fans out to embedder + cloud + hydrate. If
  // any of those blow up, the unified cascade must still surface graph hits.
  const engine = stubEngine({
    recall: async () => { throw new Error('ONNX runtime crash: tensor shape mismatch'); },
    graph: () => [
      { id: 'ws_readme', title: 'README.md', summary: 'project root', type: 'workspace_file' },
    ],
  });
  const out = await engine.unifiedCascadeSearch('setup instructions');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, 'ws_readme');
});

test('L3·F1 embedder AND graph both throwing returns empty {results:[]}, never throws', async () => {
  const engine = stubEngine({
    recall: async () => { throw new Error('embedder timeout'); },
    graph: () => { throw new Error('SQLite: database is locked'); },
  });
  const out = await engine.unifiedCascadeSearch('any query');
  assert.deepEqual(out, { results: [] });
});

test('L3·F1 parallelism: slow recall does not block graph channel', async () => {
  // Contract: the two channels must run concurrently. A slow recall (200 ms)
  // plus a fast graph (0 ms) should complete in ~200 ms, not ~200 ms + overhead.
  // This catches the regression where someone accidentally `await`s recall
  // before starting graph, serialising the two.
  let graphCallTime = 0;
  const engine = stubEngine({
    recall: () => new Promise((resolve) => setTimeout(
      () => resolve([{ id: 'slow', title: 'T', summary: 'S', type: 'knowledge_card' }]),
      200,
    )),
    graph: () => {
      graphCallTime = Date.now();
      return [{ id: 'fast', title: 'T2', summary: 'S2', type: 'workspace_file' }];
    },
  });
  const start = Date.now();
  const out = await engine.unifiedCascadeSearch('q');
  const totalElapsed = Date.now() - start;
  const graphLatency = graphCallTime - start;

  assert.equal(out.results.length, 2, 'both channel results should fuse');
  assert.ok(graphLatency < 50,
    `graph channel must start in parallel (was ${graphLatency}ms after call)`);
  assert.ok(totalElapsed < 300,
    `total latency should be ≈ recall duration, not additive (was ${totalElapsed}ms)`);
});

// ---------------------------------------------------------------------------
// F2 · Partial-source: one channel throws, the other succeeds
// ---------------------------------------------------------------------------

test('L3·F2 recall succeeds + graph SQLITE_BUSY → returns recall results only', async () => {
  const err = new Error('SQLITE_BUSY: database is locked');
  err.code = 'SQLITE_BUSY';
  const engine = stubEngine({
    recall: async () => [
      { id: 'mem1', title: 'T', summary: 'S', type: 'knowledge_card' },
      { id: 'mem2', title: 'T2', summary: 'S2', type: 'turn_summary' },
    ],
    graph: () => { throw err; },
  });
  const out = await engine.unifiedCascadeSearch('q');
  assert.equal(out.results.length, 2);
  const ids = new Set(out.results.map((r) => r.id));
  assert.ok(ids.has('mem1') && ids.has('mem2'));
});

test('L3·F2 graph returns results + recall() throws → returns graph results only', async () => {
  const engine = stubEngine({
    recall: async () => { throw new Error('pgvector connection refused'); },
    graph: () => [
      { id: 'g1', title: 'file.ts', summary: 'workspace hit', type: 'workspace_file' },
    ],
  });
  const out = await engine.unifiedCascadeSearch('q');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].id, 'g1');
});

test('L3·F2 graph returns non-array garbage → treated as empty, no crash', async () => {
  const engine = stubEngine({
    recall: async () => [{ id: 'mem1', title: 'T', summary: 'S', type: 'knowledge_card' }],
    graph: () => ({ not_an_array: true }), // corrupt return shape
  });
  const out = await engine.unifiedCascadeSearch('q');
  assert.equal(out.results.length, 1, 'garbage graph return must not poison the fused pool');
  assert.equal(out.results[0].id, 'mem1');
});

// ---------------------------------------------------------------------------
// F3 · Query pathologies
// ---------------------------------------------------------------------------

test('L3·F3 empty string query → {results:[]} without calling channels', async () => {
  let recallCalls = 0;
  let graphCalls = 0;
  const engine = stubEngine({
    recall: async () => { recallCalls += 1; return []; },
    graph: () => { graphCalls += 1; return []; },
  });
  const out = await engine.unifiedCascadeSearch('');
  assert.deepEqual(out, { results: [] });
  assert.equal(recallCalls, 0, 'empty query must short-circuit before recall');
  assert.equal(graphCalls, 0, 'empty query must short-circuit before graph');
});

test('L3·F3 whitespace-only query → {results:[]}', async () => {
  const engine = stubEngine();
  const out = await engine.unifiedCascadeSearch('   \t\n\r  ');
  assert.deepEqual(out, { results: [] });
});

test('L3·F3 non-string query types → {results:[]} (null/undefined/number/object/array)', async () => {
  const engine = stubEngine();
  for (const bad of [null, undefined, 42, 3.14, {}, [], true, false]) {
    const out = await engine.unifiedCascadeSearch(bad);
    assert.deepEqual(out, { results: [] }, `input ${JSON.stringify(bad)} must be rejected safely`);
  }
});

test('L3·F3 oversized query (10K chars) still executes — no size cap at cascade layer', async () => {
  // F-053 ACCEPTANCE.md F3 says "query length > 10K chars →明确 4xx". That gate
  // lives at the MCP handler boundary (daemon/backend), NOT inside the search
  // engine. This test locks the contract that search.mjs accepts any non-empty
  // string — protocol-level enforcement belongs upstream.
  const huge = 'x'.repeat(10_000);
  let capturedQuery = null;
  const engine = stubEngine({
    recall: async (params) => {
      capturedQuery = params.semantic_query;
      return [{ id: 'r', title: 'T', summary: 'S', type: 'knowledge_card' }];
    },
  });
  const out = await engine.unifiedCascadeSearch(huge);
  assert.equal(capturedQuery.length, 10_000);
  assert.equal(out.results.length, 1);
});

test('L3·F3 invalid tokenBudget / limit opts fall back to defaults, no throw', async () => {
  let capturedBudget = -1;
  let capturedLimit = -1;
  const engine = stubEngine({
    recall: async (params) => {
      capturedBudget = params.token_budget;
      capturedLimit = params.limit;
      return [];
    },
  });
  // NaN / negative / non-number — all should fall back to defaults (5000, 10).
  for (const opts of [
    { tokenBudget: NaN, limit: NaN },
    { tokenBudget: -1, limit: -5 },
    { tokenBudget: 'big', limit: 'lots' },
    { tokenBudget: null, limit: null },
    undefined,
  ]) {
    await engine.unifiedCascadeSearch('q', opts);
    assert.equal(capturedBudget, 5000, `budget default for opts=${JSON.stringify(opts)}`);
    assert.equal(capturedLimit, 10, `limit default for opts=${JSON.stringify(opts)}`);
  }
});

// ---------------------------------------------------------------------------
// Opacity under chaos — no field leaks even when a channel fails.
// ---------------------------------------------------------------------------

test('L3·opacity · recall returns items with source_channel → still stripped on failure', async () => {
  const engine = stubEngine({
    recall: async () => [
      { id: 'a', title: 'T', summary: 'S', type: 'knowledge_card',
        source_channel: 'cloud', cascade_layer: 'layer1', recall_mode: 'hybrid',
        record_source: 'cloud-sync', db_source: 'postgres' },
    ],
    graph: () => { throw new Error('graph down'); },
  });
  const out = await engine.unifiedCascadeSearch('q');
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  for (const leakField of ['source', 'source_channel', 'cascade_layer', 'recall_mode', 'record_source', 'db_source', 'source_origin']) {
    assert.equal(r[leakField], undefined, `${leakField} must be stripped even after graph failure`);
  }
});
