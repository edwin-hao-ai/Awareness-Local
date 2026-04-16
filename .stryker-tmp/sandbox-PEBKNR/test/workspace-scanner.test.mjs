// @ts-nocheck
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  scanWorkspace,
  isGitRepo,
  getCurrentCommit,
  parseGitDiffOutput,
  getGitChanges,
  indexWorkspaceFiles,
  markDeletedFiles,
  handleRenamedFiles,
} from '../src/core/workspace-scanner.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scanner-test-'));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Create a file tree from a spec like { 'src/app.ts': 'code', 'README.md': '# Hi' } */
function createTree(root, spec) {
  for (const [relPath, content] of Object.entries(spec)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// scanWorkspace Tests
// ---------------------------------------------------------------------------

describe('scanWorkspace', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanDir(tmpDir); });

  it('discovers code and doc files', () => {
    createTree(tmpDir, {
      'src/app.ts': 'const x = 1;',
      'src/utils.js': 'module.exports = {};',
      'README.md': '# Project',
      'docs/guide.txt': 'guide content',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 4);

    const categories = files.map(f => f.category);
    assert.ok(categories.includes('code'));
    assert.ok(categories.includes('docs'));
  });

  it('excludes node_modules and .git directories', () => {
    createTree(tmpDir, {
      'src/app.ts': 'code',
      'node_modules/pkg/index.js': 'package code',
      '.git/config': 'git config',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0].relativePath, path.join('src', 'app.ts'));
  });

  it('excludes sensitive files', () => {
    createTree(tmpDir, {
      'src/app.ts': 'code',
      '.env': 'SECRET=x',
      '.env.local': 'SECRET=y',
      'credentials.json': '{"key":"val"}',
      'id_rsa': 'private key',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0].relativePath), 'app.ts');
  });

  it('excludes lock files and binary patterns', () => {
    createTree(tmpDir, {
      'src/app.ts': 'code',
      'package-lock.json': '{}',
      'yarn.lock': '# lock',
      'bundle.min.js': 'minified',
      'app.map': 'sourcemap',
      'image.png': 'binary',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 1);
  });

  it('respects .gitignore rules', () => {
    createTree(tmpDir, {
      '.gitignore': 'build/\n*.log\n',
      'src/app.ts': 'code',
      'build/output.js': 'built code',
      'debug.log': 'log content',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0].relativePath), 'app.ts');
  });

  it('respects scan-config exclude patterns', () => {
    // Create scan config
    const awarenessDir = path.join(tmpDir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    fs.writeFileSync(path.join(awarenessDir, 'scan-config.json'), JSON.stringify({
      exclude: ['test/**', 'fixtures/**'],
    }));

    createTree(tmpDir, {
      'src/app.ts': 'code',
      'test/app.test.ts': 'test code',
      'fixtures/data.json': '{}',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0].relativePath), 'app.ts');
  });

  it('respects config category toggles', () => {
    createTree(tmpDir, {
      'src/app.ts': 'code',
      'README.md': '# readme',
      'data.pdf': 'pdf content',
      'config.yaml': 'key: val',
    });

    // Disable docs and config
    const files = scanWorkspace(tmpDir, {
      config: { enabled: true, scan_code: true, scan_docs: false, scan_config: false, scan_convertible: false, max_depth: 15, max_total_files: 10000, max_file_size_kb: 500 },
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].category, 'code');
  });

  it('respects max_depth limit', () => {
    createTree(tmpDir, {
      'a/b/c/d/e/deep.ts': 'deep code',
      'shallow.ts': 'shallow code',
    });

    const files = scanWorkspace(tmpDir, {
      config: { enabled: true, scan_code: true, scan_docs: true, max_depth: 2, max_total_files: 10000, max_file_size_kb: 500 },
    });
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0].relativePath), 'shallow.ts');
  });

  it('respects max_total_files limit', () => {
    const tree = {};
    for (let i = 0; i < 20; i++) {
      tree[`file${i}.ts`] = `const x = ${i};`;
    }
    createTree(tmpDir, tree);

    const files = scanWorkspace(tmpDir, {
      config: { enabled: true, scan_code: true, max_depth: 15, max_total_files: 5, max_file_size_kb: 500 },
    });
    assert.equal(files.length, 5);
  });

  it('marks oversized files', () => {
    const bigContent = 'x'.repeat(600 * 1024); // 600KB
    createTree(tmpDir, {
      'big.ts': bigContent,
      'small.ts': 'const x = 1;',
    });

    const files = scanWorkspace(tmpDir);
    const big = files.find(f => f.relativePath.endsWith('big.ts'));
    const small = files.find(f => f.relativePath.endsWith('small.ts'));
    assert.ok(big?.oversized);
    assert.ok(!small?.oversized);
  });

  it('supports AbortController cancellation', () => {
    const tree = {};
    for (let i = 0; i < 50; i++) {
      tree[`file${i}.ts`] = `const x = ${i};`;
    }
    createTree(tmpDir, tree);

    const controller = new AbortController();
    controller.abort(); // Abort immediately

    const files = scanWorkspace(tmpDir, { signal: controller.signal });
    assert.equal(files.length, 0);
  });

  it('returns empty when scanning is disabled', () => {
    createTree(tmpDir, { 'app.ts': 'code' });
    const files = scanWorkspace(tmpDir, {
      config: { enabled: false },
    });
    assert.equal(files.length, 0);
  });

  it('handles .awareness directory exclusion', () => {
    createTree(tmpDir, {
      'src/app.ts': 'code',
      '.awareness/memories/event.md': 'memory',
      '.awareness/knowledge/card.md': 'card',
    });

    const files = scanWorkspace(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(path.basename(files[0].relativePath), 'app.ts');
  });
});

