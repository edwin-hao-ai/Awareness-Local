/**
 * Tests for core/link-discovery.mjs — discover links between docs and code.
 *
 * Scans markdown content for code references (backtick identifiers,
 * file paths, PascalCase names) and matches against known graph_nodes.
 */
// @ts-nocheck


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCodeReferences,
  matchReferencesToNodes,
  discoverLinks,
} from '../src/core/link-discovery.mjs';

// ---------------------------------------------------------------------------
// extractCodeReferences — regex extraction from markdown
// ---------------------------------------------------------------------------

describe('extractCodeReferences', () => {
  it('extracts backtick identifiers', () => {
    const md = 'Use `convertToMarkdown` to convert files. Call `indexer.graphInsertNode()`.';
    const refs = extractCodeReferences(md);
    const names = refs.map(r => r.name);
    assert.ok(names.includes('convertToMarkdown'));
    assert.ok(names.includes('graphInsertNode'));
  });

  it('extracts file paths', () => {
    const md = 'See `src/core/indexer.mjs` for schema.\nAlso check parsers/python.mjs.';
    const refs = extractCodeReferences(md);
    const names = refs.map(r => r.name);
    assert.ok(refs.some(r => r.type === 'path' && r.name.includes('indexer.mjs')));
  });

  it('extracts PascalCase names (likely class/component)', () => {
    const md = 'The WorkspaceScanner class handles scanning. ScanState tracks progress.';
    const refs = extractCodeReferences(md);
    const names = refs.map(r => r.name);
    assert.ok(names.includes('WorkspaceScanner'));
    assert.ok(names.includes('ScanState'));
  });

  it('ignores common words like TODO, README, API', () => {
    const md = 'The README has a TODO list. Check the API docs.';
    const refs = extractCodeReferences(md);
    const names = refs.map(r => r.name);
    assert.ok(!names.includes('README'));
    assert.ok(!names.includes('TODO'));
    assert.ok(!names.includes('API'));
  });

  it('handles empty input', () => {
    const refs = extractCodeReferences('');
    assert.deepEqual(refs, []);
  });

  it('deduplicates references', () => {
    const md = 'Call `foo()` and then `foo()` again.';
    const refs = extractCodeReferences(md);
    const fooRefs = refs.filter(r => r.name === 'foo');
    assert.equal(fooRefs.length, 1);
  });

  it('extracts import-style path references with extensions', () => {
    const md = 'Import from `./utils/helpers.mjs` or see `src/core/indexer.mjs`.';
    const refs = extractCodeReferences(md);
    assert.ok(refs.some(r => r.type === 'path' || r.type === 'backtick'));
    // helpers.mjs should be extracted as a filename backtick ref
    assert.ok(refs.some(r => r.name.includes('helpers.mjs')));
  });
});

// ---------------------------------------------------------------------------
// matchReferencesToNodes — match refs against known symbols/files
// ---------------------------------------------------------------------------

describe('matchReferencesToNodes', () => {
  const knownNodes = [
    { id: 'file:src/core/indexer.mjs', node_type: 'file', title: 'indexer.mjs' },
    { id: 'sym:src/core/indexer.mjs:graphInsertNode:42', node_type: 'symbol', title: 'graphInsertNode' },
    { id: 'sym:src/core/workspace-scanner.mjs:WorkspaceScanner:10', node_type: 'symbol', title: 'WorkspaceScanner' },
    { id: 'file:src/core/parsers/python.mjs', node_type: 'file', title: 'python.mjs' },
  ];

  it('matches backtick reference to symbol node', () => {
    const refs = [{ name: 'graphInsertNode', type: 'backtick', line: 1 }];
    const links = matchReferencesToNodes(refs, knownNodes);
    assert.ok(links.length >= 1);
    assert.ok(links.some(l => l.targetId.includes('graphInsertNode')));
    assert.ok(links[0].confidence >= 0.7);
  });

  it('matches file path reference to file node', () => {
    const refs = [{ name: 'src/core/indexer.mjs', type: 'path', line: 5 }];
    const links = matchReferencesToNodes(refs, knownNodes);
    assert.ok(links.length >= 1);
    assert.ok(links.some(l => l.targetId === 'file:src/core/indexer.mjs'));
    assert.equal(links[0].confidence, 1.0);
  });

  it('matches PascalCase reference to symbol node', () => {
    const refs = [{ name: 'WorkspaceScanner', type: 'pascal', line: 3 }];
    const links = matchReferencesToNodes(refs, knownNodes);
    assert.ok(links.length >= 1);
    assert.ok(links.some(l => l.targetId.includes('WorkspaceScanner')));
  });

  it('returns empty for unmatched reference', () => {
    const refs = [{ name: 'nonExistentThing', type: 'backtick', line: 1 }];
    const links = matchReferencesToNodes(refs, knownNodes);
    assert.equal(links.length, 0);
  });

  it('handles empty inputs', () => {
    assert.deepEqual(matchReferencesToNodes([], knownNodes), []);
    assert.deepEqual(matchReferencesToNodes([{ name: 'foo', type: 'backtick', line: 1 }], []), []);
  });
});

// ---------------------------------------------------------------------------
// discoverLinks — end-to-end: markdown → matched links
// ---------------------------------------------------------------------------

describe('discoverLinks', () => {
  const knownNodes = [
    { id: 'file:src/core/indexer.mjs', node_type: 'file', title: 'indexer.mjs' },
    { id: 'sym:src/core/indexer.mjs:graphInsertNode:42', node_type: 'symbol', title: 'graphInsertNode' },
  ];

  it('discovers links from markdown content', () => {
    const md = '# Architecture\n\nThe `graphInsertNode` function in `src/core/indexer.mjs` handles storage.';
    const links = discoverLinks(md, knownNodes);
    assert.ok(links.length >= 1);
    assert.ok(links.some(l => l.targetId.includes('graphInsertNode') || l.targetId.includes('indexer')));
  });

  it('returns empty for markdown with no code refs', () => {
    const md = '# Meeting Notes\n\nWe discussed the timeline for Q3.';
    const links = discoverLinks(md, knownNodes);
    assert.equal(links.length, 0);
  });

  it('includes confidence scores', () => {
    const md = 'Use `graphInsertNode` for writing nodes.';
    const links = discoverLinks(md, knownNodes);
    for (const link of links) {
      assert.ok(typeof link.confidence === 'number');
      assert.ok(link.confidence > 0 && link.confidence <= 1);
    }
  });
});
