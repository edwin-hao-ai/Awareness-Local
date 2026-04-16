// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createSyncHttp } = await import('../src/core/sync/sync-http.mjs');
const { createCardPuller } = await import('../src/core/sync/sync-pull-cards.mjs');

function makeFakeTransport(responder) {
  return async (url, opts) => {
    const res = await responder(url, opts);
    return {
      status: res.status,
      headers: res.headers || {},
      body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {}),
    };
  };
}

describe('pullCardsSince', () => {
  it('includes since and device_id query params and applies returned cards', async () => {
    let capturedUrl = null;
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      deviceId: 'dev-2',
      transport: makeFakeTransport((url) => {
        capturedUrl = url;
        return {
          status: 200,
          body: {
            cards: [
              { id: 'c1', title: 'A', version: 2, updated_at: '2026-04-08T10:00:00Z' },
              { id: 'c2', title: 'B', version: 1, updated_at: '2026-04-08T10:05:00Z' },
              { id: 'c3', title: 'C', version: 3, updated_at: '2026-04-08T10:10:00Z' },
            ],
            count: 3,
          },
        };
      }),
    });

    const applied = [];
    const puller = createCardPuller({
      http,
      memoryId: 'mem-xyz',
      deviceId: 'dev-2',
      applyCard: async (card) => {
        applied.push(card.id);
        if (card.id === 'c1') return 'inserted';
        if (card.id === 'c2') return 'updated';
        return 'skipped';
      },
    });

    const result = await puller.pullCardsSince('2026-04-08T09:00:00Z', { limit: 25 });

    assert.match(capturedUrl, /\/api\/v1\/memories\/mem-xyz\/cards\/sync\?/);
    assert.match(capturedUrl, /since=2026-04-08T09%3A00%3A00Z/);
    assert.match(capturedUrl, /device_id=dev-2/);
    assert.match(capturedUrl, /limit=25/);

    assert.deepEqual(applied, ['c1', 'c2', 'c3']);
    assert.equal(result.pulled, 3);
    assert.equal(result.inserted, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.skipped, 1);
  });

  it('returns error shape on non-2xx without throwing', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      transport: makeFakeTransport(() => ({ status: 500, body: {} })),
    });
    const puller = createCardPuller({
      http,
      memoryId: 'mem-xyz',
      applyCard: async () => 'skipped',
    });
    const result = await puller.pullCardsSince(null);
    assert.equal(result.pulled, 0);
    assert.match(result.error, /HTTP 500/);
  });

  it('handles 404 legacy backend gracefully', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      transport: makeFakeTransport(() => ({ status: 404, body: '' })),
    });
    const puller = createCardPuller({
      http,
      memoryId: 'mem-xyz',
      applyCard: async () => 'inserted',
    });
    const result = await puller.pullCardsSince('2026-04-08T09:00:00Z');
    assert.equal(result.pulled, 0);
    assert.equal(result.error, 'endpoint not available');
  });

  it('omits since param when sinceIso is null', async () => {
    let capturedUrl = null;
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      deviceId: 'dev-2',
      transport: makeFakeTransport((url) => {
        capturedUrl = url;
        return { status: 200, body: { cards: [], count: 0 } };
      }),
    });
    const puller = createCardPuller({
      http,
      memoryId: 'mem-xyz',
      deviceId: 'dev-2',
      applyCard: async () => 'skipped',
    });
    const result = await puller.pullCardsSince(null);
    assert.equal(result.pulled, 0);
    assert.doesNotMatch(capturedUrl, /since=/);
    assert.match(capturedUrl, /device_id=dev-2/);
  });
});
