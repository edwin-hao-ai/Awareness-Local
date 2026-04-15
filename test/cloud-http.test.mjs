/**
 * Contract test for src/daemon/cloud-http.mjs.
 *
 * Regression: the daemon used to resolve with the raw response string on
 * HTTP 5xx (because JSON.parse threw), which then got spread into the
 * response to the onboarding UI, causing `${verification_uri}?code=${user_code}`
 * to render as "undefined?code=undefined" and open a broken link in the
 * browser. After the fix, non-2xx statuses reject and callers can handle
 * the error properly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpJson } from '../src/daemon/cloud-http.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('httpJson: 200 JSON resolves to parsed object', async (t) => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, code: 'ABCD-1234' }));
  });
  t.after(() => srv.close());
  const out = await httpJson('POST', `${srv.url}/init`, {});
  assert.equal(out.ok, true);
  assert.equal(out.code, 'ABCD-1234');
});

test('httpJson: 502 HTML body REJECTS (instead of returning the string)', async (t) => {
  const srv = await startServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  });
  t.after(() => srv.close());
  await assert.rejects(
    () => httpJson('POST', `${srv.url}/init`, {}),
    (err) => /HTTP 502/.test(err.message),
  );
});

test('httpJson: 500 JSON error body REJECTS with status preview', async (t) => {
  const srv = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal' }));
  });
  t.after(() => srv.close());
  await assert.rejects(
    () => httpJson('GET', `${srv.url}/boom`, null),
    (err) => /HTTP 500/.test(err.message),
  );
});

test('httpJson: 204 empty body resolves to empty string (non-JSON 2xx is OK)', async (t) => {
  const srv = await startServer((req, res) => {
    res.writeHead(204);
    res.end();
  });
  t.after(() => srv.close());
  const out = await httpJson('DELETE', `${srv.url}/x`);
  assert.equal(out, '');
});

test('httpJson: forwards extraHeaders (e.g. Authorization)', async (t) => {
  let seenAuth = null;
  const srv = await startServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  t.after(() => srv.close());
  await httpJson('GET', `${srv.url}/`, null, { Authorization: 'Bearer xyz' });
  assert.equal(seenAuth, 'Bearer xyz');
});
