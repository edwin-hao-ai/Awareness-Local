// @ts-nocheck
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { performHandshake, CURRENT_LOCAL_SCHEMA_VERSION } = await import(
  '../src/core/sync-handshake.mjs'
);

describe('sync-handshake — CURRENT_LOCAL_SCHEMA_VERSION', () => {
  it('is an integer >= 1', () => {
    assert.equal(typeof CURRENT_LOCAL_SCHEMA_VERSION, 'number');
    assert.ok(Number.isInteger(CURRENT_LOCAL_SCHEMA_VERSION));
    assert.ok(CURRENT_LOCAL_SCHEMA_VERSION >= 1);
  });
});

describe('sync-handshake — performHandshake', () => {
  it('returns compatible:true when cloud reports compatible', async () => {
    const httpGet = async (endpoint) => ({
      compatible: true,
      cloud_schema_version: 2,
      message: '',
    });

    const result = await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.equal(result.compatible, true);
    assert.equal(result.cloud_schema_version, 2);
  });

  it('returns compatible:false when cloud reports incompatible', async () => {
    const httpGet = async (endpoint) => ({
      compatible: false,
      cloud_schema_version: 99,
      message: 'Please upgrade your local daemon',
    });

    const result = await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.equal(result.compatible, false);
    assert.equal(result.cloud_schema_version, 99);
    assert.ok(result.message.includes('Please upgrade'));
  });

  it('passes client_schema query param to httpGet', async () => {
    let capturedEndpoint = '';
    const httpGet = async (endpoint) => {
      capturedEndpoint = endpoint;
      return { compatible: true, cloud_schema_version: 2 };
    };

    await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.ok(
      capturedEndpoint.includes(`client_schema=${CURRENT_LOCAL_SCHEMA_VERSION}`),
      `Expected endpoint to contain client_schema param, got: ${capturedEndpoint}`
    );
  });

  it('returns compatible:true when httpGet returns null (offline/404)', async () => {
    const httpGet = async () => null;

    const result = await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.equal(result.compatible, true);
    assert.equal(result.cloud_schema_version, null);
    assert.ok(result.message.includes('offline'));
  });

  it('returns compatible:true on network error (offline-safe fallback)', async () => {
    const httpGet = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.equal(result.compatible, true);
    assert.equal(result.cloud_schema_version, null);
    assert.ok(result.message.includes('offline'));
    assert.ok(result.message.includes('ECONNREFUSED'));
  });

  it('defaults to compatible:true when compatible field is missing from response', async () => {
    const httpGet = async () => ({ cloud_schema_version: 3 });

    const result = await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.equal(result.compatible, true);
    assert.equal(result.cloud_schema_version, 3);
  });

  it('reads schema_version as fallback when cloud_schema_version is absent', async () => {
    const httpGet = async () => ({ compatible: true, schema_version: 5 });

    const result = await performHandshake('http://test.local', 'aw_test', httpGet);

    assert.equal(result.cloud_schema_version, 5);
  });
});
