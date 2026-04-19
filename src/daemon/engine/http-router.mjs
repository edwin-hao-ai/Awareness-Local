/**
 * HTTP request router · extracted from daemon.mjs::_handleRequest
 * (F-057 Phase 7). Dispatches to /healthz, /mcp, /api/v1, or /web based
 * on URL path. Enforces project_dir validation via the
 * `x-awareness-project-dir(-b64)` header and refuses requests while a
 * project switch is in progress.
 */

import path from 'node:path';
import { jsonResponse } from '../helpers.mjs';
import { track } from '../../core/telemetry.mjs';

export async function handleHttpRequest(daemon, req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, X-Awareness-Project-Dir, X-Awareness-Project-Dir-B64',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${daemon.port}`);

  try {
    // /healthz — exempt from project validation
    if (url.pathname === '/healthz') {
      return daemon._handleHealthz(res);
    }

    // Guard: reject requests while switchProject() is in progress
    if (daemon._switching) {
      jsonResponse(res, { error: 'project_switching', message: 'Daemon is switching projects, retry shortly' }, 503);
      return;
    }

    // Per-request project_dir validation — base64 variant supports
    // CJK/emoji paths on Windows. Malformed base64 silently falls
    // through to the legacy plain header.
    let requestedProject = null;
    const b64Header = req.headers['x-awareness-project-dir-b64'];
    if (b64Header) {
      try {
        requestedProject = Buffer.from(String(b64Header), 'base64').toString('utf8');
      } catch { /* malformed → ignore */ }
    }
    if (!requestedProject && req.headers['x-awareness-project-dir']) {
      requestedProject = String(req.headers['x-awareness-project-dir']);
    }
    if (requestedProject) {
      const normalizedRequested = path.resolve(requestedProject);
      const normalizedCurrent = path.resolve(daemon.projectDir);
      if (normalizedRequested !== normalizedCurrent) {
        jsonResponse(res, {
          error: 'project_mismatch',
          daemon_project: normalizedCurrent,
          requested_project: normalizedRequested,
        }, 409);
        return;
      }
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return await daemon._handleMcp(req, res);
    }

    if (url.pathname.startsWith('/api/v1')) {
      return await daemon._handleApi(req, res, url);
    }

    if (url.pathname === '/' || url.pathname.startsWith('/web')) {
      return daemon._handleWebUI(res, url.pathname);
    }

    jsonResponse(res, { error: 'Not Found' }, 404);
  } catch (err) {
    console.error('[awareness-local] request error:', err.message);
    track('error_occurred', { error_code: err.code || 'unknown', component: 'api' });
    jsonResponse(res, { error: 'Internal Server Error' }, 500);
  }
}
