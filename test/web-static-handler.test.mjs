import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWebUi } from '../src/daemon/http-handlers.mjs';

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h); },
    end(data) { this.body = data; },
  };
}

// daemon.mjs is the anchor — it sits next to the web/ directory.
const ANCHOR = new URL('../src/daemon.mjs', import.meta.url).href;

test('handleWebUi serves index.html at /', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.ok(String(res.body).includes('Awareness Local'));
});

test('handleWebUi serves onboarding/index.js with correct mime', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/onboarding/index.js');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /application\/javascript/);
  assert.ok(String(res.body).includes('AwarenessOnboarding'));
});

test('handleWebUi serves onboarding/styles.css', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/onboarding/styles.css');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/css/);
});

test('handleWebUi rejects path traversal', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/../../etc/passwd');
  assert.equal(res.statusCode, 400);
});

test('handleWebUi 404s on non-whitelisted subpaths', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/secret.js');
  assert.equal(res.statusCode, 404);
});

test('handleWebUi 404s for unknown onboarding file', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/onboarding/does-not-exist.js');
  assert.equal(res.statusCode, 404);
});

test('handleWebUi rejects URL-encoded path traversal', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/%2e%2e/%2e%2e/etc/passwd');
  assert.equal(res.statusCode, 400);
});

test('handleWebUi rejects NUL byte injection', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/onboarding/index.js%00.png');
  assert.equal(res.statusCode, 400);
});

test('handleWebUi rejects malformed URL encoding', () => {
  const res = mockRes();
  handleWebUi(res, ANCHOR, '/web/%E0%A4%A');
  assert.equal(res.statusCode, 400);
});

test('handleWebUi rejects symlink escape from web/', async () => {
  // Create a symlink inside src/web/onboarding/ pointing outside src/web/.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.join(here, '..', 'src', 'web');
  const linkPath = path.join(webDir, 'onboarding', 'evil-link.js');
  const target = path.join(webDir, '..', '..', 'package.json'); // sdks/local/package.json — outside web/

  try { fs.unlinkSync(linkPath); } catch {}
  try {
    fs.symlinkSync(target, linkPath);
    const res = mockRes();
    handleWebUi(res, ANCHOR, '/web/onboarding/evil-link.js');
    assert.equal(res.statusCode, 400, 'symlink escape must be blocked');
  } finally {
    try { fs.unlinkSync(linkPath); } catch {}
  }
});
