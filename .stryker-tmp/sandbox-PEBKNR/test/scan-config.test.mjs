/**
 * Tests for scan-config.mjs
 *
 * Covers: default config, load/save, merge logic, type safety,
 *         corrupted JSON handling, atomic writes.
 */
// @ts-nocheck


import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadScanConfig,
  saveScanConfig,
  getScanConfigPath,
  getDefaultScanConfig,
} from '../src/core/scan-config.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scanconfig-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDefaultScanConfig', () => {
  it('returns a complete config with expected defaults', () => {
    const defaults = getDefaultScanConfig();
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.scan_code, true);
    assert.equal(defaults.scan_docs, true);
    assert.equal(defaults.scan_config, false);
    assert.equal(defaults.scan_convertible, true);
    assert.equal(defaults.max_file_size_kb, 500);
    assert.equal(defaults.max_total_files, 10000);
    assert.equal(defaults.max_depth, 15);
    assert.equal(defaults.git_incremental, true);
    assert.equal(defaults.watch_enabled, true);
    assert.deepEqual(defaults.include, []);
    assert.deepEqual(defaults.exclude, []);
  });

  it('returns a new object each time (no shared references)', () => {
    const a = getDefaultScanConfig();
    const b = getDefaultScanConfig();
    assert.notEqual(a, b);
    a.enabled = false;
    assert.equal(b.enabled, true);
  });
});

describe('loadScanConfig', () => {
  it('returns defaults when no config file exists', () => {
    const dir = makeTmpDir();
    const config = loadScanConfig(dir);
    assert.equal(config.enabled, true);
    assert.equal(config.max_file_size_kb, 500);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges user overrides with defaults', () => {
    const dir = makeTmpDir();
    const awarenessDir = path.join(dir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    fs.writeFileSync(
      path.join(awarenessDir, 'scan-config.json'),
      JSON.stringify({ max_file_size_kb: 1000, scan_config: true }),
      'utf-8'
    );

    const config = loadScanConfig(dir);
    assert.equal(config.max_file_size_kb, 1000); // overridden
    assert.equal(config.scan_config, true);       // overridden
    assert.equal(config.enabled, true);           // default preserved
    assert.equal(config.scan_code, true);         // default preserved
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns defaults on corrupted JSON', () => {
    const dir = makeTmpDir();
    const awarenessDir = path.join(dir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    fs.writeFileSync(
      path.join(awarenessDir, 'scan-config.json'),
      'NOT VALID JSON {{{',
      'utf-8'
    );

    const config = loadScanConfig(dir);
    assert.equal(config.enabled, true);
    assert.equal(config.max_file_size_kb, 500);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores unknown keys from user config', () => {
    const dir = makeTmpDir();
    const awarenessDir = path.join(dir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    fs.writeFileSync(
      path.join(awarenessDir, 'scan-config.json'),
      JSON.stringify({ unknown_key: 'should be ignored', enabled: false }),
      'utf-8'
    );

    const config = loadScanConfig(dir);
    assert.equal(config.enabled, false);
    assert.equal(config.unknown_key, undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects type-mismatched values', () => {
    const dir = makeTmpDir();
    const awarenessDir = path.join(dir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    fs.writeFileSync(
      path.join(awarenessDir, 'scan-config.json'),
      JSON.stringify({ max_file_size_kb: 'not a number', enabled: 42 }),
      'utf-8'
    );

    const config = loadScanConfig(dir);
    assert.equal(config.max_file_size_kb, 500);  // default kept (type mismatch)
    assert.equal(config.enabled, true);           // default kept (type mismatch)
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('saveScanConfig', () => {
  it('writes config file and returns merged result', () => {
    const dir = makeTmpDir();
    const result = saveScanConfig(dir, { enabled: false, max_file_size_kb: 2000 });
    assert.equal(result.enabled, false);
    assert.equal(result.max_file_size_kb, 2000);
    assert.equal(result.scan_code, true); // default

    // Verify file was written
    const configPath = getScanConfigPath(dir);
    assert.ok(fs.existsSync(configPath));
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(raw.enabled, false);
    assert.equal(raw.max_file_size_kb, 2000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates .awareness directory if it does not exist', () => {
    const dir = makeTmpDir();
    saveScanConfig(dir, { scan_docs: false });
    assert.ok(fs.existsSync(path.join(dir, '.awareness')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites existing config file', () => {
    const dir = makeTmpDir();
    saveScanConfig(dir, { max_file_size_kb: 100 });
    saveScanConfig(dir, { max_file_size_kb: 999 });
    const config = loadScanConfig(dir);
    assert.equal(config.max_file_size_kb, 999);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('getScanConfigPath', () => {
  it('returns path inside .awareness directory', () => {
    const result = getScanConfigPath('/home/user/project');
    assert.ok(result.includes('.awareness'));
    assert.ok(result.endsWith('scan-config.json'));
  });
});
