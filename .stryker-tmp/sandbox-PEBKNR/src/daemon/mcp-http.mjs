// @ts-nocheck
import { jsonResponse, readBody } from './helpers.mjs';

const MCP_TOOL_NAMES = [
  'awareness_init',
  'awareness_recall',
  'awareness_record',
  'awareness_lookup',
  'awareness_get_agent_prompt',
  'awareness_apply_skill',
  'awareness_workspace_search',
];

export async function handleMcpHttp({ req, res, version, dispatchJsonRpc }) {
  if (req.method !== 'POST') {
    if (req.method === 'GET') {
      jsonResponse(res, {
        name: 'awareness-local',
        version,
        protocol: 'mcp',
        capabilities: {
          tools: MCP_TOOL_NAMES,
        },
      });
      return;
    }
    jsonResponse(res, { error: 'Method not allowed' }, 405);
    return;
  }

  const body = await readBody(req);
  let rpcRequest;

  try {
    rpcRequest = JSON.parse(body);
  } catch {
    jsonResponse(
      res,
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      400
    );
    return;
  }

  const rpcResponse = await dispatchJsonRpc(rpcRequest);
  jsonResponse(res, rpcResponse);
}

export async function dispatchJsonRpcRequest({ rpcRequest, getToolDefinitions, callTool }) {
  const { method, params, id } = rpcRequest;

  try {
    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'awareness-local', version: '0.1.0' },
            capabilities: { tools: {} },
          },
        };
      }

      case 'notifications/initialized': {
        return { jsonrpc: '2.0', id, result: {} };
      }

      case 'tools/list': {
        const tools = getToolDefinitions();
        return { jsonrpc: '2.0', id, result: { tools } };
      }

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const result = await callTool(name, args || {});
        return { jsonrpc: '2.0', id, result };
      }

      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message },
    };
  }
}
