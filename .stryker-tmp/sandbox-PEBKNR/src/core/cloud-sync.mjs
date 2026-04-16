/**
 * CloudSync — Thin coordinator for cloud synchronisation.
 * Delegates to: sync-state, sync-push, sync-pull, sync-sse, sync-handshake, sync-conflict.
 * New v2 modules: sync/sync-http, sync/sync-handshake, sync/sync-push-optimistic,
 *   sync/sync-pull-cards, sync/sync-conflict (cloud REST client).
 * Cloud unavailability MUST NOT crash the daemon.
 */
// @ts-nocheck

import http from 'node:http';
import https from 'node:https';
import { ensureSyncSchema, getSyncState, setSyncState, recordSyncEvent, getSyncHistory as getSyncHistoryImpl, parseTags, sleep } from './sync-state.mjs';
import { pushMemoriesToCloud, pushInsightsToCloud, pushTasksToCloud, pushDocumentsToCloud } from './sync-push.mjs';
import { createSSEState, startSSE as startSSEImpl, scheduleSSEReconnect, stopSSE } from './sync-sse.mjs';
import { ensureConflictSchema, createLocalConflict } from './sync-conflict.mjs';
// New v2 sync modules
import { createSyncHttp } from './sync/sync-http.mjs';
import { performHandshake } from './sync/sync-handshake.mjs';
import { createOptimisticPusher } from './sync/sync-push-optimistic.mjs';
import { createCardPuller } from './sync/sync-pull-cards.mjs';
import { createConflictHandler } from './sync/sync-conflict.mjs';

const LOG_PREFIX = '[CloudSync]';
const SSE_RECONNECT_BASE_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 60_000;
const DEFAULT_PERIODIC_INTERVAL_MIN = 5;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_POLL_TIMEOUT_SEC = 300;

/** Perform an HTTP(S) request and return { status, headers, body }. */
function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET', headers: opts.headers || {},
      timeout: opts.timeout ?? 15_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Open an SSE connection. Returns { req, res } on success. */
export function openSSEStream(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search, method: 'GET',
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...headers },
    }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(`SSE connection failed: HTTP ${res.statusCode} — ${Buffer.concat(chunks).toString('utf-8').slice(0, 200)}`)));
        return;
      }
      resolve({ req, res });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Parse an SSE buffer into { parsed: Array<{ event, data }>, remainder }. */
export function parseSSE(buffer) {
  const parsed = [];
  const blocks = buffer.split('\n\n');
  const remainder = blocks.pop() || '';
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) parsed.push({ event, data });
  }
  return { parsed, remainder };
}

export class CloudSync {
  constructor(config, indexer, memoryStore) {
    this.config = config;
    this.apiBase = config.cloud?.api_base || 'https://awareness.market/api/v1';
    this.apiKey = config.cloud?.api_key || '';
    this.memoryId = config.cloud?.memory_id || '';
    this.deviceId = config.device?.id || 'unknown-device';
    this.indexer = indexer;
    this.memoryStore = memoryStore;
    this._sseState = createSSEState();
    this._periodicTimer = null;
    ensureSyncSchema(indexer);
    ensureConflictSchema(indexer);

    // v2 sync modules — injectable HTTP client + sub-handlers
    this._syncHttp = createSyncHttp({
      apiBase: this.apiBase,
      apiKey: this.apiKey,
      deviceId: this.deviceId,
    });
    this._optimisticPusher = createOptimisticPusher({
      http: this._syncHttp,
      memoryId: this.memoryId,
      deviceId: this.deviceId,
    });
    this._cardPuller = createCardPuller({
      http: this._syncHttp,
      memoryId: this.memoryId,
      deviceId: this.deviceId,
      applyCard: (card) => this._applyPulledCard(card),
    });
    this._conflictHandler = createConflictHandler({
      http: this._syncHttp,
      memoryId: this.memoryId,
      deviceId: this.deviceId,
    });
  }

