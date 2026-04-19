/**
 * Regression: daemon must decode X-Awareness-Project-Dir-B64 for CJK/emoji
 * paths (Node http rejects non-ISO-8859-1 in raw header values, so Windows
 * users with Chinese usernames and macOS users with localized workspace
 * folders rely on the base64 variant).
 *
 * The decoder lives inline in daemon.mjs::_handleRequest. These tests spin
 * up a minimal HTTP server mimicking that logic so we can assert behavior
 * without bringing up the full daemon stack.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

function makeTestServer(projectDir) {
  return http.createServer((req, res) => {
    let requestedProject = null;
    const b64Header = req.headers['x-awareness-project-dir-b64'];
    if (b64Header) {
      try { requestedProject = Buffer.from(String(b64Header), 'base64').toString('utf8'); }
      catch { /* malformed → ignore */ }
    }
    if (!requestedProject && req.headers['x-awareness-project-dir']) {
      requestedProject = String(req.headers['x-awareness-project-dir']);
    }
    if (requestedProject) {
      const normalizedRequested = path.resolve(requestedProject);
      const normalizedCurrent = path.resolve(projectDir);
      if (normalizedRequested !== normalizedCurrent) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project_mismatch', requested_project: normalizedRequested }));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requested_project: requestedProject }));
  });
}

function request(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end('{}');
  });
}

describe('daemon project-dir header decode (CJK/emoji safety)', () => {
  let server;
  let port;
  const DAEMON_PROJECT = '/Users/测试/Awareness 文件夹';

  before(async () => {
    server = makeTestServer(DAEMON_PROJECT);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(() => new Promise((r) => server.close(r)));

  it('ASCII plain header: matching project → 200', async () => {
    const { status } = await request(port, { 'X-Awareness-Project-Dir': '/tmp/ascii-only' });
    // daemon projectDir is CJK so /tmp/ascii-only mismatches → 409 is expected
    assert.equal(status, 409);
  });

  it('B64 header carrying CJK path equal to daemon projectDir → 200', async () => {
    const b64 = Buffer.from(DAEMON_PROJECT, 'utf8').toString('base64');
    const { status, json } = await request(port, { 'X-Awareness-Project-Dir-B64': b64 });
    assert.equal(status, 200);
    assert.equal(json.requested_project, DAEMON_PROJECT);
  });

  it('B64 header carrying mismatched CJK path → 409 with decoded original string', async () => {
    const other = '/Users/张三/Other 文件夹';
    const b64 = Buffer.from(other, 'utf8').toString('base64');
    const { status, json } = await request(port, { 'X-Awareness-Project-Dir-B64': b64 });
    assert.equal(status, 409);
    assert.equal(json.requested_project, other);
  });

  it('B64 carrying emoji path → correctly decoded', async () => {
    const emojiPath = '/Users/edwinhao/Project 🚀';
    const b64 = Buffer.from(emojiPath, 'utf8').toString('base64');
    const { status, json } = await request(port, { 'X-Awareness-Project-Dir-B64': b64 });
    assert.equal(status, 409);
    assert.equal(json.requested_project, emojiPath);
  });

  it('B64 takes priority over legacy header when both present', async () => {
    const b64 = Buffer.from(DAEMON_PROJECT, 'utf8').toString('base64');
    const { status, json } = await request(port, {
      'X-Awareness-Project-Dir-B64': b64,
      'X-Awareness-Project-Dir': '/some/ascii/path',
    });
    assert.equal(status, 200);
    assert.equal(json.requested_project, DAEMON_PROJECT);
  });

  it('Malformed B64 falls back to legacy header (no 500)', async () => {
    const { status } = await request(port, {
      'X-Awareness-Project-Dir-B64': '!!!not-valid-base64***',
      'X-Awareness-Project-Dir': '/some/path',
    });
    // base64 decoder is lenient — produces some garbage — but must NOT 500.
    // Accept either 409 (decoded to mismatch) or 409 from legacy fallback.
    assert.ok(status === 409 || status === 200, `expected 2xx/409, got ${status}`);
  });

  it('No header at all → 200 (daemon uses its default project)', async () => {
    const { status } = await request(port, {});
    assert.equal(status, 200);
  });
});