// ---------------------------------------------------------------------------
// Git helpers Tests
// ---------------------------------------------------------------------------

describe('isGitRepo', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanDir(tmpDir); });

  it('returns true for a git repo', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    assert.equal(isGitRepo(tmpDir), true);
  });

  it('returns false for a non-git directory', () => {
    assert.equal(isGitRepo(tmpDir), false);
  });
});

describe('parseGitDiffOutput', () => {
  it('parses Added/Modified/Deleted/Renamed', () => {
    const output = [
      'A\tsrc/new.ts',
      'M\tsrc/existing.ts',
      'D\tsrc/removed.ts',
      'R080\told.ts\tnew.ts',
    ].join('\n');

    const changes = parseGitDiffOutput(output);
    assert.deepEqual(changes.added, ['src/new.ts']);
    assert.deepEqual(changes.modified, ['src/existing.ts']);
    assert.deepEqual(changes.deleted, ['src/removed.ts']);
    assert.deepEqual(changes.renamed, [{ from: 'old.ts', to: 'new.ts' }]);
  });

  it('handles empty output', () => {
    const changes = parseGitDiffOutput('');
    assert.deepEqual(changes, { added: [], modified: [], deleted: [], renamed: [] });
  });

  it('handles null input', () => {
    const changes = parseGitDiffOutput(null);
    assert.deepEqual(changes, { added: [], modified: [], deleted: [], renamed: [] });
  });
});

describe('getCurrentCommit', () => {
  it('returns null for non-git directory', () => {
    const tmpDir = makeTmpDir();
    const result = getCurrentCommit(tmpDir);
    assert.equal(result, null);
    cleanDir(tmpDir);
  });
});

