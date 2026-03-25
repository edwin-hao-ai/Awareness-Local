/**
 * CloudSync — Optional cloud synchronisation client for Awareness Local.
 *
 * Implements three-layer sync guarantee:
 *   Layer 1: SSE real-time push (second-level latency)
 *   Layer 2: Incremental pull on awareness_init / daemon start
 *   Layer 3: Periodic polling fallback (minute-level)
 *
 * Uses only Node.js built-in http/https modules — zero external dependencies.
 *
 * Cloud unavailability MUST NOT crash the daemon.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[CloudSync]';
const SSE_RECONNECT_BASE_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 60_000;
const DEFAULT_PERIODIC_INTERVAL_MIN = 5;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_POLL_TIMEOUT_SEC = 300;

// ---------------------------------------------------------------------------
// Helpers — minimal HTTP client using built-in http/https
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP(S) request and return { status, headers, body }.
 * Resolves even on non-2xx so callers can inspect status.
 *
 * @param {string} url    — Full URL
 * @param {object} opts
 * @param {string}   opts.method  — HTTP method
 * @param {object}   opts.headers — Request headers
 * @param {string}  [opts.body]   — JSON string body
 * @param {number}  [opts.timeout=15000]
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
function httpRequest(url, opts = {}) {
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
 * Open an SSE (Server-Sent Events) connection.
 * Returns an object with { req, res } on success; the caller reads `res`.
 * The caller is responsible for destroying `req` to close the connection.
 *
 * @param {string} url
 * @param {object} headers
 * @returns {Promise<{ req: http.ClientRequest, res: http.IncomingMessage }>}
 */
function openSSEStream(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...headers,
      },
    };

    const req = transport.request(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          reject(
            new Error(
              `SSE connection failed: HTTP ${res.statusCode} — ${Buffer.concat(chunks).toString('utf-8').slice(0, 200)}`
            )
          );
        });
        return;
      }
      resolve({ req, res });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse an SSE buffer into discrete events.
 * Returns { parsed: Array<{ event, data }>, remainder: string }.
 *
 * SSE format:
 *   event: <type>\n
 *   data: <payload>\n
 *   \n
 *
 * @param {string} buffer
 * @returns {{ parsed: Array<{ event: string, data: string }>, remainder: string }}
 */
function parseSSE(buffer) {
  const parsed = [];
  // Split on double newline — each block is one event
  const blocks = buffer.split('\n\n');
  // The last element may be an incomplete block
  const remainder = blocks.pop() || '';

  for (const block of blocks) {
    if (!block.trim()) continue;

    let event = 'message';
    let data = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trim();
      } else if (line.startsWith(':')) {
        // Comment line — ignore (often used for keepalive)
      }
    }

    if (data) {
      parsed.push({ event, data });
    }
  }

  return { parsed, remainder };
}

// ---------------------------------------------------------------------------
// CloudSync
// ---------------------------------------------------------------------------

