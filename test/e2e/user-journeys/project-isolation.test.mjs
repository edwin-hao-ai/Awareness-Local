/**
 * L4 E2E: Project isolation — real daemon, zero mock.
 * Tests that X-Awareness-Project-Dir header prevents cross-project memory contamination.
 *
 * Requires: local daemon running on port 37800.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const DAEMON = 'http://127.0.0.1:37800';

function httpJson(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, DAEMON);
    const req = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function mcpCall(toolName, args, headers = {}) {
  return httpJson('POST', '/mcp', {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, headers);
}

describe('L4 E2E: Project isolation via X-Awareness-Project-Dir', () => {
  it('healthz is exempt from project validation', async () => {
    const result = await httpJson('GET', '/healthz', null, {
      'X-Awareness-Project-Dir': '/nonexistent/path/that/should/not/block/healthz',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
  });

  it('matching project header passes through', async () => {
    // Get current daemon project
    const health = await httpJson('GET', '/healthz');
    const currentProject = health.body.project_dir;
    assert.ok(currentProject, 'daemon should report project_dir');

    // Send request with matching header
    const result = await httpJson('GET', '/api/v1/stats', null, {
      'X-Awareness-Project-Dir': currentProject,
    });
    assert.equal(result.status, 200);
  });

  it('mismatching project header returns 409', async () => {
    const result = await httpJson('GET', '/api/v1/stats', null, {
      'X-Awareness-Project-Dir': '/this/project/does/not/match',
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'project_mismatch');
    assert.ok(result.body.daemon_project, 'should include daemon_project');
    assert.ok(result.body.requested_project, 'should include requested_project');
  });

  it('no header (old client) still works', async () => {
    const result = await httpJson('GET', '/api/v1/stats');
    assert.equal(result.status, 200);
  });

  it('MCP calls with mismatching header return 409', async () => {
    const result = await mcpCall('awareness_lookup', { type: 'knowledge' }, {
      'X-Awareness-Project-Dir': '/wrong/project',
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'project_mismatch');
  });

  it('memory written in project A is not accessible after switch to project B', async () => {
    // Get current project
    const health = await httpJson('GET', '/healthz');
    const projectA = health.body.project_dir;

    // Write a unique memory
    const uniqueTag = `isolation-test-${Date.now()}`;
    await mcpCall('awareness_record', {
      action: 'remember',
      content: `Test memory for isolation: ${uniqueTag}`,
      event_type: 'turn_brief',
      source: 'test',
    });

    // Create a temp project directory
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-test-'));
    fs.mkdirSync(path.join(projectB, '.awareness', 'memories'), { recursive: true });

    try {
      // Switch to project B
      const switchResult = await httpJson('POST', '/api/v1/workspace/switch', {
        project_dir: projectB,
      });
      assert.equal(switchResult.status, 200);

      // Search in project B should NOT find the uniqueTag
      const searchResult = await httpJson('GET', `/api/v1/memories/search?q=${encodeURIComponent(uniqueTag)}`);
      const items = searchResult.body?.items || [];
      const found = items.some((i) => (i.fts_content || i.content || '').includes(uniqueTag));
      assert.equal(found, false, `Memory "${uniqueTag}" should NOT be found in project B`);

      // Request with project A header should get 409
      const mismatchResult = await httpJson('GET', '/api/v1/stats', null, {
        'X-Awareness-Project-Dir': projectA,
      });
      assert.equal(mismatchResult.status, 409);
    } finally {
      // Switch back to original project
      await httpJson('POST', '/api/v1/workspace/switch', { project_dir: projectA });
      // Clean up temp dir
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });
});
