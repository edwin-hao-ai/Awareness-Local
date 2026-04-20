/**
 * Switch-ghost-pipeline regression test.
 *
 * Bug (2026-04-20, reported by user): switching workspaces 2+ times in
 * a row freezes the UI. Root cause was a fire-and-forget graph-embedder
 * pipeline that kept calling graphInsertNode / graphInsertEdge /
 * storeGraphEmbedding on the indexer *after* switchProject() had closed
 * its DB, flooding the log with "The database connection is not open"
 * (7606 lines per 3-switch cycle in the repro).
 *
 * This test spins up an isolated daemon on a throwaway port with 3
 * seeded workspaces (200 small files each — enough to make the
 * graph-embedder actually run), switches A → B → C with no pauses,
 * and asserts:
 *   1. zero "database connection is not open" lines in the daemon log
 *   2. each switch returns HTTP 200 within 5s
 *   3. /healthz stays responsive the whole time
 *
 * If this test fails, do NOT just bump the threshold — it means the
 * graph-embedder abort/drain contract is broken again. Investigate
 * graph-embedder.mjs's signal handling and switchProject's
 * `await this._inflightGraphPipeline` drain step first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../bin/awareness-local.mjs');
const PORT = 37911; // avoid 37800 (user's real daemon) and 37900 (repro script)
const BASE = `http://127.0.0.1:${PORT}`;

async function getJson(pathname, { timeout = 3000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(`${BASE}${pathname}`, { signal: ac.signal });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message };
  } finally { clearTimeout(t); }
}

async function postSwitch(projectDir, { timeout = 10000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/v1/workspace/switch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_dir: projectDir }),
      signal: ac.signal,
    });
    return { ok: r.ok, status: r.status, elapsed: Date.now() - t0 };
  } catch (e) {
    return { ok: false, elapsed: Date.now() - t0, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message };
  } finally { clearTimeout(t); }
}

function seedWorkspace(dir, fileCount = 200) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  for (let i = 0; i < fileCount; i++) {
    const sub = path.join(dir, `dir${Math.floor(i / 50)}`);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, `mod${i}.js`),
      `// ${path.basename(dir)} mod ${i}\nexport function h${i}(x){ return x*${i}; }\n`,
    );
  }
}

async function waitForHealthz(deadlineMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = await getJson('/healthz', { timeout: 1000 });
    if (r.ok) return true;
    await new Promise((x) => setTimeout(x, 200));
  }
  return false;
}

test('switch A→B→C with active graph-embedder pipelines does not flood log with closed-DB errors', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-switch-ghost-'));
  const daemonRoot = path.join(root, 'daemon-root');
  const logFile = path.join(root, 'daemon.log');
  const wsA = path.join(root, 'ws-A');
  const wsB = path.join(root, 'ws-B');
  const wsC = path.join(root, 'ws-C');
  fs.mkdirSync(daemonRoot, { recursive: true });
  seedWorkspace(wsA, 200);
  seedWorkspace(wsB, 200);
  seedWorkspace(wsC, 200);

  const logStream = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [CLI, 'start', '--foreground', '--project', daemonRoot, '--port', String(PORT)], {
    stdio: ['ignore', logStream, logStream],
    detached: false,
  });

  t.after(async () => {
    try { child.kill('SIGTERM'); } catch {}
    // Give it a moment to exit cleanly before hard-killing
    await new Promise((x) => setTimeout(x, 500));
    try { child.kill('SIGKILL'); } catch {}
    try { fs.closeSync(logStream); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  const up = await waitForHealthz(15000);
  assert.equal(up, true, 'daemon must come up on /healthz within 15s');

  // Fire 3 back-to-back switches so the earlier graph-embedder pipelines
  // are still running when the next switch tears down their DB.
  const r1 = await postSwitch(wsA);
  assert.equal(r1.ok, true, `switch A failed: ${r1.error || r1.status}`);
  assert.ok(r1.elapsed < 5000, `switch A too slow: ${r1.elapsed}ms`);

  const r2 = await postSwitch(wsB);
  assert.equal(r2.ok, true, `switch B failed: ${r2.error || r2.status}`);
  assert.ok(r2.elapsed < 5000, `switch B too slow: ${r2.elapsed}ms`);

  const r3 = await postSwitch(wsC);
  assert.equal(r3.ok, true, `switch C failed: ${r3.error || r3.status}`);
  assert.ok(r3.elapsed < 5000, `switch C too slow: ${r3.elapsed}ms`);

  // healthz stays responsive right after the critical 3rd switch
  const h = await getJson('/healthz', { timeout: 2000 });
  assert.equal(h.ok, true, 'healthz must respond within 2s after the third switch');

  // Give any residual pipeline ~1s to attempt writes against the now-closed DBs.
  await new Promise((x) => setTimeout(x, 1200));

  const log = fs.readFileSync(logFile, 'utf8');
  const closedDbLines = log.split('\n').filter((l) => l.includes('database connection is not open')).length;
  assert.equal(
    closedDbLines, 0,
    `expected ZERO "database connection is not open" log lines, saw ${closedDbLines}.\n` +
    `This means a fire-and-forget pipeline is still writing to a closed indexer.\n` +
    `Check: graph-embedder.mjs signal handling, switchProject _inflightGraphPipeline drain.\n` +
    `Log tail:\n${log.split('\n').slice(-30).join('\n')}`,
  );
});
