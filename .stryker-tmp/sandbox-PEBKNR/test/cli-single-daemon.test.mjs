/**
 * Single-daemon policy tests for bin/awareness-local.mjs.
 *
 * Contract:
 *   - resolvePort() returns --port flag when given, else 37800. No registry lookup.
 *   - registerWorkspace(newDir, {port:37800}) does NOT auto-allocate 37801 even
 *     when another workspace is already at 37800 in ~/.awareness/workspaces.json.
 *   - The CLI probe logic (checked via real subprocess) detects an existing
 *     Awareness daemon and POSTs /api/v1/workspace/switch instead of
 *     spawning a duplicate on a new port.
 */
// @ts-nocheck


import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../bin/awareness-local.mjs');

// ---------- registerWorkspace: no port auto-allocation ----------

test('registerWorkspace: new workspace reuses default 37800 even when occupied', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-reg-'));
  const originalHome = process.env.HOME;
  process.env.HOME = tmp;
  t.after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Seed workspaces.json with one workspace already on 37800
  const awDir = path.join(tmp, '.awareness');
  fs.mkdirSync(awDir, { recursive: true });
  fs.writeFileSync(
    path.join(awDir, 'workspaces.json'),
    JSON.stringify({
      '/first/project': {
        memoryId: 'aw_first',
        port: 37800,
        name: 'first',
        lastUsed: new Date().toISOString(),
      },
    }),
  );

  // Bust import cache: use a unique query to force re-import
  const cacheBuster = `?t=${Date.now()}`;
  const { registerWorkspace } = await import(
    new URL('../src/core/config.mjs' + cacheBuster, import.meta.url).href
  );

  const entry = registerWorkspace('/second/project', { port: 37800 });
  assert.equal(entry.port, 37800, 'second workspace must share the default port');
});

test('registerWorkspace: existing entry is updated, port preserved', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-reg-'));
  const originalHome = process.env.HOME;
  process.env.HOME = tmp;
  t.after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const { registerWorkspace, lookupWorkspace } = await import(
    new URL('../src/core/config.mjs?' + Date.now(), import.meta.url).href
  );

  registerWorkspace('/proj/alpha', { port: 37800, memoryId: 'aw_a' });
  const updated = registerWorkspace('/proj/alpha', { memoryId: 'aw_a', name: 'alpha-renamed' });
  assert.equal(updated.port, 37800);
  assert.equal(updated.name, 'alpha-renamed');
  assert.equal(lookupWorkspace('/proj/alpha').port, 37800);
});

// ---------- CLI: probe + switch vs. spawn new ----------

/**
 * Stand up a minimal HTTP server that pretends to be an Awareness daemon at
 * port 37800 (or any given port). Returns a controller with .close() and a
 * .calls log so tests can assert the CLI made the right requests.
 */
function startFakeDaemon({ port, projectDir }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        mode: 'local',
        version: '0.6.0-test',
        pid: process.pid,
        port,
        project_dir: projectDir,
      }));
      return;
    }
    if (req.url === '/api/v1/workspace/switch' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls[calls.length - 1].body = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', projectDir: JSON.parse(body).project_dir }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      calls,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI start: existing daemon on same project → exits with "already running"', async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-proj-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-home-'));
  const daemon = await startFakeDaemon({ port: 37833, projectDir });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const res = await runCli(
    ['start', '--project', projectDir, '--port', '37833'],
    { HOME: tmpHome },
  );
  assert.equal(res.code, 0, `CLI exit 0, got ${res.code}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /already running/i);
  assert.ok(
    daemon.calls.some((c) => c.url === '/healthz'),
    'expected CLI to probe /healthz',
  );
  assert.ok(
    !daemon.calls.some((c) => c.url === '/api/v1/workspace/switch'),
    'must NOT POST switch when project matches',
  );
});

test('CLI start: existing daemon on different project → POSTs /workspace/switch', async (t) => {
  const existingProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-old-'));
  const newProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-new-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-home-'));
  const daemon = await startFakeDaemon({ port: 37834, projectDir: existingProject });
  t.after(async () => {
    await daemon.close();
    fs.rmSync(existingProject, { recursive: true, force: true });
    fs.rmSync(newProject, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const res = await runCli(
    ['start', '--project', newProject, '--port', '37834'],
    { HOME: tmpHome },
  );
  assert.equal(res.code, 0, `exit 0, got ${res.code}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /Switched daemon workspace/i);
  const switchCall = daemon.calls.find((c) => c.url === '/api/v1/workspace/switch');
  assert.ok(switchCall, 'must POST /api/v1/workspace/switch');
  assert.equal(switchCall.method, 'POST');
  const payload = JSON.parse(switchCall.body);
  assert.equal(path.resolve(payload.project_dir), path.resolve(newProject));
});
