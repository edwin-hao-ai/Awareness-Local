/**
 * daemon-startup-dedup.test.mjs
 *
 * L2 Integration tests for the daemon startup deduplication lock
 * introduced in sdks/local/bin/awareness-local.mjs.
 *
 * Covers the three concurrent-start scenarios:
 *   1. No lock → acquires lock, spawns daemon normally.
 *   2. Lock exists, owner alive → waits for daemon rather than spawning.
 *   3. Lock exists, owner dead (stale) → removes stale lock, acquires, spawns.
 *
 * We test the lock file mechanics directly (atomic open, stale detection,
 * cleanup) without spawning real daemon processes.
 */
// @ts-nocheck


import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers that replicate the lock logic from awareness-local.mjs
// (keeps tests fast and independent of the full CLI entrypoint)
// ---------------------------------------------------------------------------

const LOCK_FILENAME = 'daemon.starting';

/**
 * Attempt to acquire the startup lock.
 * Returns { acquired: true, lockPath } or { acquired: false, lockPath, ownerPid }.
 */
function tryAcquireLock(awarenessDir, ownerPid = process.pid) {
  const lockPath = path.join(awarenessDir, LOCK_FILENAME);
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(ownerPid));
    fs.closeSync(fd);
    return { acquired: true, lockPath };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Read current owner
    let ownerPidFromFile = null;
    try {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      ownerPidFromFile = parseInt(content, 10) || null;
    } catch { /* unreadable */ }
    return { acquired: false, lockPath, ownerPid: ownerPidFromFile };
  }
}

/**
 * Check whether a PID is alive (mirrors processExists in awareness-local.mjs).
 */
function processExists(pid) {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the startup lock.
 */
function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemon startup dedup — lock acquisition', () => {
  let awarenessDir;

  beforeEach(() => {
    awarenessDir = fs.mkdtempSync(path.join(tmpDir, 'awareness-'));
  });

  afterEach(() => {
    // Ensure no lock file leaks between tests
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  });

  it('acquires lock when no lock file exists', () => {
    const result = tryAcquireLock(awarenessDir);
    assert.equal(result.acquired, true);
    assert.ok(fs.existsSync(result.lockPath), 'lock file should exist after acquisition');
    const content = fs.readFileSync(result.lockPath, 'utf-8').trim();
    assert.equal(content, String(process.pid), 'lock file should contain current PID');
  });

  it('fails to acquire when lock already held by a live process', () => {
    // First process acquires the lock
    const { lockPath } = tryAcquireLock(awarenessDir, process.pid);

    // Second process tries to acquire
    const result = tryAcquireLock(awarenessDir, process.pid + 1);
    assert.equal(result.acquired, false);
    assert.ok(result.ownerPid !== null, 'should read owner PID from lock file');

    releaseLock(lockPath);
  });

  it('detects live owner correctly', () => {
    // current process is guaranteed alive
    assert.equal(processExists(process.pid), true);
  });

  it('detects dead owner correctly', () => {
    // PID 0 is reserved and never a real user PID; kill(0, 0) succeeds for
    // "current process group" so use a very high unlikely PID instead.
    // We use PID 2 which is always the kernel thread on Linux/macOS and can
    // never be killed/signalled by a user process — but the real test is a
    // known-dead PID. Use Number.MAX_SAFE_INTEGER as a guaranteed non-existent PID.
    const deadPid = 999999999;
    assert.equal(processExists(deadPid), false);
  });

  it('removes stale lock (dead owner) and re-acquires', () => {
    const deadPid = 999999999;

    // Write a stale lock
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, String(deadPid), 'utf-8');

    // Simulate the stale-detection + retry logic
    const first = tryAcquireLock(awarenessDir);
    assert.equal(first.acquired, false);
    assert.equal(first.ownerPid, deadPid);

    // Owner is dead → remove stale lock
    const isAlive = processExists(first.ownerPid);
    assert.equal(isAlive, false, 'stale owner should be dead');
    releaseLock(lockPath);

    // Now re-acquire
    const second = tryAcquireLock(awarenessDir);
    assert.equal(second.acquired, true, 'should acquire after stale lock removal');
    const content = fs.readFileSync(second.lockPath, 'utf-8').trim();
    assert.equal(content, String(process.pid));
  });

  it('lock is released after cleanup', () => {
    const { lockPath } = tryAcquireLock(awarenessDir);
    assert.ok(fs.existsSync(lockPath));

    releaseLock(lockPath);
    assert.equal(fs.existsSync(lockPath), false, 'lock file should be gone after release');

    // A new process can now acquire it
    const result = tryAcquireLock(awarenessDir);
    assert.equal(result.acquired, true);
  });
});

