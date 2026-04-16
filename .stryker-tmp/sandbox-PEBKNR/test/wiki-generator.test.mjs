/**
 * Tests for core/wiki-generator.mjs — auto-generate wiki pages from graph data.
 *
 * Wiki pages are zero-LLM rule-based summaries:
 *   - Module pages: aggregate files by directory
 *   - Concept pages: aggregate by high-frequency tags
 */
// @ts-nocheck


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateModulePage,
  generateConceptPage,
  generateWikiPages,
  buildDirectoryTree,
} from '../src/core/wiki-generator.mjs';

// ---------------------------------------------------------------------------
// Mock graph nodes for tests
// ---------------------------------------------------------------------------

const MOCK_NODES = [
  {
    id: 'file:src/core/indexer.mjs',
    node_type: 'file',
    title: 'indexer.mjs',
    content: 'SQLite indexer with graph support',
    metadata: { relativePath: 'src/core/indexer.mjs', category: 'code' },
  },
  {
    id: 'file:src/core/workspace-scanner.mjs',
    node_type: 'file',
    title: 'workspace-scanner.mjs',
    content: 'Recursive file discovery and indexing',
    metadata: { relativePath: 'src/core/workspace-scanner.mjs', category: 'code' },
  },
  {
    id: 'file:src/core/doc-converter.mjs',
    node_type: 'file',
    title: 'doc-converter.mjs',
    content: 'Document to markdown conversion',
    metadata: { relativePath: 'src/core/doc-converter.mjs', category: 'code' },
  },
  {
    id: 'file:src/daemon.mjs',
    node_type: 'file',
    title: 'daemon.mjs',
    content: 'Main daemon entry point',
    metadata: { relativePath: 'src/daemon.mjs', category: 'code' },
  },
  {
    id: 'sym:src/core/indexer.mjs:graphInsertNode:42',
    node_type: 'symbol',
    title: 'graphInsertNode',
    content: 'graphInsertNode(node)',
    metadata: { symbol_type: 'function', file: 'src/core/indexer.mjs', exported: true },
  },
  {
    id: 'sym:src/core/workspace-scanner.mjs:scanWorkspace:30',
    node_type: 'symbol',
    title: 'scanWorkspace',
    content: 'scanWorkspace(projectDir, options)',
    metadata: { symbol_type: 'function', file: 'src/core/workspace-scanner.mjs', exported: true },
  },
  {
    id: 'sym:src/core/workspace-scanner.mjs:indexWorkspaceFiles:100',
    node_type: 'symbol',
    title: 'indexWorkspaceFiles',
    content: 'indexWorkspaceFiles(files, indexer, options)',
    metadata: { symbol_type: 'function', file: 'src/core/workspace-scanner.mjs', exported: true },
  },
];

const MOCK_EDGES = [
  { from_node_id: 'file:src/core/indexer.mjs', to_node_id: 'sym:src/core/indexer.mjs:graphInsertNode:42', edge_type: 'contains' },
  { from_node_id: 'file:src/core/workspace-scanner.mjs', to_node_id: 'sym:src/core/workspace-scanner.mjs:scanWorkspace:30', edge_type: 'contains' },
  { from_node_id: 'file:src/core/workspace-scanner.mjs', to_node_id: 'sym:src/core/workspace-scanner.mjs:indexWorkspaceFiles:100', edge_type: 'contains' },
  { from_node_id: 'file:src/core/workspace-scanner.mjs', to_node_id: 'file:src/core/indexer.mjs', edge_type: 'import' },
  { from_node_id: 'file:src/core/workspace-scanner.mjs', to_node_id: 'file:src/core/doc-converter.mjs', edge_type: 'import' },
];

// ---------------------------------------------------------------------------
// buildDirectoryTree
// ---------------------------------------------------------------------------

describe('buildDirectoryTree', () => {
  it('groups files by directory', () => {
    const tree = buildDirectoryTree(MOCK_NODES.filter(n => n.node_type === 'file'));
    assert.ok(tree.has('src/core'));
    assert.ok(tree.has('src'));
    assert.equal(tree.get('src/core').length, 3); // indexer, workspace-scanner, doc-converter
    assert.equal(tree.get('src').length, 1);       // daemon.mjs
  });

  it('handles root-level files', () => {
    const nodes = [
      { id: 'file:package.json', node_type: 'file', title: 'package.json', metadata: { relativePath: 'package.json' } },
    ];
    const tree = buildDirectoryTree(nodes);
    assert.ok(tree.has('.'));
    assert.equal(tree.get('.').length, 1);
  });

  it('returns empty map for empty input', () => {
    const tree = buildDirectoryTree([]);
    assert.equal(tree.size, 0);
  });
});

