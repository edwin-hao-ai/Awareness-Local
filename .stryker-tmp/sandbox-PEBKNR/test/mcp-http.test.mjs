// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchJsonRpcRequest } from '../src/daemon/mcp-http.mjs';

test('dispatchJsonRpcRequest returns tools/list payload from provided definitions', async () => {
  const response = await dispatchJsonRpcRequest({
    rpcRequest: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    getToolDefinitions: () => [{ name: 'awareness_init' }, { name: 'awareness_recall' }],
    callTool: async () => ({ content: [] }),
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.tools, [{ name: 'awareness_init' }, { name: 'awareness_recall' }]);
});

test('dispatchJsonRpcRequest returns method not found for unknown methods', async () => {
  const response = await dispatchJsonRpcRequest({
    rpcRequest: { jsonrpc: '2.0', id: 2, method: 'nope' },
    getToolDefinitions: () => [],
    callTool: async () => ({ content: [] }),
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 2);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Method not found/);
});

test('dispatchJsonRpcRequest wraps tool exceptions as internal errors', async () => {
  const response = await dispatchJsonRpcRequest({
    rpcRequest: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'awareness_recall', arguments: {} },
    },
    getToolDefinitions: () => [],
    callTool: async () => {
      throw new Error('boom');
    },
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 3);
  assert.equal(response.error.code, -32603);
  assert.equal(response.error.message, 'boom');
});
