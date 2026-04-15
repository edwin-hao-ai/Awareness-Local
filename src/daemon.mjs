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
import { fileURLToPath } from 'node:url';
import { detectNeedsCJK } from './core/lang-detect.mjs';
import { detectGuardSignals } from './core/guard-detector.mjs';
import { classifyNoiseEvent } from './core/noise-filter.mjs';
import { createRequire } from 'node:module';
import {
  AWARENESS_DIR,
  BIND_HOST,
  DEFAULT_PORT,
  LOG_FILENAME,
  PID_FILENAME,
} from './daemon/constants.mjs';
import {
  createNoopIndexer,
  httpHealthCheck,
  jsonResponse,
  nowISO,
  splitPreferences,
} from './daemon/helpers.mjs';
import {
  loadDaemonConfig,
  loadDaemonSpec,
  loadEmbedderModule,
  loadKnowledgeExtractorModule,
  loadSearchEngineModule,
} from './daemon/loaders.mjs';
import {
  getToolDefinitions,
} from './daemon/mcp-contract.mjs';
import { handleApiRoute } from './daemon/api-handlers.mjs';
import {
  dispatchJsonRpcRequest,
  handleMcpHttp,
} from './daemon/mcp-http.mjs';
import { handleHealthz, handleWebUi } from './daemon/http-handlers.mjs';
import { callMcpTool } from './daemon/tool-bridge.mjs';
import { httpJson } from './daemon/cloud-http.mjs';
import { startFileWatcher, startWorkspaceWatcher, startGitHeadWatcher } from './daemon/file-watcher.mjs';
import { scanWorkspace, indexWorkspaceFiles, getGitChanges, getCurrentCommit, isGitRepo, markDeletedFiles, handleRenamedFiles } from './core/workspace-scanner.mjs';
import { loadScanState, saveScanState, createScanState, updateScanState, appendScanError } from './core/scan-state.mjs';
import { loadScanConfig } from './core/scan-config.mjs';
import { initTelemetry, getTelemetry } from './core/telemetry.mjs';
import { loadGitignoreRules } from './core/gitignore-parser.mjs';
import { classifyFile } from './core/scan-defaults.mjs';
import {
  backfillEmbeddings,
  embedAndStore,
  extractAndIndex,
  warmupEmbedder,
} from './daemon/embedding-helpers.mjs';
import { runGraphEmbeddingPipeline } from './daemon/graph-embedder.mjs';

// Read version from package.json (not hardcoded)
const __daemon_dirname = path.dirname(fileURLToPath(import.meta.url));
let PKG_VERSION = '0.4.0';
try {
  const require = createRequire(import.meta.url);
  const pkg = require(path.join(__daemon_dirname, '..', 'package.json'));
  PKG_VERSION = pkg.version || PKG_VERSION;
} catch { /* fallback */ }

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
import { runLifecycleChecks, validateTaskQuality, checkTaskDedup } from './core/lifecycle-manager.mjs';

// ---------------------------------------------------------------------------
// F-034: Crystallization local helper
// ---------------------------------------------------------------------------

/** Eligible categories for F-034 crystallization detection */
const _CRYST_CATEGORIES = new Set(['workflow', 'decision', 'problem_solution']);

/** Minimum similar pre-existing cards required to trigger a hint */
const _CRYST_MIN_SIMILAR = 2;

/** Maximum cards to include in the hint */
const _CRYST_MAX_CARDS = 5;

/**
 * Check if a newly created card triggers a crystallization hint.
 * Uses SQLite FTS5 trigram search on knowledge_fts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, title: string, summary: string, category: string }} newCard
 * @returns {{ topic: string, similar_cards: Array, categories: string[] } | null}
 */
