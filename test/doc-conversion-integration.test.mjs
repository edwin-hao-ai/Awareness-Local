/**
 * Integration tests for document conversion within the workspace scanner pipeline.
 *
 * Tests T-020: convertible files detected during scan get auto-converted
 * and indexed as graph_nodes with converted markdown content.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { convertDocumentsInBatch } from '../src/core/doc-converter.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docint-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// convertDocumentsInBatch — batch conversion for scanner pipeline
// ---------------------------------------------------------------------------

describe('convertDocumentsInBatch', () => {
  it('converts multiple text files in one call', async () => {
    const outDir = path.join(tmpDir, 'converted');
    fs.mkdirSync(outDir);

    const files = [
      { absolutePath: writeTmp('a.txt', 'content A'), relativePath: 'a.txt', category: 'convertible' },
      { absolutePath: writeTmp('b.csv', 'x,y\n1,2'), relativePath: 'b.csv', category: 'convertible' },
    ];

    const results = await convertDocumentsInBatch(files, outDir);
    assert.equal(results.length, 2);
    assert.ok(results[0].success);
    assert.ok(results[1].success);
    assert.ok(fs.existsSync(results[0].outputPath));
    assert.ok(fs.existsSync(results[1].outputPath));
  });

  it('skips non-convertible files', async () => {
    const outDir = path.join(tmpDir, 'converted');
    fs.mkdirSync(outDir);

    const files = [
      { absolutePath: writeTmp('code.js', 'const x = 1;'), relativePath: 'code.js', category: 'code' },
      { absolutePath: writeTmp('note.txt', 'hello'), relativePath: 'note.txt', category: 'convertible' },
    ];

    const results = await convertDocumentsInBatch(files, outDir);
    // Only the convertible file gets processed
    assert.equal(results.length, 1);
    assert.ok(results[0].success);
  });

  it('uses content_hash to skip unchanged files', async () => {
    const outDir = path.join(tmpDir, 'converted');
    fs.mkdirSync(outDir);

    const files = [
      { absolutePath: writeTmp('stable.txt', 'no change'), relativePath: 'stable.txt', category: 'convertible' },
    ];

    const r1 = await convertDocumentsInBatch(files, outDir);
    assert.ok(r1[0].success);
    assert.ok(!r1[0].skipped);

    // Second call with known hashes
    const hashMap = { 'stable.txt': r1[0].contentHash };
    const r2 = await convertDocumentsInBatch(files, outDir, { hashMap });
    assert.ok(r2[0].skipped);
  });

  it('returns empty array for empty input', async () => {
    const outDir = path.join(tmpDir, 'converted');
    fs.mkdirSync(outDir);
    const results = await convertDocumentsInBatch([], outDir);
    assert.deepEqual(results, []);
  });

  it('handles errors gracefully without stopping batch', async () => {
    const outDir = path.join(tmpDir, 'converted');
    fs.mkdirSync(outDir);

    const files = [
      { absolutePath: '/nonexistent/file.txt', relativePath: 'missing.txt', category: 'convertible' },
      { absolutePath: writeTmp('ok.txt', 'fine'), relativePath: 'ok.txt', category: 'convertible' },
    ];

    const results = await convertDocumentsInBatch(files, outDir);
    assert.equal(results.length, 2);
    assert.equal(results[0].success, false);
    assert.ok(results[1].success);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}
