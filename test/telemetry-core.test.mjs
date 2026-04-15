import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telemetry } from '../src/core/telemetry.mjs';

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-tel-'));
  fs.mkdirSync(path.join(dir, '.awareness'), { recursive: true });
  return dir;
}

function makeTel({ enabled = true, fetchImpl } = {}) {
  const projectDir = tmpProject();
  const realFetch = global.fetch;
  if (fetchImpl) global.fetch = fetchImpl;
  const tel = new Telemetry({
    config: { telemetry: { enabled, endpoint: 'https://example.test/api/v1' }, device: { id: 'dev-test-1' } },
    projectDir,
    version: '0.5.x-test',
  });
  return {
    tel,
    projectDir,
    restore() { global.fetch = realFetch; },
  };
}

test('Telemetry: opt-out is the default — track() is a no-op', () => {
  const { tel, restore } = makeTel({ enabled: false });
  tel.track('daemon_started', { os: 'darwin' });
  assert.equal(tel.queue.length, 0);
  restore();
});

test('Telemetry: when enabled, track() enqueues only whitelisted events', () => {
  const { tel, restore } = makeTel();
  tel.track('daemon_started', { os: 'darwin' });
  tel.track('NOT_WHITELISTED', { foo: 'bar' });
  assert.equal(tel.queue.length, 1);
  assert.equal(tel.queue[0].event_type, 'daemon_started');
  restore();
});

test('Telemetry: properties are filtered to the whitelist', () => {
  const { tel, restore } = makeTel();
  tel.track('daemon_started', {
    os: 'darwin',
    arch: 'arm64',
    secret_token: 'sk-leaked',
    file_path: '/Users/me/secret.md',
    query: 'private question',
  });
  const props = tel.queue[0].properties;
  assert.equal(props.os, 'darwin');
  assert.equal(props.arch, 'arm64');
  assert.equal(props.secret_token, undefined);
  assert.equal(props.file_path, undefined);
  assert.equal(props.query, undefined);
  restore();
});

test('Telemetry: long string values are dropped (leak guard)', () => {
  const { tel, restore } = makeTel();
  tel.track('error_occurred', { error_code: 'x'.repeat(300), component: 'ok' });
  const props = tel.queue[0].properties;
  assert.equal(props.error_code, undefined);
  assert.equal(props.component, 'ok');
  restore();
});

test('Telemetry: installation_id is deterministic SHA-256 hash, not raw device_id', () => {
  const { tel: a, restore: r1 } = makeTel();
  const { tel: b, restore: r2 } = makeTel();
  assert.equal(a.installationId, b.installationId);
  assert.notEqual(a.installationId, 'dev-test-1');
  assert.match(a.installationId, /^[0-9a-f]{64}$/);
  r1(); r2();
});

test('Telemetry: setEnabled(false) clears the queue immediately', () => {
  const { tel, restore } = makeTel();
  tel.track('daemon_started', { os: 'linux' });
  assert.equal(tel.queue.length, 1);
  tel.setEnabled(false);
  assert.equal(tel.queue.length, 0);
  restore();
});

test('Telemetry: queue persists to .awareness/telemetry-queue.json', () => {
  const { tel, projectDir, restore } = makeTel();
  tel.track('daemon_started', { os: 'darwin' });
  const queueFile = path.join(projectDir, '.awareness', 'telemetry-queue.json');
  assert.ok(fs.existsSync(queueFile));
  const onDisk = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
  assert.equal(onDisk.length, 1);
  restore();
});

test('Telemetry: flush() POSTs whitelist endpoint with batched events', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  const { tel, restore } = makeTel({ fetchImpl });
  tel.track('daemon_started', { os: 'darwin' });
  tel.track('onboarding_step', { step_number: 1 });
  await tel.flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/telemetry\/events$/);
  assert.equal(calls[0].body.events.length, 2);
  // Queue cleared after flush
  assert.equal(tel.queue.length, 0);
  restore();
});

test('Telemetry: deleteLocal() clears queue AND POSTs forget endpoint', async () => {
  const forgotten = [];
  const fetchImpl = async (url, opts) => {
    forgotten.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  const { tel, restore } = makeTel({ fetchImpl });
  tel.track('daemon_started', { os: 'darwin' });
  await tel.deleteLocal();
  assert.equal(tel.queue.length, 0);
  assert.equal(forgotten.length, 1);
  assert.match(forgotten[0].url, /\/telemetry\/forget$/);
  assert.equal(forgotten[0].body.installation_id, tel.installationId);
  restore();
});

test('Telemetry: track is no-op when disabled even after enable→track→disable', () => {
  const { tel, restore } = makeTel({ enabled: false });
  tel.track('daemon_started', { os: 'darwin' });
  assert.equal(tel.queue.length, 0);
  tel.setEnabled(true);
  tel.track('daemon_started', { os: 'darwin' });
  assert.equal(tel.queue.length, 1);
  tel.setEnabled(false);
  tel.track('daemon_started', { os: 'darwin' });
  assert.equal(tel.queue.length, 0);
  restore();
});

test('Telemetry: hard cap drops oldest events past MAX_QUEUE', () => {
  const { tel, restore } = makeTel();
  for (let i = 0; i < 600; i++) tel.track('daemon_started', { os: 'darwin' });
  assert.ok(tel.queue.length <= 500, `queue overflowed: ${tel.queue.length}`);
  restore();
});
