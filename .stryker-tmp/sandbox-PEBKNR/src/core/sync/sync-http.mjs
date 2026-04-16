/**
 * sync-http.mjs — Thin HTTP client wrapper for sync sub-modules.
 *
 * Wraps Node's built-in http/https with JSON helpers plus an injectable
 * transport so tests can stub requests without opening sockets.
 *
 * Kept additive to cloud-sync.mjs: the existing CloudSync keeps its private
 * httpRequest. New sync modules should go through this factory.
 */
// @ts-nocheck


import http from 'node:http';
import https from 'node:https';

const LOG_PREFIX = '[CloudSync]';

/**
 * Default transport using Node built-ins. Resolves even on non-2xx.
 *
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string, timeout?: number}} opts
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
export function defaultTransport(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: opts.timeout ?? 15_000,
    };

    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

/**
 * Create a sync HTTP client bound to an API base + auth context.
 *
 * @param {object} cfg
 * @param {string} cfg.apiBase   — e.g. "https://api.awareness.market"
 * @param {string} [cfg.apiKey]  — bearer token
 * @param {string} [cfg.deviceId]
 * @param {Function} [cfg.transport] — override for tests; same shape as defaultTransport
 */
export function createSyncHttp({ apiBase, apiKey, deviceId, transport } = {}) {
  const base = (apiBase || '').replace(/\/$/, '');
  const send = transport || defaultTransport;

  function authHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (deviceId) headers['X-Device-Id'] = deviceId;
    return headers;
  }

  function buildUrl(endpoint) {
    if (/^https?:\/\//i.test(endpoint)) return endpoint;
    const ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${base}${ep}`;
  }

  /**
   * Generic request helper — returns `{status, body, headers, json}` without
   * throwing on non-2xx. `json` is the parsed body when possible.
   */
  async function request(method, endpoint, { body, headers, timeout } = {}) {
    const url = buildUrl(endpoint);
    const payload = body != null ? JSON.stringify(body) : undefined;
    const res = await send(url, {
      method,
      headers: authHeaders(headers),
      body: payload,
      timeout,
    });
    let json = null;
    if (res.body) {
      try {
        json = JSON.parse(res.body);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, body: res.body, json };
  }

  async function get(endpoint, opts) {
    return request('GET', endpoint, opts);
  }

  async function post(endpoint, body, opts = {}) {
    return request('POST', endpoint, { ...opts, body });
  }

  async function put(endpoint, body, opts = {}) {
    return request('PUT', endpoint, { ...opts, body });
  }

  return { request, get, post, put, authHeaders, buildUrl, LOG_PREFIX };
}
