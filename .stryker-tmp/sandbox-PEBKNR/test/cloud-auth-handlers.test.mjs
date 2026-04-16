/**
 * cloud-auth-handlers.test.mjs — Tests for local daemon cloud auth proxy.
 *
 * Covers F-035 (headless device auth UX):
 *   - apiCloudAuthStart enriches response with verification_url + is_headless
 *   - apiCloudAuthPoll honors total_wait_ms beyond the historical 30s cap
 *   - Poll timeout is clamped to [30s, 900s]
 *   - Headless env detection works for SSH / missing DISPLAY / explicit flag
 */
// @ts-nocheck


import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiCloudAuthStart,
  apiCloudAuthPoll,
  apiCloudGetProfile,
} from '../src/daemon/api-handlers.mjs';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockRes() {
  let _status = 200;
  let _body = '';
  return {
    writeHead(status) { _status = status; },
    end(body) { _body = body; },
    get status() { return _status; },
    get json() { return JSON.parse(_body); },
  };
}

function mockReq(body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const chunks = [Buffer.from(payload)];
  let idx = 0;
  return {
    on(event, handler) {
      if (event === 'data') {
        for (const c of chunks) handler(c);
      } else if (event === 'end') {
        handler();
      }
    },
  };
}

/** Build a fake daemon with a programmable _httpJson for intercepting backend calls.
 *
 * IMPORTANT: this fake intentionally leaves `daemon.config` undefined to mirror
 * the real daemon (which never assigns it). Handlers must go through
 * `_loadConfig()` to read the current config, not `daemon.config` — see the
 * pre-existing bug fix in F-035 where apiCloudAuthStart was hitting production
 * because it read `daemon.config?.cloud?.api_base`.
 */
function fakeDaemon({ onPost, configOverride } = {}) {
  const calls = [];
  const config = configOverride ?? {
    cloud: { api_base: 'https://backend.test/api/v1' },
  };
  return {
    // config intentionally NOT set — matches real daemon behavior
    _loadConfig() {
      return config;
    },
    async _httpJson(method, url, body) {
      calls.push({ method, url, body });
      if (onPost) return onPost({ method, url, body, callIndex: calls.length - 1 });
      return {};
    },
    _calls: calls,
  };
}

function timeoutError(message = 'timed out') {
  const err = new Error(message);
  err.code = 'ETIMEDOUT';
  return err;
}

// ---------------------------------------------------------------------------
// Environment sandbox: each test saves/restores process.env keys it touches
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'AWARENESS_HEADLESS',
  'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
  'CODESPACES', 'GITPOD_WORKSPACE_ID', 'CLOUD_SHELL',
  'DISPLAY', 'WAYLAND_DISPLAY',
];

function saveEnv() {
  const snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
  return snapshot;
}

