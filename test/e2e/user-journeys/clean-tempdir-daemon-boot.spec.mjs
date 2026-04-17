/**
 * L4 E2E: Fresh-install daemon boot — real npx, zero mock.
 *
 * Reproduces the failure mode reported against 0.7.1:
 *   `Fatal error: Cannot find module '…/completable.js' imported from
 *    …/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`
 *
 * Root cause was a loose semver on @modelcontextprotocol/sdk + a corrupt
 * npx cache; the hoisted layout dropped `completable.js` from the nested
 * package, and ESM resolution does not fall back.
 *
 * This journey:
 *   1. Create an empty tempdir (no prior AwarenessClaw or daemon state).
 *   2. Install the current local package source into it — `npm pack` of
 *      sdks/local, then `npm install` of the tarball. This mirrors what
 *      `npx @awareness-sdk/local@<new-version>` will do for a real user.
 *   3. Boot `awareness-local start` on an unused port.
 *   4. Assert /healthz responds 200 within a grace window.
 *   5. Assert /mcp responds to tools/list.
 *   6. Kill the daemon and clean up.
 *
 * Skips gracefully when network is unavailable (npm install) — CI will
 * still catch regressions but local runs without network are ignored.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEST_TIMEOUT = 180_000;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForHealth(port, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await httpGet(`http://127.0.0.1:${port}/healthz`, 1500);
    if (r && r.status === 200) return true;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  return false;
}

describe('L4 E2E: fresh npm install → daemon boots on clean tempdir', { concurrency: false }, () => {
  let tmpDir;
  let projectDir;
  let daemonChild;
  let port;
  let tarball;
  let installSkipped = false;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-boot-'));
    projectDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(projectDir, { recursive: true });

    // Pack the current source so we test the would-be-published tarball.
    const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', tmpDir], {
      cwd: SDK_ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    if (pack.status !== 0) {
      console.warn('[e2e] npm pack failed — skipping:', pack.stderr);
      installSkipped = true;
      return;
    }
    tarball = path.join(tmpDir, pack.stdout.trim().split('\n').pop());

    // Install into the tempdir so every nested dep resolves under
    // `<tmpDir>/node_modules/@awareness-sdk/local/...`.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'daemon-boot-fixture', version: '0.0.0', private: true }),
      'utf-8',
    );
    const install = spawnSync('npm', [
      'install',
      '--no-fund', '--no-audit',
      '--registry=https://registry.npmjs.org/',
      tarball,
    ], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 180_000,
    });
    if (install.status !== 0) {
      console.warn('[e2e] npm install failed (likely offline) — skipping:', install.stderr?.slice(0, 500));
      installSkipped = true;
      return;
    }

    port = await pickFreePort();
    const bin = path.join(tmpDir, 'node_modules', '@awareness-sdk', 'local', 'bin', 'awareness-local.mjs');
    assert.ok(fs.existsSync(bin), `daemon entrypoint not found at ${bin}`);

    daemonChild = spawn(process.execPath, [bin, 'start', '--port', String(port), '--project', projectDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    daemonChild.stdout.on('data', (d) => process.stderr.write(`[daemon.out] ${d}`));
    daemonChild.stderr.on('data', (d) => process.stderr.write(`[daemon.err] ${d}`));
  });

  after(async () => {
    if (daemonChild && !daemonChild.killed) {
      daemonChild.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!daemonChild.killed) daemonChild.kill('SIGKILL');
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it('daemon /healthz returns 200 within 30s', { timeout: TEST_TIMEOUT }, async (t) => {
    if (installSkipped) return t.skip('npm install unavailable (offline or registry error)');
    const ok = await waitForHealth(port, 30_000);
    assert.ok(ok, 'daemon never became healthy — check [daemon.err] above for the crash');
  });

  it('daemon /mcp responds to tools/list (means @modelcontextprotocol/sdk loaded cleanly)', { timeout: TEST_TIMEOUT }, async (t) => {
    if (installSkipped) return t.skip('npm install unavailable');
    const r = await new Promise((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/mcp`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      req.end();
    });
    assert.ok(r, 'no response from /mcp');
    assert.equal(r.status, 200, `/mcp tools/list returned ${r.status}: ${r.body?.slice(0, 300)}`);
  });
});
