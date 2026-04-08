import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { jsonResponse, nowISO, readBody } from './helpers.mjs';

export async function handleApiRoute(daemon, req, res, url) {
  const route = url.pathname.replace('/api/v1', '');

  if (route === '/stats' && req.method === 'GET') {
    const stats = daemon.indexer ? daemon.indexer.getStats() : {};
    return jsonResponse(res, stats);
  }

  if (route === '/memories' && req.method === 'GET') {
    return apiListMemories(daemon, req, res, url);
  }

  if (route === '/memories/search' && req.method === 'GET') {
    return apiSearchMemories(daemon, req, res, url);
  }

  if (route === '/knowledge' && req.method === 'GET') {
    return apiListKnowledge(daemon, req, res, url);
  }

  if (route.startsWith('/knowledge/') && route.endsWith('/evolution') && req.method === 'GET') {
    const cardId = decodeURIComponent(route.replace('/knowledge/', '').replace('/evolution', ''));
    return apiGetEvolutionChain(daemon, req, res, cardId);
  }

  if (route === '/knowledge/cleanup' && req.method === 'DELETE') {
    return apiCleanupKnowledge(daemon, req, res);
  }

  if (route === '/tasks' && req.method === 'GET') {
    return apiListTasks(daemon, req, res, url);
  }

  if (route.startsWith('/tasks/') && req.method === 'PUT') {
    const taskId = decodeURIComponent(route.replace('/tasks/', ''));
    return apiUpdateTask(daemon, req, res, taskId);
  }

  if (route === '/sync/status' && req.method === 'GET') {
    return apiSyncStatus(daemon, req, res);
  }

  if (route === '/workspaces' && req.method === 'GET') {
    return apiWorkspaces(res);
  }

  if (route === '/config' && req.method === 'GET') {
    return apiGetConfig(daemon, req, res);
  }

  if (route === '/config' && req.method === 'PUT') {
    return apiUpdateConfig(daemon, req, res);
  }

  if (route === '/cloud/auth/start' && req.method === 'POST') {
    return apiCloudAuthStart(daemon, req, res);
  }

  if (route === '/cloud/auth/poll' && req.method === 'POST') {
    return apiCloudAuthPoll(daemon, req, res);
  }

  if (route === '/cloud/auth/open-browser' && req.method === 'POST') {
    return apiCloudAuthOpenBrowser(daemon, req, res);
  }

  if (route.startsWith('/cloud/memories') && req.method === 'GET') {
    return apiCloudListMemories(daemon, req, res, url);
  }

  if (route === '/cloud/connect' && req.method === 'POST') {
    return apiCloudConnect(daemon, req, res);
  }

  if (route === '/cloud/disconnect' && req.method === 'POST') {
    return apiCloudDisconnect(daemon, req, res);
  }

  return jsonResponse(res, { error: 'Not found', route }, 404);
}

export function apiListMemories(daemon, _req, res, url) {
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const sourceFilter = url.searchParams.get('source') || null;
  const sourceExclude = url.searchParams.get('source_exclude') || null;

  if (!daemon.indexer) {
    return jsonResponse(res, { items: [], total: 0 });
  }

  const conditions = [`status = 'active'`];
  const params = [];

  if (sourceFilter) {
    conditions.push(`source = ?`);
    params.push(sourceFilter);
  } else if (sourceExclude) {
    conditions.push(`source != ?`);
    params.push(sourceExclude);
  }

  const whereClause = conditions.join(' AND ');

  const rows = daemon.indexer.db
    .prepare(
      `SELECT m.*, f.content AS fts_content
       FROM memories m
       LEFT JOIN memories_fts f ON f.id = m.id
       WHERE ${whereClause}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = daemon.indexer.db
    .prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereClause}`)
    .all(...params)[0]?.c ?? 0;

  return jsonResponse(res, { items: rows, total, limit, offset });
}

export function apiSearchMemories(daemon, _req, res, url) {
  const q = url.searchParams.get('q') || '';
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);

  if (!q || !daemon.indexer) {
    return jsonResponse(res, { items: [], total: 0, query: q });
  }

  const results = daemon.indexer.search(q, { limit });
  return jsonResponse(res, { items: results, total: results.length, query: q });
}

export function apiListKnowledge(daemon, _req, res, url) {
  const category = url.searchParams.get('category') || null;
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  if (!daemon.indexer) {
    return jsonResponse(res, { items: [], total: 0 });
  }

  let sql = `SELECT * FROM knowledge_cards WHERE status = 'active'`;
  const params = [];

  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = daemon.indexer.db.prepare(sql).all(...params);
  return jsonResponse(res, { items: rows, total: rows.length });
}

export function apiGetEvolutionChain(daemon, _req, res, cardId) {
  if (!daemon.indexer?.getEvolutionChain) {
    return jsonResponse(res, { card_id: cardId, chain_length: 0, evolution_chain: [] });
  }
  const chain = daemon.indexer.getEvolutionChain(cardId);
  return jsonResponse(res, {
    card_id: cardId,
    chain_length: chain.length,
    evolution_chain: chain,
  });
}