// ---------------------------------------------------------------------------
// generateModulePage
// ---------------------------------------------------------------------------

describe('generateModulePage', () => {
  it('generates markdown for a directory module', () => {
    const files = MOCK_NODES.filter(n => n.node_type === 'file' && n.metadata.relativePath.startsWith('src/core/'));
    const symbols = MOCK_NODES.filter(n => n.node_type === 'symbol');
    const md = generateModulePage('src/core', files, symbols, MOCK_EDGES);

    assert.ok(md.includes('# src/core'));
    assert.ok(md.includes('indexer.mjs'));
    assert.ok(md.includes('workspace-scanner.mjs'));
    assert.ok(md.includes('doc-converter.mjs'));
  });

  it('includes exported symbols in module page', () => {
    const files = MOCK_NODES.filter(n => n.node_type === 'file' && n.metadata.relativePath.startsWith('src/core/'));
    const symbols = MOCK_NODES.filter(n => n.node_type === 'symbol');
    const md = generateModulePage('src/core', files, symbols, MOCK_EDGES);

    assert.ok(md.includes('graphInsertNode'));
    assert.ok(md.includes('scanWorkspace'));
  });

  it('includes dependency info', () => {
    const files = MOCK_NODES.filter(n => n.node_type === 'file' && n.metadata.relativePath.startsWith('src/core/'));
    const symbols = MOCK_NODES.filter(n => n.node_type === 'symbol');
    const md = generateModulePage('src/core', files, symbols, MOCK_EDGES);

    // workspace-scanner imports indexer and doc-converter
    assert.ok(md.includes('import'));
  });

  it('handles empty file list', () => {
    const md = generateModulePage('empty/dir', [], [], []);
    assert.ok(md.includes('# empty/dir'));
    assert.ok(md.includes('No files'));
  });
});

// ---------------------------------------------------------------------------
// generateConceptPage
// ---------------------------------------------------------------------------

describe('generateConceptPage', () => {
  it('generates a concept page from tagged nodes', () => {
    const taggedNodes = [
      { id: 'kc_1', title: 'Graph Node Design', tags: ['graph', 'schema'] },
      { id: 'kc_2', title: 'Graph Traversal Algorithm', tags: ['graph', 'algorithm'] },
      { id: 'kc_3', title: 'Graph Edge Types', tags: ['graph', 'schema'] },
    ];
    const md = generateConceptPage('graph', taggedNodes);
    assert.ok(md.includes('# graph'));
    assert.ok(md.includes('Graph Node Design'));
    assert.ok(md.includes('Graph Traversal Algorithm'));
    assert.ok(md.includes('3'));
  });

  it('handles empty tagged nodes', () => {
    const md = generateConceptPage('orphan-topic', []);
    assert.ok(md.includes('# orphan-topic'));
    assert.ok(md.includes('No'));
  });
});

// ---------------------------------------------------------------------------
// generateWikiPages — end-to-end
// ---------------------------------------------------------------------------

describe('generateWikiPages', () => {
  it('generates module pages for each directory', () => {
    const pages = generateWikiPages(MOCK_NODES, MOCK_EDGES, []);
    const moduleSlugs = pages.filter(p => p.slug.startsWith('modules/')).map(p => p.slug);
    assert.ok(moduleSlugs.includes('modules/src/core'));
    assert.ok(moduleSlugs.includes('modules/src'));
  });

  it('generates concept pages from tagged knowledge cards', () => {
    const cards = [
      { id: 'kc_1', title: 'Card A', tags: ['graph', 'schema'] },
      { id: 'kc_2', title: 'Card B', tags: ['graph', 'testing'] },
      { id: 'kc_3', title: 'Card C', tags: ['graph', 'testing'] },
    ];
    const pages = generateWikiPages([], [], cards);
    const conceptSlugs = pages.filter(p => p.slug.startsWith('concepts/')).map(p => p.slug);
    // 'graph' appears 3 times (≥ 2 threshold) → concept page
    assert.ok(conceptSlugs.includes('concepts/graph'));
  });

  it('returns wiki page objects with required fields', () => {
    const pages = generateWikiPages(MOCK_NODES, MOCK_EDGES, []);
    for (const page of pages) {
      assert.ok(page.slug, 'missing slug');
      assert.ok(page.title, 'missing title');
      assert.ok(page.content, 'missing content');
      assert.ok(page.pageType === 'module' || page.pageType === 'concept');
    }
  });

  it('returns empty for no data', () => {
    const pages = generateWikiPages([], [], []);
    assert.deepEqual(pages, []);
  });
});
