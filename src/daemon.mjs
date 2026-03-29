/**
 * AwarenessLocalDaemon — HTTP server + MCP transport for Awareness Local.
 *
 * Binds to 127.0.0.1 (loopback only) and routes:
 *   /healthz          → health check JSON
 *   /mcp              → MCP Streamable HTTP (JSON-RPC over POST)
 *   /api/v1/*         → REST API (Phase 4)
 *   /                 → Web UI placeholder (Phase 4)
 *
 * Lifecycle:
 *   start()   → init modules → incremental index → HTTP listen → PID file → fs.watch
 *   stop()    → close watcher → close HTTP → remove PID
 *   isRunning() → PID file + healthz probe
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Force UTF-8 encoding on Windows (prevents Chinese/CJK text from becoming ????)
if (process.platform === 'win32') {
  try { process.stdout.setEncoding('utf8'); } catch { /* best-effort */ }
  try { process.stderr.setEncoding('utf8'); } catch { /* best-effort */ }
  // Set LANG to ensure downstream tools respect UTF-8
  process.env.LANG = process.env.LANG || 'en_US.UTF-8';
}

import { MemoryStore } from './core/memory-store.mjs';
import { Indexer } from './core/indexer.mjs';
import { CloudSync } from './core/cloud-sync.mjs';
import { LocalMcpServer } from './mcp-server.mjs';
import { buildContextXml } from './harness-builder.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 37800;
const BIND_HOST = '127.0.0.1';
const AWARENESS_DIR = '.awareness';
const PID_FILENAME = 'daemon.pid';
const LOG_FILENAME = 'daemon.log';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a noop indexer fallback when better-sqlite3 is not available.
 * Provides stubs for every method/property accessed on the real Indexer,
 * including `db.prepare(sql).get/all/run()` and `db.transaction()`.
 */
function createNoopIndexer() {
  const noopStmt = { get: () => undefined, all: () => [], run: () => ({}) };
  const noopDb = {
    prepare: () => noopStmt,
    transaction: (fn) => fn,
    exec: () => {},
    pragma: () => {},
  };
  return {
    db: noopDb,
    incrementalIndex: async () => ({ indexed: 0, skipped: 0 }),
    indexMemory: () => ({ indexed: false }),
    indexKnowledgeCard: () => {},
    indexTask: () => {},
    search: () => [],
    searchKnowledge: () => [],
    getRecentKnowledge: () => [],
    getRecentMemories: () => [],
    getOpenTasks: () => [],
    getRecentSessions: () => [],
    getStats: () => ({ totalMemories: 0, totalKnowledge: 0, totalTasks: 0, totalSessions: 0 }),
    createSession: (source, agentRole = 'builder_agent') => ({
      id: `ses_${Date.now()}_noop`,
      source: source || null,
      agent_role: agentRole,
      started_at: new Date().toISOString(),
    }),
    updateSession: () => {},
    supersedeCard: () => false,
    getEvolutionChain: () => [],
    storeEmbedding: () => {},
    getEmbedding: () => null,
    getAllEmbeddings: () => [],
    close: () => {},
  };
}

/** Current ISO timestamp. */
function nowISO() {
  return new Date().toISOString();
}

/** Categories surfaced as top-level user_preferences (mirrors cloud PREFERENCE_FIRST_CATEGORIES). */
const PREFERENCE_FIRST_CATEGORIES = new Set([
  'personal_preference', 'activity_preference', 'important_detail', 'career_info',
]);
const MAX_USER_PREFERENCES = 15;

/** Split knowledge cards into {user_preferences, knowledge_cards}. */
function splitPreferences(cards) {
  const prefs = [];
  const other = [];
  for (const c of cards) {
    if (PREFERENCE_FIRST_CATEGORIES.has(c.category) && prefs.length < MAX_USER_PREFERENCES) {
      prefs.push(c);
    } else {
      other.push(c);
    }
  }
  return { user_preferences: prefs, knowledge_cards: other };
}

// ---------------------------------------------------------------------------
// Dynamic rule synthesis from knowledge cards (zero-LLM)
// ---------------------------------------------------------------------------

const CATEGORY_TO_RULE_TYPE = {
  decision: 'architecture', workflow: 'workflow', pitfall: 'pitfall',
  problem_solution: 'solution', key_point: 'knowledge', insight: 'knowledge',
  personal_preference: 'preference', activity_preference: 'preference',
  important_detail: 'context', plan_intention: 'context',
  health_info: 'context', career_info: 'context', custom_misc: 'context',
};

/**
 * Synthesize rules from knowledge cards, prioritised by type.
 * @param {object[]} cards — active knowledge cards
 * @param {number} [maxRules=30]
 * @returns {{ rules: object[], rule_count: number }}
 */
function synthesizeRules(cards, maxRules = 30) {
  const buckets = {};
  for (const card of cards) {
    const ruleType = CATEGORY_TO_RULE_TYPE[card.category] || 'knowledge';
    if (!buckets[ruleType]) buckets[ruleType] = [];

    // Prefer actionable_rule, fall back to summary
    const ruleText = (card.actionable_rule || '').trim() || card.summary || '';
    if (!ruleText) continue;

    buckets[ruleType].push({
      id: `rule_${(card.id || '').slice(0, 8)}`,
      rule_type: ruleType,
      title: card.title || '',
      rule: ruleText,
      confidence: card.confidence || 0.8,
      tags: card.tags ? (typeof card.tags === 'string' ? JSON.parse(card.tags) : card.tags) : [],
    });
  }

  const priority = ['preference', 'architecture', 'pitfall', 'workflow', 'solution', 'knowledge', 'context'];
  const rules = [];
  for (const type of priority) {
    const bucket = (buckets[type] || []).slice(0, 8);
    for (const r of bucket) {
      if (rules.length >= maxRules) break;
      rules.push(r);
    }
    if (rules.length >= maxRules) break;
  }
  return { rules, rule_count: rules.length };
}

/**
 * Extract active skills from knowledge cards (category === 'skill').
 * @param {object[]} cards
 * @returns {object[]}
 */
function extractActiveSkills(cards) {
  return cards
    .filter(c => c.category === 'skill')
    .map(c => {
      let methods = [];
      if (c.methods) {
        methods = typeof c.methods === 'string' ? JSON.parse(c.methods) : c.methods;
      }
      if (!Array.isArray(methods)) methods = [];
      return {
        title: c.title || '',
        summary: c.summary || '',
        methods,
      };
    });
}

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {object} data
 * @param {number} [status=200]
 */
function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  // SECURITY: Only allow requests from localhost dashboard (not arbitrary websites)
  const origin = 'http://localhost:37800';
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': origin,
  });
  res.end(body);
}

/** Max request body size (10 MB) — prevents memory exhaustion DoS. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read the full request body as a string.
 * Rejects with 413 if body exceeds MAX_BODY_BYTES.
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large (max 10MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Minimal HTTP GET health check against localhost.
 * Resolves true if status 200, false otherwise.
 * @param {number} port
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<boolean>}
 */
