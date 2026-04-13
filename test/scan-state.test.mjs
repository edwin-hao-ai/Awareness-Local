import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  createScanState,
  updateScanState,
  appendScanError,
  loadScanState,
  saveScanState,
  getScanStatePath,
} from '../src/core/scan-state.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scan-state-test-'));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createScanState', () => {
  it('returns a fresh state with idle status', () => {
    const state = createScanState();
    assert.equal(state.status, 'idle');
    assert.equal(state.phase, null);
    assert.equal(state.discovered_total, 0);
    assert.equal(state.index_done, 0);
    assert.equal(state.last_git_commit, null);
    assert.deepEqual(state.errors, []);
  });

  it('returns a new object each time (no shared reference)', () => {
    const a = createScanState();
    const b = createScanState();
    assert.notEqual(a, b);
    a.status = 'scanning';
    assert.equal(b.status, 'idle');
  });
});

describe('updateScanState', () => {
  it('returns a new object without mutating the original', () => {
    const original = createScanState();
    const updated = updateScanState(original, { status: 'scanning', phase: 'discovering' });

    assert.equal(original.status, 'idle');
    assert.equal(updated.status, 'scanning');
    assert.equal(updated.phase, 'discovering');
    assert.notEqual(original, updated);
  });

  it('caps errors at 10 entries', () => {
    let state = createScanState();
    const errors = Array.from({ length: 15 }, (_, i) => ({
      message: `error ${i}`,
      at: new Date().toISOString(),
    }));
    state = updateScanState(state, { errors });
    assert.equal(state.errors.length, 10);
    assert.equal(state.errors[0].message, 'error 5'); // kept last 10
  });
});

describe('appendScanError', () => {
  it('appends an error immutably', () => {
    const state = createScanState();
    const updated = appendScanError(state, 'something broke');

    assert.equal(state.errors.length, 0);
    assert.equal(updated.errors.length, 1);
    assert.equal(updated.errors[0].message, 'something broke');
    assert.ok(updated.errors[0].at);
  });
});

describe('getScanStatePath', () => {
  it('returns path inside .awareness directory', () => {
    const p = getScanStatePath('/tmp/project');
    assert.equal(p, '/tmp/project/.awareness/scan-state.json');
  });
});

describe('loadScanState / saveScanState', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { cleanDir(tmpDir); });

  it('returns fresh state when no file exists', () => {
    const state = loadScanState(tmpDir);
    assert.equal(state.status, 'idle');
    assert.equal(state.last_git_commit, null);
  });

  it('persists and reloads state correctly', () => {
    const state = updateScanState(createScanState(), {
      status: 'idle',
      last_git_commit: 'abc123',
      total_files: 42,
      scan_duration_ms: 1500,
    });

    saveScanState(tmpDir, state);
    const loaded = loadScanState(tmpDir);

    assert.equal(loaded.last_git_commit, 'abc123');
    assert.equal(loaded.total_files, 42);
    assert.equal(loaded.scan_duration_ms, 1500);
  });

  it('creates .awareness directory if missing', () => {
    const awarenessDir = path.join(tmpDir, '.awareness');
    assert.equal(fs.existsSync(awarenessDir), false);

    saveScanState(tmpDir, createScanState());
    assert.equal(fs.existsSync(awarenessDir), true);
  });

  it('handles corrupted JSON gracefully', () => {
    const awarenessDir = path.join(tmpDir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    fs.writeFileSync(path.join(awarenessDir, 'scan-state.json'), 'not valid json!!!');

    const state = loadScanState(tmpDir);
    assert.equal(state.status, 'idle'); // fallback to defaults
  });

  it('atomic write does not corrupt on read', () => {
    // Save twice rapidly
    saveScanState(tmpDir, updateScanState(createScanState(), { total_files: 10 }));
    saveScanState(tmpDir, updateScanState(createScanState(), { total_files: 20 }));

    const loaded = loadScanState(tmpDir);
    assert.equal(loaded.total_files, 20);
  });

  it('handles schema evolution — adds new fields from defaults', () => {
    const awarenessDir = path.join(tmpDir, '.awareness');
    fs.mkdirSync(awarenessDir, { recursive: true });
    // Simulate an old schema without embed_total
    fs.writeFileSync(
      path.join(awarenessDir, 'scan-state.json'),
      JSON.stringify({ status: 'idle', total_files: 5 })
    );

    const loaded = loadScanState(tmpDir);
    assert.equal(loaded.total_files, 5);
    assert.equal(loaded.embed_total, 0); // from defaults
    assert.deepEqual(loaded.errors, []); // from defaults
  });
});
