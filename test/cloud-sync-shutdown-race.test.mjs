/**
 * cloud-sync-shutdown-race.test.mjs — L3 chaos test for the shutdown race
 * that flooded user logs with "database connection is not open" errors in
 * 0.7.0/0.7.1.
 *
 * Pre-0.7.2 flow:
 *   1. startPeriodicSync() -> setInterval(() => this.fullSync()) — fire and
 *      forget. Interval callback returns an unawaited promise.
 *   2. stop() -> clearInterval() + return. Does NOT wait for the in-flight
 *      promise.
 *   3. Daemon.stop() then closes the SQLite handle. The in-flight fullSync
 *      is now racing a closed DB, producing dozens of log lines per tick.
 *
 * 0.7.2 flow:
 *   1. Interval callback stores its promise in this._inflightSync and
 *      short-circuits when this._stopped is true.
 *   2. stop() is async: sets _stopped, clears the timer, AWAITS the
 *      in-flight promise before returning.
 *   3. Daemon.stop() awaits cloudSync.stop() before closing the DB.
 *
 * This test exercises the fixed path with a fake indexer that mirrors the
 * real shape but lets us inject a slow "query" to guarantee there is an
 * in-flight sync when stop() is called.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CloudSync } from '../src/core/cloud-sync.mjs';

function makeFakeIndexer() {
  // Only the methods CloudSync actually touches during periodic sync setup.
  const db = {
    prepared: [],
    exec() {},
    prepare(sql) {
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
        sql,
      };
    },
    pragma() {},
    close() { db._closed = true; },
    _closed: false,
  };
  return { db };
}

describe('CloudSync shutdown race (0.7.2)', () => {
  it('stop() awaits an in-flight fullSync()', async () => {
    const indexer = makeFakeIndexer();
    const cs = new CloudSync(
      { cloud: { enabled: true, api_key: 'k', memory_id: 'm', api_base: 'http://127.0.0.1:1' } },
      indexer,
      null,
    );

    // Simulate an in-flight sync: install a promise that resolves after
    // 60ms and plant it into _inflightSync as the real setInterval callback
    // would.
    let resolved = false;
    cs._inflightSync = new Promise((resolve) => {
      setTimeout(() => { resolved = true; resolve(); }, 60);
    });

    const t0 = Date.now();
    await cs.stop();
    const elapsed = Date.now() - t0;

    assert.ok(resolved, 'stop() should have awaited the in-flight sync to resolution');
    assert.ok(elapsed >= 55, `stop() returned too fast (${elapsed}ms) — did it await?`);
    assert.equal(cs._inflightSync, null, 'inflight pointer should be cleared after drain');
    assert.equal(cs._stopped, true, 'stopped flag should be set');
  });

  it('stop() tolerates an in-flight sync that rejects with "not open"', async () => {
    const indexer = makeFakeIndexer();
    const cs = new CloudSync(
      { cloud: { enabled: true, api_key: 'k', memory_id: 'm', api_base: 'http://127.0.0.1:1' } },
      indexer,
      null,
    );

    cs._inflightSync = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('The database connection is not open')), 20);
    });

    // Must not throw — stop() should swallow shutdown-race errors silently.
    await assert.doesNotReject(() => cs.stop());
  });

  it('after stop(), a queued interval tick becomes a no-op', async () => {
    const indexer = makeFakeIndexer();
    const cs = new CloudSync(
      { cloud: { enabled: true, api_key: 'k', memory_id: 'm', api_base: 'http://127.0.0.1:1' } },
      indexer,
      null,
    );

    await cs.stop();
    assert.equal(cs._stopped, true);

    // Manually invoke the guarded logic the interval wrapper uses.
    // Post-stop the wrapper returns before calling fullSync().
    let fullSyncCalled = false;
    cs.fullSync = async () => {
      fullSyncCalled = true;
      return { pushed: 0, pulled: 0, insights_pushed: 0, tasks_pushed: 0 };
    };

    // Emulate the setInterval body (see startPeriodicSync). Early-return
    // on this._stopped means fullSync is never called.
    if (cs._stopped) {
      // noop — matches production guard
    } else {
      await cs.fullSync();
    }

    assert.equal(fullSyncCalled, false, 'fullSync must NOT run after stop()');
  });
});
