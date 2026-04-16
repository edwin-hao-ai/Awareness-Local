/**
 * Tests for scan-defaults.mjs
 *
 * Covers: file categorization, directory exclusion, file exclusion,
 *         sensitive file detection, full classification pipeline.
 */
// @ts-nocheck


import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFileCategory,
  isExcludedDir,
  isExcludedFile,
  isSensitiveFile,
  classifyFile,
  SCANNABLE_EXTENSIONS,
  ALWAYS_EXCLUDE_DIRS,
  ALWAYS_EXCLUDE_FILES,
} from '../src/core/scan-defaults.mjs';

// ---------------------------------------------------------------------------
// getFileCategory
// ---------------------------------------------------------------------------

describe('getFileCategory', () => {
  it('classifies JavaScript/TypeScript files as code', () => {
    assert.equal(getFileCategory('app.js'), 'code');
    assert.equal(getFileCategory('server.mjs'), 'code');
    assert.equal(getFileCategory('types.ts'), 'code');
    assert.equal(getFileCategory('App.tsx'), 'code');
    assert.equal(getFileCategory('App.jsx'), 'code');
  });

  it('classifies Python files as code', () => {
    assert.equal(getFileCategory('main.py'), 'code');
    assert.equal(getFileCategory('types.pyi'), 'code');
  });

  it('classifies Go, Rust, Java, Swift as code', () => {
    assert.equal(getFileCategory('main.go'), 'code');
    assert.equal(getFileCategory('lib.rs'), 'code');
    assert.equal(getFileCategory('App.java'), 'code');
    assert.equal(getFileCategory('ViewController.swift'), 'code');
  });

  it('classifies markdown/text as docs', () => {
    assert.equal(getFileCategory('README.md'), 'docs');
    assert.equal(getFileCategory('guide.mdx'), 'docs');
    assert.equal(getFileCategory('notes.txt'), 'docs');
    assert.equal(getFileCategory('index.rst'), 'docs');
  });

  it('classifies PDF/DOCX as convertible', () => {
    assert.equal(getFileCategory('report.pdf'), 'convertible');
    assert.equal(getFileCategory('spec.docx'), 'convertible');
    assert.equal(getFileCategory('data.xlsx'), 'convertible');
    assert.equal(getFileCategory('data.csv'), 'convertible');
  });

  it('classifies JSON/YAML/TOML as config', () => {
    assert.equal(getFileCategory('package.json'), 'config');
    assert.equal(getFileCategory('config.yaml'), 'config');
    assert.equal(getFileCategory('config.yml'), 'config');
    assert.equal(getFileCategory('Cargo.toml'), 'config');
  });

  it('recognizes special basenames as config', () => {
    assert.equal(getFileCategory('Dockerfile'), 'config');
    assert.equal(getFileCategory('Makefile'), 'config');
    assert.equal(getFileCategory('Rakefile'), 'config');
  });

  it('recognizes special basenames as docs', () => {
    assert.equal(getFileCategory('README'), 'docs');
    assert.equal(getFileCategory('LICENSE'), 'docs');
    assert.equal(getFileCategory('CHANGELOG'), 'docs');
    assert.equal(getFileCategory('CONTRIBUTING'), 'docs');
  });

  it('returns null for unknown file types', () => {
    assert.equal(getFileCategory('image.png'), null);
    assert.equal(getFileCategory('video.mp4'), null);
    assert.equal(getFileCategory('font.woff2'), null);
    assert.equal(getFileCategory('archive.zip'), null);
    assert.equal(getFileCategory('unknown'), null);
  });

  it('handles paths with directories', () => {
    assert.equal(getFileCategory('src/core/indexer.mjs'), 'code');
    assert.equal(getFileCategory('docs/guide.md'), 'docs');
  });

  it('classifies Vue and Svelte as code', () => {
    assert.equal(getFileCategory('App.vue'), 'code');
    assert.equal(getFileCategory('Page.svelte'), 'code');
  });
});

// ---------------------------------------------------------------------------
// isExcludedDir
// ---------------------------------------------------------------------------

describe('isExcludedDir', () => {
  it('excludes node_modules', () => {
    assert.equal(isExcludedDir('node_modules'), true);
  });

  it('excludes .git', () => {
    assert.equal(isExcludedDir('.git'), true);
  });

  it('excludes build directories', () => {
    assert.equal(isExcludedDir('dist'), true);
    assert.equal(isExcludedDir('build'), true);
    assert.equal(isExcludedDir('out'), true);
    assert.equal(isExcludedDir('target'), true);
  });

  it('excludes IDE directories', () => {
    assert.equal(isExcludedDir('.idea'), true);
    assert.equal(isExcludedDir('.vscode'), true);
  });

  it('excludes .awareness itself', () => {
    assert.equal(isExcludedDir('.awareness'), true);
  });

  it('does not exclude normal directories', () => {
    assert.equal(isExcludedDir('src'), false);
    assert.equal(isExcludedDir('lib'), false);
    assert.equal(isExcludedDir('components'), false);
  });
});

