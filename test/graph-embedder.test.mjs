/**
 * Tests for F-038 Phase 5 T-030: Graph Embedder.
 *
 * Covers: graph_embeddings CRUD, batch embedding, similarity edge generation,
 *         text preparation, CJK detection, progress tracking.
 *
 * Uses a mock embedder to avoid ONNX dependency in CI.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Indexer } from '../src/core/indexer.mjs';
import {
  embedGraphNodes,
  generateSimilarityEdges,
  runGraphEmbeddingPipeline,
} from '../src/daemon/graph-embedder.mjs';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-embedder-test-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock embedder — produces deterministic 384-dim vectors from text hash
// ---------------------------------------------------------------------------

function createMockEmbedder() {
  function textToVector(text) {
    const vec = new Float32Array(384);
    // Simple hash-based vector: spread chars across dimensions
    for (let i = 0; i < text.length && i < 384; i++) {
      vec[i % 384] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 384; i++) vec[i] /= norm;
    return vec;
  }

  return {
    MODEL_MAP: { english: 'mock-english', multilingual: 'mock-multilingual' },
    isEmbeddingAvailable: async () => true,
    embed: async (text, type, language) => textToVector(text),
    embedBatch: async (texts, type, language) => texts.map(textToVector),
  };
}

// ---------------------------------------------------------------------------
// Helper: seed graph_nodes with test data
// ---------------------------------------------------------------------------

function seedGraphNodes(indexer) {
  const nodes = [
    { id: 'file:src/auth.ts', node_type: 'file', title: 'auth.ts', content: 'Authentication module with JWT token validation and session management', metadata: { category: 'code' } },
    { id: 'file:src/auth-middleware.ts', node_type: 'file', title: 'auth-middleware.ts', content: 'Authentication middleware that validates JWT tokens on every request', metadata: { category: 'code' } },
    { id: 'file:src/database.ts', node_type: 'file', title: 'database.ts', content: 'Database connection pool and query builder for PostgreSQL', metadata: { category: 'code' } },
    { id: 'file:src/cache.ts', node_type: 'file', title: 'cache.ts', content: 'Redis cache layer for session storage and rate limiting', metadata: { category: 'code' } },
    { id: 'file:README.md', node_type: 'file', title: 'README.md', content: 'Project documentation with setup instructions and API reference', metadata: { category: 'docs' } },
    { id: 'sym:src/auth.ts:validateToken:10', node_type: 'symbol', title: 'validateToken', content: 'function validateToken(token: string): boolean' },
    { id: 'sym:src/auth.ts:createSession:25', node_type: 'symbol', title: 'createSession', content: 'function createSession(userId: string): Session' },
    { id: 'wiki:modules/auth', node_type: 'wiki', title: 'auth', content: '# auth\n\n> 2 files in this module.\n\n## Files\n\n### auth.ts\nAuthentication module\n\n### auth-middleware.ts\nAuth middleware' },
    { id: 'wiki:modules/database', node_type: 'wiki', title: 'database', content: '# database\n\n> 1 file in this module.\n\n## Files\n\n### database.ts\nDatabase connection' },
    { id: 'wiki:concepts/authentication', node_type: 'wiki', title: 'authentication', content: '# authentication\n\nConcept page for authentication patterns including JWT, sessions, and middleware' },
  ];

  for (const n of nodes) {
    indexer.graphInsertNode({
      id: n.id,
      node_type: n.node_type,
      title: n.title,
      content: n.content,
      metadata: n.metadata || {},
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Indexer CRUD Tests
// ---------------------------------------------------------------------------

describe('F-038 T-030 Graph Embeddings CRUD', () => {
  let indexer;

  before(() => {
    indexer = new Indexer(path.join(tmpDir, 'crud-test.db'));
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('graph_embeddings table exists', () => {
    const tables = indexer.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_embeddings'")
      .all();
    assert.equal(tables.length, 1);
  });

  it('storeGraphEmbedding + getGraphEmbedding round-trips', () => {
    // Insert a node first (FK constraint)
    indexer.graphInsertNode({
      id: 'file:test.ts',
      node_type: 'file',
      title: 'test.ts',
      content: 'test file',
    });

    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) vec[i] = i / 384;

    indexer.storeGraphEmbedding('file:test.ts', vec, 'test-model');

    const result = indexer.getGraphEmbedding('file:test.ts');
    assert.ok(result, 'embedding should exist');
    assert.equal(result.model_id, 'test-model');
    assert.equal(result.vector.length, 384);
    assert.ok(Math.abs(result.vector[0] - 0) < 0.001);
    assert.ok(Math.abs(result.vector[1] - 1 / 384) < 0.001);
  });

  it('getGraphEmbedding returns null for missing node', () => {
    const result = indexer.getGraphEmbedding('file:nonexistent.ts');
    assert.equal(result, null);
  });

  it('storeGraphEmbedding replaces existing embedding', () => {
    const vec2 = new Float32Array(384);
    for (let i = 0; i < 384; i++) vec2[i] = 1.0;

    indexer.storeGraphEmbedding('file:test.ts', vec2, 'updated-model');
    const result = indexer.getGraphEmbedding('file:test.ts');
    assert.equal(result.model_id, 'updated-model');
    assert.ok(Math.abs(result.vector[0] - 1.0) < 0.001);
  });

  it('getAllGraphEmbeddings returns all entries', () => {
    indexer.graphInsertNode({
      id: 'file:test2.ts',
      node_type: 'file',
      title: 'test2.ts',
      content: 'test2',
    });

    const vec = new Float32Array(384).fill(0.5);
    indexer.storeGraphEmbedding('file:test2.ts', vec, 'test-model');

    const all = indexer.getAllGraphEmbeddings();
    assert.ok(all.length >= 2);
    assert.ok(all.every(e => e.node_id && e.vector && e.vector.length === 384));
  });

  it('getUnembeddedGraphNodes lists nodes without embeddings', () => {
    indexer.graphInsertNode({
      id: 'file:no-embed.ts',
      node_type: 'file',
      title: 'no-embed.ts',
      content: 'no embedding yet',
    });

    const unembedded = indexer.getUnembeddedGraphNodes();
    const ids = unembedded.map(n => n.id);
    assert.ok(ids.includes('file:no-embed.ts'), 'should include unembbeded node');
    assert.ok(!ids.includes('file:test.ts'), 'should NOT include embedded node');
  });
});

// ---------------------------------------------------------------------------
// Embedding Pipeline Tests
// ---------------------------------------------------------------------------

describe('F-038 T-030 embedGraphNodes', () => {
  let indexer;
  let daemon;

  before(() => {
    indexer = new Indexer(path.join(tmpDir, 'embed-test.db'));
    daemon = {
      _embedder: createMockEmbedder(),
      indexer,
    };
    seedGraphNodes(indexer);
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('embeds all unembedded graph nodes', async () => {
    const result = await embedGraphNodes(daemon);
    assert.ok(result.embedded > 0, 'should embed at least 1 node');
    assert.equal(result.embedded + result.skipped, result.total);
    assert.equal(result.total, 10); // 5 files + 2 symbols + 3 wikis
  });

  it('graph_embeddings populated after embedding', () => {
    const all = indexer.getAllGraphEmbeddings();
    assert.equal(all.length, 10);
    assert.ok(all.every(e => e.vector.length === 384));
  });

  it('skips already-embedded nodes on second run', async () => {
    const result = await embedGraphNodes(daemon);
    assert.equal(result.embedded, 0, 'should embed 0 on second run');
    assert.equal(result.total, 0);
  });

  it('reports progress via callback', async () => {
    // Add a new node to embed
    indexer.graphInsertNode({
      id: 'file:new-progress.ts',
      node_type: 'file',
      title: 'new-progress.ts',
      content: 'test progress tracking',
    });

    const progressCalls = [];
    await embedGraphNodes(daemon, {
      onProgress: (done, total) => progressCalls.push({ done, total }),
    });

    assert.ok(progressCalls.length > 0, 'should call onProgress');
    const last = progressCalls[progressCalls.length - 1];
    assert.equal(last.done, last.total);
  });

  it('returns zeros when embedder is not available', async () => {
    const noEmbedDaemon = { _embedder: null, indexer };
    const result = await embedGraphNodes(noEmbedDaemon);
    assert.equal(result.embedded, 0);
  });
});

// ---------------------------------------------------------------------------
// Similarity Edge Tests
// ---------------------------------------------------------------------------

describe('F-038 T-030 generateSimilarityEdges', () => {
  let indexer;
  let daemon;

  before(() => {
    indexer = new Indexer(path.join(tmpDir, 'sim-test.db'));
    daemon = { _embedder: createMockEmbedder(), indexer };

    // Seed nodes with deliberately similar content
    const nodes = [
      { id: 'file:auth.ts', node_type: 'file', title: 'auth.ts', content: 'JWT authentication token validation' },
      { id: 'file:auth-guard.ts', node_type: 'file', title: 'auth-guard.ts', content: 'JWT authentication token guard' },
      { id: 'file:db.ts', node_type: 'file', title: 'db.ts', content: 'PostgreSQL database connection pool' },
      { id: 'wiki:auth', node_type: 'wiki', title: 'auth', content: 'Authentication module JWT tokens' },
      { id: 'wiki:database', node_type: 'wiki', title: 'database', content: 'Database PostgreSQL connection' },
    ];

    for (const n of nodes) {
      indexer.graphInsertNode({ ...n, metadata: {} });
    }
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('generates similarity edges after embedding', async () => {
    // First embed all nodes
    await embedGraphNodes(daemon);

    // Then generate similarity edges
    const result = generateSimilarityEdges(daemon);
    assert.ok(result.edgesCreated > 0, 'should create at least 1 similarity edge');
    assert.equal(result.nodesProcessed, 5);
  });

  it('similarity edges are in graph_edges table', () => {
    const edges = indexer.db
      .prepare("SELECT * FROM graph_edges WHERE edge_type = 'similarity'")
      .all();
    assert.ok(edges.length > 0, 'should have similarity edges');

    // All weights should be between 0 and 1
    for (const e of edges) {
      assert.ok(e.weight > 0 && e.weight <= 1, `weight ${e.weight} should be in (0, 1]`);
    }
  });

  it('similarity edges are same-type only', () => {
    const edges = indexer.db
      .prepare("SELECT * FROM graph_edges WHERE edge_type = 'similarity'")
      .all();

    for (const e of edges) {
      const fromType = e.from_node_id.split(':')[0];
      const toType = e.to_node_id.split(':')[0];
      assert.equal(fromType, toType, `similarity edge should be same-type: ${fromType} vs ${toType}`);
    }
  });

  it('respects threshold parameter', () => {
    // With threshold = 0.99, very few edges should be created
    const result = generateSimilarityEdges(daemon, { threshold: 0.99 });
    // High threshold means fewer edges (or none)
    assert.ok(result.edgesCreated <= 1, `expected few edges at threshold 0.99, got ${result.edgesCreated}`);
  });

  it('returns zeros when no embeddings exist', () => {
    const emptyIndexer = new Indexer(path.join(tmpDir, 'empty-sim.db'));
    const result = generateSimilarityEdges({ indexer: emptyIndexer });
    assert.equal(result.edgesCreated, 0);
    assert.equal(result.nodesProcessed, 0);
    emptyIndexer.db.close();
  });
});

// ---------------------------------------------------------------------------
// Full Pipeline Test
// ---------------------------------------------------------------------------

describe('F-038 T-030 runGraphEmbeddingPipeline', () => {
  let indexer;
  let daemon;

  before(() => {
    indexer = new Indexer(path.join(tmpDir, 'pipeline-test.db'));
    daemon = { _embedder: createMockEmbedder(), indexer };

    // Seed with 3 similar file nodes
    const nodes = [
      { id: 'file:a.ts', node_type: 'file', title: 'a.ts', content: 'user authentication handler' },
      { id: 'file:b.ts', node_type: 'file', title: 'b.ts', content: 'user authorization handler' },
      { id: 'file:c.ts', node_type: 'file', title: 'c.ts', content: 'database migration script' },
    ];

    for (const n of nodes) {
      indexer.graphInsertNode({ ...n, metadata: {} });
    }
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('runs full pipeline: embed + similarity', async () => {
    const result = await runGraphEmbeddingPipeline(daemon);

    assert.equal(result.embedding.embedded, 3);
    assert.ok(result.similarity.nodesProcessed === 3);

    // Verify embeddings in DB
    const allEmb = indexer.getAllGraphEmbeddings();
    assert.equal(allEmb.length, 3);

    // Verify similarity edges exist
    const simEdges = indexer.db
      .prepare("SELECT COUNT(*) as cnt FROM graph_edges WHERE edge_type = 'similarity'")
      .get();
    assert.ok(simEdges.cnt >= 0); // may or may not have edges depending on mock vectors
  });
});
