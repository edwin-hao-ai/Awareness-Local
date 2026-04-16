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
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectNeedsCJK } from './core/lang-detect.mjs';
import { detectGuardSignals } from './core/guard-detector.mjs';
import { classifyNoiseEvent } from './core/noise-filter.mjs';
import { createRequire } from 'node:module';
import { AWARENESS_DIR, BIND_HOST, DEFAULT_PORT, LOG_FILENAME, PID_FILENAME } from './daemon/constants.mjs';
import { createNoopIndexer, httpHealthCheck, jsonResponse, nowISO, splitPreferences } from './daemon/helpers.mjs';
import { loadDaemonConfig, loadDaemonSpec, loadEmbedderModule, loadKnowledgeExtractorModule, loadSearchEngineModule } from './daemon/loaders.mjs';
import { getToolDefinitions } from './daemon/mcp-contract.mjs';
import { handleApiRoute } from './daemon/api-handlers.mjs';
import { dispatchJsonRpcRequest, handleMcpHttp } from './daemon/mcp-http.mjs';
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
import { backfillEmbeddings, embedAndStore, extractAndIndex, warmupEmbedder } from './daemon/embedding-helpers.mjs';
import { runGraphEmbeddingPipeline } from './daemon/graph-embedder.mjs';
import { shouldRequestExtraction, buildExtractionInstruction } from './daemon/extraction-instruction.mjs';

// Read version from package.json (not hardcoded)
const __daemon_dirname = path.dirname(fileURLToPath(import.meta.url));
let PKG_VERSION = stryMutAct_9fa48("0") ? "" : (stryCov_9fa48("0"), '0.4.0');
try {
  if (stryMutAct_9fa48("1")) {
    {}
  } else {
    stryCov_9fa48("1");
    const require = createRequire(import.meta.url);
    const pkg = require(path.join(__daemon_dirname, stryMutAct_9fa48("2") ? "" : (stryCov_9fa48("2"), '..'), stryMutAct_9fa48("3") ? "" : (stryCov_9fa48("3"), 'package.json')));
    PKG_VERSION = stryMutAct_9fa48("6") ? pkg.version && PKG_VERSION : stryMutAct_9fa48("5") ? false : stryMutAct_9fa48("4") ? true : (stryCov_9fa48("4", "5", "6"), pkg.version || PKG_VERSION);
  }
} catch {/* fallback */}

