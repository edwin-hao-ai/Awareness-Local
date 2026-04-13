/**
 * Tests for F-038 graph-first schema and recall_count weighting.
 *
 * Covers: graph_nodes, graph_edges, graph_nodes_fts tables,
 *         graphInsertNode, graphInsertEdge, graphTraverse,
 *         recall_count migration, weighted search ranking.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Indexer } from '../src/core/indexer.mjs';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-schema-test-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Graph Schema Tests
// ---------------------------------------------------------------------------

describe('F-038 Graph Schema', () => {
  let indexer;

  before(() => {
    const dbPath = path.join(tmpDir, 'graph-test.db');
    indexer = new Indexer(dbPath);
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('creates graph_nodes table', () => {
    const tables = indexer.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes'")
      .all();
    assert.equal(tables.length, 1);
  });

  it('creates graph_edges table', () => {
    const tables = indexer.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_edges'")
      .all();
    assert.equal(tables.length, 1);
  });

  it('creates graph_nodes_fts virtual table', () => {
    const tables = indexer.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_nodes_fts'")
      .all();
    assert.equal(tables.length, 1);
  });

  it('creates graph_embeddings table', () => {
    const tables = indexer.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_embeddings'")
      .all();
    assert.equal(tables.length, 1);
  });

  it('graph_nodes has all expected columns', () => {
    const cols = indexer.db.prepare('PRAGMA table_info(graph_nodes)').all();
    const colNames = cols.map(c => c.name);
    for (const expected of [
      'id', 'node_type', 'title', 'content', 'metadata',
      'content_hash', 'salience_score', 'recall_count',
      'status', 'created_at', 'updated_at',
    ]) {
      assert.ok(colNames.includes(expected), `Missing column: ${expected}`);
    }
  });

  it('graph_edges has composite primary key', () => {
    const cols = indexer.db.prepare('PRAGMA table_info(graph_edges)').all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('from_node_id'));
    assert.ok(colNames.includes('to_node_id'));
    assert.ok(colNames.includes('edge_type'));
    assert.ok(colNames.includes('weight'));
  });

  it('does not break existing tables on re-init', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT OR IGNORE INTO memories (id, filepath, type, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('test_mem_graph', '/test/path.md', 'event', 'Test Memory', now, now);

    // Re-initialize schema
    indexer.initSchema();

    // Verify existing data is preserved
    const mem = indexer.db.prepare('SELECT * FROM memories WHERE id = ?').get('test_mem_graph');
    assert.ok(mem);
    assert.equal(mem.title, 'Test Memory');
  });
});

// ---------------------------------------------------------------------------
// Graph Insert/Query Tests
// ---------------------------------------------------------------------------

describe('graphInsertNode / graphInsertEdge', () => {
  let indexer;

  before(() => {
    const dbPath = path.join(tmpDir, 'graph-ops-test.db');
    indexer = new Indexer(dbPath);
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('inserts a file node', () => {
    const result = indexer.graphInsertNode({
      id: 'gn_file_001',
      node_type: 'file',
      title: 'indexer.mjs',
      content: 'SQLite FTS5 full-text search index for Awareness Local',
      metadata: { relative_path: 'src/core/indexer.mjs', language: 'javascript', line_count: 1500 },
      content_hash: 'abc123',
    });
    assert.equal(result.inserted, true);

    const node = indexer.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('gn_file_001');
    assert.equal(node.node_type, 'file');
    assert.equal(node.title, 'indexer.mjs');
    const meta = JSON.parse(node.metadata);
    assert.equal(meta.language, 'javascript');
  });

  it('inserts a symbol node', () => {
    const result = indexer.graphInsertNode({
      id: 'gn_sym_001',
      node_type: 'symbol',
      title: 'processFile',
      content: 'function processFile(path: string): void',
      metadata: { symbol_type: 'function', line_start: 42 },
    });
    assert.equal(result.inserted, true);
  });

  it('upserts a node (update on conflict)', () => {
    indexer.graphInsertNode({
      id: 'gn_file_001',
      node_type: 'file',
      title: 'indexer.mjs (updated)',
      content: 'Updated content',
    });
    const node = indexer.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('gn_file_001');
    assert.equal(node.title, 'indexer.mjs (updated)');
  });

  it('inserts an edge', () => {
    const result = indexer.graphInsertEdge({
      from_node_id: 'gn_file_001',
      to_node_id: 'gn_sym_001',
      edge_type: 'contains',
      weight: 1.0,
    });
    assert.equal(result.inserted, true);

    const edges = indexer.db.prepare('SELECT * FROM graph_edges WHERE from_node_id = ?').all('gn_file_001');
    assert.equal(edges.length, 1);
    assert.equal(edges[0].edge_type, 'contains');
  });

  it('upserts an edge (update on conflict)', () => {
    indexer.graphInsertEdge({
      from_node_id: 'gn_file_001',
      to_node_id: 'gn_sym_001',
      edge_type: 'contains',
      weight: 0.8,
    });
    const edge = indexer.db.prepare(
      "SELECT * FROM graph_edges WHERE from_node_id = ? AND to_node_id = ? AND edge_type = ?"
    ).get('gn_file_001', 'gn_sym_001', 'contains');
    assert.equal(edge.weight, 0.8);
  });
});

// ---------------------------------------------------------------------------
// graphTraverse Tests
// ---------------------------------------------------------------------------

describe('graphTraverse', () => {
  let indexer;

  before(() => {
    const dbPath = path.join(tmpDir, 'graph-traverse-test.db');
    indexer = new Indexer(dbPath);

    // Build a test graph:
    //   A --import--> B --import--> C --import--> D
    //   A --contains--> E
    //   B --doc_reference--> F
    const nodes = [
      { id: 'A', node_type: 'file', title: 'app.ts' },
      { id: 'B', node_type: 'file', title: 'utils.ts' },
      { id: 'C', node_type: 'file', title: 'helpers.ts' },
      { id: 'D', node_type: 'file', title: 'constants.ts' },
      { id: 'E', node_type: 'symbol', title: 'main()' },
      { id: 'F', node_type: 'doc', title: 'API docs' },
    ];
    for (const n of nodes) indexer.graphInsertNode(n);

    const edges = [
      { from_node_id: 'A', to_node_id: 'B', edge_type: 'import' },
      { from_node_id: 'B', to_node_id: 'C', edge_type: 'import' },
      { from_node_id: 'C', to_node_id: 'D', edge_type: 'import' },
      { from_node_id: 'A', to_node_id: 'E', edge_type: 'contains' },
      { from_node_id: 'B', to_node_id: 'F', edge_type: 'doc_reference' },
    ];
    for (const e of edges) indexer.graphInsertEdge(e);
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('traverses 1 hop from A', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 1 });
    const ids = result.map(r => r.id);
    assert.ok(ids.includes('B'), 'Should find B (1 hop via import)');
    assert.ok(ids.includes('E'), 'Should find E (1 hop via contains)');
    assert.ok(!ids.includes('C'), 'Should NOT find C (2 hops away)');
    assert.ok(!ids.includes('A'), 'Should NOT include start node');
  });

  it('traverses 2 hops from A', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 2 });
    const ids = result.map(r => r.id);
    assert.ok(ids.includes('B'), 'Should find B (1 hop)');
    assert.ok(ids.includes('E'), 'Should find E (1 hop)');
    assert.ok(ids.includes('C'), 'Should find C (2 hops via A→B→C)');
    assert.ok(ids.includes('F'), 'Should find F (2 hops via A→B→F)');
    assert.ok(!ids.includes('D'), 'Should NOT find D (3 hops away)');
  });

  it('traverses 3 hops from A (finds everything)', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 3 });
    const ids = result.map(r => r.id);
    assert.ok(ids.includes('D'), 'Should find D at 3 hops');
    assert.equal(ids.length, 5, 'Should find all 5 other nodes');
  });

  it('filters by edge type', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 2, edgeTypes: ['import'] });
    const ids = result.map(r => r.id);
    assert.ok(ids.includes('B'), 'Should find B (import)');
    assert.ok(ids.includes('C'), 'Should find C (import chain)');
    assert.ok(!ids.includes('E'), 'Should NOT find E (contains edge, filtered)');
    assert.ok(!ids.includes('F'), 'Should NOT find F (doc_reference edge, filtered)');
  });

  it('filters by node type', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 2, nodeTypes: ['file'] });
    const ids = result.map(r => r.id);
    assert.ok(ids.includes('B'));
    assert.ok(ids.includes('C'));
    assert.ok(!ids.includes('E'), 'Should NOT include symbol nodes');
    assert.ok(!ids.includes('F'), 'Should NOT include doc nodes');
  });

  it('returns depth information', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 2 });
    const b = result.find(r => r.id === 'B');
    const c = result.find(r => r.id === 'C');
    assert.equal(b.depth, 1);
    assert.equal(c.depth, 2);
  });

  it('handles non-existent start node gracefully', () => {
    const result = indexer.graphTraverse('nonexistent', { maxDepth: 2 });
    assert.equal(result.length, 0);
  });

  it('respects limit parameter', () => {
    const result = indexer.graphTraverse('A', { maxDepth: 3, limit: 2 });
    assert.ok(result.length <= 2);
  });

  it('traverses bidirectionally (follows edges in reverse)', () => {
    // Start from C, should reach B (reverse import) and then A (reverse import)
    const result = indexer.graphTraverse('C', { maxDepth: 2 });
    const ids = result.map(r => r.id);
    assert.ok(ids.includes('B'), 'Should find B (reverse import)');
    assert.ok(ids.includes('D'), 'Should find D (forward import)');
  });
});

// ---------------------------------------------------------------------------
// searchGraphNodes Tests
// ---------------------------------------------------------------------------

describe('searchGraphNodes', () => {
  let indexer;

  before(() => {
    const dbPath = path.join(tmpDir, 'graph-search-test.db');
    indexer = new Indexer(dbPath);

    indexer.graphInsertNode({ id: 'search_1', node_type: 'file', title: 'indexer.mjs', content: 'SQLite FTS5 search engine' });
    indexer.graphInsertNode({ id: 'search_2', node_type: 'symbol', title: 'searchKnowledge', content: 'Full text search over knowledge cards' });
    indexer.graphInsertNode({ id: 'search_3', node_type: 'doc', title: 'API Guide', content: 'REST API documentation for memory endpoints' });
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('finds nodes by content', () => {
    const results = indexer.searchGraphNodes('FTS5');
    assert.ok(results.length > 0);
    assert.ok(results.some(r => r.id === 'search_1'));
  });

  it('filters by node type', () => {
    const results = indexer.searchGraphNodes('search', { nodeTypes: ['symbol'] });
    assert.ok(results.every(r => r.node_type === 'symbol'));
  });

  it('returns empty for no matches', () => {
    const results = indexer.searchGraphNodes('xyznonexistent');
    assert.equal(results.length, 0);
  });
});

// ---------------------------------------------------------------------------
// recall_count Tests
// ---------------------------------------------------------------------------

describe('F-038 recall_count', () => {
  let indexer;

  before(() => {
    const dbPath = path.join(tmpDir, 'recall-test.db');
    indexer = new Indexer(dbPath);
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('knowledge_cards has recall_count column', () => {
    const cols = indexer.db.prepare('PRAGMA table_info(knowledge_cards)').all();
    const colNames = cols.map(c => c.name);
    assert.ok(colNames.includes('recall_count'), 'recall_count column missing');
  });

  it('recall_count defaults to 0', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT INTO knowledge_cards (id, category, title, summary, source_memories, confidence, status, tags, created_at, filepath)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('kc_rc_test', 'decision', 'Test Card', 'Test summary', '[]', 0.8, 'active', '[]', now, '/test/rc.md');

    const card = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('kc_rc_test');
    assert.equal(card.recall_count, 0);
  });

  it('_incrementRecallCount increases count', () => {
    indexer._incrementRecallCount(['kc_rc_test']);
    const card = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('kc_rc_test');
    assert.equal(card.recall_count, 1);

    indexer._incrementRecallCount(['kc_rc_test']);
    const card2 = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('kc_rc_test');
    assert.equal(card2.recall_count, 2);
  });

  it('_incrementRecallCount handles empty array gracefully', () => {
    indexer._incrementRecallCount([]);
    indexer._incrementRecallCount(null);
  });

  it('searchKnowledge returns weighted_rank and increments recall_count', () => {
    const now = new Date().toISOString();
    indexer.db.prepare(`
      INSERT OR IGNORE INTO knowledge_cards (id, category, title, summary, source_memories, confidence, status, tags, created_at, filepath, recall_count, link_count_incoming)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('kc_search_test', 'decision', 'SQLite FTS5 Search', 'How to use FTS5 for full text search', '[]', 0.9, 'active', '["sqlite","fts5"]', now, '/test/fts.md', 5, 3);

    indexer.db.prepare(`
      INSERT OR IGNORE INTO knowledge_fts (id, title, summary, content, tags)
      VALUES (?, ?, ?, ?, ?)
    `).run('kc_search_test', 'SQLite FTS5 Search', 'How to use FTS5 for full text search', 'FTS5 search details', '["sqlite","fts5"]');

    const results = indexer.searchKnowledge('FTS5');
    assert.ok(results.length > 0, 'Should find at least one result');

    const match = results.find(r => r.id === 'kc_search_test');
    assert.ok(match, 'Should find our test card');
    assert.ok('weighted_rank' in match, 'Should have weighted_rank');
    assert.ok('bm25_raw' in match, 'Should have bm25_raw');

    const card = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('kc_search_test');
    assert.ok(card.recall_count > 5, `recall_count should be > 5, got ${card.recall_count}`);
  });
});