export class CloudSync {
  /**
   * @param {object} config       — Full config from .awareness/config.json
   * @param {object} indexer      — Indexer instance (SQLite access)
   * @param {object} memoryStore  — MemoryStore instance (markdown read/write)
   */
  constructor(config, indexer, memoryStore) {
    this.config = config;
    this.apiBase = config.cloud?.api_base || 'https://awareness.market/api/v1';
    this.apiKey = config.cloud?.api_key || '';
    this.memoryId = config.cloud?.memory_id || '';
    this.deviceId = config.device?.id || 'unknown-device';
    this.indexer = indexer;
    this.memoryStore = memoryStore;

    // SSE connection state
    this._sseReq = null;           // http.ClientRequest — destroy to close
    this._sseReconnectMs = SSE_RECONNECT_BASE_MS;
    this._sseReconnectTimer = null;
    this._sseStopped = false;

    // Periodic sync interval handle
    this._periodicTimer = null;

    // Ensure sync_state table has the columns we need (ALTER is idempotent via IF NOT EXISTS in schema)
    this._ensureSyncSchema();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Whether cloud sync is enabled and has the necessary credentials.
   * @returns {boolean}
   */
  isEnabled() {
    return !!(
      this.config.cloud?.enabled &&
      this.apiKey &&
      this.memoryId
    );
  }

  /**
   * Initiate device-auth flow.
   * POST /auth/device/init
   * @returns {Promise<{ device_code: string, user_code: string, verification_uri: string } | null>}
   */
  async initAuth() {
    try {
      const result = await this._post('/auth/device/init', {
        device_id: this.deviceId,
        device_name: this.config.device?.name || 'Awareness Local',
      });
      return result;
    } catch (err) {
      console.error(`${LOG_PREFIX} initAuth failed:`, err.message);
      return null;
    }
  }

  /**
   * Poll for device-auth completion.
   * POST /auth/device/poll
   *
   * @param {string} deviceCode — The device_code from initAuth()
   * @param {number} [interval=5] — Poll interval in seconds
   * @param {number} [timeout=300] — Total timeout in seconds
   * @returns {Promise<{ api_key: string, memory_id?: string } | null>}
   */
  async pollAuth(deviceCode, interval = DEFAULT_POLL_INTERVAL_SEC, timeout = DEFAULT_POLL_TIMEOUT_SEC) {
    const deadline = Date.now() + timeout * 1000;

    while (Date.now() < deadline) {
      try {
        const result = await this._post('/auth/device/poll', {
          device_code: deviceCode,
        });

        if (result && result.api_key) {
          return result;
        }

        // Not yet approved — wait and retry
        if (result && result.status === 'pending') {
          await this._sleep(interval * 1000);
          continue;
        }

        // Denied or error
        if (result && (result.status === 'denied' || result.error)) {
          console.error(`${LOG_PREFIX} pollAuth denied:`, result.error || 'User denied');
          return null;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} pollAuth error (retrying):`, err.message);
      }

      await this._sleep(interval * 1000);
    }

    console.warn(`${LOG_PREFIX} pollAuth timed out after ${timeout}s`);
    return null;
  }

  /**
   * Push unsynced local memories to the cloud.
   * Finds all memories with synced_to_cloud=0 and POSTs them to /mcp/events.
   *
   * @returns {Promise<{ synced: number, errors: number }>}
   */
  async syncToCloud() {
    if (!this.isEnabled()) return { synced: 0, errors: 0 };

    let synced = 0;
    let errors = 0;

    try {
      const unsynced = this.indexer.db
        .prepare('SELECT * FROM memories WHERE synced_to_cloud = 0 ORDER BY created_at')
        .all();

      if (!unsynced.length) return { synced: 0, errors: 0 };

      for (const memory of unsynced) {
        try {
          // Read the markdown content from disk, strip YAML front matter
          let content = '';
          try {
            const raw = fs.readFileSync(memory.filepath, 'utf-8');
            content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
          } catch {
            // File may have been deleted — skip
            console.warn(`${LOG_PREFIX} File not found, skipping: ${memory.filepath}`);
            errors++;
            continue;
          }

          // Gather local vector if available
          const embedding = this.indexer.db
            .prepare('SELECT vector, model_id FROM embeddings WHERE memory_id = ?')
            .get(memory.id);

          const metadata = {
            local_id: memory.id,
            device_id: this.deviceId,
            agent_role: memory.agent_role,
            tags: this._parseTags(memory.tags),
            source: memory.source || 'awareness-local',
          };

          // Attach local vector for cloud to optionally reuse
          if (embedding) {
            try {
              const floats = new Float32Array(embedding.vector.buffer, embedding.vector.byteOffset, embedding.vector.byteLength / 4);
              metadata.local_vector = Array.from(floats);
              metadata.local_model = embedding.model_id;
              metadata.local_dim = floats.length;
            } catch {
              // Vector decode failed — send without
            }
          }

          const result = await this._post('/mcp/events', {
            memory_id: this.memoryId,
            events: [
              {
                event_type: memory.type,
                content,
                metadata,
              },
            ],
          });

          // Mark as synced
          const cloudId = result?.cloud_id || result?.ids?.[0] || null;
          this.indexer.db
            .prepare(
              'UPDATE memories SET synced_to_cloud = 1 WHERE id = ?'
            )
            .run(memory.id);

          // Store cloud_id mapping in sync_state for reference
          if (cloudId) {
            this._setSyncState(`cloud_id:${memory.id}`, cloudId);
          }

          synced++;
        } catch (err) {
          console.warn(`${LOG_PREFIX} Failed to push memory ${memory.id}:`, err.message);
          errors++;
        }
      }

      if (synced > 0) {
        console.log(`${LOG_PREFIX} Pushed ${synced} memories to cloud` + (errors ? ` (${errors} errors)` : ''));
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} syncToCloud failed:`, err.message);
    }

    if (synced > 0) {
      this._recordSyncEvent('memories', { count: synced, direction: 'push' });
    }

    return { synced, errors };
  }

  /**
   * Pull new memories from the cloud using cursor-based pagination.
   * Excludes items written by this device to prevent loops.
   *
   * @returns {Promise<{ pulled: number }>}
   */
  async pullFromCloud() {
    if (!this.isEnabled()) return { pulled: 0 };

    let pulled = 0;

    try {
      const cursor = this._getSyncState('pull_cursor') || '';

      const qs = new URLSearchParams({ limit: '50' });
      if (cursor) qs.set('cursor', cursor);

      const result = await this._get(
        `/memories/${this.memoryId}/content?${qs.toString()}`
      );

      // API may return array directly or { items: [...] }
      const items = Array.isArray(result) ? result : (result?.items || []);
      if (!items.length) return { pulled: 0 };

      for (const item of items) {
        // Skip items we pushed ourselves (by checking device_id in metadata)
        const itemDeviceId = item.metadata?.device_id || item.device_id;
        if (itemDeviceId === this.deviceId) continue;
        // Check if we already have this cloud item (by cloud_id mapping)
        const existing = this._getSyncState(`cloud_id_reverse:${item.id}`);
        if (existing) continue;

        try {
          await this._pullSingleItem(item);
          pulled++;
        } catch (err) {
          console.warn(`${LOG_PREFIX} Failed to pull item ${item.id}:`, err.message);
        }
      }

      // Advance cursor
      if (result.next_cursor) {
        this._setSyncState('pull_cursor', result.next_cursor);
      }

      if (pulled > 0) {
        console.log(`${LOG_PREFIX} Pulled ${pulled} memories from cloud`);
        this._recordSyncEvent('memories', { count: pulled, direction: 'pull' });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} pullFromCloud failed:`, err.message);
    }

    return { pulled };
  }

  /**
   * Push unsynced knowledge cards to the cloud.
   * Uses POST /memories/{id}/insights/submit with action:"new".
   *
   * @returns {Promise<{ synced: number, errors: number }>}
   */
  async syncInsightsToCloud() {
    if (!this.isEnabled()) return { synced: 0, errors: 0 };

    let synced = 0;
    let errors = 0;

    try {
      const unsynced = this.indexer.db
        .prepare("SELECT * FROM knowledge_cards WHERE synced_to_cloud = 0 AND status = 'active' ORDER BY created_at")
        .all();

      if (!unsynced.length) return { synced: 0, errors: 0 };

      // Batch cards in groups of 10 to reduce API calls
      const batchSize = 10;
      for (let i = 0; i < unsynced.length; i += batchSize) {
        const batch = unsynced.slice(i, i + batchSize);
        const cards = batch.map((card) => ({
          title: card.title,
          summary: card.summary || '',
          category: card.category,
          confidence: card.confidence || 0.8,
          tags: this._parseTags(card.tags),
          action: 'new',
        }));

        try {
          const result = await this._post(
            `/memories/${this.memoryId}/insights/submit`,
            {
              session_id: `local-sync-${this.deviceId}`,
              knowledge_cards: cards,
              metadata: { device_id: this.deviceId, source: 'awareness-local' },
            }
          );

          if (result) {
            // Mark batch as synced
            const markStmt = this.indexer.db.prepare(
              'UPDATE knowledge_cards SET synced_to_cloud = 1 WHERE id = ?'
            );
            for (const card of batch) {
              markStmt.run(card.id);
            }
            synced += batch.length;
          } else {
            errors += batch.length;
          }
        } catch (err) {
          console.warn(`${LOG_PREFIX} Failed to push insight batch:`, err.message);
          errors += batch.length;
        }
      }

      if (synced > 0) {
        console.log(`${LOG_PREFIX} Pushed ${synced} knowledge cards to cloud` + (errors ? ` (${errors} errors)` : ''));
        this._recordSyncEvent('insights', { count: synced, direction: 'push' });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} syncInsightsToCloud failed:`, err.message);
    }

    return { synced, errors };
  }