// Force UTF-8 encoding on Windows (prevents Chinese/CJK text from becoming ????)
if (stryMutAct_9fa48("9") ? process.platform !== 'win32' : stryMutAct_9fa48("8") ? false : stryMutAct_9fa48("7") ? true : (stryCov_9fa48("7", "8", "9"), process.platform === (stryMutAct_9fa48("10") ? "" : (stryCov_9fa48("10"), 'win32')))) {
  if (stryMutAct_9fa48("11")) {
    {}
  } else {
    stryCov_9fa48("11");
    try {
      if (stryMutAct_9fa48("12")) {
        {}
      } else {
        stryCov_9fa48("12");
        process.stdout.setEncoding(stryMutAct_9fa48("13") ? "" : (stryCov_9fa48("13"), 'utf8'));
      }
    } catch {/* best-effort */}
    try {
      if (stryMutAct_9fa48("14")) {
        {}
      } else {
        stryCov_9fa48("14");
        process.stderr.setEncoding(stryMutAct_9fa48("15") ? "" : (stryCov_9fa48("15"), 'utf8'));
      }
    } catch {/* best-effort */}
    // Set LANG to ensure downstream tools respect UTF-8
    process.env.LANG = stryMutAct_9fa48("18") ? process.env.LANG && 'en_US.UTF-8' : stryMutAct_9fa48("17") ? false : stryMutAct_9fa48("16") ? true : (stryCov_9fa48("16", "17", "18"), process.env.LANG || (stryMutAct_9fa48("19") ? "" : (stryCov_9fa48("19"), 'en_US.UTF-8')));
  }
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
const _CRYST_CATEGORIES = new Set(stryMutAct_9fa48("20") ? [] : (stryCov_9fa48("20"), [stryMutAct_9fa48("21") ? "" : (stryCov_9fa48("21"), 'workflow'), stryMutAct_9fa48("22") ? "" : (stryCov_9fa48("22"), 'decision'), stryMutAct_9fa48("23") ? "" : (stryCov_9fa48("23"), 'problem_solution')]));

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
  if (stryMutAct_9fa48("24")) {
    {}
  } else {
    stryCov_9fa48("24");
    try {
      if (stryMutAct_9fa48("25")) {
        {}
      } else {
        stryCov_9fa48("25");
        if (stryMutAct_9fa48("28") ? false : stryMutAct_9fa48("27") ? true : stryMutAct_9fa48("26") ? _CRYST_CATEGORIES.has(newCard.category) : (stryCov_9fa48("26", "27", "28"), !_CRYST_CATEGORIES.has(newCard.category))) return null;

        // Build query terms from title + summary (first 120 chars)
        const queryText = stryMutAct_9fa48("29") ? `${newCard.title} ${(newCard.summary || '').slice(0, 120)}` : (stryCov_9fa48("29"), (stryMutAct_9fa48("30") ? `` : (stryCov_9fa48("30"), `${newCard.title} ${stryMutAct_9fa48("31") ? newCard.summary || '' : (stryCov_9fa48("31"), (stryMutAct_9fa48("34") ? newCard.summary && '' : stryMutAct_9fa48("33") ? false : stryMutAct_9fa48("32") ? true : (stryCov_9fa48("32", "33", "34"), newCard.summary || (stryMutAct_9fa48("35") ? "Stryker was here!" : (stryCov_9fa48("35"), '')))).slice(0, 120))}`)).trim());
        if (stryMutAct_9fa48("39") ? queryText.length >= 5 : stryMutAct_9fa48("38") ? queryText.length <= 5 : stryMutAct_9fa48("37") ? false : stryMutAct_9fa48("36") ? true : (stryCov_9fa48("36", "37", "38", "39"), queryText.length < 5)) return null;

        // FTS5 trigram search — exclude the card itself, restrict to eligible categories
        const cats = (stryMutAct_9fa48("40") ? [] : (stryCov_9fa48("40"), [..._CRYST_CATEGORIES])).map(stryMutAct_9fa48("41") ? () => undefined : (stryCov_9fa48("41"), () => stryMutAct_9fa48("42") ? "" : (stryCov_9fa48("42"), '?'))).join(stryMutAct_9fa48("43") ? "" : (stryCov_9fa48("43"), ','));
        const rows = db.prepare(stryMutAct_9fa48("44") ? `` : (stryCov_9fa48("44"), `
      SELECT kc.id, kc.title, kc.summary, kc.category
      FROM knowledge_cards kc
      JOIN knowledge_fts fts ON fts.id = kc.id
      WHERE knowledge_fts MATCH ?
        AND kc.id != ?
        AND kc.category IN (${cats})
        AND kc.status NOT IN ('superseded', 'archived')
      LIMIT ?
    `)).all(queryText, newCard.id, ...(stryMutAct_9fa48("45") ? [] : (stryCov_9fa48("45"), [..._CRYST_CATEGORIES])), stryMutAct_9fa48("46") ? _CRYST_MAX_CARDS - 5 : (stryCov_9fa48("46"), _CRYST_MAX_CARDS + 5));
        if (stryMutAct_9fa48("50") ? rows.length >= _CRYST_MIN_SIMILAR : stryMutAct_9fa48("49") ? rows.length <= _CRYST_MIN_SIMILAR : stryMutAct_9fa48("48") ? false : stryMutAct_9fa48("47") ? true : (stryCov_9fa48("47", "48", "49", "50"), rows.length < _CRYST_MIN_SIMILAR)) return null;

        // Check if a skill already exists covering this topic
        const existingSkill = db.prepare(stryMutAct_9fa48("51") ? `` : (stryCov_9fa48("51"), `SELECT id FROM skills WHERE lower(name) LIKE ? AND status != 'archived' LIMIT 1`)).get(stryMutAct_9fa48("52") ? `` : (stryCov_9fa48("52"), `%${stryMutAct_9fa48("54") ? newCard.title.toLowerCase() : stryMutAct_9fa48("53") ? newCard.title.slice(0, 20).toUpperCase() : (stryCov_9fa48("53", "54"), newCard.title.slice(0, 20).toLowerCase())}%`));
        if (stryMutAct_9fa48("56") ? false : stryMutAct_9fa48("55") ? true : (stryCov_9fa48("55", "56"), existingSkill)) return null;
        const similarCards = stryMutAct_9fa48("57") ? rows.map(r => ({
          id: r.id,
          title: r.title,
          summary: r.summary || ''
        })) : (stryCov_9fa48("57"), rows.slice(0, _CRYST_MAX_CARDS).map(stryMutAct_9fa48("58") ? () => undefined : (stryCov_9fa48("58"), r => stryMutAct_9fa48("59") ? {} : (stryCov_9fa48("59"), {
          id: r.id,
          title: r.title,
          summary: stryMutAct_9fa48("62") ? r.summary && '' : stryMutAct_9fa48("61") ? false : stryMutAct_9fa48("60") ? true : (stryCov_9fa48("60", "61", "62"), r.summary || (stryMutAct_9fa48("63") ? "Stryker was here!" : (stryCov_9fa48("63"), '')))
        }))));
        const categories = stryMutAct_9fa48("64") ? [] : (stryCov_9fa48("64"), [...new Set(rows.map(stryMutAct_9fa48("65") ? () => undefined : (stryCov_9fa48("65"), r => r.category)))]);
        return stryMutAct_9fa48("66") ? {} : (stryCov_9fa48("66"), {
          topic: newCard.title,
          similar_cards: similarCards,
          categories
        });
      }
    } catch (err) {
      if (stryMutAct_9fa48("67")) {
        {}
      } else {
        stryCov_9fa48("67");
        console.warn(stryMutAct_9fa48("68") ? "" : (stryCov_9fa48("68"), '[AwarenessDaemon] Crystallization check failed:'), err.message);
        return null;
      }
    }
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
    if (stryMutAct_9fa48("69")) {
      {}
    } else {
      stryCov_9fa48("69");
      this.port = stryMutAct_9fa48("72") ? options.port && DEFAULT_PORT : stryMutAct_9fa48("71") ? false : stryMutAct_9fa48("70") ? true : (stryCov_9fa48("70", "71", "72"), options.port || DEFAULT_PORT);
      this.projectDir = stryMutAct_9fa48("75") ? options.projectDir && process.cwd() : stryMutAct_9fa48("74") ? false : stryMutAct_9fa48("73") ? true : (stryCov_9fa48("73", "74", "75"), options.projectDir || process.cwd());
      this.guardProfile = stryMutAct_9fa48("78") ? options.guardProfile && detectGuardProfile(this.projectDir) : stryMutAct_9fa48("77") ? false : stryMutAct_9fa48("76") ? true : (stryCov_9fa48("76", "77", "78"), options.guardProfile || detectGuardProfile(this.projectDir));
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
    if (stryMutAct_9fa48("79")) {
      {}
    } else {
      stryCov_9fa48("79");
      // SECURITY C4: Prevent unhandled rejections from crashing the daemon
      process.on(stryMutAct_9fa48("80") ? "" : (stryCov_9fa48("80"), 'unhandledRejection'), err => {
        if (stryMutAct_9fa48("81")) {
          {}
        } else {
          stryCov_9fa48("81");
          console.error(stryMutAct_9fa48("82") ? "" : (stryCov_9fa48("82"), '[awareness-local] unhandled rejection:'), stryMutAct_9fa48("85") ? err?.message && err : stryMutAct_9fa48("84") ? false : stryMutAct_9fa48("83") ? true : (stryCov_9fa48("83", "84", "85"), (stryMutAct_9fa48("86") ? err.message : (stryCov_9fa48("86"), err?.message)) || err));
        }
      });
      if (stryMutAct_9fa48("88") ? false : stryMutAct_9fa48("87") ? true : (stryCov_9fa48("87", "88"), await this.isRunning())) {
        if (stryMutAct_9fa48("89")) {
          {}
        } else {
          stryCov_9fa48("89");
          console.log(stryMutAct_9fa48("90") ? `` : (stryCov_9fa48("90"), `[awareness-local] daemon already running on port ${this.port}`));
          return stryMutAct_9fa48("91") ? {} : (stryCov_9fa48("91"), {
            alreadyRunning: stryMutAct_9fa48("92") ? false : (stryCov_9fa48("92"), true),
            port: this.port
          });
        }
      }

      // Ensure directory structure
      fs.mkdirSync(path.join(this.awarenessDir, stryMutAct_9fa48("93") ? "" : (stryCov_9fa48("93"), 'memories')), stryMutAct_9fa48("94") ? {} : (stryCov_9fa48("94"), {
        recursive: stryMutAct_9fa48("95") ? false : (stryCov_9fa48("95"), true)
      }));
      fs.mkdirSync(path.join(this.awarenessDir, stryMutAct_9fa48("96") ? "" : (stryCov_9fa48("96"), 'knowledge')), stryMutAct_9fa48("97") ? {} : (stryCov_9fa48("97"), {
        recursive: stryMutAct_9fa48("98") ? false : (stryCov_9fa48("98"), true)
      }));
      fs.mkdirSync(path.join(this.awarenessDir, stryMutAct_9fa48("99") ? "" : (stryCov_9fa48("99"), 'tasks')), stryMutAct_9fa48("100") ? {} : (stryCov_9fa48("100"), {
        recursive: stryMutAct_9fa48("101") ? false : (stryCov_9fa48("101"), true)
      }));

      // ---- Init core modules ----
      this.memoryStore = new MemoryStore(this.projectDir);
      try {
        if (stryMutAct_9fa48("102")) {
          {}
        } else {
          stryCov_9fa48("102");
          this.indexer = new Indexer(path.join(this.awarenessDir, stryMutAct_9fa48("103") ? "" : (stryCov_9fa48("103"), 'index.db')));
        }
      } catch (e) {
        if (stryMutAct_9fa48("104")) {
          {}
        } else {
          stryCov_9fa48("104");
          // Auto-rebuild better-sqlite3 when Node.js major version has changed
          if (stryMutAct_9fa48("107") ? e.message || e.message.includes('NODE_MODULE_VERSION') : stryMutAct_9fa48("106") ? false : stryMutAct_9fa48("105") ? true : (stryCov_9fa48("105", "106", "107"), e.message && e.message.includes(stryMutAct_9fa48("108") ? "" : (stryCov_9fa48("108"), 'NODE_MODULE_VERSION')))) {
            if (stryMutAct_9fa48("109")) {
              {}
            } else {
              stryCov_9fa48("109");
              const rebuilt = await this._tryRebuildBetterSqlite(e.message);
              if (stryMutAct_9fa48("111") ? false : stryMutAct_9fa48("110") ? true : (stryCov_9fa48("110", "111"), rebuilt)) {
                if (stryMutAct_9fa48("112")) {
                  {}
                } else {
                  stryCov_9fa48("112");
                  try {
                    if (stryMutAct_9fa48("113")) {
                      {}
                    } else {
                      stryCov_9fa48("113");
                      this.indexer = new Indexer(path.join(this.awarenessDir, stryMutAct_9fa48("114") ? "" : (stryCov_9fa48("114"), 'index.db')));
                    }
                  } catch (e2) {
                    if (stryMutAct_9fa48("115")) {
                      {}
                    } else {
                      stryCov_9fa48("115");
                      console.error(stryMutAct_9fa48("116") ? `` : (stryCov_9fa48("116"), `[awareness-local] SQLite still unavailable after rebuild: ${e2.message}`));
                      this.indexer = createNoopIndexer();
                    }
                  }
                }
              } else {
                if (stryMutAct_9fa48("117")) {
                  {}
                } else {
                  stryCov_9fa48("117");
                  this.indexer = createNoopIndexer();
                }
              }
            }
          } else {
            if (stryMutAct_9fa48("118")) {
              {}
            } else {
              stryCov_9fa48("118");
              console.error(stryMutAct_9fa48("119") ? `` : (stryCov_9fa48("119"), `[awareness-local] SQLite indexer unavailable: ${e.message}`));
              console.error(stryMutAct_9fa48("120") ? "" : (stryCov_9fa48("120"), '[awareness-local] Falling back to file-only mode (no search). Install better-sqlite3: npm install better-sqlite3'));
              this.indexer = createNoopIndexer();
            }
          }
        }
      }

      // Search and extractor are optional Phase 1 modules — import dynamically
      // so that missing files don't break daemon startup.
      this.search = await this._loadSearchEngine();
      this.extractor = await this._loadKnowledgeExtractor();

      // ---- Incremental index ----
      try {
        if (stryMutAct_9fa48("121")) {
          {}
        } else {
          stryCov_9fa48("121");
          const indexResult = await this.indexer.incrementalIndex(this.memoryStore);
          console.log((stryMutAct_9fa48("122") ? `` : (stryCov_9fa48("122"), `[awareness-local] indexed ${indexResult.indexed} files, `)) + (stryMutAct_9fa48("123") ? `` : (stryCov_9fa48("123"), `skipped ${indexResult.skipped}`)));
        }
      } catch (err) {
        if (stryMutAct_9fa48("124")) {
          {}
        } else {
          stryCov_9fa48("124");
          console.error(stryMutAct_9fa48("125") ? "" : (stryCov_9fa48("125"), '[awareness-local] incremental index error:'), err.message);
        }
      }

      // ---- Pre-warm embedding model + backfill (fire-and-forget, non-blocking) ----
      if (stryMutAct_9fa48("127") ? false : stryMutAct_9fa48("126") ? true : (stryCov_9fa48("126", "127"), this._embedder)) {
        if (stryMutAct_9fa48("128")) {
          {}
        } else {
          stryCov_9fa48("128");
          this._warmupEmbedder().catch(err => {
            if (stryMutAct_9fa48("129")) {
              {}
            } else {
              stryCov_9fa48("129");
              console.warn(stryMutAct_9fa48("130") ? "" : (stryCov_9fa48("130"), '[awareness-local] embedder warmup error:'), err.message);
            }
          });
        }
      }

      // ---- MCP server ----
      this.mcpServer = new LocalMcpServer(stryMutAct_9fa48("131") ? {} : (stryCov_9fa48("131"), {
        memoryStore: this.memoryStore,
        indexer: this.indexer,
        search: this.search,
        extractor: this.extractor,
        config: this._loadConfig(),
        loadSpec: stryMutAct_9fa48("132") ? () => undefined : (stryCov_9fa48("132"), () => this._loadSpec()),
        createSession: stryMutAct_9fa48("133") ? () => undefined : (stryCov_9fa48("133"), source => this._createSession(source)),
        remember: stryMutAct_9fa48("134") ? () => undefined : (stryCov_9fa48("134"), params => this._remember(params)),
        rememberBatch: stryMutAct_9fa48("135") ? () => undefined : (stryCov_9fa48("135"), params => this._rememberBatch(params)),
        updateTask: stryMutAct_9fa48("136") ? () => undefined : (stryCov_9fa48("136"), params => this._updateTask(params)),
        submitInsights: stryMutAct_9fa48("137") ? () => undefined : (stryCov_9fa48("137"), params => this._submitInsights(params)),
        lookup: stryMutAct_9fa48("138") ? () => undefined : (stryCov_9fa48("138"), params => this._lookup(params))
      }));

      // ---- Telemetry (opt-in) ----
      try {
        if (stryMutAct_9fa48("139")) {
          {}
        } else {
          stryCov_9fa48("139");
          const cfg = this._loadConfig();
          initTelemetry(stryMutAct_9fa48("140") ? {} : (stryCov_9fa48("140"), {
            config: cfg,
            projectDir: this.projectDir,
            version: PKG_VERSION
          }));
          const tel = getTelemetry();
          stryMutAct_9fa48("141") ? tel.track('daemon_started', {
            daemon_version: PKG_VERSION,
            os: process.platform,
            node_version: process.version,
            arch: process.arch,
            locale: Intl.DateTimeFormat().resolvedOptions().locale || 'unknown'
          }) : (stryCov_9fa48("141"), tel?.track(stryMutAct_9fa48("142") ? "" : (stryCov_9fa48("142"), 'daemon_started'), stryMutAct_9fa48("143") ? {} : (stryCov_9fa48("143"), {
            daemon_version: PKG_VERSION,
            os: process.platform,
            node_version: process.version,
            arch: process.arch,
            locale: stryMutAct_9fa48("146") ? Intl.DateTimeFormat().resolvedOptions().locale && 'unknown' : stryMutAct_9fa48("145") ? false : stryMutAct_9fa48("144") ? true : (stryCov_9fa48("144", "145", "146"), Intl.DateTimeFormat().resolvedOptions().locale || (stryMutAct_9fa48("147") ? "" : (stryCov_9fa48("147"), 'unknown')))
          })));
        }
      } catch (err) {
        if (stryMutAct_9fa48("148")) {
          {}
        } else {
          stryCov_9fa48("148");
          // Never let telemetry init block daemon startup.
          console.warn(stryMutAct_9fa48("149") ? "" : (stryCov_9fa48("149"), '[awareness-local] telemetry init failed:'), err.message);
        }
      }

      // ---- Cloud sync (optional) ----
      const config = this._loadConfig();
      if (stryMutAct_9fa48("152") ? config.cloud.enabled : stryMutAct_9fa48("151") ? false : stryMutAct_9fa48("150") ? true : (stryCov_9fa48("150", "151", "152"), config.cloud?.enabled)) {
        if (stryMutAct_9fa48("153")) {
          {}
        } else {
          stryCov_9fa48("153");
          try {
            if (stryMutAct_9fa48("154")) {
              {}
            } else {
              stryCov_9fa48("154");
              this.cloudSync = new CloudSync(config, this.indexer, this.memoryStore);
              if (stryMutAct_9fa48("156") ? false : stryMutAct_9fa48("155") ? true : (stryCov_9fa48("155", "156"), this.cloudSync.isEnabled())) {
                if (stryMutAct_9fa48("157")) {
                  {}
                } else {
                  stryCov_9fa48("157");
                  // Start cloud sync (non-blocking — errors won't prevent daemon startup)
                  this.cloudSync.start().catch(err => {
                    if (stryMutAct_9fa48("158")) {
                      {}
                    } else {
                      stryCov_9fa48("158");
                      console.warn(stryMutAct_9fa48("159") ? "" : (stryCov_9fa48("159"), '[awareness-local] cloud sync start failed:'), err.message);
                    }
                  });
                }
              }
            }
          } catch (err) {
            if (stryMutAct_9fa48("160")) {
              {}
            } else {
              stryCov_9fa48("160");
              console.warn(stryMutAct_9fa48("161") ? "" : (stryCov_9fa48("161"), '[awareness-local] cloud sync init failed:'), err.message);
              this.cloudSync = null;
            }
          }
        }
      }

      // ---- HTTP server ----
      this.httpServer = http.createServer(stryMutAct_9fa48("162") ? () => undefined : (stryCov_9fa48("162"), (req, res) => this._handleRequest(req, res)));
      try {
        if (stryMutAct_9fa48("163")) {
          {}
        } else {
          stryCov_9fa48("163");
          await new Promise((resolve, reject) => {
            if (stryMutAct_9fa48("164")) {
              {}
            } else {
              stryCov_9fa48("164");
              this.httpServer.on(stryMutAct_9fa48("165") ? "" : (stryCov_9fa48("165"), 'error'), reject);
              this.httpServer.listen(this.port, BIND_HOST, stryMutAct_9fa48("166") ? () => undefined : (stryCov_9fa48("166"), () => resolve()));
            }
          });
        }
      } catch (err) {
        if (stryMutAct_9fa48("167")) {
          {}
        } else {
          stryCov_9fa48("167");
          if (stryMutAct_9fa48("170") ? err.code !== 'EADDRINUSE' : stryMutAct_9fa48("169") ? false : stryMutAct_9fa48("168") ? true : (stryCov_9fa48("168", "169", "170"), err.code === (stryMutAct_9fa48("171") ? "" : (stryCov_9fa48("171"), 'EADDRINUSE')))) {
            if (stryMutAct_9fa48("172")) {
              {}
            } else {
              stryCov_9fa48("172");
              console.error((stryMutAct_9fa48("173") ? `` : (stryCov_9fa48("173"), `[awareness-local] Port ${this.port} is already in use.\n`)) + (stryMutAct_9fa48("174") ? `` : (stryCov_9fa48("174"), `  Possible causes:\n`)) + (stryMutAct_9fa48("175") ? `` : (stryCov_9fa48("175"), `  - Another awareness-local instance is running (try: awareness-local status)\n`)) + (stryMutAct_9fa48("176") ? `` : (stryCov_9fa48("176"), `  - Another application is using port ${this.port}\n`)) + (stryMutAct_9fa48("177") ? `` : (stryCov_9fa48("177"), `  Fix: Run "awareness-local stop" or "lsof -i :${this.port}" to find the process.`)));
            }
          }
          throw err;
        }
      }
      this._startedAt = Date.now();

      // ---- PID file ----
      fs.writeFileSync(this.pidFile, String(process.pid), stryMutAct_9fa48("178") ? "" : (stryCov_9fa48("178"), 'utf-8'));

      // ---- File watcher ----
      this._startFileWatcher();

      // ---- F-038: Workspace scanner (background, non-blocking) ----
      this._initWorkspaceScanner();

      // ---- Skill decay timer (every 24h) ----
      this._startSkillDecayTimer();
      console.log(stryMutAct_9fa48("179") ? `` : (stryCov_9fa48("179"), `[awareness-local] daemon running at http://localhost:${this.port}`));
      console.log(stryMutAct_9fa48("180") ? `` : (stryCov_9fa48("180"), `[awareness-local] MCP endpoint: http://localhost:${this.port}/mcp`));
      return stryMutAct_9fa48("181") ? {} : (stryCov_9fa48("181"), {
        started: stryMutAct_9fa48("182") ? false : (stryCov_9fa48("182"), true),
        port: this.port,
        pid: process.pid
      });
    }
  }

  /**
   * Stop the daemon gracefully.
   */
  async stop() {
    if (stryMutAct_9fa48("183")) {
      {}
    } else {
      stryCov_9fa48("183");
      // Stop file watcher
      if (stryMutAct_9fa48("185") ? false : stryMutAct_9fa48("184") ? true : (stryCov_9fa48("184", "185"), this.watcher)) {
        if (stryMutAct_9fa48("186")) {
          {}
        } else {
          stryCov_9fa48("186");
          this.watcher.close();
          this.watcher = null;
        }
      }
      if (stryMutAct_9fa48("188") ? false : stryMutAct_9fa48("187") ? true : (stryCov_9fa48("187", "188"), this._reindexTimer)) {
        if (stryMutAct_9fa48("189")) {
          {}
        } else {
          stryCov_9fa48("189");
          clearTimeout(this._reindexTimer);
          this._reindexTimer = null;
        }
      }
      if (stryMutAct_9fa48("191") ? false : stryMutAct_9fa48("190") ? true : (stryCov_9fa48("190", "191"), this._skillDecayTimer)) {
        if (stryMutAct_9fa48("192")) {
          {}
        } else {
          stryCov_9fa48("192");
          clearInterval(this._skillDecayTimer);
          this._skillDecayTimer = null;
        }
      }

      // Stop workspace watchers (F-038)
      if (stryMutAct_9fa48("194") ? false : stryMutAct_9fa48("193") ? true : (stryCov_9fa48("193", "194"), this._scanAbortController)) {
        if (stryMutAct_9fa48("195")) {
          {}
        } else {
          stryCov_9fa48("195");
          this._scanAbortController.abort();
          this._scanAbortController = null;
        }
      }
      if (stryMutAct_9fa48("197") ? false : stryMutAct_9fa48("196") ? true : (stryCov_9fa48("196", "197"), this._workspaceWatcher)) {
        if (stryMutAct_9fa48("198")) {
          {}
        } else {
          stryCov_9fa48("198");
          this._workspaceWatcher.close();
          this._workspaceWatcher = null;
        }
      }
      if (stryMutAct_9fa48("200") ? false : stryMutAct_9fa48("199") ? true : (stryCov_9fa48("199", "200"), this._gitHeadWatcher)) {
        if (stryMutAct_9fa48("201")) {
          {}
        } else {
          stryCov_9fa48("201");
          this._gitHeadWatcher.close();
          this._gitHeadWatcher = null;
        }
      }

      // Stop cloud sync
      if (stryMutAct_9fa48("203") ? false : stryMutAct_9fa48("202") ? true : (stryCov_9fa48("202", "203"), this.cloudSync)) {
        if (stryMutAct_9fa48("204")) {
          {}
        } else {
          stryCov_9fa48("204");
          this.cloudSync.stop();
          this.cloudSync = null;
        }
      }

      // Close MCP sessions
      this._mcpSessions.clear();

      // Close HTTP server
      if (stryMutAct_9fa48("206") ? false : stryMutAct_9fa48("205") ? true : (stryCov_9fa48("205", "206"), this.httpServer)) {
        if (stryMutAct_9fa48("207")) {
          {}
        } else {
          stryCov_9fa48("207");
          await new Promise(stryMutAct_9fa48("208") ? () => undefined : (stryCov_9fa48("208"), resolve => this.httpServer.close(resolve)));
          this.httpServer = null;
        }
      }

      // Close SQLite
      if (stryMutAct_9fa48("210") ? false : stryMutAct_9fa48("209") ? true : (stryCov_9fa48("209", "210"), this.indexer)) {
        if (stryMutAct_9fa48("211")) {
          {}
        } else {
          stryCov_9fa48("211");
          this.indexer.close();
          this.indexer = null;
        }
      }

      // Remove PID file
      try {
        if (stryMutAct_9fa48("212")) {
          {}
        } else {
          stryCov_9fa48("212");
          if (stryMutAct_9fa48("214") ? false : stryMutAct_9fa48("213") ? true : (stryCov_9fa48("213", "214"), fs.existsSync(this.pidFile))) {
            if (stryMutAct_9fa48("215")) {
              {}
            } else {
              stryCov_9fa48("215");
              fs.unlinkSync(this.pidFile);
            }
          }
        }
      } catch {
        // ignore cleanup errors
      }
      console.log(stryMutAct_9fa48("216") ? "" : (stryCov_9fa48("216"), '[awareness-local] daemon stopped'));
    }
  }

  /**
   * Check if a daemon instance is already running.
   * Validates both PID file and HTTP healthz endpoint.
   * @returns {Promise<boolean>}
   */
  async isRunning() {
    if (stryMutAct_9fa48("217")) {
      {}
    } else {
      stryCov_9fa48("217");
      if (stryMutAct_9fa48("220") ? false : stryMutAct_9fa48("219") ? true : stryMutAct_9fa48("218") ? fs.existsSync(this.pidFile) : (stryCov_9fa48("218", "219", "220"), !fs.existsSync(this.pidFile))) return stryMutAct_9fa48("221") ? true : (stryCov_9fa48("221"), false);
      let pid;
      try {
        if (stryMutAct_9fa48("222")) {
          {}
        } else {
          stryCov_9fa48("222");
          pid = parseInt(stryMutAct_9fa48("223") ? fs.readFileSync(this.pidFile, 'utf-8') : (stryCov_9fa48("223"), fs.readFileSync(this.pidFile, stryMutAct_9fa48("224") ? "" : (stryCov_9fa48("224"), 'utf-8')).trim()), 10);
        }
      } catch {
        if (stryMutAct_9fa48("225")) {
          {}
        } else {
          stryCov_9fa48("225");
          return stryMutAct_9fa48("226") ? true : (stryCov_9fa48("226"), false);
        }
      }

      // Check if process exists
      try {
        if (stryMutAct_9fa48("227")) {
          {}
        } else {
          stryCov_9fa48("227");
          process.kill(pid, 0);
        }
      } catch {
        if (stryMutAct_9fa48("228")) {
          {}
        } else {
          stryCov_9fa48("228");
          // Process dead — stale PID file
          this._cleanPidFile();
          return stryMutAct_9fa48("229") ? true : (stryCov_9fa48("229"), false);
        }
      }

      // Also verify HTTP endpoint is responsive
      const healthy = await httpHealthCheck(this.port);
      if (stryMutAct_9fa48("232") ? false : stryMutAct_9fa48("231") ? true : stryMutAct_9fa48("230") ? healthy : (stryCov_9fa48("230", "231", "232"), !healthy)) {
        if (stryMutAct_9fa48("233")) {
          {}
        } else {
          stryCov_9fa48("233");
          this._cleanPidFile();
          return stryMutAct_9fa48("234") ? true : (stryCov_9fa48("234"), false);
        }
      }
      return stryMutAct_9fa48("235") ? false : (stryCov_9fa48("235"), true);
    }
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
    if (stryMutAct_9fa48("236")) {
      {}
    } else {
      stryCov_9fa48("236");
      // CORS preflight
      if (stryMutAct_9fa48("239") ? req.method !== 'OPTIONS' : stryMutAct_9fa48("238") ? false : stryMutAct_9fa48("237") ? true : (stryCov_9fa48("237", "238", "239"), req.method === (stryMutAct_9fa48("240") ? "" : (stryCov_9fa48("240"), 'OPTIONS')))) {
        if (stryMutAct_9fa48("241")) {
          {}
        } else {
          stryCov_9fa48("241");
          res.writeHead(204, stryMutAct_9fa48("242") ? {} : (stryCov_9fa48("242"), {
            'Access-Control-Allow-Origin': stryMutAct_9fa48("243") ? "" : (stryCov_9fa48("243"), '*'),
            'Access-Control-Allow-Methods': stryMutAct_9fa48("244") ? "" : (stryCov_9fa48("244"), 'GET, POST, PUT, DELETE, OPTIONS'),
            'Access-Control-Allow-Headers': stryMutAct_9fa48("245") ? "" : (stryCov_9fa48("245"), 'Content-Type, Mcp-Session-Id, X-Awareness-Project-Dir')
          }));
          res.end();
          return;
        }
      }
      const url = new URL(req.url, stryMutAct_9fa48("246") ? `` : (stryCov_9fa48("246"), `http://localhost:${this.port}`));
      try {
        if (stryMutAct_9fa48("247")) {
          {}
        } else {
          stryCov_9fa48("247");
          // /healthz — exempt from project validation
          if (stryMutAct_9fa48("250") ? url.pathname !== '/healthz' : stryMutAct_9fa48("249") ? false : stryMutAct_9fa48("248") ? true : (stryCov_9fa48("248", "249", "250"), url.pathname === (stryMutAct_9fa48("251") ? "" : (stryCov_9fa48("251"), '/healthz')))) {
            if (stryMutAct_9fa48("252")) {
              {}
            } else {
              stryCov_9fa48("252");
              return this._handleHealthz(res);
            }
          }

          // Guard: reject requests while switchProject() is in progress
          if (stryMutAct_9fa48("254") ? false : stryMutAct_9fa48("253") ? true : (stryCov_9fa48("253", "254"), this._switching)) {
            if (stryMutAct_9fa48("255")) {
              {}
            } else {
              stryCov_9fa48("255");
              jsonResponse(res, stryMutAct_9fa48("256") ? {} : (stryCov_9fa48("256"), {
                error: stryMutAct_9fa48("257") ? "" : (stryCov_9fa48("257"), 'project_switching'),
                message: stryMutAct_9fa48("258") ? "" : (stryCov_9fa48("258"), 'Daemon is switching projects, retry shortly')
              }), 503);
              return;
            }
          }

          // Per-request project_dir validation via X-Awareness-Project-Dir header
          const requestedProject = req.headers[stryMutAct_9fa48("259") ? "" : (stryCov_9fa48("259"), 'x-awareness-project-dir')];
          if (stryMutAct_9fa48("261") ? false : stryMutAct_9fa48("260") ? true : (stryCov_9fa48("260", "261"), requestedProject)) {
            if (stryMutAct_9fa48("262")) {
              {}
            } else {
              stryCov_9fa48("262");
              const normalizedRequested = path.resolve(requestedProject);
              const normalizedCurrent = path.resolve(this.projectDir);
              if (stryMutAct_9fa48("265") ? normalizedRequested === normalizedCurrent : stryMutAct_9fa48("264") ? false : stryMutAct_9fa48("263") ? true : (stryCov_9fa48("263", "264", "265"), normalizedRequested !== normalizedCurrent)) {
                if (stryMutAct_9fa48("266")) {
                  {}
                } else {
                  stryCov_9fa48("266");
                  jsonResponse(res, stryMutAct_9fa48("267") ? {} : (stryCov_9fa48("267"), {
                    error: stryMutAct_9fa48("268") ? "" : (stryCov_9fa48("268"), 'project_mismatch'),
                    daemon_project: normalizedCurrent,
                    requested_project: normalizedRequested
                  }), 409);
                  return;
                }
              }
            }
          }

          // /mcp — MCP JSON-RPC over HTTP
          if (stryMutAct_9fa48("271") ? url.pathname === '/mcp' && url.pathname.startsWith('/mcp/') : stryMutAct_9fa48("270") ? false : stryMutAct_9fa48("269") ? true : (stryCov_9fa48("269", "270", "271"), (stryMutAct_9fa48("273") ? url.pathname !== '/mcp' : stryMutAct_9fa48("272") ? false : (stryCov_9fa48("272", "273"), url.pathname === (stryMutAct_9fa48("274") ? "" : (stryCov_9fa48("274"), '/mcp')))) || (stryMutAct_9fa48("275") ? url.pathname.endsWith('/mcp/') : (stryCov_9fa48("275"), url.pathname.startsWith(stryMutAct_9fa48("276") ? "" : (stryCov_9fa48("276"), '/mcp/')))))) {
            if (stryMutAct_9fa48("277")) {
              {}
            } else {
              stryCov_9fa48("277");
              return await this._handleMcp(req, res);
            }
          }

          // /api/v1/* — REST API
          if (stryMutAct_9fa48("280") ? url.pathname.endsWith('/api/v1') : stryMutAct_9fa48("279") ? false : stryMutAct_9fa48("278") ? true : (stryCov_9fa48("278", "279", "280"), url.pathname.startsWith(stryMutAct_9fa48("281") ? "" : (stryCov_9fa48("281"), '/api/v1')))) {
            if (stryMutAct_9fa48("282")) {
              {}
            } else {
              stryCov_9fa48("282");
              return await this._handleApi(req, res, url);
            }
          }

          // / — Web Dashboard
          if (stryMutAct_9fa48("285") ? url.pathname === '/' && url.pathname.startsWith('/web') : stryMutAct_9fa48("284") ? false : stryMutAct_9fa48("283") ? true : (stryCov_9fa48("283", "284", "285"), (stryMutAct_9fa48("287") ? url.pathname !== '/' : stryMutAct_9fa48("286") ? false : (stryCov_9fa48("286", "287"), url.pathname === (stryMutAct_9fa48("288") ? "" : (stryCov_9fa48("288"), '/')))) || (stryMutAct_9fa48("289") ? url.pathname.endsWith('/web') : (stryCov_9fa48("289"), url.pathname.startsWith(stryMutAct_9fa48("290") ? "" : (stryCov_9fa48("290"), '/web')))))) {
            if (stryMutAct_9fa48("291")) {
              {}
            } else {
              stryCov_9fa48("291");
              return this._handleWebUI(res, url.pathname);
            }
          }

          // 404
          jsonResponse(res, stryMutAct_9fa48("292") ? {} : (stryCov_9fa48("292"), {
            error: stryMutAct_9fa48("293") ? "" : (stryCov_9fa48("293"), 'Not Found')
          }), 404);
        }
      } catch (err) {
        if (stryMutAct_9fa48("294")) {
          {}
        } else {
          stryCov_9fa48("294");
          console.error(stryMutAct_9fa48("295") ? "" : (stryCov_9fa48("295"), '[awareness-local] request error:'), err.message);
          track(stryMutAct_9fa48("296") ? "" : (stryCov_9fa48("296"), 'error_occurred'), stryMutAct_9fa48("297") ? {} : (stryCov_9fa48("297"), {
            error_code: stryMutAct_9fa48("300") ? err.code && 'unknown' : stryMutAct_9fa48("299") ? false : stryMutAct_9fa48("298") ? true : (stryCov_9fa48("298", "299", "300"), err.code || (stryMutAct_9fa48("301") ? "" : (stryCov_9fa48("301"), 'unknown'))),
            component: stryMutAct_9fa48("302") ? "" : (stryCov_9fa48("302"), 'api')
          }));
          jsonResponse(res, stryMutAct_9fa48("303") ? {} : (stryCov_9fa48("303"), {
            error: stryMutAct_9fa48("304") ? "" : (stryCov_9fa48("304"), 'Internal Server Error')
          }), 500);
        }
      }
    }
  }

  /**
   * GET /healthz — health check + stats.
   */
  _handleHealthz(res) {
    if (stryMutAct_9fa48("305")) {
      {}
    } else {
      stryCov_9fa48("305");
      return handleHealthz(this, res, stryMutAct_9fa48("306") ? {} : (stryCov_9fa48("306"), {
        version: PKG_VERSION
      }));
    }
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
    if (stryMutAct_9fa48("307")) {
      {}
    } else {
      stryCov_9fa48("307");
      return handleMcpHttp(stryMutAct_9fa48("308") ? {} : (stryCov_9fa48("308"), {
        req,
        res,
        version: PKG_VERSION,
        dispatchJsonRpc: stryMutAct_9fa48("309") ? () => undefined : (stryCov_9fa48("309"), rpcRequest => this._dispatchJsonRpc(rpcRequest))
      }));
    }
  }

  /**
   * Dispatch a JSON-RPC request to the appropriate handler.
   * Supports the MCP protocol methods: initialize, tools/list, tools/call.
   * @param {object} rpcRequest
   * @returns {object} JSON-RPC response
   */
  async _dispatchJsonRpc(rpcRequest) {
    if (stryMutAct_9fa48("310")) {
      {}
    } else {
      stryCov_9fa48("310");
      return dispatchJsonRpcRequest(stryMutAct_9fa48("311") ? {} : (stryCov_9fa48("311"), {
        rpcRequest,
        getToolDefinitions: stryMutAct_9fa48("312") ? () => undefined : (stryCov_9fa48("312"), () => this._getToolDefinitions()),
        callTool: stryMutAct_9fa48("313") ? () => undefined : (stryCov_9fa48("313"), (name, args) => this._callTool(name, args))
      }));
    }
  }

  /**
   * Return MCP tool definitions for tools/list.
   * @returns {Array<object>}
   */
  _getToolDefinitions() {
    if (stryMutAct_9fa48("314")) {
      {}
    } else {
      stryCov_9fa48("314");
      return getToolDefinitions();
    }
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
    if (stryMutAct_9fa48("315")) {
      {}
    } else {
      stryCov_9fa48("315");
      return callMcpTool(this, name, args);
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
    if (stryMutAct_9fa48("316")) {
      {}
    } else {
      stryCov_9fa48("316");
      return handleApiRoute(this, req, res, url);
    }
  }

  /** Simple HTTP JSON request helper for cloud API calls. */
  async _httpJson(method, urlStr, body = null, extraHeaders = {}) {
    if (stryMutAct_9fa48("317")) {
      {}
    } else {
      stryCov_9fa48("317");
      return httpJson(method, urlStr, body, extraHeaders);
    }
  }

  // -----------------------------------------------------------------------
  // Web UI
  // -----------------------------------------------------------------------

  /**
   * Serve the web dashboard SPA from web/index.html.
   */
  _handleWebUI(res, pathname = stryMutAct_9fa48("318") ? "" : (stryCov_9fa48("318"), '/')) {
    if (stryMutAct_9fa48("319")) {
      {}
    } else {
      stryCov_9fa48("319");
      return handleWebUi(res, import.meta.url, pathname);
    }
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
    if (stryMutAct_9fa48("320")) {
      {}
    } else {
      stryCov_9fa48("320");
      const results = new Map(); // id → { card, score }

      // Channel 1: FTS5 search (sanitiseFtsQuery now handles CJK trigram splitting)
      if (stryMutAct_9fa48("322") ? false : stryMutAct_9fa48("321") ? true : (stryCov_9fa48("321", "322"), this.indexer.searchKnowledge)) {
        if (stryMutAct_9fa48("323")) {
          {}
        } else {
          stryCov_9fa48("323");
          try {
            if (stryMutAct_9fa48("324")) {
              {}
            } else {
              stryCov_9fa48("324");
              const ftsResults = this.indexer.searchKnowledge(query, stryMutAct_9fa48("325") ? {} : (stryCov_9fa48("325"), {
                limit: stryMutAct_9fa48("326") ? limit / 2 : (stryCov_9fa48("326"), limit * 2)
              }));
              for (const r of ftsResults) {
                if (stryMutAct_9fa48("327")) {
                  {}
                } else {
                  stryCov_9fa48("327");
                  results.set(r.id, stryMutAct_9fa48("328") ? {} : (stryCov_9fa48("328"), {
                    card: r,
                    score: stryMutAct_9fa48("329") ? 1 * (60 + (results.size + 1)) : (stryCov_9fa48("329"), 1 / (stryMutAct_9fa48("330") ? 60 - (results.size + 1) : (stryCov_9fa48("330"), 60 + (stryMutAct_9fa48("331") ? results.size - 1 : (stryCov_9fa48("331"), results.size + 1)))))
                  }));
                }
              }
            }
          } catch {/* FTS error — skip */}
        }
      }

      // Channel 2: Embedding cosine similarity (if available)
      if (stryMutAct_9fa48("333") ? false : stryMutAct_9fa48("332") ? true : (stryCov_9fa48("332", "333"), this._embedder)) {
        if (stryMutAct_9fa48("334")) {
          {}
        } else {
          stryCov_9fa48("334");
          try {
            if (stryMutAct_9fa48("335")) {
              {}
            } else {
              stryCov_9fa48("335");
              const available = await this._embedder.isEmbeddingAvailable();
              if (stryMutAct_9fa48("337") ? false : stryMutAct_9fa48("336") ? true : (stryCov_9fa48("336", "337"), available)) {
                if (stryMutAct_9fa48("338")) {
                  {}
                } else {
                  stryCov_9fa48("338");
                  // Use one consistent model for query+card embedding comparison
                  const embLang = detectNeedsCJK(query) ? stryMutAct_9fa48("339") ? "" : (stryCov_9fa48("339"), 'multilingual') : stryMutAct_9fa48("340") ? "" : (stryCov_9fa48("340"), 'english');
                  const queryVec = await this._embedder.embed(query, stryMutAct_9fa48("341") ? "" : (stryCov_9fa48("341"), 'query'), embLang);
                  const allCards = this.indexer.db.prepare(stryMutAct_9fa48("342") ? "" : (stryCov_9fa48("342"), "SELECT * FROM knowledge_cards WHERE status = 'active' ORDER BY created_at DESC LIMIT 50")).all();
                  for (const card of allCards) {
                    if (stryMutAct_9fa48("343")) {
                      {}
                    } else {
                      stryCov_9fa48("343");
                      const cardText = stryMutAct_9fa48("344") ? `${card.title || ''} ${card.summary || ''}` : (stryCov_9fa48("344"), (stryMutAct_9fa48("345") ? `` : (stryCov_9fa48("345"), `${stryMutAct_9fa48("348") ? card.title && '' : stryMutAct_9fa48("347") ? false : stryMutAct_9fa48("346") ? true : (stryCov_9fa48("346", "347", "348"), card.title || (stryMutAct_9fa48("349") ? "Stryker was here!" : (stryCov_9fa48("349"), '')))} ${stryMutAct_9fa48("352") ? card.summary && '' : stryMutAct_9fa48("351") ? false : stryMutAct_9fa48("350") ? true : (stryCov_9fa48("350", "351", "352"), card.summary || (stryMutAct_9fa48("353") ? "Stryker was here!" : (stryCov_9fa48("353"), '')))}`)).trim());
                      if (stryMutAct_9fa48("356") ? false : stryMutAct_9fa48("355") ? true : stryMutAct_9fa48("354") ? cardText : (stryCov_9fa48("354", "355", "356"), !cardText)) continue;
                      try {
                        if (stryMutAct_9fa48("357")) {
                          {}
                        } else {
                          stryCov_9fa48("357");
                          // Use same model as query to ensure vectors are in same space
                          const cardVec = await this._embedder.embed(cardText, stryMutAct_9fa48("358") ? "" : (stryCov_9fa48("358"), 'passage'), embLang);
                          const sim = this._embedder.cosineSimilarity(queryVec, cardVec);
                          const existing = results.get(card.id);
                          const ftsScore = stryMutAct_9fa48("361") ? existing?.score && 0 : stryMutAct_9fa48("360") ? false : stryMutAct_9fa48("359") ? true : (stryCov_9fa48("359", "360", "361"), (stryMutAct_9fa48("362") ? existing.score : (stryCov_9fa48("362"), existing?.score)) || 0);
                          results.set(card.id, stryMutAct_9fa48("363") ? {} : (stryCov_9fa48("363"), {
                            card,
                            score: stryMutAct_9fa48("364") ? ftsScore - sim : (stryCov_9fa48("364"), ftsScore + sim)
                          }));
                        }
                      } catch {/* skip individual card errors */}
                    }
                  }
                }
              }
            }
          } catch {/* Embedder not available — FTS-only */}
        }
      }

      // Sort by combined score descending
      const sorted = stryMutAct_9fa48("366") ? [...results.values()].slice(0, limit).map(r => r.card) : stryMutAct_9fa48("365") ? [...results.values()].sort((a, b) => b.score - a.score).map(r => r.card) : (stryCov_9fa48("365", "366"), (stryMutAct_9fa48("367") ? [] : (stryCov_9fa48("367"), [...results.values()])).sort(stryMutAct_9fa48("368") ? () => undefined : (stryCov_9fa48("368"), (a, b) => stryMutAct_9fa48("369") ? b.score + a.score : (stryCov_9fa48("369"), b.score - a.score))).slice(0, limit).map(stryMutAct_9fa48("370") ? () => undefined : (stryCov_9fa48("370"), r => r.card)));

      // Supplement with recent cards if not enough results
      if (stryMutAct_9fa48("374") ? sorted.length >= limit : stryMutAct_9fa48("373") ? sorted.length <= limit : stryMutAct_9fa48("372") ? false : stryMutAct_9fa48("371") ? true : (stryCov_9fa48("371", "372", "373", "374"), sorted.length < limit)) {
        if (stryMutAct_9fa48("375")) {
          {}
        } else {
          stryCov_9fa48("375");
          const matchedIds = new Set(sorted.map(stryMutAct_9fa48("376") ? () => undefined : (stryCov_9fa48("376"), c => c.id)));
          const recent = stryMutAct_9fa48("377") ? this.indexer.getRecentKnowledge(limit) : (stryCov_9fa48("377"), this.indexer.getRecentKnowledge(limit).filter(stryMutAct_9fa48("378") ? () => undefined : (stryCov_9fa48("378"), c => stryMutAct_9fa48("379") ? matchedIds.has(c.id) : (stryCov_9fa48("379"), !matchedIds.has(c.id)))));
          return stryMutAct_9fa48("380") ? [...sorted, ...recent] : (stryCov_9fa48("380"), (stryMutAct_9fa48("381") ? [] : (stryCov_9fa48("381"), [...sorted, ...recent])).slice(0, limit));
        }
      }
      return sorted;
    }
  }

  /** Create a new session and return session metadata. */
  _createSession(source) {
    if (stryMutAct_9fa48("382")) {
      {}
    } else {
      stryCov_9fa48("382");
      return this.indexer.createSession(stryMutAct_9fa48("385") ? source && 'local' : stryMutAct_9fa48("384") ? false : stryMutAct_9fa48("383") ? true : (stryCov_9fa48("383", "384", "385"), source || (stryMutAct_9fa48("386") ? "" : (stryCov_9fa48("386"), 'local'))));
    }
  }

  /** Max content size per memory (1 MB). */
  static MAX_CONTENT_BYTES = stryMutAct_9fa48("387") ? 1024 / 1024 : (stryCov_9fa48("387"), 1024 * 1024);

  /** Write a single memory, index it, and trigger knowledge extraction. */
  async _remember(params) {
    if (stryMutAct_9fa48("388")) {
      {}
    } else {
      stryCov_9fa48("388");
      if (stryMutAct_9fa48("391") ? false : stryMutAct_9fa48("390") ? true : stryMutAct_9fa48("389") ? params.content : (stryCov_9fa48("389", "390", "391"), !params.content)) {
        if (stryMutAct_9fa48("392")) {
          {}
        } else {
          stryCov_9fa48("392");
          return stryMutAct_9fa48("393") ? {} : (stryCov_9fa48("393"), {
            error: stryMutAct_9fa48("394") ? "" : (stryCov_9fa48("394"), 'content is required for remember action')
          });
        }
      }
      const noiseReason = classifyNoiseEvent(params);
      if (stryMutAct_9fa48("396") ? false : stryMutAct_9fa48("395") ? true : (stryCov_9fa48("395", "396"), noiseReason)) {
        if (stryMutAct_9fa48("397")) {
          {}
        } else {
          stryCov_9fa48("397");
          return stryMutAct_9fa48("398") ? {} : (stryCov_9fa48("398"), {
            status: stryMutAct_9fa48("399") ? "" : (stryCov_9fa48("399"), 'skipped'),
            reason: noiseReason
          });
        }
      }

      // SECURITY H1: Reject oversized content to prevent FTS5/embedding freeze
      if (stryMutAct_9fa48("402") ? typeof params.content === 'string' || params.content.length > AwarenessLocalDaemon.MAX_CONTENT_BYTES : stryMutAct_9fa48("401") ? false : stryMutAct_9fa48("400") ? true : (stryCov_9fa48("400", "401", "402"), (stryMutAct_9fa48("404") ? typeof params.content !== 'string' : stryMutAct_9fa48("403") ? true : (stryCov_9fa48("403", "404"), typeof params.content === (stryMutAct_9fa48("405") ? "" : (stryCov_9fa48("405"), 'string')))) && (stryMutAct_9fa48("408") ? params.content.length <= AwarenessLocalDaemon.MAX_CONTENT_BYTES : stryMutAct_9fa48("407") ? params.content.length >= AwarenessLocalDaemon.MAX_CONTENT_BYTES : stryMutAct_9fa48("406") ? true : (stryCov_9fa48("406", "407", "408"), params.content.length > AwarenessLocalDaemon.MAX_CONTENT_BYTES)))) {
        if (stryMutAct_9fa48("409")) {
          {}
        } else {
          stryCov_9fa48("409");
          return stryMutAct_9fa48("410") ? {} : (stryCov_9fa48("410"), {
            error: stryMutAct_9fa48("411") ? `` : (stryCov_9fa48("411"), `Content too large (${params.content.length} bytes, max ${AwarenessLocalDaemon.MAX_CONTENT_BYTES})`)
          });
        }
      }

      // Auto-generate title from content if not provided
      let title = stryMutAct_9fa48("414") ? params.title && '' : stryMutAct_9fa48("413") ? false : stryMutAct_9fa48("412") ? true : (stryCov_9fa48("412", "413", "414"), params.title || (stryMutAct_9fa48("415") ? "Stryker was here!" : (stryCov_9fa48("415"), '')));
      if (stryMutAct_9fa48("418") ? !title || params.content : stryMutAct_9fa48("417") ? false : stryMutAct_9fa48("416") ? true : (stryCov_9fa48("416", "417", "418"), (stryMutAct_9fa48("419") ? title : (stryCov_9fa48("419"), !title)) && params.content)) {
        if (stryMutAct_9fa48("420")) {
          {}
        } else {
          stryCov_9fa48("420");
          // Take first sentence or first 80 chars, whichever is shorter
          const firstLine = stryMutAct_9fa48("421") ? params.content.split(/[.\n!?。！？]/)[0] : (stryCov_9fa48("421"), params.content.split(stryMutAct_9fa48("422") ? /[^.\n!?。！？]/ : (stryCov_9fa48("422"), /[.\n!?。！？]/))[0].trim());
          title = (stryMutAct_9fa48("426") ? firstLine.length <= 80 : stryMutAct_9fa48("425") ? firstLine.length >= 80 : stryMutAct_9fa48("424") ? false : stryMutAct_9fa48("423") ? true : (stryCov_9fa48("423", "424", "425", "426"), firstLine.length > 80)) ? (stryMutAct_9fa48("427") ? firstLine : (stryCov_9fa48("427"), firstLine.substring(0, 77))) + (stryMutAct_9fa48("428") ? "" : (stryCov_9fa48("428"), '...')) : firstLine;
        }
      }
      const memory = stryMutAct_9fa48("429") ? {} : (stryCov_9fa48("429"), {
        type: stryMutAct_9fa48("432") ? params.event_type && 'turn_summary' : stryMutAct_9fa48("431") ? false : stryMutAct_9fa48("430") ? true : (stryCov_9fa48("430", "431", "432"), params.event_type || (stryMutAct_9fa48("433") ? "" : (stryCov_9fa48("433"), 'turn_summary'))),
        content: params.content,
        title,
        tags: stryMutAct_9fa48("436") ? params.tags && [] : stryMutAct_9fa48("435") ? false : stryMutAct_9fa48("434") ? true : (stryCov_9fa48("434", "435", "436"), params.tags || (stryMutAct_9fa48("437") ? ["Stryker was here"] : (stryCov_9fa48("437"), []))),
        agent_role: stryMutAct_9fa48("440") ? params.agent_role && 'builder_agent' : stryMutAct_9fa48("439") ? false : stryMutAct_9fa48("438") ? true : (stryCov_9fa48("438", "439", "440"), params.agent_role || (stryMutAct_9fa48("441") ? "" : (stryCov_9fa48("441"), 'builder_agent'))),
        session_id: stryMutAct_9fa48("444") ? params.session_id && '' : stryMutAct_9fa48("443") ? false : stryMutAct_9fa48("442") ? true : (stryCov_9fa48("442", "443", "444"), params.session_id || (stryMutAct_9fa48("445") ? "Stryker was here!" : (stryCov_9fa48("445"), ''))),
        source: stryMutAct_9fa48("448") ? params.source && 'mcp' : stryMutAct_9fa48("447") ? false : stryMutAct_9fa48("446") ? true : (stryCov_9fa48("446", "447", "448"), params.source || (stryMutAct_9fa48("449") ? "" : (stryCov_9fa48("449"), 'mcp')))
      });

      // Write markdown file
      const {
        id,
        filepath
      } = await this.memoryStore.write(memory);

      // Index in SQLite
      this.indexer.indexMemory(id, stryMutAct_9fa48("450") ? {} : (stryCov_9fa48("450"), {
        ...memory,
        filepath
      }), params.content);

      // Generate and store embedding for vector search (fire-and-forget)
      this._embedAndStore(id, params.content).catch(() => {});

      // Knowledge extraction (fire-and-forget)
      this._extractAndIndex(id, params.content, memory, params.insights);

      // Cloud sync (fire-and-forget — don't block the response)
      if (stryMutAct_9fa48("453") ? this.cloudSync.isEnabled() : stryMutAct_9fa48("452") ? false : stryMutAct_9fa48("451") ? true : (stryCov_9fa48("451", "452", "453"), this.cloudSync?.isEnabled())) {
        if (stryMutAct_9fa48("454")) {
          {}
        } else {
          stryCov_9fa48("454");
          Promise.all(stryMutAct_9fa48("455") ? [] : (stryCov_9fa48("455"), [this.cloudSync.syncToCloud(), this.cloudSync.syncInsightsToCloud(), this.cloudSync.syncTasksToCloud()])).catch(err => {
            if (stryMutAct_9fa48("456")) {
              {}
            } else {
              stryCov_9fa48("456");
              console.warn(stryMutAct_9fa48("457") ? "" : (stryCov_9fa48("457"), '[awareness-local] cloud sync after remember failed:'), err.message);
            }
          });
        }
      }

      // Lifecycle: auto-resolve tasks/risks, garbage collect (fire-and-forget, hybrid FTS5+embedding)
      const lifecycleOpts = {};
      if (stryMutAct_9fa48("459") ? false : stryMutAct_9fa48("458") ? true : (stryCov_9fa48("458", "459"), this._embedder)) {
        if (stryMutAct_9fa48("460")) {
          {}
        } else {
          stryCov_9fa48("460");
          lifecycleOpts.embedFn = stryMutAct_9fa48("461") ? () => undefined : (stryCov_9fa48("461"), (text, type) => this._embedder.embed(text, type));
          lifecycleOpts.cosineFn = this._embedder.cosineSimilarity;
        }
      }
      const lifecycle = await runLifecycleChecks(this.indexer, params.content, title, params.insights, lifecycleOpts);

      // Perception: surface signals the agent didn't ask about (Eywa Whisper)
      const perception = this._buildPerception(params.content, title, memory, params.insights);

      // Fire-and-forget: LLM auto-resolve check on existing active perceptions
      this._checkPerceptionResolution(id, stryMutAct_9fa48("462") ? {} : (stryCov_9fa48("462"), {
        title,
        content: params.content,
        tags: memory.tags,
        insights: params.insights
      })).catch(err => {
        if (stryMutAct_9fa48("463")) {
          {}
        } else {
          stryCov_9fa48("463");
          if (stryMutAct_9fa48("465") ? false : stryMutAct_9fa48("464") ? true : (stryCov_9fa48("464", "465"), process.env.DEBUG)) console.warn(stryMutAct_9fa48("466") ? "" : (stryCov_9fa48("466"), '[awareness-local] perception resolve failed:'), err.message);
        }
      });
      const result = stryMutAct_9fa48("467") ? {} : (stryCov_9fa48("467"), {
        status: stryMutAct_9fa48("468") ? "" : (stryCov_9fa48("468"), 'ok'),
        id,
        filepath,
        mode: stryMutAct_9fa48("469") ? "" : (stryCov_9fa48("469"), 'local')
      });

      // Return _extraction_instruction when the caller didn't provide pre-extracted insights.
      // This mirrors the cloud MCP backend behaviour: the client LLM does extraction using
      // its own model, then calls awareness_record(action="submit_insights") with the result.
      if (stryMutAct_9fa48("471") ? false : stryMutAct_9fa48("470") ? true : (stryCov_9fa48("470", "471"), shouldRequestExtraction(params))) {
        if (stryMutAct_9fa48("472")) {
          {}
        } else {
          stryCov_9fa48("472");
          try {
            if (stryMutAct_9fa48("473")) {
              {}
            } else {
              stryCov_9fa48("473");
              const existingCards = this.indexer.db.prepare(stryMutAct_9fa48("474") ? "" : (stryCov_9fa48("474"), "SELECT id, title, category, summary FROM knowledge_cards WHERE status = 'active' ORDER BY created_at DESC LIMIT 8")).all();
              const spec = this._loadSpec();
              result._extraction_instruction = buildExtractionInstruction(stryMutAct_9fa48("475") ? {} : (stryCov_9fa48("475"), {
                content: params.content,
                memoryId: id,
                existingCards,
                spec
              }));
            }
          } catch (_err) {
            // Non-fatal: extraction instruction is best-effort
          }
        }
      }
      if (stryMutAct_9fa48("478") ? perception || perception.length > 0 : stryMutAct_9fa48("477") ? false : stryMutAct_9fa48("476") ? true : (stryCov_9fa48("476", "477", "478"), perception && (stryMutAct_9fa48("481") ? perception.length <= 0 : stryMutAct_9fa48("480") ? perception.length >= 0 : stryMutAct_9fa48("479") ? true : (stryCov_9fa48("479", "480", "481"), perception.length > 0)))) {
        if (stryMutAct_9fa48("482")) {
          {}
        } else {
          stryCov_9fa48("482");
          result.perception = perception;
        }
      }

      // Surface lifecycle actions in response
      if (stryMutAct_9fa48("486") ? lifecycle.resolved_tasks.length <= 0 : stryMutAct_9fa48("485") ? lifecycle.resolved_tasks.length >= 0 : stryMutAct_9fa48("484") ? false : stryMutAct_9fa48("483") ? true : (stryCov_9fa48("483", "484", "485", "486"), lifecycle.resolved_tasks.length > 0)) {
        if (stryMutAct_9fa48("487")) {
          {}
        } else {
          stryCov_9fa48("487");
          result.resolved_tasks = lifecycle.resolved_tasks;
        }
      }
      if (stryMutAct_9fa48("491") ? lifecycle.mitigated_risks.length <= 0 : stryMutAct_9fa48("490") ? lifecycle.mitigated_risks.length >= 0 : stryMutAct_9fa48("489") ? false : stryMutAct_9fa48("488") ? true : (stryCov_9fa48("488", "489", "490", "491"), lifecycle.mitigated_risks.length > 0)) {
        if (stryMutAct_9fa48("492")) {
          {}
        } else {
          stryCov_9fa48("492");
          result.mitigated_risks = lifecycle.mitigated_risks;
        }
      }
      if (stryMutAct_9fa48("496") ? lifecycle.archived <= 0 : stryMutAct_9fa48("495") ? lifecycle.archived >= 0 : stryMutAct_9fa48("494") ? false : stryMutAct_9fa48("493") ? true : (stryCov_9fa48("493", "494", "495", "496"), lifecycle.archived > 0)) {
        if (stryMutAct_9fa48("497")) {
          {}
        } else {
          stryCov_9fa48("497");
          result.archived_count = lifecycle.archived;
        }
      }
      return result;
    }
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
    if (stryMutAct_9fa48("498")) {
      {}
    } else {
      stryCov_9fa48("498");
      const signals = detectGuardSignals(stryMutAct_9fa48("499") ? {} : (stryCov_9fa48("499"), {
        content,
        title,
        tags: stryMutAct_9fa48("500") ? memory.tags : (stryCov_9fa48("500"), memory?.tags),
        insights
      }), stryMutAct_9fa48("501") ? {} : (stryCov_9fa48("501"), {
        profile: this.guardProfile
      }));
      try {
        if (stryMutAct_9fa48("502")) {
          {}
        } else {
          stryCov_9fa48("502");
          // 1. Resonance: find similar existing knowledge cards via FTS5
          if (stryMutAct_9fa48("505") ? title || title.length >= 5 : stryMutAct_9fa48("504") ? false : stryMutAct_9fa48("503") ? true : (stryCov_9fa48("503", "504", "505"), title && (stryMutAct_9fa48("508") ? title.length < 5 : stryMutAct_9fa48("507") ? title.length > 5 : stryMutAct_9fa48("506") ? true : (stryCov_9fa48("506", "507", "508"), title.length >= 5)))) {
            if (stryMutAct_9fa48("509")) {
              {}
            } else {
              stryCov_9fa48("509");
              const resonanceResults = this.indexer.searchKnowledge(title, stryMutAct_9fa48("510") ? {} : (stryCov_9fa48("510"), {
                limit: 2
              }));
              for (const r of resonanceResults) {
                if (stryMutAct_9fa48("511")) {
                  {}
                } else {
                  stryCov_9fa48("511");
                  // BM25 rank: closer to 0 = better match. Only surface strong matches.
                  if (stryMutAct_9fa48("515") ? r.rank <= -3.0 : stryMutAct_9fa48("514") ? r.rank >= -3.0 : stryMutAct_9fa48("513") ? false : stryMutAct_9fa48("512") ? true : (stryCov_9fa48("512", "513", "514", "515"), r.rank > (stryMutAct_9fa48("516") ? +3.0 : (stryCov_9fa48("516"), -3.0)))) {
                    if (stryMutAct_9fa48("517")) {
                      {}
                    } else {
                      stryCov_9fa48("517");
                      const daysAgo = r.created_at ? Math.floor(stryMutAct_9fa48("518") ? (Date.now() - new Date(r.created_at).getTime()) * 86400000 : (stryCov_9fa48("518"), (stryMutAct_9fa48("519") ? Date.now() + new Date(r.created_at).getTime() : (stryCov_9fa48("519"), Date.now() - new Date(r.created_at).getTime())) / 86400000)) : 0;
                      signals.push(stryMutAct_9fa48("520") ? {} : (stryCov_9fa48("520"), {
                        type: stryMutAct_9fa48("521") ? "" : (stryCov_9fa48("521"), 'resonance'),
                        title: r.title,
                        summary: stryMutAct_9fa48("524") ? r.summary && '' : stryMutAct_9fa48("523") ? false : stryMutAct_9fa48("522") ? true : (stryCov_9fa48("522", "523", "524"), r.summary || (stryMutAct_9fa48("525") ? "Stryker was here!" : (stryCov_9fa48("525"), ''))),
                        category: stryMutAct_9fa48("528") ? r.category && '' : stryMutAct_9fa48("527") ? false : stryMutAct_9fa48("526") ? true : (stryCov_9fa48("526", "527", "528"), r.category || (stryMutAct_9fa48("529") ? "Stryker was here!" : (stryCov_9fa48("529"), ''))),
                        card_id: r.id,
                        days_ago: daysAgo,
                        message: stryMutAct_9fa48("530") ? `` : (stryCov_9fa48("530"), `🌿 Similar past experience (${daysAgo}d ago): "${r.title}"`)
                      }));
                    }
                  }
                }
              }
            }
          }

          // 2. Pattern: detect recurring themes via tag co-occurrence (not just category count)
          if (stryMutAct_9fa48("534") ? insights.knowledge_cards?.length : stryMutAct_9fa48("533") ? insights?.knowledge_cards.length : stryMutAct_9fa48("532") ? false : stryMutAct_9fa48("531") ? true : (stryCov_9fa48("531", "532", "533", "534"), insights?.knowledge_cards?.length)) {
            if (stryMutAct_9fa48("535")) {
              {}
            } else {
              stryCov_9fa48("535");
              try {
                if (stryMutAct_9fa48("536")) {
                  {}
                } else {
                  stryCov_9fa48("536");
                  // Collect tags from the last 7 days of active cards
                  const recentCards = this.indexer.db.prepare(stryMutAct_9fa48("537") ? `` : (stryCov_9fa48("537"), `SELECT tags FROM knowledge_cards
               WHERE status = 'active' AND created_at > datetime('now', '-7 days')`)).all();
                  const tagCounts = new Map();
                  for (const row of recentCards) {
                    if (stryMutAct_9fa48("538")) {
                      {}
                    } else {
                      stryCov_9fa48("538");
                      let tags = stryMutAct_9fa48("539") ? ["Stryker was here"] : (stryCov_9fa48("539"), []);
                      try {
                        if (stryMutAct_9fa48("540")) {
                          {}
                        } else {
                          stryCov_9fa48("540");
                          tags = JSON.parse(stryMutAct_9fa48("543") ? row.tags && '[]' : stryMutAct_9fa48("542") ? false : stryMutAct_9fa48("541") ? true : (stryCov_9fa48("541", "542", "543"), row.tags || (stryMutAct_9fa48("544") ? "" : (stryCov_9fa48("544"), '[]'))));
                        }
                      } catch {/* skip */}
                      for (const t of tags) {
                        if (stryMutAct_9fa48("545")) {
                          {}
                        } else {
                          stryCov_9fa48("545");
                          if (stryMutAct_9fa48("548") ? typeof t === 'string' || t.length >= 2 : stryMutAct_9fa48("547") ? false : stryMutAct_9fa48("546") ? true : (stryCov_9fa48("546", "547", "548"), (stryMutAct_9fa48("550") ? typeof t !== 'string' : stryMutAct_9fa48("549") ? true : (stryCov_9fa48("549", "550"), typeof t === (stryMutAct_9fa48("551") ? "" : (stryCov_9fa48("551"), 'string')))) && (stryMutAct_9fa48("554") ? t.length < 2 : stryMutAct_9fa48("553") ? t.length > 2 : stryMutAct_9fa48("552") ? true : (stryCov_9fa48("552", "553", "554"), t.length >= 2)))) {
                            if (stryMutAct_9fa48("555")) {
                              {}
                            } else {
                              stryCov_9fa48("555");
                              const k = stryMutAct_9fa48("556") ? t.toUpperCase() : (stryCov_9fa48("556"), t.toLowerCase());
                              tagCounts.set(k, stryMutAct_9fa48("557") ? (tagCounts.get(k) || 0) - 1 : (stryCov_9fa48("557"), (stryMutAct_9fa48("560") ? tagCounts.get(k) && 0 : stryMutAct_9fa48("559") ? false : stryMutAct_9fa48("558") ? true : (stryCov_9fa48("558", "559", "560"), tagCounts.get(k) || 0)) + 1));
                            }
                          }
                        }
                      }
                    }
                  }
                  // Find dominant themes (3+ occurrences in 7 days)
                  const themes = stryMutAct_9fa48("563") ? [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2) : stryMutAct_9fa48("562") ? [...tagCounts.entries()].filter(([, count]) => count >= 3).slice(0, 2) : stryMutAct_9fa48("561") ? [...tagCounts.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]) : (stryCov_9fa48("561", "562", "563"), (stryMutAct_9fa48("564") ? [] : (stryCov_9fa48("564"), [...tagCounts.entries()])).filter(stryMutAct_9fa48("565") ? () => undefined : (stryCov_9fa48("565"), ([, count]) => stryMutAct_9fa48("569") ? count < 3 : stryMutAct_9fa48("568") ? count > 3 : stryMutAct_9fa48("567") ? false : stryMutAct_9fa48("566") ? true : (stryCov_9fa48("566", "567", "568", "569"), count >= 3))).sort(stryMutAct_9fa48("570") ? () => undefined : (stryCov_9fa48("570"), (a, b) => stryMutAct_9fa48("571") ? b[1] + a[1] : (stryCov_9fa48("571"), b[1] - a[1]))).slice(0, 2));
                  for (const [tag, count] of themes) {
                    if (stryMutAct_9fa48("572")) {
                      {}
                    } else {
                      stryCov_9fa48("572");
                      signals.push(stryMutAct_9fa48("573") ? {} : (stryCov_9fa48("573"), {
                        type: stryMutAct_9fa48("574") ? "" : (stryCov_9fa48("574"), 'pattern'),
                        tag,
                        count,
                        message: stryMutAct_9fa48("575") ? `` : (stryCov_9fa48("575"), `🔄 Recurring theme in last 7 days: "${tag}" (${count} cards) — consider a systematic approach`)
                      }));
                    }
                  }
                }
              } catch {/* ignore */}
            }
          }

          // 3. Staleness: find related but old knowledge (30-day threshold, unified)
          if (stryMutAct_9fa48("578") ? title || title.length >= 5 : stryMutAct_9fa48("577") ? false : stryMutAct_9fa48("576") ? true : (stryCov_9fa48("576", "577", "578"), title && (stryMutAct_9fa48("581") ? title.length < 5 : stryMutAct_9fa48("580") ? title.length > 5 : stryMutAct_9fa48("579") ? true : (stryCov_9fa48("579", "580", "581"), title.length >= 5)))) {
            if (stryMutAct_9fa48("582")) {
              {}
            } else {
              stryCov_9fa48("582");
              try {
                if (stryMutAct_9fa48("583")) {
                  {}
                } else {
                  stryCov_9fa48("583");
                  const relatedResults = this.indexer.searchKnowledge(title, stryMutAct_9fa48("584") ? {} : (stryCov_9fa48("584"), {
                    limit: 3
                  }));
                  for (const r of relatedResults) {
                    if (stryMutAct_9fa48("585")) {
                      {}
                    } else {
                      stryCov_9fa48("585");
                      const ts = stryMutAct_9fa48("588") ? r.updated_at && r.created_at : stryMutAct_9fa48("587") ? false : stryMutAct_9fa48("586") ? true : (stryCov_9fa48("586", "587", "588"), r.updated_at || r.created_at);
                      if (stryMutAct_9fa48("591") ? false : stryMutAct_9fa48("590") ? true : stryMutAct_9fa48("589") ? ts : (stryCov_9fa48("589", "590", "591"), !ts)) continue;
                      const daysOld = Math.floor(stryMutAct_9fa48("592") ? (Date.now() - new Date(ts).getTime()) * 86400000 : (stryCov_9fa48("592"), (stryMutAct_9fa48("593") ? Date.now() + new Date(ts).getTime() : (stryCov_9fa48("593"), Date.now() - new Date(ts).getTime())) / 86400000));
                      if (stryMutAct_9fa48("597") ? daysOld < 30 : stryMutAct_9fa48("596") ? daysOld > 30 : stryMutAct_9fa48("595") ? false : stryMutAct_9fa48("594") ? true : (stryCov_9fa48("594", "595", "596", "597"), daysOld >= 30)) {
                        if (stryMutAct_9fa48("598")) {
                          {}
                        } else {
                          stryCov_9fa48("598");
                          signals.push(stryMutAct_9fa48("599") ? {} : (stryCov_9fa48("599"), {
                            type: stryMutAct_9fa48("600") ? "" : (stryCov_9fa48("600"), 'staleness'),
                            title: r.title,
                            category: stryMutAct_9fa48("603") ? r.category && '' : stryMutAct_9fa48("602") ? false : stryMutAct_9fa48("601") ? true : (stryCov_9fa48("601", "602", "603"), r.category || (stryMutAct_9fa48("604") ? "Stryker was here!" : (stryCov_9fa48("604"), ''))),
                            card_id: r.id,
                            days_since_update: daysOld,
                            message: stryMutAct_9fa48("605") ? `` : (stryCov_9fa48("605"), `⏳ Related knowledge "${r.title}" hasn't been updated in ${daysOld} days — may be outdated`)
                          }));
                          break; // Only 1 staleness signal
                        }
                      }
                    }
                  }
                }
              } catch {/* FTS query may fail on special chars */}
            }
          }

          // 4. Contradiction: proactive detection via FTS + superseded cards
          // 4a. Surface recently superseded cards (7-day window)
          try {
            if (stryMutAct_9fa48("606")) {
              {}
            } else {
              stryCov_9fa48("606");
              const sevenDaysAgo = new Date(stryMutAct_9fa48("607") ? Date.now() + 7 * 86400000 : (stryCov_9fa48("607"), Date.now() - (stryMutAct_9fa48("608") ? 7 / 86400000 : (stryCov_9fa48("608"), 7 * 86400000)))).toISOString();
              const superseded = this.indexer.db.prepare(stryMutAct_9fa48("609") ? `` : (stryCov_9fa48("609"), `SELECT id, title, category, summary FROM knowledge_cards
             WHERE status = 'superseded' AND updated_at > ?
             ORDER BY updated_at DESC LIMIT 2`)).all(sevenDaysAgo);
              for (const r of superseded) {
                if (stryMutAct_9fa48("610")) {
                  {}
                } else {
                  stryCov_9fa48("610");
                  signals.push(stryMutAct_9fa48("611") ? {} : (stryCov_9fa48("611"), {
                    type: stryMutAct_9fa48("612") ? "" : (stryCov_9fa48("612"), 'contradiction'),
                    title: r.title,
                    summary: stryMutAct_9fa48("615") ? r.summary && '' : stryMutAct_9fa48("614") ? false : stryMutAct_9fa48("613") ? true : (stryCov_9fa48("613", "614", "615"), r.summary || (stryMutAct_9fa48("616") ? "Stryker was here!" : (stryCov_9fa48("616"), ''))),
                    card_id: r.id,
                    message: stryMutAct_9fa48("617") ? `` : (stryCov_9fa48("617"), `⚡ Recently superseded belief: "${r.title}" — verify current approach`)
                  }));
                }
              }
            }
          } catch {/* ignore */}

          // 4b. Proactive: if new card is decision/problem_solution, check for conflicting active cards
          if (stryMutAct_9fa48("620") ? insights?.knowledge_cards?.length || title : stryMutAct_9fa48("619") ? false : stryMutAct_9fa48("618") ? true : (stryCov_9fa48("618", "619", "620"), (stryMutAct_9fa48("622") ? insights.knowledge_cards?.length : stryMutAct_9fa48("621") ? insights?.knowledge_cards.length : (stryCov_9fa48("621", "622"), insights?.knowledge_cards?.length)) && title)) {
            if (stryMutAct_9fa48("623")) {
              {}
            } else {
              stryCov_9fa48("623");
              try {
                if (stryMutAct_9fa48("624")) {
                  {}
                } else {
                  stryCov_9fa48("624");
                  const newCard = insights.knowledge_cards[0];
                  const cat = stryMutAct_9fa48("625") ? newCard.category : (stryCov_9fa48("625"), newCard?.category);
                  if (stryMutAct_9fa48("628") ? cat === 'decision' && cat === 'problem_solution' : stryMutAct_9fa48("627") ? false : stryMutAct_9fa48("626") ? true : (stryCov_9fa48("626", "627", "628"), (stryMutAct_9fa48("630") ? cat !== 'decision' : stryMutAct_9fa48("629") ? false : (stryCov_9fa48("629", "630"), cat === (stryMutAct_9fa48("631") ? "" : (stryCov_9fa48("631"), 'decision')))) || (stryMutAct_9fa48("633") ? cat !== 'problem_solution' : stryMutAct_9fa48("632") ? false : (stryCov_9fa48("632", "633"), cat === (stryMutAct_9fa48("634") ? "" : (stryCov_9fa48("634"), 'problem_solution')))))) {
                    if (stryMutAct_9fa48("635")) {
                      {}
                    } else {
                      stryCov_9fa48("635");
                      const similar = this.indexer.searchKnowledge(title, stryMutAct_9fa48("636") ? {} : (stryCov_9fa48("636"), {
                        limit: 3
                      }));
                      for (const existing of similar) {
                        if (stryMutAct_9fa48("637")) {
                          {}
                        } else {
                          stryCov_9fa48("637");
                          if (stryMutAct_9fa48("640") ? existing.category !== cat && !existing.summary : stryMutAct_9fa48("639") ? false : stryMutAct_9fa48("638") ? true : (stryCov_9fa48("638", "639", "640"), (stryMutAct_9fa48("642") ? existing.category === cat : stryMutAct_9fa48("641") ? false : (stryCov_9fa48("641", "642"), existing.category !== cat)) || (stryMutAct_9fa48("643") ? existing.summary : (stryCov_9fa48("643"), !existing.summary)))) continue;
                          // Simple heuristic: if same category and same topic but different summary content
                          // (Jaccard similarity of words < 0.3), flag as potential contradiction
                          const newWords = new Set(stryMutAct_9fa48("644") ? (newCard.summary || '').toUpperCase().split(/\s+/) : (stryCov_9fa48("644"), (stryMutAct_9fa48("647") ? newCard.summary && '' : stryMutAct_9fa48("646") ? false : stryMutAct_9fa48("645") ? true : (stryCov_9fa48("645", "646", "647"), newCard.summary || (stryMutAct_9fa48("648") ? "Stryker was here!" : (stryCov_9fa48("648"), '')))).toLowerCase().split(stryMutAct_9fa48("650") ? /\S+/ : stryMutAct_9fa48("649") ? /\s/ : (stryCov_9fa48("649", "650"), /\s+/))));
                          const oldWords = new Set(stryMutAct_9fa48("651") ? existing.summary.toUpperCase().split(/\s+/) : (stryCov_9fa48("651"), existing.summary.toLowerCase().split(stryMutAct_9fa48("653") ? /\S+/ : stryMutAct_9fa48("652") ? /\s/ : (stryCov_9fa48("652", "653"), /\s+/))));
                          const intersection = stryMutAct_9fa48("654") ? [...newWords].length : (stryCov_9fa48("654"), (stryMutAct_9fa48("655") ? [] : (stryCov_9fa48("655"), [...newWords])).filter(stryMutAct_9fa48("656") ? () => undefined : (stryCov_9fa48("656"), w => oldWords.has(w))).length);
                          const union = new Set(stryMutAct_9fa48("657") ? [] : (stryCov_9fa48("657"), [...newWords, ...oldWords])).size;
                          const jaccard = (stryMutAct_9fa48("661") ? union <= 0 : stryMutAct_9fa48("660") ? union >= 0 : stryMutAct_9fa48("659") ? false : stryMutAct_9fa48("658") ? true : (stryCov_9fa48("658", "659", "660", "661"), union > 0)) ? stryMutAct_9fa48("662") ? intersection * union : (stryCov_9fa48("662"), intersection / union) : 1;
                          if (stryMutAct_9fa48("665") ? jaccard < 0.3 || existing.id !== newCard.id : stryMutAct_9fa48("664") ? false : stryMutAct_9fa48("663") ? true : (stryCov_9fa48("663", "664", "665"), (stryMutAct_9fa48("668") ? jaccard >= 0.3 : stryMutAct_9fa48("667") ? jaccard <= 0.3 : stryMutAct_9fa48("666") ? true : (stryCov_9fa48("666", "667", "668"), jaccard < 0.3)) && (stryMutAct_9fa48("670") ? existing.id === newCard.id : stryMutAct_9fa48("669") ? true : (stryCov_9fa48("669", "670"), existing.id !== newCard.id)))) {
                            if (stryMutAct_9fa48("671")) {
                              {}
                            } else {
                              stryCov_9fa48("671");
                              signals.push(stryMutAct_9fa48("672") ? {} : (stryCov_9fa48("672"), {
                                type: stryMutAct_9fa48("673") ? "" : (stryCov_9fa48("673"), 'contradiction'),
                                title: existing.title,
                                summary: existing.summary,
                                card_id: existing.id,
                                similarity: jaccard,
                                message: stryMutAct_9fa48("674") ? `` : (stryCov_9fa48("674"), `⚡ New ${cat} may conflict with existing: "${existing.title}" — verify if the old approach is still valid`)
                              }));
                              break;
                            }
                          }
                        }
                      }
                    }
                  }
                }
              } catch {/* ignore */}
            }
          }

          // 5. Related_decision: find prior decisions with overlapping tags
          if (stryMutAct_9fa48("678") ? insights.knowledge_cards?.length : stryMutAct_9fa48("677") ? insights?.knowledge_cards.length : stryMutAct_9fa48("676") ? false : stryMutAct_9fa48("675") ? true : (stryCov_9fa48("675", "676", "677", "678"), insights?.knowledge_cards?.length)) {
            if (stryMutAct_9fa48("679")) {
              {}
            } else {
              stryCov_9fa48("679");
              try {
                if (stryMutAct_9fa48("680")) {
                  {}
                } else {
                  stryCov_9fa48("680");
                  const newTags = new Set();
                  for (const card of insights.knowledge_cards) {
                    if (stryMutAct_9fa48("681")) {
                      {}
                    } else {
                      stryCov_9fa48("681");
                      const tags = stryMutAct_9fa48("684") ? card.tags && [] : stryMutAct_9fa48("683") ? false : stryMutAct_9fa48("682") ? true : (stryCov_9fa48("682", "683", "684"), card.tags || (stryMutAct_9fa48("685") ? ["Stryker was here"] : (stryCov_9fa48("685"), [])));
                      for (const tag of Array.isArray(tags) ? tags : stryMutAct_9fa48("686") ? ["Stryker was here"] : (stryCov_9fa48("686"), [])) {
                        if (stryMutAct_9fa48("687")) {
                          {}
                        } else {
                          stryCov_9fa48("687");
                          if (stryMutAct_9fa48("690") ? typeof tag === 'string' || tag.length >= 2 : stryMutAct_9fa48("689") ? false : stryMutAct_9fa48("688") ? true : (stryCov_9fa48("688", "689", "690"), (stryMutAct_9fa48("692") ? typeof tag !== 'string' : stryMutAct_9fa48("691") ? true : (stryCov_9fa48("691", "692"), typeof tag === (stryMutAct_9fa48("693") ? "" : (stryCov_9fa48("693"), 'string')))) && (stryMutAct_9fa48("696") ? tag.length < 2 : stryMutAct_9fa48("695") ? tag.length > 2 : stryMutAct_9fa48("694") ? true : (stryCov_9fa48("694", "695", "696"), tag.length >= 2)))) {
                            if (stryMutAct_9fa48("697")) {
                              {}
                            } else {
                              stryCov_9fa48("697");
                              newTags.add(stryMutAct_9fa48("698") ? tag.toUpperCase() : (stryCov_9fa48("698"), tag.toLowerCase()));
                            }
                          }
                        }
                      }
                    }
                  }
                  if (stryMutAct_9fa48("702") ? newTags.size <= 0 : stryMutAct_9fa48("701") ? newTags.size >= 0 : stryMutAct_9fa48("700") ? false : stryMutAct_9fa48("699") ? true : (stryCov_9fa48("699", "700", "701", "702"), newTags.size > 0)) {
                    if (stryMutAct_9fa48("703")) {
                      {}
                    } else {
                      stryCov_9fa48("703");
                      const decisions = this.indexer.db.prepare(stryMutAct_9fa48("704") ? `` : (stryCov_9fa48("704"), `SELECT id, title, summary, tags FROM knowledge_cards
                 WHERE category = 'decision' AND status = 'active'
                 ORDER BY created_at DESC LIMIT 20`)).all();
                      for (const d of decisions) {
                        if (stryMutAct_9fa48("705")) {
                          {}
                        } else {
                          stryCov_9fa48("705");
                          let cardTags = stryMutAct_9fa48("706") ? ["Stryker was here"] : (stryCov_9fa48("706"), []);
                          try {
                            if (stryMutAct_9fa48("707")) {
                              {}
                            } else {
                              stryCov_9fa48("707");
                              cardTags = JSON.parse(stryMutAct_9fa48("710") ? d.tags && '[]' : stryMutAct_9fa48("709") ? false : stryMutAct_9fa48("708") ? true : (stryCov_9fa48("708", "709", "710"), d.tags || (stryMutAct_9fa48("711") ? "" : (stryCov_9fa48("711"), '[]'))));
                            }
                          } catch {/* skip */}
                          const overlap = stryMutAct_9fa48("712") ? cardTags.every(t => typeof t === 'string' && newTags.has(t.toLowerCase())) : (stryCov_9fa48("712"), cardTags.some(stryMutAct_9fa48("713") ? () => undefined : (stryCov_9fa48("713"), t => stryMutAct_9fa48("716") ? typeof t === 'string' || newTags.has(t.toLowerCase()) : stryMutAct_9fa48("715") ? false : stryMutAct_9fa48("714") ? true : (stryCov_9fa48("714", "715", "716"), (stryMutAct_9fa48("718") ? typeof t !== 'string' : stryMutAct_9fa48("717") ? true : (stryCov_9fa48("717", "718"), typeof t === (stryMutAct_9fa48("719") ? "" : (stryCov_9fa48("719"), 'string')))) && newTags.has(stryMutAct_9fa48("720") ? t.toUpperCase() : (stryCov_9fa48("720"), t.toLowerCase()))))));
                          if (stryMutAct_9fa48("722") ? false : stryMutAct_9fa48("721") ? true : (stryCov_9fa48("721", "722"), overlap)) {
                            if (stryMutAct_9fa48("723")) {
                              {}
                            } else {
                              stryCov_9fa48("723");
                              signals.push(stryMutAct_9fa48("724") ? {} : (stryCov_9fa48("724"), {
                                type: stryMutAct_9fa48("725") ? "" : (stryCov_9fa48("725"), 'related_decision'),
                                title: d.title,
                                summary: stryMutAct_9fa48("728") ? d.summary && '' : stryMutAct_9fa48("727") ? false : stryMutAct_9fa48("726") ? true : (stryCov_9fa48("726", "727", "728"), d.summary || (stryMutAct_9fa48("729") ? "Stryker was here!" : (stryCov_9fa48("729"), ''))),
                                card_id: d.id,
                                message: stryMutAct_9fa48("730") ? `` : (stryCov_9fa48("730"), `📌 Related prior decision: "${d.title}"`)
                              }));
                              if (stryMutAct_9fa48("734") ? signals.filter(s => s.type === 'related_decision').length < 2 : stryMutAct_9fa48("733") ? signals.filter(s => s.type === 'related_decision').length > 2 : stryMutAct_9fa48("732") ? false : stryMutAct_9fa48("731") ? true : (stryCov_9fa48("731", "732", "733", "734"), (stryMutAct_9fa48("735") ? signals.length : (stryCov_9fa48("735"), signals.filter(stryMutAct_9fa48("736") ? () => undefined : (stryCov_9fa48("736"), s => stryMutAct_9fa48("739") ? s.type !== 'related_decision' : stryMutAct_9fa48("738") ? false : stryMutAct_9fa48("737") ? true : (stryCov_9fa48("737", "738", "739"), s.type === (stryMutAct_9fa48("740") ? "" : (stryCov_9fa48("740"), 'related_decision'))))).length)) >= 2)) break;
                            }
                          }
                        }
                      }
                    }
                  }
                }
              } catch {/* ignore */}
            }
          }
        }
      } catch (err) {
        if (stryMutAct_9fa48("741")) {
          {}
        } else {
          stryCov_9fa48("741");
          // Perception is best-effort, never block the write
          if (stryMutAct_9fa48("743") ? false : stryMutAct_9fa48("742") ? true : (stryCov_9fa48("742", "743"), process.env.DEBUG)) {
            if (stryMutAct_9fa48("744")) {
              {}
            } else {
              stryCov_9fa48("744");
              console.warn(stryMutAct_9fa48("745") ? "" : (stryCov_9fa48("745"), '[awareness-local] perception failed:'), err.message);
            }
          }
        }
      }

      // Apply perception lifecycle: compute signal_id, filter dormant/dismissed/snoozed, update state
      const filteredSignals = stryMutAct_9fa48("746") ? ["Stryker was here"] : (stryCov_9fa48("746"), []);
      for (const sig of signals) {
        if (stryMutAct_9fa48("747")) {
          {}
        } else {
          stryCov_9fa48("747");
          try {
            if (stryMutAct_9fa48("748")) {
              {}
            } else {
              stryCov_9fa48("748");
              const signalId = this._computeSignalId(sig);
              sig.signal_id = signalId;
              if (stryMutAct_9fa48("751") ? false : stryMutAct_9fa48("750") ? true : stryMutAct_9fa48("749") ? this.indexer?.shouldShowPerception : (stryCov_9fa48("749", "750", "751"), !(stryMutAct_9fa48("752") ? this.indexer.shouldShowPerception : (stryCov_9fa48("752"), this.indexer?.shouldShowPerception)))) {
                if (stryMutAct_9fa48("753")) {
                  {}
                } else {
                  stryCov_9fa48("753");
                  filteredSignals.push(sig);
                  continue;
                }
              }
              if (stryMutAct_9fa48("756") ? false : stryMutAct_9fa48("755") ? true : stryMutAct_9fa48("754") ? this.indexer.shouldShowPerception(signalId) : (stryCov_9fa48("754", "755", "756"), !this.indexer.shouldShowPerception(signalId))) continue;
              // Touch state (increment exposure_count, apply decay)
              this.indexer.touchPerceptionState(stryMutAct_9fa48("757") ? {} : (stryCov_9fa48("757"), {
                signal_id: signalId,
                signal_type: sig.type,
                source_card_id: stryMutAct_9fa48("760") ? sig.card_id && null : stryMutAct_9fa48("759") ? false : stryMutAct_9fa48("758") ? true : (stryCov_9fa48("758", "759", "760"), sig.card_id || null),
                title: stryMutAct_9fa48("763") ? (sig.title || sig.message) && '' : stryMutAct_9fa48("762") ? false : stryMutAct_9fa48("761") ? true : (stryCov_9fa48("761", "762", "763"), (stryMutAct_9fa48("765") ? sig.title && sig.message : stryMutAct_9fa48("764") ? false : (stryCov_9fa48("764", "765"), sig.title || sig.message)) || (stryMutAct_9fa48("766") ? "Stryker was here!" : (stryCov_9fa48("766"), ''))),
                metadata: stryMutAct_9fa48("767") ? {} : (stryCov_9fa48("767"), {
                  tag: sig.tag,
                  count: sig.count,
                  category: sig.category
                })
              }));
              filteredSignals.push(sig);
            }
          } catch {/* non-fatal */}
        }
      }
      return stryMutAct_9fa48("768") ? filteredSignals : (stryCov_9fa48("768"), filteredSignals.slice(0, 5)); // Cap at 5 signals
    }
  }

  /**
   * Compute a stable signal_id based on type + source identifier.
   * Same signal produced in two different sessions must yield the same ID.
   */
  _computeSignalId(sig) {
    if (stryMutAct_9fa48("769")) {
      {}
    } else {
      stryCov_9fa48("769");
      const parts = stryMutAct_9fa48("770") ? [] : (stryCov_9fa48("770"), [sig.type]);
      if (stryMutAct_9fa48("772") ? false : stryMutAct_9fa48("771") ? true : (stryCov_9fa48("771", "772"), sig.card_id)) parts.push(sig.card_id);else if (stryMutAct_9fa48("774") ? false : stryMutAct_9fa48("773") ? true : (stryCov_9fa48("773", "774"), sig.tag)) parts.push(stryMutAct_9fa48("775") ? `` : (stryCov_9fa48("775"), `tag:${sig.tag}`));else if (stryMutAct_9fa48("777") ? false : stryMutAct_9fa48("776") ? true : (stryCov_9fa48("776", "777"), sig.title)) parts.push(stryMutAct_9fa48("778") ? `` : (stryCov_9fa48("778"), `title:${stryMutAct_9fa48("779") ? sig.title : (stryCov_9fa48("779"), sig.title.slice(0, 60))}`));else parts.push(stryMutAct_9fa48("782") ? sig.message?.slice(0, 60) && '' : stryMutAct_9fa48("781") ? false : stryMutAct_9fa48("780") ? true : (stryCov_9fa48("780", "781", "782"), (stryMutAct_9fa48("784") ? sig.message.slice(0, 60) : stryMutAct_9fa48("783") ? sig.message : (stryCov_9fa48("783", "784"), sig.message?.slice(0, 60))) || (stryMutAct_9fa48("785") ? "Stryker was here!" : (stryCov_9fa48("785"), ''))));
      // Simple hash (deterministic)
      const key = parts.join(stryMutAct_9fa48("786") ? "" : (stryCov_9fa48("786"), '|'));
      let hash = 0;
      for (let i = 0; stryMutAct_9fa48("789") ? i >= key.length : stryMutAct_9fa48("788") ? i <= key.length : stryMutAct_9fa48("787") ? false : (stryCov_9fa48("787", "788", "789"), i < key.length); stryMutAct_9fa48("790") ? i-- : (stryCov_9fa48("790"), i++)) {
        if (stryMutAct_9fa48("791")) {
          {}
        } else {
          stryCov_9fa48("791");
          hash = (stryMutAct_9fa48("792") ? (hash << 5) - hash - key.charCodeAt(i) : (stryCov_9fa48("792"), (stryMutAct_9fa48("793") ? (hash << 5) + hash : (stryCov_9fa48("793"), (hash << 5) - hash)) + key.charCodeAt(i))) | 0;
        }
      }
      return stryMutAct_9fa48("794") ? `` : (stryCov_9fa48("794"), `sig_${sig.type}_${Math.abs(hash).toString(36)}`);
    }
  }

  /** Return ordinal string (1st, 2nd, 3rd, etc.) */
  _ordinal(n) {
    if (stryMutAct_9fa48("795")) {
      {}
    } else {
      stryCov_9fa48("795");
      if (stryMutAct_9fa48("798") ? n % 100 >= 11 || n % 100 <= 13 : stryMutAct_9fa48("797") ? false : stryMutAct_9fa48("796") ? true : (stryCov_9fa48("796", "797", "798"), (stryMutAct_9fa48("801") ? n % 100 < 11 : stryMutAct_9fa48("800") ? n % 100 > 11 : stryMutAct_9fa48("799") ? true : (stryCov_9fa48("799", "800", "801"), (stryMutAct_9fa48("802") ? n * 100 : (stryCov_9fa48("802"), n % 100)) >= 11)) && (stryMutAct_9fa48("805") ? n % 100 > 13 : stryMutAct_9fa48("804") ? n % 100 < 13 : stryMutAct_9fa48("803") ? true : (stryCov_9fa48("803", "804", "805"), (stryMutAct_9fa48("806") ? n * 100 : (stryCov_9fa48("806"), n % 100)) <= 13)))) return stryMutAct_9fa48("807") ? `` : (stryCov_9fa48("807"), `${n}th`);
      const suffix = stryMutAct_9fa48("810") ? {
        1: 'st',
        2: 'nd',
        3: 'rd'
      }[n % 10] && 'th' : stryMutAct_9fa48("809") ? false : stryMutAct_9fa48("808") ? true : (stryCov_9fa48("808", "809", "810"), (stryMutAct_9fa48("811") ? {} : (stryCov_9fa48("811"), {
        1: stryMutAct_9fa48("812") ? "" : (stryCov_9fa48("812"), 'st'),
        2: stryMutAct_9fa48("813") ? "" : (stryCov_9fa48("813"), 'nd'),
        3: stryMutAct_9fa48("814") ? "" : (stryCov_9fa48("814"), 'rd')
      }))[stryMutAct_9fa48("815") ? n * 10 : (stryCov_9fa48("815"), n % 10)] || (stryMutAct_9fa48("816") ? "" : (stryCov_9fa48("816"), 'th')));
      return stryMutAct_9fa48("817") ? `` : (stryCov_9fa48("817"), `${n}${suffix}`);
    }
  }

  /** Write multiple memories in batch. */
  async _rememberBatch(params) {
    if (stryMutAct_9fa48("818")) {
      {}
    } else {
      stryCov_9fa48("818");
      const items = stryMutAct_9fa48("821") ? params.items && [] : stryMutAct_9fa48("820") ? false : stryMutAct_9fa48("819") ? true : (stryCov_9fa48("819", "820", "821"), params.items || (stryMutAct_9fa48("822") ? ["Stryker was here"] : (stryCov_9fa48("822"), [])));
      if (stryMutAct_9fa48("825") ? false : stryMutAct_9fa48("824") ? true : stryMutAct_9fa48("823") ? items.length : (stryCov_9fa48("823", "824", "825"), !items.length)) {
        if (stryMutAct_9fa48("826")) {
          {}
        } else {
          stryCov_9fa48("826");
          return stryMutAct_9fa48("827") ? {} : (stryCov_9fa48("827"), {
            error: stryMutAct_9fa48("828") ? "" : (stryCov_9fa48("828"), 'items array is required for remember_batch')
          });
        }
      }

      // Batch-level insights go to the last item (summary item)
      const batchInsights = stryMutAct_9fa48("831") ? params.insights && null : stryMutAct_9fa48("830") ? false : stryMutAct_9fa48("829") ? true : (stryCov_9fa48("829", "830", "831"), params.insights || null);
      const results = stryMutAct_9fa48("832") ? ["Stryker was here"] : (stryCov_9fa48("832"), []);
      for (let i = 0; stryMutAct_9fa48("835") ? i >= items.length : stryMutAct_9fa48("834") ? i <= items.length : stryMutAct_9fa48("833") ? false : (stryCov_9fa48("833", "834", "835"), i < items.length); stryMutAct_9fa48("836") ? i-- : (stryCov_9fa48("836"), i++)) {
        if (stryMutAct_9fa48("837")) {
          {}
        } else {
          stryCov_9fa48("837");
          const item = items[i];
          const isLast = stryMutAct_9fa48("840") ? i !== items.length - 1 : stryMutAct_9fa48("839") ? false : stryMutAct_9fa48("838") ? true : (stryCov_9fa48("838", "839", "840"), i === (stryMutAct_9fa48("841") ? items.length + 1 : (stryCov_9fa48("841"), items.length - 1)));
          const result = await this._remember(stryMutAct_9fa48("842") ? {} : (stryCov_9fa48("842"), {
            content: item.content,
            title: item.title,
            event_type: item.event_type,
            tags: item.tags,
            insights: stryMutAct_9fa48("845") ? item.insights && (isLast ? batchInsights : null) : stryMutAct_9fa48("844") ? false : stryMutAct_9fa48("843") ? true : (stryCov_9fa48("843", "844", "845"), item.insights || (isLast ? batchInsights : null)),
            session_id: params.session_id,
            agent_role: params.agent_role
          }));
          results.push(result);
        }
      }
      return stryMutAct_9fa48("846") ? {} : (stryCov_9fa48("846"), {
        status: stryMutAct_9fa48("847") ? "" : (stryCov_9fa48("847"), 'ok'),
        count: results.length,
        items: results,
        mode: stryMutAct_9fa48("848") ? "" : (stryCov_9fa48("848"), 'local')
      });
    }
  }

  /** Update a task's status. */
  async _updateTask(params) {
    if (stryMutAct_9fa48("849")) {
      {}
    } else {
      stryCov_9fa48("849");
      if (stryMutAct_9fa48("852") ? false : stryMutAct_9fa48("851") ? true : stryMutAct_9fa48("850") ? params.task_id : (stryCov_9fa48("850", "851", "852"), !params.task_id)) {
        if (stryMutAct_9fa48("853")) {
          {}
        } else {
          stryCov_9fa48("853");
          return stryMutAct_9fa48("854") ? {} : (stryCov_9fa48("854"), {
            error: stryMutAct_9fa48("855") ? "" : (stryCov_9fa48("855"), 'task_id is required for update_task')
          });
        }
      }
      const task = this.indexer.db.prepare(stryMutAct_9fa48("856") ? "" : (stryCov_9fa48("856"), 'SELECT * FROM tasks WHERE id = ?')).get(params.task_id);
      if (stryMutAct_9fa48("859") ? false : stryMutAct_9fa48("858") ? true : stryMutAct_9fa48("857") ? task : (stryCov_9fa48("857", "858", "859"), !task)) {
        if (stryMutAct_9fa48("860")) {
          {}
        } else {
          stryCov_9fa48("860");
          return stryMutAct_9fa48("861") ? {} : (stryCov_9fa48("861"), {
            error: stryMutAct_9fa48("862") ? `` : (stryCov_9fa48("862"), `Task not found: ${params.task_id}`)
          });
        }
      }
      this.indexer.indexTask(stryMutAct_9fa48("863") ? {} : (stryCov_9fa48("863"), {
        ...task,
        status: stryMutAct_9fa48("866") ? params.status && task.status : stryMutAct_9fa48("865") ? false : stryMutAct_9fa48("864") ? true : (stryCov_9fa48("864", "865", "866"), params.status || task.status),
        updated_at: nowISO()
      }));
      return stryMutAct_9fa48("867") ? {} : (stryCov_9fa48("867"), {
        status: stryMutAct_9fa48("868") ? "" : (stryCov_9fa48("868"), 'ok'),
        task_id: params.task_id,
        new_status: stryMutAct_9fa48("871") ? params.status && task.status : stryMutAct_9fa48("870") ? false : stryMutAct_9fa48("869") ? true : (stryCov_9fa48("869", "870", "871"), params.status || task.status),
        mode: stryMutAct_9fa48("872") ? "" : (stryCov_9fa48("872"), 'local')
      });
    }
  }

  /** Process pre-extracted insights and index them. */
  async _submitInsights(params) {
    if (stryMutAct_9fa48("873")) {
      {}
    } else {
      stryCov_9fa48("873");
      const insights = stryMutAct_9fa48("876") ? params.insights && {} : stryMutAct_9fa48("875") ? false : stryMutAct_9fa48("874") ? true : (stryCov_9fa48("874", "875", "876"), params.insights || {});
      let cardsCreated = 0;
      let tasksCreated = 0;

      // F-034: Track newly created eligible cards for crystallization detection
      const CRYSTALLIZATION_CATEGORIES = new Set(stryMutAct_9fa48("877") ? [] : (stryCov_9fa48("877"), [stryMutAct_9fa48("878") ? "" : (stryCov_9fa48("878"), 'workflow'), stryMutAct_9fa48("879") ? "" : (stryCov_9fa48("879"), 'decision'), stryMutAct_9fa48("880") ? "" : (stryCov_9fa48("880"), 'problem_solution')]));
      const crystallizationCandidates = stryMutAct_9fa48("881") ? ["Stryker was here"] : (stryCov_9fa48("881"), []);

      // Process knowledge cards
      if (stryMutAct_9fa48("883") ? false : stryMutAct_9fa48("882") ? true : (stryCov_9fa48("882", "883"), Array.isArray(insights.knowledge_cards))) {
        if (stryMutAct_9fa48("884")) {
          {}
        } else {
          stryCov_9fa48("884");
          for (const card of insights.knowledge_cards) {
            if (stryMutAct_9fa48("885")) {
              {}
            } else {
              stryCov_9fa48("885");
              const cardId = stryMutAct_9fa48("886") ? `` : (stryCov_9fa48("886"), `kc_${Date.now()}_${stryMutAct_9fa48("887") ? Math.random().toString(36) : (stryCov_9fa48("887"), Math.random().toString(36).slice(2, 6))}`);
              const cardFilepath = path.join(this.awarenessDir, stryMutAct_9fa48("888") ? "" : (stryCov_9fa48("888"), 'knowledge'), stryMutAct_9fa48("891") ? card.category && 'insights' : stryMutAct_9fa48("890") ? false : stryMutAct_9fa48("889") ? true : (stryCov_9fa48("889", "890", "891"), card.category || (stryMutAct_9fa48("892") ? "" : (stryCov_9fa48("892"), 'insights'))), stryMutAct_9fa48("893") ? `` : (stryCov_9fa48("893"), `${cardId}.md`));

              // Ensure category directory exists
              fs.mkdirSync(path.dirname(cardFilepath), stryMutAct_9fa48("894") ? {} : (stryCov_9fa48("894"), {
                recursive: stryMutAct_9fa48("895") ? false : (stryCov_9fa48("895"), true)
              }));

              // Write markdown file for the card
              const cardContent = stryMutAct_9fa48("896") ? `` : (stryCov_9fa48("896"), `---
id: ${cardId}
category: ${stryMutAct_9fa48("899") ? card.category && 'insight' : stryMutAct_9fa48("898") ? false : stryMutAct_9fa48("897") ? true : (stryCov_9fa48("897", "898", "899"), card.category || (stryMutAct_9fa48("900") ? "" : (stryCov_9fa48("900"), 'insight')))}
title: "${(stryMutAct_9fa48("903") ? card.title && '' : stryMutAct_9fa48("902") ? false : stryMutAct_9fa48("901") ? true : (stryCov_9fa48("901", "902", "903"), card.title || (stryMutAct_9fa48("904") ? "Stryker was here!" : (stryCov_9fa48("904"), '')))).replace(/"/g, stryMutAct_9fa48("905") ? "" : (stryCov_9fa48("905"), '\\"'))}"
confidence: ${stryMutAct_9fa48("906") ? card.confidence && 0.8 : (stryCov_9fa48("906"), card.confidence ?? 0.8)}
status: ${stryMutAct_9fa48("909") ? card.status && 'active' : stryMutAct_9fa48("908") ? false : stryMutAct_9fa48("907") ? true : (stryCov_9fa48("907", "908", "909"), card.status || (stryMutAct_9fa48("910") ? "" : (stryCov_9fa48("910"), 'active')))}
tags: ${JSON.stringify(stryMutAct_9fa48("913") ? card.tags && [] : stryMutAct_9fa48("912") ? false : stryMutAct_9fa48("911") ? true : (stryCov_9fa48("911", "912", "913"), card.tags || (stryMutAct_9fa48("914") ? ["Stryker was here"] : (stryCov_9fa48("914"), []))))}
created_at: ${nowISO()}
---

${stryMutAct_9fa48("917") ? (card.summary || card.title) && '' : stryMutAct_9fa48("916") ? false : stryMutAct_9fa48("915") ? true : (stryCov_9fa48("915", "916", "917"), (stryMutAct_9fa48("919") ? card.summary && card.title : stryMutAct_9fa48("918") ? false : (stryCov_9fa48("918", "919"), card.summary || card.title)) || (stryMutAct_9fa48("920") ? "Stryker was here!" : (stryCov_9fa48("920"), '')))}
`);
              fs.mkdirSync(path.dirname(cardFilepath), stryMutAct_9fa48("921") ? {} : (stryCov_9fa48("921"), {
                recursive: stryMutAct_9fa48("922") ? false : (stryCov_9fa48("922"), true)
              }));
              fs.writeFileSync(cardFilepath, cardContent, stryMutAct_9fa48("923") ? "" : (stryCov_9fa48("923"), 'utf-8'));
              const cardData = stryMutAct_9fa48("924") ? {} : (stryCov_9fa48("924"), {
                id: cardId,
                category: stryMutAct_9fa48("927") ? card.category && 'insight' : stryMutAct_9fa48("926") ? false : stryMutAct_9fa48("925") ? true : (stryCov_9fa48("925", "926", "927"), card.category || (stryMutAct_9fa48("928") ? "" : (stryCov_9fa48("928"), 'insight'))),
                title: stryMutAct_9fa48("931") ? card.title && '' : stryMutAct_9fa48("930") ? false : stryMutAct_9fa48("929") ? true : (stryCov_9fa48("929", "930", "931"), card.title || (stryMutAct_9fa48("932") ? "Stryker was here!" : (stryCov_9fa48("932"), ''))),
                summary: stryMutAct_9fa48("935") ? card.summary && '' : stryMutAct_9fa48("934") ? false : stryMutAct_9fa48("933") ? true : (stryCov_9fa48("933", "934", "935"), card.summary || (stryMutAct_9fa48("936") ? "Stryker was here!" : (stryCov_9fa48("936"), ''))),
                source_memories: JSON.stringify(stryMutAct_9fa48("937") ? ["Stryker was here"] : (stryCov_9fa48("937"), [])),
                confidence: stryMutAct_9fa48("938") ? card.confidence && 0.8 : (stryCov_9fa48("938"), card.confidence ?? 0.8),
                status: stryMutAct_9fa48("941") ? card.status && 'active' : stryMutAct_9fa48("940") ? false : stryMutAct_9fa48("939") ? true : (stryCov_9fa48("939", "940", "941"), card.status || (stryMutAct_9fa48("942") ? "" : (stryCov_9fa48("942"), 'active'))),
                tags: stryMutAct_9fa48("945") ? card.tags && [] : stryMutAct_9fa48("944") ? false : stryMutAct_9fa48("943") ? true : (stryCov_9fa48("943", "944", "945"), card.tags || (stryMutAct_9fa48("946") ? ["Stryker was here"] : (stryCov_9fa48("946"), []))),
                created_at: nowISO(),
                filepath: cardFilepath,
                content: stryMutAct_9fa48("949") ? (card.summary || card.title) && '' : stryMutAct_9fa48("948") ? false : stryMutAct_9fa48("947") ? true : (stryCov_9fa48("947", "948", "949"), (stryMutAct_9fa48("951") ? card.summary && card.title : stryMutAct_9fa48("950") ? false : (stryCov_9fa48("950", "951"), card.summary || card.title)) || (stryMutAct_9fa48("952") ? "Stryker was here!" : (stryCov_9fa48("952"), ''))),
                novelty_score: stryMutAct_9fa48("953") ? card.novelty_score && null : (stryCov_9fa48("953"), card.novelty_score ?? null),
                salience_reason: stryMutAct_9fa48("956") ? card.salience_reason && null : stryMutAct_9fa48("955") ? false : stryMutAct_9fa48("954") ? true : (stryCov_9fa48("954", "955", "956"), card.salience_reason || null)
              });
              this.indexer.indexKnowledgeCard(cardData);

              // Incremental MOC: check if this card's tags trigger MOC creation
              try {
                if (stryMutAct_9fa48("957")) {
                  {}
                } else {
                  stryCov_9fa48("957");
                  const newMocIds = this.indexer.tryAutoMoc(cardData);
                  // Fire-and-forget: refine MOC titles with LLM if available
                  if (stryMutAct_9fa48("961") ? newMocIds.length <= 0 : stryMutAct_9fa48("960") ? newMocIds.length >= 0 : stryMutAct_9fa48("959") ? false : stryMutAct_9fa48("958") ? true : (stryCov_9fa48("958", "959", "960", "961"), newMocIds.length > 0)) {
                    if (stryMutAct_9fa48("962")) {
                      {}
                    } else {
                      stryCov_9fa48("962");
                      this._refineMocTitles(newMocIds).catch(() => {});
                    }
                  }
                }
              } catch (e) {
                if (stryMutAct_9fa48("963")) {
                  {}
                } else {
                  stryCov_9fa48("963");
                  console.warn(stryMutAct_9fa48("964") ? "" : (stryCov_9fa48("964"), '[awareness-local] autoMoc error:'), e.message);
                }
              }

              // Skill auto-evolution: check if new card should evolve existing skills
              try {
                if (stryMutAct_9fa48("965")) {
                  {}
                } else {
                  stryCov_9fa48("965");
                  if (stryMutAct_9fa48("967") ? false : stryMutAct_9fa48("966") ? true : (stryCov_9fa48("966", "967"), this.extractor)) {
                    if (stryMutAct_9fa48("968")) {
                      {}
                    } else {
                      stryCov_9fa48("968");
                      this.extractor._checkSkillEvolution(cardData).catch(err => {
                        if (stryMutAct_9fa48("969")) {
                          {}
                        } else {
                          stryCov_9fa48("969");
                          console.warn(stryMutAct_9fa48("970") ? "" : (stryCov_9fa48("970"), '[awareness-local] skill evolution check failed:'), err.message);
                        }
                      });
                    }
                  }
                }
              } catch {/* non-critical */}

              // F-034: Track eligible cards for crystallization hint check
              if (stryMutAct_9fa48("972") ? false : stryMutAct_9fa48("971") ? true : (stryCov_9fa48("971", "972"), CRYSTALLIZATION_CATEGORIES.has(card.category))) {
                if (stryMutAct_9fa48("973")) {
                  {}
                } else {
                  stryCov_9fa48("973");
                  crystallizationCandidates.push(stryMutAct_9fa48("974") ? {} : (stryCov_9fa48("974"), {
                    id: cardId,
                    title: stryMutAct_9fa48("977") ? card.title && '' : stryMutAct_9fa48("976") ? false : stryMutAct_9fa48("975") ? true : (stryCov_9fa48("975", "976", "977"), card.title || (stryMutAct_9fa48("978") ? "Stryker was here!" : (stryCov_9fa48("978"), ''))),
                    summary: stryMutAct_9fa48("981") ? card.summary && '' : stryMutAct_9fa48("980") ? false : stryMutAct_9fa48("979") ? true : (stryCov_9fa48("979", "980", "981"), card.summary || (stryMutAct_9fa48("982") ? "Stryker was here!" : (stryCov_9fa48("982"), ''))),
                    category: card.category
                  }));
                }
              }
              stryMutAct_9fa48("983") ? cardsCreated-- : (stryCov_9fa48("983"), cardsCreated++);
            }
          }
        }
      }

      // Process action items / tasks
      if (stryMutAct_9fa48("985") ? false : stryMutAct_9fa48("984") ? true : (stryCov_9fa48("984", "985"), Array.isArray(insights.action_items))) {
        if (stryMutAct_9fa48("986")) {
          {}
        } else {
          stryCov_9fa48("986");
          for (const item of insights.action_items) {
            if (stryMutAct_9fa48("987")) {
              {}
            } else {
              stryCov_9fa48("987");
              // Quality gate: reject noise tasks
              const rejection = validateTaskQuality(item.title);
              if (stryMutAct_9fa48("989") ? false : stryMutAct_9fa48("988") ? true : (stryCov_9fa48("988", "989"), rejection)) {
                if (stryMutAct_9fa48("990")) {
                  {}
                } else {
                  stryCov_9fa48("990");
                  console.warn(stryMutAct_9fa48("991") ? `` : (stryCov_9fa48("991"), `[AwarenessDaemon] Rejected noise task (${rejection}): ${stryMutAct_9fa48("992") ? item.title || '' : (stryCov_9fa48("992"), (stryMutAct_9fa48("995") ? item.title && '' : stryMutAct_9fa48("994") ? false : stryMutAct_9fa48("993") ? true : (stryCov_9fa48("993", "994", "995"), item.title || (stryMutAct_9fa48("996") ? "Stryker was here!" : (stryCov_9fa48("996"), '')))).substring(0, 60))}`));
                  continue;
                }
              }

              // Dedup gate: skip if similar open task already exists
              const {
                isDuplicate,
                existingTaskId
              } = checkTaskDedup(this.indexer, item.title);
              if (stryMutAct_9fa48("998") ? false : stryMutAct_9fa48("997") ? true : (stryCov_9fa48("997", "998"), isDuplicate)) {
                if (stryMutAct_9fa48("999")) {
                  {}
                } else {
                  stryCov_9fa48("999");
                  console.warn(stryMutAct_9fa48("1000") ? `` : (stryCov_9fa48("1000"), `[AwarenessDaemon] Skipped duplicate task: "${stryMutAct_9fa48("1001") ? item.title || '' : (stryCov_9fa48("1001"), (stryMutAct_9fa48("1004") ? item.title && '' : stryMutAct_9fa48("1003") ? false : stryMutAct_9fa48("1002") ? true : (stryCov_9fa48("1002", "1003", "1004"), item.title || (stryMutAct_9fa48("1005") ? "Stryker was here!" : (stryCov_9fa48("1005"), '')))).substring(0, 60))}" (existing: ${existingTaskId})`));
                  continue;
                }
              }
              const taskId = stryMutAct_9fa48("1006") ? `` : (stryCov_9fa48("1006"), `task_${Date.now()}_${stryMutAct_9fa48("1007") ? Math.random().toString(36) : (stryCov_9fa48("1007"), Math.random().toString(36).slice(2, 6))}`);
              const taskFilepath = path.join(this.awarenessDir, stryMutAct_9fa48("1008") ? "" : (stryCov_9fa48("1008"), 'tasks'), stryMutAct_9fa48("1009") ? "" : (stryCov_9fa48("1009"), 'open'), stryMutAct_9fa48("1010") ? `` : (stryCov_9fa48("1010"), `${taskId}.md`));
              const taskContent = stryMutAct_9fa48("1011") ? `` : (stryCov_9fa48("1011"), `---
id: ${taskId}
title: "${(stryMutAct_9fa48("1014") ? item.title && '' : stryMutAct_9fa48("1013") ? false : stryMutAct_9fa48("1012") ? true : (stryCov_9fa48("1012", "1013", "1014"), item.title || (stryMutAct_9fa48("1015") ? "Stryker was here!" : (stryCov_9fa48("1015"), '')))).replace(/"/g, stryMutAct_9fa48("1016") ? "" : (stryCov_9fa48("1016"), '\\"'))}"
priority: ${stryMutAct_9fa48("1019") ? item.priority && 'medium' : stryMutAct_9fa48("1018") ? false : stryMutAct_9fa48("1017") ? true : (stryCov_9fa48("1017", "1018", "1019"), item.priority || (stryMutAct_9fa48("1020") ? "" : (stryCov_9fa48("1020"), 'medium')))}
status: ${stryMutAct_9fa48("1023") ? item.status && 'open' : stryMutAct_9fa48("1022") ? false : stryMutAct_9fa48("1021") ? true : (stryCov_9fa48("1021", "1022", "1023"), item.status || (stryMutAct_9fa48("1024") ? "" : (stryCov_9fa48("1024"), 'open')))}
created_at: ${nowISO()}
---

${stryMutAct_9fa48("1027") ? (item.description || item.title) && '' : stryMutAct_9fa48("1026") ? false : stryMutAct_9fa48("1025") ? true : (stryCov_9fa48("1025", "1026", "1027"), (stryMutAct_9fa48("1029") ? item.description && item.title : stryMutAct_9fa48("1028") ? false : (stryCov_9fa48("1028", "1029"), item.description || item.title)) || (stryMutAct_9fa48("1030") ? "Stryker was here!" : (stryCov_9fa48("1030"), '')))}
`);
              fs.mkdirSync(path.dirname(taskFilepath), stryMutAct_9fa48("1031") ? {} : (stryCov_9fa48("1031"), {
                recursive: stryMutAct_9fa48("1032") ? false : (stryCov_9fa48("1032"), true)
              }));
              fs.writeFileSync(taskFilepath, taskContent, stryMutAct_9fa48("1033") ? "" : (stryCov_9fa48("1033"), 'utf-8'));
              this.indexer.indexTask(stryMutAct_9fa48("1034") ? {} : (stryCov_9fa48("1034"), {
                id: taskId,
                title: stryMutAct_9fa48("1037") ? item.title && '' : stryMutAct_9fa48("1036") ? false : stryMutAct_9fa48("1035") ? true : (stryCov_9fa48("1035", "1036", "1037"), item.title || (stryMutAct_9fa48("1038") ? "Stryker was here!" : (stryCov_9fa48("1038"), ''))),
                description: stryMutAct_9fa48("1041") ? item.description && '' : stryMutAct_9fa48("1040") ? false : stryMutAct_9fa48("1039") ? true : (stryCov_9fa48("1039", "1040", "1041"), item.description || (stryMutAct_9fa48("1042") ? "Stryker was here!" : (stryCov_9fa48("1042"), ''))),
                status: stryMutAct_9fa48("1045") ? item.status && 'open' : stryMutAct_9fa48("1044") ? false : stryMutAct_9fa48("1043") ? true : (stryCov_9fa48("1043", "1044", "1045"), item.status || (stryMutAct_9fa48("1046") ? "" : (stryCov_9fa48("1046"), 'open'))),
                priority: stryMutAct_9fa48("1049") ? item.priority && 'medium' : stryMutAct_9fa48("1048") ? false : stryMutAct_9fa48("1047") ? true : (stryCov_9fa48("1047", "1048", "1049"), item.priority || (stryMutAct_9fa48("1050") ? "" : (stryCov_9fa48("1050"), 'medium'))),
                agent_role: stryMutAct_9fa48("1053") ? params.agent_role && null : stryMutAct_9fa48("1052") ? false : stryMutAct_9fa48("1051") ? true : (stryCov_9fa48("1051", "1052", "1053"), params.agent_role || null),
                created_at: nowISO(),
                updated_at: nowISO(),
                filepath: taskFilepath
              }));
              stryMutAct_9fa48("1054") ? tasksCreated-- : (stryCov_9fa48("1054"), tasksCreated++);
            }
          }
        }
      }

      // Auto-complete tasks identified by the LLM
      let tasksAutoCompleted = 0;
      if (stryMutAct_9fa48("1056") ? false : stryMutAct_9fa48("1055") ? true : (stryCov_9fa48("1055", "1056"), Array.isArray(insights.completed_tasks))) {
        if (stryMutAct_9fa48("1057")) {
          {}
        } else {
          stryCov_9fa48("1057");
          for (const completed of insights.completed_tasks) {
            if (stryMutAct_9fa48("1058")) {
              {}
            } else {
              stryCov_9fa48("1058");
              const taskId = stryMutAct_9fa48("1059") ? completed.task_id || '' : (stryCov_9fa48("1059"), (stryMutAct_9fa48("1062") ? completed.task_id && '' : stryMutAct_9fa48("1061") ? false : stryMutAct_9fa48("1060") ? true : (stryCov_9fa48("1060", "1061", "1062"), completed.task_id || (stryMutAct_9fa48("1063") ? "Stryker was here!" : (stryCov_9fa48("1063"), '')))).trim());
              if (stryMutAct_9fa48("1066") ? false : stryMutAct_9fa48("1065") ? true : stryMutAct_9fa48("1064") ? taskId : (stryCov_9fa48("1064", "1065", "1066"), !taskId)) continue;
              try {
                if (stryMutAct_9fa48("1067")) {
                  {}
                } else {
                  stryCov_9fa48("1067");
                  const existing = this.indexer.db.prepare(stryMutAct_9fa48("1068") ? "" : (stryCov_9fa48("1068"), 'SELECT * FROM tasks WHERE id = ?')).get(taskId);
                  if (stryMutAct_9fa48("1071") ? existing || existing.status !== 'done' : stryMutAct_9fa48("1070") ? false : stryMutAct_9fa48("1069") ? true : (stryCov_9fa48("1069", "1070", "1071"), existing && (stryMutAct_9fa48("1073") ? existing.status === 'done' : stryMutAct_9fa48("1072") ? true : (stryCov_9fa48("1072", "1073"), existing.status !== (stryMutAct_9fa48("1074") ? "" : (stryCov_9fa48("1074"), 'done')))))) {
                    if (stryMutAct_9fa48("1075")) {
                      {}
                    } else {
                      stryCov_9fa48("1075");
                      this.indexer.indexTask(stryMutAct_9fa48("1076") ? {} : (stryCov_9fa48("1076"), {
                        ...existing,
                        status: stryMutAct_9fa48("1077") ? "" : (stryCov_9fa48("1077"), 'done'),
                        updated_at: nowISO()
                      }));
                      stryMutAct_9fa48("1078") ? tasksAutoCompleted-- : (stryCov_9fa48("1078"), tasksAutoCompleted++);
                    }
                  }
                }
              } catch (err) {
                if (stryMutAct_9fa48("1079")) {
                  {}
                } else {
                  stryCov_9fa48("1079");
                  console.warn(stryMutAct_9fa48("1080") ? `` : (stryCov_9fa48("1080"), `[AwarenessDaemon] Failed to auto-complete task '${taskId}':`), err.message);
                }
              }
            }
          }
        }
      }

      // F-034: Handle skills submitted via insights.skills[] (crystallization result)
      let skillsCreated = 0;
      const submittedSkills = Array.isArray(insights.skills) ? insights.skills : stryMutAct_9fa48("1081") ? ["Stryker was here"] : (stryCov_9fa48("1081"), []);
      if (stryMutAct_9fa48("1085") ? submittedSkills.length <= 0 : stryMutAct_9fa48("1084") ? submittedSkills.length >= 0 : stryMutAct_9fa48("1083") ? false : stryMutAct_9fa48("1082") ? true : (stryCov_9fa48("1082", "1083", "1084", "1085"), submittedSkills.length > 0)) {
        if (stryMutAct_9fa48("1086")) {
          {}
        } else {
          stryCov_9fa48("1086");
          for (const skill of submittedSkills) {
            if (stryMutAct_9fa48("1087")) {
              {}
            } else {
              stryCov_9fa48("1087");
              if (stryMutAct_9fa48("1090") ? false : stryMutAct_9fa48("1089") ? true : stryMutAct_9fa48("1088") ? skill.name : (stryCov_9fa48("1088", "1089", "1090"), !skill.name)) continue;
              try {
                if (stryMutAct_9fa48("1091")) {
                  {}
                } else {
                  stryCov_9fa48("1091");
                  const skillId = stryMutAct_9fa48("1092") ? `` : (stryCov_9fa48("1092"), `skill_${Date.now()}_${stryMutAct_9fa48("1093") ? Math.random().toString(36) : (stryCov_9fa48("1093"), Math.random().toString(36).slice(2, 6))}`);
                  const now = nowISO();
                  this.indexer.db.prepare(stryMutAct_9fa48("1094") ? `` : (stryCov_9fa48("1094"), `
            INSERT OR IGNORE INTO skills
              (id, name, summary, methods, trigger_conditions, tags, source_card_ids,
               decay_score, usage_count, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 0, 'active', ?, ?)
          `)).run(skillId, skill.name, stryMutAct_9fa48("1097") ? skill.summary && '' : stryMutAct_9fa48("1096") ? false : stryMutAct_9fa48("1095") ? true : (stryCov_9fa48("1095", "1096", "1097"), skill.summary || (stryMutAct_9fa48("1098") ? "Stryker was here!" : (stryCov_9fa48("1098"), ''))), skill.methods ? JSON.stringify(skill.methods) : null, skill.trigger_conditions ? JSON.stringify(skill.trigger_conditions) : null, skill.tags ? JSON.stringify(skill.tags) : null, skill.source_card_ids ? JSON.stringify(skill.source_card_ids) : null, now, now);
                  stryMutAct_9fa48("1099") ? skillsCreated-- : (stryCov_9fa48("1099"), skillsCreated++);
                }
              } catch (err) {
                if (stryMutAct_9fa48("1100")) {
                  {}
                } else {
                  stryCov_9fa48("1100");
                  console.warn(stryMutAct_9fa48("1101") ? `` : (stryCov_9fa48("1101"), `[AwarenessDaemon] Failed to save skill '${skill.name}':`), err.message);
                }
              }
            }
          }
        }
      }

      // F-034: Crystallization hint — check if newly created eligible cards match existing ones
      let crystallizationHint = null;
      if (stryMutAct_9fa48("1104") ? crystallizationCandidates.length > 0 || submittedSkills.length === 0 : stryMutAct_9fa48("1103") ? false : stryMutAct_9fa48("1102") ? true : (stryCov_9fa48("1102", "1103", "1104"), (stryMutAct_9fa48("1107") ? crystallizationCandidates.length <= 0 : stryMutAct_9fa48("1106") ? crystallizationCandidates.length >= 0 : stryMutAct_9fa48("1105") ? true : (stryCov_9fa48("1105", "1106", "1107"), crystallizationCandidates.length > 0)) && (stryMutAct_9fa48("1109") ? submittedSkills.length !== 0 : stryMutAct_9fa48("1108") ? true : (stryCov_9fa48("1108", "1109"), submittedSkills.length === 0)))) {
        if (stryMutAct_9fa48("1110")) {
          {}
        } else {
          stryCov_9fa48("1110");
          const first = crystallizationCandidates[0];
          crystallizationHint = _checkCrystallizationLocal(this.indexer.db, first);
        }
      }
      const result = stryMutAct_9fa48("1111") ? {} : (stryCov_9fa48("1111"), {
        status: stryMutAct_9fa48("1112") ? "" : (stryCov_9fa48("1112"), 'ok'),
        cards_created: cardsCreated,
        tasks_created: tasksCreated,
        tasks_auto_completed: tasksAutoCompleted,
        skills_created: skillsCreated,
        mode: stryMutAct_9fa48("1113") ? "" : (stryCov_9fa48("1113"), 'local')
      });
      if (stryMutAct_9fa48("1115") ? false : stryMutAct_9fa48("1114") ? true : (stryCov_9fa48("1114", "1115"), crystallizationHint)) {
        if (stryMutAct_9fa48("1116")) {
          {}
        } else {
          stryCov_9fa48("1116");
          result._skill_crystallization_hint = crystallizationHint;
        }
      }
      return result;
    }
  }

  /** Handle structured data lookups. */
  async _lookup(params) {
    if (stryMutAct_9fa48("1117")) {
      {}
    } else {
      stryCov_9fa48("1117");
      const {
        type,
        limit = 10,
        status,
        category,
        priority,
        session_id,
        agent_role,
        query
      } = params;
      switch (type) {
        case stryMutAct_9fa48("1119") ? "" : (stryCov_9fa48("1119"), 'context'):
          if (stryMutAct_9fa48("1118")) {} else {
            stryCov_9fa48("1118");
            {
              if (stryMutAct_9fa48("1120")) {
                {}
              } else {
                stryCov_9fa48("1120");
                // Full context dump with preference separation
                const stats = this.indexer.getStats();
                const knowledge = this.indexer.getRecentKnowledge(limit);
                const tasks = this.indexer.getOpenTasks(0);
                const rawSessions = this.indexer.getRecentSessions(7);
                // De-noise: only sessions with content; fallback to 3 most recent
                let sessions = stryMutAct_9fa48("1121") ? rawSessions : (stryCov_9fa48("1121"), rawSessions.filter(stryMutAct_9fa48("1122") ? () => undefined : (stryCov_9fa48("1122"), s => stryMutAct_9fa48("1125") ? s.memory_count > 0 && s.summary : stryMutAct_9fa48("1124") ? false : stryMutAct_9fa48("1123") ? true : (stryCov_9fa48("1123", "1124", "1125"), (stryMutAct_9fa48("1128") ? s.memory_count <= 0 : stryMutAct_9fa48("1127") ? s.memory_count >= 0 : stryMutAct_9fa48("1126") ? false : (stryCov_9fa48("1126", "1127", "1128"), s.memory_count > 0)) || s.summary))));
                if (stryMutAct_9fa48("1131") ? sessions.length !== 0 : stryMutAct_9fa48("1130") ? false : stryMutAct_9fa48("1129") ? true : (stryCov_9fa48("1129", "1130", "1131"), sessions.length === 0)) sessions = stryMutAct_9fa48("1132") ? rawSessions : (stryCov_9fa48("1132"), rawSessions.slice(0, 3));
                sessions = stryMutAct_9fa48("1133") ? sessions : (stryCov_9fa48("1133"), sessions.slice(0, 5));
                const {
                  user_preferences,
                  knowledge_cards: otherCards
                } = splitPreferences(knowledge);
                return stryMutAct_9fa48("1134") ? {} : (stryCov_9fa48("1134"), {
                  stats,
                  user_preferences,
                  knowledge_cards: otherCards,
                  open_tasks: tasks,
                  recent_sessions: sessions,
                  mode: stryMutAct_9fa48("1135") ? "" : (stryCov_9fa48("1135"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1137") ? "" : (stryCov_9fa48("1137"), 'tasks'):
          if (stryMutAct_9fa48("1136")) {} else {
            stryCov_9fa48("1136");
            {
              if (stryMutAct_9fa48("1138")) {
                {}
              } else {
                stryCov_9fa48("1138");
                let sql = stryMutAct_9fa48("1139") ? "" : (stryCov_9fa48("1139"), 'SELECT * FROM tasks');
                const conditions = stryMutAct_9fa48("1140") ? ["Stryker was here"] : (stryCov_9fa48("1140"), []);
                const sqlParams = stryMutAct_9fa48("1141") ? ["Stryker was here"] : (stryCov_9fa48("1141"), []);
                if (stryMutAct_9fa48("1143") ? false : stryMutAct_9fa48("1142") ? true : (stryCov_9fa48("1142", "1143"), status)) {
                  if (stryMutAct_9fa48("1144")) {
                    {}
                  } else {
                    stryCov_9fa48("1144");
                    conditions.push(stryMutAct_9fa48("1145") ? "" : (stryCov_9fa48("1145"), 'status = ?'));
                    sqlParams.push(status);
                  }
                } else {
                  if (stryMutAct_9fa48("1146")) {
                    {}
                  } else {
                    stryCov_9fa48("1146");
                    conditions.push(stryMutAct_9fa48("1147") ? "" : (stryCov_9fa48("1147"), "status = 'open'"));
                  }
                }
                if (stryMutAct_9fa48("1149") ? false : stryMutAct_9fa48("1148") ? true : (stryCov_9fa48("1148", "1149"), priority)) {
                  if (stryMutAct_9fa48("1150")) {
                    {}
                  } else {
                    stryCov_9fa48("1150");
                    conditions.push(stryMutAct_9fa48("1151") ? "" : (stryCov_9fa48("1151"), 'priority = ?'));
                    sqlParams.push(priority);
                  }
                }
                if (stryMutAct_9fa48("1153") ? false : stryMutAct_9fa48("1152") ? true : (stryCov_9fa48("1152", "1153"), agent_role)) {
                  if (stryMutAct_9fa48("1154")) {
                    {}
                  } else {
                    stryCov_9fa48("1154");
                    conditions.push(stryMutAct_9fa48("1155") ? "" : (stryCov_9fa48("1155"), 'agent_role = ?'));
                    sqlParams.push(agent_role);
                  }
                }
                if (stryMutAct_9fa48("1157") ? false : stryMutAct_9fa48("1156") ? true : (stryCov_9fa48("1156", "1157"), conditions.length)) stryMutAct_9fa48("1158") ? sql -= ' WHERE ' + conditions.join(' AND ') : (stryCov_9fa48("1158"), sql += (stryMutAct_9fa48("1159") ? "" : (stryCov_9fa48("1159"), ' WHERE ')) + conditions.join(stryMutAct_9fa48("1160") ? "" : (stryCov_9fa48("1160"), ' AND ')));
                sql += stryMutAct_9fa48("1161") ? "" : (stryCov_9fa48("1161"), ' ORDER BY created_at DESC');
                if (stryMutAct_9fa48("1165") ? limit <= 0 : stryMutAct_9fa48("1164") ? limit >= 0 : stryMutAct_9fa48("1163") ? false : stryMutAct_9fa48("1162") ? true : (stryCov_9fa48("1162", "1163", "1164", "1165"), limit > 0)) {
                  if (stryMutAct_9fa48("1166")) {
                    {}
                  } else {
                    stryCov_9fa48("1166");
                    sql += stryMutAct_9fa48("1167") ? "" : (stryCov_9fa48("1167"), ' LIMIT ?');
                    sqlParams.push(limit);
                  }
                }
                const tasks = this.indexer.db.prepare(sql).all(...sqlParams);
                return stryMutAct_9fa48("1168") ? {} : (stryCov_9fa48("1168"), {
                  tasks,
                  total: tasks.length,
                  mode: stryMutAct_9fa48("1169") ? "" : (stryCov_9fa48("1169"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1171") ? "" : (stryCov_9fa48("1171"), 'knowledge'):
          if (stryMutAct_9fa48("1170")) {} else {
            stryCov_9fa48("1170");
            {
              if (stryMutAct_9fa48("1172")) {
                {}
              } else {
                stryCov_9fa48("1172");
                let sql = stryMutAct_9fa48("1173") ? "" : (stryCov_9fa48("1173"), 'SELECT * FROM knowledge_cards');
                const conditions = stryMutAct_9fa48("1174") ? ["Stryker was here"] : (stryCov_9fa48("1174"), []);
                const sqlParams = stryMutAct_9fa48("1175") ? ["Stryker was here"] : (stryCov_9fa48("1175"), []);
                if (stryMutAct_9fa48("1177") ? false : stryMutAct_9fa48("1176") ? true : (stryCov_9fa48("1176", "1177"), status)) {
                  if (stryMutAct_9fa48("1178")) {
                    {}
                  } else {
                    stryCov_9fa48("1178");
                    conditions.push(stryMutAct_9fa48("1179") ? "" : (stryCov_9fa48("1179"), 'status = ?'));
                    sqlParams.push(status);
                  }
                } else {
                  if (stryMutAct_9fa48("1180")) {
                    {}
                  } else {
                    stryCov_9fa48("1180");
                    conditions.push(stryMutAct_9fa48("1181") ? "" : (stryCov_9fa48("1181"), "status = 'active'"));
                  }
                }
                if (stryMutAct_9fa48("1183") ? false : stryMutAct_9fa48("1182") ? true : (stryCov_9fa48("1182", "1183"), category)) {
                  if (stryMutAct_9fa48("1184")) {
                    {}
                  } else {
                    stryCov_9fa48("1184");
                    conditions.push(stryMutAct_9fa48("1185") ? "" : (stryCov_9fa48("1185"), 'category = ?'));
                    sqlParams.push(category);
                  }
                }
                if (stryMutAct_9fa48("1187") ? false : stryMutAct_9fa48("1186") ? true : (stryCov_9fa48("1186", "1187"), conditions.length)) stryMutAct_9fa48("1188") ? sql -= ' WHERE ' + conditions.join(' AND ') : (stryCov_9fa48("1188"), sql += (stryMutAct_9fa48("1189") ? "" : (stryCov_9fa48("1189"), ' WHERE ')) + conditions.join(stryMutAct_9fa48("1190") ? "" : (stryCov_9fa48("1190"), ' AND ')));
                sql += stryMutAct_9fa48("1191") ? "" : (stryCov_9fa48("1191"), ' ORDER BY created_at DESC LIMIT ?');
                sqlParams.push(limit);
                const cards = this.indexer.db.prepare(sql).all(...sqlParams);
                return stryMutAct_9fa48("1192") ? {} : (stryCov_9fa48("1192"), {
                  knowledge_cards: cards,
                  total: cards.length,
                  mode: stryMutAct_9fa48("1193") ? "" : (stryCov_9fa48("1193"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1195") ? "" : (stryCov_9fa48("1195"), 'risks'):
          if (stryMutAct_9fa48("1194")) {} else {
            stryCov_9fa48("1194");
            {
              if (stryMutAct_9fa48("1196")) {
                {}
              } else {
                stryCov_9fa48("1196");
                // Risks are stored as knowledge_cards with category containing 'risk' or 'pitfall'
                let sql = stryMutAct_9fa48("1197") ? "" : (stryCov_9fa48("1197"), "SELECT * FROM knowledge_cards WHERE (category = 'pitfall' OR category = 'risk')");
                const sqlParams = stryMutAct_9fa48("1198") ? ["Stryker was here"] : (stryCov_9fa48("1198"), []);
                if (stryMutAct_9fa48("1200") ? false : stryMutAct_9fa48("1199") ? true : (stryCov_9fa48("1199", "1200"), status)) {
                  if (stryMutAct_9fa48("1201")) {
                    {}
                  } else {
                    stryCov_9fa48("1201");
                    sql += stryMutAct_9fa48("1202") ? "" : (stryCov_9fa48("1202"), ' AND status = ?');
                    sqlParams.push(status);
                  }
                } else {
                  if (stryMutAct_9fa48("1203")) {
                    {}
                  } else {
                    stryCov_9fa48("1203");
                    sql += stryMutAct_9fa48("1204") ? "" : (stryCov_9fa48("1204"), " AND status = 'active'");
                  }
                }
                sql += stryMutAct_9fa48("1205") ? "" : (stryCov_9fa48("1205"), ' ORDER BY created_at DESC LIMIT ?');
                sqlParams.push(limit);
                const risks = this.indexer.db.prepare(sql).all(...sqlParams);
                return stryMutAct_9fa48("1206") ? {} : (stryCov_9fa48("1206"), {
                  risks,
                  total: risks.length,
                  mode: stryMutAct_9fa48("1207") ? "" : (stryCov_9fa48("1207"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1209") ? "" : (stryCov_9fa48("1209"), 'session_history'):
          if (stryMutAct_9fa48("1208")) {} else {
            stryCov_9fa48("1208");
            {
              if (stryMutAct_9fa48("1210")) {
                {}
              } else {
                stryCov_9fa48("1210");
                let sql = stryMutAct_9fa48("1211") ? "" : (stryCov_9fa48("1211"), 'SELECT * FROM sessions');
                const conditions = stryMutAct_9fa48("1212") ? ["Stryker was here"] : (stryCov_9fa48("1212"), []);
                const sqlParams = stryMutAct_9fa48("1213") ? ["Stryker was here"] : (stryCov_9fa48("1213"), []);
                if (stryMutAct_9fa48("1215") ? false : stryMutAct_9fa48("1214") ? true : (stryCov_9fa48("1214", "1215"), session_id)) {
                  if (stryMutAct_9fa48("1216")) {
                    {}
                  } else {
                    stryCov_9fa48("1216");
                    conditions.push(stryMutAct_9fa48("1217") ? "" : (stryCov_9fa48("1217"), 'id = ?'));
                    sqlParams.push(session_id);
                  }
                }
                if (stryMutAct_9fa48("1219") ? false : stryMutAct_9fa48("1218") ? true : (stryCov_9fa48("1218", "1219"), conditions.length)) stryMutAct_9fa48("1220") ? sql -= ' WHERE ' + conditions.join(' AND ') : (stryCov_9fa48("1220"), sql += (stryMutAct_9fa48("1221") ? "" : (stryCov_9fa48("1221"), ' WHERE ')) + conditions.join(stryMutAct_9fa48("1222") ? "" : (stryCov_9fa48("1222"), ' AND ')));
                sql += stryMutAct_9fa48("1223") ? "" : (stryCov_9fa48("1223"), ' ORDER BY started_at DESC LIMIT ?');
                sqlParams.push(limit);
                const sessions = this.indexer.db.prepare(sql).all(...sqlParams);
                return stryMutAct_9fa48("1224") ? {} : (stryCov_9fa48("1224"), {
                  sessions,
                  total: sessions.length,
                  mode: stryMutAct_9fa48("1225") ? "" : (stryCov_9fa48("1225"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1227") ? "" : (stryCov_9fa48("1227"), 'timeline'):
          if (stryMutAct_9fa48("1226")) {} else {
            stryCov_9fa48("1226");
            {
              if (stryMutAct_9fa48("1228")) {
                {}
              } else {
                stryCov_9fa48("1228");
                // Timeline = recent memories ordered by time
                const memories = this.indexer.db.prepare(stryMutAct_9fa48("1229") ? "" : (stryCov_9fa48("1229"), "SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ?")).all(limit);
                return stryMutAct_9fa48("1230") ? {} : (stryCov_9fa48("1230"), {
                  events: memories,
                  total: memories.length,
                  mode: stryMutAct_9fa48("1231") ? "" : (stryCov_9fa48("1231"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1233") ? "" : (stryCov_9fa48("1233"), 'skills'):
          if (stryMutAct_9fa48("1232")) {} else {
            stryCov_9fa48("1232");
            {
              if (stryMutAct_9fa48("1234")) {
                {}
              } else {
                stryCov_9fa48("1234");
                // F-032: Query dedicated skills table (not deprecated knowledge_cards category)
                let skillSql = stryMutAct_9fa48("1235") ? "" : (stryCov_9fa48("1235"), 'SELECT * FROM skills');
                const skillParams = stryMutAct_9fa48("1236") ? ["Stryker was here"] : (stryCov_9fa48("1236"), []);
                if (stryMutAct_9fa48("1238") ? false : stryMutAct_9fa48("1237") ? true : (stryCov_9fa48("1237", "1238"), status)) {
                  if (stryMutAct_9fa48("1239")) {
                    {}
                  } else {
                    stryCov_9fa48("1239");
                    skillSql += stryMutAct_9fa48("1240") ? "" : (stryCov_9fa48("1240"), ' WHERE status = ?');
                    skillParams.push(status);
                  }
                } else {
                  if (stryMutAct_9fa48("1241")) {
                    {}
                  } else {
                    stryCov_9fa48("1241");
                    skillSql += stryMutAct_9fa48("1242") ? "" : (stryCov_9fa48("1242"), " WHERE status = 'active'");
                  }
                }
                skillSql += stryMutAct_9fa48("1243") ? "" : (stryCov_9fa48("1243"), ' ORDER BY decay_score DESC, created_at DESC LIMIT ?');
                skillParams.push(limit);
                let skills;
                try {
                  if (stryMutAct_9fa48("1244")) {
                    {}
                  } else {
                    stryCov_9fa48("1244");
                    skills = this.indexer.db.prepare(skillSql).all(...skillParams);
                  }
                } catch {
                  if (stryMutAct_9fa48("1245")) {
                    {}
                  } else {
                    stryCov_9fa48("1245");
                    // Fallback to legacy knowledge_cards if skills table doesn't exist yet
                    skills = this.indexer.db.prepare(stryMutAct_9fa48("1246") ? "" : (stryCov_9fa48("1246"), "SELECT * FROM knowledge_cards WHERE category = 'skill' AND status = 'active' ORDER BY created_at DESC LIMIT ?")).all(limit);
                  }
                }
                return stryMutAct_9fa48("1247") ? {} : (stryCov_9fa48("1247"), {
                  skills,
                  total: skills.length,
                  mode: stryMutAct_9fa48("1248") ? "" : (stryCov_9fa48("1248"), 'local')
                });
              }
            }
          }
        case stryMutAct_9fa48("1250") ? "" : (stryCov_9fa48("1250"), 'perception'):
          if (stryMutAct_9fa48("1249")) {} else {
            stryCov_9fa48("1249");
            {
              if (stryMutAct_9fa48("1251")) {
                {}
              } else {
                stryCov_9fa48("1251");
                // Read perception signals from cache file + derive from recent knowledge
                const signals = stryMutAct_9fa48("1252") ? ["Stryker was here"] : (stryCov_9fa48("1252"), []);
                const fs = await import('fs');
                const path = await import('path');
                const os = await import('os');

                // 1. Read cached perception signals (written by awareness plugin hooks)
                try {
                  if (stryMutAct_9fa48("1253")) {
                    {}
                  } else {
                    stryCov_9fa48("1253");
                    const cachePath = path.join(this.awarenessDir, stryMutAct_9fa48("1254") ? "" : (stryCov_9fa48("1254"), 'perception-cache.json'));
                    if (stryMutAct_9fa48("1256") ? false : stryMutAct_9fa48("1255") ? true : (stryCov_9fa48("1255", "1256"), fs.existsSync(cachePath))) {
                      if (stryMutAct_9fa48("1257")) {
                        {}
                      } else {
                        stryCov_9fa48("1257");
                        const cached = JSON.parse(fs.readFileSync(cachePath, stryMutAct_9fa48("1258") ? "" : (stryCov_9fa48("1258"), 'utf8')));
                        if (stryMutAct_9fa48("1260") ? false : stryMutAct_9fa48("1259") ? true : (stryCov_9fa48("1259", "1260"), Array.isArray(cached))) {
                          if (stryMutAct_9fa48("1261")) {
                            {}
                          } else {
                            stryCov_9fa48("1261");
                            signals.push(...cached);
                          }
                        } else if (stryMutAct_9fa48("1263") ? false : stryMutAct_9fa48("1262") ? true : (stryCov_9fa48("1262", "1263"), cached.signals)) {
                          if (stryMutAct_9fa48("1264")) {
                            {}
                          } else {
                            stryCov_9fa48("1264");
                            signals.push(...cached.signals);
                          }
                        }
                      }
                    }
                  }
                } catch {/* no cache file */}

                // 2. Derive staleness signals from old knowledge cards (30-day threshold, unified)
                try {
                  if (stryMutAct_9fa48("1265")) {
                    {}
                  } else {
                    stryCov_9fa48("1265");
                    const staleCards = this.indexer.db.prepare(stryMutAct_9fa48("1266") ? `` : (stryCov_9fa48("1266"), `SELECT title, category, COALESCE(updated_at, created_at) AS last_touch
               FROM knowledge_cards
               WHERE status = 'active'
                 AND COALESCE(updated_at, created_at) < datetime('now', '-30 days')
               ORDER BY last_touch ASC LIMIT 3`)).all();
                    for (const card of staleCards) {
                      if (stryMutAct_9fa48("1267")) {
                        {}
                      } else {
                        stryCov_9fa48("1267");
                        const daysOld = card.last_touch ? Math.floor(stryMutAct_9fa48("1268") ? (Date.now() - new Date(card.last_touch).getTime()) * 86400000 : (stryCov_9fa48("1268"), (stryMutAct_9fa48("1269") ? Date.now() + new Date(card.last_touch).getTime() : (stryCov_9fa48("1269"), Date.now() - new Date(card.last_touch).getTime())) / 86400000)) : 30;
                        signals.push(stryMutAct_9fa48("1270") ? {} : (stryCov_9fa48("1270"), {
                          type: stryMutAct_9fa48("1271") ? "" : (stryCov_9fa48("1271"), 'staleness'),
                          message: stryMutAct_9fa48("1272") ? `` : (stryCov_9fa48("1272"), `⏳ Knowledge card "${card.title}" hasn't been updated in ${daysOld} days — may be outdated`),
                          card_title: card.title,
                          category: card.category,
                          days_since_update: daysOld
                        }));
                      }
                    }
                  }
                } catch {/* db might not have the table */}

                // 3. Derive pattern signals from tag co-occurrence (not just category count)
                try {
                  if (stryMutAct_9fa48("1273")) {
                    {}
                  } else {
                    stryCov_9fa48("1273");
                    const recentCards = this.indexer.db.prepare(stryMutAct_9fa48("1274") ? `` : (stryCov_9fa48("1274"), `SELECT tags FROM knowledge_cards
               WHERE status = 'active' AND created_at > datetime('now', '-7 days')`)).all();
                    const tagCounts = new Map();
                    for (const row of recentCards) {
                      if (stryMutAct_9fa48("1275")) {
                        {}
                      } else {
                        stryCov_9fa48("1275");
                        let tags = stryMutAct_9fa48("1276") ? ["Stryker was here"] : (stryCov_9fa48("1276"), []);
                        try {
                          if (stryMutAct_9fa48("1277")) {
                            {}
                          } else {
                            stryCov_9fa48("1277");
                            tags = JSON.parse(stryMutAct_9fa48("1280") ? row.tags && '[]' : stryMutAct_9fa48("1279") ? false : stryMutAct_9fa48("1278") ? true : (stryCov_9fa48("1278", "1279", "1280"), row.tags || (stryMutAct_9fa48("1281") ? "" : (stryCov_9fa48("1281"), '[]'))));
                          }
                        } catch {/* skip */}
                        for (const t of tags) {
                          if (stryMutAct_9fa48("1282")) {
                            {}
                          } else {
                            stryCov_9fa48("1282");
                            if (stryMutAct_9fa48("1285") ? typeof t === 'string' || t.length >= 2 : stryMutAct_9fa48("1284") ? false : stryMutAct_9fa48("1283") ? true : (stryCov_9fa48("1283", "1284", "1285"), (stryMutAct_9fa48("1287") ? typeof t !== 'string' : stryMutAct_9fa48("1286") ? true : (stryCov_9fa48("1286", "1287"), typeof t === (stryMutAct_9fa48("1288") ? "" : (stryCov_9fa48("1288"), 'string')))) && (stryMutAct_9fa48("1291") ? t.length < 2 : stryMutAct_9fa48("1290") ? t.length > 2 : stryMutAct_9fa48("1289") ? true : (stryCov_9fa48("1289", "1290", "1291"), t.length >= 2)))) {
                              if (stryMutAct_9fa48("1292")) {
                                {}
                              } else {
                                stryCov_9fa48("1292");
                                const k = stryMutAct_9fa48("1293") ? t.toUpperCase() : (stryCov_9fa48("1293"), t.toLowerCase());
                                tagCounts.set(k, stryMutAct_9fa48("1294") ? (tagCounts.get(k) || 0) - 1 : (stryCov_9fa48("1294"), (stryMutAct_9fa48("1297") ? tagCounts.get(k) && 0 : stryMutAct_9fa48("1296") ? false : stryMutAct_9fa48("1295") ? true : (stryCov_9fa48("1295", "1296", "1297"), tagCounts.get(k) || 0)) + 1));
                              }
                            }
                          }
                        }
                      }
                    }
                    const themes = stryMutAct_9fa48("1300") ? [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) : stryMutAct_9fa48("1299") ? [...tagCounts.entries()].filter(([, count]) => count >= 3).slice(0, 3) : stryMutAct_9fa48("1298") ? [...tagCounts.entries()].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]) : (stryCov_9fa48("1298", "1299", "1300"), (stryMutAct_9fa48("1301") ? [] : (stryCov_9fa48("1301"), [...tagCounts.entries()])).filter(stryMutAct_9fa48("1302") ? () => undefined : (stryCov_9fa48("1302"), ([, count]) => stryMutAct_9fa48("1306") ? count < 3 : stryMutAct_9fa48("1305") ? count > 3 : stryMutAct_9fa48("1304") ? false : stryMutAct_9fa48("1303") ? true : (stryCov_9fa48("1303", "1304", "1305", "1306"), count >= 3))).sort(stryMutAct_9fa48("1307") ? () => undefined : (stryCov_9fa48("1307"), (a, b) => stryMutAct_9fa48("1308") ? b[1] + a[1] : (stryCov_9fa48("1308"), b[1] - a[1]))).slice(0, 3));
                    for (const [tag, count] of themes) {
                      if (stryMutAct_9fa48("1309")) {
                        {}
                      } else {
                        stryCov_9fa48("1309");
                        signals.push(stryMutAct_9fa48("1310") ? {} : (stryCov_9fa48("1310"), {
                          type: stryMutAct_9fa48("1311") ? "" : (stryCov_9fa48("1311"), 'pattern'),
                          message: stryMutAct_9fa48("1312") ? `` : (stryCov_9fa48("1312"), `🔄 Recurring theme in last 7 days: "${tag}" (${count} cards) — consider a systematic approach`),
                          tag,
                          count
                        }));
                      }
                    }
                  }
                } catch {/* db issue */}
                return stryMutAct_9fa48("1313") ? {} : (stryCov_9fa48("1313"), {
                  signals,
                  total: signals.length,
                  mode: stryMutAct_9fa48("1314") ? "" : (stryCov_9fa48("1314"), 'local')
                });
              }
            }
          }
        default:
          if (stryMutAct_9fa48("1315")) {} else {
            stryCov_9fa48("1315");
            return stryMutAct_9fa48("1316") ? {} : (stryCov_9fa48("1316"), {
              error: stryMutAct_9fa48("1317") ? `` : (stryCov_9fa48("1317"), `Unknown lookup type: ${type}`),
              mode: stryMutAct_9fa48("1318") ? "" : (stryCov_9fa48("1318"), 'local')
            });
          }
      }
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
    if (stryMutAct_9fa48("1319")) {
      {}
    } else {
      stryCov_9fa48("1319");
      return warmupEmbedder(this);
    }
  }

  /**
   * Backfill embeddings for memories that were indexed before vector search was enabled.
   * Runs in background on startup — processes in batches to avoid blocking.
   */
  async _backfillEmbeddings() {
    if (stryMutAct_9fa48("1320")) {
      {}
    } else {
      stryCov_9fa48("1320");
      return backfillEmbeddings(this);
    }
  }

  /**
   * Generate embedding for a memory and store it in the index.
   * Fire-and-forget — errors are logged but don't block the record flow.
   */
  async _embedAndStore(memoryId, content) {
    if (stryMutAct_9fa48("1321")) {
      {}
    } else {
      stryCov_9fa48("1321");
      return embedAndStore(this, memoryId, content);
    }
  }

  /**
   * Extract knowledge from a newly recorded memory and index the results.
   * Fire-and-forget — errors are logged but don't fail the record.
   */
  async _extractAndIndex(memoryId, content, metadata, preExtractedInsights) {
    if (stryMutAct_9fa48("1322")) {
      {}
    } else {
      stryCov_9fa48("1322");
      return extractAndIndex(this, memoryId, content, metadata, preExtractedInsights);
    }
  }

  // -----------------------------------------------------------------------
  // File watcher
  // -----------------------------------------------------------------------

  /** Start watching .awareness/memories/ for changes (debounced reindex). */
  _startFileWatcher() {
    if (stryMutAct_9fa48("1323")) {
      {}
    } else {
      stryCov_9fa48("1323");
      this.watcher = startFileWatcher(this);
    }
  }

  // -----------------------------------------------------------------------
  // F-038: Workspace Scanner
  // -----------------------------------------------------------------------

  /**
   * Initialize workspace scanner: load state, start watchers, trigger first scan.
   * All operations are non-blocking — errors degrade gracefully.
   */
  _initWorkspaceScanner() {
    if (stryMutAct_9fa48("1324")) {
      {}
    } else {
      stryCov_9fa48("1324");
      try {
        if (stryMutAct_9fa48("1325")) {
          {}
        } else {
          stryCov_9fa48("1325");
          this.scanConfig = loadScanConfig(this.projectDir);
          if (stryMutAct_9fa48("1328") ? false : stryMutAct_9fa48("1327") ? true : stryMutAct_9fa48("1326") ? this.scanConfig.enabled : (stryCov_9fa48("1326", "1327", "1328"), !this.scanConfig.enabled)) {
            if (stryMutAct_9fa48("1329")) {
              {}
            } else {
              stryCov_9fa48("1329");
              console.log(stryMutAct_9fa48("1330") ? "" : (stryCov_9fa48("1330"), '[workspace-scanner] disabled via scan-config.json'));
              return;
            }
          }

          // Load persisted state (for last_git_commit etc.)
          this.scanState = loadScanState(this.projectDir);

          // Start workspace file watcher
          this._workspaceWatcher = startWorkspaceWatcher(this);

          // Start .git/HEAD watcher
          if (stryMutAct_9fa48("1332") ? false : stryMutAct_9fa48("1331") ? true : (stryCov_9fa48("1331", "1332"), isGitRepo(this.projectDir))) {
            if (stryMutAct_9fa48("1333")) {
              {}
            } else {
              stryCov_9fa48("1333");
              this._gitHeadWatcher = startGitHeadWatcher(this);
            }
          }

          // Trigger initial scan in background (deferred 3s to avoid blocking startup)
          setTimeout(() => {
            if (stryMutAct_9fa48("1334")) {
              {}
            } else {
              stryCov_9fa48("1334");
              this.triggerScan(stryMutAct_9fa48("1335") ? "" : (stryCov_9fa48("1335"), 'incremental')).catch(err => {
                if (stryMutAct_9fa48("1336")) {
                  {}
                } else {
                  stryCov_9fa48("1336");
                  console.error(stryMutAct_9fa48("1337") ? "" : (stryCov_9fa48("1337"), '[workspace-scanner] initial scan failed:'), err.message);
                }
              });
            }
          }, 3000);
          console.log(stryMutAct_9fa48("1338") ? "" : (stryCov_9fa48("1338"), '[workspace-scanner] initialized, first scan in 3s'));
        }
      } catch (err) {
        if (stryMutAct_9fa48("1339")) {
          {}
        } else {
          stryCov_9fa48("1339");
          console.error(stryMutAct_9fa48("1340") ? "" : (stryCov_9fa48("1340"), '[workspace-scanner] init failed (degraded):'), err.message);
        }
      }
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
  async triggerScan(mode = stryMutAct_9fa48("1341") ? "" : (stryCov_9fa48("1341"), 'incremental')) {
    if (stryMutAct_9fa48("1342")) {
      {}
    } else {
      stryCov_9fa48("1342");
      if (stryMutAct_9fa48("1345") ? !this.indexer && !this.scanConfig?.enabled : stryMutAct_9fa48("1344") ? false : stryMutAct_9fa48("1343") ? true : (stryCov_9fa48("1343", "1344", "1345"), (stryMutAct_9fa48("1346") ? this.indexer : (stryCov_9fa48("1346"), !this.indexer)) || (stryMutAct_9fa48("1347") ? this.scanConfig?.enabled : (stryCov_9fa48("1347"), !(stryMutAct_9fa48("1348") ? this.scanConfig.enabled : (stryCov_9fa48("1348"), this.scanConfig?.enabled)))))) {
        if (stryMutAct_9fa48("1349")) {
          {}
        } else {
          stryCov_9fa48("1349");
          return stryMutAct_9fa48("1350") ? {} : (stryCov_9fa48("1350"), {
            indexed: 0,
            skipped: 0,
            errors: 0,
            edges: 0
          });
        }
      }

      // Prevent concurrent scans
      if (stryMutAct_9fa48("1353") ? this.scanState.status === 'scanning' && this.scanState.status === 'indexing' : stryMutAct_9fa48("1352") ? false : stryMutAct_9fa48("1351") ? true : (stryCov_9fa48("1351", "1352", "1353"), (stryMutAct_9fa48("1355") ? this.scanState.status !== 'scanning' : stryMutAct_9fa48("1354") ? false : (stryCov_9fa48("1354", "1355"), this.scanState.status === (stryMutAct_9fa48("1356") ? "" : (stryCov_9fa48("1356"), 'scanning')))) || (stryMutAct_9fa48("1358") ? this.scanState.status !== 'indexing' : stryMutAct_9fa48("1357") ? false : (stryCov_9fa48("1357", "1358"), this.scanState.status === (stryMutAct_9fa48("1359") ? "" : (stryCov_9fa48("1359"), 'indexing')))))) {
        if (stryMutAct_9fa48("1360")) {
          {}
        } else {
          stryCov_9fa48("1360");
          console.log(stryMutAct_9fa48("1361") ? "" : (stryCov_9fa48("1361"), '[workspace-scanner] scan already in progress, skipping'));
          return stryMutAct_9fa48("1362") ? {} : (stryCov_9fa48("1362"), {
            indexed: 0,
            skipped: 0,
            errors: 0,
            edges: 0
          });
        }
      }
      const startTime = Date.now();
      this._scanAbortController = new AbortController();
      try {
        if (stryMutAct_9fa48("1363")) {
          {}
        } else {
          stryCov_9fa48("1363");
          this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1364") ? {} : (stryCov_9fa48("1364"), {
            status: stryMutAct_9fa48("1365") ? "" : (stryCov_9fa48("1365"), 'scanning'),
            phase: stryMutAct_9fa48("1366") ? "" : (stryCov_9fa48("1366"), 'discovering')
          }));
          const config = this.scanConfig;
          const gitignore = loadGitignoreRules(this.projectDir, stryMutAct_9fa48("1367") ? {} : (stryCov_9fa48("1367"), {
            extraPatterns: config.exclude
          }));
          let filesToIndex;
          if (stryMutAct_9fa48("1370") ? mode === 'incremental' && config.git_incremental || isGitRepo(this.projectDir) : stryMutAct_9fa48("1369") ? false : stryMutAct_9fa48("1368") ? true : (stryCov_9fa48("1368", "1369", "1370"), (stryMutAct_9fa48("1372") ? mode === 'incremental' || config.git_incremental : stryMutAct_9fa48("1371") ? true : (stryCov_9fa48("1371", "1372"), (stryMutAct_9fa48("1374") ? mode !== 'incremental' : stryMutAct_9fa48("1373") ? true : (stryCov_9fa48("1373", "1374"), mode === (stryMutAct_9fa48("1375") ? "" : (stryCov_9fa48("1375"), 'incremental')))) && config.git_incremental)) && isGitRepo(this.projectDir))) {
            if (stryMutAct_9fa48("1376")) {
              {}
            } else {
              stryCov_9fa48("1376");
              const currentCommit = getCurrentCommit(this.projectDir);
              const lastCommit = this.scanState.last_git_commit;
              if (stryMutAct_9fa48("1379") ? currentCommit || currentCommit === lastCommit : stryMutAct_9fa48("1378") ? false : stryMutAct_9fa48("1377") ? true : (stryCov_9fa48("1377", "1378", "1379"), currentCommit && (stryMutAct_9fa48("1381") ? currentCommit !== lastCommit : stryMutAct_9fa48("1380") ? true : (stryCov_9fa48("1380", "1381"), currentCommit === lastCommit)))) {
                if (stryMutAct_9fa48("1382")) {
                  {}
                } else {
                  stryCov_9fa48("1382");
                  // No changes since last scan
                  this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1383") ? {} : (stryCov_9fa48("1383"), {
                    status: stryMutAct_9fa48("1384") ? "" : (stryCov_9fa48("1384"), 'idle'),
                    phase: null,
                    last_incremental_at: new Date().toISOString()
                  }));
                  return stryMutAct_9fa48("1385") ? {} : (stryCov_9fa48("1385"), {
                    indexed: 0,
                    skipped: 0,
                    errors: 0,
                    edges: 0
                  });
                }
              }
              const gitChanges = getGitChanges(this.projectDir, lastCommit);
              if (stryMutAct_9fa48("1387") ? false : stryMutAct_9fa48("1386") ? true : (stryCov_9fa48("1386", "1387"), gitChanges)) {
                if (stryMutAct_9fa48("1388")) {
                  {}
                } else {
                  stryCov_9fa48("1388");
                  // Handle deletions and renames first
                  if (stryMutAct_9fa48("1392") ? gitChanges.deleted.length <= 0 : stryMutAct_9fa48("1391") ? gitChanges.deleted.length >= 0 : stryMutAct_9fa48("1390") ? false : stryMutAct_9fa48("1389") ? true : (stryCov_9fa48("1389", "1390", "1391", "1392"), gitChanges.deleted.length > 0)) {
                    if (stryMutAct_9fa48("1393")) {
                      {}
                    } else {
                      stryCov_9fa48("1393");
                      markDeletedFiles(gitChanges.deleted, this.indexer);
                    }
                  }
                  if (stryMutAct_9fa48("1397") ? gitChanges.renamed.length <= 0 : stryMutAct_9fa48("1396") ? gitChanges.renamed.length >= 0 : stryMutAct_9fa48("1395") ? false : stryMutAct_9fa48("1394") ? true : (stryCov_9fa48("1394", "1395", "1396", "1397"), gitChanges.renamed.length > 0)) {
                    if (stryMutAct_9fa48("1398")) {
                      {}
                    } else {
                      stryCov_9fa48("1398");
                      handleRenamedFiles(gitChanges.renamed, this.indexer);
                    }
                  }

                  // Filter changed files through the scan pipeline
                  const changedPaths = stryMutAct_9fa48("1399") ? [] : (stryCov_9fa48("1399"), [...gitChanges.added, ...gitChanges.modified, ...gitChanges.renamed.map(stryMutAct_9fa48("1400") ? () => undefined : (stryCov_9fa48("1400"), r => r.to))]);
                  filesToIndex = stryMutAct_9fa48("1401") ? changedPaths.map(relPath => {
                    const absPath = path.join(this.projectDir, relPath);
                    if (!fs.existsSync(absPath)) return null;
                    const classification = classifyFile(relPath, config);
                    if (classification.excluded) return null;
                    if (gitignore.isIgnored(relPath)) return null;
                    let stat;
                    try {
                      stat = fs.statSync(absPath);
                    } catch {
                      return null;
                    }
                    return {
                      absolutePath: absPath,
                      relativePath: relPath,
                      category: classification.category,
                      size: stat.size,
                      mtime: stat.mtimeMs,
                      oversized: stat.size > (config.max_file_size_kb || 500) * 1024
                    };
                  }) : (stryCov_9fa48("1401"), changedPaths.map(relPath => {
                    if (stryMutAct_9fa48("1402")) {
                      {}
                    } else {
                      stryCov_9fa48("1402");
                      const absPath = path.join(this.projectDir, relPath);
                      if (stryMutAct_9fa48("1405") ? false : stryMutAct_9fa48("1404") ? true : stryMutAct_9fa48("1403") ? fs.existsSync(absPath) : (stryCov_9fa48("1403", "1404", "1405"), !fs.existsSync(absPath))) return null;
                      const classification = classifyFile(relPath, config);
                      if (stryMutAct_9fa48("1407") ? false : stryMutAct_9fa48("1406") ? true : (stryCov_9fa48("1406", "1407"), classification.excluded)) return null;
                      if (stryMutAct_9fa48("1409") ? false : stryMutAct_9fa48("1408") ? true : (stryCov_9fa48("1408", "1409"), gitignore.isIgnored(relPath))) return null;
                      let stat;
                      try {
                        if (stryMutAct_9fa48("1410")) {
                          {}
                        } else {
                          stryCov_9fa48("1410");
                          stat = fs.statSync(absPath);
                        }
                      } catch {
                        if (stryMutAct_9fa48("1411")) {
                          {}
                        } else {
                          stryCov_9fa48("1411");
                          return null;
                        }
                      }
                      return stryMutAct_9fa48("1412") ? {} : (stryCov_9fa48("1412"), {
                        absolutePath: absPath,
                        relativePath: relPath,
                        category: classification.category,
                        size: stat.size,
                        mtime: stat.mtimeMs,
                        oversized: stryMutAct_9fa48("1416") ? stat.size <= (config.max_file_size_kb || 500) * 1024 : stryMutAct_9fa48("1415") ? stat.size >= (config.max_file_size_kb || 500) * 1024 : stryMutAct_9fa48("1414") ? false : stryMutAct_9fa48("1413") ? true : (stryCov_9fa48("1413", "1414", "1415", "1416"), stat.size > (stryMutAct_9fa48("1417") ? (config.max_file_size_kb || 500) / 1024 : (stryCov_9fa48("1417"), (stryMutAct_9fa48("1420") ? config.max_file_size_kb && 500 : stryMutAct_9fa48("1419") ? false : stryMutAct_9fa48("1418") ? true : (stryCov_9fa48("1418", "1419", "1420"), config.max_file_size_kb || 500)) * 1024)))
                      });
                    }
                  }).filter(Boolean));

                  // Update commit tracking
                  if (stryMutAct_9fa48("1422") ? false : stryMutAct_9fa48("1421") ? true : (stryCov_9fa48("1421", "1422"), currentCommit)) {
                    if (stryMutAct_9fa48("1423")) {
                      {}
                    } else {
                      stryCov_9fa48("1423");
                      this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1424") ? {} : (stryCov_9fa48("1424"), {
                        last_git_commit: currentCommit
                      }));
                    }
                  }
                }
              } else {
                if (stryMutAct_9fa48("1425")) {
                  {}
                } else {
                  stryCov_9fa48("1425");
                  // Git changes unavailable — do full scan
                  filesToIndex = scanWorkspace(this.projectDir, stryMutAct_9fa48("1426") ? {} : (stryCov_9fa48("1426"), {
                    config,
                    gitignore,
                    signal: this._scanAbortController.signal
                  }));
                }
              }
            }
          } else {
            if (stryMutAct_9fa48("1427")) {
              {}
            } else {
              stryCov_9fa48("1427");
              // Full scan
              filesToIndex = scanWorkspace(this.projectDir, stryMutAct_9fa48("1428") ? {} : (stryCov_9fa48("1428"), {
                config,
                gitignore,
                signal: this._scanAbortController.signal
              }));
            }
          }
          this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1429") ? {} : (stryCov_9fa48("1429"), {
            status: stryMutAct_9fa48("1430") ? "" : (stryCov_9fa48("1430"), 'indexing'),
            phase: stryMutAct_9fa48("1431") ? "" : (stryCov_9fa48("1431"), 'parsing'),
            discovered_total: filesToIndex.length,
            index_total: filesToIndex.length,
            index_done: 0,
            index_skipped: 0
          }));

          // Index the files
          const result = await indexWorkspaceFiles(filesToIndex, this.indexer, stryMutAct_9fa48("1432") ? {} : (stryCov_9fa48("1432"), {
            signal: this._scanAbortController.signal,
            onProgress: progress => {
              if (stryMutAct_9fa48("1433")) {
                {}
              } else {
                stryCov_9fa48("1433");
                this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1434") ? {} : (stryCov_9fa48("1434"), {
                  index_done: progress.done,
                  index_skipped: progress.skipped
                }));
              }
            }
          }));

          // Update git commit tracking (needed for both full and incremental scans)
          if (stryMutAct_9fa48("1437") ? !this.scanState.last_git_commit || isGitRepo(this.projectDir) : stryMutAct_9fa48("1436") ? false : stryMutAct_9fa48("1435") ? true : (stryCov_9fa48("1435", "1436", "1437"), (stryMutAct_9fa48("1438") ? this.scanState.last_git_commit : (stryCov_9fa48("1438"), !this.scanState.last_git_commit)) && isGitRepo(this.projectDir))) {
            if (stryMutAct_9fa48("1439")) {
              {}
            } else {
              stryCov_9fa48("1439");
              const headCommit = getCurrentCommit(this.projectDir);
              if (stryMutAct_9fa48("1441") ? false : stryMutAct_9fa48("1440") ? true : (stryCov_9fa48("1440", "1441"), headCommit)) {
                if (stryMutAct_9fa48("1442")) {
                  {}
                } else {
                  stryCov_9fa48("1442");
                  this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1443") ? {} : (stryCov_9fa48("1443"), {
                    last_git_commit: headCommit
                  }));
                }
              }
            }
          }

          // Count totals from graph_nodes
          let totalFiles = 0;
          let totalCodeFiles = 0;
          let totalDocFiles = 0;
          let totalSymbols = 0;
          try {
            if (stryMutAct_9fa48("1444")) {
              {}
            } else {
              stryCov_9fa48("1444");
              totalFiles = this.indexer.db.prepare(stryMutAct_9fa48("1445") ? "" : (stryCov_9fa48("1445"), "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active'")).get().c;
              totalCodeFiles = this.indexer.db.prepare(stryMutAct_9fa48("1446") ? "" : (stryCov_9fa48("1446"), "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active' AND json_extract(metadata, '$.category') = 'code'")).get().c;
              totalDocFiles = this.indexer.db.prepare(stryMutAct_9fa48("1447") ? "" : (stryCov_9fa48("1447"), "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'file' AND status = 'active' AND json_extract(metadata, '$.category') = 'docs'")).get().c;
              totalSymbols = this.indexer.db.prepare(stryMutAct_9fa48("1448") ? "" : (stryCov_9fa48("1448"), "SELECT count(*) AS c FROM graph_nodes WHERE node_type = 'symbol' AND status = 'active'")).get().c;
            }
          } catch {/* stats are non-critical */}
          const duration = stryMutAct_9fa48("1449") ? Date.now() + startTime : (stryCov_9fa48("1449"), Date.now() - startTime);
          const scanType = (stryMutAct_9fa48("1452") ? mode !== 'full' : stryMutAct_9fa48("1451") ? false : stryMutAct_9fa48("1450") ? true : (stryCov_9fa48("1450", "1451", "1452"), mode === (stryMutAct_9fa48("1453") ? "" : (stryCov_9fa48("1453"), 'full')))) ? stryMutAct_9fa48("1454") ? "" : (stryCov_9fa48("1454"), 'last_full_scan_at') : stryMutAct_9fa48("1455") ? "" : (stryCov_9fa48("1455"), 'last_incremental_at');
          this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1456") ? {} : (stryCov_9fa48("1456"), {
            status: stryMutAct_9fa48("1457") ? "" : (stryCov_9fa48("1457"), 'idle'),
            phase: null,
            total_files: totalFiles,
            total_code_files: totalCodeFiles,
            total_doc_files: totalDocFiles,
            total_symbols: totalSymbols,
            scan_duration_ms: duration,
            [scanType]: new Date().toISOString()
          }));

          // Persist state
          saveScanState(this.projectDir, this.scanState);
          if (stryMutAct_9fa48("1460") ? result.indexed > 0 && result.edges > 0 : stryMutAct_9fa48("1459") ? false : stryMutAct_9fa48("1458") ? true : (stryCov_9fa48("1458", "1459", "1460"), (stryMutAct_9fa48("1463") ? result.indexed <= 0 : stryMutAct_9fa48("1462") ? result.indexed >= 0 : stryMutAct_9fa48("1461") ? false : (stryCov_9fa48("1461", "1462", "1463"), result.indexed > 0)) || (stryMutAct_9fa48("1466") ? result.edges <= 0 : stryMutAct_9fa48("1465") ? result.edges >= 0 : stryMutAct_9fa48("1464") ? false : (stryCov_9fa48("1464", "1465", "1466"), result.edges > 0)))) {
            if (stryMutAct_9fa48("1467")) {
              {}
            } else {
              stryCov_9fa48("1467");
              console.log(stryMutAct_9fa48("1468") ? `` : (stryCov_9fa48("1468"), `[workspace-scanner] ${mode} scan done: ${result.indexed} indexed, ${result.skipped} skipped, ${result.edges} edges (${duration}ms)`));
            }
          }

          // Fire-and-forget: embed graph nodes + generate similarity edges
          // Runs in background after scan completes — does not block return
          if (stryMutAct_9fa48("1471") ? result.indexed > 0 || this._embedder : stryMutAct_9fa48("1470") ? false : stryMutAct_9fa48("1469") ? true : (stryCov_9fa48("1469", "1470", "1471"), (stryMutAct_9fa48("1474") ? result.indexed <= 0 : stryMutAct_9fa48("1473") ? result.indexed >= 0 : stryMutAct_9fa48("1472") ? true : (stryCov_9fa48("1472", "1473", "1474"), result.indexed > 0)) && this._embedder)) {
            if (stryMutAct_9fa48("1475")) {
              {}
            } else {
              stryCov_9fa48("1475");
              this._triggerGraphEmbedding();
            }
          }
          return result;
        }
      } catch (err) {
        if (stryMutAct_9fa48("1476")) {
          {}
        } else {
          stryCov_9fa48("1476");
          this.scanState = appendScanError(updateScanState(this.scanState, stryMutAct_9fa48("1477") ? {} : (stryCov_9fa48("1477"), {
            status: stryMutAct_9fa48("1478") ? "" : (stryCov_9fa48("1478"), 'error'),
            phase: null
          })), err.message);
          saveScanState(this.projectDir, this.scanState);
          console.error(stryMutAct_9fa48("1479") ? "" : (stryCov_9fa48("1479"), '[workspace-scanner] scan error:'), err.message);
          return stryMutAct_9fa48("1480") ? {} : (stryCov_9fa48("1480"), {
            indexed: 0,
            skipped: 0,
            errors: 1,
            edges: 0
          });
        }
      }
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
    if (stryMutAct_9fa48("1481")) {
      {}
    } else {
      stryCov_9fa48("1481");
      // Update state to show embedding phase
      this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1482") ? {} : (stryCov_9fa48("1482"), {
        status: stryMutAct_9fa48("1483") ? "" : (stryCov_9fa48("1483"), 'indexing'),
        phase: stryMutAct_9fa48("1484") ? "" : (stryCov_9fa48("1484"), 'embedding'),
        embed_total: 0,
        embed_done: 0
      }));
      runGraphEmbeddingPipeline(this, stryMutAct_9fa48("1485") ? {} : (stryCov_9fa48("1485"), {
        onProgress: (done, total) => {
          if (stryMutAct_9fa48("1486")) {
            {}
          } else {
            stryCov_9fa48("1486");
            this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1487") ? {} : (stryCov_9fa48("1487"), {
              embed_total: total,
              embed_done: done
            }));
          }
        }
      })).then(({
        embedding,
        similarity
      }) => {
        if (stryMutAct_9fa48("1488")) {
          {}
        } else {
          stryCov_9fa48("1488");
          this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1489") ? {} : (stryCov_9fa48("1489"), {
            status: stryMutAct_9fa48("1490") ? "" : (stryCov_9fa48("1490"), 'idle'),
            phase: null,
            embed_total: embedding.total,
            embed_done: embedding.embedded
          }));
          saveScanState(this.projectDir, this.scanState);
        }
      }).catch(err => {
        if (stryMutAct_9fa48("1491")) {
          {}
        } else {
          stryCov_9fa48("1491");
          console.warn(stryMutAct_9fa48("1492") ? "" : (stryCov_9fa48("1492"), '[graph-embedder] pipeline error:'), err.message);
          this.scanState = updateScanState(this.scanState, stryMutAct_9fa48("1493") ? {} : (stryCov_9fa48("1493"), {
            status: stryMutAct_9fa48("1494") ? "" : (stryCov_9fa48("1494"), 'idle'),
            phase: null
          }));
          saveScanState(this.projectDir, this.scanState);
        }
      });
    }
  }

  // -----------------------------------------------------------------------
  // Skill Decay
  // -----------------------------------------------------------------------

  /**
   * Start a 24-hour interval that recalculates skill decay scores.
   * Also runs once at startup.
   */
  _startSkillDecayTimer() {
    if (stryMutAct_9fa48("1495")) {
      {}
    } else {
      stryCov_9fa48("1495");
      const TWENTY_FOUR_HOURS = stryMutAct_9fa48("1496") ? 24 * 60 * 60 / 1000 : (stryCov_9fa48("1496"), (stryMutAct_9fa48("1497") ? 24 * 60 / 60 : (stryCov_9fa48("1497"), (stryMutAct_9fa48("1498") ? 24 / 60 : (stryCov_9fa48("1498"), 24 * 60)) * 60)) * 1000);
      // Run once at startup (deferred so it doesn't block start)
      setTimeout(stryMutAct_9fa48("1499") ? () => undefined : (stryCov_9fa48("1499"), () => this._runSkillDecay()), 5000);
      this._skillDecayTimer = setInterval(stryMutAct_9fa48("1500") ? () => undefined : (stryCov_9fa48("1500"), () => this._runSkillDecay()), TWENTY_FOUR_HOURS);
      // Allow process to exit even if timer is pending
      if (stryMutAct_9fa48("1502") ? false : stryMutAct_9fa48("1501") ? true : (stryCov_9fa48("1501", "1502"), this._skillDecayTimer.unref)) this._skillDecayTimer.unref();
    }
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
    if (stryMutAct_9fa48("1503")) {
      {}
    } else {
      stryCov_9fa48("1503");
      if (stryMutAct_9fa48("1506") ? !this.indexer && !this.indexer.db : stryMutAct_9fa48("1505") ? false : stryMutAct_9fa48("1504") ? true : (stryCov_9fa48("1504", "1505", "1506"), (stryMutAct_9fa48("1507") ? this.indexer : (stryCov_9fa48("1507"), !this.indexer)) || (stryMutAct_9fa48("1508") ? this.indexer.db : (stryCov_9fa48("1508"), !this.indexer.db)))) return;
      try {
        if (stryMutAct_9fa48("1509")) {
          {}
        } else {
          stryCov_9fa48("1509");
          const now = Date.now();
          const skills = this.indexer.db.prepare(stryMutAct_9fa48("1510") ? "" : (stryCov_9fa48("1510"), 'SELECT id, last_used_at, usage_count, pinned FROM skills WHERE status = ?')).all(stryMutAct_9fa48("1511") ? "" : (stryCov_9fa48("1511"), 'active'));
          const update = this.indexer.db.prepare(stryMutAct_9fa48("1512") ? "" : (stryCov_9fa48("1512"), 'UPDATE skills SET decay_score = ?, updated_at = ? WHERE id = ?'));
          const nowISO_ = new Date(now).toISOString();
          const LN_20 = Math.log(20);
          const HALF_LIFE_DAYS = 30;
          const LAMBDA = stryMutAct_9fa48("1513") ? 0.693 * HALF_LIFE_DAYS : (stryCov_9fa48("1513"), 0.693 / HALF_LIFE_DAYS); // ln(2) / half-life

          const batch = this.indexer.db.transaction(() => {
            if (stryMutAct_9fa48("1514")) {
              {}
            } else {
              stryCov_9fa48("1514");
              for (const skill of skills) {
                if (stryMutAct_9fa48("1515")) {
                  {}
                } else {
                  stryCov_9fa48("1515");
                  if (stryMutAct_9fa48("1517") ? false : stryMutAct_9fa48("1516") ? true : (stryCov_9fa48("1516", "1517"), skill.pinned)) {
                    if (stryMutAct_9fa48("1518")) {
                      {}
                    } else {
                      stryCov_9fa48("1518");
                      update.run(1.0, nowISO_, skill.id);
                      continue;
                    }
                  }
                  const lastUsed = skill.last_used_at ? new Date(skill.last_used_at).getTime() : now;
                  const daysSince = stryMutAct_9fa48("1519") ? (now - lastUsed) * (1000 * 60 * 60 * 24) : (stryCov_9fa48("1519"), (stryMutAct_9fa48("1520") ? now + lastUsed : (stryCov_9fa48("1520"), now - lastUsed)) / (stryMutAct_9fa48("1521") ? 1000 * 60 * 60 / 24 : (stryCov_9fa48("1521"), (stryMutAct_9fa48("1522") ? 1000 * 60 / 60 : (stryCov_9fa48("1522"), (stryMutAct_9fa48("1523") ? 1000 / 60 : (stryCov_9fa48("1523"), 1000 * 60)) * 60)) * 24)));
                  const baseDecay = Math.exp(stryMutAct_9fa48("1524") ? -LAMBDA / daysSince : (stryCov_9fa48("1524"), (stryMutAct_9fa48("1525") ? +LAMBDA : (stryCov_9fa48("1525"), -LAMBDA)) * daysSince));
                  const usageBoost = stryMutAct_9fa48("1526") ? Math.log((skill.usage_count || 0) + 1) * LN_20 : (stryCov_9fa48("1526"), Math.log(stryMutAct_9fa48("1527") ? (skill.usage_count || 0) - 1 : (stryCov_9fa48("1527"), (stryMutAct_9fa48("1530") ? skill.usage_count && 0 : stryMutAct_9fa48("1529") ? false : stryMutAct_9fa48("1528") ? true : (stryCov_9fa48("1528", "1529", "1530"), skill.usage_count || 0)) + 1)) / LN_20);
                  const score = stryMutAct_9fa48("1531") ? Math.max(1.0, baseDecay + usageBoost) : (stryCov_9fa48("1531"), Math.min(1.0, stryMutAct_9fa48("1532") ? baseDecay - usageBoost : (stryCov_9fa48("1532"), baseDecay + usageBoost)));
                  update.run(stryMutAct_9fa48("1533") ? Math.round(score * 1000) * 1000 : (stryCov_9fa48("1533"), Math.round(stryMutAct_9fa48("1534") ? score / 1000 : (stryCov_9fa48("1534"), score * 1000)) / 1000), nowISO_, skill.id);
                }
              }
            }
          });
          batch();
          if (stryMutAct_9fa48("1538") ? skills.length <= 0 : stryMutAct_9fa48("1537") ? skills.length >= 0 : stryMutAct_9fa48("1536") ? false : stryMutAct_9fa48("1535") ? true : (stryCov_9fa48("1535", "1536", "1537", "1538"), skills.length > 0)) {
            if (stryMutAct_9fa48("1539")) {
              {}
            } else {
              stryCov_9fa48("1539");
              console.log(stryMutAct_9fa48("1540") ? `` : (stryCov_9fa48("1540"), `[awareness-local] skill decay: updated ${skills.length} skills`));
            }
          }
        }
      } catch (err) {
        if (stryMutAct_9fa48("1541")) {
          {}
        } else {
          stryCov_9fa48("1541");
          console.error(stryMutAct_9fa48("1542") ? "" : (stryCov_9fa48("1542"), '[awareness-local] skill decay error:'), err.message);
        }
      }
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
    if (stryMutAct_9fa48("1543")) {
      {}
    } else {
      stryCov_9fa48("1543");
      if (stryMutAct_9fa48("1546") ? false : stryMutAct_9fa48("1545") ? true : stryMutAct_9fa48("1544") ? fs.existsSync(newProjectDir) : (stryCov_9fa48("1544", "1545", "1546"), !fs.existsSync(newProjectDir))) {
        if (stryMutAct_9fa48("1547")) {
          {}
        } else {
          stryCov_9fa48("1547");
          throw new Error(stryMutAct_9fa48("1548") ? `` : (stryCov_9fa48("1548"), `Project directory does not exist: ${newProjectDir}`));
        }
      }
      this._switching = stryMutAct_9fa48("1549") ? false : (stryCov_9fa48("1549"), true);
      try {
        if (stryMutAct_9fa48("1550")) {
          {}
        } else {
          stryCov_9fa48("1550");
          const newAwarenessDir = path.join(newProjectDir, AWARENESS_DIR);
          console.log(stryMutAct_9fa48("1551") ? `` : (stryCov_9fa48("1551"), `[awareness-local] switching project: ${this.projectDir} → ${newProjectDir}`));

          // 1. Stop watchers & timers
          if (stryMutAct_9fa48("1553") ? false : stryMutAct_9fa48("1552") ? true : (stryCov_9fa48("1552", "1553"), this.watcher)) {
            if (stryMutAct_9fa48("1554")) {
              {}
            } else {
              stryCov_9fa48("1554");
              this.watcher.close();
              this.watcher = null;
            }
          }
          if (stryMutAct_9fa48("1556") ? false : stryMutAct_9fa48("1555") ? true : (stryCov_9fa48("1555", "1556"), this._reindexTimer)) {
            if (stryMutAct_9fa48("1557")) {
              {}
            } else {
              stryCov_9fa48("1557");
              clearTimeout(this._reindexTimer);
              this._reindexTimer = null;
            }
          }
          if (stryMutAct_9fa48("1559") ? false : stryMutAct_9fa48("1558") ? true : (stryCov_9fa48("1558", "1559"), this.cloudSync)) {
            if (stryMutAct_9fa48("1560")) {
              {}
            } else {
              stryCov_9fa48("1560");
              this.cloudSync.stop();
              this.cloudSync = null;
            }
          }

          // 2. Close old indexer
          if (stryMutAct_9fa48("1563") ? this.indexer || this.indexer.close : stryMutAct_9fa48("1562") ? false : stryMutAct_9fa48("1561") ? true : (stryCov_9fa48("1561", "1562", "1563"), this.indexer && this.indexer.close)) {
            if (stryMutAct_9fa48("1564")) {
              {}
            } else {
              stryCov_9fa48("1564");
              this.indexer.close();
            }
          }

          // 3. Update project paths
          this.projectDir = newProjectDir;
          this.guardProfile = detectGuardProfile(this.projectDir);
          this.awarenessDir = newAwarenessDir;
          this.pidFile = path.join(this.awarenessDir, PID_FILENAME);
          this.logFile = path.join(this.awarenessDir, LOG_FILENAME);

          // 4. Ensure directory structure
          fs.mkdirSync(path.join(this.awarenessDir, stryMutAct_9fa48("1565") ? "" : (stryCov_9fa48("1565"), 'memories')), stryMutAct_9fa48("1566") ? {} : (stryCov_9fa48("1566"), {
            recursive: stryMutAct_9fa48("1567") ? false : (stryCov_9fa48("1567"), true)
          }));
          fs.mkdirSync(path.join(this.awarenessDir, stryMutAct_9fa48("1568") ? "" : (stryCov_9fa48("1568"), 'knowledge')), stryMutAct_9fa48("1569") ? {} : (stryCov_9fa48("1569"), {
            recursive: stryMutAct_9fa48("1570") ? false : (stryCov_9fa48("1570"), true)
          }));
          fs.mkdirSync(path.join(this.awarenessDir, stryMutAct_9fa48("1571") ? "" : (stryCov_9fa48("1571"), 'tasks')), stryMutAct_9fa48("1572") ? {} : (stryCov_9fa48("1572"), {
            recursive: stryMutAct_9fa48("1573") ? false : (stryCov_9fa48("1573"), true)
          }));

          // 5. Re-init core modules
          this.memoryStore = new MemoryStore(this.projectDir);
          try {
            if (stryMutAct_9fa48("1574")) {
              {}
            } else {
              stryCov_9fa48("1574");
              this.indexer = new Indexer(path.join(this.awarenessDir, stryMutAct_9fa48("1575") ? "" : (stryCov_9fa48("1575"), 'index.db')));
            }
          } catch (e) {
            if (stryMutAct_9fa48("1576")) {
              {}
            } else {
              stryCov_9fa48("1576");
              console.error(stryMutAct_9fa48("1577") ? `` : (stryCov_9fa48("1577"), `[awareness-local] SQLite indexer unavailable after switch: ${e.message}`));
              this.indexer = createNoopIndexer();
            }
          }
          this.search = await this._loadSearchEngine();
          this.extractor = await this._loadKnowledgeExtractor();

          // 6. Incremental index
          try {
            if (stryMutAct_9fa48("1578")) {
              {}
            } else {
              stryCov_9fa48("1578");
              const result = await this.indexer.incrementalIndex(this.memoryStore);
              console.log(stryMutAct_9fa48("1579") ? `` : (stryCov_9fa48("1579"), `[awareness-local] re-indexed: ${result.indexed} files, ${result.skipped} skipped`));
            }
          } catch (err) {
            if (stryMutAct_9fa48("1580")) {
              {}
            } else {
              stryCov_9fa48("1580");
              console.error(stryMutAct_9fa48("1581") ? "" : (stryCov_9fa48("1581"), '[awareness-local] re-index error:'), err.message);
            }
          }

          // 7. Restart cloud sync if configured
          const config = this._loadConfig();
          if (stryMutAct_9fa48("1584") ? config.cloud.enabled : stryMutAct_9fa48("1583") ? false : stryMutAct_9fa48("1582") ? true : (stryCov_9fa48("1582", "1583", "1584"), config.cloud?.enabled)) {
            if (stryMutAct_9fa48("1585")) {
              {}
            } else {
              stryCov_9fa48("1585");
              try {
                if (stryMutAct_9fa48("1586")) {
                  {}
                } else {
                  stryCov_9fa48("1586");
                  const {
                    CloudSync
                  } = await import('./core/cloud-sync.mjs');
                  this.cloudSync = new CloudSync(config, this.indexer, this.memoryStore);
                  this.cloudSync.start().catch(() => {});
                }
              } catch {/* CloudSync not available */}
            }
          }

          // 8. Update workspace registry
          try {
            if (stryMutAct_9fa48("1587")) {
              {}
            } else {
              stryCov_9fa48("1587");
              const {
                registerWorkspace
              } = await import('./core/config.mjs');
              registerWorkspace(newProjectDir, stryMutAct_9fa48("1588") ? {} : (stryCov_9fa48("1588"), {
                port: this.port
              }));
            }
          } catch {/* config.mjs not available */}
          console.log(stryMutAct_9fa48("1589") ? `` : (stryCov_9fa48("1589"), `[awareness-local] switched to: ${newProjectDir} (${this.indexer.getStats().totalMemories} memories)`));
          return stryMutAct_9fa48("1590") ? {} : (stryCov_9fa48("1590"), {
            projectDir: newProjectDir,
            stats: this.indexer.getStats()
          });
        }
      } finally {
        if (stryMutAct_9fa48("1591")) {
          {}
        } else {
          stryCov_9fa48("1591");
          this._switching = stryMutAct_9fa48("1592") ? true : (stryCov_9fa48("1592"), false);
        }
      }
    }
  }

  /** Load .awareness/config.json (or return defaults). */
  _loadConfig() {
    if (stryMutAct_9fa48("1593")) {
      {}
    } else {
      stryCov_9fa48("1593");
      return loadDaemonConfig(stryMutAct_9fa48("1594") ? {} : (stryCov_9fa48("1594"), {
        awarenessDir: this.awarenessDir,
        port: this.port
      }));
    }
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
    if (stryMutAct_9fa48("1595")) {
      {}
    } else {
      stryCov_9fa48("1595");
      try {
        if (stryMutAct_9fa48("1596")) {
          {}
        } else {
          stryCov_9fa48("1596");
          const match = errMsg.match(stryMutAct_9fa48("1598") ? /The module '(.+?better-sqlite3.\.node)'/ : stryMutAct_9fa48("1597") ? /The module '(.better-sqlite3.+?\.node)'/ : (stryCov_9fa48("1597", "1598"), /The module '(.+?better-sqlite3.+?\.node)'/));
          if (stryMutAct_9fa48("1601") ? false : stryMutAct_9fa48("1600") ? true : stryMutAct_9fa48("1599") ? match : (stryCov_9fa48("1599", "1600", "1601"), !match)) return stryMutAct_9fa48("1602") ? true : (stryCov_9fa48("1602"), false);
          const moduleDir = match[1].split(stryMutAct_9fa48("1603") ? "" : (stryCov_9fa48("1603"), '/build/'))[0];
          const {
            execSync
          } = await import('node:child_process');
          console.log(stryMutAct_9fa48("1604") ? `` : (stryCov_9fa48("1604"), `[awareness-local] Node.js version changed — auto-rebuilding better-sqlite3 for ${process.version}...`));
          execSync(stryMutAct_9fa48("1605") ? "" : (stryCov_9fa48("1605"), 'npm rebuild'), stryMutAct_9fa48("1606") ? {} : (stryCov_9fa48("1606"), {
            cwd: moduleDir,
            stdio: stryMutAct_9fa48("1607") ? "" : (stryCov_9fa48("1607"), 'pipe')
          }));
          console.log(stryMutAct_9fa48("1608") ? "" : (stryCov_9fa48("1608"), '[awareness-local] better-sqlite3 rebuilt successfully'));
          return stryMutAct_9fa48("1609") ? false : (stryCov_9fa48("1609"), true);
        }
      } catch (rebuildErr) {
        if (stryMutAct_9fa48("1610")) {
          {}
        } else {
          stryCov_9fa48("1610");
          console.error(stryMutAct_9fa48("1611") ? `` : (stryCov_9fa48("1611"), `[awareness-local] Auto-rebuild failed: ${rebuildErr.message}`));
          console.error(stryMutAct_9fa48("1612") ? "" : (stryCov_9fa48("1612"), '[awareness-local] Falling back to file-only mode (no search)'));
          return stryMutAct_9fa48("1613") ? true : (stryCov_9fa48("1613"), false);
        }
      }
    }
  }

  /** Load awareness-spec.json from the bundled spec directory. */
  _loadSpec() {
    if (stryMutAct_9fa48("1614")) {
      {}
    } else {
      stryCov_9fa48("1614");
      return loadDaemonSpec(import.meta.url);
    }
  }

  // -----------------------------------------------------------------------
  // Dynamic module loading
  // -----------------------------------------------------------------------

  /**
   * Lazy-load the embedder module (shared by SearchEngine + KnowledgeExtractor).
   * Caches at this._embedder. Returns null when unavailable (graceful degradation).
   */
  async _loadEmbedder() {
    if (stryMutAct_9fa48("1615")) {
      {}
    } else {
      stryCov_9fa48("1615");
      this._embedder = await loadEmbedderModule(stryMutAct_9fa48("1616") ? {} : (stryCov_9fa48("1616"), {
        importMetaUrl: import.meta.url,
        cachedEmbedder: this._embedder
      }));
      return this._embedder;
    }
  }

  /** Try to load SearchEngine from Phase 1 core. Returns null if not available. */
  async _loadSearchEngine() {
    if (stryMutAct_9fa48("1617")) {
      {}
    } else {
      stryCov_9fa48("1617");
      return loadSearchEngineModule(stryMutAct_9fa48("1618") ? {} : (stryCov_9fa48("1618"), {
        importMetaUrl: import.meta.url,
        indexer: this.indexer,
        memoryStore: this.memoryStore,
        loadEmbedder: stryMutAct_9fa48("1619") ? () => undefined : (stryCov_9fa48("1619"), () => this._loadEmbedder())
      }));
    }
  }

  /** Try to load KnowledgeExtractor from Phase 1 core. Returns null if not available. */
  async _loadKnowledgeExtractor() {
    if (stryMutAct_9fa48("1620")) {
      {}
    } else {
      stryCov_9fa48("1620");
      return loadKnowledgeExtractorModule(stryMutAct_9fa48("1621") ? {} : (stryCov_9fa48("1621"), {
        importMetaUrl: import.meta.url,
        memoryStore: this.memoryStore,
        indexer: this.indexer,
        loadEmbedder: stryMutAct_9fa48("1622") ? () => undefined : (stryCov_9fa48("1622"), () => this._loadEmbedder())
      }));
    }
  }

  // -----------------------------------------------------------------------
  // LLM-assisted MOC title refinement (fire-and-forget)
  // -----------------------------------------------------------------------

  /**
   * Attempt to refine newly created MOC card titles using LLM.
   * Uses cloud API inference if cloud sync is enabled, otherwise skips silently.
   */
  async _refineMocTitles(mocIds) {
    if (stryMutAct_9fa48("1623")) {
      {}
    } else {
      stryCov_9fa48("1623");
      const config = this._loadConfig();
      if (stryMutAct_9fa48("1626") ? !config.cloud?.enabled && !config.cloud?.api_key : stryMutAct_9fa48("1625") ? false : stryMutAct_9fa48("1624") ? true : (stryCov_9fa48("1624", "1625", "1626"), (stryMutAct_9fa48("1627") ? config.cloud?.enabled : (stryCov_9fa48("1627"), !(stryMutAct_9fa48("1628") ? config.cloud.enabled : (stryCov_9fa48("1628"), config.cloud?.enabled)))) || (stryMutAct_9fa48("1629") ? config.cloud?.api_key : (stryCov_9fa48("1629"), !(stryMutAct_9fa48("1630") ? config.cloud.api_key : (stryCov_9fa48("1630"), config.cloud?.api_key)))))) return;
      const apiBase = stryMutAct_9fa48("1633") ? config.cloud.api_base && 'https://awareness.market/api/v1' : stryMutAct_9fa48("1632") ? false : stryMutAct_9fa48("1631") ? true : (stryCov_9fa48("1631", "1632", "1633"), config.cloud.api_base || (stryMutAct_9fa48("1634") ? "" : (stryCov_9fa48("1634"), 'https://awareness.market/api/v1')));
      const memoryId = config.cloud.memory_id;
      const apiKey = config.cloud.api_key;

      // Simple LLM inference via cloud API's chat endpoint
      const llmInfer = async (systemPrompt, userContent) => {
        if (stryMutAct_9fa48("1635")) {
          {}
        } else {
          stryCov_9fa48("1635");
          const {
            httpJson
          } = await import('./daemon/cloud-http.mjs');
          const resp = await httpJson(stryMutAct_9fa48("1636") ? "" : (stryCov_9fa48("1636"), 'POST'), stryMutAct_9fa48("1637") ? `` : (stryCov_9fa48("1637"), `${apiBase}/memories/${memoryId}/chat`), stryMutAct_9fa48("1638") ? {} : (stryCov_9fa48("1638"), {
            messages: stryMutAct_9fa48("1639") ? [] : (stryCov_9fa48("1639"), [stryMutAct_9fa48("1640") ? {} : (stryCov_9fa48("1640"), {
              role: stryMutAct_9fa48("1641") ? "" : (stryCov_9fa48("1641"), 'system'),
              content: systemPrompt
            }), stryMutAct_9fa48("1642") ? {} : (stryCov_9fa48("1642"), {
              role: stryMutAct_9fa48("1643") ? "" : (stryCov_9fa48("1643"), 'user'),
              content: userContent
            })]),
            max_tokens: 200
          }), stryMutAct_9fa48("1644") ? {} : (stryCov_9fa48("1644"), {
            Authorization: stryMutAct_9fa48("1645") ? `` : (stryCov_9fa48("1645"), `Bearer ${apiKey}`)
          }));
          // The chat endpoint may return different formats
          if (stryMutAct_9fa48("1648") ? typeof resp !== 'string' : stryMutAct_9fa48("1647") ? false : stryMutAct_9fa48("1646") ? true : (stryCov_9fa48("1646", "1647", "1648"), typeof resp === (stryMutAct_9fa48("1649") ? "" : (stryCov_9fa48("1649"), 'string')))) return resp;
          return stryMutAct_9fa48("1652") ? (resp?.content || resp?.choices?.[0]?.message?.content) && JSON.stringify(resp) : stryMutAct_9fa48("1651") ? false : stryMutAct_9fa48("1650") ? true : (stryCov_9fa48("1650", "1651", "1652"), (stryMutAct_9fa48("1654") ? resp?.content && resp?.choices?.[0]?.message?.content : stryMutAct_9fa48("1653") ? false : (stryCov_9fa48("1653", "1654"), (stryMutAct_9fa48("1655") ? resp.content : (stryCov_9fa48("1655"), resp?.content)) || (stryMutAct_9fa48("1659") ? resp.choices?.[0]?.message?.content : stryMutAct_9fa48("1658") ? resp?.choices[0]?.message?.content : stryMutAct_9fa48("1657") ? resp?.choices?.[0].message?.content : stryMutAct_9fa48("1656") ? resp?.choices?.[0]?.message.content : (stryCov_9fa48("1656", "1657", "1658", "1659"), resp?.choices?.[0]?.message?.content)))) || JSON.stringify(resp));
        }
      };
      for (const mocId of mocIds) {
        if (stryMutAct_9fa48("1660")) {
          {}
        } else {
          stryCov_9fa48("1660");
          try {
            if (stryMutAct_9fa48("1661")) {
              {}
            } else {
              stryCov_9fa48("1661");
              await this.indexer.refineMocWithLlm(mocId, llmInfer);
            }
          } catch (err) {
            if (stryMutAct_9fa48("1662")) {
              {}
            } else {
              stryCov_9fa48("1662");
              // Non-fatal — tag-based title remains
              if (stryMutAct_9fa48("1664") ? false : stryMutAct_9fa48("1663") ? true : (stryCov_9fa48("1663", "1664"), process.env.DEBUG)) {
                if (stryMutAct_9fa48("1665")) {
                  {}
                } else {
                  stryCov_9fa48("1665");
                  console.warn(stryMutAct_9fa48("1666") ? `` : (stryCov_9fa48("1666"), `[awareness-local] MOC LLM refine failed for ${mocId}: ${err.message}`));
                }
              }
            }
          }
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
    if (stryMutAct_9fa48("1667")) {
      {}
    } else {
      stryCov_9fa48("1667");
      // Rate limit: 1 check per memory per 60s
      const now = Date.now();
      if (stryMutAct_9fa48("1670") ? false : stryMutAct_9fa48("1669") ? true : stryMutAct_9fa48("1668") ? this._lastResolveCheckAt : (stryCov_9fa48("1668", "1669", "1670"), !this._lastResolveCheckAt)) this._lastResolveCheckAt = 0;
      if (stryMutAct_9fa48("1674") ? now - this._lastResolveCheckAt >= 60000 : stryMutAct_9fa48("1673") ? now - this._lastResolveCheckAt <= 60000 : stryMutAct_9fa48("1672") ? false : stryMutAct_9fa48("1671") ? true : (stryCov_9fa48("1671", "1672", "1673", "1674"), (stryMutAct_9fa48("1675") ? now + this._lastResolveCheckAt : (stryCov_9fa48("1675"), now - this._lastResolveCheckAt)) < 60000)) return;
      this._lastResolveCheckAt = now;

      // Only if cloud is enabled (we route LLM calls through cloud API)
      const config = this._loadConfig();
      if (stryMutAct_9fa48("1678") ? !config.cloud?.enabled && !config.cloud?.api_key : stryMutAct_9fa48("1677") ? false : stryMutAct_9fa48("1676") ? true : (stryCov_9fa48("1676", "1677", "1678"), (stryMutAct_9fa48("1679") ? config.cloud?.enabled : (stryCov_9fa48("1679"), !(stryMutAct_9fa48("1680") ? config.cloud.enabled : (stryCov_9fa48("1680"), config.cloud?.enabled)))) || (stryMutAct_9fa48("1681") ? config.cloud?.api_key : (stryCov_9fa48("1681"), !(stryMutAct_9fa48("1682") ? config.cloud.api_key : (stryCov_9fa48("1682"), config.cloud?.api_key)))))) return;

      // Fetch active perceptions that support auto-resolution
      if (stryMutAct_9fa48("1685") ? false : stryMutAct_9fa48("1684") ? true : stryMutAct_9fa48("1683") ? this.indexer?.listPerceptionStates : (stryCov_9fa48("1683", "1684", "1685"), !(stryMutAct_9fa48("1686") ? this.indexer.listPerceptionStates : (stryCov_9fa48("1686"), this.indexer?.listPerceptionStates)))) return;
      const activeStates = this.indexer.listPerceptionStates(stryMutAct_9fa48("1687") ? {} : (stryCov_9fa48("1687"), {
        state: stryMutAct_9fa48("1688") ? [] : (stryCov_9fa48("1688"), [stryMutAct_9fa48("1689") ? "" : (stryCov_9fa48("1689"), 'active'), stryMutAct_9fa48("1690") ? "" : (stryCov_9fa48("1690"), 'snoozed')]),
        limit: 50
      }));
      const candidates = stryMutAct_9fa48("1691") ? activeStates : (stryCov_9fa48("1691"), activeStates.filter(stryMutAct_9fa48("1692") ? () => undefined : (stryCov_9fa48("1692"), s => (stryMutAct_9fa48("1693") ? [] : (stryCov_9fa48("1693"), [stryMutAct_9fa48("1694") ? "" : (stryCov_9fa48("1694"), 'guard'), stryMutAct_9fa48("1695") ? "" : (stryCov_9fa48("1695"), 'contradiction'), stryMutAct_9fa48("1696") ? "" : (stryCov_9fa48("1696"), 'pattern'), stryMutAct_9fa48("1697") ? "" : (stryCov_9fa48("1697"), 'staleness')])).includes(s.signal_type))));
      if (stryMutAct_9fa48("1700") ? candidates.length !== 0 : stryMutAct_9fa48("1699") ? false : stryMutAct_9fa48("1698") ? true : (stryCov_9fa48("1698", "1699", "1700"), candidates.length === 0)) return;

      // Pre-filter: only signals with tag/keyword/source_card overlap with new memory
      const memTags = new Set((stryMutAct_9fa48("1703") ? newMemory.tags && [] : stryMutAct_9fa48("1702") ? false : stryMutAct_9fa48("1701") ? true : (stryCov_9fa48("1701", "1702", "1703"), newMemory.tags || (stryMutAct_9fa48("1704") ? ["Stryker was here"] : (stryCov_9fa48("1704"), [])))).map(stryMutAct_9fa48("1705") ? () => undefined : (stryCov_9fa48("1705"), t => stryMutAct_9fa48("1706") ? String(t).toUpperCase() : (stryCov_9fa48("1706"), String(t).toLowerCase()))));
      const memText = stryMutAct_9fa48("1707") ? `${newMemory.title || ''} ${newMemory.content || ''}`.toUpperCase() : (stryCov_9fa48("1707"), (stryMutAct_9fa48("1708") ? `` : (stryCov_9fa48("1708"), `${stryMutAct_9fa48("1711") ? newMemory.title && '' : stryMutAct_9fa48("1710") ? false : stryMutAct_9fa48("1709") ? true : (stryCov_9fa48("1709", "1710", "1711"), newMemory.title || (stryMutAct_9fa48("1712") ? "Stryker was here!" : (stryCov_9fa48("1712"), '')))} ${stryMutAct_9fa48("1715") ? newMemory.content && '' : stryMutAct_9fa48("1714") ? false : stryMutAct_9fa48("1713") ? true : (stryCov_9fa48("1713", "1714", "1715"), newMemory.content || (stryMutAct_9fa48("1716") ? "Stryker was here!" : (stryCov_9fa48("1716"), '')))}`)).toLowerCase());
      const newCategory = stryMutAct_9fa48("1719") ? newMemory.insights.knowledge_cards?.[0]?.category : stryMutAct_9fa48("1718") ? newMemory.insights?.knowledge_cards[0]?.category : stryMutAct_9fa48("1717") ? newMemory.insights?.knowledge_cards?.[0].category : (stryCov_9fa48("1717", "1718", "1719"), newMemory.insights?.knowledge_cards?.[0]?.category);
      const isFixCategory = (stryMutAct_9fa48("1720") ? [] : (stryCov_9fa48("1720"), [stryMutAct_9fa48("1721") ? "" : (stryCov_9fa48("1721"), 'problem_solution'), stryMutAct_9fa48("1722") ? "" : (stryCov_9fa48("1722"), 'decision')])).includes(newCategory);
      if (stryMutAct_9fa48("1725") ? !isFixCategory || newCategory : stryMutAct_9fa48("1724") ? false : stryMutAct_9fa48("1723") ? true : (stryCov_9fa48("1723", "1724", "1725"), (stryMutAct_9fa48("1726") ? isFixCategory : (stryCov_9fa48("1726"), !isFixCategory)) && newCategory)) return; // Only problem_solution/decision/null can resolve

      const filtered = stryMutAct_9fa48("1727") ? candidates : (stryCov_9fa48("1727"), candidates.filter(sig => {
        if (stryMutAct_9fa48("1728")) {
          {}
        } else {
          stryCov_9fa48("1728");
          // Check tag overlap (signal metadata may have tags)
          let sigTags = stryMutAct_9fa48("1729") ? ["Stryker was here"] : (stryCov_9fa48("1729"), []);
          try {
            if (stryMutAct_9fa48("1730")) {
              {}
            } else {
              stryCov_9fa48("1730");
              sigTags = stryMutAct_9fa48("1733") ? JSON.parse(sig.metadata || '{}').tags && [] : stryMutAct_9fa48("1732") ? false : stryMutAct_9fa48("1731") ? true : (stryCov_9fa48("1731", "1732", "1733"), JSON.parse(stryMutAct_9fa48("1736") ? sig.metadata && '{}' : stryMutAct_9fa48("1735") ? false : stryMutAct_9fa48("1734") ? true : (stryCov_9fa48("1734", "1735", "1736"), sig.metadata || (stryMutAct_9fa48("1737") ? "" : (stryCov_9fa48("1737"), '{}')))).tags || (stryMutAct_9fa48("1738") ? ["Stryker was here"] : (stryCov_9fa48("1738"), [])));
            }
          } catch {}
          const hasTagOverlap = stryMutAct_9fa48("1739") ? sigTags.every(t => memTags.has(String(t).toLowerCase())) : (stryCov_9fa48("1739"), sigTags.some(stryMutAct_9fa48("1740") ? () => undefined : (stryCov_9fa48("1740"), t => memTags.has(stryMutAct_9fa48("1741") ? String(t).toUpperCase() : (stryCov_9fa48("1741"), String(t).toLowerCase())))));

          // Check keyword mention in title
          const sigWords = stryMutAct_9fa48("1743") ? (sig.title || '').toUpperCase().split(/\s+/).filter(w => w.length > 3) : stryMutAct_9fa48("1742") ? (sig.title || '').toLowerCase().split(/\s+/) : (stryCov_9fa48("1742", "1743"), (stryMutAct_9fa48("1746") ? sig.title && '' : stryMutAct_9fa48("1745") ? false : stryMutAct_9fa48("1744") ? true : (stryCov_9fa48("1744", "1745", "1746"), sig.title || (stryMutAct_9fa48("1747") ? "Stryker was here!" : (stryCov_9fa48("1747"), '')))).toLowerCase().split(stryMutAct_9fa48("1749") ? /\S+/ : stryMutAct_9fa48("1748") ? /\s/ : (stryCov_9fa48("1748", "1749"), /\s+/)).filter(stryMutAct_9fa48("1750") ? () => undefined : (stryCov_9fa48("1750"), w => stryMutAct_9fa48("1754") ? w.length <= 3 : stryMutAct_9fa48("1753") ? w.length >= 3 : stryMutAct_9fa48("1752") ? false : stryMutAct_9fa48("1751") ? true : (stryCov_9fa48("1751", "1752", "1753", "1754"), w.length > 3))));
          const hasKeyword = stryMutAct_9fa48("1755") ? sigWords.every(w => memText.includes(w)) : (stryCov_9fa48("1755"), sigWords.some(stryMutAct_9fa48("1756") ? () => undefined : (stryCov_9fa48("1756"), w => memText.includes(w))));

          // Check source card reference
          const sourceMemories = stryMutAct_9fa48("1759") ? newMemory.insights?.knowledge_cards?.[0]?.source_memories && [] : stryMutAct_9fa48("1758") ? false : stryMutAct_9fa48("1757") ? true : (stryCov_9fa48("1757", "1758", "1759"), (stryMutAct_9fa48("1762") ? newMemory.insights.knowledge_cards?.[0]?.source_memories : stryMutAct_9fa48("1761") ? newMemory.insights?.knowledge_cards[0]?.source_memories : stryMutAct_9fa48("1760") ? newMemory.insights?.knowledge_cards?.[0].source_memories : (stryCov_9fa48("1760", "1761", "1762"), newMemory.insights?.knowledge_cards?.[0]?.source_memories)) || (stryMutAct_9fa48("1763") ? ["Stryker was here"] : (stryCov_9fa48("1763"), [])));
          const refsSourceCard = stryMutAct_9fa48("1766") ? sig.source_card_id || sourceMemories.includes(sig.source_card_id) : stryMutAct_9fa48("1765") ? false : stryMutAct_9fa48("1764") ? true : (stryCov_9fa48("1764", "1765", "1766"), sig.source_card_id && sourceMemories.includes(sig.source_card_id));
          return stryMutAct_9fa48("1769") ? (hasTagOverlap || hasKeyword) && refsSourceCard : stryMutAct_9fa48("1768") ? false : stryMutAct_9fa48("1767") ? true : (stryCov_9fa48("1767", "1768", "1769"), (stryMutAct_9fa48("1771") ? hasTagOverlap && hasKeyword : stryMutAct_9fa48("1770") ? false : (stryCov_9fa48("1770", "1771"), hasTagOverlap || hasKeyword)) || refsSourceCard);
        }
      }));
      if (stryMutAct_9fa48("1774") ? filtered.length !== 0 : stryMutAct_9fa48("1773") ? false : stryMutAct_9fa48("1772") ? true : (stryCov_9fa48("1772", "1773", "1774"), filtered.length === 0)) return;

      // Build batch prompt
      const systemPrompt = stryMutAct_9fa48("1775") ? `` : (stryCov_9fa48("1775"), `You are analyzing whether a new memory resolves previously-flagged awareness signals.

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

Return JSON only: {"results": [{"signal_id":"...","status":"resolved|irrelevant|still_active","reason":"..."}]}`);
      const userContent = stryMutAct_9fa48("1776") ? `` : (stryCov_9fa48("1776"), `NEW MEMORY:
Title: ${stryMutAct_9fa48("1779") ? newMemory.title && '(no title)' : stryMutAct_9fa48("1778") ? false : stryMutAct_9fa48("1777") ? true : (stryCov_9fa48("1777", "1778", "1779"), newMemory.title || (stryMutAct_9fa48("1780") ? "" : (stryCov_9fa48("1780"), '(no title)')))}
Content: ${stryMutAct_9fa48("1781") ? newMemory.content || '' : (stryCov_9fa48("1781"), (stryMutAct_9fa48("1784") ? newMemory.content && '' : stryMutAct_9fa48("1783") ? false : stryMutAct_9fa48("1782") ? true : (stryCov_9fa48("1782", "1783", "1784"), newMemory.content || (stryMutAct_9fa48("1785") ? "Stryker was here!" : (stryCov_9fa48("1785"), '')))).slice(0, 500))}
Tags: ${stryMutAct_9fa48("1788") ? [...memTags].join(', ') && '(none)' : stryMutAct_9fa48("1787") ? false : stryMutAct_9fa48("1786") ? true : (stryCov_9fa48("1786", "1787", "1788"), (stryMutAct_9fa48("1789") ? [] : (stryCov_9fa48("1789"), [...memTags])).join(stryMutAct_9fa48("1790") ? "" : (stryCov_9fa48("1790"), ', ')) || (stryMutAct_9fa48("1791") ? "" : (stryCov_9fa48("1791"), '(none)')))}

SIGNALS TO CHECK:
${filtered.map(stryMutAct_9fa48("1792") ? () => undefined : (stryCov_9fa48("1792"), s => stryMutAct_9fa48("1793") ? `` : (stryCov_9fa48("1793"), `[${s.signal_id}] (${s.signal_type}) ${stryMutAct_9fa48("1796") ? s.title && s.signal_id : stryMutAct_9fa48("1795") ? false : stryMutAct_9fa48("1794") ? true : (stryCov_9fa48("1794", "1795", "1796"), s.title || s.signal_id)}`))).join(stryMutAct_9fa48("1797") ? "" : (stryCov_9fa48("1797"), '\n'))}`);
      try {
        if (stryMutAct_9fa48("1798")) {
          {}
        } else {
          stryCov_9fa48("1798");
          const {
            httpJson
          } = await import('./daemon/cloud-http.mjs');
          const apiBase = stryMutAct_9fa48("1801") ? config.cloud.api_base && 'https://awareness.market/api/v1' : stryMutAct_9fa48("1800") ? false : stryMutAct_9fa48("1799") ? true : (stryCov_9fa48("1799", "1800", "1801"), config.cloud.api_base || (stryMutAct_9fa48("1802") ? "" : (stryCov_9fa48("1802"), 'https://awareness.market/api/v1')));
          const memoryId = config.cloud.memory_id;
          const apiKey = config.cloud.api_key;
          const resp = await httpJson(stryMutAct_9fa48("1803") ? "" : (stryCov_9fa48("1803"), 'POST'), stryMutAct_9fa48("1804") ? `` : (stryCov_9fa48("1804"), `${apiBase}/memories/${memoryId}/chat`), stryMutAct_9fa48("1805") ? {} : (stryCov_9fa48("1805"), {
            messages: stryMutAct_9fa48("1806") ? [] : (stryCov_9fa48("1806"), [stryMutAct_9fa48("1807") ? {} : (stryCov_9fa48("1807"), {
              role: stryMutAct_9fa48("1808") ? "" : (stryCov_9fa48("1808"), 'system'),
              content: systemPrompt
            }), stryMutAct_9fa48("1809") ? {} : (stryCov_9fa48("1809"), {
              role: stryMutAct_9fa48("1810") ? "" : (stryCov_9fa48("1810"), 'user'),
              content: userContent
            })]),
            max_tokens: 500
          }), stryMutAct_9fa48("1811") ? {} : (stryCov_9fa48("1811"), {
            Authorization: stryMutAct_9fa48("1812") ? `` : (stryCov_9fa48("1812"), `Bearer ${apiKey}`)
          }));
          const raw = (stryMutAct_9fa48("1815") ? typeof resp !== 'string' : stryMutAct_9fa48("1814") ? false : stryMutAct_9fa48("1813") ? true : (stryCov_9fa48("1813", "1814", "1815"), typeof resp === (stryMutAct_9fa48("1816") ? "" : (stryCov_9fa48("1816"), 'string')))) ? resp : stryMutAct_9fa48("1819") ? (resp?.content || resp?.choices?.[0]?.message?.content) && '' : stryMutAct_9fa48("1818") ? false : stryMutAct_9fa48("1817") ? true : (stryCov_9fa48("1817", "1818", "1819"), (stryMutAct_9fa48("1821") ? resp?.content && resp?.choices?.[0]?.message?.content : stryMutAct_9fa48("1820") ? false : (stryCov_9fa48("1820", "1821"), (stryMutAct_9fa48("1822") ? resp.content : (stryCov_9fa48("1822"), resp?.content)) || (stryMutAct_9fa48("1826") ? resp.choices?.[0]?.message?.content : stryMutAct_9fa48("1825") ? resp?.choices[0]?.message?.content : stryMutAct_9fa48("1824") ? resp?.choices?.[0].message?.content : stryMutAct_9fa48("1823") ? resp?.choices?.[0]?.message.content : (stryCov_9fa48("1823", "1824", "1825", "1826"), resp?.choices?.[0]?.message?.content)))) || (stryMutAct_9fa48("1827") ? "Stryker was here!" : (stryCov_9fa48("1827"), '')));
          if (stryMutAct_9fa48("1830") ? false : stryMutAct_9fa48("1829") ? true : stryMutAct_9fa48("1828") ? raw : (stryCov_9fa48("1828", "1829", "1830"), !raw)) return;

          // Parse JSON response (robust — grab first JSON object)
          const jsonMatch = raw.match(stryMutAct_9fa48("1834") ? /\{[\s\s]*\}/ : stryMutAct_9fa48("1833") ? /\{[\S\S]*\}/ : stryMutAct_9fa48("1832") ? /\{[^\s\S]*\}/ : stryMutAct_9fa48("1831") ? /\{[\s\S]\}/ : (stryCov_9fa48("1831", "1832", "1833", "1834"), /\{[\s\S]*\}/));
          if (stryMutAct_9fa48("1837") ? false : stryMutAct_9fa48("1836") ? true : stryMutAct_9fa48("1835") ? jsonMatch : (stryCov_9fa48("1835", "1836", "1837"), !jsonMatch)) return;
          const parsed = JSON.parse(jsonMatch[0]);
          const results = Array.isArray(parsed.results) ? parsed.results : stryMutAct_9fa48("1838") ? ["Stryker was here"] : (stryCov_9fa48("1838"), []);
          for (const r of results) {
            if (stryMutAct_9fa48("1839")) {
              {}
            } else {
              stryCov_9fa48("1839");
              if (stryMutAct_9fa48("1842") ? r.status === 'resolved' || r.signal_id : stryMutAct_9fa48("1841") ? false : stryMutAct_9fa48("1840") ? true : (stryCov_9fa48("1840", "1841", "1842"), (stryMutAct_9fa48("1844") ? r.status !== 'resolved' : stryMutAct_9fa48("1843") ? true : (stryCov_9fa48("1843", "1844"), r.status === (stryMutAct_9fa48("1845") ? "" : (stryCov_9fa48("1845"), 'resolved')))) && r.signal_id)) {
                if (stryMutAct_9fa48("1846")) {
                  {}
                } else {
                  stryCov_9fa48("1846");
                  this.indexer.autoResolvePerception(r.signal_id, newMemoryId, stryMutAct_9fa48("1849") ? r.reason && 'Auto-resolved by LLM' : stryMutAct_9fa48("1848") ? false : stryMutAct_9fa48("1847") ? true : (stryCov_9fa48("1847", "1848", "1849"), r.reason || (stryMutAct_9fa48("1850") ? "" : (stryCov_9fa48("1850"), 'Auto-resolved by LLM'))));
                  console.log(stryMutAct_9fa48("1851") ? `` : (stryCov_9fa48("1851"), `[awareness-local] perception auto-resolved: ${r.signal_id} — ${stryMutAct_9fa48("1852") ? r.reason || '' : (stryCov_9fa48("1852"), (stryMutAct_9fa48("1855") ? r.reason && '' : stryMutAct_9fa48("1854") ? false : stryMutAct_9fa48("1853") ? true : (stryCov_9fa48("1853", "1854", "1855"), r.reason || (stryMutAct_9fa48("1856") ? "Stryker was here!" : (stryCov_9fa48("1856"), '')))).slice(0, 80))}`));
                }
              }
            }
          }
        }
      } catch (err) {
        if (stryMutAct_9fa48("1857")) {
          {}
        } else {
          stryCov_9fa48("1857");
          if (stryMutAct_9fa48("1859") ? false : stryMutAct_9fa48("1858") ? true : (stryCov_9fa48("1858", "1859"), process.env.DEBUG)) {
            if (stryMutAct_9fa48("1860")) {
              {}
            } else {
              stryCov_9fa48("1860");
              console.warn(stryMutAct_9fa48("1861") ? `` : (stryCov_9fa48("1861"), `[awareness-local] LLM perception resolve failed: ${err.message}`));
            }
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  /** Remove stale PID file. */
  _cleanPidFile() {
    if (stryMutAct_9fa48("1862")) {
      {}
    } else {
      stryCov_9fa48("1862");
      try {
        if (stryMutAct_9fa48("1863")) {
          {}
        } else {
          stryCov_9fa48("1863");
          if (stryMutAct_9fa48("1865") ? false : stryMutAct_9fa48("1864") ? true : (stryCov_9fa48("1864", "1865"), fs.existsSync(this.pidFile))) {
            if (stryMutAct_9fa48("1866")) {
              {}
            } else {
              stryCov_9fa48("1866");
              fs.unlinkSync(this.pidFile);
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }
}
function detectGuardProfile(projectDir) {
  if (stryMutAct_9fa48("1867")) {
    {}
  } else {
    stryCov_9fa48("1867");
    const explicit = process.env.AWARENESS_LOCAL_GUARD_PROFILE;
    if (stryMutAct_9fa48("1869") ? false : stryMutAct_9fa48("1868") ? true : (stryCov_9fa48("1868", "1869"), explicit)) return explicit;
    const awarenessMarkers = stryMutAct_9fa48("1870") ? [] : (stryCov_9fa48("1870"), [path.join(projectDir, stryMutAct_9fa48("1871") ? "" : (stryCov_9fa48("1871"), 'backend'), stryMutAct_9fa48("1872") ? "" : (stryCov_9fa48("1872"), 'awareness-spec.json')), path.join(projectDir, stryMutAct_9fa48("1873") ? "" : (stryCov_9fa48("1873"), 'docs'), stryMutAct_9fa48("1874") ? "" : (stryCov_9fa48("1874"), 'prd'), stryMutAct_9fa48("1875") ? "" : (stryCov_9fa48("1875"), 'deployment-guide.md'))]);
    return (stryMutAct_9fa48("1876") ? awarenessMarkers.some(marker => fs.existsSync(marker)) : (stryCov_9fa48("1876"), awarenessMarkers.every(stryMutAct_9fa48("1877") ? () => undefined : (stryCov_9fa48("1877"), marker => fs.existsSync(marker))))) ? stryMutAct_9fa48("1878") ? "" : (stryCov_9fa48("1878"), 'awareness') : stryMutAct_9fa48("1879") ? "" : (stryCov_9fa48("1879"), 'generic');
  }
}
export default AwarenessLocalDaemon;