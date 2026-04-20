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
import { classifyNoiseEvent, cleanContent } from './core/noise-filter.mjs';
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
  isSemanticallyRelated,
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
import { initTelemetry, getTelemetry, track } from './core/telemetry.mjs';
import { loadGitignoreRules } from './core/gitignore-parser.mjs';
import { classifyFile } from './core/scan-defaults.mjs';
import {
  backfillEmbeddings,
  embedAndStore,
  extractAndIndex,
  warmupEmbedder,
} from './daemon/embedding-helpers.mjs';
import {
  ensureArchetypeIndex,
  tryRebuildBetterSqlite,
} from './daemon/bootstrap.mjs';
import {
  findEvolutionTarget,
  supersedeCard,
} from './daemon/card-evolution.mjs';
import { lookup as lookupEngine } from './daemon/engine/lookup.mjs';
import { submitInsights as submitInsightsEngine } from './daemon/engine/submit-insights.mjs';
import {
  buildPerception as buildPerceptionEngine,
  computeSignalId as computeSignalIdEngine,
  ordinal as ordinalEngine,
} from './daemon/engine/perception.mjs';
import { remember as rememberEngine } from './daemon/engine/remember.mjs';
import {
  initWorkspaceScanner as initWorkspaceScannerImpl,
  triggerScan as triggerScanImpl,
  triggerGraphEmbedding as triggerGraphEmbeddingImpl,
} from './daemon/workspace-init.mjs';
import { checkPerceptionResolution as checkPerceptionResolutionImpl } from './daemon/engine/perception-resolve.mjs';
import { handleHttpRequest as handleHttpRequestImpl } from './daemon/engine/http-router.mjs';
import {
  startSkillDecayTimer as startSkillDecayTimerImpl,
  startGraphMaintenanceTimer as startGraphMaintenanceTimerImpl,
  runSkillDecay as runSkillDecayImpl,
} from './daemon/maintenance.mjs';
import { runGraphEmbeddingPipeline } from './daemon/graph-embedder.mjs';
import { shouldRequestExtraction, buildExtractionInstruction } from './daemon/extraction-instruction.mjs';

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
import { runLifecycleChecks, validateTaskQuality, checkTaskDedup, validateCardQuality } from './core/lifecycle-manager.mjs';


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

    // F-053 Phase 3 · archetype classifier index (lazy-built on first recall,
    // then cached for daemon lifetime). Building it costs one embed per
    // archetype (~100ms × 10 = ~1s) using the multilingual model.
    this._archetypeIndex = null;
    this._archetypeIndexBuildInFlight = null;

    // Debounce timer for fs.watch reindex
    this._reindexTimer = null;
    this._reindexDebounceMs = 1000;

    // Skill decay timer (runs every 24h)
    this._skillDecayTimer = null;
    // 0.7.2: daily graph edge cap + VACUUM to bound index.db growth.
    this._graphMaintenanceTimer = null;

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

    // ---- Graph maintenance: edge cap + VACUUM every 24h ----
    this._startGraphMaintenanceTimer();

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
    if (this._graphMaintenanceTimer) {
      clearInterval(this._graphMaintenanceTimer);
      this._graphMaintenanceTimer = null;
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

    // Stop cloud sync — MUST await so in-flight fullSync() drains before
    // indexer.close() below. Pre-0.7.2 this was fire-and-forget and produced
    // the "database connection is not open" log flood.
    if (this.cloudSync) {
      try { await this.cloudSync.stop(); } catch { /* best-effort */ }
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
    return handleHttpRequestImpl(this, req, res);
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
    return rememberEngine(this, params);
  }



  /** Write a single memory, index it, and trigger knowledge extraction. */

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
  async _buildPerception(content, title, memory, insights) {
    return buildPerceptionEngine(this, content, title, memory, insights);
  }

  _computeSignalId(sig) { return computeSignalIdEngine(sig); }

  _ordinal(n) { return ordinalEngine(n); }

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
    return submitInsightsEngine(this, params);
  }


  /** Handle structured data lookups. */
  async _lookup(params) {
    return lookupEngine(this, params);
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
  /**
   * F-053 Phase 3 · lazy-build and cache the archetype classifier index.
   * Returns null (not an error) when the embedder module is unavailable,
   * so recall gracefully falls back to Phase 1c budget-tier default.
   *
   * Thread-safety: if two recalls race in parallel on a cold daemon, the
   * in-flight promise is shared so we don't double-embed the archetypes.
   */
  async _ensureArchetypeIndex() {
    return ensureArchetypeIndex(this);
  }

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
  _initWorkspaceScanner() { return initWorkspaceScannerImpl(this); }

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
  async triggerScan(mode = 'incremental') { return triggerScanImpl(this, mode); }

  // -----------------------------------------------------------------------
  // Graph Embedding (Phase 5 T-030)
  // -----------------------------------------------------------------------

  /**
   * Run graph embedding pipeline in background.
   * Updates ScanState with embedding progress.
   */
  _triggerGraphEmbedding() { return triggerGraphEmbeddingImpl(this); }

  // -----------------------------------------------------------------------
  // Skill Decay
  // -----------------------------------------------------------------------

  /**
   * Start a 24-hour interval that recalculates skill decay scores.
   * Also runs once at startup.
   */
  _startSkillDecayTimer() { return startSkillDecayTimerImpl(this); }

  /**
   * 0.7.2: bound graph_edges growth + reclaim pages daily.
   *
   * Order matters: prune first (large DELETE), then VACUUM to actually
   * return the pages to disk. SQLite does not auto-compact.
   */
  _startGraphMaintenanceTimer() { return startGraphMaintenanceTimerImpl(this); }

  /**
   * Recalculate decay_score for every non-pinned skill.
   * Formula (aligned with cloud backend):
   *   baseDecay = exp(-0.693 * daysSince / 30)   // 30-day half-life
   *   usageBoost = ln(usage_count + 1) / ln(20)
   *   decay_score = min(1.0, baseDecay + usageBoost)
   * Pinned skills always keep decay_score = 1.0.
   */
  _runSkillDecay() { return runSkillDecayImpl(this); }

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

    this._switching = true;
    try {
      const newAwarenessDir = path.join(newProjectDir, AWARENESS_DIR);
      console.log(`[awareness-local] switching project: ${this.projectDir} → ${newProjectDir}`);

      // 1. Stop watchers & timers
      if (this.watcher) { this.watcher.close(); this.watcher = null; }
      if (this._reindexTimer) { clearTimeout(this._reindexTimer); this._reindexTimer = null; }
      if (this.cloudSync) { try { await this.cloudSync.stop(); } catch { /* best-effort */ } this.cloudSync = null; }

      // F-055b P0 — also tear down the workspace-scanner watchers that
      // were rooted at the OLD projectDir. Without this the fs/git watchers
      // keep firing on stale paths and graph_nodes stays polluted with
      // the previous workspace's files.
      if (this._workspaceWatcher && typeof this._workspaceWatcher.close === 'function') {
        try { this._workspaceWatcher.close(); } catch { /* best-effort */ }
        this._workspaceWatcher = null;
      }
      if (this._gitHeadWatcher && typeof this._gitHeadWatcher.close === 'function') {
        try { this._gitHeadWatcher.close(); } catch { /* best-effort */ }
        this._gitHeadWatcher = null;
      }
      if (this._scanAbortController) {
        try { this._scanAbortController.abort(); } catch { /* best-effort */ }
        this._scanAbortController = null;
      }

      // 1.5 Drain any in-flight graph-embedder pipeline rooted at the OLD
      // projectDir before closing its indexer. Without this the pipeline
      // keeps calling graphInsertEdge / storeGraphEmbedding on a closed DB
      // and floods the log with "database connection is not open" errors.
      // Capped at 3s so a runaway pipeline can't block the switch forever —
      // the indexer's db.open guard is our safety net if it outlives the wait.
      if (this._inflightGraphPipeline) {
        const inflight = this._inflightGraphPipeline;
        try {
          await Promise.race([
            inflight.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 3000)),
          ]);
        } catch { /* swallowed */ }
        this._inflightGraphPipeline = null;
      }

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

      // 9. F-055b P0 — re-initialise the workspace scanner against the
      // new projectDir and fire a full rescan in the background. Before
      // this, graph_nodes kept pointing at the OLD workspace because
      // `_initWorkspaceScanner` only ran at daemon boot — users saw
      // "Code Files: 500" (stale) in the UI while `/scan/status` showed
      // the correct 20-file count for the new workspace.
      try {
        this.scanState = { status: 'idle', phase: '', last_scan_at: null };
        this._initWorkspaceScanner();
        // Kick a full rescan right away (don't wait the 3s stagger — the
        // user just explicitly asked to switch, so latency matters).
        this.triggerScan('full').catch((err) => {
          console.error('[workspace-scanner] post-switch full rescan failed:', err.message);
        });
      } catch (err) {
        console.error('[workspace-scanner] re-init after switch failed:', err.message);
      }

      console.log(`[awareness-local] switched to: ${newProjectDir} (${this.indexer.getStats().totalMemories} memories)`);
      return { projectDir: newProjectDir, stats: this.indexer.getStats() };
    } finally {
      this._switching = false;
    }
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
    return tryRebuildBetterSqlite(errMsg);
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
    // F-059 · inject into indexer so indexTask can cache task vectors
    // for the auto-resolve hybrid search (real vector channel, not Jaccard).
    if (this._embedder && this.indexer?.setEmbedder) {
      this.indexer.setEmbedder(this._embedder);
    }
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

    // Snapshot the project so a slow cloud LLM round-trip doesn't end up
    // writing a refined title into the WRONG workspace's MOC after the
    // user has switched. Each iteration re-checks before await and before
    // the DB write.
    const projectAtStart = this.projectDir;
    const indexerAtStart = this.indexer;

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
      if (this.projectDir !== projectAtStart) return; // workspace switched mid-loop
      try {
        await indexerAtStart.refineMocWithLlm(mocId, llmInfer);
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
    return checkPerceptionResolutionImpl(this, newMemoryId, newMemory);
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