  /**
   * Push unsynced tasks (action items) to the cloud.
   * Uses POST /memories/{id}/insights/submit with action_items.
   *
   * @returns {Promise<{ synced: number, errors: number }>}
   */
  async syncTasksToCloud() {
    if (!this.isEnabled()) return { synced: 0, errors: 0 };

    let synced = 0;
    let errors = 0;

    try {
      const unsynced = this.indexer.db
        .prepare("SELECT * FROM tasks WHERE synced_to_cloud = 0 ORDER BY created_at")
        .all();

      if (!unsynced.length) return { synced: 0, errors: 0 };

      const batchSize = 10;
      for (let i = 0; i < unsynced.length; i += batchSize) {
        const batch = unsynced.slice(i, i + batchSize);
        const items = batch.map((task) => ({
          title: task.title,
          detail: task.description || '',
          priority: task.priority || 'medium',
          status: task.status || 'open',
          agent_role: task.agent_role || '',
        }));

        try {
          const result = await this._post(
            `/memories/${this.memoryId}/insights/submit`,
            {
              session_id: `local-sync-${this.deviceId}`,
              action_items: items,
              metadata: { device_id: this.deviceId, source: 'awareness-local' },
            }
          );

          if (result) {
            const markStmt = this.indexer.db.prepare(
              'UPDATE tasks SET synced_to_cloud = 1 WHERE id = ?'
            );
            for (const task of batch) {
              markStmt.run(task.id);
            }
            synced += batch.length;
          } else {
            errors += batch.length;
          }
        } catch (err) {
          console.warn(`${LOG_PREFIX} Failed to push task batch:`, err.message);
          errors += batch.length;
        }
      }

      if (synced > 0) {
        console.log(`${LOG_PREFIX} Pushed ${synced} tasks to cloud` + (errors ? ` (${errors} errors)` : ''));
        this._recordSyncEvent('tasks', { count: synced, direction: 'push' });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} syncTasksToCloud failed:`, err.message);
    }

    return { synced, errors };
  }

  /**
   * Full bidirectional sync: push memories + insights + tasks, then pull.
   * @returns {Promise<{ pushed: number, pulled: number, insights_pushed: number, tasks_pushed: number }>}
   */
  async fullSync() {
    const pushResult = await this.syncToCloud();
    const insightsResult = await this.syncInsightsToCloud();
    const tasksResult = await this.syncTasksToCloud();
    const pullResult = await this.pullFromCloud();
    return {
      pushed: pushResult.synced,
      insights_pushed: insightsResult.synced,
      tasks_pushed: tasksResult.synced,
      pulled: pullResult.pulled,
    };
  }

  /**
   * Connect to the cloud SSE endpoint for real-time event streaming.
   * Automatically reconnects on disconnect with exponential backoff.
   */
  async startSSE() {
    if (!this.isEnabled()) return;
    this._sseStopped = false;

    const url = `${this.apiBase}/memories/${this.memoryId}/events/stream`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'X-Awareness-Device-Id': this.deviceId,
    };

    try {
      const { req, res } = await openSSEStream(url, headers);
      this._sseReq = req;
      this._sseReconnectMs = SSE_RECONNECT_BASE_MS; // Reset backoff on success

      console.log(`${LOG_PREFIX} SSE connected to cloud`);

      let buffer = '';
      res.setEncoding('utf-8');

      res.on('data', (chunk) => {
        buffer += chunk;
        // SECURITY C7: Cap SSE buffer to prevent unbounded memory growth
        if (buffer.length > 1024 * 1024) {
          console.warn(`${LOG_PREFIX} SSE buffer overflow (>1MB) — dropping`);
          buffer = '';
          return;
        }
        const { parsed, remainder } = parseSSE(buffer);
        buffer = remainder;

        for (const event of parsed) {
          // Handle event asynchronously — don't block the stream
          this._handleSSEEvent(event).catch((err) => {
            console.warn(`${LOG_PREFIX} SSE event handler error:`, err.message);
          });
        }
      });

      res.on('end', () => {
        console.warn(`${LOG_PREFIX} SSE stream ended`);
        this._scheduleSSEReconnect();
      });

      res.on('error', (err) => {
        console.warn(`${LOG_PREFIX} SSE stream error:`, err.message);
        this._scheduleSSEReconnect();
      });

    } catch (err) {
      // SSE is optional (server may not support it yet) — silently fall back
      if (err.message && err.message.includes('404')) {
        if (!this._sseRetryCount) {
          console.log(`${LOG_PREFIX} SSE not available on server — using periodic sync only`);
        }
        return; // Don't retry on 404; periodic sync is the fallback
      }
      console.warn(`${LOG_PREFIX} SSE connection failed:`, err.message);
      this._scheduleSSEReconnect();
    }
  }

  /**
   * Start periodic sync fallback (Layer 3).
   * @param {number} [intervalMin=5] — Interval in minutes
   */
  startPeriodicSync(intervalMin = DEFAULT_PERIODIC_INTERVAL_MIN) {
    if (intervalMin <= 0) return;

    this._periodicTimer = setInterval(async () => {
      try {
        const result = await this.fullSync();
        if (result.pushed > 0 || result.pulled > 0 || result.insights_pushed > 0 || result.tasks_pushed > 0) {
          console.log(
            `${LOG_PREFIX} Periodic sync: memories=${result.pushed}, insights=${result.insights_pushed}, tasks=${result.tasks_pushed}, pulled=${result.pulled}`
          );
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Periodic sync failed:`, err.message);
      }
    }, intervalMin * 60 * 1000);
  }

  /**
   * Start all sync layers:
   *   1. Pull from cloud (catch up while offline)
   *   2. Push unsynced local memories
   *   3. Start SSE real-time stream
   *   4. Start periodic fallback
   */
  async start() {
    if (!this.isEnabled()) {
      console.log(`${LOG_PREFIX} Cloud sync disabled (missing credentials or not enabled)`);
      return;
    }

    console.log(`${LOG_PREFIX} Starting cloud sync...`);

    try {
      // Layer 2: Catch-up pull
      await this.pullFromCloud();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Initial pull failed (will retry):`, err.message);
    }

    try {
      // Push unsynced memories, knowledge cards, and tasks
      await this.syncToCloud();
      await this.syncInsightsToCloud();
      await this.syncTasksToCloud();
    } catch (err) {
      console.warn(`${LOG_PREFIX} Initial push failed (will retry):`, err.message);
    }

    // Layer 1: SSE real-time (non-blocking)
    this.startSSE();

    // Layer 3: Periodic fallback
    const intervalMin = this.config.cloud?.sync_interval_min || DEFAULT_PERIODIC_INTERVAL_MIN;
    this.startPeriodicSync(intervalMin);

    console.log(`${LOG_PREFIX} Started: SSE + periodic sync (${intervalMin}min) enabled`);
  }

  /**
   * Stop all sync activity gracefully.
   */
  stop() {
    this._sseStopped = true;

    // Abort SSE connection
    if (this._sseReq) {
      try {
        this._sseReq.destroy();
      } catch {
        // ignore
      }
      this._sseReq = null;
    }

    // Clear SSE reconnect timer
    if (this._sseReconnectTimer) {
      clearTimeout(this._sseReconnectTimer);
      this._sseReconnectTimer = null;
    }

    // Clear periodic sync
    if (this._periodicTimer) {
      clearInterval(this._periodicTimer);
      this._periodicTimer = null;
    }

    console.log(`${LOG_PREFIX} Stopped`);
  }

  // =========================================================================
  // Internal — SSE event handling
  // =========================================================================

  /**
   * Handle a single parsed SSE event.
   * @param {{ event: string, data: string }} sseEvent
   */
  async _handleSSEEvent(sseEvent) {
    let data;
    try {
      data = JSON.parse(sseEvent.data);
    } catch {
      return; // Malformed data — skip silently
    }

    switch (sseEvent.event) {
      case 'memory_created':
      case 'memory_updated': {
        // Skip our own events (anti-loop)
        if (data.device_id === this.deviceId) return;

        // Check if already pulled
        const existing = this._getSyncState(`cloud_id_reverse:${data.id}`);
        if (existing) return;

        // Pull the full content
        try {
          await this._pullSingleItem(data);
          console.log(
            `${LOG_PREFIX} SSE received: ${data.title || data.id} (from ${data.source || 'cloud'})`
          );
        } catch (err) {
          console.warn(`${LOG_PREFIX} SSE pull failed for ${data.id}:`, err.message);
        }
        break;
      }

      case 'knowledge_extracted':
      case 'insight_submitted': {
        if (data.device_id === this.deviceId) return;
        try {
          await this._pullKnowledgeCard(data);
        } catch (err) {
          console.warn(`${LOG_PREFIX} SSE knowledge pull failed:`, err.message);
        }
        break;
      }

      case 'task_created':
      case 'task_updated': {
        if (data.device_id === this.deviceId) return;
        try {
          await this._pullTask(data);
        } catch (err) {
          console.warn(`${LOG_PREFIX} SSE task pull failed:`, err.message);
        }
        break;
      }

      case 'heartbeat':
        // Keepalive — no action needed
        break;

      default:
        // Unknown event type — ignore gracefully
        break;
    }
  }

  /**
   * Schedule an SSE reconnection with exponential backoff.
   */
  _scheduleSSEReconnect() {
    if (this._sseStopped) return;

    // Clean up current request
    if (this._sseReq) {
      try {
        this._sseReq.destroy();
      } catch {
        // ignore
      }
      this._sseReq = null;
    }

    const delay = this._sseReconnectMs;
    this._sseReconnectMs = Math.min(
      this._sseReconnectMs * 2,
      SSE_RECONNECT_MAX_MS
    );

    this._sseRetryCount = (this._sseRetryCount || 0) + 1;
    if (this._sseRetryCount >= 3) {
      console.log(`${LOG_PREFIX} SSE unavailable after 3 retries — falling back to periodic sync only`);
      return;  // Stop retrying; periodic sync will compensate
    }

    console.log(`${LOG_PREFIX} SSE reconnecting in ${Math.round(delay / 1000)}s... (retry ${this._sseRetryCount}/3)`);

    this._sseReconnectTimer = setTimeout(() => {
      this._sseReconnectTimer = null;
      this.startSSE();
    }, delay);
  }

  // =========================================================================
  // Internal — pull helpers
  // =========================================================================

  /**
   * Pull a single memory item from cloud and write to local store.
   * @param {object} item — { id, event_type, content, metadata, ... }
   */
  async _pullSingleItem(item) {
    // If item doesn't have content, fetch it from the API
    let content = item.content;
    let eventType = item.event_type || item.type || 'turn_summary';
    let tags = item.metadata?.tags || item.tags || [];
    let agentRole = item.metadata?.agent_role || item.agent_role;
    let source = item.metadata?.source || item.source || 'cloud-pull';

    if (!content && item.id) {
      const detail = await this._get(
        `/memories/${this.memoryId}/content/${item.id}`
      );
      if (!detail) return;
      content = detail.content || '';
      eventType = detail.event_type || eventType;
      tags = detail.metadata?.tags || tags;
      agentRole = detail.metadata?.agent_role || agentRole;
      source = detail.metadata?.source || source;
    }

    if (!content) return;

    // Write to local markdown
    const { id, filepath } = await this.memoryStore.write({
      type: eventType,
      content,
      title: item.title || '',
      tags: Array.isArray(tags) ? tags : [],
      agent_role: agentRole,
      session_id: item.session_id || '',
      source,
    });

    // Index in SQLite
    this.indexer.indexMemory(
      id,
      {
        type: eventType,
        title: item.title || '',
        tags: Array.isArray(tags) ? tags : [],
        agent_role: agentRole,
        session_id: item.session_id || '',
        source,
        filepath,
        synced_to_cloud: true,
      },
      content
    );

    // Mark synced and store cloud_id mapping (bidirectional)
    this.indexer.db
      .prepare('UPDATE memories SET synced_to_cloud = 1 WHERE id = ?')
      .run(id);

    if (item.id) {
      this._setSyncState(`cloud_id:${id}`, item.id);
      this._setSyncState(`cloud_id_reverse:${item.id}`, id);
    }
  }

  /**
   * Pull a knowledge card from cloud SSE event data and store locally.
   * @param {object} data — { id, category, title, summary, tags, ... }
   */
  async _pullKnowledgeCard(data) {
    if (!data.title || !data.category) return;

    // Check if we already have this knowledge card
    const existing = this._getSyncState(`cloud_kc:${data.id}`);
    if (existing) return;

    // Write knowledge card markdown
    const kcContent = [
      `# ${data.title}`,
      '',
      data.summary ? `**Summary**: ${data.summary}` : '',
      data.key_insight ? `**Key Insight**: ${data.key_insight}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Store via memoryStore's knowledge write (if available) or direct file write
    const kcId = `kc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const tags = Array.isArray(data.tags) ? data.tags : [];

    try {
      this.indexer.db
        .prepare(
          `INSERT OR IGNORE INTO knowledge_cards
           (id, category, title, summary, source_memories, confidence, status, tags, created_at, filepath, synced_to_cloud)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          kcId,
          data.category,
          data.title,
          data.summary || '',
          JSON.stringify(data.source_memories || []),
          data.confidence || 0.8,
          'active',
          JSON.stringify(tags),
          new Date().toISOString(),
          `cloud-pull:${data.id}`
        );

      this._setSyncState(`cloud_kc:${data.id}`, kcId);
    } catch (err) {
      // Duplicate or constraint error — safe to ignore
      if (!err.message?.includes('UNIQUE')) {
        throw err;
      }
    }
  }

  /**
   * Pull a task from cloud SSE event data and store locally.
   * @param {object} data — { id, title, detail, priority, status, agent_role, ... }
   */
  async _pullTask(data) {
    if (!data.title) return;

    // Check if we already have this task
    const existing = this._getSyncState(`cloud_task:${data.id}`);
    if (existing) {
      // Task update — update status/priority if changed
      try {
        this.indexer.db
          .prepare('UPDATE tasks SET status = ?, priority = ?, updated_at = ? WHERE id = ?')
          .run(data.status || 'open', data.priority || 'medium', new Date().toISOString(), existing);
      } catch {
        // ignore update failures
      }
      return;
    }

    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    try {
      this.indexer.db
        .prepare(
          `INSERT OR IGNORE INTO tasks
           (id, title, description, status, priority, agent_role, created_at, updated_at, filepath, synced_to_cloud)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(
          taskId,
          data.title,
          data.detail || data.description || '',
          data.status || 'open',
          data.priority || 'medium',
          data.agent_role || '',
          now,
          now,
          `cloud-pull:${data.id}`
        );

      this._setSyncState(`cloud_task:${data.id}`, taskId);
    } catch (err) {
      if (!err.message?.includes('UNIQUE')) {
        throw err;
      }
    }
  }

  // =========================================================================
  // Internal — HTTP helpers
  // =========================================================================

  /**
   * GET request to cloud API.
   * @param {string} endpoint — Path relative to apiBase (e.g. "/memories/xxx/content")
   * @returns {Promise<object|null>}
   */
  async _get(endpoint) {
    const url = `${this.apiBase}${endpoint}`;
    try {
      const { status, body } = await httpRequest(url, {
        method: 'GET',
        headers: this._authHeaders(),
      });

      if (status >= 200 && status < 300) {
        return JSON.parse(body);
      }

      console.warn(`${LOG_PREFIX} GET ${endpoint} → HTTP ${status}`);
      return null;
    } catch (err) {
      console.warn(`${LOG_PREFIX} GET ${endpoint} failed:`, err.message);
      return null;
    }
  }

  /**
   * POST request to cloud API.
   * @param {string} endpoint
   * @param {object} data
   * @returns {Promise<object|null>}
   */
  async _post(endpoint, data) {
    const url = `${this.apiBase}${endpoint}`;
    const jsonBody = JSON.stringify(data);
    try {
      const { status, body } = await httpRequest(url, {
        method: 'POST',
        headers: {
          ...this._authHeaders(),
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(jsonBody)),
        },
        body: jsonBody,
      });

      if (status >= 200 && status < 300) {
        return JSON.parse(body);
      }

      console.warn(`${LOG_PREFIX} POST ${endpoint} → HTTP ${status}: ${body.slice(0, 200)}`);
      return null;
    } catch (err) {
      console.warn(`${LOG_PREFIX} POST ${endpoint} failed:`, err.message);
      return null;
    }
  }

  /**
   * Build authorization headers for cloud requests.
   * @returns {object}
   */
  _authHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'X-Awareness-Device-Id': this.deviceId,
    };
  }

  // =========================================================================
  // Internal — sync state persistence (via SQLite sync_state table)
  // =========================================================================

  /**
   * Ensure the sync_state table and any missing columns exist.
   */
  _ensureSyncSchema() {
    try {
      // sync_state table is created by indexer schema init; just verify it exists
      this.indexer.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`
        )
        .run();
    } catch {
      // Table likely already exists
    }

    // Migrate existing tables: add synced_to_cloud column if missing.
    // DEFAULT 0 means all existing records are marked as unsynced → they'll be
    // pushed on the next sync cycle, ensuring old data reaches the cloud.
    for (const table of ['knowledge_cards', 'tasks']) {
      try {
        this.indexer.db
          .prepare(`ALTER TABLE ${table} ADD COLUMN synced_to_cloud INTEGER DEFAULT 0`)
          .run();
        console.log(`${LOG_PREFIX} Migrated ${table}: added synced_to_cloud column`);
      } catch {
        // Column already exists — expected for fresh installs
      }
    }
  }

  /**
   * Get a value from sync_state.
   * @param {string} key
   * @returns {string|null}
   */
  _getSyncState(key) {
    try {
      const row = this.indexer.db
        .prepare('SELECT value FROM sync_state WHERE key = ?')
        .get(key);
      return row?.value || null;
    } catch {
      return null;
    }
  }

  /**
   * Set a value in sync_state (upsert).
   * @param {string} key
   * @param {string} value
   */
  _setSyncState(key, value) {
    try {
      this.indexer.db
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(key, value, new Date().toISOString());
    } catch {
      // Non-critical — log and continue
    }
  }

  // =========================================================================
  // Public — sync history
  // =========================================================================

  /**
   * Record a sync event to the sync_state table for history tracking.
   * @param {string} type — "memories" | "insights" | "tasks"
   * @param {object} details — { count, direction: "push"|"pull" }
   */
  _recordSyncEvent(type, details) {
    try {
      const timestamp = new Date().toISOString();
      const key = `sync_log:${timestamp}`;
      const value = JSON.stringify({ type, details, timestamp });
      this._setSyncState(key, value);
    } catch {
      // Non-critical — don't crash on history logging failure
    }
  }

  /**
   * Get recent sync history events.
   * @param {number} [limit=20] — Maximum number of events to return
   * @returns {Array<{ type: string, details: object, timestamp: string }>}
   */
  getSyncHistory(limit = 20) {
    try {
      const rows = this.indexer.db
        .prepare(
          `SELECT value FROM sync_state WHERE key LIKE 'sync_log:%' ORDER BY key DESC LIMIT ?`
        )
        .all(limit);

      return rows.map((row) => {
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  // =========================================================================
  // Internal — utilities
  // =========================================================================

  /**
   * Parse tags JSON string safely.
   * @param {string} tagsStr — JSON array string or empty
   * @returns {string[]}
   */
  _parseTags(tagsStr) {
    if (!tagsStr) return [];
    try {
      const parsed = JSON.parse(tagsStr);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Simple async sleep.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
