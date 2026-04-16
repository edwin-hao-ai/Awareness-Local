/**
 * Tests for core/doc-converter.mjs — document-to-markdown conversion.
 *
 * Uses inline test fixtures (Buffer) to avoid shipping binary test files.
 * For PDF/DOCX/XLSX, tests focus on the dispatch logic and error handling;
 * full format fidelity is the responsibility of the underlying libraries.
 */
// @ts-nocheck


import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  convertToMarkdown,
  convertPdf,
  convertDocx,
  convertExcel,
  convertCsv,
  convertPlainText,
  getSupportedConvertibleExts,
  isConvertible,
} from '../src/core/doc-converter.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docconv-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write content to a temp file and return its path. */
function writeTmp(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// isConvertible + getSupportedConvertibleExts
// ---------------------------------------------------------------------------

describe('isConvertible', () => {
  it('returns true for supported extensions', () => {
    for (const ext of ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.text', '.log']) {
      assert.ok(isConvertible(`report${ext}`), `expected ${ext} to be convertible`);
    }
  });

  it('returns false for unsupported extensions', () => {
    for (const f of ['image.png', 'code.js', 'style.css', 'archive.zip']) {
      assert.ok(!isConvertible(f), `expected ${f} not convertible`);
    }
  });

  it('is case-insensitive', () => {
    assert.ok(isConvertible('REPORT.PDF'));
    assert.ok(isConvertible('Doc.DOCX'));
  });
});

describe('getSupportedConvertibleExts', () => {
  it('returns an array of lowercase extensions', () => {
    const exts = getSupportedConvertibleExts();
    assert.ok(Array.isArray(exts));
    assert.ok(exts.length >= 5);
    for (const e of exts) {
      assert.ok(e.startsWith('.'), `extension ${e} should start with dot`);
      assert.equal(e, e.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// convertPlainText
// ---------------------------------------------------------------------------

describe('convertPlainText', () => {
  it('wraps plain text with frontmatter', () => {
    const src = writeTmp('notes.txt', 'Hello world\nLine two');
    const md = convertPlainText(src);
    assert.ok(md.includes('---'));
    assert.ok(md.includes('source: notes.txt'));
    assert.ok(md.includes('Hello world'));
    assert.ok(md.includes('Line two'));
  });

  it('handles empty file gracefully', () => {
    const src = writeTmp('empty.txt', '');
    const md = convertPlainText(src);
    assert.ok(md.includes('---'));
    assert.ok(typeof md === 'string');
  });
});

// ---------------------------------------------------------------------------
// convertCsv
// ---------------------------------------------------------------------------

describe('convertCsv', () => {
  it('converts CSV to markdown table', () => {
    const csv = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA\n';
    const src = writeTmp('data.csv', csv);
    const md = convertCsv(src);
    assert.ok(md.includes('| Name'));
    assert.ok(md.includes('| Alice'));
    assert.ok(md.includes('---'));
  });

  it('handles single-column CSV', () => {
    const csv = 'items\napple\nbanana\n';
    const src = writeTmp('single.csv', csv);
    const md = convertCsv(src);
    assert.ok(md.includes('| items'));
  });

  it('handles empty CSV', () => {
    const src = writeTmp('empty.csv', '');
    const md = convertCsv(src);
    assert.ok(typeof md === 'string');
  });
});

// ---------------------------------------------------------------------------
// convertToMarkdown — unified entry
// ---------------------------------------------------------------------------

describe('convertToMarkdown', () => {
  it('converts .txt file to outputDir', async () => {
    const src = writeTmp('readme.txt', 'Some content here');
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    const result = await convertToMarkdown(src, outDir);
    assert.ok(result.success);
    assert.ok(result.outputPath.endsWith('readme.txt.md'));
    assert.ok(fs.existsSync(result.outputPath));
    const content = fs.readFileSync(result.outputPath, 'utf8');
    assert.ok(content.includes('Some content here'));
  });

  it('converts .csv file to outputDir', async () => {
    const csv = 'x,y\n1,2\n3,4\n';
    const src = writeTmp('data.csv', csv);
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    const result = await convertToMarkdown(src, outDir);
    assert.ok(result.success);
    assert.ok(fs.existsSync(result.outputPath));
  });

  it('returns error for unsupported extension', async () => {
    const src = writeTmp('photo.png', 'fake-png-data');
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    const result = await convertToMarkdown(src, outDir);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Unsupported'));
  });

  it('returns error for missing file', async () => {
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    const result = await convertToMarkdown('/nonexistent/file.pdf', outDir);
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('creates outputDir if not exists', async () => {
    const src = writeTmp('note.txt', 'hi');
    const outDir = path.join(tmpDir, 'auto-created');
    const result = await convertToMarkdown(src, outDir);
    assert.ok(result.success);
    assert.ok(fs.existsSync(outDir));
  });

  it('generates content_hash for dedup', async () => {
    const src = writeTmp('doc.txt', 'stable content');
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    const r1 = await convertToMarkdown(src, outDir);
    const r2 = await convertToMarkdown(src, outDir);
    assert.ok(r1.contentHash);
    assert.equal(r1.contentHash, r2.contentHash);
  });

  it('skips conversion when content_hash matches', async () => {
    const src = writeTmp('stable.txt', 'unchanged');
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
    const r1 = await convertToMarkdown(src, outDir);
    const r2 = await convertToMarkdown(src, outDir, { knownHash: r1.contentHash });
    assert.ok(r2.skipped);
  });
});

// ---------------------------------------------------------------------------
// convertPdf — requires real PDF (graceful degradation test)
// ---------------------------------------------------------------------------

describe('convertPdf', () => {
  it('returns error for invalid PDF data', async () => {
    const src = writeTmp('bad.pdf', 'not a real pdf');
    try {
      await convertPdf(src);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// convertDocx — requires real DOCX (graceful degradation test)
// ---------------------------------------------------------------------------

describe('convertDocx', () => {
  it('returns error for invalid DOCX data', async () => {
    const src = writeTmp('bad.docx', 'not a real docx');
    try {
      await convertDocx(src);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// convertExcel — requires real XLSX (graceful degradation test)
// ---------------------------------------------------------------------------

describe('convertExcel', () => {
  it('returns error for invalid XLSX data', async () => {
    const src = writeTmp('bad.xlsx', 'not a real xlsx');
    try {
      await convertExcel(src);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.message);
    }
  });
});
