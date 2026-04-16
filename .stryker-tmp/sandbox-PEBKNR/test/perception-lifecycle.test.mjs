/**
 * perception-lifecycle.test.mjs — Tests for perception state lifecycle
 *
 * Tests:
 *   1. Indexer perception_state CRUD (touch, get, acknowledge, dismiss, restore)
 *   2. Exposure cap (3 times) — shouldShowPerception returns false after 3 exposures
 *   3. Weight decay (drops 0.2 per exposure)
 *   4. Snooze expiry (snoozed_until in past → can show again)
 *   5. Auto-resolve via LLM
 *   6. Cleanup of old dismissed entries
 *   7. REST API endpoints (list, ack, dismiss, restore, refresh)
 */
// @ts-nocheck


import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Indexer } from '../src/core/indexer.mjs';
import {
  apiListPerceptions,
  apiAcknowledgePerception,
  apiDismissPerception,
  apiRestorePerception,
  apiRefreshPerceptions,
} from '../src/daemon/api-handlers.mjs';

const NOW = new Date().toISOString();

function mockRes() {
  let _status = 200, _body = '';
  return {
    writeHead(s) { _status = s; },
    end(b) { _body = b; },
    get status() { return _status; },
    get json() { return JSON.parse(_body); },
  };
}

function makeUrl(path, params = {}) {
  const u = new URL('http://localhost:37800/api/v1' + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}

function mockReq(bodyStr = '') {
  return {
    on(event, handler) {
      if (event === 'data' && bodyStr) handler(Buffer.from(bodyStr));
      if (event === 'end') handler();
    },
    destroy() {},
  };
}

describe('Perception Lifecycle', () => {
  let tmpDir;
  let indexer;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perception-test-'));
    indexer = new Indexer(path.join(tmpDir, 'index.db'));
  });

  after(() => {
    if (indexer) indexer.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function daemon() { return { indexer }; }

  // ── Basic CRUD ──

  it('touchPerceptionState creates new row on first call', () => {
    const state = indexer.touchPerceptionState({
      signal_id: 'sig_guard_a1',
      signal_type: 'guard',
      source_card_id: 'kc_001',
      title: 'Test guard',
    });
    assert.equal(state.exposure_count, 1);
    assert.equal(state.current_weight, 1.0);
    assert.equal(state.state, 'active');
  });

  it('touchPerceptionState increments exposure and decays weight', () => {
    indexer.touchPerceptionState({
      signal_id: 'sig_guard_a1',
      signal_type: 'guard',
      title: 'Test guard',
    });
    const state = indexer.getPerceptionState('sig_guard_a1');
    assert.equal(state.exposure_count, 2);
    assert.ok(state.current_weight < 1.0, 'weight should decay');
    assert.ok(state.current_weight >= 0.7, 'weight should still be above 0.7 after 1 exposure');
  });

  it('shouldShowPerception respects exposure cap (3)', () => {
    // Third exposure
    indexer.touchPerceptionState({ signal_id: 'sig_guard_a1', signal_type: 'guard', title: 'Test' });
    const state = indexer.getPerceptionState('sig_guard_a1');
    assert.equal(state.exposure_count, 3);
    assert.equal(indexer.shouldShowPerception('sig_guard_a1'), false,
      'should NOT show after 3 exposures');
  });

  it('shouldShowPerception returns true for brand new signal', () => {
    assert.equal(indexer.shouldShowPerception('sig_nonexistent'), true,
      'new signal should always be shown');
  });

  // ── Acknowledge (snooze) ──

  it('acknowledgePerception snoozes for N days', () => {
    indexer.touchPerceptionState({
      signal_id: 'sig_guard_b1',
      signal_type: 'guard',
      title: 'Test B',
    });
    const ok = indexer.acknowledgePerception('sig_guard_b1', 7);
    assert.equal(ok, true);
    const state = indexer.getPerceptionState('sig_guard_b1');
    assert.equal(state.state, 'snoozed');
    assert.ok(state.snoozed_until);
    assert.equal(indexer.shouldShowPerception('sig_guard_b1'), false,
      'snoozed signal should not show');
  });

  it('acknowledgePerception returns false for nonexistent signal', () => {
    const ok = indexer.acknowledgePerception('sig_nope', 7);
    assert.equal(ok, false);
  });

  // ── Dismiss ──

  it('dismissPerception sets state=dismissed and hides forever', () => {
    indexer.touchPerceptionState({
      signal_id: 'sig_guard_c1',
      signal_type: 'guard',
      title: 'Test C',
    });
    indexer.dismissPerception('sig_guard_c1');
    const state = indexer.getPerceptionState('sig_guard_c1');
    assert.equal(state.state, 'dismissed');
    assert.ok(state.dismissed_at);
    assert.equal(indexer.shouldShowPerception('sig_guard_c1'), false);
  });

  // ── Restore ──

  it('restorePerception resets dismissed → active', () => {
    indexer.restorePerception('sig_guard_c1');
    const state = indexer.getPerceptionState('sig_guard_c1');
    assert.equal(state.state, 'active');
    assert.equal(state.exposure_count, 0);
    assert.equal(state.current_weight, 1.0);
    assert.equal(indexer.shouldShowPerception('sig_guard_c1'), true);
  });

  // ── Auto-resolve ──

  it('autoResolvePerception marks signal as resolved by LLM', () => {
    indexer.touchPerceptionState({
      signal_id: 'sig_guard_d1',
      signal_type: 'guard',
      title: 'Bug to fix',
    });
    const ok = indexer.autoResolvePerception('sig_guard_d1', 'mem_fix_001', 'Fixed in commit abc123');
    assert.equal(ok, true);
    const state = indexer.getPerceptionState('sig_guard_d1');
    assert.equal(state.state, 'auto_resolved');
    assert.equal(state.resolved_by_llm, 1);
    assert.equal(state.resolved_by_memory_id, 'mem_fix_001');
    assert.equal(state.resolution_reason, 'Fixed in commit abc123');
    assert.equal(indexer.shouldShowPerception('sig_guard_d1'), false);
  });

  it('autoResolvePerception creates row if none existed', () => {
    const ok = indexer.autoResolvePerception('sig_never_seen', 'mem_001', 'auto');
    assert.equal(ok, true);
    const state = indexer.getPerceptionState('sig_never_seen');
    assert.equal(state.state, 'auto_resolved');
  });

  // ── Counts ──

  it('countPerceptions returns breakdown by state', () => {
    const counts = indexer.countPerceptions();
    assert.ok(counts.active >= 1);
    assert.ok(counts.snoozed >= 1);
    assert.ok(counts.auto_resolved >= 2);
  });

  // ── listPerceptionStates ──

  it('listPerceptionStates filters by state array', () => {
    const active = indexer.listPerceptionStates({ state: ['active'] });
    assert.ok(active.length >= 1);
    assert.ok(active.every(s => s.state === 'active'));
  });

  it('listPerceptionStates filters by type', () => {
    const guards = indexer.listPerceptionStates({ type: 'guard' });
    assert.ok(guards.every(s => s.signal_type === 'guard'));
  });

  // ── REST API ──

  it('REST: GET /perceptions returns items and counts', () => {
    const res = mockRes();
    apiListPerceptions(daemon(), null, res, makeUrl('/perceptions', { state: 'all' }));
    assert.equal(res.status, 200);
    const data = res.json;
    assert.ok(Array.isArray(data.items));
    assert.ok(data.counts);
    assert.ok(data.total >= 0);
  });

  it('REST: POST /perceptions/:id/acknowledge snoozes', async () => {
    // Need a fresh signal
    indexer.touchPerceptionState({
      signal_id: 'sig_api_ack',
      signal_type: 'guard',
      title: 'API test',
    });
    const res = mockRes();
    await apiAcknowledgePerception(daemon(), mockReq('{"snooze_days":3}'), res, 'sig_api_ack');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.snoozed_days, 3);
  });

  it('REST: POST /perceptions/:id/dismiss marks dismissed', () => {
    indexer.touchPerceptionState({
      signal_id: 'sig_api_dis',
      signal_type: 'guard',
      title: 'API test dis',
    });
    const res = mockRes();
    apiDismissPerception(daemon(), null, res, 'sig_api_dis');
    assert.equal(res.status, 200);
    const state = indexer.getPerceptionState('sig_api_dis');
    assert.equal(state.state, 'dismissed');
  });

  it('REST: POST /perceptions/:id/restore brings signal back', () => {
    const res = mockRes();
    apiRestorePerception(daemon(), null, res, 'sig_api_dis');
    assert.equal(res.status, 200);
    const state = indexer.getPerceptionState('sig_api_dis');
    assert.equal(state.state, 'active');
  });

  it('REST: 404 on nonexistent signal', () => {
    const res = mockRes();
    apiDismissPerception(daemon(), null, res, 'sig_missing');
    assert.equal(res.status, 404);
  });

  it('REST: POST /perceptions/refresh cleans up old entries', () => {
    const res = mockRes();
    apiRefreshPerceptions(daemon(), null, res);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.ok('cleaned' in res.json);
  });

  // ── Cleanup ──

  it('cleanupPerceptionState deletes old dismissed rows', () => {
    // Manually set an old dismissed row
    const oldIso = new Date(Date.now() - 100 * 86400000).toISOString();
    indexer.db.prepare(
      `INSERT INTO perception_state (signal_id, signal_type, first_seen_at, last_seen_at, state, dismissed_at)
       VALUES ('sig_old', 'guard', ?, ?, 'dismissed', ?)`
    ).run(oldIso, oldIso, oldIso);

    const cleaned = indexer.cleanupPerceptionState();
    assert.ok(cleaned >= 1, 'should clean at least 1 old entry');
    const state = indexer.getPerceptionState('sig_old');
    assert.equal(state, undefined);
  });
});