// ---------------------------------------------------------------------------
// L3 · Failure-Mode / Chaos Tests
// Tests edge-case and error conditions the lock mechanism must survive.
// ---------------------------------------------------------------------------

describe('daemon startup dedup — L3 failure modes', () => {
  let awarenessDir;

  beforeEach(() => {
    awarenessDir = fs.mkdtempSync(path.join(tmpDir, 'chaos-'));
  });

  afterEach(() => {
    // Restore permissions so cleanup can delete everything
    try { fs.chmodSync(awarenessDir, 0o755); } catch { /* ignore */ }
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  });

  it('handles corrupt lock file (non-numeric PID) as stale', () => {
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    // Write garbage content
    fs.writeFileSync(lockPath, 'not-a-pid', 'utf-8');

    const result = tryAcquireLock(awarenessDir);
    assert.equal(result.acquired, false);
    assert.equal(result.ownerPid, null, 'non-numeric PID should parse to null');

    // processExists(null) must return false (treat as dead)
    assert.equal(processExists(null), false);
    assert.equal(processExists(NaN), false);
  });

  it('handles empty lock file as stale', () => {
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    fs.writeFileSync(lockPath, '', 'utf-8');

    const result = tryAcquireLock(awarenessDir);
    assert.equal(result.acquired, false);
    assert.equal(result.ownerPid, null);
    assert.equal(processExists(result.ownerPid), false);
  });

  it('handles PID=0 as dead (reserved PID, never a real user process)', () => {
    assert.equal(processExists(0), false,
      'PID 0 should be treated as non-existent user process');
  });

  it('handles very-large dead PID gracefully', () => {
    const hugePid = 2_000_000_000;
    assert.equal(processExists(hugePid), false);
  });

  it('releaseLock is idempotent — double-release does not throw', () => {
    const { lockPath } = tryAcquireLock(awarenessDir);
    releaseLock(lockPath);
    // Second release must not throw
    assert.doesNotThrow(() => releaseLock(lockPath));
  });

  it('releaseLock on non-existent path is safe', () => {
    const fakePath = path.join(awarenessDir, 'non-existent.lk');
    assert.doesNotThrow(() => releaseLock(fakePath));
  });

  it('lock write succeeds after stale corrupt file is cleaned', () => {
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    // Simulate stale corrupt lock
    fs.writeFileSync(lockPath, 'garbage', 'utf-8');

    const first = tryAcquireLock(awarenessDir);
    assert.equal(first.acquired, false);
    assert.equal(first.ownerPid, null);

    // Simulate stale-detection logic: owner is null → dead → remove lock
    assert.equal(processExists(first.ownerPid), false);
    releaseLock(first.lockPath);

    // Now acquire succeeds
    const second = tryAcquireLock(awarenessDir);
    assert.equal(second.acquired, true);
  });

  it('lock file always contains positive integer PID (negative PID impossible)', () => {
    // process.pid is always a positive integer; parseInt of a lock file written
    // by tryAcquireLock will never produce a negative or zero value.
    // This test documents the invariant rather than testing processExists(-1),
    // which has platform-specific behavior (macOS: kill(-1,0) succeeds).
    assert.ok(process.pid > 0, 'process.pid must be positive');

    const { lockPath } = tryAcquireLock(awarenessDir);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    const parsed = parseInt(content, 10);
    assert.ok(!isNaN(parsed) && parsed > 0, 'lock file PID must be a positive integer');
    releaseLock(lockPath);
  });
});

describe('daemon startup dedup — concurrent simulation', () => {
  let awarenessDir;

  beforeEach(() => {
    awarenessDir = fs.mkdtempSync(path.join(tmpDir, 'concurrent-'));
  });

  afterEach(() => {
    const lockPath = path.join(awarenessDir, LOCK_FILENAME);
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  });

  it('only one winner in a race (sequential simulation)', () => {
    // Simulate N concurrent callers all trying to acquire the lock.
    // On a real OS these would be parallel, but in a single-threaded test
    // we verify that exactly one acquire returns true and the rest false.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(tryAcquireLock(awarenessDir, process.pid + i));
    }
    const winners = results.filter((r) => r.acquired);
    assert.equal(winners.length, 1, 'exactly one caller should win the lock');
    assert.equal(results.filter((r) => !r.acquired).length, 4, 'remaining 4 should see EEXIST');
  });

  it('lock contention is resolved after winner releases', () => {
    const first = tryAcquireLock(awarenessDir);
    assert.equal(first.acquired, true);

    const second = tryAcquireLock(awarenessDir);
    assert.equal(second.acquired, false);

    // Winner finishes and releases lock
    releaseLock(first.lockPath);

    // Now the previously-blocked caller can acquire
    const third = tryAcquireLock(awarenessDir);
    assert.equal(third.acquired, true, 'should succeed once lock is released');
  });
});
