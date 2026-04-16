// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Indexer } from '../src/core/indexer.mjs';
import { KnowledgeExtractor } from '../src/core/knowledge-extractor.mjs';

test('Indexer.getAllEmbeddings returns id alias for fusion compatibility', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-local-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const indexer = new Indexer(dbPath);

  try {
    indexer.indexMemory(
      'mem_test_123',
      {
        filepath: path.join(tmpDir, 'mem_test_123.md'),
        type: 'turn_summary',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      'JWT auth decision',
    );
    indexer.storeEmbedding('mem_test_123', new Float32Array([0.1, 0.2, 0.3]), 'all-MiniLM-L6-v2');
    const embeddings = indexer.getAllEmbeddings();

    assert.equal(embeddings.length, 1);
    assert.equal(embeddings[0].id, 'mem_test_123');
    assert.equal(embeddings[0].memory_id, 'mem_test_123');
  } finally {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('KnowledgeExtractor treats completed_tasks-only payload as valid insights', () => {
  const extractor = new KnowledgeExtractor(null, null, null);

  assert.equal(
    extractor._hasInsights({
      completed_tasks: [{ task_id: 'task_123', reason: 'implemented and verified' }],
    }),
    true,
  );
});
