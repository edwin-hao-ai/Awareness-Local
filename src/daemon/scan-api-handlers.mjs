/**
 * Scan API Handlers — REST endpoints for workspace scanning (F-038).
 *
 * Endpoints:
 *   GET  /api/v1/scan/status  — current scan state
 *   POST /api/v1/scan/trigger — trigger manual scan
 *   GET  /api/v1/scan/files   — list indexed workspace files
 *   GET  /api/v1/scan/file/:id — single file detail
 *   GET  /api/v1/scan/config  — current scan config
 *   PUT  /api/v1/scan/config  — update scan config
 */

import { jsonResponse, readBody } from './helpers.mjs';
import { loadScanConfig, saveScanConfig } from '../core/scan-config.mjs';

// ---------------------------------------------------------------------------
// GET /api/v1/scan/status
// ---------------------------------------------------------------------------

export function apiScanStatus(daemon, _req, res) {
  const state = daemon.scanState || {
    status: 'idle',
    phase: null,
    total_files: 0,
  };
  return jsonResponse(res, state);
}

// ---------------------------------------------------------------------------
// POST /api/v1/scan/trigger
// ---------------------------------------------------------------------------

export async function apiScanTrigger(daemon, req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON' }, 400);
  }

  const mode = body.mode || 'incremental';
  if (mode !== 'full' && mode !== 'incremental') {
    return jsonResponse(res, { error: 'mode must be "full" or "incremental"' }, 400);
  }

  if (daemon.scanState?.status === 'scanning' || daemon.scanState?.status === 'indexing') {
    return jsonResponse(res, { error: 'Scan already in progress', status: daemon.scanState.status }, 409);
  }

  // Trigger scan in background (non-blocking)
  if (typeof daemon.triggerScan === 'function') {
    daemon.triggerScan(mode).catch(err => {
      console.error('[scan-api] trigger error:', err.message);
    });
  }

  return jsonResponse(res, { ok: true, mode });
}

// ---------------------------------------------------------------------------
// GET /api/v1/scan/files
// ---------------------------------------------------------------------------

export function apiScanFiles(daemon, _req, res, url) {
  if (!daemon.indexer) {
    return jsonResponse(res, { error: 'Indexer not available' }, 503);
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const category = url.searchParams.get('category') || null;
  const q = url.searchParams.get('q') || null;
  const status = url.searchParams.get('status') || 'active';

  try {
    const columns = 'id, node_type, title, content_hash, metadata, salience_score, recall_count, status, created_at, updated_at';
    let sql = '';
    const params = [];

    // Map category param to graph_nodes query
    if (category === 'wiki') {
      // Query wiki pages (node_type = 'wiki')
      sql = `SELECT ${columns} FROM graph_nodes WHERE node_type = 'wiki'`;
    } else if (category === 'docs') {
      // Query doc files (file+docs) and converted documents (node_type='doc')
      sql = `SELECT ${columns} FROM graph_nodes WHERE (node_type = 'file' AND json_extract(metadata, '$.category') = 'docs') OR node_type = 'doc'`;
    } else if (category === 'code') {
      sql = `SELECT ${columns} FROM graph_nodes WHERE node_type = 'file' AND json_extract(metadata, '$.category') = 'code'`;
    } else if (category === 'config') {
      sql = `SELECT ${columns} FROM graph_nodes WHERE node_type = 'file' AND json_extract(metadata, '$.category') = 'config'`;
    } else {
      // Default: all file-like nodes (file + doc + wiki)
      sql = `SELECT ${columns} FROM graph_nodes WHERE node_type IN ('file', 'doc', 'wiki')`;
    }

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (q) {
      // Use FTS5 for text search — search across all node types
      const nodeTypes = category === 'wiki' ? ['wiki'] : category === 'docs' ? ['file', 'doc'] : category === 'code' ? ['file'] : ['file', 'doc', 'wiki'];
      const ftsResults = daemon.indexer.searchGraphNodes(q, { nodeTypes, limit: limit + offset });
      const ids = ftsResults.map(r => r.id);
      if (ids.length === 0) {
        return jsonResponse(res, { files: [], total: 0, limit, offset });
      }
      const placeholders = ids.map(() => '?').join(',');
      sql = `SELECT ${columns} FROM graph_nodes WHERE id IN (${placeholders})`;
      params.length = 0;
      params.push(...ids);
    }

    // Count total
    const countSql = sql.replace(/SELECT .+ FROM/, 'SELECT count(*) AS total FROM');
    const total = daemon.indexer.db.prepare(countSql).get(...params)?.total || 0;

    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = daemon.indexer.db.prepare(sql).all(...params);

    const files = rows.map(row => ({
      id: row.id,
      title: row.title,
      category: safeJsonExtract(row.metadata, 'category'),
      relativePath: safeJsonExtract(row.metadata, 'relativePath'),
      size: safeJsonExtract(row.metadata, 'size'),
      content_hash: row.content_hash,
      salience_score: row.salience_score,
      recall_count: row.recall_count,
      status: row.status,
      updated_at: row.updated_at,
    }));

    return jsonResponse(res, { files, total, limit, offset });
  } catch (err) {
    return jsonResponse(res, { error: 'Query failed: ' + err.message }, 500);
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/scan/file/:fileId
// ---------------------------------------------------------------------------

export function apiScanFileDetail(daemon, _req, res, fileId) {
  if (!daemon.indexer) {
    return jsonResponse(res, { error: 'Indexer not available' }, 503);
  }

  // Resolve node ID: if it already has a type prefix (file:/wiki:/doc:/sym:), use as-is.
  // Otherwise, try 'file:' prefix as default.
  const hasPrefix = /^(file|wiki|doc|sym):/.test(fileId);
  const nodeId = hasPrefix ? fileId : 'file:' + fileId;
  const node = daemon.indexer.getGraphNode(nodeId);

  if (!node) {
    return jsonResponse(res, { error: 'File not found' }, 404);
  }

  // Get connected edges
  let edges = [];
  try {
    edges = daemon.indexer.db.prepare(`
      SELECT from_node_id, to_node_id, edge_type, weight, metadata
      FROM graph_edges
      WHERE from_node_id = ? OR to_node_id = ?
    `).all(nodeId, nodeId);
  } catch { /* edges table might not exist */ }

  const metadata = safeJsonParse(node.metadata);
  return jsonResponse(res, {
    id: node.id,
    title: node.title,
    node_type: node.node_type,
    content: node.content,
    content_hash: node.content_hash,
    metadata,
    salience_score: node.salience_score,
    recall_count: node.recall_count,
    status: node.status,
    created_at: node.created_at,
    updated_at: node.updated_at,
    edges: edges.map(e => ({
      from: e.from_node_id,
      to: e.to_node_id,
      type: e.edge_type,
      weight: e.weight,
      metadata: safeJsonParse(e.metadata),
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/scan/config
// ---------------------------------------------------------------------------

export function apiScanConfig(daemon, _req, res) {
  const config = loadScanConfig(daemon.projectDir);
  return jsonResponse(res, config);
}

// ---------------------------------------------------------------------------
// PUT /api/v1/scan/config
// ---------------------------------------------------------------------------

export async function apiScanConfigUpdate(daemon, req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON' }, 400);
  }

  try {
    const saved = saveScanConfig(daemon.projectDir, body);
    return jsonResponse(res, saved);
  } catch (err) {
    return jsonResponse(res, { error: 'Failed to save: ' + err.message }, 500);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function safeJsonExtract(metadataStr, key) {
  const parsed = safeJsonParse(metadataStr);
  return parsed?.[key] ?? null;
}