// ---------------------------------------------------------------------------
// isExcludedFile
// ---------------------------------------------------------------------------

describe('isExcludedFile', () => {
  it('excludes .DS_Store', () => {
    assert.equal(isExcludedFile('.DS_Store'), true);
  });

  it('excludes .env files', () => {
    assert.equal(isExcludedFile('.env'), true);
    assert.equal(isExcludedFile('.env.local'), true);
    assert.equal(isExcludedFile('.env.production'), true);
  });

  it('excludes lock files', () => {
    assert.equal(isExcludedFile('package-lock.json'), true);
    assert.equal(isExcludedFile('yarn.lock'), true);
    assert.equal(isExcludedFile('pnpm-lock.yaml'), true);
    assert.equal(isExcludedFile('Cargo.lock'), true);
  });

  it('excludes minified files', () => {
    assert.equal(isExcludedFile('bundle.min.js'), true);
    assert.equal(isExcludedFile('styles.min.css'), true);
  });

  it('excludes source maps', () => {
    assert.equal(isExcludedFile('bundle.js.map'), true);
  });

  it('excludes binary/media files', () => {
    assert.equal(isExcludedFile('image.png'), true);
    assert.equal(isExcludedFile('photo.jpg'), true);
    assert.equal(isExcludedFile('video.mp4'), true);
    assert.equal(isExcludedFile('font.woff2'), true);
  });

  it('excludes database files', () => {
    assert.equal(isExcludedFile('data.db'), true);
    assert.equal(isExcludedFile('index.sqlite'), true);
    assert.equal(isExcludedFile('index.db-wal'), true);
  });

  it('does not exclude normal code files', () => {
    assert.equal(isExcludedFile('index.js'), false);
    assert.equal(isExcludedFile('main.py'), false);
    assert.equal(isExcludedFile('README.md'), false);
  });
});

// ---------------------------------------------------------------------------
// isSensitiveFile
// ---------------------------------------------------------------------------

describe('isSensitiveFile', () => {
  it('detects .env variants as sensitive', () => {
    assert.equal(isSensitiveFile('.env'), true);
    assert.equal(isSensitiveFile('.env.staging'), true);
    assert.equal(isSensitiveFile('config/.env.prod'), true);
  });

  it('detects credential files as sensitive', () => {
    assert.equal(isSensitiveFile('credentials.json'), true);
    assert.equal(isSensitiveFile('secrets.yaml'), true);
    assert.equal(isSensitiveFile('token.json'), true);
    assert.equal(isSensitiveFile('auth.json'), true);
  });

  it('detects key/certificate files as sensitive', () => {
    assert.equal(isSensitiveFile('server.pem'), true);
    assert.equal(isSensitiveFile('private.key'), true);
    assert.equal(isSensitiveFile('cert.p12'), true);
    assert.equal(isSensitiveFile('id_rsa'), true);
    assert.equal(isSensitiveFile('id_ed25519'), true);
  });

  it('detects service account files as sensitive', () => {
    assert.equal(isSensitiveFile('service-account.json'), true);
    assert.equal(isSensitiveFile('service_account_key.json'), true);
  });

  it('does not flag normal files as sensitive', () => {
    assert.equal(isSensitiveFile('index.js'), false);
    assert.equal(isSensitiveFile('config.yaml'), false);
    assert.equal(isSensitiveFile('README.md'), false);
  });
});

// ---------------------------------------------------------------------------
// classifyFile
// ---------------------------------------------------------------------------

describe('classifyFile', () => {
  it('classifies a JavaScript file as code', () => {
    const result = classifyFile('src/index.js');
    assert.equal(result.category, 'code');
    assert.equal(result.excluded, false);
  });

  it('excludes .env as excluded_file', () => {
    const result = classifyFile('.env');
    assert.equal(result.excluded, true);
    assert.equal(result.reason, 'excluded_file');
  });

  it('excludes credentials.json as sensitive', () => {
    const result = classifyFile('config/credentials.json');
    assert.equal(result.excluded, true);
    assert.equal(result.reason, 'sensitive');
  });

  it('excludes unknown file types', () => {
    const result = classifyFile('data.bin');
    assert.equal(result.excluded, true);
    assert.equal(result.reason, 'unknown_type');
  });

  it('respects scan_config=false (default)', () => {
    const result = classifyFile('tsconfig.json');
    assert.equal(result.excluded, true);
    assert.equal(result.reason, 'category_disabled');
  });

  it('includes config files when scan_config=true', () => {
    const result = classifyFile('tsconfig.json', { scan_config: true });
    assert.equal(result.category, 'config');
    assert.equal(result.excluded, false);
  });

  it('excludes code when scan_code=false', () => {
    const result = classifyFile('src/app.ts', { scan_code: false });
    assert.equal(result.excluded, true);
    assert.equal(result.reason, 'category_disabled');
  });

  it('classifies PDF as convertible by default', () => {
    const result = classifyFile('docs/spec.pdf');
    assert.equal(result.category, 'convertible');
    assert.equal(result.excluded, false);
  });
});