function httpHealthCheck(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs },
      (res) => {
        // Drain body
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// AwarenessLocalDaemon
// ---------------------------------------------------------------------------

export class AwarenessLocalDaemon {
  /**
   * @param {object} [options]
   * @param {number}  [options.port=37800]       — HTTP listen port
   * @param {string}  [options.projectDir=cwd]   — project root directory
   */
  constructor(options = {}) {
    this.port = options.port || DEFAULT_PORT;
    this.projectDir = options.projectDir || process.cwd();

    this.awarenessDir = path.join(this.projectDir, AWARENESS_DIR);
    this.pidFile = path.join(this.awarenessDir, PID_FILENAME);
    this.logFile = path.join(this.awarenessDir, LOG_FILENAME);

    // Modules — initialised in start()
    this.memoryStore = null;
    this.indexer = null;
    this.search = null;
    this.extractor = null;
    this.mcpServer = null;
    this.cloudSync = null;
    this.httpServer = null;
    this.watcher = null;

    // Debounce timer for fs.watch reindex
    this._reindexTimer = null;
    this._reindexDebounceMs = 1000;

    // Track uptime
    this._startedAt = null;

    // Active MCP sessions (session-id → transport)
    this._mcpSessions = new Map();
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the daemon.
   *   1. Check if another instance is running
   *   2. Initialise all core modules
   *   3. Run incremental index
   *   4. Start HTTP server
   *   5. Set up MCP server
   *   6. Write PID file
   *   7. Start fs.watch on memories dir
   */
  async start() {
    // SECURITY C4: Prevent unhandled rejections from crashing the daemon
    process.on('unhandledRejection', (err) => {
      console.error('[awareness-local] unhandled rejection:', err?.message || err);
    });

    if (await this.isRunning()) {
      console.log(
        `[awareness-local] daemon already running on port ${this.port}`
      );
      return { alreadyRunning: true, port: this.port };
    }

    // Ensure directory structure
    fs.mkdirSync(path.join(this.awarenessDir, 'memories'), { recursive: true });
    fs.mkdirSync(path.join(this.awarenessDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(this.awarenessDir, 'tasks'), { recursive: true });

    // ---- Init core modules ----
    this.memoryStore = new MemoryStore(this.projectDir);
    try {
      this.indexer = new Indexer(
        path.join(this.awarenessDir, 'index.db')
      );
    } catch (e) {
      console.error(`[awareness-local] SQLite indexer unavailable: ${e.message}`);
      console.error('[awareness-local] Falling back to file-only mode (no search). Install better-sqlite3: npm install better-sqlite3');
      this.indexer = createNoopIndexer();
    }

    // Search and extractor are optional Phase 1 modules — import dynamically
    // so that missing files don't break daemon startup.
    this.search = await this._loadSearchEngine();
    this.extractor = await this._loadKnowledgeExtractor();

    // ---- Incremental index ----
    try {
      const indexResult = await this.indexer.incrementalIndex(this.memoryStore);
      console.log(
        `[awareness-local] indexed ${indexResult.indexed} files, ` +
        `skipped ${indexResult.skipped}`
      );
    } catch (err) {
      console.error('[awareness-local] incremental index error:', err.message);
    }

    // ---- Pre-warm embedding model + backfill (fire-and-forget, non-blocking) ----
    if (this._embedder) {
      this._warmupEmbedder().catch((err) => {
        console.warn('[awareness-local] embedder warmup error:', err.message);
      });
    }

    // ---- MCP server ----
    this.mcpServer = new LocalMcpServer({
      memoryStore: this.memoryStore,
      indexer: this.indexer,
      search: this.search,
      extractor: this.extractor,
      config: this._loadConfig(),
      loadSpec: () => this._loadSpec(),
      createSession: (source) => this._createSession(source),
      remember: (params) => this._remember(params),
      rememberBatch: (params) => this._rememberBatch(params),
      updateTask: (params) => this._updateTask(params),
      submitInsights: (params) => this._submitInsights(params),
      lookup: (params) => this._lookup(params),
    });

    // ---- Cloud sync (optional) ----
    const config = this._loadConfig();
    if (config.cloud?.enabled) {
      try {
        this.cloudSync = new CloudSync(config, this.indexer, this.memoryStore);
        if (this.cloudSync.isEnabled()) {
          // Start cloud sync (non-blocking — errors won't prevent daemon startup)
          this.cloudSync.start().catch((err) => {
            console.warn('[awareness-local] cloud sync start failed:', err.message);
          });
        }
      } catch (err) {
        console.warn('[awareness-local] cloud sync init failed:', err.message);
        this.cloudSync = null;
      }
    }

    // ---- HTTP server ----
    this.httpServer = http.createServer((req, res) =>
      this._handleRequest(req, res)
    );

    try {
      await new Promise((resolve, reject) => {
        this.httpServer.on('error', reject);
        this.httpServer.listen(this.port, BIND_HOST, () => resolve());
      });
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[awareness-local] Port ${this.port} is already in use.\n` +
          `  Possible causes:\n` +
          `  - Another awareness-local instance is running (try: awareness-local status)\n` +
          `  - Another application is using port ${this.port}\n` +
          `  Fix: Run "awareness-local stop" or "lsof -i :${this.port}" to find the process.`
        );
      }
      throw err;
    }

    this._startedAt = Date.now();

    // ---- PID file ----
    fs.writeFileSync(this.pidFile, String(process.pid), 'utf-8');

    // ---- File watcher ----
    this._startFileWatcher();

    console.log(
      `[awareness-local] daemon running at http://localhost:${this.port}`
    );
    console.log(
      `[awareness-local] MCP endpoint: http://localhost:${this.port}/mcp`
    );

    return { started: true, port: this.port, pid: process.pid };
  }

  /**
   * Stop the daemon gracefully.
   */
  async stop() {
    // Stop file watcher
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this._reindexTimer) {
      clearTimeout(this._reindexTimer);
      this._reindexTimer = null;
    }

    // Stop cloud sync
    if (this.cloudSync) {
      this.cloudSync.stop();
      this.cloudSync = null;
    }

    // Close MCP sessions
    this._mcpSessions.clear();

    // Close HTTP server
    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
      this.httpServer = null;
    }

    // Close SQLite
    if (this.indexer) {
      this.indexer.close();
      this.indexer = null;
    }

    // Remove PID file
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch {
      // ignore cleanup errors
    }

    console.log('[awareness-local] daemon stopped');
  }

  /**
   * Check if a daemon instance is already running.
   * Validates both PID file and HTTP healthz endpoint.
   * @returns {Promise<boolean>}
   */
  async isRunning() {
    if (!fs.existsSync(this.pidFile)) return false;

    let pid;
    try {
      pid = parseInt(fs.readFileSync(this.pidFile, 'utf-8').trim(), 10);
    } catch {
      return false;
    }

    // Check if process exists
    try {
      process.kill(pid, 0);
    } catch {
      // Process dead — stale PID file
      this._cleanPidFile();
      return false;
    }

    // Also verify HTTP endpoint is responsive
    const healthy = await httpHealthCheck(this.port);
    if (!healthy) {
      this._cleanPidFile();
      return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // HTTP routing
  // -----------------------------------------------------------------------

  /**
   * Route incoming HTTP requests.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async _handleRequest(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.port}`);

    try {
      // /healthz
      if (url.pathname === '/healthz') {
        return this._handleHealthz(req, res);
      }

      // /mcp — MCP JSON-RPC over HTTP
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        return await this._handleMcp(req, res);
      }

      // /api/v1/* — REST API
      if (url.pathname.startsWith('/api/v1')) {
        return await this._handleApi(req, res, url);
      }

      // / — Web Dashboard
      if (url.pathname === '/' || url.pathname.startsWith('/web')) {
        return this._handleWebUI(req, res);
      }

      // 404
      jsonResponse(res, { error: 'Not Found' }, 404);
    } catch (err) {
      console.error('[awareness-local] request error:', err.message);
      jsonResponse(res, { error: 'Internal Server Error' }, 500);
    }
  }

  /**
   * GET /healthz — health check + stats.
   */
  _handleHealthz(_req, res) {
    const stats = this.indexer
      ? this.indexer.getStats()
      : { totalMemories: 0, totalKnowledge: 0, totalTasks: 0, totalSessions: 0 };

    jsonResponse(res, {
      status: 'ok',
      mode: 'local',
      version: '0.1.0',
      uptime: this._startedAt
        ? Math.floor((Date.now() - this._startedAt) / 1000)
        : 0,
      pid: process.pid,
      port: this.port,
      project_dir: this.projectDir,
      search_mode: this._embedder ? 'hybrid' : 'fts5-only',
      stats,
    });
  }

  /**
   * POST /mcp — Handle MCP JSON-RPC requests.
   *
   * This implements a lightweight JSON-RPC adapter that dispatches to the
   * McpServer instance. Instead of using StreamableHTTPServerTransport
   * (which requires specific Express-like middleware), we handle the
   * JSON-RPC protocol directly — simpler and zero-dep.
   */
  async _handleMcp(req, res) {
    // Only POST with JSON body
    if (req.method !== 'POST') {
      // GET /mcp returns server capabilities info
      if (req.method === 'GET') {
        jsonResponse(res, {
          name: 'awareness-local',
          version: '0.1.0',
          protocol: 'mcp',
          capabilities: {
            tools: ['awareness_init', 'awareness_recall', 'awareness_record',
                     'awareness_lookup', 'awareness_get_agent_prompt'],
          },
        });
        return;
      }
      jsonResponse(res, { error: 'Method not allowed' }, 405);
      return;
    }

    const body = await readBody(req);
    let rpcRequest;

    try {
      rpcRequest = JSON.parse(body);
    } catch {
      jsonResponse(
        res,
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
        400
      );
      return;
    }

    // Handle JSON-RPC request
    const rpcResponse = await this._dispatchJsonRpc(rpcRequest);
    jsonResponse(res, rpcResponse);
  }

  /**
   * Dispatch a JSON-RPC request to the appropriate handler.
   * Supports the MCP protocol methods: initialize, tools/list, tools/call.
   * @param {object} rpcRequest
   * @returns {object} JSON-RPC response
   */
  async _dispatchJsonRpc(rpcRequest) {
    const { method, params, id } = rpcRequest;

    try {
      switch (method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'awareness-local', version: '0.1.0' },
              capabilities: { tools: {} },
            },
          };
        }

        case 'notifications/initialized': {
          // Client acknowledgment — no response needed for notifications
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          const tools = this._getToolDefinitions();
          return { jsonrpc: '2.0', id, result: { tools } };
        }

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          const result = await this._callTool(name, args || {});
          return { jsonrpc: '2.0', id, result };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
        }
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message },
      };
    }
  }

  /**
   * Return MCP tool definitions for tools/list.
   * @returns {Array<object>}
   */
  _getToolDefinitions() {
    return [
      {
        name: 'awareness_init',
        description:
          'Start a new session and load context (knowledge cards, tasks, rules). ' +
          'Call this at the beginning of every conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            memory_id: { type: 'string', description: 'Memory identifier (ignored in local mode)' },
            source: { type: 'string', description: 'Client source identifier' },
            days: { type: 'number', description: 'Days of history to load', default: 7 },
            max_cards: { type: 'number', default: 5 },
            max_tasks: { type: 'number', default: 5 },
          },
        },
      },
      {
        name: 'awareness_recall',
        description:
          'Search persistent memory for past decisions, solutions, and knowledge. ' +
          'Use progressive disclosure: detail=summary first, then detail=full with ids.',
        inputSchema: {
          type: 'object',
          properties: {
            semantic_query: { type: 'string', description: 'Natural language search query' },
            keyword_query: { type: 'string', description: 'Exact keyword match' },
            scope: { type: 'string', enum: ['all', 'timeline', 'knowledge', 'insights'], default: 'all' },
            recall_mode: { type: 'string', enum: ['precise', 'session', 'structured', 'hybrid', 'auto'], default: 'hybrid' },
            limit: { type: 'number', default: 10, maximum: 30 },
            detail: {
              type: 'string', enum: ['summary', 'full'], default: 'summary',
              description: 'summary = lightweight index; full = complete content for specified ids',
            },
            ids: { type: 'array', items: { type: 'string' }, description: 'Item IDs to expand (with detail=full)' },
            agent_role: { type: 'string' },
          },
        },
      },
      {
        name: 'awareness_record',
        description:
          'Record memories, update tasks, or submit insights. ' +
          'Use action=remember for single records, remember_batch for bulk.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['remember', 'remember_batch', 'update_task', 'submit_insights'],
            },
            content: { type: 'string', description: 'Memory content (markdown)' },
            title: { type: 'string', description: 'Memory title' },
            items: { type: 'array', description: 'Batch items for remember_batch' },
            insights: { type: 'object', description: 'Pre-extracted knowledge cards, tasks, risks' },
            session_id: { type: 'string' },
            agent_role: { type: 'string' },
            event_type: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            task_id: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'awareness_lookup',
        description:
          'Fast DB lookup — use instead of awareness_recall when you know what type of data you want.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['context', 'tasks', 'knowledge', 'risks', 'session_history', 'timeline'],
            },
            limit: { type: 'number', default: 10 },
            status: { type: 'string' },
            category: { type: 'string' },
            priority: { type: 'string' },
            session_id: { type: 'string' },
            agent_role: { type: 'string' },
            query: { type: 'string' },
          },
          required: ['type'],
        },
      },
      {
        name: 'awareness_get_agent_prompt',
        description: 'Get the activation prompt for a specific agent role.',
        inputSchema: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'Agent role to get prompt for' },
          },
        },
      },
    ];
  }

  /**
   * Execute a tool call by name, dispatching to the engine methods.
   * This is the bridge for the JSON-RPC /mcp endpoint.
   *
   * @param {string} name — tool name
   * @param {object} args — tool arguments
   * @returns {object} MCP result envelope
   */
  async _callTool(name, args) {
    switch (name) {
      case 'awareness_init': {
        const session = this._createSession(args.source);
        const stats = this.indexer.getStats();
        // If a query/prompt is provided, search for relevant cards instead of recent ones
        const maxCards = args.max_cards ?? 5;
        let recentCards;
        if (args.query) {
          recentCards = await this._searchRelevantCards(args.query, maxCards);
        } else {
          recentCards = this.indexer.getRecentKnowledge(maxCards);
        }
        // Load all active cards for rule synthesis and skill extraction
        const allActiveCards = this.indexer.getRecentKnowledge(200);
        const openTasks = this.indexer.getOpenTasks(args.max_tasks ?? 0);
        const rawSessions = this.indexer.getRecentSessions(args.days ?? 7);
        // De-noise: only sessions with content; fallback to 3 most recent
        let recentSessions = rawSessions.filter(s => s.memory_count > 0 || s.summary);
        if (recentSessions.length === 0) {
          recentSessions = rawSessions.slice(0, 3);
        }
        recentSessions = recentSessions.slice(0, 5);
        const spec = this._loadSpec();

        // Compute attention_summary for LLM-side triage
        const now = Date.now();
        const staleDays = 3;
        const staleCutoff = now - staleDays * 86400000;
        const staleTasks = openTasks.filter(t => {
          const created = t.created_at ? new Date(t.created_at).getTime() : now;
          return created < staleCutoff;
        }).length;
        const riskCards = this.indexer.db
          .prepare("SELECT COUNT(*) as cnt FROM knowledge_cards WHERE (category = 'risk' OR category = 'pitfall') AND status = 'active'")
          .get();
        const highRisks = riskCards?.cnt || 0;

        const attentionSummary = {
          stale_tasks: staleTasks,
          high_risks: highRisks,
          total_open_tasks: openTasks.length,
          total_knowledge_cards: recentCards.length,
          needs_attention: staleTasks > 0 || highRisks > 0,
        };

        // Dynamic rule synthesis from knowledge cards
        const { rules, rule_count } = synthesizeRules(allActiveCards);
        // Active skills from knowledge cards
        const activeSkills = extractActiveSkills(allActiveCards);

        const { user_preferences, knowledge_cards: otherCards } = splitPreferences(recentCards);
        const initResult = {
          session_id: session.id,
          mode: 'local',
          user_preferences,
          knowledge_cards: otherCards,
          open_tasks: openTasks,
          recent_sessions: recentSessions,
          stats,
          attention_summary: attentionSummary,
          synthesized_rules: { rules, rule_count },
          init_guides: spec.init_guides || {},
          agent_profiles: [],
          active_skills: activeSkills,
          setup_hints: [],
        };

        // Render XML context
        try {
          initResult.rendered_context = buildContextXml(initResult, [], [], {
            localUrl: `http://localhost:${this.port}`,
          });
        } catch {
          // Non-fatal — client can still use structured data
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(initResult),
          }],
        };
      }

      case 'awareness_recall': {
        // Phase 2: full content for specific IDs
        if (args.detail === 'full' && args.ids?.length) {
          const items = this.search
            ? await this.search.getFullContent(args.ids)
            : [];
          // Return as readable text (no JSON noise for the Agent)
          const sections = items.map(r => {
            const header = r.title ? `## ${r.title}` : '';
            return `${header}\n\n${r.content || '(no content)'}`;
          });
          return {
            content: [{ type: 'text', text: sections.join('\n\n---\n\n') || '(no results)' }],
          };
        }

        // Phase 1: search + summary
        if (!args.semantic_query && !args.keyword_query) {
          return {
            content: [{ type: 'text', text: 'No query provided. Use semantic_query or keyword_query to search.' }],
          };
        }

        const summaries = this.search
          ? await this.search.recall(args)
          : [];

        if (!summaries.length) {
          return {
            content: [{ type: 'text', text: 'No matching memories found.' }],
          };
        }

        // Format as readable text for the Agent (not raw JSON)
        const lines = summaries.map((r, i) => {
          const type = r.type ? `[${r.type}]` : '';
          const title = r.title || '(untitled)';
          const summary = r.summary ? `\n   ${r.summary}` : '';
          return `${i + 1}. ${type} ${title}${summary}`;
        });
        const readableText = `Found ${summaries.length} memories:\n\n${lines.join('\n\n')}`;

        // IDs in a separate content block for Phase 2 expansion
        const idsMeta = JSON.stringify({
          _ids: summaries.map(r => r.id),
          _hint: 'To see full content, call awareness_recall(detail="full", ids=[...]) with IDs above.',
        });

        return {
          content: [
            { type: 'text', text: readableText },
            { type: 'text', text: idsMeta },
          ],
        };
      }

      case 'awareness_record': {
        let result;
        switch (args.action) {
          case 'remember':
            result = await this._remember(args);
            break;
          case 'remember_batch':
            result = await this._rememberBatch(args);
            break;
          case 'update_task':
            result = await this._updateTask(args);
            break;
          case 'submit_insights':
            result = await this._submitInsights(args);
            break;
          default:
            result = { error: `Unknown action: ${args.action}` };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'awareness_lookup': {
        const result = await this._lookup(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'awareness_get_agent_prompt': {
        const spec = this._loadSpec();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              prompt: spec.init_guides?.sub_agent_guide || '',
              role: args.role || '',
              mode: 'local',
            }),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // -----------------------------------------------------------------------
  // REST API
  // -----------------------------------------------------------------------

  /**
   * Route REST API requests.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   */
  async _handleApi(req, res, url) {
    const route = url.pathname.replace('/api/v1', '');

    // GET /api/v1/stats
    if (route === '/stats' && req.method === 'GET') {
      const stats = this.indexer ? this.indexer.getStats() : {};
      return jsonResponse(res, stats);
    }

    // GET /api/v1/memories
    if (route === '/memories' && req.method === 'GET') {
      return this._apiListMemories(req, res, url);
    }

    // GET /api/v1/memories/search?q=query
    if (route === '/memories/search' && req.method === 'GET') {
      return this._apiSearchMemories(req, res, url);
    }

    // GET /api/v1/knowledge
    if (route === '/knowledge' && req.method === 'GET') {
      return this._apiListKnowledge(req, res, url);
    }

    // GET /api/v1/knowledge/:id/evolution — get evolution chain for a card
    if (route.startsWith('/knowledge/') && route.endsWith('/evolution') && req.method === 'GET') {
      const cardId = decodeURIComponent(route.replace('/knowledge/', '').replace('/evolution', ''));
      return this._apiGetEvolutionChain(req, res, cardId);
    }

    // DELETE /api/v1/knowledge/cleanup — batch-delete cards matching regex patterns
    if (route === '/knowledge/cleanup' && req.method === 'DELETE') {
      return await this._apiCleanupKnowledge(req, res);
    }

    // GET /api/v1/tasks
    if (route === '/tasks' && req.method === 'GET') {
      return this._apiListTasks(req, res, url);
    }

    // PUT /api/v1/tasks/:id
    if (route.startsWith('/tasks/') && req.method === 'PUT') {
      const taskId = decodeURIComponent(route.replace('/tasks/', ''));
      return await this._apiUpdateTask(req, res, taskId);
    }

    // GET /api/v1/sync/status
    if (route === '/sync/status' && req.method === 'GET') {
      return this._apiSyncStatus(req, res);
    }

    // GET /api/v1/config
    if (route === '/config' && req.method === 'GET') {
      return this._apiGetConfig(req, res);
    }

    // PUT /api/v1/config
    if (route === '/config' && req.method === 'PUT') {
      return await this._apiUpdateConfig(req, res);
    }

    // POST /api/v1/cloud/auth/start — initiate device-auth
    if (route === '/cloud/auth/start' && req.method === 'POST') {
      return await this._apiCloudAuthStart(req, res);
    }

    // POST /api/v1/cloud/auth/poll — poll device-auth result
    if (route === '/cloud/auth/poll' && req.method === 'POST') {
      return await this._apiCloudAuthPoll(req, res);
    }

    // POST /api/v1/cloud/auth/open-browser — open URL in system browser
    if (route === '/cloud/auth/open-browser' && req.method === 'POST') {
      return await this._apiCloudAuthOpenBrowser(req, res);
    }

    // GET /api/v1/cloud/memories — list memories (after auth)
    if (route.startsWith('/cloud/memories') && req.method === 'GET') {
      return await this._apiCloudListMemories(req, res, url);
    }

    // POST /api/v1/cloud/connect — save cloud config
    if (route === '/cloud/connect' && req.method === 'POST') {
      return await this._apiCloudConnect(req, res);
    }

    // POST /api/v1/cloud/disconnect
    if (route === '/cloud/disconnect' && req.method === 'POST') {
      return await this._apiCloudDisconnect(req, res);
    }

    // 404
    jsonResponse(res, { error: 'Not found', route }, 404);
  }

  // -----------------------------------------------------------------------
  // REST API handlers
  // -----------------------------------------------------------------------

  /**
   * GET /api/v1/memories?limit=50&offset=0
   * Lists memories from SQLite index with FTS content.
   */
  _apiListMemories(_req, res, url) {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    if (!this.indexer) {
      return jsonResponse(res, { items: [], total: 0 });
    }

    const rows = this.indexer.db
      .prepare(
        `SELECT m.*, f.content AS fts_content
         FROM memories m
         LEFT JOIN memories_fts f ON f.id = m.id
         WHERE m.status = 'active'
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset);

    const total = this.indexer.db
      .prepare(`SELECT COUNT(*) AS c FROM memories WHERE status = 'active'`)
      .get().c;

    return jsonResponse(res, { items: rows, total, limit, offset });
  }

  /**
   * GET /api/v1/memories/search?q=query&limit=20
   * Full-text search over memories via FTS5.
   */
  _apiSearchMemories(_req, res, url) {
    const q = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (!q || !this.indexer) {
      return jsonResponse(res, { items: [], total: 0, query: q });
    }

    const results = this.indexer.search(q, { limit });
    return jsonResponse(res, { items: results, total: results.length, query: q });
  }

  /**
   * GET /api/v1/knowledge?category=decision&limit=100
   * Lists knowledge cards, optionally filtered by category.
   */
  _apiListKnowledge(_req, res, url) {
    const category = url.searchParams.get('category') || null;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    if (!this.indexer) {
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

    const rows = this.indexer.db.prepare(sql).all(...params);
    return jsonResponse(res, { items: rows, total: rows.length });
  }

  /**
   * GET /api/v1/knowledge/:id/evolution
   * Returns the full evolution chain for a knowledge card.
   */
  _apiGetEvolutionChain(_req, res, cardId) {
    if (!this.indexer?.getEvolutionChain) {
      return jsonResponse(res, { card_id: cardId, chain_length: 0, evolution_chain: [] });
    }
    const chain = this.indexer.getEvolutionChain(cardId);
    return jsonResponse(res, {
      card_id: cardId,
      chain_length: chain.length,
      evolution_chain: chain,
    });
  }

  /**
   * DELETE /api/v1/knowledge/cleanup
   * Batch-delete knowledge cards whose title matches any of the provided regex patterns.
   * Request body: { patterns: ["^Tool:", "^Assistant:", ...] }
   * Response: { deleted: N }
   */
  async _apiCleanupKnowledge(req, res) {
    if (!this.indexer) {
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

    // Compile regex patterns
    let regexes;
    try {
      regexes = patterns.map(p => new RegExp(p));
    } catch (err) {
      return jsonResponse(res, { error: `Invalid regex: ${err.message}` }, 400);
    }

    // Query all active knowledge cards
    const allCards = this.indexer.db
      .prepare("SELECT id, title, filepath FROM knowledge_cards WHERE status = 'active'")
      .all();

    const toDelete = allCards.filter(card =>
      regexes.some(re => re.test(card.title))
    );

    if (toDelete.length === 0) {
      return jsonResponse(res, { deleted: 0 });
    }

    // Delete from SQLite tables + FTS index, and remove markdown files
    const deleteCard = this.indexer.db.prepare('DELETE FROM knowledge_cards WHERE id = ?');
    const deleteFts = this.indexer.db.prepare('DELETE FROM knowledge_fts WHERE id = ?');
    const deleteMany = this.indexer.db.transaction((cards) => {
      for (const card of cards) {
        deleteCard.run(card.id);
        deleteFts.run(card.id);
      }
    });
    deleteMany(toDelete);

    // Remove corresponding markdown files
    for (const card of toDelete) {
      if (card.filepath) {
        try { fs.unlinkSync(card.filepath); } catch { /* file may already be gone */ }
      }
    }

    return jsonResponse(res, { deleted: toDelete.length });
  }

  /**
   * GET /api/v1/tasks?status=open
   * Lists tasks sorted by priority then date.
   */
  _apiListTasks(_req, res, url) {
    const status = url.searchParams.get('status') || null;
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 0;

    if (!this.indexer) {
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

    const rows = this.indexer.db.prepare(sql).all(...params);
    return jsonResponse(res, { items: rows, total: rows.length });
  }

  /**
   * PUT /api/v1/tasks/:id — update task status/priority.
   */
  async _apiUpdateTask(req, res, taskId) {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return jsonResponse(res, { error: 'Invalid JSON' }, 400);
    }

    if (!this.indexer) {
      return jsonResponse(res, { error: 'Indexer not available' }, 503);
    }

    const task = this.indexer.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId);

    if (!task) {
      return jsonResponse(res, { error: 'Task not found' }, 404);
    }

    const newStatus = payload.status || task.status;
    const newPriority = payload.priority || task.priority;

    this.indexer.indexTask({
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

  /**
   * GET /api/v1/sync/status — cloud sync status from config.
   */
  _apiSyncStatus(_req, res) {
    const config = this._loadConfig();
    const cloud = config.cloud || {};

    const history = this.cloudSync ? this.cloudSync.getSyncHistory() : [];

    return jsonResponse(res, {
      cloud_enabled: !!cloud.enabled,
      api_base: cloud.api_base || null,
      memory_id: cloud.memory_id || null,
      auto_sync: cloud.auto_sync ?? true,
      last_push_at: cloud.last_push_at || null,
      last_pull_at: cloud.last_pull_at || null,
      history,
    });
  }

  /**
   * GET /api/v1/config — return config with redacted API key.
   */
  _apiGetConfig(_req, res) {
    const config = this._loadConfig();
    // Redact API key for security
    if (config.cloud && config.cloud.api_key) {
      const key = config.cloud.api_key;
      config.cloud.api_key = key.length > 8
        ? key.slice(0, 4) + '...' + key.slice(-4)
        : '****';
    }
    return jsonResponse(res, config);
  }

  /**
   * PUT /api/v1/config — partial config update (deep merge).
   */
  async _apiUpdateConfig(req, res) {
    const body = await readBody(req);
    let patch;
    try {
      patch = JSON.parse(body);
    } catch {
      return jsonResponse(res, { error: 'Invalid JSON' }, 400);
    }

    const configPath = path.join(this.awarenessDir, 'config.json');
    const config = this._loadConfig();

    // Deep merge patch into config (only known sections)
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

    // Redact API key in response
    if (config.cloud && config.cloud.api_key) {
      const key = config.cloud.api_key;
      config.cloud.api_key = key.length > 8
        ? key.slice(0, 4) + '...' + key.slice(-4)
        : '****';
    }

    return jsonResponse(res, { status: 'ok', config });
  }

  // -----------------------------------------------------------------------
  // Cloud Auth API (device-auth flow from Dashboard)
  // -----------------------------------------------------------------------

  async _apiCloudAuthOpenBrowser(req, res) {
    const body = await readBody(req);
    let params;
    try { params = JSON.parse(body); } catch { return jsonResponse(res, { error: 'Invalid JSON' }, 400); }
    const { url: targetUrl } = params;
    if (!targetUrl || typeof targetUrl !== 'string') {
      return jsonResponse(res, { error: 'url required' }, 400);
    }
    // Only allow opening our own auth URLs
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

  async _apiCloudAuthStart(_req, res) {
    const apiBase = this.config?.cloud?.api_base || 'https://awareness.market/api/v1';
    try {
      const data = await this._httpJson('POST', `${apiBase}/auth/device/init`, {});
      return jsonResponse(res, data);
    } catch (err) {
      return jsonResponse(res, { error: 'Failed to start auth: ' + err.message }, 502);
    }
  }

  async _apiCloudAuthPoll(req, res) {
    const body = await readBody(req);
    let params;
    try { params = JSON.parse(body); } catch { return jsonResponse(res, { error: 'Invalid JSON' }, 400); }

    const config = this._loadConfig();
    const apiBase = config?.cloud?.api_base || 'https://awareness.market/api/v1';

    // SECURITY C5: Don't hold connection for 5 minutes.
    // Poll a few times (max 30s), then return pending for client to retry.
    const interval = Math.max((params.interval || 5) * 1000, 3000);
    const maxPolls = Math.min(Math.floor(30000 / interval), 6);

    for (let i = 0; i < maxPolls; i++) {
      try {
        const data = await this._httpJson('POST', `${apiBase}/auth/device/poll`, {
          device_code: params.device_code,
        });
        if (data.status === 'approved' && data.api_key) {
          return jsonResponse(res, { api_key: data.api_key });
        }
        if (data.status === 'expired') {
          return jsonResponse(res, { error: 'Auth expired' }, 410);
        }
      } catch { /* continue polling */ }
      await new Promise(r => setTimeout(r, interval));
    }
    return jsonResponse(res, { error: 'Auth timeout' }, 408);
  }

  async _apiCloudListMemories(req, res, url) {
    // Accept api_key from query param (during auth flow, before config is saved)
    // or fall back to saved config (for subsequent calls)
    const config = this._loadConfig();
    const apiKey = url.searchParams.get('api_key') || config?.cloud?.api_key;
    if (!apiKey) return jsonResponse(res, { error: 'Cloud not configured. Connect via /api/v1/cloud/connect first.' }, 400);

    const apiBase = this.config?.cloud?.api_base || 'https://awareness.market/api/v1';
    try {
      const data = await this._httpJson('GET', `${apiBase}/memories`, null, {
        'Authorization': `Bearer ${apiKey}`,
      });
      return jsonResponse(res, data);
    } catch (err) {
      return jsonResponse(res, { error: 'Failed to list memories: ' + err.message }, 502);
    }
  }

  async _apiCloudConnect(req, res) {
    const body = await readBody(req);
    let params;
    try { params = JSON.parse(body); } catch { return jsonResponse(res, { error: 'Invalid JSON' }, 400); }

    const { api_key, memory_id } = params;
    if (!api_key) return jsonResponse(res, { error: 'api_key required' }, 400);

    // Save cloud config
    const configPath = path.join(this.awarenessDir, 'config.json');
    const config = this._loadConfig();
    config.cloud = {
      ...config.cloud,
      enabled: true,
      api_key,
      memory_id: memory_id || '',
      auto_sync: true,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.config = config;

    // Start cloud sync if not already running
    if (this.cloudSync) {
      this.cloudSync.stop();
    }
    try {
      const { CloudSync } = await import('./core/cloud-sync.mjs');
      this.cloudSync = new CloudSync(config, this.indexer, this.memoryStore);
      this.cloudSync.start().catch(err => {
        console.warn('[awareness-local] cloud sync start failed:', err.message);
      });
    } catch { /* CloudSync not available */ }

    return jsonResponse(res, { status: 'ok', cloud_enabled: true });
  }

  async _apiCloudDisconnect(_req, res) {
    const configPath = path.join(this.awarenessDir, 'config.json');
    const config = this._loadConfig();
    config.cloud = { ...config.cloud, enabled: false, api_key: '', memory_id: '' };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.config = config;

    if (this.cloudSync) {
      this.cloudSync.stop();
      this.cloudSync = null;
    }

    return jsonResponse(res, { status: 'ok', cloud_enabled: false });
  }

  /** Simple HTTP JSON request helper for cloud API calls. */
  async _httpJson(method, urlStr, body = null, extraHeaders = {}) {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpMod = isHttps ? (await import('https')).default : (await import('http')).default;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
      };

      const req = httpMod.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });

      if (body !== null) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  // -----------------------------------------------------------------------
  // Web UI
  // -----------------------------------------------------------------------

  /**
   * Serve the web dashboard SPA from web/index.html.
   */
  _handleWebUI(_req, res) {
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const htmlPath = path.join(thisDir, 'web', 'index.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
        return;
      }
    } catch (err) {
      console.error('[awareness-local] failed to load web UI:', err.message);
    }

    // Fallback if index.html not found
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

  // -----------------------------------------------------------------------
  // Engine methods (called by MCP tools)
  // -----------------------------------------------------------------------

  /**
   * Search for knowledge cards relevant to a user query.
   * Uses FTS5 trigram (with CJK n-gram splitting) + embedding dual-channel.
   *
   * @param {string} query - User's prompt text
   * @param {number} limit - Max cards to return
   * @returns {Promise<object[]>} Knowledge card rows
   */
  async _searchRelevantCards(query, limit) {
    const results = new Map(); // id → { card, score }

    // Channel 1: FTS5 search (sanitiseFtsQuery now handles CJK trigram splitting)
    if (this.indexer.searchKnowledge) {
      try {
        const ftsResults = this.indexer.searchKnowledge(query, { limit: limit * 2 });
        for (const r of ftsResults) {
          results.set(r.id, { card: r, score: 1 / (60 + (results.size + 1)) });
        }
      } catch { /* FTS error — skip */ }
    }

    // Channel 2: Embedding cosine similarity (if available)
    if (this._embedder) {
      try {
        const available = await this._embedder.isEmbeddingAvailable();
        if (available) {
          const queryVec = await this._embedder.embed(query, 'query');
          const allCards = this.indexer.db
            .prepare("SELECT * FROM knowledge_cards WHERE status = 'active' ORDER BY created_at DESC LIMIT 50")
            .all();
          for (const card of allCards) {
            const cardText = `${card.title || ''} ${card.summary || ''}`.trim();
            if (!cardText) continue;
            try {
              const cardVec = await this._embedder.embed(cardText, 'passage');
              const sim = this._embedder.cosineSimilarity(queryVec, cardVec);
              const existing = results.get(card.id);
              const ftsScore = existing?.score || 0;
              results.set(card.id, { card, score: ftsScore + sim });
            } catch { /* skip individual card errors */ }
          }
        }
      } catch { /* Embedder not available — FTS-only */ }
    }

    // Sort by combined score descending
    const sorted = [...results.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.card);

    // Supplement with recent cards if not enough results
    if (sorted.length < limit) {
      const matchedIds = new Set(sorted.map(c => c.id));
      const recent = this.indexer.getRecentKnowledge(limit)
        .filter(c => !matchedIds.has(c.id));
      return [...sorted, ...recent].slice(0, limit);
    }
    return sorted;
  }

  /** Create a new session and return session metadata. */
  _createSession(source) {
    return this.indexer.createSession(source || 'local');
  }

  /** Max content size per memory (1 MB). */
  static MAX_CONTENT_BYTES = 1024 * 1024;

  /** Write a single memory, index it, and trigger knowledge extraction. */
  async _remember(params) {
    // Skip session_checkpoint — these are low-value truncated response snippets
    // that pollute recall results. Meaningful content is saved via record-rule.
    if (params.event_type === 'session_checkpoint') {
      return { status: 'skipped', reason: 'session_checkpoint filtered' };
    }
    if (!params.content) {
      return { error: 'content is required for remember action' };
    }
    // SECURITY H1: Reject oversized content to prevent FTS5/embedding freeze
    if (typeof params.content === 'string' && params.content.length > AwarenessLocalDaemon.MAX_CONTENT_BYTES) {
      return { error: `Content too large (${params.content.length} bytes, max ${AwarenessLocalDaemon.MAX_CONTENT_BYTES})` };
    }

    // Auto-generate title from content if not provided
    let title = params.title || '';
    if (!title && params.content) {
      // Take first sentence or first 80 chars, whichever is shorter
      const firstLine = params.content.split(/[.\n!?。！？]/)[0].trim();
      title = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;
    }

    const memory = {
      type: params.event_type || 'turn_summary',
      content: params.content,
      title,
      tags: params.tags || [],
      agent_role: params.agent_role || 'builder_agent',
      session_id: params.session_id || '',
      source: 'mcp',
    };

    // Write markdown file
    const { id, filepath } = await this.memoryStore.write(memory);

    // Index in SQLite
    this.indexer.indexMemory(id, { ...memory, filepath }, params.content);

    // Generate and store embedding for vector search (fire-and-forget)
    this._embedAndStore(id, params.content).catch(() => {});

    // Knowledge extraction (fire-and-forget)
    this._extractAndIndex(id, params.content, memory, params.insights);

    // Cloud sync (fire-and-forget — don't block the response)
    if (this.cloudSync?.isEnabled()) {
      Promise.all([
        this.cloudSync.syncToCloud(),
        this.cloudSync.syncInsightsToCloud(),
        this.cloudSync.syncTasksToCloud(),
      ]).catch((err) => {
        console.warn('[awareness-local] cloud sync after remember failed:', err.message);
      });
    }

    // Perception: surface signals the agent didn't ask about (Eywa Whisper)
    const perception = this._buildPerception(params.content, title, memory, params.insights);

    const result = {
      status: 'ok',
      id,
      filepath,
      mode: 'local',
    };

    if (perception && perception.length > 0) {
      result.perception = perception;
    }

    return result;
  }

  /**
   * Build perception signals after a record operation (Eywa Whisper).
   *
   * Unlike recall (agent asks a question), perception is the system
   * noticing something the agent didn't ask about:
   * - resonance: similar past knowledge exists
   * - pattern: recurring category/theme detected (3+)
   * - staleness: related knowledge is old
   *
   * Zero LLM. Pure SQLite queries. Target: <20ms.
   *
   * @param {string} content - The content being recorded
   * @param {string} title - Auto-generated or provided title
   * @param {Object} memory - The memory metadata object
   * @param {Object} [insights] - Optional pre-extracted insights
   * @returns {Array<Object>} perception signals (max 5)
   */
  _buildPerception(content, title, memory, insights) {
    const signals = [];

    try {
      // 1. Resonance: find similar existing knowledge cards via FTS5
      if (title && title.length >= 5) {
        const resonanceResults = this.indexer.searchKnowledge(title, { limit: 2 });
        for (const r of resonanceResults) {
          // BM25 rank: closer to 0 = better match. Only surface strong matches.
          if (r.rank > -3.0) {
            const daysAgo = r.created_at
              ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000)
              : 0;
            signals.push({
              type: 'resonance',
              title: r.title,
              summary: (r.summary || '').slice(0, 150),
              category: r.category || '',
              card_id: r.id,
              days_ago: daysAgo,
              message: `🌿 Similar past experience (${daysAgo}d ago): "${r.title}"`,
            });
          }
        }
      }

      // 2. Pattern: detect recurring categories (3+ cards of same category)
      if (insights?.knowledge_cards?.length) {
        for (const card of insights.knowledge_cards) {
          const cat = card.category;
          if (!cat) continue;
          try {
            const row = this.indexer.db
              .prepare(`SELECT COUNT(*) AS cnt FROM knowledge_cards WHERE category = ? AND status = 'active'`)
              .get(cat);
            const count = row?.cnt || 0;
            if (count >= 3) {
              signals.push({
                type: 'pattern',
                category: cat,
                count: count + 1, // +1 for the one being written now
                message: `🔄 Pattern: this is the ${this._ordinal(count + 1)} '${cat}' card — recurring theme`,
              });
            }
          } catch { /* ignore */ }
        }
      }

      // 3. Staleness: find related but old knowledge (reuse searchKnowledge for FTS safety)
      if (title && title.length >= 5) {
        try {
          const relatedResults = this.indexer.searchKnowledge(title, { limit: 3 });
          for (const r of relatedResults) {
            if (!r.updated_at) continue;
            const daysOld = Math.floor(
              (Date.now() - new Date(r.updated_at).getTime()) / 86400000
            );
            if (daysOld >= 60) {
              signals.push({
                type: 'staleness',
                title: r.title,
                category: r.category || '',
                card_id: r.id,
                days_since_update: daysOld,
                message: `⏳ Related knowledge "${r.title}" hasn't been updated in ${daysOld} days`,
              });
              break; // Only 1 staleness signal
            }
          }
        } catch { /* FTS query may fail on special chars */ }
      }

      // 4. Contradiction: surface recently superseded cards (1-day window)
      try {
        const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
        const superseded = this.indexer.db
          .prepare(
            `SELECT id, title, category, summary FROM knowledge_cards
             WHERE status = 'superseded' AND updated_at > ?
             ORDER BY updated_at DESC LIMIT 2`
          )
          .all(oneDayAgo);
        for (const r of superseded) {
          signals.push({
            type: 'contradiction',
            title: r.title,
            summary: (r.summary || '').slice(0, 150),
            card_id: r.id,
            message: `⚡ This may contradict a prior belief: "${r.title}"`,
          });
        }
      } catch { /* ignore */ }

      // 5. Related_decision: find prior decisions with overlapping tags
      if (insights?.knowledge_cards?.length) {
        try {
          const newTags = new Set();
          for (const card of insights.knowledge_cards) {
            const tags = card.tags || [];
            for (const tag of (Array.isArray(tags) ? tags : [])) {
              if (typeof tag === 'string' && tag.length >= 2) {
                newTags.add(tag.toLowerCase());
              }
            }
          }
          if (newTags.size > 0) {
            const decisions = this.indexer.db
              .prepare(
                `SELECT id, title, summary, tags FROM knowledge_cards
                 WHERE category = 'decision' AND status = 'active'
                 ORDER BY created_at DESC LIMIT 20`
              )
              .all();
            for (const d of decisions) {
              let cardTags = [];
              try { cardTags = JSON.parse(d.tags || '[]'); } catch { /* skip */ }
              const overlap = cardTags.some(t => typeof t === 'string' && newTags.has(t.toLowerCase()));
              if (overlap) {
                signals.push({
                  type: 'related_decision',
                  title: d.title,
                  summary: (d.summary || '').slice(0, 150),
                  card_id: d.id,
                  message: `📌 Related prior decision: "${d.title}"`,
                });
                if (signals.filter(s => s.type === 'related_decision').length >= 2) break;
              }
            }
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      // Perception is best-effort, never block the write
      if (process.env.DEBUG) {
        console.warn('[awareness-local] perception failed:', err.message);
      }
    }

    return signals.slice(0, 5); // Cap at 5 signals
  }

  /** Return ordinal string (1st, 2nd, 3rd, etc.) */
  _ordinal(n) {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return `${n}${suffix}`;
  }

  /** Write multiple memories in batch. */
  async _rememberBatch(params) {
    const items = params.items || [];
    if (!items.length) {
      return { error: 'items array is required for remember_batch' };
    }

    // Batch-level insights go to the last item (summary item)
    const batchInsights = params.insights || null;

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const result = await this._remember({
        content: item.content,
        title: item.title,
        event_type: item.event_type,
        tags: item.tags,
        insights: item.insights || (isLast ? batchInsights : null),
        session_id: params.session_id,
        agent_role: params.agent_role,
      });
      results.push(result);
    }

    return {
      status: 'ok',
      count: results.length,
      items: results,
      mode: 'local',
    };
  }

  /** Update a task's status. */
  async _updateTask(params) {
    if (!params.task_id) {
      return { error: 'task_id is required for update_task' };
    }

    const task = this.indexer.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(params.task_id);

    if (!task) {
      return { error: `Task not found: ${params.task_id}` };
    }

    this.indexer.indexTask({
      ...task,
      status: params.status || task.status,
      updated_at: nowISO(),
    });

    return {
      status: 'ok',
      task_id: params.task_id,
      new_status: params.status || task.status,
      mode: 'local',
    };
  }

  /** Process pre-extracted insights and index them. */
  async _submitInsights(params) {
    const insights = params.insights || {};
    let cardsCreated = 0;
    let tasksCreated = 0;

    // Process knowledge cards
    if (Array.isArray(insights.knowledge_cards)) {
      for (const card of insights.knowledge_cards) {
        const cardId = `kc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const cardFilepath = path.join(
          this.awarenessDir,
          'knowledge',
          card.category || 'insights',
          `${cardId}.md`
        );

        // Ensure category directory exists
        fs.mkdirSync(path.dirname(cardFilepath), { recursive: true });

        // Write markdown file for the card
        const cardContent = `---
id: ${cardId}
category: ${card.category || 'insight'}
title: "${(card.title || '').replace(/"/g, '\\"')}"
confidence: ${card.confidence ?? 0.8}
status: ${card.status || 'active'}
tags: ${JSON.stringify(card.tags || [])}
created_at: ${nowISO()}
---

${card.summary || card.title || ''}
`;
        fs.mkdirSync(path.dirname(cardFilepath), { recursive: true });
        fs.writeFileSync(cardFilepath, cardContent, 'utf-8');

        this.indexer.indexKnowledgeCard({
          id: cardId,
          category: card.category || 'insight',
          title: card.title || '',
          summary: card.summary || '',
          source_memories: JSON.stringify([]),
          confidence: card.confidence ?? 0.8,
          status: card.status || 'active',
          tags: card.tags || [],
          created_at: nowISO(),
          filepath: cardFilepath,
          content: card.summary || card.title || '',
        });

        cardsCreated++;
      }
    }

    // Process action items / tasks
    if (Array.isArray(insights.action_items)) {
      for (const item of insights.action_items) {
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const taskFilepath = path.join(
          this.awarenessDir, 'tasks', 'open', `${taskId}.md`
        );

        const taskContent = `---
id: ${taskId}
title: "${(item.title || '').replace(/"/g, '\\"')}"
priority: ${item.priority || 'medium'}
status: ${item.status || 'open'}
created_at: ${nowISO()}
---