describe('getGitChanges', () => {
  it('returns null when lastCommit is null (triggers full scan)', () => {
    const result = getGitChanges('/tmp', null);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// indexWorkspaceFiles Tests (mock indexer)
// ---------------------------------------------------------------------------

describe('indexWorkspaceFiles', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanDir(tmpDir); });

  function mockIndexer() {
    const nodes = new Map();
    const edges = [];
    return {
      nodes,
      edges,
      getGraphNode(id) { return nodes.get(id) || null; },
      graphInsertNode(node) {
        nodes.set(node.id, { ...node });
        return { inserted: true };
      },
      graphInsertEdge(edge) {
        edges.push(edge);
        return { inserted: true };
      },
    };
  }

  it('indexes files into graph nodes', async () => {
    createTree(tmpDir, {
      'src/app.ts': 'const x = 1;',
      'src/utils.ts': 'export function foo() {}',
    });

    const files = [
      { absolutePath: path.join(tmpDir, 'src/app.ts'), relativePath: 'src/app.ts', category: 'code', size: 14, mtime: Date.now(), oversized: false },
      { absolutePath: path.join(tmpDir, 'src/utils.ts'), relativePath: 'src/utils.ts', category: 'code', size: 25, mtime: Date.now(), oversized: false },
    ];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    assert.equal(result.indexed, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    // 2 file nodes + symbol nodes (foo from utils.ts)
    assert.ok(indexer.nodes.size >= 2);
    assert.ok(indexer.nodes.has('file:src/app.ts'));
    assert.ok(indexer.nodes.has('file:src/utils.ts'));
  });

  it('skips unchanged files via content_hash', async () => {
    const content = 'const x = 1;';
    createTree(tmpDir, { 'app.ts': content });

    const files = [{
      absolutePath: path.join(tmpDir, 'app.ts'),
      relativePath: 'app.ts',
      category: 'code',
      size: content.length,
      mtime: Date.now(),
      oversized: false,
    }];

    const indexer = mockIndexer();
    // First index
    await indexWorkspaceFiles(files, indexer);
    assert.equal(indexer.nodes.size, 1);

    // Second index — same content → skip
    const result = await indexWorkspaceFiles(files, indexer);
    assert.equal(result.skipped, 1);
    assert.equal(result.indexed, 0);
  });

  it('creates import edges for relative imports', async () => {
    createTree(tmpDir, {
      'src/app.ts': "import { foo } from './utils.ts';\nconst x = foo();",
      'src/utils.ts': 'export function foo() { return 1; }',
    });

    const files = [
      { absolutePath: path.join(tmpDir, 'src/app.ts'), relativePath: 'src/app.ts', category: 'code', size: 50, mtime: Date.now(), oversized: false },
      { absolutePath: path.join(tmpDir, 'src/utils.ts'), relativePath: 'src/utils.ts', category: 'code', size: 40, mtime: Date.now(), oversized: false },
    ];

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer);

    assert.ok(result.edges > 0);
    assert.ok(indexer.edges.some(e =>
      e.from_node_id === 'file:src/app.ts' &&
      e.to_node_id === 'file:src/utils.ts' &&
      e.edge_type === 'import'
    ));
  });

  it('handles AbortController cancellation', async () => {
    createTree(tmpDir, { 'a.ts': 'code' });
    const files = [{
      absolutePath: path.join(tmpDir, 'a.ts'),
      relativePath: 'a.ts',
      category: 'code',
      size: 4,
      mtime: Date.now(),
      oversized: false,
    }];

    const controller = new AbortController();
    controller.abort();

    const indexer = mockIndexer();
    const result = await indexWorkspaceFiles(files, indexer, { signal: controller.signal });
    assert.equal(result.indexed, 0);
  });

  it('calls onProgress during indexing', async () => {
    const tree = {};
    for (let i = 0; i < 5; i++) {
      tree[`file${i}.ts`] = `const x = ${i};`;
    }
    createTree(tmpDir, tree);

    const files = Object.keys(tree).map(name => ({
      absolutePath: path.join(tmpDir, name),
      relativePath: name,
      category: 'code',
      size: 14,
      mtime: Date.now(),
      oversized: false,
    }));

    const progressCalls = [];
    const indexer = mockIndexer();
    await indexWorkspaceFiles(files, indexer, {
      onProgress: (p) => progressCalls.push(p),
    });

    assert.ok(progressCalls.length > 0);
    assert.equal(progressCalls[0].phase, 'indexing');
  });

  it('returns empty result for empty file list', async () => {
    const result = await indexWorkspaceFiles([], mockIndexer());
    assert.deepEqual(result, { indexed: 0, skipped: 0, errors: 0, edges: 0 });
  });
});

// ---------------------------------------------------------------------------
// markDeletedFiles / handleRenamedFiles Tests
// ---------------------------------------------------------------------------

describe('markDeletedFiles', () => {
  it('marks nodes as deleted', () => {
    const prepared = [];
    const mockIndexer = {
      db: {
        prepare(sql) {
          return {
            run(...args) { prepared.push({ sql, args }); },
          };
        },
      },
    };

    const count = markDeletedFiles(['src/old.ts', 'src/removed.ts'], mockIndexer);
    assert.equal(count, 2);
    assert.equal(prepared.length, 2);
  });
});

describe('handleRenamedFiles', () => {
  it('marks old paths as deleted', () => {
    const operations = [];
    const mockIndexer = {
      db: {
        prepare(sql) {
          return {
            run(...args) { operations.push({ sql, args }); },
          };
        },
      },
    };

    const count = handleRenamedFiles([
      { from: 'old.ts', to: 'new.ts' },
    ], mockIndexer);
    assert.equal(count, 1);
  });
});
