import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { callMcpTool } from '../src/daemon/tool-bridge.mjs';
import { getTelemetry, initTelemetry } from '../src/core/telemetry.mjs';

function setupTelemetry(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tool-telemetry-'));
  initTelemetry({
    config: { telemetry: { enabled: true }, device: { id: 'device-test' } },
    projectDir: tmp,
    version: 'test',
  });
  t.after(async () => {
    await getTelemetry()?.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

function recent(eventType) {
  return getTelemetry().listRecent().filter((event) => event.event_type === eventType);
}

test('callMcpTool records success=true only after a known tool succeeds', async (t) => {
  setupTelemetry(t);

  const daemon = {
    _lookup: async () => ({ items: [] }),
  };

  const result = await callMcpTool(daemon, 'awareness_lookup', { query: 'redis' });
  assert.ok(result);

  const events = recent('mcp_tool_called');
  assert.equal(events.length, 1);
  assert.equal(events[0].properties.tool_name, 'awareness_lookup');
  assert.equal(events[0].properties.success, true);
});

test('callMcpTool records success=false when a known tool throws', async (t) => {
  setupTelemetry(t);

  const daemon = {
    _lookup: async () => { throw new Error('lookup failed'); },
  };

  await assert.rejects(() => callMcpTool(daemon, 'awareness_lookup', { query: 'redis' }), /lookup failed/);

  const events = recent('mcp_tool_called');
  assert.equal(events.length, 1);
  assert.equal(events[0].properties.tool_name, 'awareness_lookup');
  assert.equal(events[0].properties.success, false);
});

test('unknown tool emits feature_blocked plus failed mcp_tool_called', async (t) => {
  setupTelemetry(t);

  await assert.rejects(() => callMcpTool({}, 'awareness_not_real', {}), /Unknown tool/);

  const toolEvents = recent('mcp_tool_called');
  const blockedEvents = recent('feature_blocked');

  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].properties.tool_name, 'awareness_not_real');
  assert.equal(toolEvents[0].properties.success, false);

  assert.equal(blockedEvents.length, 1);
  assert.equal(blockedEvents[0].properties.feature_name, 'awareness_not_real');
});