${item.description || item.title || ''}
`;
        fs.mkdirSync(path.dirname(taskFilepath), { recursive: true });
        fs.writeFileSync(taskFilepath, taskContent, 'utf-8');

        this.indexer.indexTask({
          id: taskId,
          title: item.title || '',
          description: item.description || '',
          status: item.status || 'open',
          priority: item.priority || 'medium',
          agent_role: params.agent_role || null,
          created_at: nowISO(),
          updated_at: nowISO(),
          filepath: taskFilepath,
        });

        tasksCreated++;
      }
    }

    // Auto-complete tasks identified by the LLM
    let tasksAutoCompleted = 0;
    if (Array.isArray(insights.completed_tasks)) {
      for (const completed of insights.completed_tasks) {
        const taskId = (completed.task_id || '').trim();
        if (!taskId) continue;
        try {
          const existing = this.indexer.db
            .prepare('SELECT * FROM tasks WHERE id = ?')
            .get(taskId);
          if (existing && existing.status !== 'done') {
            this.indexer.indexTask({
              ...existing,
              status: 'done',
              updated_at: nowISO(),
            });
            tasksAutoCompleted++;
          }
        } catch (err) {
          console.warn(`[AwarenessDaemon] Failed to auto-complete task '${taskId}':`, err.message);
        }
      }
    }

    return {
      status: 'ok',
      cards_created: cardsCreated,
      tasks_created: tasksCreated,
      tasks_auto_completed: tasksAutoCompleted,
      mode: 'local',
    };
  }

  /** Handle structured data lookups. */
  async _lookup(params) {
    const { type, limit = 10, status, category, priority, session_id, agent_role, query } = params;

    switch (type) {
      case 'context': {
        // Full context dump with preference separation
        const stats = this.indexer.getStats();
        const knowledge = this.indexer.getRecentKnowledge(limit);
        const tasks = this.indexer.getOpenTasks(0);
        const rawSessions = this.indexer.getRecentSessions(7);
        // De-noise: only sessions with content; fallback to 3 most recent
        let sessions = rawSessions.filter(s => s.memory_count > 0 || s.summary);
        if (sessions.length === 0) sessions = rawSessions.slice(0, 3);
        sessions = sessions.slice(0, 5);
        const { user_preferences, knowledge_cards: otherCards } = splitPreferences(knowledge);
        return { stats, user_preferences, knowledge_cards: otherCards, open_tasks: tasks, recent_sessions: sessions, mode: 'local' };
      }

      case 'tasks': {
        let sql = 'SELECT * FROM tasks';
        const conditions = [];
        const sqlParams = [];

        if (status) {
          conditions.push('status = ?');
          sqlParams.push(status);
        } else {
          conditions.push("status = 'open'");
        }
        if (priority) {
          conditions.push('priority = ?');
          sqlParams.push(priority);
        }
        if (agent_role) {
          conditions.push('agent_role = ?');
          sqlParams.push(agent_role);
        }

        if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY created_at DESC';
        if (limit > 0) {
          sql += ' LIMIT ?';
          sqlParams.push(limit);
        }

        const tasks = this.indexer.db.prepare(sql).all(...sqlParams);
        return { tasks, total: tasks.length, mode: 'local' };
      }

      case 'knowledge': {
        let sql = 'SELECT * FROM knowledge_cards';
        const conditions = [];
        const sqlParams = [];

        if (status) {
          conditions.push('status = ?');
          sqlParams.push(status);
        } else {
          conditions.push("status = 'active'");
        }
        if (category) {
          conditions.push('category = ?');
          sqlParams.push(category);
        }

        if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY created_at DESC LIMIT ?';
        sqlParams.push(limit);

        const cards = this.indexer.db.prepare(sql).all(...sqlParams);
        return { knowledge_cards: cards, total: cards.length, mode: 'local' };
      }

      case 'risks': {
        // Risks are stored as knowledge_cards with category containing 'risk' or 'pitfall'
        let sql = "SELECT * FROM knowledge_cards WHERE (category = 'pitfall' OR category = 'risk')";
        const sqlParams = [];

        if (status) {
          sql += ' AND status = ?';
          sqlParams.push(status);
        } else {
          sql += " AND status = 'active'";
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        sqlParams.push(limit);

        const risks = this.indexer.db.prepare(sql).all(...sqlParams);
        return { risks, total: risks.length, mode: 'local' };
      }

      case 'session_history': {
        let sql = 'SELECT * FROM sessions';
        const conditions = [];
        const sqlParams = [];

        if (session_id) {
          conditions.push('id = ?');
          sqlParams.push(session_id);
        }

        if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY started_at DESC LIMIT ?';
        sqlParams.push(limit);

        const sessions = this.indexer.db.prepare(sql).all(...sqlParams);
        return { sessions, total: sessions.length, mode: 'local' };
      }

      case 'timeline': {
        // Timeline = recent memories ordered by time
        const memories = this.indexer.db
          .prepare(
            "SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ?"
          )
          .all(limit);
        return { events: memories, total: memories.length, mode: 'local' };
      }

      default:
        return { error: `Unknown lookup type: ${type}`, mode: 'local' };
    }
  }

  // -----------------------------------------------------------------------
  // Knowledge extraction
  // -----------------------------------------------------------------------

  /**
   * Pre-warm the embedding model (downloads on first run, ~23MB) then backfill.
   * Runs in background — daemon is fully usable during warmup via FTS5 fallback.
   */
  async _warmupEmbedder() {
    if (!this._embedder) return;
    try {
      const available = await this._embedder.isEmbeddingAvailable();
      if (!available) {
        console.warn('[awareness-local] Embedding library not available — FTS5-only mode');
        return;
      }
      console.log('[awareness-local] Pre-warming embedding model (first run downloads ~23MB)...');
      await this._embedder.embed('warmup', 'query');
      console.log('[awareness-local] Embedding model ready — hybrid search active');
    } catch (err) {
      console.warn('[awareness-local] Embedding warmup failed:', err.message);
      return; // skip backfill if model can't load
    }
    // Model is warm — now backfill old memories
    await this._backfillEmbeddings();
  }

  /**
   * Backfill embeddings for memories that were indexed before vector search was enabled.
   * Runs in background on startup — processes in batches to avoid blocking.
   */
  async _backfillEmbeddings() {
    if (!this._embedder) return;
    // memories table has no content column — get IDs missing embeddings, read content from files
    const missing = this.indexer.db
      .prepare('SELECT id, filepath FROM memories WHERE id NOT IN (SELECT memory_id FROM embeddings)')
      .all();
    if (missing.length === 0) return;
    console.log(`[awareness-local] backfilling embeddings for ${missing.length} memories...`);
    let done = 0;
    for (const mem of missing) {
      try {
        const result = await this.memoryStore.read(mem.id);
        if (result?.content) {
          await this._embedAndStore(mem.id, result.content);
          done++;
        }
      } catch {
        // File may be missing or corrupt — skip silently
      }
    }
    console.log(`[awareness-local] embedding backfill complete: ${done}/${missing.length} memories embedded`);
  }

  /**
   * Generate embedding for a memory and store it in the index.
   * Fire-and-forget — errors are logged but don't block the record flow.
   */
  async _embedAndStore(memoryId, content) {
    if (!this._embedder || !content) return;
    try {
      const vector = await this._embedder.embed(content, 'passage');
      if (vector) {
        const modelId = this._embedder.MODEL_MAP?.english || 'all-MiniLM-L6-v2';
        this.indexer.storeEmbedding(memoryId, vector, modelId);
      }
    } catch (err) {
      // Embedding generation failed — FTS5 still indexed, no data loss
      console.warn('[awareness-local] embedding failed for', memoryId, ':', err.message);
    }
  }

  /**
   * Extract knowledge from a newly recorded memory and index the results.
   * Fire-and-forget — errors are logged but don't fail the record.
   */
  async _extractAndIndex(memoryId, content, metadata, preExtractedInsights) {
    try {
      if (!this.extractor) return;

      // extractor.extract() internally calls _persistAll() which:
      // - Saves knowledge cards to .awareness/knowledge/*.md + indexes them
      // - Saves tasks to .awareness/tasks/*.md + indexes them
      // - Saves risks as knowledge cards with category 'risk'
      // So we just call extract() — no need to manually persist again.
      await this.extractor.extract(content, metadata, preExtractedInsights);
    } catch (err) {
      console.error('[awareness-local] extraction error:', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // File watcher
  // -----------------------------------------------------------------------

  /** Start watching .awareness/memories/ for changes (debounced reindex). */
  _startFileWatcher() {
    const memoriesDir = path.join(this.awarenessDir, 'memories');
    if (!fs.existsSync(memoriesDir)) return;

    try {
      this.watcher = fs.watch(memoriesDir, { recursive: true }, () => {
        // Debounce: wait for writes to settle before reindexing
        if (this._reindexTimer) clearTimeout(this._reindexTimer);
        this._reindexTimer = setTimeout(async () => {
          try {
            if (this.indexer && this.memoryStore) {
              const result = await this.indexer.incrementalIndex(this.memoryStore);
              if (result.indexed > 0) {
                console.log(
                  `[awareness-local] auto-indexed ${result.indexed} changed files`
                );
              }
            }
          } catch (err) {
            console.error('[awareness-local] auto-reindex error:', err.message);
          }
        }, this._reindexDebounceMs);
      });
    } catch (err) {
      console.error('[awareness-local] fs.watch setup failed:', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Config & spec loading
  // -----------------------------------------------------------------------

  /** Load .awareness/config.json (or return defaults). */
  _loadConfig() {
    try {
      const configPath = path.join(this.awarenessDir, 'config.json');
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return { daemon: { port: this.port } };
  }

  /** Load awareness-spec.json from the bundled spec directory. */
  _loadSpec() {
    try {
      // Resolve relative to this file's directory
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const specPath = path.join(thisDir, 'spec', 'awareness-spec.json');
      if (fs.existsSync(specPath)) {
        return JSON.parse(fs.readFileSync(specPath, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return { core_lines: [], init_guides: {} };
  }

  // -----------------------------------------------------------------------
  // Dynamic module loading
  // -----------------------------------------------------------------------

  /**
   * Lazy-load the embedder module (shared by SearchEngine + KnowledgeExtractor).
   * Caches at this._embedder. Returns null when unavailable (graceful degradation).
   */
  async _loadEmbedder() {
    if (this._embedder !== undefined) return this._embedder;
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const embedderPath = path.join(thisDir, 'core', 'embedder.mjs');
      if (fs.existsSync(embedderPath)) {
        this._embedder = await import(pathToFileURL(embedderPath).href);
        console.log('[awareness-local] Embedder loaded — hybrid vector+FTS5 search enabled');
        return this._embedder;
      }
    } catch (err) {
      console.warn('[awareness-local] Embedder unavailable, FTS5-only mode:', err.message);
    }
    this._embedder = null;
    return null;
  }

  /** Try to load SearchEngine from Phase 1 core. Returns null if not available. */
  async _loadSearchEngine() {
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const modPath = path.join(thisDir, 'core', 'search.mjs');
      if (fs.existsSync(modPath)) {
        const mod = await import(pathToFileURL(modPath).href);
        const SearchEngine = mod.SearchEngine || mod.default;
        if (SearchEngine) {
          const embedder = await this._loadEmbedder();
          return new SearchEngine(this.indexer, this.memoryStore, embedder);
        }
      }
    } catch (err) {
      console.warn('[awareness-local] SearchEngine not available:', err.message);
    }
    return null;
  }

  /** Try to load KnowledgeExtractor from Phase 1 core. Returns null if not available. */
  async _loadKnowledgeExtractor() {
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const modPath = path.join(thisDir, 'core', 'knowledge-extractor.mjs');
      if (fs.existsSync(modPath)) {
        const mod = await import(pathToFileURL(modPath).href);
        const KnowledgeExtractor = mod.KnowledgeExtractor || mod.default;
        if (KnowledgeExtractor) {
          const embedder = await this._loadEmbedder();
          return new KnowledgeExtractor(this.memoryStore, this.indexer, embedder);
        }
      }
    } catch (err) {
      console.warn(
        '[awareness-local] KnowledgeExtractor not available:',
        err.message
      );
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  /** Remove stale PID file. */
  _cleanPidFile() {
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch {
      // ignore
    }
  }
}

export default AwarenessLocalDaemon;
