/**
 * P1 regression · v2 sync modules must NOT double-prefix `/api/v1` when the
 * configured `apiBase` already ends with `/api/v1`.
 *
 * Context: production config ships with `api_base = https://awareness.market/api/v1`.
 * The v2 sync modules (push-optimistic / pull-cards / handshake / conflict)
 * historically built endpoints starting with `/api/v1/…`, which once
 * concatenated produced `https://awareness.market/api/v1/api/v1/…` → 404.
 * This test locks the fix by asserting the URL contains exactly one `/api/v1/`
 * segment when apiBase is production-shaped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyncHttp } from '../src/core/sync/sync-http.mjs';
import { createOptimisticPusher } from '../src/core/sync/sync-push-optimistic.mjs';
import { createCardPuller } from '../src/core/sync/sync-pull-cards.mjs';
import { performHandshake } from '../src/core/sync/sync-handshake.mjs';

function makeTransport(responder) {
  return async (url, opts) => {
    const res = await responder(url, opts);
    return {
      status: res.status,
      headers: res.headers || {},
      body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {}),
    };
  };
}

function countSegment(s, needle) {
  let count = 0, idx = 0;
  while ((idx = s.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

test('P1 · pushCardWithVersion URL has exactly one /api/v1/ segment with prod apiBase', async () => {
  let captured = null;
  const http = createSyncHttp({
    apiBase: 'https://awareness.market/api/v1',
    apiKey: 'k',
    deviceId: 'dev',
    transport: makeTransport((url) => {
      captured = url;
      return { status: 200, body: { status: 'created', card_id: 'x', version: 1 } };
    }),
  });
  const pusher = createOptimisticPusher({ http, memoryId: 'mem-1', deviceId: 'dev' });
  await pusher.pushCardWithVersion({ title: 't', category: 'decision', version: 1 });
  assert.equal(countSegment(captured, '/api/v1/'), 1, `double-prefix detected: ${captured}`);
  assert.match(captured, /awareness\.market\/api\/v1\/memories\/mem-1\/cards\/sync$/);
});

test('P1 · pullCardsSince URL has exactly one /api/v1/ segment with prod apiBase', async () => {
  let captured = null;
  const http = createSyncHttp({
    apiBase: 'https://awareness.market/api/v1',
    transport: makeTransport((url) => {
      captured = url;
      return { status: 200, body: { items: [] } };
    }),
  });
  const puller = createCardPuller({
    http, memoryId: 'mem-1', deviceId: 'dev',
    applyCard: async () => 'skipped',
  });
  await puller.pullCardsSince(null);
  assert.equal(countSegment(captured, '/api/v1/'), 1, `double-prefix detected: ${captured}`);
  assert.match(captured, /awareness\.market\/api\/v1\/memories\/mem-1\/cards\/sync\?/);
});

test('P1 · performHandshake URL has exactly one /api/v1/ segment with prod apiBase', async () => {
  let captured = null;
  const http = createSyncHttp({
    apiBase: 'https://awareness.market/api/v1',
    transport: makeTransport((url) => {
      captured = url;
      return { status: 200, body: { ok: true, compatible: true } };
    }),
  });
  await performHandshake(http, 1);
  assert.equal(countSegment(captured, '/api/v1/'), 1, `double-prefix detected: ${captured}`);
  assert.match(captured, /awareness\.market\/api\/v1\/sync\/handshake\?client_schema=1/);
});
