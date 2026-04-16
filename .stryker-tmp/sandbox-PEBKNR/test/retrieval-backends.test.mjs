// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { BuiltinRetrievalBackend } from '../src/core/retrieval-backends/builtin-backend.mjs';
import { QmdRetrievalBackend, QMD_RESULT_PREFIX } from '../src/core/retrieval-backends/qmd-backend.mjs';
import { SearchEngine } from '../src/core/search.mjs';

test('BuiltinRetrievalBackend delegates to engine builtin methods', async () => {
  const calls = [];
  const engine = {
    async _searchLocalBuiltin(params) {
      calls.push(['search', params]);
      return [{ id: 'mem_1', finalScore: 0.9 }];
    },
    async _getFullContentLocal(ids) {
      calls.push(['full', ids]);
      return [{ id: ids[0], content: 'ok' }];
    },
  };

  const backend = new BuiltinRetrievalBackend({ engine });
  const results = await backend.search({ semantic_query: 'auth' });
  const full = await backend.getFullContent(['mem_1']);

  assert.equal(results[0].id, 'mem_1');
  assert.equal(full[0].content, 'ok');
  assert.equal(calls.length, 2);
});

test('QmdRetrievalBackend uses DB-only store factory and prefixes ids', async () => {
  const backend = new QmdRetrievalBackend({
    dbPath: '/tmp/qmd.sqlite',
    storeFactory: async () => ({
      async search() {
        return [{ docid: '#abc123', title: 'Doc', snippet: 'Snippet', score: 0.8 }];
      },
      async get(id) {
        return { title: `Doc ${id}`, body: 'Full body' };
      },
    }),
  });

  const results = await backend.search({ semantic_query: 'auth', limit: 5 });
  const full = await backend.getFullContent([`${QMD_RESULT_PREFIX}#abc123`]);

  assert.equal(results[0].id, `${QMD_RESULT_PREFIX}#abc123`);
  assert.equal(full[0].content, 'Full body');
});

test('SearchEngine keeps default builtin behavior and can expand qmd-prefixed full content', async () => {
  const engine = new SearchEngine(
    { db: { prepare: () => ({ get: () => null }) } },
    { readContent: async () => '' },
    null,
    null,
    {
      builtinBackend: { search: async () => [{ id: 'mem_1', title: 'Local', finalScore: 0.9 }], getFullContent: async () => [{ id: 'mem_1', content: 'local body' }], getStatus: () => ({ kind: 'builtin', ready: true }) },
      qmdBackend: { search: async () => [{ id: `${QMD_RESULT_PREFIX}doc`, title: 'QMD', finalScore: 0.7, source: 'qmd' }], getFullContent: async () => [{ id: `${QMD_RESULT_PREFIX}doc`, content: 'qmd body', source: 'qmd' }], getStatus: () => ({ kind: 'qmd', ready: true }) },
    },
  );

  const summary = await engine.recall({ semantic_query: 'auth', detail: 'summary', limit: 5 });
  const full = await engine.getFullContent(['mem_1', `${QMD_RESULT_PREFIX}doc`]);

  assert.equal(summary[0].id, 'mem_1');
  assert.equal(full.length, 2);
  assert.equal(full[1].source, 'qmd');
});
