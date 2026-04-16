/**
 * Integration tests for Phase 2: symbol extraction → graph_nodes + graph_edges.
 *
 * Tests the full pipeline: detectLanguage → extractFile → graphInsertNode/Edge
 * through the workspace-scanner indexWorkspaceFiles function.
 */
// @ts-nocheck


import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { indexWorkspaceFiles } from '../src/core/workspace-scanner.mjs';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p2-integ-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTree(baseDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function mockIndexer() {
  const nodes = new Map();
  const edges = [];
  return {
    nodes,
    edges,
    getGraphNode(id) {
      return nodes.get(id) || null;
    },
    graphInsertNode(node) {
      nodes.set(node.id, node);
      return { inserted: true };
    },
    graphInsertEdge(edge) {
      edges.push(edge);
      return { inserted: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 2 Integration: symbol extraction pipeline', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTmpDir(); });
  afterEach(() => { cleanup(tmpDir); });

  it('extracts JS function symbols into graph_nodes', async () => {
    createTree(tmpDir, {
      'src/utils.mjs': `
export function parseJSON(str) {
  return JSON.parse(str);
}

export const FORMAT_VERSION = 2;

/**
 * Validate input data.
 */
export function validate(data) {
  return data != null;
}
`,
    });

    const files = [{
      absolutePath: path.join(tmpDir, 'src/utils.mjs'),
      relativePath: 'src/utils.mjs',
      category: 'code',
      size: 200,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    // Should have file node + symbol nodes
    assert.ok(indexer.nodes.has('file:src/utils.mjs'));
    assert.equal(result.indexed, 1);

    // Check symbol nodes exist
    const symbolNodes = [...indexer.nodes.values()].filter(n => n.node_type === 'symbol');
    assert.ok(symbolNodes.length >= 2, `Expected at least 2 symbols, got ${symbolNodes.length}`);

    // Check parseJSON symbol
    const parseJSONSym = symbolNodes.find(n => n.title === 'parseJSON');
    assert.ok(parseJSONSym, 'parseJSON symbol should exist');
    assert.equal(parseJSONSym.metadata.symbol_type, 'function');
    assert.equal(parseJSONSym.metadata.exported, true);
    assert.equal(parseJSONSym.metadata.language, 'javascript');

    // Check validate symbol has JSDoc
    const validateSym = symbolNodes.find(n => n.title === 'validate');
    assert.ok(validateSym, 'validate symbol should exist');
    assert.ok(validateSym.content.includes('Validate input data'));

    // Check 'contains' edges from file to symbols
    const containsEdges = indexer.edges.filter(e => e.edge_type === 'contains');
    assert.ok(containsEdges.length >= 2);
    assert.ok(containsEdges.every(e => e.from_node_id === 'file:src/utils.mjs'));
  });

  it('extracts TypeScript interface/type into graph_nodes', async () => {
    createTree(tmpDir, {
      'src/types.ts': `
export interface Config {
  port: number;
  host: string;
}

export type UserId = string;

export enum Status {
  Active,
  Inactive,
}
`,
    });

    const files = [{
      absolutePath: path.join(tmpDir, 'src/types.ts'),
      relativePath: 'src/types.ts',
      category: 'code',
      size: 150,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    await indexWorkspaceFiles(files, indexer);

    const symbolNodes = [...indexer.nodes.values()].filter(n => n.node_type === 'symbol');
    assert.ok(symbolNodes.find(n => n.title === 'Config' && n.metadata.symbol_type === 'interface'));
    assert.ok(symbolNodes.find(n => n.title === 'UserId' && n.metadata.symbol_type === 'type'));
    assert.ok(symbolNodes.find(n => n.title === 'Status' && n.metadata.symbol_type === 'enum'));
  });

  it('extracts Python symbols with decorators', async () => {
    createTree(tmpDir, {
      'app.py': `
from fastapi import FastAPI

app = FastAPI()

class UserService:
    def get_user(self, id):
        pass

    def _private(self):
        pass

def public_helper():
    pass
`,
    });

    const files = [{
      absolutePath: path.join(tmpDir, 'app.py'),
      relativePath: 'app.py',
      category: 'code',
      size: 200,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    await indexWorkspaceFiles(files, indexer);

    const symbolNodes = [...indexer.nodes.values()].filter(n => n.node_type === 'symbol');
    assert.ok(symbolNodes.find(n => n.title === 'UserService' && n.metadata.symbol_type === 'class'));
    assert.ok(symbolNodes.find(n => n.title === 'get_user' && n.metadata.symbol_type === 'method'));
    assert.ok(symbolNodes.find(n => n.title === 'public_helper' && n.metadata.symbol_type === 'function'));
  });

  it('creates import edges between files', async () => {
    createTree(tmpDir, {
      'src/index.mjs': `import { helper } from './utils.mjs';\nconsole.log(helper());`,
      'src/utils.mjs': `export function helper() { return 42; }`,
    });

    const files = [
      { absolutePath: path.join(tmpDir, 'src/index.mjs'), relativePath: 'src/index.mjs', category: 'code', size: 80, mtime: Date.now(), oversized: false },
      { absolutePath: path.join(tmpDir, 'src/utils.mjs'), relativePath: 'src/utils.mjs', category: 'code', size: 50, mtime: Date.now(), oversized: false },
    ];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    // Should have import edge from index.mjs → utils.mjs
    const importEdges = indexer.edges.filter(e => e.edge_type === 'import');
    assert.ok(importEdges.length >= 1, `Expected import edges, got ${importEdges.length}`);
    assert.ok(importEdges.find(e =>
      e.from_node_id === 'file:src/index.mjs' &&
      e.to_node_id === 'file:src/utils.mjs'
    ), 'import edge from index → utils should exist');
  });

  it('creates both import and contains edges', async () => {
    createTree(tmpDir, {
      'a.mjs': `import { b } from './b.mjs';\nexport function aFunc() {}`,
      'b.mjs': `export function bFunc() {}`,
    });

    const files = [
      { absolutePath: path.join(tmpDir, 'a.mjs'), relativePath: 'a.mjs', category: 'code', size: 60, mtime: Date.now(), oversized: false },
      { absolutePath: path.join(tmpDir, 'b.mjs'), relativePath: 'b.mjs', category: 'code', size: 30, mtime: Date.now(), oversized: false },
    ];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    const importEdges = indexer.edges.filter(e => e.edge_type === 'import');
    const containsEdges = indexer.edges.filter(e => e.edge_type === 'contains');

    assert.ok(importEdges.length >= 1, 'Should have import edges');
    assert.ok(containsEdges.length >= 2, 'Should have contains edges');
    assert.ok(result.edges >= 3, 'Total edges should include import + contains');
  });

  it('reports symbols count in result', async () => {
    createTree(tmpDir, {
      'lib.mjs': `export function a() {}\nexport function b() {}\nexport class C {}`,
    });

    const files = [{
      absolutePath: path.join(tmpDir, 'lib.mjs'),
      relativePath: 'lib.mjs',
      category: 'code',
      size: 70,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);
    assert.ok(result.symbols >= 3, `Expected 3+ symbols, got ${result.symbols}`);
  });

  it('skips annotation symbols (TODO/FIXME) from graph', async () => {
    createTree(tmpDir, {
      'app.mjs': `// TODO: implement this\nexport function stub() {}`,
    });

    const files = [{
      absolutePath: path.join(tmpDir, 'app.mjs'),
      relativePath: 'app.mjs',
      category: 'code',
      size: 50,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    await indexWorkspaceFiles(files, indexer);

    const symbolNodes = [...indexer.nodes.values()].filter(n => n.node_type === 'symbol');
    assert.ok(!symbolNodes.find(n => n.title === 'TODO'), 'TODO annotation should NOT be in graph');
    assert.ok(symbolNodes.find(n => n.title === 'stub'), 'stub function should be in graph');
  });

  it('handles non-code files gracefully (no symbol extraction)', async () => {
    createTree(tmpDir, {
      'README.md': `# Project\n\n## Setup\n\nRun npm install.`,
    });

    const files = [{
      absolutePath: path.join(tmpDir, 'README.md'),
      relativePath: 'README.md',
      category: 'docs',
      size: 40,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    assert.equal(result.indexed, 1);
    assert.ok(indexer.nodes.has('file:README.md'));
    // Docs don't get symbol extraction (only code files)
    const symbolNodes = [...indexer.nodes.values()].filter(n => n.node_type === 'symbol');
    assert.equal(symbolNodes.length, 0);
  });

  it('handles mixed language project', async () => {
    createTree(tmpDir, {
      'src/server.mjs': `import express from 'express';\nexport function createApp() {}`,
      'src/handler.py': `def handle_request(req):\n    pass`,
      'docs/README.md': `# API\n\nSee [server](../src/server.mjs).`,
    });

    const files = [
      { absolutePath: path.join(tmpDir, 'src/server.mjs'), relativePath: 'src/server.mjs', category: 'code', size: 70, mtime: Date.now(), oversized: false },
      { absolutePath: path.join(tmpDir, 'src/handler.py'), relativePath: 'src/handler.py', category: 'code', size: 40, mtime: Date.now(), oversized: false },
      { absolutePath: path.join(tmpDir, 'docs/README.md'), relativePath: 'docs/README.md', category: 'docs', size: 50, mtime: Date.now(), oversized: false },
    ];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    assert.equal(result.indexed, 3);
    // JS symbol
    const jsSym = [...indexer.nodes.values()].find(n => n.title === 'createApp');
    assert.ok(jsSym, 'JS function should be extracted');
    assert.equal(jsSym.metadata.language, 'javascript');
    // Python symbol
    const pySym = [...indexer.nodes.values()].find(n => n.title === 'handle_request');
    assert.ok(pySym, 'Python function should be extracted');
    assert.equal(pySym.metadata.language, 'python');
  });
});