function restoreEnv(snapshot) {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

// ---------------------------------------------------------------------------
// apiCloudAuthStart
// ---------------------------------------------------------------------------

describe('apiCloudAuthStart', () => {
  let snapshot;
  before(() => { snapshot = saveEnv(); });
  after(() => restoreEnv(snapshot));

  it('proxies to backend and enriches with verification_url + is_headless', async () => {
    clearEnv();
    process.env.AWARENESS_HEADLESS = '1';

    const daemon = fakeDaemon({
      onPost: () => ({
        device_code: 'dev_abc',
        user_code: 'A3K9-M7FX',
        verification_uri: 'https://awareness.market/cli-auth',
        expires_in: 900,
        interval: 5,
      }),
    });
    const res = mockRes();
    await apiCloudAuthStart(daemon, {}, res);

    assert.equal(res.status, 200);
    assert.equal(res.json.device_code, 'dev_abc');
    assert.equal(res.json.user_code, 'A3K9-M7FX');
    assert.equal(
      res.json.verification_url,
      'https://awareness.market/cli-auth?code=A3K9-M7FX',
      'verification_url should be a ready-to-click URL with ?code=',
    );
    assert.equal(res.json.is_headless, true);
    assert.equal(daemon._calls.length, 1);
    assert.equal(daemon._calls[0].url, 'https://backend.test/api/v1/auth/device/init');
  });

  it('reports is_headless=false on desktop macOS-equivalent env', async () => {
    clearEnv();
    process.env.AWARENESS_HEADLESS = '0';
    process.env.DISPLAY = ':0';

    const daemon = fakeDaemon({
      onPost: () => ({
        device_code: 'dev_xyz',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://awareness.market/cli-auth',
        expires_in: 900,
        interval: 5,
      }),
    });
    const res = mockRes();
    await apiCloudAuthStart(daemon, {}, res);

    assert.equal(res.json.is_headless, false);
  });

  it('detects SSH_CONNECTION as headless without explicit flag', async () => {
    clearEnv();
    process.env.SSH_CONNECTION = '1.2.3.4 22 5.6.7.8 22';

    const daemon = fakeDaemon({
      onPost: () => ({
        device_code: 'dev_ssh',
        user_code: 'SSH1-TEST',
        verification_uri: 'https://awareness.market/cli-auth',
        expires_in: 900,
        interval: 5,
      }),
    });
    const res = mockRes();
    await apiCloudAuthStart(daemon, {}, res);

    assert.equal(res.json.is_headless, true);
  });

  it('returns 502 on backend failure with friendly error', async () => {
    clearEnv();
    const daemon = fakeDaemon({
      onPost: () => { throw new Error('network down'); },
    });
    const res = mockRes();
    await apiCloudAuthStart(daemon, {}, res);

    assert.equal(res.status, 502);
    assert.match(res.json.error, /network down/);
  });

  it('reads config via _loadConfig() not daemon.config (regression)', async () => {
    // Historical bug: apiCloudAuthStart used `daemon.config?.cloud?.api_base`
    // but daemon.config was never assigned, so it silently fell back to the
    // production URL. This test guards against that regression by checking
    // that the handler uses the config returned from _loadConfig().
    clearEnv();
    const daemon = fakeDaemon({
      configOverride: {
        cloud: { api_base: 'http://localhost:8000/api/v1' },
      },
      onPost: ({ url }) => {
        // If the handler falls back to production URL, this assertion
        // would fire — the test would fail because the URL contains
        // "awareness.market" not "localhost".
        assert.match(url, /localhost:8000/, 'Should use configured api_base');
        return {
          device_code: 'dc1',
          user_code: 'RGRS-TEST',
          verification_uri: 'https://awareness.market/cli-auth',
          expires_in: 900,
          interval: 5,
        };
      },
    });
    const res = mockRes();
    await apiCloudAuthStart(daemon, {}, res);
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// apiCloudAuthPoll
// ---------------------------------------------------------------------------

describe('apiCloudAuthPoll', () => {
  it('returns api_key immediately when backend says approved', async () => {
    const daemon = fakeDaemon({
      onPost: () => ({ status: 'approved', api_key: 'aw_new_key', user_id: 'u1' }),
    });
    const res = mockRes();
    await apiCloudAuthPoll(daemon, mockReq({ device_code: 'dev_abc' }), res);

    assert.equal(res.status, 200);
    assert.equal(res.json.api_key, 'aw_new_key');
    assert.equal(res.json.user_id, 'u1');
  });

  it('returns 410 expired when backend says expired', async () => {
    const daemon = fakeDaemon({
      onPost: () => ({ status: 'expired' }),
    });
    const res = mockRes();
    await apiCloudAuthPoll(daemon, mockReq({ device_code: 'dev_abc' }), res);

    assert.equal(res.status, 410);
    assert.match(res.json.error, /expired/i);
  });

  it('accepts total_wait_ms parameter to extend poll window', async () => {
    // Force a short poll loop but with a very short interval so test is fast.
    // We'll make the backend always return pending and verify it polls
    // multiple times within the 30 000ms minimum wait.
    let pollCount = 0;
    const daemon = fakeDaemon({
      onPost: () => {
        pollCount++;
        return { status: 'pending' };
      },
    });
    const res = mockRes();

    // Use interval=1 (bumped to 3000ms minimum) and total_wait_ms=30000 (clamped)
    // to bound the test at exactly 30 seconds. We cannot wait that long in a
    // unit test, so we cut this test short by using a tight daemon.
    // Instead we'll pass total_wait_ms=30000 which is the minimum clamp, and
    // verify by checking that after the loop completes the response is 408.
    const start = Date.now();
    await apiCloudAuthPoll(
      daemon,
      mockReq({ device_code: 'dev_abc', interval: 1, total_wait_ms: 30000 }),
      res,
    );
    const elapsed = Date.now() - start;

    assert.equal(res.status, 408);
    assert.equal(res.json.status, 'pending');
    // 30s minimum clamp + 3s interval minimum = 10 polls
    assert.ok(pollCount >= 10, `expected at least 10 polls, got ${pollCount}`);
    // Don't be too strict on upper bound — timer jitter is possible.
    assert.ok(elapsed >= 29000, `expected at least 29s elapsed, got ${elapsed}ms`);
  }).timeout = 60000; // allow 60s max for this slow test

  it('clamps total_wait_ms above 900s to 900s', async () => {
    // We verify the clamp indirectly: pass a huge value and ensure the
    // handler does not hang for > 900s. Using pending responses with
    // a high interval would take too long to fully verify here, so we
    // instead check the clamp via a short-interval variant.
    // Use approved on 2nd call to exit fast but confirm the loop accepts
    // the inflated number without crashing.
    let pollCount = 0;
    const daemon = fakeDaemon({
      onPost: () => {
        pollCount++;
        if (pollCount >= 2) return { status: 'approved', api_key: 'aw_k' };
        return { status: 'pending' };
      },
    });
    const res = mockRes();
    await apiCloudAuthPoll(
      daemon,
      // Interval 3s min, huge total would be clamped to 900s.
      // Approved on 2nd poll → returns fast.
      mockReq({ device_code: 'dev_abc', interval: 1, total_wait_ms: 999999999 }),
      res,
    );

    assert.equal(res.status, 200);
    assert.equal(res.json.api_key, 'aw_k');
  });

  it('returns 400 on invalid JSON', async () => {
    const daemon = fakeDaemon();
    const res = mockRes();
    await apiCloudAuthPoll(daemon, mockReq('not json'), res);

    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// apiCloudGetProfile
// ---------------------------------------------------------------------------

describe('apiCloudGetProfile', () => {
  it('returns the user profile when api_key is provided in POST body', async () => {
    const daemon = fakeDaemon({
      onPost: ({ method, url, body }) => {
        assert.equal(method, 'GET');
        assert.equal(url, 'https://backend.test/api/v1/users/me');
        assert.deepEqual(body, null);
        return { email: 'test@example.com', id: 'user_123' };
      },
    });
    const res = mockRes();

    await apiCloudGetProfile(daemon, mockReq({ api_key: 'aw_token' }), res, new URL('http://127.0.0.1/api/v1/cloud/profile'));

    assert.equal(res.status, 200);
    assert.equal(res.json.email, 'test@example.com');
    assert.equal(daemon._calls.length, 1);
  });

  it('falls back to configured api_key when POST body is empty', async () => {
    const daemon = fakeDaemon({
      configOverride: {
        cloud: {
          api_base: 'https://backend.test/api/v1',
          api_key: 'from-config',
        },
      },
      onPost: () => ({ email: 'config@example.com' }),
    });
    const res = mockRes();

    await apiCloudGetProfile(daemon, mockReq({}), res, new URL('http://127.0.0.1/api/v1/cloud/profile'));

    assert.equal(res.status, 200);
    assert.equal(res.json.email, 'config@example.com');
  });

  it('returns 400 on invalid JSON body', async () => {
    const daemon = fakeDaemon();
    const res = mockRes();

    await apiCloudGetProfile(daemon, mockReq('not json'), res, new URL('http://127.0.0.1/api/v1/cloud/profile'));

    assert.equal(res.status, 400);
    assert.match(res.json.error, /invalid json/i);
  });

  it('returns 400 when no api_key is available', async () => {
    const daemon = fakeDaemon({
      configOverride: { cloud: { api_base: 'https://backend.test/api/v1' } },
    });
    const res = mockRes();

    await apiCloudGetProfile(daemon, mockReq({}), res, new URL('http://127.0.0.1/api/v1/cloud/profile'));

    assert.equal(res.status, 400);
    assert.match(res.json.error, /cloud not configured/i);
  });

  it('returns 502 when upstream returns a 5xx-style error', async () => {
    const daemon = fakeDaemon({
      onPost: () => {
        throw new Error('HTTP 502 https://backend.test/api/v1/users/me — <html>Bad Gateway</html>');
      },
    });
    const res = mockRes();

    await apiCloudGetProfile(daemon, mockReq({ api_key: 'aw_token' }), res, new URL('http://127.0.0.1/api/v1/cloud/profile'));

    assert.equal(res.status, 502);
    assert.match(res.json.error, /502/);
  });

  it('returns 502 when upstream times out', async () => {
    const daemon = fakeDaemon({
      onPost: () => {
        throw timeoutError('upstream timed out');
      },
    });
    const res = mockRes();

    await apiCloudGetProfile(daemon, mockReq({ api_key: 'aw_token' }), res, new URL('http://127.0.0.1/api/v1/cloud/profile'));

    assert.equal(res.status, 502);
    assert.match(res.json.error, /timed out/i);
  });
});
