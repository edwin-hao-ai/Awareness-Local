/**
 * Tests for gitignore-parser.mjs
 *
 * Covers: global gitignore, project .gitignore, negation (!), **,
 *         subdirectory .gitignore, extra patterns from scan-config.
 */
// @ts-nocheck


import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadGitignoreRules, loadSubdirGitignore } from '../src/core/gitignore-parser.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-test-'));
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadGitignoreRules', () => {
  let tmpDir;

  before(() => {
    tmpDir = makeTmpDir();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a filter that does not ignore any path when no .gitignore exists', () => {
    const emptyDir = makeTmpDir();
    const filter = loadGitignoreRules(emptyDir);
    assert.equal(filter.isIgnored('src/index.js'), false);
    assert.equal(filter.isIgnored('README.md'), false);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('respects basic .gitignore patterns', () => {
    writeFile(tmpDir, '.gitignore', 'node_modules/\n*.log\n');
    const filter = loadGitignoreRules(tmpDir);
    assert.equal(filter.isIgnored('node_modules/express/index.js'), true);
    assert.equal(filter.isIgnored('debug.log'), true);
    assert.equal(filter.isIgnored('src/app.js'), false);
  });

  it('handles ** glob patterns', () => {
    const dir = makeTmpDir();
    writeFile(dir, '.gitignore', '**/build/\n**/*.min.js\n');
    const filter = loadGitignoreRules(dir);
    assert.equal(filter.isIgnored('build/output.js'), true);
    assert.equal(filter.isIgnored('packages/ui/build/index.js'), true);
    assert.equal(filter.isIgnored('lib/bundle.min.js'), true);
    assert.equal(filter.isIgnored('lib/bundle.js'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles negation patterns (!)', () => {
    const dir = makeTmpDir();
    writeFile(dir, '.gitignore', '*.log\n!important.log\n');
    const filter = loadGitignoreRules(dir);
    assert.equal(filter.isIgnored('debug.log'), true);
    assert.equal(filter.isIgnored('important.log'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts extra patterns from scan-config', () => {
    const dir = makeTmpDir();
    writeFile(dir, '.gitignore', 'node_modules/\n');
    const filter = loadGitignoreRules(dir, {
      extraPatterns: ['test/fixtures/**', 'generated/**'],
    });
    assert.equal(filter.isIgnored('node_modules/foo'), true);
    assert.equal(filter.isIgnored('test/fixtures/sample.txt'), true);
    assert.equal(filter.isIgnored('generated/output.js'), true);
    assert.equal(filter.isIgnored('src/main.ts'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles empty relative path gracefully', () => {
    const filter = loadGitignoreRules(tmpDir);
    assert.equal(filter.isIgnored(''), false);
  });

  it('addPatterns allows dynamic rule additions', () => {
    const dir = makeTmpDir();
    const filter = loadGitignoreRules(dir);
    assert.equal(filter.isIgnored('temp/cache.json'), false);
    filter.addPatterns(['temp/']);
    assert.equal(filter.isIgnored('temp/cache.json'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadSubdirGitignore', () => {
  it('returns null when no .gitignore exists in subdirectory', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const result = loadSubdirGitignore(dir, path.join(dir, 'src'));
    assert.equal(result, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies subdirectory .gitignore rules scoped to that directory', () => {
    const dir = makeTmpDir();
    writeFile(dir, 'packages/ui/.gitignore', 'dist/\n*.css.map\n');
    const filter = loadSubdirGitignore(dir, path.join(dir, 'packages/ui'));
    assert.ok(filter);
    // Should ignore files within packages/ui/
    assert.equal(filter.isIgnored('packages/ui/dist/bundle.js'), true);
    assert.equal(filter.isIgnored('packages/ui/styles.css.map'), true);
    // Should NOT affect files outside packages/ui/
    assert.equal(filter.isIgnored('packages/api/dist/index.js'), false);
    assert.equal(filter.isIgnored('src/styles.css.map'), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
