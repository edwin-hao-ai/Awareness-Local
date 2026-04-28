import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiPromptInject } from '../src/daemon/prompt-injector.mjs';

function mockRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, headers) { this.statusCode = code; if (headers) Object.assign(this.headers, headers); },
    end(s) { chunks.push(s); this.body = s; },
    _chunks: chunks,
  };
}

function mkUrl(qs) {
  return new URL(`http://localhost/api/v1/prompt/inject?${qs}`);
}

const stubDaemon = (items) => ({
  search: null,
  indexer: {
    search: () => items,
  },
});

test('empty query returns empty markdown', async () => {
  const res = mockRes();
  await apiPromptInject(stubDaemon([]), {}, res, mkUrl(''));
  const data = JSON.parse(res.body);
  assert.equal(data.markdown, '');
  assert.equal(data.card_count, 0);
  assert.equal(data.reason, 'empty query');
});

test('renders cards as markdown with header', async () => {
  const items = [
    { title: 'Use pgvector', summary: 'Chose pgvector over Pinecone because of licensing.', category: 'decision' },
    { title: 'Prisma gotcha', summary: 'Model names differ from table names; use @@map.', category: 'pitfall' },
  ];
  const res = mockRes();
  await apiPromptInject(stubDaemon(items), {}, res, mkUrl('q=database&runtime=cursor'));
  const data = JSON.parse(res.body);
  assert.match(data.markdown, /Relevant memory for: "database"/);
  assert.match(data.markdown, /runtime=cursor/);
  assert.match(data.markdown, /### 1\. Use pgvector \(decision\)/);
  assert.match(data.markdown, /### 2\. Prisma gotcha \(pitfall\)/);
  assert.equal(data.card_count, 2);
  assert.equal(data.query, 'database');
  assert.equal(data.runtime, 'cursor');
  assert.ok(data.estimated_tokens > 0);
});

test('no-match returns no-memory markdown', async () => {
  const res = mockRes();
  await apiPromptInject(stubDaemon([]), {}, res, mkUrl('q=zzz&runtime=aider'));
  const data = JSON.parse(res.body);
  assert.match(data.markdown, /No memory found for: "zzz"/);
  assert.equal(data.card_count, 0);
});

test('truncates when budget exceeded', async () => {
  const big = 'x'.repeat(5000);
  const items = Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, summary: big }));
  const res = mockRes();
  await apiPromptInject(stubDaemon(items), {}, res, mkUrl('q=test&budget=500&limit=16'));
  const data = JSON.parse(res.body);
  assert.match(data.markdown, /truncated at card/);
  assert.ok(data.card_count < items.length);
});

test('prefers unifiedCascadeSearch when available', async () => {
  let cascadeCalled = false;
  const daemon = {
    search: {
      unifiedCascadeSearch: async (q, opts) => {
        cascadeCalled = true;
        return { results: [{ title: 'from-cascade', summary: 'cascade hit' }] };
      },
    },
    indexer: { search: () => [{ title: 'from-index', summary: 'should not appear' }] },
  };
  const res = mockRes();
  await apiPromptInject(daemon, {}, res, mkUrl('q=test'));
  const data = JSON.parse(res.body);
  assert.equal(cascadeCalled, true);
  assert.match(data.markdown, /from-cascade/);
  assert.doesNotMatch(data.markdown, /from-index/);
});

test('falls back to indexer when cascade throws', async () => {
  const daemon = {
    search: { unifiedCascadeSearch: async () => { throw new Error('db down'); } },
    indexer: { search: () => [{ title: 'fallback', summary: 'indexer used' }] },
  };
  const res = mockRes();
  await apiPromptInject(daemon, {}, res, mkUrl('q=test'));
  const data = JSON.parse(res.body);
  assert.match(data.markdown, /fallback/);
});
