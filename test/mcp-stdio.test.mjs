import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { buildDaemonStartArgs, ensureDaemon } from '../src/mcp-stdio.mjs';

test('mcp stdio auto-start forwards explicit projectDir to awareness-local start', () => {
  const projectDir = path.join(os.tmpdir(), 'awareness-project');
  const { args } = buildDaemonStartArgs(projectDir);
  assert.deepEqual(args.slice(1), ['start', '--project', path.resolve(projectDir)]);
});

test('mcp stdio auto-start rejects home directory as workspace root', () => {
  assert.throws(
    () => buildDaemonStartArgs(os.homedir()),
    /Refusing to use home directory/
  );
});

test('mcp stdio start switches an existing daemon to the requested workspace', async (t) => {
  const requestedProject = path.join(os.tmpdir(), 'awareness-requested-project');
  const existingProject = path.join(os.tmpdir(), 'awareness-existing-project');
  const calls = [];

  const fakeDaemon = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode: 'local', project_dir: existingProject, pid: process.pid }));
      return;
    }
    if (req.url === '/api/v1/workspace/switch' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        calls[calls.length - 1].body = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => fakeDaemon.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => fakeDaemon.close(resolve));
  });

  const port = fakeDaemon.address().port;
  await ensureDaemon(port, requestedProject);

  const switchCall = calls.find((call) => call.url === '/api/v1/workspace/switch');
  assert.ok(switchCall, 'expected stdio startup to switch the running daemon workspace');
  const payload = JSON.parse(switchCall.body);
  assert.equal(payload.project_dir, path.resolve(requestedProject));
});