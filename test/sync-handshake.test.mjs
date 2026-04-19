import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createSyncHttp } = await import('../src/core/sync/sync-http.mjs');
const { performHandshake } = await import('../src/core/sync/sync-handshake.mjs');

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

describe('performHandshake', () => {
  it('returns compatible for schema 1', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test/api/v1',
      transport: makeFakeTransport((url) => {
        assert.match(url, /\/api\/v1\/sync\/handshake\?client_schema=1$/);
        return {
          status: 200,
          body: {
            compatible: true,
            cloud_schema_version: 2,
            client_schema_version: 1,
            message: 'ok',
          },
        };
      }),
    });
    const result = await performHandshake(http, 1);
    assert.equal(result.ok, true);
    assert.equal(result.compatible, true);
    assert.equal(result.cloud_schema_version, 2);
    assert.equal(result.client_schema_version, 1);
  });

  it('returns compatible for schema 2', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test/api/v1',
      transport: makeFakeTransport(() => ({
        status: 200,
        body: { compatible: true, cloud_schema_version: 2, client_schema_version: 2, message: 'ok' },
      })),
    });
    const result = await performHandshake(http, 2);
    assert.equal(result.compatible, true);
    assert.equal(result.client_schema_version, 2);
  });

  it('returns incompatible for schema 999', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test/api/v1',
      transport: makeFakeTransport(() => ({
        status: 200,
        body: {
          compatible: false,
          cloud_schema_version: 2,
          client_schema_version: 999,
          message: 'client schema too new',
        },
      })),
    });
    const result = await performHandshake(http, 999);
    assert.equal(result.ok, true);
    assert.equal(result.compatible, false);
    assert.match(result.message, /too new/);
  });

  it('falls back to compatible on 404 (legacy backend)', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test/api/v1',
      transport: makeFakeTransport(() => ({ status: 404, body: '' })),
    });
    const result = await performHandshake(http, 2);
    assert.equal(result.compatible, true);
    assert.equal(result.status, 404);
  });

  it('handles network errors without throwing', async () => {
    const http = createSyncHttp({
      apiBase: 'https://api.test/api/v1',
      transport: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await performHandshake(http, 2);
    assert.equal(result.ok, false);
    assert.equal(result.compatible, false);
    assert.match(result.message, /ECONNREFUSED/);
  });
});