function _checkCrystallizationLocal(db, newCard) {
  try {
    if (!_CRYST_CATEGORIES.has(newCard.category)) return null;

    // Build query terms from title + summary (first 120 chars)
    const queryText = `${newCard.title} ${(newCard.summary || '').slice(0, 120)}`.trim();
    if (queryText.length < 5) return null;

    // FTS5 trigram search — exclude the card itself, restrict to eligible categories
    const cats = [..._CRYST_CATEGORIES].map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT kc.id, kc.title, kc.summary, kc.category
      FROM knowledge_cards kc
      JOIN knowledge_fts fts ON fts.id = kc.id
      WHERE knowledge_fts MATCH ?
        AND kc.id != ?
        AND kc.category IN (${cats})
        AND kc.status NOT IN ('superseded', 'archived')
      LIMIT ?
    `).all(queryText, newCard.id, ...[..._CRYST_CATEGORIES], _CRYST_MAX_CARDS + 5);

    if (rows.length < _CRYST_MIN_SIMILAR) return null;

    // Check if a skill already exists covering this topic
    const existingSkill = db.prepare(
      `SELECT id FROM skills WHERE lower(name) LIKE ? AND status != 'archived' LIMIT 1`
    ).get(`%${newCard.title.slice(0, 20).toLowerCase()}%`);
    if (existingSkill) return null;

    const similarCards = rows.slice(0, _CRYST_MAX_CARDS).map(r => ({
      id: r.id,
      title: r.title,
      summary: (r.summary || '').slice(0, 200),
    }));

    const categories = [...new Set(rows.map(r => r.category))];

    return {
      topic: newCard.title,
      similar_cards: similarCards,
      categories,
    };
  } catch (err) {
    console.warn('[AwarenessDaemon] Crystallization check failed:', err.message);
    return null;
  }
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
    this.guardProfile = options.guardProfile || detectGuardProfile(this.projectDir);

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

    // Skill decay timer (runs every 24h)
    this._skillDecayTimer = null;

    // F-038: Workspace scanner state
    this.scanState = createScanState();
    this.scanConfig = null;
    this._scanAbortController = null;
    this._workspaceWatcher = null;
    this._gitHeadWatcher = null;

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
      // Auto-rebuild better-sqlite3 when Node.js major version has changed
      if (e.message && e.message.includes('NODE_MODULE_VERSION')) {
        const rebuilt = await this._tryRebuildBetterSqlite(e.message);
        if (rebuilt) {
          try {
            this.indexer = new Indexer(path.join(this.awarenessDir, 'index.db'));
          } catch (e2) {
            console.error(`[awareness-local] SQLite still unavailable after rebuild: ${e2.message}`);
            this.indexer = createNoopIndexer();
          }
        } else {
          this.indexer = createNoopIndexer();
        }
      } else {
        console.error(`[awareness-local] SQLite indexer unavailable: ${e.message}`);
        console.error('[awareness-local] Falling back to file-only mode (no search). Install better-sqlite3: npm install better-sqlite3');
        this.indexer = createNoopIndexer();
      }
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

    // ---- Telemetry (opt-in) ----
    try {
      const cfg = this._loadConfig();
      initTelemetry({ config: cfg, projectDir: this.projectDir, version: PKG_VERSION });
      const tel = getTelemetry();
      tel?.track('daemon_started', {
        daemon_version: PKG_VERSION,
        os: process.platform,
        node_version: process.version,
        arch: process.arch,
        locale: (Intl.DateTimeFormat().resolvedOptions().locale) || 'unknown',
      });
    } catch (err) {
      // Never let telemetry init block daemon startup.
      console.warn('[awareness-local] telemetry init failed:', err.message);
    }

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

    // ---- F-038: Workspace scanner (background, non-blocking) ----
    this._initWorkspaceScanner();

    // ---- Skill decay timer (every 24h) ----
    this._startSkillDecayTimer();

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
    if (this._skillDecayTimer) {
      clearInterval(this._skillDecayTimer);
      this._skillDecayTimer = null;
    }

    // Stop workspace watchers (F-038)
    if (this._scanAbortController) {
      this._scanAbortController.abort();
      this._scanAbortController = null;
    }
    if (this._workspaceWatcher) {
      this._workspaceWatcher.close();
      this._workspaceWatcher = null;
    }
    if (this._gitHeadWatcher) {
      this._gitHeadWatcher.close();
      this._gitHeadWatcher = null;
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
        return this._handleHealthz(res);
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
        return this._handleWebUI(res, url.pathname);
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
  _handleHealthz(res) {
    return handleHealthz(this, res, { version: PKG_VERSION });
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
    return handleMcpHttp({
      req,
      res,
      version: PKG_VERSION,
      dispatchJsonRpc: (rpcRequest) => this._dispatchJsonRpc(rpcRequest),
    });
  }

  /**
   * Dispatch a JSON-RPC request to the appropriate handler.
   * Supports the MCP protocol methods: initialize, tools/list, tools/call.
   * @param {object} rpcRequest
   * @returns {object} JSON-RPC response
   */
  async _dispatchJsonRpc(rpcRequest) {
    return dispatchJsonRpcRequest({
      rpcRequest,
      getToolDefinitions: () => this._getToolDefinitions(),
      callTool: (name, args) => this._callTool(name, args),
    });
  }

  /**
   * Return MCP tool definitions for tools/list.
   * @returns {Array<object>}
   */
  _getToolDefinitions() {
    return getToolDefinitions();
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
    return callMcpTool(this, name, args);
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
    return handleApiRoute(this, req, res, url);
  }

  /** Simple HTTP JSON request helper for cloud API calls. */
  async _httpJson(method, urlStr, body = null, extraHeaders = {}) {
    return httpJson(method, urlStr, body, extraHeaders);
  }

  // -----------------------------------------------------------------------
  // Web UI
  // -----------------------------------------------------------------------

  /**
   * Serve the web dashboard SPA from web/index.html.
   */
  _handleWebUI(res, pathname = '/') {
    return handleWebUi(res, import.meta.url, pathname);
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
          // Use one consistent model for query+card embedding comparison
          const embLang = detectNeedsCJK(query) ? 'multilingual' : 'english';
          const queryVec = await this._embedder.embed(query, 'query', embLang);
          const allCards = this.indexer.db
            .prepare("SELECT * FROM knowledge_cards WHERE status = 'active' ORDER BY created_at DESC LIMIT 50")
            .all();
          for (const card of allCards) {
            const cardText = `${card.title || ''} ${card.summary || ''}`.trim();
            if (!cardText) continue;
            try {
              // Use same model as query to ensure vectors are in same space
              const cardVec = await this._embedder.embed(cardText, 'passage', embLang);
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
    if (!params.content) {
      return { error: 'content is required for remember action' };
    }

    const noiseReason = classifyNoiseEvent(params);
    if (noiseReason) {
      return { status: 'skipped', reason: noiseReason };
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
      source: params.source || 'mcp',
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

    // Lifecycle: auto-resolve tasks/risks, garbage collect (fire-and-forget, hybrid FTS5+embedding)
    const lifecycleOpts = {};
    if (this._embedder) {
      lifecycleOpts.embedFn = (text, type) => this._embedder.embed(text, type);
      lifecycleOpts.cosineFn = this._embedder.cosineSimilarity;
    }
    const lifecycle = await runLifecycleChecks(this.indexer, params.content, title, params.insights, lifecycleOpts);

    // Perception: surface signals the agent didn't ask about (Eywa Whisper)
    const perception = this._buildPerception(params.content, title, memory, params.insights);

    // Fire-and-forget: LLM auto-resolve check on existing active perceptions
    this._checkPerceptionResolution(id, { title, content: params.content, tags: memory.tags, insights: params.insights })
      .catch((err) => { if (process.env.DEBUG) console.warn('[awareness-local] perception resolve failed:', err.message); });

    const result = {
      status: 'ok',
      id,
      filepath,
      mode: 'local',
    };

    if (perception && perception.length > 0) {
      result.perception = perception;
    }

    // Surface lifecycle actions in response
    if (lifecycle.resolved_tasks.length > 0) {
      result.resolved_tasks = lifecycle.resolved_tasks;
    }
    if (lifecycle.mitigated_risks.length > 0) {
      result.mitigated_risks = lifecycle.mitigated_risks;
    }
    if (lifecycle.archived > 0) {
      result.archived_count = lifecycle.archived;
    }

    return result;
  }

  /**
   * Build perception signals after a record operation (Eywa Whisper).
   *
   * Unlike recall (agent asks a question), perception is the system
   * noticing something the agent didn't ask about:
  * - guard: known high-risk action is about to repeat
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
    const signals = detectGuardSignals({
      content,
      title,
      tags: memory?.tags,
      insights,
    }, {
      profile: this.guardProfile,
    });

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
              summary: r.summary || '',
              category: r.category || '',
              card_id: r.id,
              days_ago: daysAgo,
              message: `🌿 Similar past experience (${daysAgo}d ago): "${r.title}"`,
            });
          }
        }
      }

      // 2. Pattern: detect recurring themes via tag co-occurrence (not just category count)
      if (insights?.knowledge_cards?.length) {
        try {
          // Collect tags from the last 7 days of active cards
          const recentCards = this.indexer.db
            .prepare(
              `SELECT tags FROM knowledge_cards
               WHERE status = 'active' AND created_at > datetime('now', '-7 days')`
            )
            .all();
          const tagCounts = new Map();
          for (const row of recentCards) {
            let tags = [];
            try { tags = JSON.parse(row.tags || '[]'); } catch { /* skip */ }
            for (const t of tags) {
              if (typeof t === 'string' && t.length >= 2) {
                const k = t.toLowerCase();
                tagCounts.set(k, (tagCounts.get(k) || 0) + 1);
              }
            }
          }
          // Find dominant themes (3+ occurrences in 7 days)
          const themes = [...tagCounts.entries()]
            .filter(([, count]) => count >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
          for (const [tag, count] of themes) {
            signals.push({
              type: 'pattern',
              tag,
              count,
              message: `🔄 Recurring theme in last 7 days: "${tag}" (${count} cards) — consider a systematic approach`,
            });
          }
        } catch { /* ignore */ }
      }

      // 3. Staleness: find related but old knowledge (30-day threshold, unified)
      if (title && title.length >= 5) {
        try {
          const relatedResults = this.indexer.searchKnowledge(title, { limit: 3 });
          for (const r of relatedResults) {
            const ts = r.updated_at || r.created_at;
            if (!ts) continue;
            const daysOld = Math.floor(
              (Date.now() - new Date(ts).getTime()) / 86400000
            );
            if (daysOld >= 30) {
              signals.push({
                type: 'staleness',
                title: r.title,
                category: r.category || '',
                card_id: r.id,
                days_since_update: daysOld,
                message: `⏳ Related knowledge "${r.title}" hasn't been updated in ${daysOld} days — may be outdated`,
              });
              break; // Only 1 staleness signal
            }
          }
        } catch { /* FTS query may fail on special chars */ }
      }

      // 4. Contradiction: proactive detection via FTS + superseded cards
      // 4a. Surface recently superseded cards (7-day window)
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
        const superseded = this.indexer.db
          .prepare(
            `SELECT id, title, category, summary FROM knowledge_cards
             WHERE status = 'superseded' AND updated_at > ?
             ORDER BY updated_at DESC LIMIT 2`
          )
          .all(sevenDaysAgo);
        for (const r of superseded) {
          signals.push({
            type: 'contradiction',
            title: r.title,
            summary: r.summary || '',
            card_id: r.id,
            message: `⚡ Recently superseded belief: "${r.title}" — verify current approach`,
          });
        }
      } catch { /* ignore */ }

      // 4b. Proactive: if new card is decision/problem_solution, check for conflicting active cards
      if (insights?.knowledge_cards?.length && title) {
        try {
          const newCard = insights.knowledge_cards[0];
          const cat = newCard?.category;
          if (cat === 'decision' || cat === 'problem_solution') {
            const similar = this.indexer.searchKnowledge(title, { limit: 3 });
            for (const existing of similar) {
              if (existing.category !== cat || !existing.summary) continue;
              // Simple heuristic: if same category and same topic but different summary content
              // (Jaccard similarity of words < 0.3), flag as potential contradiction
              const newWords = new Set((newCard.summary || '').toLowerCase().split(/\s+/));
              const oldWords = new Set(existing.summary.toLowerCase().split(/\s+/));
              const intersection = [...newWords].filter((w) => oldWords.has(w)).length;
              const union = new Set([...newWords, ...oldWords]).size;
              const jaccard = union > 0 ? intersection / union : 1;
              if (jaccard < 0.3 && existing.id !== newCard.id) {
                signals.push({
                  type: 'contradiction',
                  title: existing.title,
                  summary: existing.summary,
                  card_id: existing.id,
                  similarity: jaccard,
                  message: `⚡ New ${cat} may conflict with existing: "${existing.title}" — verify if the old approach is still valid`,
                });
                break;
              }
            }
          }
        } catch { /* ignore */ }
      }

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
                  summary: d.summary || '',
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

    // Apply perception lifecycle: compute signal_id, filter dormant/dismissed/snoozed, update state
    const filteredSignals = [];
    for (const sig of signals) {
      try {
        const signalId = this._computeSignalId(sig);
        sig.signal_id = signalId;
        if (!this.indexer?.shouldShowPerception) {
          filteredSignals.push(sig);
          continue;
        }
        if (!this.indexer.shouldShowPerception(signalId)) continue;
        // Touch state (increment exposure_count, apply decay)
        this.indexer.touchPerceptionState({
          signal_id: signalId,
          signal_type: sig.type,
          source_card_id: sig.card_id || null,
          title: sig.title || sig.message || '',
          metadata: { tag: sig.tag, count: sig.count, category: sig.category },
        });
        filteredSignals.push(sig);
      } catch { /* non-fatal */ }
    }

    return filteredSignals.slice(0, 5); // Cap at 5 signals
  }

  /**
   * Compute a stable signal_id based on type + source identifier.
   * Same signal produced in two different sessions must yield the same ID.
   */
  _computeSignalId(sig) {
    const parts = [sig.type];
    if (sig.card_id) parts.push(sig.card_id);
    else if (sig.tag) parts.push(`tag:${sig.tag}`);
    else if (sig.title) parts.push(`title:${sig.title.slice(0, 60)}`);
    else parts.push(sig.message?.slice(0, 60) || '');
    // Simple hash (deterministic)
    const key = parts.join('|');
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return `sig_${sig.type}_${Math.abs(hash).toString(36)}`;
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

    // F-034: Track newly created eligible cards for crystallization detection
    const CRYSTALLIZATION_CATEGORIES = new Set(['workflow', 'decision', 'problem_solution']);
    const crystallizationCandidates = [];

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

        const cardData = {
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
        };
        this.indexer.indexKnowledgeCard(cardData);

        // Incremental MOC: check if this card's tags trigger MOC creation
        try {
          const newMocIds = this.indexer.tryAutoMoc(cardData);
          // Fire-and-forget: refine MOC titles with LLM if available
          if (newMocIds.length > 0) {
            this._refineMocTitles(newMocIds).catch(() => {});
          }
        } catch (e) {
          console.warn('[awareness-local] autoMoc error:', e.message);
        }

        // Skill auto-evolution: check if new card should evolve existing skills
        try {
          if (this.extractor) {
            this.extractor._checkSkillEvolution(cardData).catch((err) => {
              console.warn('[awareness-local] skill evolution check failed:', err.message);
            });
          }
        } catch { /* non-critical */ }

        // F-034: Track eligible cards for crystallization hint check
        if (CRYSTALLIZATION_CATEGORIES.has(card.category)) {
          crystallizationCandidates.push({
            id: cardId,
            title: card.title || '',
            summary: card.summary || '',
            category: card.category,
          });
        }

        cardsCreated++;
      }
    }

    // Process action items / tasks
    if (Array.isArray(insights.action_items)) {
      for (const item of insights.action_items) {
        // Quality gate: reject noise tasks
        const rejection = validateTaskQuality(item.title);
        if (rejection) {
          console.warn(`[AwarenessDaemon] Rejected noise task (${rejection}): ${(item.title || '').substring(0, 60)}`);
          continue;
        }

        // Dedup gate: skip if similar open task already exists
        const { isDuplicate, existingTaskId } = checkTaskDedup(this.indexer, item.title);
        if (isDuplicate) {
          console.warn(`[AwarenessDaemon] Skipped duplicate task: "${(item.title || '').substring(0, 60)}" (existing: ${existingTaskId})`);
          continue;
        }

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

    // F-034: Handle skills submitted via insights.skills[] (crystallization result)
    let skillsCreated = 0;
    const submittedSkills = Array.isArray(insights.skills) ? insights.skills : [];
    if (submittedSkills.length > 0) {
      for (const skill of submittedSkills) {
        if (!skill.name) continue;
        try {
          const skillId = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const now = nowISO();
          this.indexer.db.prepare(`
            INSERT OR IGNORE INTO skills
              (id, name, summary, methods, trigger_conditions, tags, source_card_ids,
               decay_score, usage_count, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 0, 'active', ?, ?)
          `).run(
            skillId,
            skill.name,
            skill.summary || '',
            skill.methods ? JSON.stringify(skill.methods) : null,
            skill.trigger_conditions ? JSON.stringify(skill.trigger_conditions) : null,
            skill.tags ? JSON.stringify(skill.tags) : null,
            skill.source_card_ids ? JSON.stringify(skill.source_card_ids) : null,
            now,
            now,
          );
          skillsCreated++;
        } catch (err) {
          console.warn(`[AwarenessDaemon] Failed to save skill '${skill.name}':`, err.message);
        }
      }
    }

    // F-034: Crystallization hint — check if newly created eligible cards match existing ones
    let crystallizationHint = null;
    if (crystallizationCandidates.length > 0 && submittedSkills.length === 0) {
      const first = crystallizationCandidates[0];
      crystallizationHint = _checkCrystallizationLocal(this.indexer.db, first);
    }

    const result = {
      status: 'ok',
      cards_created: cardsCreated,
      tasks_created: tasksCreated,
      tasks_auto_completed: tasksAutoCompleted,
      skills_created: skillsCreated,
      mode: 'local',
    };
    if (crystallizationHint) {
      result._skill_crystallization_hint = crystallizationHint;
    }
    return result;
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

      case 'skills': {
        // F-032: Query dedicated skills table (not deprecated knowledge_cards category)
        let skillSql = 'SELECT * FROM skills';
        const skillParams = [];

        if (status) {
          skillSql += ' WHERE status = ?';
          skillParams.push(status);
        } else {
          skillSql += " WHERE status = 'active'";
        }

        skillSql += ' ORDER BY decay_score DESC, created_at DESC LIMIT ?';
        skillParams.push(limit);

        let skills;
        try {
          skills = this.indexer.db.prepare(skillSql).all(...skillParams);
        } catch {
          // Fallback to legacy knowledge_cards if skills table doesn't exist yet
          skills = this.indexer.db.prepare(
            "SELECT * FROM knowledge_cards WHERE category = 'skill' AND status = 'active' ORDER BY created_at DESC LIMIT ?"
          ).all(limit);
        }
        return { skills, total: skills.length, mode: 'local' };
      }

      case 'perception': {
        // Read perception signals from cache file + derive from recent knowledge
        const signals = [];
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');

        // 1. Read cached perception signals (written by awareness plugin hooks)
        try {
          const cachePath = path.join(this.awarenessDir, 'perception-cache.json');
          if (fs.existsSync(cachePath)) {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (Array.isArray(cached)) {
              signals.push(...cached);
            } else if (cached.signals) {
              signals.push(...cached.signals);
            }
          }
        } catch { /* no cache file */ }

        // 2. Derive staleness signals from old knowledge cards (30-day threshold, unified)
        try {
          const staleCards = this.indexer.db
            .prepare(
              `SELECT title, category, COALESCE(updated_at, created_at) AS last_touch
               FROM knowledge_cards
               WHERE status = 'active'
                 AND COALESCE(updated_at, created_at) < datetime('now', '-30 days')
               ORDER BY last_touch ASC LIMIT 3`
            )
            .all();
          for (const card of staleCards) {
            const daysOld = card.last_touch
              ? Math.floor((Date.now() - new Date(card.last_touch).getTime()) / 86400000)
              : 30;
            signals.push({
              type: 'staleness',
              message: `⏳ Knowledge card "${card.title}" hasn't been updated in ${daysOld} days — may be outdated`,
              card_title: card.title,
              category: card.category,
              days_since_update: daysOld,
            });
          }
        } catch { /* db might not have the table */ }

        // 3. Derive pattern signals from tag co-occurrence (not just category count)
        try {
          const recentCards = this.indexer.db
            .prepare(
              `SELECT tags FROM knowledge_cards
               WHERE status = 'active' AND created_at > datetime('now', '-7 days')`
            )
            .all();
          const tagCounts = new Map();
          for (const row of recentCards) {
            let tags = [];
            try { tags = JSON.parse(row.tags || '[]'); } catch { /* skip */ }
            for (const t of tags) {
              if (typeof t === 'string' && t.length >= 2) {
                const k = t.toLowerCase();
                tagCounts.set(k, (tagCounts.get(k) || 0) + 1);
              }
            }
          }
          const themes = [...tagCounts.entries()]
            .filter(([, count]) => count >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          for (const [tag, count] of themes) {
            signals.push({
              type: 'pattern',
              message: `🔄 Recurring theme in last 7 days: "${tag}" (${count} cards) — consider a systematic approach`,
              tag,
              count,
            });
          }
        } catch { /* db issue */ }

        return { signals, total: signals.length, mode: 'local' };
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
    return warmupEmbedder(this);
  }

  /**
   * Backfill embeddings for memories that were indexed before vector search was enabled.
   * Runs in background on startup — processes in batches to avoid blocking.
   */
  async _backfillEmbeddings() {
    return backfillEmbeddings(this);
  }

  /**
   * Generate embedding for a memory and store it in the index.
   * Fire-and-forget — errors are logged but don't block the record flow.
   */
  async _embedAndStore(memoryId, content) {
    return embedAndStore(this, memoryId, content);
  }

  /**
   * Extract knowledge from a newly recorded memory and index the results.
   * Fire-and-forget — errors are logged but don't fail the record.
   */
  async _extractAndIndex(memoryId, content, metadata, preExtractedInsights) {
    return extractAndIndex(this, memoryId, content, metadata, preExtractedInsights);
  }

  // -----------------------------------------------------------------------
  // File watcher
  // -----------------------------------------------------------------------

  /** Start watching .awareness/memories/ for changes (debounced reindex). */
  _startFileWatcher() {
    this.watcher = startFileWatcher(this);
  }

  // -----------------------------------------------------------------------
  // F-038: Workspace Scanner
  // -----------------------------------------------------------------------

  /**
   * Initialize workspace scanner: load state, start watchers, trigger first scan.
   * All operations are non-blocking — errors degrade gracefully.
   */
  _initWorkspaceScanner() {
    try {
      this.scanConfig = loadScanConfig(this.projectDir);
      if (!this.scanConfig.enabled) {
        console.log('[workspace-scanner] disabled via scan-config.json');
        return;
      }

      // Load persisted state (for last_git_commit etc.)
      this.scanState = loadScanState(this.projectDir);

      // Start workspace file watcher
      this._workspaceWatcher = startWorkspaceWatcher(this);

      // Start .git/HEAD watcher
      if (isGitRepo(this.projectDir)) {
        this._gitHeadWatcher = startGitHeadWatcher(this);
      }

      // Trigger initial scan in background (deferred 3s to avoid blocking startup)
      setTimeout(() => {
        this.triggerScan('incremental').catch(err => {
          console.error('[workspace-scanner] initial scan failed:', err.message);
        });
      }, 3000);

      console.log('[workspace-scanner] initialized, first scan in 3s');
    } catch (err) {
      console.error('[workspace-scanner] init failed (degraded):', err.message);
    }
  }

  /**
   * Trigger a workspace scan. Supports 'full' and 'incremental' modes.
   *
   * - Full: re-scans all files regardless of git state
   * - Incremental: uses git diff to detect changes since last commit
   *
   * Non-blocking — yields to event loop between batches.
   *
   * @param {'full'|'incremental'} mode
   * @returns {Promise<import('./core/workspace-scanner.mjs').IndexResult>}
   */
  async triggerScan(mode = 'incremental') {
    if (!this.indexer || !this.scanConfig?.enabled) {
      return { indexed: 0, skipped: 0, errors: 0, edges: 0 };
    }

    // Prevent concurrent scans
    if (this.scanState.status === 'scanning' || this.scanState.status === 'indexing') {
      console.log('[workspace-scanner] scan already in progress, skipping');
      return { indexed: 0, skipped: 0, errors: 0, edges: 0 };
    }

    const startTime = Date.now();
    this._scanAbortController = new AbortController();

    try {
      this.scanState = updateScanState(this.scanState, {
        status: 'scanning',
        phase: 'discovering',
      });

      const config = this.scanConfig;
      const gitignore = loadGitignoreRules(this.projectDir, {
        extraPatterns: config.exclude,
      });

      let filesToIndex;

      if (mode === 'incremental' && config.git_incremental && isGitRepo(this.projectDir)) {
        const currentCommit = getCurrentCommit(this.projectDir);
        const lastCommit = this.scanState.last_git_commit;

        if (currentCommit && currentCommit === lastCommit) {
          // No changes since last scan
          this.scanState = updateScanState(this.scanState, {
            status: 'idle',
            phase: null,
            last_incremental_at: new Date().toISOString(),
          });
          return { indexed: 0, skipped: 0, errors: 0, edges: 0 };
        }

        const gitChanges = getGitChanges(this.projectDir, lastCommit);

        if (gitChanges) {
          // Handle deletions and renames first
          if (gitChanges.deleted.length > 0) {
            markDeletedFiles(gitChanges.deleted, this.indexer);
          }
          if (gitChanges.renamed.length > 0) {
            handleRenamedFiles(gitChanges.renamed, this.indexer);
          }

          // Filter changed files through the scan pipeline
          const changedPaths = [
            ...gitChanges.added,
            ...gitChanges.modified,
            ...gitChanges.renamed.map(r => r.to),
          ];

          filesToIndex = changedPaths
            .map(relPath => {
              const absPath = path.join(this.projectDir, relPath);
              if (!fs.existsSync(absPath)) return null;

              const classification = classifyFile(relPath, config);
              if (classification.excluded) return null;
              if (gitignore.isIgnored(relPath)) return null;

              let stat;
              try { stat = fs.statSync(absPath); } catch { return null; }

              return {
                absolutePath: absPath,
                relativePath: relPath,
                category: classification.category,
                size: stat.size,
                mtime: stat.mtimeMs,
                oversized: stat.size > (config.max_file_size_kb || 500) * 1024,
              };
            })
            .filter(Boolean);

          // Update commit tracking
          if (currentCommit) {
            this.scanState = updateScanState(this.scanState, {
              last_git_commit: currentCommit,
            });
          }
        } else {
          // Git changes unavailable — do full scan
          filesToIndex = scanWorkspace(this.projectDir, {
            config,
            gitignore,
            signal: this._scanAbortController.signal,
          });
        }
      } else {
        // Full scan
        filesToIndex = scanWorkspace(this.projectDir, {
          config,
          gitignore,
          signal: this._scanAbortController.signal,
        });
      }

      this.scanState = updateScanState(this.scanState, {
        status: 'indexing',
        phase: 'parsing',
        discovered_total: filesToIndex.length,
        index_total: filesToIndex.length,
        index_done: 0,
        index_skipped: 0,
      });

      // Index the files
      const result = await indexWorkspaceFiles(filesToIndex, this.indexer, {
        signal: this._scanAbortController.signal,
        onProgress: (progress) => {
          this.scanState = updateScanState(this.scanState, {
            index_done: progress.done,
            index_skipped: progress.skipped,
          });
        },
      });

      // Update git commit tracking (needed for both full and incremental scans)
      if (!this.scanState.last_git_commit && isGitRepo(this.projectDir)) {
        const headCommit = getCurrentCommit(this.projectDir);
        if (headCommit) {
          this.scanState = updateScanState(this.scanState, {
            last_git_commit: headCommit,
          });
        }
      }

      // Count totals from graph_nodes
      let totalFiles = 0;
      let totalCodeFiles = 0;
      let totalDocFiles = 0;
      let totalSymbols = 0;
      try {
        totalFiles = this.indexer.db.prepare(
          "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active'"
        ).get().c;
        totalCodeFiles = this.indexer.db.prepare(
          "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active' AND json_extract(metadata, '$.category') = 'code'"
        ).get().c;
        totalDocFiles = this.indexer.db.prepare(
          "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active' AND json_extract(metadata, '$.category') = 'docs'"
        ).get().c;
        totalSymbols = this.indexer.db.prepare(
          "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'symbol' AND status = 'active'"
        ).get().c;
      } catch { /* stats are non-critical */ }

      const duration = Date.now() - startTime;
      const scanType = mode === 'full' ? 'last_full_scan_at' : 'last_incremental_at';

      this.scanState = updateScanState(this.scanState, {
        status: 'idle',
        phase: null,
        total_files: totalFiles,
        total_code_files: totalCodeFiles,
        total_doc_files: totalDocFiles,
        total_symbols: totalSymbols,
        scan_duration_ms: duration,
        [scanType]: new Date().toISOString(),
      });

      // Persist state
      saveScanState(this.projectDir, this.scanState);

      if (result.indexed > 0 || result.edges > 0) {
        console.log(
          `[workspace-scanner] ${mode} scan done: ${result.indexed} indexed, ${result.skipped} skipped, ${result.edges} edges (${duration}ms)`
        );
      }

      // Fire-and-forget: embed graph nodes + generate similarity edges
      // Runs in background after scan completes — does not block return
      if (result.indexed > 0 && this._embedder) {
        this._triggerGraphEmbedding();
      }

      return result;
    } catch (err) {
      this.scanState = appendScanError(
        updateScanState(this.scanState, { status: 'error', phase: null }),
        err.message
      );
      saveScanState(this.projectDir, this.scanState);
      console.error('[workspace-scanner] scan error:', err.message);
      return { indexed: 0, skipped: 0, errors: 1, edges: 0 };
    }
  }

  // -----------------------------------------------------------------------
  // Graph Embedding (Phase 5 T-030)
  // -----------------------------------------------------------------------

  /**
   * Run graph embedding pipeline in background.
   * Updates ScanState with embedding progress.
   */
  _triggerGraphEmbedding() {
    // Update state to show embedding phase
    this.scanState = updateScanState(this.scanState, {
      status: 'indexing',
      phase: 'embedding',
      embed_total: 0,
      embed_done: 0,
    });

    runGraphEmbeddingPipeline(this, {
      onProgress: (done, total) => {
        this.scanState = updateScanState(this.scanState, {
          embed_total: total,
          embed_done: done,
        });
      },
    })
      .then(({ embedding, similarity }) => {
        this.scanState = updateScanState(this.scanState, {
          status: 'idle',
          phase: null,
          embed_total: embedding.total,
          embed_done: embedding.embedded,
        });
        saveScanState(this.projectDir, this.scanState);
      })
      .catch((err) => {
        console.warn('[graph-embedder] pipeline error:', err.message);
        this.scanState = updateScanState(this.scanState, {
          status: 'idle',
          phase: null,
        });
        saveScanState(this.projectDir, this.scanState);
      });
  }

  // -----------------------------------------------------------------------
  // Skill Decay
  // -----------------------------------------------------------------------

  /**
   * Start a 24-hour interval that recalculates skill decay scores.
   * Also runs once at startup.
   */
  _startSkillDecayTimer() {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    // Run once at startup (deferred so it doesn't block start)
    setTimeout(() => this._runSkillDecay(), 5000);
    this._skillDecayTimer = setInterval(
      () => this._runSkillDecay(),
      TWENTY_FOUR_HOURS,
    );
    // Allow process to exit even if timer is pending
    if (this._skillDecayTimer.unref) this._skillDecayTimer.unref();
  }

  /**
   * Recalculate decay_score for every non-pinned skill.
   * Formula (aligned with cloud backend):
   *   baseDecay = exp(-0.693 * daysSince / 30)   // 30-day half-life
   *   usageBoost = ln(usage_count + 1) / ln(20)
   *   decay_score = min(1.0, baseDecay + usageBoost)
   * Pinned skills always keep decay_score = 1.0.
   */
  _runSkillDecay() {
    if (!this.indexer || !this.indexer.db) return;
    try {
      const now = Date.now();
      const skills = this.indexer.db
        .prepare('SELECT id, last_used_at, usage_count, pinned FROM skills WHERE status = ?')
        .all('active');

      const update = this.indexer.db.prepare(
        'UPDATE skills SET decay_score = ?, updated_at = ? WHERE id = ?',
      );

      const nowISO_ = new Date(now).toISOString();
      const LN_20 = Math.log(20);
      const HALF_LIFE_DAYS = 30;
      const LAMBDA = 0.693 / HALF_LIFE_DAYS; // ln(2) / half-life

      const batch = this.indexer.db.transaction(() => {
        for (const skill of skills) {
          if (skill.pinned) {
            update.run(1.0, nowISO_, skill.id);
            continue;
          }
          const lastUsed = skill.last_used_at
            ? new Date(skill.last_used_at).getTime()
            : now;
          const daysSince = (now - lastUsed) / (1000 * 60 * 60 * 24);
          const baseDecay = Math.exp(-LAMBDA * daysSince);
          const usageBoost = Math.log((skill.usage_count || 0) + 1) / LN_20;
          const score = Math.min(1.0, baseDecay + usageBoost);
          update.run(Math.round(score * 1000) / 1000, nowISO_, skill.id);
        }
      });
      batch();

      if (skills.length > 0) {
        console.log(`[awareness-local] skill decay: updated ${skills.length} skills`);
      }
    } catch (err) {
      console.error('[awareness-local] skill decay error:', err.message);
    }
  }

  // -----------------------------------------------------------------------
  // Config & spec loading
  // -----------------------------------------------------------------------

  /**
   * Hot-switch to a different project directory without restarting the daemon.
   * Closes current indexer/search, re-initializes with new project's .awareness/ data.
   */
  async switchProject(newProjectDir) {
    if (!fs.existsSync(newProjectDir)) {
      throw new Error(`Project directory does not exist: ${newProjectDir}`);
    }

    const newAwarenessDir = path.join(newProjectDir, AWARENESS_DIR);
    console.log(`[awareness-local] switching project: ${this.projectDir} → ${newProjectDir}`);

    // 1. Stop watchers & timers
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._reindexTimer) { clearTimeout(this._reindexTimer); this._reindexTimer = null; }
    if (this.cloudSync) { this.cloudSync.stop(); this.cloudSync = null; }

    // 2. Close old indexer
    if (this.indexer && this.indexer.close) {
      this.indexer.close();
    }

    // 3. Update project paths
    this.projectDir = newProjectDir;
    this.guardProfile = detectGuardProfile(this.projectDir);
    this.awarenessDir = newAwarenessDir;
    this.pidFile = path.join(this.awarenessDir, PID_FILENAME);
    this.logFile = path.join(this.awarenessDir, LOG_FILENAME);

    // 4. Ensure directory structure
    fs.mkdirSync(path.join(this.awarenessDir, 'memories'), { recursive: true });
    fs.mkdirSync(path.join(this.awarenessDir, 'knowledge'), { recursive: true });
    fs.mkdirSync(path.join(this.awarenessDir, 'tasks'), { recursive: true });

    // 5. Re-init core modules
    this.memoryStore = new MemoryStore(this.projectDir);
    try {
      this.indexer = new Indexer(path.join(this.awarenessDir, 'index.db'));
    } catch (e) {
      console.error(`[awareness-local] SQLite indexer unavailable after switch: ${e.message}`);
      this.indexer = createNoopIndexer();
    }
    this.search = await this._loadSearchEngine();
    this.extractor = await this._loadKnowledgeExtractor();

    // 6. Incremental index
    try {
      const result = await this.indexer.incrementalIndex(this.memoryStore);
      console.log(`[awareness-local] re-indexed: ${result.indexed} files, ${result.skipped} skipped`);
    } catch (err) {
      console.error('[awareness-local] re-index error:', err.message);
    }

    // 7. Restart cloud sync if configured
    const config = this._loadConfig();
    if (config.cloud?.enabled) {
      try {
        const { CloudSync } = await import('./core/cloud-sync.mjs');
        this.cloudSync = new CloudSync(config, this.indexer, this.memoryStore);
        this.cloudSync.start().catch(() => {});
      } catch { /* CloudSync not available */ }
    }

    // 8. Update workspace registry
    try {
      const { registerWorkspace } = await import('./core/config.mjs');
      registerWorkspace(newProjectDir, { port: this.port });
    } catch { /* config.mjs not available */ }

    console.log(`[awareness-local] switched to: ${newProjectDir} (${this.indexer.getStats().totalMemories} memories)`);
    return { projectDir: newProjectDir, stats: this.indexer.getStats() };
  }

  /** Load .awareness/config.json (or return defaults). */
  _loadConfig() {
    return loadDaemonConfig({
      awarenessDir: this.awarenessDir,
      port: this.port,
    });
  }

  /**
   * Attempt to auto-rebuild better-sqlite3 when a NODE_MODULE_VERSION mismatch
   * is detected (e.g. after a Node.js major version upgrade).
   * Extracts the module directory from the error message and runs `npm rebuild`.
   *
   * @param {string} errMsg - The error message from the failed require()
   * @returns {Promise<boolean>} true if rebuild succeeded
   */
  async _tryRebuildBetterSqlite(errMsg) {
    try {
      const match = errMsg.match(/The module '(.+?better-sqlite3.+?\.node)'/);
      if (!match) return false;
      const moduleDir = match[1].split('/build/')[0];
      const { execSync } = await import('node:child_process');
      console.log(`[awareness-local] Node.js version changed — auto-rebuilding better-sqlite3 for ${process.version}...`);
      execSync('npm rebuild', { cwd: moduleDir, stdio: 'pipe' });
      console.log('[awareness-local] better-sqlite3 rebuilt successfully');
      return true;
    } catch (rebuildErr) {
      console.error(`[awareness-local] Auto-rebuild failed: ${rebuildErr.message}`);
      console.error('[awareness-local] Falling back to file-only mode (no search)');
      return false;
    }
  }

  /** Load awareness-spec.json from the bundled spec directory. */
  _loadSpec() {
    return loadDaemonSpec(import.meta.url);
  }

  // -----------------------------------------------------------------------
  // Dynamic module loading
  // -----------------------------------------------------------------------

  /**
   * Lazy-load the embedder module (shared by SearchEngine + KnowledgeExtractor).
   * Caches at this._embedder. Returns null when unavailable (graceful degradation).
   */
  async _loadEmbedder() {
    this._embedder = await loadEmbedderModule({
      importMetaUrl: import.meta.url,
      cachedEmbedder: this._embedder,
    });
    return this._embedder;
  }

  /** Try to load SearchEngine from Phase 1 core. Returns null if not available. */
  async _loadSearchEngine() {
    return loadSearchEngineModule({
      importMetaUrl: import.meta.url,
      indexer: this.indexer,
      memoryStore: this.memoryStore,
      loadEmbedder: () => this._loadEmbedder(),
    });
  }

  /** Try to load KnowledgeExtractor from Phase 1 core. Returns null if not available. */
  async _loadKnowledgeExtractor() {
    return loadKnowledgeExtractorModule({
      importMetaUrl: import.meta.url,
      memoryStore: this.memoryStore,
      indexer: this.indexer,
      loadEmbedder: () => this._loadEmbedder(),
    });
  }

  // -----------------------------------------------------------------------
  // LLM-assisted MOC title refinement (fire-and-forget)
  // -----------------------------------------------------------------------

  /**
   * Attempt to refine newly created MOC card titles using LLM.
   * Uses cloud API inference if cloud sync is enabled, otherwise skips silently.
   */
  async _refineMocTitles(mocIds) {
    const config = this._loadConfig();
    if (!config.cloud?.enabled || !config.cloud?.api_key) return;

    const apiBase = config.cloud.api_base || 'https://awareness.market/api/v1';
    const memoryId = config.cloud.memory_id;
    const apiKey = config.cloud.api_key;

    // Simple LLM inference via cloud API's chat endpoint
    const llmInfer = async (systemPrompt, userContent) => {
      const { httpJson } = await import('./daemon/cloud-http.mjs');
      const resp = await httpJson('POST', `${apiBase}/memories/${memoryId}/chat`, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 200,
      }, { Authorization: `Bearer ${apiKey}` });
      // The chat endpoint may return different formats
      if (typeof resp === 'string') return resp;
      return resp?.content || resp?.choices?.[0]?.message?.content || JSON.stringify(resp);
    };

    for (const mocId of mocIds) {
      try {
        await this.indexer.refineMocWithLlm(mocId, llmInfer);
      } catch (err) {
        // Non-fatal — tag-based title remains
        if (process.env.DEBUG) {
          console.warn(`[awareness-local] MOC LLM refine failed for ${mocId}: ${err.message}`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // LLM-assisted perception auto-resolution
  // -----------------------------------------------------------------------

  /**
   * After a new memory is recorded, ask the user's LLM whether any currently
   * active perception signals have been resolved by this new memory.
   *
   * Fire-and-forget. Only runs when:
   *   - cloud sync is enabled (we use cloud API chat endpoint)
   *   - there are active perceptions
   *   - pre-filter finds candidate signals (tag/keyword/source_card match)
   *
   * LLM returns a classification per signal: resolved / irrelevant / still_active.
   * "resolved" signals are auto-dismissed with a resolution_reason.
   */
  async _checkPerceptionResolution(newMemoryId, newMemory) {
    // Rate limit: 1 check per memory per 60s
    const now = Date.now();
    if (!this._lastResolveCheckAt) this._lastResolveCheckAt = 0;
    if (now - this._lastResolveCheckAt < 60000) return;
    this._lastResolveCheckAt = now;

    // Only if cloud is enabled (we route LLM calls through cloud API)
    const config = this._loadConfig();
    if (!config.cloud?.enabled || !config.cloud?.api_key) return;

    // Fetch active perceptions that support auto-resolution
    if (!this.indexer?.listPerceptionStates) return;
    const activeStates = this.indexer.listPerceptionStates({
      state: ['active', 'snoozed'],
      limit: 50,
    });
    const candidates = activeStates.filter((s) =>
      ['guard', 'contradiction', 'pattern', 'staleness'].includes(s.signal_type)
    );
    if (candidates.length === 0) return;

    // Pre-filter: only signals with tag/keyword/source_card overlap with new memory
    const memTags = new Set((newMemory.tags || []).map((t) => String(t).toLowerCase()));
    const memText = `${newMemory.title || ''} ${newMemory.content || ''}`.toLowerCase();
    const newCategory = newMemory.insights?.knowledge_cards?.[0]?.category;
    const isFixCategory = ['problem_solution', 'decision'].includes(newCategory);
    if (!isFixCategory && newCategory) return; // Only problem_solution/decision/null can resolve

    const filtered = candidates.filter((sig) => {
      // Check tag overlap (signal metadata may have tags)
      let sigTags = [];
      try { sigTags = JSON.parse(sig.metadata || '{}').tags || []; } catch {}
      const hasTagOverlap = sigTags.some((t) => memTags.has(String(t).toLowerCase()));

      // Check keyword mention in title
      const sigWords = (sig.title || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      const hasKeyword = sigWords.some((w) => memText.includes(w));

      // Check source card reference
      const sourceMemories = newMemory.insights?.knowledge_cards?.[0]?.source_memories || [];
      const refsSourceCard = sig.source_card_id && sourceMemories.includes(sig.source_card_id);

      return hasTagOverlap || hasKeyword || refsSourceCard;
    });

    if (filtered.length === 0) return;

    // Build batch prompt
    const systemPrompt = `You are analyzing whether a new memory resolves previously-flagged awareness signals.

A "signal" is a warning or insight the system surfaced to the user:
- GUARD: a known pitfall (e.g., "Electron shell must use --norc")
- CONTRADICTION: conflicting beliefs in the memory
- PATTERN: recurring theme suggesting systematic action
- STALENESS: knowledge that may be outdated

Given each signal + the new memory, classify:
- "resolved": new memory shows CLEAR evidence the issue was fixed or addressed
- "irrelevant": new memory is unrelated to this signal
- "still_active": signal is still relevant (DEFAULT — be conservative)

Rules:
- Only mark "resolved" when there's explicit evidence (fix, refactor, decision made)
- Related but not resolved → "still_active"
- When in doubt → "still_active"

Return JSON only: {"results": [{"signal_id":"...","status":"resolved|irrelevant|still_active","reason":"..."}]}`;

    const userContent = `NEW MEMORY:
Title: ${newMemory.title || '(no title)'}
Content: ${(newMemory.content || '').slice(0, 500)}
Tags: ${[...memTags].join(', ') || '(none)'}

SIGNALS TO CHECK:
${filtered.map((s) => `[${s.signal_id}] (${s.signal_type}) ${s.title || s.signal_id}`).join('\n')}`;

    try {
      const { httpJson } = await import('./daemon/cloud-http.mjs');
      const apiBase = config.cloud.api_base || 'https://awareness.market/api/v1';
      const memoryId = config.cloud.memory_id;
      const apiKey = config.cloud.api_key;
      const resp = await httpJson('POST', `${apiBase}/memories/${memoryId}/chat`, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 500,
      }, { Authorization: `Bearer ${apiKey}` });

      const raw = typeof resp === 'string' ? resp
        : resp?.content || resp?.choices?.[0]?.message?.content || '';
      if (!raw) return;

      // Parse JSON response (robust — grab first JSON object)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const parsed = JSON.parse(jsonMatch[0]);
      const results = Array.isArray(parsed.results) ? parsed.results : [];

      for (const r of results) {
        if (r.status === 'resolved' && r.signal_id) {
          this.indexer.autoResolvePerception(r.signal_id, newMemoryId, r.reason || 'Auto-resolved by LLM');
          console.log(`[awareness-local] perception auto-resolved: ${r.signal_id} — ${(r.reason || '').slice(0, 80)}`);
        }
      }
    } catch (err) {
      if (process.env.DEBUG) {
        console.warn(`[awareness-local] LLM perception resolve failed: ${err.message}`);
      }
    }
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

function detectGuardProfile(projectDir) {
  const explicit = process.env.AWARENESS_LOCAL_GUARD_PROFILE;
  if (explicit) return explicit;
  const awarenessMarkers = [
    path.join(projectDir, 'backend', 'awareness-spec.json'),
    path.join(projectDir, 'docs', 'prd', 'deployment-guide.md'),
  ];
  return awarenessMarkers.every((marker) => fs.existsSync(marker)) ? 'awareness' : 'generic';
}

export default AwarenessLocalDaemon;
