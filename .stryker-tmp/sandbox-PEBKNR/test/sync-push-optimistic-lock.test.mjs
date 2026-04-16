// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createSyncHttp } = await import('../src/core/sync/sync-http.mjs');
const { createOptimisticPusher } = await import('../src/core/sync/sync-push-optimistic.mjs');

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

describe('pushCardWithVersion', () => {
  it('sends If-Match header with local version and returns updated status on 200', async () => {
    let captured = null;
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      apiKey: 'k',
      deviceId: 'dev-1',
      transport: makeFakeTransport((url, opts) => {
        captured = { url, opts };
        return {
          status: 200,
          body: { status: 'updated', card_id: 'card-abc', version: 6 },
        };
      }),
    });
    const pusher = createOptimisticPusher({ http, memoryId: 'mem-1', deviceId: 'dev-1' });
    const result = await pusher.pushCardWithVersion({
      id: 'card-abc',
      title: 'Use JWT',
      summary: 'adopt JWT auth',
      category: 'decision',
      version: 5,
      tags: '[]',
    });

    assert.equal(result.status, 'updated');
    assert.equal(result.card_id, 'card-abc');
    assert.equal(result.version, 6);
    assert.equal(captured.opts.method, 'POST');
    assert.match(captured.url, /\/api\/v1\/memories\/mem-1\/cards\/sync$/);
    assert.equal(captured.opts.headers['If-Match'], '5');
    assert.equal(captured.opts.headers['Authorization'], 'Bearer k');
    const sent = JSON.parse(captured.opts.body);
    assert.equal(sent.id, 'card-abc');
    assert.equal(sent.title, 'Use JWT');
    assert.equal(sent.device_id, 'dev-1');
    assert.equal(sent.schema_version, 1);
  });

  it('defaults version to 1 when card.version is missing', async () => {
    let capturedHeaders = null;
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      transport: makeFakeTransport((_url, opts) => {
        capturedHeaders = opts.headers;
        return { status: 200, body: { status: 'created', card_id: 'new', version: 1 } };
      }),
    });
    const pusher = createOptimisticPusher({ http, memoryId: 'mem-1' });
    const result = await pusher.pushCardWithVersion({ title: 'X', category: 'key_point' });
    assert.equal(capturedHeaders['If-Match'], '1');
    assert.equal(result.status, 'created');
  });

  it('returns status=conflict on 409 with cloud/local versions', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      transport: makeFakeTransport(() => ({
        status: 409,
        body: {
          detail: {
            error: 'Version mismatch',
            card_id: 'card-abc',
            expected_version: 5,
            actual_version: 7,
          },
        },
      })),
    });
    const pusher = createOptimisticPusher({ http, memoryId: 'mem-1', deviceId: 'dev-1' });
    const result = await pusher.pushCardWithVersion({
      id: 'card-abc',
      title: 'Use JWT',
      category: 'decision',
      version: 5,
    });

    assert.equal(result.status, 'conflict');
    assert.equal(result.card_id, 'card-abc');
    assert.equal(result.localVersion, 5);
    assert.equal(result.cloudVersion, 7);
  });

  it('returns error on other non-2xx without throwing', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test',
      transport: makeFakeTransport(() => ({ status: 500, body: { detail: 'boom' } })),
    });
    const pusher = createOptimisticPusher({ http, memoryId: 'mem-1' });
    const result = await pusher.pushCardWithVersion({ title: 'X', version: 1 });
    assert.equal(result.status, 'error');
    assert.equal(result.httpStatus, 500);
  });
});
