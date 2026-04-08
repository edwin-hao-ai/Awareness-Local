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
import { startFileWatcher } from './daemon/file-watcher.mjs';
import {
  backfillEmbeddings,
  embedAndStore,
  extractAndIndex,
  warmupEmbedder,
} from './daemon/embedding-helpers.mjs';

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
        return this._handleWebUI(res);
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
  _handleWebUI(res) {
    return handleWebUi(res, import.meta.url);
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
  // Config & spec loading
  // -----------------------------------------------------------------------

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