  _buildCtx() {
    return {
      indexer: this.indexer, memoryStore: this.memoryStore,
      apiBase: this.apiBase, apiKey: this.apiKey,
      memoryId: this.memoryId, deviceId: this.deviceId, config: this.config,
      httpGet: (ep) => this._get(ep),
      httpPost: (ep, d) => this._post(ep, d),
      authHeaders: () => this._authHeaders(),
      getSyncState: (k) => getSyncState(this.indexer, k),
      setSyncState: (k, v) => setSyncState(this.indexer, k, v),
      recordSyncEvent: (t, d) => recordSyncEvent(this.indexer, t, d),
      parseTags,
    };
  }

  isEnabled() {
    return !!(this.config.cloud?.enabled && this.apiKey && this.memoryId);
  }

  async initAuth() {
    try {
      return await this._post('/auth/device/init', {
        device_id: this.deviceId, device_name: this.config.device?.name || 'Awareness Local',
      });
    } catch (err) { console.error(`${LOG_PREFIX} initAuth failed:`, err.message); return null; }
  }

  async pollAuth(deviceCode, interval = DEFAULT_POLL_INTERVAL_SEC, timeout = DEFAULT_POLL_TIMEOUT_SEC) {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      try {
        const result = await this._post('/auth/device/poll', { device_code: deviceCode });
        if (result?.api_key) return result;
        if (result?.status === 'pending') { await sleep(interval * 1000); continue; }
        if (result?.status === 'denied' || result?.error) {
          console.error(`${LOG_PREFIX} pollAuth denied:`, result.error || 'User denied');
          return null;
        }
      } catch (err) { console.warn(`${LOG_PREFIX} pollAuth error (retrying):`, err.message); }
      await sleep(interval * 1000);
    }
    console.warn(`${LOG_PREFIX} pollAuth timed out after ${timeout}s`);
    return null;
  }

  async syncToCloud() {
    if (!this.isEnabled()) return { synced: 0, errors: 0 };
    return pushMemoriesToCloud(this._buildCtx());
  }

  async syncInsightsToCloud() {
    if (!this.isEnabled()) return { synced: 0, errors: 0 };
    return pushInsightsToCloud({ ...this._buildCtx(), httpPostRaw: (ep, d, extra) => this._postRaw(ep, d, extra) });
  }

  async syncTasksToCloud() {
    if (!this.isEnabled()) return { synced: 0, errors: 0 };
    return pushTasksToCloud(this._buildCtx());
  }

  async syncDocumentsToCloud() {
    if (!this.isEnabled()) return { synced: 0, skipped: 0, errors: 0 };
    return pushDocumentsToCloud(this._buildCtx());
  }

  async pullFromCloud() {
    if (!this.isEnabled()) return { pulled: 0 };
    let pulled = 0;
    try {
      const cursor = getSyncState(this.indexer, 'pull_cursor') || '';
      const qs = new URLSearchParams({ limit: '50' });
      if (cursor) qs.set('cursor', cursor);
      const result = await this._get(`/memories/${this.memoryId}/content?${qs.toString()}`);
      const items = Array.isArray(result) ? result : (result?.items || []);
      if (!items.length) return { pulled: 0 };
      for (const item of items) {
        const itemDeviceId = item.metadata?.device_id || item.device_id;
        if (itemDeviceId === this.deviceId) continue;
        if (getSyncState(this.indexer, `cloud_id_reverse:${item.id}`)) continue;
        try { await this._pullSingleItem(item); pulled++; } catch (err) {
          console.warn(`${LOG_PREFIX} Failed to pull item ${item.id}:`, err.message);
        }
      }
      if (result.next_cursor) setSyncState(this.indexer, 'pull_cursor', result.next_cursor);
      if (pulled > 0) {
        console.log(`${LOG_PREFIX} Pulled ${pulled} memories from cloud`);
        recordSyncEvent(this.indexer, 'memories', { count: pulled, direction: 'pull' });
      }
    } catch (err) { console.error(`${LOG_PREFIX} pullFromCloud failed:`, err.message); }
    return { pulled };
  }

  async fullSync() {
    // v2: Handshake → Pull → Push order
    let hs;
    try {
      hs = await performHandshake(this._syncHttp);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Handshake failed:`, err.message);
      hs = { ok: false, compatible: false };
    }
    if (!hs.compatible) {
      console.warn(`${LOG_PREFIX} fullSync aborted — incompatible schema`);
      return { pushed: 0, insights_pushed: 0, tasks_pushed: 0, pulled: 0 };
    }

    // Pull cards since last checkpoint
    let pullResult = { pulled: 0 };
    try {
      const lastPulledAt = getSyncState(this.indexer, 'cards_last_pulled_at') || null;
      pullResult = await this._cardPuller.pullCardsSince(lastPulledAt);
      if (pullResult.pulled > 0) {
        setSyncState(this.indexer, 'cards_last_pulled_at', new Date().toISOString());
        recordSyncEvent(this.indexer, 'cards', { count: pullResult.pulled, direction: 'pull' });
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Card pull failed:`, err.message);
    }

    // Push memories (bulk), cards (v2 optimistic), tasks (bulk), skills, documents
    const pushResult = await this.syncToCloud();
    const cardsResult = await this._pushCardsV2();
    const tasksResult = await this.syncTasksToCloud();
    const skillsResult = await this._syncSkills();
    const risksResult = await this._pullRisks();
    let docsResult = { synced: 0 };
    try { docsResult = await this.syncDocumentsToCloud(); } catch { /* non-fatal */ }
    return {
      pushed: pushResult.synced, insights_pushed: cardsResult.synced,
      tasks_pushed: tasksResult.synced, skills_synced: skillsResult.synced,
      docs_pushed: docsResult.synced, risks_pulled: risksResult.pulled,
      pulled: pullResult.pulled, conflicts: cardsResult.conflicts || 0,
    };
  }

  async startSSE() {
    if (!this.isEnabled()) return;
    await startSSEImpl({
      ...this._buildCtx(), handleSSEEvent: (ev) => this._handleSSEEvent(ev),
      openSSEStream, parseSSE,
    }, this._sseState);
  }

  startPeriodicSync(intervalMin = DEFAULT_PERIODIC_INTERVAL_MIN) {
    if (intervalMin <= 0) return;
    this._periodicTimer = setInterval(async () => {
      try {
        const r = await this.fullSync();
        if (r.pushed > 0 || r.pulled > 0 || r.insights_pushed > 0 || r.tasks_pushed > 0) {
          console.log(`${LOG_PREFIX} Periodic sync: memories=${r.pushed}, insights=${r.insights_pushed}, tasks=${r.tasks_pushed}, pulled=${r.pulled}`);
        }
      } catch (err) { console.warn(`${LOG_PREFIX} Periodic sync failed:`, err.message); }
    }, intervalMin * 60 * 1000);
  }

  async start() {
    if (!this.isEnabled()) {
      console.log(`${LOG_PREFIX} Cloud sync disabled (missing credentials or not enabled)`);
      return;
    }
    console.log(`${LOG_PREFIX} Starting cloud sync...`);
    // Initial sync uses v2 flow: Handshake → Pull → Push
    try { await this.fullSync(); } catch (err) {
      console.warn(`${LOG_PREFIX} Initial sync failed (will retry):`, err.message);
    }
    this.startSSE();
    const intervalMin = this.config.cloud?.sync_interval_min || DEFAULT_PERIODIC_INTERVAL_MIN;
    this.startPeriodicSync(intervalMin);
    console.log(`${LOG_PREFIX} Started: SSE + periodic sync (${intervalMin}min) enabled`);
  }

  stop() {
    stopSSE(this._sseState);
    if (this._periodicTimer) { clearInterval(this._periodicTimer); this._periodicTimer = null; }
    console.log(`${LOG_PREFIX} Stopped`);
  }

  getSyncHistory(limit = 20) { return getSyncHistoryImpl(this.indexer, limit); }

  // --- SSE event handling ---

  async _handleSSEEvent(sseEvent) {
    let data;
    try { data = JSON.parse(sseEvent.data); } catch { return; }
    switch (sseEvent.event) {
      case 'memory_created': case 'memory_updated': {
        if (data.device_id === this.deviceId) return;
        if (getSyncState(this.indexer, `cloud_id_reverse:${data.id}`)) return;
        try {
          await this._pullSingleItem(data);
          console.log(`${LOG_PREFIX} SSE received: ${data.title || data.id} (from ${data.source || 'cloud'})`);
        } catch (err) { console.warn(`${LOG_PREFIX} SSE pull failed for ${data.id}:`, err.message); }
        break;
      }
      case 'knowledge_extracted': case 'insight_submitted': {
        if (data.device_id === this.deviceId) return;
        try { await this._pullKnowledgeCard(data); } catch (err) { console.warn(`${LOG_PREFIX} SSE knowledge pull failed:`, err.message); }
        break;
      }
      case 'task_created': case 'task_updated': {
        if (data.device_id === this.deviceId) return;
        try { await this._pullTask(data); } catch (err) { console.warn(`${LOG_PREFIX} SSE task pull failed:`, err.message); }
        break;
      }
      case 'heartbeat': break;
      default: break;
    }
  }

  // --- Legacy pull helpers (kept for SSE backward compat) ---

  async _pullSingleItem(item) {
    let content = item.content, eventType = item.event_type || item.type || 'turn_summary';
    let tags = item.metadata?.tags || item.tags || [];
    let agentRole = item.metadata?.agent_role || item.agent_role;
    let source = item.metadata?.source || item.source || 'cloud-pull';
    if (!content && item.id) {
      const d = await this._get(`/memories/${this.memoryId}/content/${item.id}`);
      if (!d) return;
      content = d.content || ''; eventType = d.event_type || eventType;
      tags = d.metadata?.tags || tags; agentRole = d.metadata?.agent_role || agentRole;
      source = d.metadata?.source || source;
    }
    if (!content) return;
    const tagsArr = Array.isArray(tags) ? tags : [];
    const { id, filepath } = await this.memoryStore.write({
      type: eventType, content, title: item.title || '', tags: tagsArr,
      agent_role: agentRole, session_id: item.session_id || '', source,
    });
    this.indexer.indexMemory(id, {
      type: eventType, title: item.title || '', tags: tagsArr,
      agent_role: agentRole, session_id: item.session_id || '', source, filepath, synced_to_cloud: true,
    }, content);
    this.indexer.db.prepare('UPDATE memories SET synced_to_cloud = 1 WHERE id = ?').run(id);
    if (item.id) {
      setSyncState(this.indexer, `cloud_id:${id}`, item.id);
      setSyncState(this.indexer, `cloud_id_reverse:${item.id}`, id);
    }
  }

  async _pullKnowledgeCard(data) {
    if (!data.title || !data.category) return;
    if (getSyncState(this.indexer, `cloud_kc:${data.id}`)) return;
    const kcId = `kc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const tags = Array.isArray(data.tags) ? data.tags : [];
    const localParentId = data.parent_card_id
      ? (getSyncState(this.indexer, `cloud_kc:${data.parent_card_id}`) || null) : null;
    if (localParentId && (data.evolution_type === 'update' || data.evolution_type === 'reversal')) {
      try { this.indexer.db.prepare("UPDATE knowledge_cards SET status = 'superseded' WHERE id = ? AND status = 'active'").run(localParentId); } catch { /* ok */ }
    }
    try {
      this.indexer.db.prepare(
        `INSERT OR IGNORE INTO knowledge_cards (id, category, title, summary, source_memories, confidence,
         status, tags, parent_card_id, evolution_type, created_at, filepath, synced_to_cloud)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(kcId, data.category, data.title, data.summary || '',
        JSON.stringify(data.source_memories || []), data.confidence || 0.8,
        data.status || 'active', JSON.stringify(tags), localParentId,
        data.evolution_type || 'initial', new Date().toISOString(), `cloud-pull:${data.id}`);
      setSyncState(this.indexer, `cloud_kc:${data.id}`, kcId);
      setSyncState(this.indexer, `local_kc_to_cloud:${kcId}`, data.id);
    } catch (err) { if (!err.message?.includes('UNIQUE')) throw err; }
  }

  async _pullTask(data) {
    if (!data.title) return;
    const existing = getSyncState(this.indexer, `cloud_task:${data.id}`);
    if (existing) {
      try { this.indexer.db.prepare('UPDATE tasks SET status = ?, priority = ?, updated_at = ? WHERE id = ?')
        .run(data.status || 'open', data.priority || 'medium', new Date().toISOString(), existing); } catch { /* ok */ }
      return;
    }
    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    try {
      this.indexer.db.prepare(
        `INSERT OR IGNORE INTO tasks (id, title, description, status, priority, agent_role,
         created_at, updated_at, filepath, synced_to_cloud) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(taskId, data.title, data.detail || data.description || '',
        data.status || 'open', data.priority || 'medium', data.agent_role || '', now, now, `cloud-pull:${data.id}`);
      setSyncState(this.indexer, `cloud_task:${data.id}`, taskId);
    } catch (err) { if (!err.message?.includes('UNIQUE')) throw err; }
  }

  // --- v2 card-level push with optimistic locking ---

  /**
   * Push unsynced knowledge_cards one by one via optimistic locking.
   * On success: updates local version + cloud_id.
   * On 409 conflict: records local conflict record.
   */
  async _pushCardsV2() {
    if (!this.isEnabled()) return { synced: 0, errors: 0, conflicts: 0 };
    let cards;
    try {
      cards = this.indexer.db.prepare(
        `SELECT id, category, title, summary, confidence, status, tags,
                source_memories, parent_card_id, evolution_type,
                cloud_id, version, schema_version, local_id,
                COALESCE(recall_count, 0) AS recall_count
         FROM knowledge_cards
         WHERE synced_to_cloud = 0 AND status IN ('active', 'superseded')
         ORDER BY created_at ASC`
      ).all();
    } catch (err) {
      console.warn(`${LOG_PREFIX} _pushCardsV2 query failed:`, err.message);
      return { synced: 0, errors: 0, conflicts: 0 };
    }
    if (!cards.length) return { synced: 0, errors: 0, conflicts: 0 };

    let synced = 0, errors = 0, conflicts = 0;
    for (const card of cards) {
      // Skip superseded cards — just mark as synced
      if (card.status === 'superseded') {
        try { this.indexer.db.prepare('UPDATE knowledge_cards SET synced_to_cloud = 1 WHERE id = ?').run(card.id); } catch { /* ok */ }
        continue;
      }
      const pushCard = {
        title: card.title || '', summary: card.summary || '',
        category: card.category || 'key_point', status: card.status || 'active',
        confidence: card.confidence ?? 0.7, tags: card.tags || '[]',
        local_id: card.local_id || card.id,
        version: card.version || 1, schema_version: card.schema_version || 1,
        recall_count: card.recall_count || 0,
      };
      if (card.cloud_id) pushCard.id = card.cloud_id;

      const result = await this._optimisticPusher.pushCardWithVersion(pushCard);

      if (result.status === 'created' || result.status === 'updated') {
        try {
          this.indexer.db.prepare(
            `UPDATE knowledge_cards SET synced_to_cloud = 1, version = ?, cloud_id = ?,
             last_pushed_at = ?, sync_status = 'synced' WHERE id = ?`
          ).run(result.version, result.card_id, new Date().toISOString(), card.id);
          if (result.card_id) {
            setSyncState(this.indexer, `cloud_kc:${result.card_id}`, card.id);
            setSyncState(this.indexer, `local_kc_to_cloud:${card.id}`, result.card_id);
          }
        } catch (err) { console.warn(`${LOG_PREFIX} Failed to update local card after push:`, err.message); }
        synced++;
      } else if (result.status === 'conflict') {
        conflicts++;
        createLocalConflict(this.indexer, {
          card_id: card.id,
          local_version: JSON.stringify(pushCard),
          cloud_version: JSON.stringify(result.detail || {}),
          device_id: this.deviceId,
          conflict_type: 'version_mismatch',
        });
      } else {
        errors++;
        console.warn(`${LOG_PREFIX} Card push failed for ${card.id}: ${result.error || 'unknown'}`);
      }
    }
    if (synced > 0 || conflicts > 0) {
      recordSyncEvent(this.indexer, 'cards', { count: synced, direction: 'push', conflicts });
      console.log(`${LOG_PREFIX} Pushed ${synced} cards (v2), ${conflicts} conflicts, ${errors} errors`);
    }
    return { synced, errors, conflicts };
  }

  // --- v2 card-level pull bridge ---

  /** Callback for createCardPuller.applyCard — writes pulled card to local SQLite. */
  async _applyPulledCard(card) {
    if (!card || !card.id) return 'skipped';
    // Check if we already have this cloud card locally
    const existingLocalId = getSyncState(this.indexer, `cloud_kc:${card.id}`);
    if (existingLocalId) {
      // Update existing local card
      try {
        // F-038 T-005.5: recall_count uses MAX(local, cloud) to avoid losing counts
        this.indexer.db.prepare(
          `UPDATE knowledge_cards SET title = ?, summary = ?, category = ?, status = ?,
           confidence = ?, tags = ?, version = ?, schema_version = ?, cloud_id = ?,
           growth_stage = ?, last_pulled_at = ?, sync_status = 'synced',
           recall_count = MAX(COALESCE(recall_count, 0), ?)
           WHERE id = ?`
        ).run(
          card.title || '', card.summary || '', card.category || 'key_point',
          card.status || 'active', card.confidence || 0.7,
          typeof card.tags === 'string' ? card.tags : JSON.stringify(card.tags || []),
          card.version || 1, card.schema_version || 1, card.id,
          card.growth_stage || 'seedling',
          new Date().toISOString(),
          card.recall_count || 0, existingLocalId,
        );
        return 'updated';
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to update local card ${existingLocalId}:`, err.message);
        return 'skipped';
      }
    }
    // Insert new local card
    const localId = `kc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const tags = typeof card.tags === 'string' ? card.tags : JSON.stringify(card.tags || []);
    const now = new Date().toISOString();
    try {
      this.indexer.db.prepare(
        `INSERT OR IGNORE INTO knowledge_cards (id, category, title, summary, source_memories, confidence,
         status, tags, parent_card_id, evolution_type, created_at, filepath, synced_to_cloud,
         cloud_id, version, schema_version, last_pulled_at, sync_status, growth_stage, recall_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'synced', ?, ?)`
      ).run(
        localId, card.category || 'key_point', card.title || '', card.summary || '',
        JSON.stringify(card.source_memories || []), card.confidence || 0.7,
        card.status || 'active', tags, null, 'initial', now,
        `cloud-pull:${card.id}`, card.id, card.version || 1, card.schema_version || 1, now,
        card.growth_stage || 'seedling', card.recall_count || 0,
      );
      setSyncState(this.indexer, `cloud_kc:${card.id}`, localId);
      setSyncState(this.indexer, `local_kc_to_cloud:${localId}`, card.id);
      return 'inserted';
    } catch (err) {
      if (!err.message?.includes('UNIQUE')) {
        console.warn(`${LOG_PREFIX} Failed to insert card from cloud ${card.id}:`, err.message);
      }
      return 'skipped';
    }
  }

  // --- HTTP helpers ---

  async _get(endpoint) {
    const url = `${this.apiBase}${endpoint}`;
    try {
      const { status, body } = await httpRequest(url, { method: 'GET', headers: this._authHeaders() });
      if (status >= 200 && status < 300) return JSON.parse(body);
      console.warn(`${LOG_PREFIX} GET ${endpoint} → HTTP ${status}`);
      return null;
    } catch (err) { console.warn(`${LOG_PREFIX} GET ${endpoint} failed:`, err.message); return null; }
  }

  async _post(endpoint, data) {
    const url = `${this.apiBase}${endpoint}`;
    const jsonBody = JSON.stringify(data);
    try {
      const { status, body } = await httpRequest(url, {
        method: 'POST', body: jsonBody,
        headers: { ...this._authHeaders(), 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(jsonBody)) },
      });
      if (status >= 200 && status < 300) return JSON.parse(body);
      console.warn(`${LOG_PREFIX} POST ${endpoint} → HTTP ${status}: ${body.slice(0, 200)}`);
      return null;
    } catch (err) { console.warn(`${LOG_PREFIX} POST ${endpoint} failed:`, err.message); return null; }
  }

  async _postRaw(endpoint, data, extraHeaders = {}) {
    const url = `${this.apiBase}${endpoint}`;
    const jsonBody = JSON.stringify(data);
    return httpRequest(url, {
      method: 'POST', body: jsonBody,
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(jsonBody)), ...extraHeaders },
    });
  }

  _authHeaders() {
    return { Authorization: `Bearer ${this.apiKey}`, 'X-Awareness-Device-Id': this.deviceId };
  }

  // -----------------------------------------------------------------------
  // Risks pull — cloud risks → local knowledge_cards with category='risk'
  // -----------------------------------------------------------------------

  async _pullRisks() {
    if (!this.isEnabled() || !this.memoryId) return { pulled: 0 };
    let pulled = 0;

    try {
      const url = `${this.apiBase}/memories/${this.memoryId}/insights/risks?limit=100`;
      const resp = await httpRequest(url, { method: 'GET', headers: this._authHeaders() });

      if (resp.status !== 200) return { pulled: 0 };

      const cloudRisks = JSON.parse(resp.body);
      const items = cloudRisks.items || cloudRisks.risks || cloudRisks || [];

      for (const risk of items) {
        if (!risk.id || !risk.title) continue;

        // Store as knowledge card with category='risk' (local convention)
        const localId = `risk_${risk.id}`;
        const existing = this.indexer.db.prepare(
          "SELECT id FROM knowledge_cards WHERE id = ? OR cloud_id = ?"
        ).get(localId, risk.id);

        if (!existing) {
          try {
            this.indexer.indexKnowledgeCard({
              id: localId,
              category: 'risk',
              title: risk.title,
              summary: [risk.detail, risk.mitigation].filter(Boolean).join('\n\nMitigation: ') || '',
              confidence: 0.8,
              status: risk.status === 'resolved' ? 'superseded' : 'active',
              tags: JSON.stringify([risk.level || 'medium']),
              source_memories: JSON.stringify([]),
              card_type: 'atomic',
              growth_stage: 'seedling',
              created_at: risk.created_at || new Date().toISOString(),
              filepath: `__cloud_risk__/${localId}`,
              cloud_id: risk.id,
              sync_status: 'synced',
              last_pulled_at: new Date().toISOString(),
            });
            pulled++;
          } catch { /* skip duplicates */ }
        }
      }

      if (pulled > 0) {
        recordSyncEvent(this.indexer, 'risks', { count: pulled, direction: 'pull' });
        console.log(`${LOG_PREFIX} Pulled ${pulled} risks from cloud`);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Risks pull failed (non-fatal):`, err.message);
    }

    return { pulled };
  }

  // -----------------------------------------------------------------------
  // Skills sync — bidirectional push/pull
  // -----------------------------------------------------------------------

  /**
   * Sync skills between local SQLite and cloud REST API.
   * Push: local skills not yet in cloud → POST /skills (via submit_insights)
   * Pull: cloud skills not in local → INSERT into local skills table
   */
  async _syncSkills() {
    if (!this.isEnabled() || !this.memoryId) return { synced: 0, pulled: 0 };

    let synced = 0;
    let pulled = 0;

    try {
      // ── Pull: fetch cloud skills and merge into local ──
      const pullUrl = `${this.apiBase}/memories/${this.memoryId}/skills?limit=200`;
      const pullResp = await httpRequest(pullUrl, {
        method: 'GET',
        headers: this._authHeaders(),
      });

      if (pullResp.status === 200) {
        const cloudSkills = JSON.parse(pullResp.body);
        const items = cloudSkills.items || cloudSkills.skills || (Array.isArray(cloudSkills) ? cloudSkills : []);
        console.log(`${LOG_PREFIX} Skills pull: got ${items.length} cloud skills`);

        for (const cs of items) {
          if (!cs.id || !cs.name) continue;
          // Check if we already have this skill locally (by name dedup)
          const existing = this.indexer.db.prepare(
            "SELECT id FROM skills WHERE name = ? OR id = ?"
          ).get(cs.name, cs.id);

          if (!existing) {
            // Insert cloud skill into local
            const now = new Date().toISOString();
            try {
              this.indexer.db.prepare(
                `INSERT INTO skills (id, memory_id, name, summary, methods, trigger_conditions, tags,
                  source_card_ids, decay_score, usage_count, last_used_at, pinned, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).run(
                cs.id,
                this.memoryId,
                cs.name || '',
                cs.summary || '',
                JSON.stringify(cs.methods || []),
                JSON.stringify(cs.trigger_conditions || []),
                JSON.stringify(cs.tags || []),
                JSON.stringify(cs.source_card_ids || []),
                cs.decay_score ?? 1.0,
                cs.usage_count ?? 0,
                cs.last_used_at || null,
                cs.pinned ? 1 : 0,
                cs.status || 'active',
                cs.created_at || now,
                cs.updated_at || now,
              );
              pulled++;
            } catch (insertErr) {
              console.warn(`${LOG_PREFIX} Skills insert failed for "${cs.name}":`, insertErr.message);
            }
          }
        }

        if (pulled > 0) {
          recordSyncEvent(this.indexer, 'skills', { count: pulled, direction: 'pull' });
          console.log(`${LOG_PREFIX} Pulled ${pulled} skills from cloud`);
        }
      }

      // ── Push: local skills not yet synced to cloud ──
      // Use submit_insights endpoint with skills[] payload (same as F-034 flow)
      let localSkills;
      try {
        localSkills = this.indexer.db.prepare(
          "SELECT * FROM skills WHERE status = 'active' AND (synced_to_cloud IS NULL OR synced_to_cloud = 0)"
        ).all();
      } catch {
        // synced_to_cloud column may not exist — try without filter
        try {
          localSkills = this.indexer.db.prepare(
            "SELECT * FROM skills WHERE status = 'active'"
          ).all();
        } catch { localSkills = []; }
      }

      for (const ls of localSkills) {
        // Check if cloud already has this skill (by name)
        const checkUrl = `${this.apiBase}/memories/${this.memoryId}/skills?limit=1&search=${encodeURIComponent(ls.name)}`;
        try {
          const checkResp = await httpRequest(checkUrl, { method: 'GET', headers: this._authHeaders() });
          if (checkResp.status === 200) {
            const existing = JSON.parse(checkResp.body);
            const items = existing.items || existing.skills || (Array.isArray(existing) ? existing : []);
            if (items.some(s => s.name === ls.name)) {
              // Already exists in cloud, skip push
              continue;
            }
          }
        } catch { /* check failed, try push anyway */ }

        // Push via insights submit
        const pushUrl = `${this.apiBase}/memories/${this.memoryId}/insights/submit`;
        let methods;
        try { methods = JSON.parse(ls.methods || '[]'); } catch { methods = []; }
        let tags;
        try { tags = JSON.parse(ls.tags || '[]'); } catch { tags = []; }

        const pushBody = {
          skills: [{
            name: ls.name || '',
            summary: ls.summary || '',
            methods: Array.isArray(methods) ? methods : [],
            tags: Array.isArray(tags) ? tags : [],
          }],
        };

        try {
          const pushResp = await this._cloudPost(pushUrl, pushBody);
          if (pushResp.status === 200 || pushResp.status === 201) {
            synced++;
          }
        } catch { /* push failed, will retry next cycle */ }
      }

      if (synced > 0) {
        recordSyncEvent(this.indexer, 'skills', { count: synced, direction: 'push' });
        console.log(`${LOG_PREFIX} Pushed ${synced} skills to cloud`);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Skills sync failed (non-fatal):`, err.message);
    }

    return { synced, pulled };
  }
}