export async function apiCleanupKnowledge(daemon, req, res) {
  if (!daemon.indexer) {
    return jsonResponse(res, { deleted: 0 });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON body' }, 400);
  }

  const patterns = body?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return jsonResponse(res, { error: 'patterns must be a non-empty array of regex strings' }, 400);
  }

  let regexes;
  try {
    regexes = patterns.map((pattern) => new RegExp(pattern));
  } catch (err) {
    return jsonResponse(res, { error: `Invalid regex: ${err.message}` }, 400);
  }

  const allCards = daemon.indexer.db
    .prepare("SELECT id, title, filepath FROM knowledge_cards WHERE status = 'active'")
    .all();

  const toDelete = allCards.filter((card) => regexes.some((regex) => regex.test(card.title)));

  if (toDelete.length === 0) {
    return jsonResponse(res, { deleted: 0 });
  }

  const deleteCard = daemon.indexer.db.prepare('DELETE FROM knowledge_cards WHERE id = ?');
  const deleteFts = daemon.indexer.db.prepare('DELETE FROM knowledge_fts WHERE id = ?');
  const deleteMany = daemon.indexer.db.transaction((cards) => {
    for (const card of cards) {
      deleteCard.run(card.id);
      deleteFts.run(card.id);
    }
  });
  deleteMany(toDelete);

  for (const card of toDelete) {
    if (card.filepath) {
      try { fs.unlinkSync(card.filepath); } catch { /* file may already be gone */ }
    }
  }

  return jsonResponse(res, { deleted: toDelete.length });
}

export function apiListTasks(daemon, _req, res, url) {
  const status = url.searchParams.get('status') || null;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 0;

  if (!daemon.indexer) {
    return jsonResponse(res, { items: [], total: 0 });
  }

  let sql = `SELECT * FROM tasks`;
  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ` ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at DESC`;
  if (limit > 0) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }

  const rows = daemon.indexer.db.prepare(sql).all(...params);
  return jsonResponse(res, { items: rows, total: rows.length });
}

export async function apiUpdateTask(daemon, req, res, taskId) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON' }, 400);
  }

  if (!daemon.indexer) {
    return jsonResponse(res, { error: 'Indexer not available' }, 503);
  }

  const task = daemon.indexer.db
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(taskId);

  if (!task) {
    return jsonResponse(res, { error: 'Task not found' }, 404);
  }

  const newStatus = payload.status || task.status;
  const newPriority = payload.priority || task.priority;

  daemon.indexer.indexTask({
    ...task,
    status: newStatus,
    priority: newPriority,
    updated_at: nowISO(),
  });

  return jsonResponse(res, {
    status: 'ok',
    task_id: taskId,
    new_status: newStatus,
  });
}

export function apiSyncStatus(daemon, _req, res) {
  const config = daemon._loadConfig();
  const cloud = config.cloud || {};
  const history = daemon.cloudSync ? daemon.cloudSync.getSyncHistory() : [];

  return jsonResponse(res, {
    cloud_enabled: !!cloud.enabled,
    api_base: cloud.api_base || null,
    memory_id: cloud.memory_id || null,
    memory_name: cloud.memory_name || null,
    auto_sync: cloud.auto_sync ?? true,
    last_push_at: cloud.last_push_at || null,
    last_pull_at: cloud.last_pull_at || null,
    history,
  });
}

export async function apiWorkspaces(res) {
  try {
    const { loadWorkspaces } = await import('../core/config.mjs');
    const ws = loadWorkspaces();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ws));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
}

export function apiGetConfig(daemon, _req, res) {
  const config = daemon._loadConfig();
  if (config.cloud && config.cloud.api_key) {
    const key = config.cloud.api_key;
    config.cloud.api_key = key.length > 8
      ? key.slice(0, 4) + '...' + key.slice(-4)
      : '****';
  }
  return jsonResponse(res, config);
}

export async function apiUpdateConfig(daemon, req, res) {
  const body = await readBody(req);
  let patch;
  try {
    patch = JSON.parse(body);
  } catch {
    return jsonResponse(res, { error: 'Invalid JSON' }, 400);
  }

  const configPath = path.join(daemon.awarenessDir, 'config.json');
  const config = daemon._loadConfig();
  const allowedSections = ['daemon', 'embedding', 'cloud', 'git_sync', 'agent', 'extraction'];
  for (const section of allowedSections) {
    if (patch[section] && typeof patch[section] === 'object') {
      config[section] = { ...(config[section] || {}), ...patch[section] };
    }
  }

  try {
    const tmpCfg = configPath + '.tmp';
    fs.writeFileSync(tmpCfg, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpCfg, configPath);
  } catch (err) {
    return jsonResponse(res, { error: 'Failed to save config: ' + err.message }, 500);
  }

  if (config.cloud && config.cloud.api_key) {
    const key = config.cloud.api_key;
    config.cloud.api_key = key.length > 8
      ? key.slice(0, 4) + '...' + key.slice(-4)
      : '****';
  }

  return jsonResponse(res, { status: 'ok', config });
}

