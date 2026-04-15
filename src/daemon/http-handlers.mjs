import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonResponse } from './helpers.mjs';

export function handleHealthz(daemon, res, { version }) {
  const stats = daemon.indexer
    ? daemon.indexer.getStats()
    : { totalMemories: 0, totalKnowledge: 0, totalTasks: 0, totalSessions: 0 };

  return jsonResponse(res, {
    status: 'ok',
    mode: 'local',
    version,
    uptime: daemon._startedAt
      ? Math.floor((Date.now() - daemon._startedAt) / 1000)
      : 0,
    pid: process.pid,
    port: daemon.port,
    project_dir: daemon.projectDir,
    search_mode: daemon._embedder ? 'hybrid' : 'fts5-only',
    embedding: {
      available: !!daemon._embedder,
      model: daemon._embedder?.MODEL_MAP?.english || null,
      multilingual_model: daemon._embedder?.MODEL_MAP?.multilingual || null,
      auto_cjk_detection: true,
    },
    stats,
  });
}

const WEB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Serve static assets under src/web/. Only whitelisted subpaths (onboarding/) are exposed;
 * the root path returns index.html, any other request 404s to keep the surface minimal.
 */
export function handleWebUi(res, importMetaUrl, pathname = '/') {
  try {
    const thisDir = path.dirname(fileURLToPath(importMetaUrl));
    const webDir = path.join(thisDir, 'web');

    // URL-decode first so encoded traversal (%2e%2e) is also caught.
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { res.writeHead(400); res.end('bad path'); return; }

    // Strip leading /web/ or fall back to index.html
    let rel = decoded.replace(/^\/web\//, '').replace(/^\/+/, '');
    if (!rel || rel === 'web') rel = 'index.html';

    // Reject traversal, absolute paths, or NUL bytes.
    if (rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) {
      res.writeHead(400); res.end('bad path'); return;
    }

    // Only allow index.html at top level; subpaths must be under onboarding/
    const isAllowed = rel === 'index.html' || rel.startsWith('onboarding/');
    if (!isAllowed) {
      res.writeHead(404); res.end('not found'); return;
    }

    const filePath = path.join(webDir, rel);
    // Resolve symlinks: a symlink under web/ pointing outside must be rejected.
    let realPath;
    try { realPath = fs.realpathSync(filePath); }
    catch {
      // File doesn't exist — fall through to the existsSync check below for consistent 404.
      realPath = filePath;
    }
    const realWebDir = fs.realpathSync(webDir);
    if (!realPath.startsWith(realWebDir + path.sep) && realPath !== realWebDir) {
      res.writeHead(400); res.end('bad path'); return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = WEB_MIME[ext] || 'application/octet-stream';
      const body = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    // Only fall back to the placeholder for the root page
    if (rel !== 'index.html') {
      res.writeHead(404); res.end('not found');
      return;
    }
  } catch (err) {
    console.error('[awareness-local] failed to load web UI:', err.message);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Awareness Local</title></head>
<body style="font-family:system-ui;max-width:600px;margin:80px auto;color:#333">
  <h1>Awareness Local</h1>
  <p>Daemon is running. Web dashboard file not found.</p>
  <p><a href="/healthz">/healthz</a> &middot; <a href="/api/v1/stats">/api/v1/stats</a></p>
</body>
</html>`);
}