export async function apiCloudAuthOpenBrowser(_daemon, req, res) {
  const body = await readBody(req);
  let params;
  try { params = JSON.parse(body); } catch { return jsonResponse(res, { error: 'Invalid JSON' }, 400); }
  const { url: targetUrl } = params;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return jsonResponse(res, { error: 'url required' }, 400);
  }
  if (!targetUrl.startsWith('https://awareness.market/')) {
    return jsonResponse(res, { error: 'URL not allowed' }, 403);
  }
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  execFile(cmd, [targetUrl], (err) => {
    if (err) console.warn('[awareness-local] failed to open browser:', err.message);
  });
  return jsonResponse(res, { status: 'ok' });
}

export async function apiCloudAuthStart(daemon, _req, res) {
  const apiBase = daemon.config?.cloud?.api_base || 'https://awareness.market/api/v1';
  try {
    const data = await daemon._httpJson('POST', `${apiBase}/auth/device/init`, {});
    return jsonResponse(res, data);
  } catch (err) {
    return jsonResponse(res, { error: 'Failed to start auth: ' + err.message }, 502);
  }
}

export async function apiCloudAuthPoll(daemon, req, res) {
  const body = await readBody(req);
  let params;
  try { params = JSON.parse(body); } catch { return jsonResponse(res, { error: 'Invalid JSON' }, 400); }

  const config = daemon._loadConfig();
  const apiBase = config?.cloud?.api_base || 'https://awareness.market/api/v1';
  const interval = Math.max((params.interval || 5) * 1000, 3000);
  const maxPolls = Math.min(Math.floor(30000 / interval), 6);

  for (let i = 0; i < maxPolls; i++) {
    try {
      const data = await daemon._httpJson('POST', `${apiBase}/auth/device/poll`, {
        device_code: params.device_code,
      });
      if (data.status === 'approved' && data.api_key) {
        return jsonResponse(res, { api_key: data.api_key });
      }
      if (data.status === 'expired') {
        return jsonResponse(res, { error: 'Auth expired' }, 410);
      }
    } catch { /* continue polling */ }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return jsonResponse(res, { error: 'Auth timeout' }, 408);
}

export async function apiCloudListMemories(daemon, _req, res, url) {
  const config = daemon._loadConfig();
  const apiKey = url.searchParams.get('api_key') || config?.cloud?.api_key;
  if (!apiKey) {
    return jsonResponse(res, { error: 'Cloud not configured. Connect via /api/v1/cloud/connect first.' }, 400);
  }

  const apiBase = daemon.config?.cloud?.api_base || 'https://awareness.market/api/v1';
  try {
    const data = await daemon._httpJson('GET', `${apiBase}/memories`, null, {
      'Authorization': `Bearer ${apiKey}`,
    });
    return jsonResponse(res, data);
  } catch (err) {
    return jsonResponse(res, { error: 'Failed to list memories: ' + err.message }, 502);
  }
}

export async function apiCloudConnect(daemon, req, res) {
  const body = await readBody(req);
  let params;
  try { params = JSON.parse(body); } catch { return jsonResponse(res, { error: 'Invalid JSON' }, 400); }

  const { api_key, memory_id, memory_name } = params;
  if (!api_key) return jsonResponse(res, { error: 'api_key required' }, 400);

  const configPath = path.join(daemon.awarenessDir, 'config.json');
  const config = daemon._loadConfig();
  config.cloud = {
    ...config.cloud,
    enabled: true,
    api_key,
    memory_id: memory_id || '',
    memory_name: memory_name || '',
    auto_sync: true,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  daemon.config = config;

  if (daemon.cloudSync) {
    daemon.cloudSync.stop();
  }
  try {
    const { CloudSync } = await import('../core/cloud-sync.mjs');
    daemon.cloudSync = new CloudSync(config, daemon.indexer, daemon.memoryStore);
    daemon.cloudSync.start().catch((err) => {
      console.warn('[awareness-local] cloud sync start failed:', err.message);
    });
  } catch { /* CloudSync not available */ }

  return jsonResponse(res, { status: 'ok', cloud_enabled: true });
}

export async function apiCloudDisconnect(daemon, _req, res) {
  const configPath = path.join(daemon.awarenessDir, 'config.json');
  const config = daemon._loadConfig();
  config.cloud = { ...config.cloud, enabled: false, api_key: '', memory_id: '' };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  daemon.config = config;

  if (daemon.cloudSync) {
    daemon.cloudSync.stop();
    daemon.cloudSync = null;
  }

  return jsonResponse(res, { status: 'ok', cloud_enabled: false });
}
