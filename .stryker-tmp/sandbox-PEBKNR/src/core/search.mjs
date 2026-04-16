/**
 * SearchEngine for Awareness Local
 *
 * Hybrid search combining:
 *   - FTS5 full-text keyword search (via Indexer)
 *   - Local embedding cosine similarity (via Embedder)
 *   - Reciprocal Rank Fusion (RRF) to merge both channels
 *   - Optional cloud recall for dual-channel results
 *
 * Follows progressive disclosure: detail='summary' returns lightweight index,
 * detail='full' + ids returns complete content.
 */
// @ts-nocheck


import { embed, cosineSimilarity } from './embedder.mjs';
import { detectNeedsCJK } from './lang-detect.mjs';
import { applyContextBudget } from './context-budgeter.mjs';
import { planRecallQuery } from './query-planner.mjs';
import { rerank, getRerankMethod } from './reranker.mjs';
import { BuiltinRetrievalBackend } from './retrieval-backends/builtin-backend.mjs';
import { QmdRetrievalBackend, QMD_RESULT_PREFIX } from './retrieval-backends/qmd-backend.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF smoothing constant — standard value from the literature */
const RRF_K = 60;

/** Time decay half-life in days (score halves every 30 days) */
const DECAY_HALF_LIFE_DAYS = 30;

/** Cold data threshold — aligned with cloud backend (90 days) */
const COLD_THRESHOLD_DAYS = 90;

/** Cold data penalty multiplier (non-evergreen, >90 days) */
const COLD_PENALTY_FACTOR = 0.3;

/** Cloud recall timeout in milliseconds */
const CLOUD_TIMEOUT_MS = 3000;

/** Minimum results before triggering broad retry */
const SPARSE_RESULT_THRESHOLD = 3;

/** Score floor that triggers broad retry */
const LOW_SCORE_THRESHOLD = 0.3;

/** Type-specific relevance boost multipliers for mergeAndRank. */
const TYPE_BOOST = {
  knowledge_card: 1.5,
  risk: 1.5,
  pitfall: 1.5,
  decision: 1.3,
  problem_solution: 1.3,
  session_summary: 1.2,
  turn_summary: 1.0,
  turn_brief: 0.4,
  message: 0.5,
  code_change: 0.3,
};

/** Types excluded from recall results by default (raw conversation noise). */
const DEFAULT_TYPE_EXCLUDE = new Set(['session_checkpoint']);

/** Common CJK tech terms → English for cross-language query expansion. */
const CJK_TECH_TERMS = [
  ['部署', 'deploy deployment'],
  ['配置', 'config configuration'],
  ['记忆', 'memory'],
  ['召回', 'recall retrieval'],
  ['搜索', 'search'],
  ['知识', 'knowledge'],
  ['卡片', 'card'],
  ['分类', 'category classification'],
  ['感知', 'perception'],
  ['信号', 'signal'],
  ['架构', 'architecture'],
  ['插件', 'plugin'],
  ['通道', 'channel'],
  ['测试', 'test testing'],
  ['修复', 'fix'],
  ['优化', 'optimize improvement'],
  ['同步', 'sync synchronization'],
  ['认证', 'auth authentication'],
  ['数据库', 'database'],
  ['索引', 'index indexing'],
  ['缓存', 'cache'],
  ['日志', 'log logging'],
  ['权限', 'permission'],
  ['工作流', 'workflow'],
  ['类型', 'type'],
];

// ---------------------------------------------------------------------------
// SearchEngine
// ---------------------------------------------------------------------------

export class SearchEngine {
  /**
   * @param {object} indexer      - Indexer instance (FTS5 search + DB access)
   * @param {object} memoryStore  - MemoryStore instance (file read/write)
   * @param {object|null} embedder - Embedder module (null = FTS5 only)
   * @param {object|null} cloudSync - CloudSync instance (null = local only)
   */
  constructor(indexer, memoryStore, embedder = null, cloudSync = null, options = {}) {
    this.indexer = indexer;
    this.store = memoryStore;
    this.embedder = embedder;
    this.cloud = cloudSync;
    this.backendKind = resolveBackendKind(options.backendKind);
    this.queryPlanner = options.queryPlanner || { plan: planRecallQuery };
    this.contextBudgeter = options.contextBudgeter || { apply: applyContextBudget };
    this.builtinBackend = options.builtinBackend || new BuiltinRetrievalBackend({ engine: this });
    this.qmdBackend = options.qmdBackend || new QmdRetrievalBackend(options.qmd || {});
  }

  // -------------------------------------------------------------------------
  // Main entry
  // -------------------------------------------------------------------------

  /**
   * Primary recall method — the only public API callers need.
   *
   * @param {object} params
   * @param {string}  [params.semantic_query] - Natural language query
   * @param {string}  [params.keyword_query]  - Exact keyword phrase
   * @param {string}  [params.scope='all']    - all | timeline | knowledge | insights
   * @param {string}  [params.recall_mode='hybrid'] - hybrid | keyword | semantic
   * @param {number}  [params.limit=10]
   * @param {string}  [params.agent_role]
   * @param {string}  [params.detail='summary'] - 'summary' | 'full'
   * @param {string[]} [params.ids]            - Specific IDs for full content
   * @param {boolean} [params.multi_level]
   * @param {boolean} [params.cluster_expand]
   * @param {boolean} [params.include_installed=true]
   * @returns {Promise<object[]>}
   */
  async recall(params) {
    const {
      semantic_query,
      keyword_query,
      scope = 'all',
      recall_mode = 'hybrid',
      limit = 10,
      agent_role,
      detail = 'summary',
      ids,
      source_exclude,
      multi_level = false,
      cluster_expand = false,
      include_installed = true,
      current_source,   // caller's source identifier (e.g. 'claude-code', 'openclaw-plugin')
    } = params;

    // Fire-and-forget telemetry for recall mode usage analytics
    try {
      const { track } = await import('./telemetry.mjs');
      track('recall_mode_used', { mode: recall_mode, scope });
    } catch { /* non-fatal */ }

    // Progressive disclosure Phase 2: return full content for specified IDs
    if (detail === 'full' && ids?.length) {
      return this.getFullContent(ids);
    }

    // CJK cross-language expansion: if query is primarily CJK, also search in English
    // This helps because ~75% of memories are in English even for Chinese-speaking users.
    const cjkChars = (semantic_query || '').match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    const isCjkDominant = cjkChars && cjkChars.length > (semantic_query || '').length * 0.3;
    const expandedKeyword = isCjkDominant
      ? this._expandCjkToEnglish(keyword_query || semantic_query || '')
      : keyword_query;

    // Session-context enrichment: extract topic keywords from memories written in the
    // last hour and append them to the semantic query.  This prevents short, ambiguous
    // prompts (e.g. "make it responsive") from pulling in unrelated cards that happen
    // to share a common term.  Works for any client — no workspace metadata needed.
    let enrichedSemantic = semantic_query;
    try {
      if (semantic_query && this.indexer?.getRecentMemories) {
        const recentMems = this.indexer.getRecentMemories(3_600_000, 8);
        const hint = this._buildSessionContextHint(recentMems);
        if (hint) enrichedSemantic = `${semantic_query} ${hint}`;
      }
    } catch { /* non-fatal — degrade gracefully */ }

    // Phase 1: search and return lightweight summaries
    const normalizedParams = this.queryPlanner.plan({
      semantic_query: enrichedSemantic,
      keyword_query: expandedKeyword || keyword_query,
      scope,
      recall_mode,
      limit,
      agent_role,
      source_exclude,
      multi_level,
      cluster_expand,
      include_installed,
      token_budget: params.token_budget,
    });

    // Dual-channel: local (always) + cloud (optional, with timeout protection)
    const [localResults, cloudResults] = await Promise.all([
      this.searchLocal(normalizedParams),
      this.cloud?.isEnabled?.()
        ? this.searchCloud(normalizedParams).catch(() => [])
        : Promise.resolve([]),
    ]);

    let merged = this.mergeResults(localResults, cloudResults, normalizedParams);

    // F-031 Phase 1: Apply reranker (fusion or LLM) after merge, before post-processing
    if (getRerankMethod() !== 'none' && merged.length > 1) {
      try {
        merged = await rerank(merged, semantic_query || keyword_query, {
          topK: Math.max(limit * 2, merged.length), // Don't trim yet — CJK boost may add more
        });
      } catch (err) {
        if (process.env.DEBUG) console.warn('[search] rerank failed (non-fatal):', err.message);
      }
    }

    // CJK cross-language boost: run additional English search if CJK dominant
    if (isCjkDominant && expandedKeyword && expandedKeyword !== keyword_query) {
      try {
        const engParams = { ...normalizedParams, semantic_query: expandedKeyword, keyword_query: expandedKeyword };
        const engResults = await this.searchLocal(engParams);
        // Merge English results with a slight discount (0.9x) since they're expansion matches
        const discounted = engResults.map((r) => ({ ...r, rrfScore: (r.rrfScore || 0) * 0.9, rank: (r.rank || 0) * 0.9 }));
        merged = this._dedup([...merged, ...discounted], limit * 2);
      } catch { /* non-fatal */ }
    }

    // Apply source exclusion filter if requested
    if (source_exclude && source_exclude.length > 0) {
      merged = merged.filter((r) => !source_exclude.includes(r.source));
    }

    // Filter out low-signal types by default
    merged = merged.filter((r) => !DEFAULT_TYPE_EXCLUDE.has(r.type));

    // Source boost: knowledge cards created by the same client as the caller
    // score 30% higher.  Cards from unknown sources are not penalised.
    // Uses the DB `source` field (mcp/openclaw-plugin/desktop/…) stored on each
    // card at write time; distinct from the retrieval-path `source` ('local'/'cloud').
    if (current_source) {
      merged = merged.map((r) => {
        const cardSource = r.record_source || r.source_origin || r.db_source;
        if (cardSource && cardSource === current_source) {
          return { ...r, finalScore: (r.finalScore ?? r.mergedScore ?? 0) * 1.3 };
        }
        return r;
      });
      merged.sort((a, b) =>
        (b.finalScore ?? b.mergedScore ?? 0) - (a.finalScore ?? a.mergedScore ?? 0)
      );
    }

    // Hydrate results missing metadata (embedding-only results lack title/content)
    this._hydrateMetadata(merged);

    // Workspace graph expansion: enrich results with related file/wiki/doc nodes
    const workspaceExpanded = this._expandWithWorkspace(merged, semantic_query || keyword_query, 5);
    const mergedWithWorkspace = workspaceExpanded.length > 0
      ? [...merged, ...workspaceExpanded]
      : merged;

    // Return summary format — full content, no truncation; control token budget via item count
    const summaryResults = mergedWithWorkspace.map((r) => {
      const item = {
        id: r.id,
        type: r.type || r.category || 'memory',
        title: r.title || this._autoTitle(r.fts_content || r.content),
        summary: r.summary || r.fts_content || r.content || '',
        score: r.finalScore ?? r.rerankScore ?? r.mergedScore ?? 0,
        tokens_est: Math.ceil((r.fts_content?.length || r.content?.length || 0) / 4),
        tags: this._parseTags(r.tags),
        created_at: r.created_at,
        source: r.source || 'local',
      };
      // Attach file_path for workspace results so callers can locate the file
      if (r.file_path) item.file_path = r.file_path;
      return item;
    });

    if (Number.isFinite(normalizedParams.token_budget) && normalizedParams.token_budget > 0) {
      return this.contextBudgeter.apply(summaryResults, {
        tokenBudget: normalizedParams.token_budget,
        minItems: 1,
        maxItems: limit,
      }).items;
    }

    return summaryResults;
  }

  // -------------------------------------------------------------------------
  // Local search (FTS5 + embedding → RRF fusion)
  // -------------------------------------------------------------------------

  /**
   * Search the local index using parallel FTS5 + embedding channels.
   *
   * @param {object} params
   * @returns {Promise<object[]>}
   */
  async searchLocal(params) {
    const limit = params.limit || 10;

    if (this.backendKind === 'qmd') {
      const qmdResults = await this.qmdBackend.search(params);
      return qmdResults.length > 0
        ? this._sortExternalResults(qmdResults, limit)
        : this.builtinBackend.search(params);
    }

    if (this.backendKind === 'hybrid') {
      const [builtinResults, qmdResults] = await Promise.all([
        this.builtinBackend.search(params),
        this.qmdBackend.search(params),
      ]);
      return this._sortExternalResults([...builtinResults, ...qmdResults], limit);
    }

    return this.builtinBackend.search(params);
  }

  async _searchLocalBuiltin(params) {
    const { semantic_query, keyword_query, scope, recall_mode, limit, agent_role } = params;

    const ftsQuery = this.buildFtsQuery(semantic_query, keyword_query);
    const searchOpts = { limit: limit * 2, agent_role };

    // Channel 1: FTS5 keyword search (<5ms typical)
    let ftsResults = [];
    if (recall_mode !== 'semantic' && ftsQuery) {
      ftsResults = this._ftsSearch(ftsQuery, scope, searchOpts);
    }

    // Channel 2: Embedding cosine similarity (~10ms typical)
    let embeddingResults = [];
    if (recall_mode !== 'keyword' && this.embedder && (semantic_query || keyword_query)) {
      try {
        embeddingResults = await this._embeddingSearch(
          semantic_query || keyword_query,
          scope,
          searchOpts,
        );
      } catch {
        // Embedding unavailable — degrade gracefully to FTS5-only
      }
    }

    // RRF fusion of both channels
    let results = this._rrfFusion(ftsResults, embeddingResults);

    // Apply time decay and rank
    results = this.mergeAndRank(results, limit);

    // Smart retry: if results are sparse or low-confidence, broaden the search
    if (results.length < SPARSE_RESULT_THRESHOLD || (results[0]?.finalScore ?? 0) < LOW_SCORE_THRESHOLD) {
      const alternateQueries = [
        ...(params.query_plan?.alternateQueries || []),
        semantic_query?.replace(/"/g, '') || '',
      ]
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);

      for (const broadQuery of [...new Set(alternateQueries)]) {
        const broadFtsQuery = this.buildFtsQuery(broadQuery, null);
        if (!broadFtsQuery || broadFtsQuery === ftsQuery) continue;

        const broadFts = this._ftsSearch(
          broadFtsQuery,
          scope,
          { ...searchOpts, limit: limit * 3 },
        );
        const broadFused = this._rrfFusion(broadFts, []);
        results = this._dedup([...results, ...this.mergeAndRank(broadFused, limit * 2)], limit);

        if (results.length >= SPARSE_RESULT_THRESHOLD && (results[0]?.finalScore ?? 0) >= LOW_SCORE_THRESHOLD) {
          break;
        }
      }

      // Also try knowledge cards if still sparse
      if (results.length < 2 && ftsQuery) {
        const cardResults = this.indexer.searchKnowledge?.(ftsQuery, { limit: 5 }) || [];
        const cardScored = cardResults.map((r) => ({ ...r, finalScore: (r.rank || 0.5) }));
        results = this._dedup([...results, ...cardScored], limit);
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Cloud search
  // -------------------------------------------------------------------------

  /**
   * Call the cloud recall API with timeout protection.
   * Returns empty array on any failure (silent degradation).
   *
   * @param {object} params
   * @returns {Promise<object[]>}
   */
  async searchCloud(params) {
    if (!this.cloud?.apiBase || !this.cloud?.apiKey || !this.cloud?.memoryId) {
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.cloud.apiBase}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.cloud.apiKey}`,
          'X-Awareness-Memory-Id': this.cloud.memoryId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'awareness_recall',
            arguments: {
              semantic_query: params.semantic_query,
              keyword_query: params.keyword_query,
              scope: params.scope || 'all',
              recall_mode: 'hybrid',
              limit: params.limit || 10,
              multi_level: !!params.multi_level,
              cluster_expand: !!params.cluster_expand,
              include_installed: params.include_installed !== false,
              reconstruct_chunks: true,
            },
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.result?.results || [];
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        // Timeout — expected when cloud is slow or offline
      }
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Result merging (local + cloud)
  // -------------------------------------------------------------------------

  /**
   * Intelligently merge local and cloud results.
   *
   * - Same item in both channels: mergedScore = local*0.4 + cloud*0.6
   * - Cloud only: cloudScore * 0.8 (slight discount — no local validation)
   * - Local only: localScore as-is
   *
   * @param {object[]} localResults
   * @param {object[]} cloudResults
   * @param {object}   params
   * @returns {object[]}
   */
  mergeResults(localResults, cloudResults, params) {
    const merged = new Map();

    // Step 1: index all local results
    for (const r of localResults) {
      merged.set(r.id, {
        ...r,
        record_source: r.source || null,  // preserve DB source (mcp/openclaw-plugin/…)
        source: 'local',                  // overwrite with retrieval-path indicator
        localScore: r.finalScore || 0,
        cloudScore: null,
        mergedScore: r.finalScore || 0,
      });
    }

    // Step 2: merge in cloud results
    for (const r of cloudResults) {
      const localId = r.metadata?.local_id || r.id;

      if (localId && merged.has(localId)) {
        // Dual hit — high confidence, boost score
        const existing = merged.get(localId);
        existing.cloudScore = r.score || 0;
        existing.mergedScore = existing.localScore * 0.4 + existing.cloudScore * 0.6;
        existing.source = 'both';
      } else {
        // Cloud-only result (cross-project, marketplace, team)
        const id = r.id || `cloud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        merged.set(id, {
          ...r,
          id,
          source: 'cloud',
          localScore: null,
          cloudScore: r.score || 0,
          mergedScore: (r.score || 0) * 0.8,
        });
      }
    }

    // Step 3: sort by merged score descending
    const results = [...merged.values()];
    results.sort((a, b) => {
      const scoreA = a.mergedScore ?? a.localScore ?? a.cloudScore ?? 0;
      const scoreB = b.mergedScore ?? b.localScore ?? b.cloudScore ?? 0;
      return scoreB - scoreA;
    });

    return results.slice(0, params.limit || 10);
  }

  // -------------------------------------------------------------------------
  // FTS5 query builder
  // -------------------------------------------------------------------------

  /**
   * Convert natural language + keyword into FTS5 MATCH syntax.
   *
   * - semantic_query words are split and joined with OR (broad match)
   * - keyword_query is wrapped as a quoted phrase (exact match)
   * - Empty input returns empty string (caller should skip FTS5)
   *
   * @param {string|null} semantic
   * @param {string|null} keyword
   * @returns {string}
   */
  buildFtsQuery(semantic, keyword) {
    const terms = [];

    if (semantic) {
      terms.push(...this._tokenizeForFts(semantic, 15));
    }

    if (keyword) {
      terms.push(...this._tokenizeForFts(keyword, 18));
    }

    return [...new Set(terms)].join(' OR ');
  }

  /**
   * Expand CJK query to English keywords for cross-language recall.
   * Uses a lightweight mapping table — no LLM required.
   * Falls back to extracting Latin tokens already present in the query.
   *
   * @param {string} query
   * @returns {string|null}
   */
  _expandCjkToEnglish(query) {
    const expansions = [];

    // Extract any Latin words already in the query (e.g., "Docker" in "Docker部署命令")
    const latinWords = query.match(/[a-zA-Z]{2,}/g) || [];
    expansions.push(...latinWords);

    // Common tech term mapping (CJK → English)
    for (const [zh, en] of CJK_TECH_TERMS) {
      if (query.includes(zh)) expansions.push(en);
    }

    return expansions.length > 0 ? expansions.join(' ') : null;
  }

  /**
   * Split text into FTS5 trigram-compatible search terms.
   * Key improvements over naive splitting:
   * 1. Separate CJK runs from Latin runs (avoid "er部" garbage)
   * 2. CJK 2-char words are kept as-is (FTS5 trigram substring match)
   * 3. CJK 3+ char words are split into overlapping trigrams
   * 4. Latin words are kept as-is (quoted)
   *
   * @param {string} text
   * @param {number} maxTerms
   * @returns {string[]}
   */
  _tokenizeForFts(text, maxTerms) {
    if (!text) return [];
    const terms = [];
    const clean = text.replace(/"/g, '').trim();

    // Split into CJK runs and Latin/number runs
    // e.g., "Docker部署命令" → ["Docker", "部署", "命令"]
    // e.g., "知识卡片分类" → ["知识卡片分类"]
    const segments = clean.match(/[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+|[a-zA-Z0-9_-]+/g) || [];

    const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

    for (const seg of segments) {
      if (terms.length >= maxTerms) break;

      if (CJK_RE.test(seg)) {
        // CJK segment: generate trigrams + keep 2-char substrings
        // For "部署" (2 chars): just quote it directly
        if (seg.length <= 2) {
          terms.push(`"${seg}"`);
        } else {
          // For "知识卡片分类" (5+ chars): overlapping trigrams
          for (let i = 0; i <= seg.length - 3 && terms.length < maxTerms; i++) {
            terms.push(`"${seg.substring(i, i + 3)}"`);
          }
          // Also add 2-char bigrams for broader matching
          for (let i = 0; i <= seg.length - 2 && terms.length < maxTerms; i++) {
            terms.push(`"${seg.substring(i, i + 2)}"`);
          }
        }
      } else {
        // Latin/number segment: quote as-is
        if (seg.length >= 2) {
          terms.push(`"${seg}"`);
        }
      }
    }

    return terms;
  }

  // -------------------------------------------------------------------------
  // Ranking with time decay
  // -------------------------------------------------------------------------

  /**
   * Sort results by finalScore incorporating time decay and type boost.
   * 1. Normalize RRF scores to 0-1 range (max = 1.0).
   * 2. Apply type-specific boost multiplier.
   * 3. Combine: normalizedRelevance * 0.7 * typeBoost + timeDecay * 0.3
   * Time decay: 30-day half-life exponential decay.
   *
   * @param {object[]} results
   * @param {number}   limit
   * @returns {object[]}
   */
  mergeAndRank(results, limit) {
    const now = Date.now();

    // Find max relevance for normalization (avoid division by zero)
    const rawScores = results.map((r) => r.rrfScore ?? r.rank ?? r.score ?? 0);
    const maxRelevance = Math.max(...rawScores, 0.001);

    const scored = results.map((r) => {
      const createdMs = r.created_at ? new Date(r.created_at).getTime() : now;
      const ageDays = Math.max(0, (now - createdMs) / (1000 * 60 * 60 * 24));
      const timeDecay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
      const rawRelevance = r.rrfScore ?? r.rank ?? r.score ?? 0;
      const normalizedRelevance = rawRelevance / maxRelevance;
      const typeBoost = TYPE_BOOST[r.type] ?? TYPE_BOOST[r.category] ?? 1.0;

      // F-031: Adjusted weights — relevance 0.65 + recency 0.05 (aligned with reranker 5-dim)
      // card_type and growth_stage handled by reranker; here we keep typeBoost as multiplier
      let finalScore = normalizedRelevance * 0.65 * typeBoost + timeDecay * 0.05;

      // F-031: Cold data penalty — 90-day non-evergreen cliff (aligned with cloud backend)
      const growthStage = r.growth_stage || 'seedling';
      if (ageDays > COLD_THRESHOLD_DAYS && growthStage !== 'evergreen') {
        finalScore *= COLD_PENALTY_FACTOR;
      }

      return { ...r, finalScore, timeDecay };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Summary truncation
  // -------------------------------------------------------------------------

  /**
   * Build a keyword-context snippet: find the first query term in content
   * and return a window around it, instead of always truncating from the start.
   *
   * @param {string|null} content
   * @param {string|null} query - search query to find in content
   * @param {number}      maxChars
   * @returns {string}
   */
  buildSnippet(content, query, maxChars = 600) {
    if (!content) return '';
    if (!query || content.length <= maxChars) return content.slice(0, maxChars);

    const lowerContent = content.toLowerCase();
    const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    let bestPos = -1;

    for (const term of queryTerms) {
      const idx = lowerContent.indexOf(term);
      if (idx >= 0) { bestPos = idx; break; }
    }

    if (bestPos < 0) return content.slice(0, maxChars) + '...';

    const halfWindow = Math.floor(maxChars / 2);
    const start = Math.max(0, bestPos - halfWindow);
    const end = Math.min(content.length, start + maxChars);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < content.length ? '...' : '';
    return prefix + content.slice(start, end) + suffix;
  }

  /**
   * Truncate content to a word-boundary summary.
   *
   * @param {string|null} content
   * @param {number}      maxChars
   * @returns {string}
   */
  truncateToSummary(content, maxChars = 0) {
    if (!content) return '';
    if (!maxChars || content.length <= maxChars) return content;

    // Cut at maxChars, then backtrack to last whitespace for word boundary
    const truncated = content.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxChars * 0.5) {
      return truncated.slice(0, lastSpace) + '...';
    }
    return truncated + '...';
  }

  // -------------------------------------------------------------------------
  // Full content retrieval
  // -------------------------------------------------------------------------

  /**
   * Read complete file content for specified IDs.
   * Looks up in both memories and knowledge_cards tables.
   * Returns partial results if some IDs are not found.
   *
   * @param {string[]} ids
   * @returns {Promise<object[]>}
   */
  async getFullContent(ids) {
    const localIds = [];
    const qmdIds = [];

    for (const id of ids) {
      if (typeof id === 'string' && id.startsWith(QMD_RESULT_PREFIX)) qmdIds.push(id);
      else localIds.push(id);
    }

    const [localResults, qmdResults] = await Promise.all([
      localIds.length > 0 ? this.builtinBackend.getFullContent(localIds) : Promise.resolve([]),
      qmdIds.length > 0 ? this.qmdBackend.getFullContent(qmdIds) : Promise.resolve([]),
    ]);

    return [...localResults, ...qmdResults];
  }

  getBackendStatus() {
    return {
      selected: this.backendKind,
      builtin: this.builtinBackend.getStatus?.() || { kind: 'builtin', ready: true },
      qmd: this.qmdBackend.getStatus?.() || { kind: 'qmd', ready: false },
    };
  }

  async _getFullContentLocal(ids) {
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const meta =
            this.indexer.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) ||
            this.indexer.db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get(id);

          if (!meta?.filepath) return null;

          const raw = await this.store.readContent(meta.filepath);
          const content = raw?.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')?.trim() || '';
          return {
            id: meta.id,
            type: meta.type || meta.category || 'memory',
            title: meta.title || '',
            content,
            tags: this._parseTags(meta.tags),
            created_at: meta.created_at,
          };
        } catch {
          return null;
        }
      }),
    );

    return results.filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Internal: FTS5 search dispatch
  // -------------------------------------------------------------------------

  /**
   * Dispatch FTS5 search based on scope.
   *
   * @param {string} ftsQuery
   * @param {string} scope
   * @param {object} opts
   * @returns {object[]}
   */
  _ftsSearch(ftsQuery, scope, opts) {
    if (!ftsQuery) return [];

    try {
      switch (scope) {
        case 'knowledge':
          return this.indexer.searchKnowledge?.(ftsQuery, opts) || [];

        case 'timeline':
        case 'insights':
          // These scopes search memories with scope-specific filtering
          return this.indexer.search?.(ftsQuery, { ...opts, scope }) || [];

        default: {
          // 'all' — search memories, knowledge, and graph nodes
          const totalLimit = opts.limit || 10;
          const memLimit = Math.ceil(totalLimit * 0.5);
          const kcLimit = Math.ceil(totalLimit * 0.3);
          const graphLimit = Math.ceil(totalLimit * 0.2);

          const memResults = this.indexer.search?.(ftsQuery, { ...opts, limit: memLimit }) || [];
          const kcResults = this.indexer.searchKnowledge?.(ftsQuery, { ...opts, limit: kcLimit }) || [];
          const graphResults = this._searchGraphNodesFts(ftsQuery, graphLimit);

          return [...memResults, ...kcResults, ...graphResults];
        }
      }
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Embedding search
  // -------------------------------------------------------------------------

  /**
   * Embed the query, compare against all stored embeddings, return top-K.
   *
   * @param {string} queryText
   * @param {string} scope
   * @param {object} opts
   * @returns {Promise<object[]>}
   */
  async _embeddingSearch(queryText, scope, opts) {
    const isCJK = detectNeedsCJK(queryText);

    // Retrieve all stored embeddings from the indexer (includes model_id)
    const allEmbeddings = this.indexer.getAllEmbeddings?.(scope) || [];
    if (allEmbeddings.length === 0) return [];

    // Determine which models have stored embeddings
    const modelIds = new Set(allEmbeddings.map((e) => e.model_id || ''));
    const hasEnglish = modelIds.has('Xenova/all-MiniLM-L6-v2') || modelIds.has('all-MiniLM-L6-v2') || modelIds.has('');
    const hasMultilingual = modelIds.has('Xenova/multilingual-e5-small') || modelIds.has('multilingual-e5-small');

    // Build query vectors — only load models that have stored embeddings
    const queryVecs = new Map(); // modelPattern -> vector
    if (hasEnglish) {
      try {
        queryVecs.set('english', await embed(queryText, 'query', 'english'));
      } catch { /* english model unavailable */ }
    }
    if (isCJK || hasMultilingual) {
      try {
        queryVecs.set('multilingual', await embed(queryText, 'query', 'multilingual'));
      } catch { /* multilingual model not yet downloaded — will lazy-load on next CJK write */ }
    }

    if (queryVecs.size === 0) return [];

    // Score each stored embedding using the matching query vector
    const scored = [];
    for (const item of allEmbeddings) {
      if (!item.vector) continue;
      const itemId = item.id || item.memory_id;
      if (!itemId) continue;
      const mid = item.model_id || '';
      const isMulti = mid.includes('multilingual') || mid.includes('e5-small');
      const qvec = isMulti ? queryVecs.get('multilingual') : queryVecs.get('english');
      if (!qvec) continue; // no matching query vector for this model
      const similarity = cosineSimilarity(qvec, item.vector);
      if (similarity > 0.1) {
        scored.push({
          ...item,
          id: itemId,
          embeddingScore: similarity,
          rank: similarity,
        });
      }
    }

    // Sort by similarity descending, take top-K
    scored.sort((a, b) => b.embeddingScore - a.embeddingScore);
    return scored.slice(0, opts.limit || 10);
  }

  // -------------------------------------------------------------------------
  // Internal: RRF fusion
  // -------------------------------------------------------------------------

  /**
   * Reciprocal Rank Fusion — combine FTS5 and embedding result lists.
   *
   * For each document d:
   *   score(d) = 1/(k + rank_fts(d)) + 1/(k + rank_embed(d))
   *
   * where k=60 (standard smoothing constant).
   *
   * @param {object[]} ftsResults     - Sorted by FTS5 BM25 rank
   * @param {object[]} embedResults   - Sorted by cosine similarity
   * @returns {object[]}
   */
  _rrfFusion(ftsResults, embedResults) {
    const scoreMap = new Map();

    // Assign RRF scores from FTS5 channel
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      const rrfContrib = 1 / (RRF_K + i + 1); // rank is 1-indexed
      const existing = scoreMap.get(r.id);
      if (existing) {
        existing.rrfScore += rrfContrib;
        // Merge any missing fields from the FTS result
        Object.assign(existing, { ...r, ...existing, rrfScore: existing.rrfScore });
      } else {
        scoreMap.set(r.id, { ...r, rrfScore: rrfContrib });
      }
    }

    // Assign RRF scores from embedding channel
    for (let i = 0; i < embedResults.length; i++) {
      const r = embedResults[i];
      const rrfContrib = 1 / (RRF_K + i + 1);
      const existing = scoreMap.get(r.id);
      if (existing) {
        existing.rrfScore += rrfContrib;
      } else {
        scoreMap.set(r.id, { ...r, rrfScore: rrfContrib });
      }
    }

    // Convert to array sorted by RRF score
    const results = [...scoreMap.values()];
    results.sort((a, b) => b.rrfScore - a.rrfScore);
    return results;
  }

  // -------------------------------------------------------------------------
  // Internal: Deduplication
  // -------------------------------------------------------------------------

  /**
   * Deduplicate results by ID, keeping the higher-scored version.
   *
   * @param {object[]} results
   * @param {number}   limit
   * @returns {object[]}
   */
  _dedup(results, limit) {
    const seen = new Map();
    for (const r of results) {
      if (!r.id) continue;
      const existing = seen.get(r.id);
      const currentScore = r.finalScore ?? r.rrfScore ?? r.score ?? 0;
      const existingScore = existing?.finalScore ?? existing?.rrfScore ?? existing?.score ?? 0;
      if (!existing || currentScore > existingScore) {
        seen.set(r.id, r);
      }
    }
    const deduped = [...seen.values()];
    deduped.sort((a, b) => {
      const sa = a.finalScore ?? a.rrfScore ?? 0;
      const sb = b.finalScore ?? b.rrfScore ?? 0;
      return sb - sa;
    });
    return deduped.slice(0, limit);
  }

  _sortExternalResults(results, limit) {
    const seen = new Map();
    for (const result of results) {
      if (!result?.id) continue;
      const existing = seen.get(result.id);
      const currentScore = result.finalScore ?? result.score ?? result.rrfScore ?? 0;
      const existingScore = existing?.finalScore ?? existing?.score ?? existing?.rrfScore ?? 0;
      if (!existing || currentScore > existingScore) {
        seen.set(result.id, result);
      }
    }
    return [...seen.values()]
      .sort((a, b) => {
        const sa = a.finalScore ?? a.score ?? a.rrfScore ?? 0;
        const sb = b.finalScore ?? b.score ?? b.rrfScore ?? 0;
        return sb - sa;
      })
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Internal: Tag parsing
  // -------------------------------------------------------------------------

  /**
   * Safely parse tags from either a JSON string or an existing array.
   *
   * @param {string|string[]|null} tags
   * @returns {string[]}
   */
  /**
   * Fill in missing metadata fields (title, type, created_at, fts_content)
   * for results that came from embedding-only search (which only returns id + score).
   * Mutates results in place for efficiency.
   * @param {object[]} results
   */
  _hydrateMetadata(results) {
    for (const r of results) {
      if (r.title && r.fts_content) continue; // already hydrated
      try {
        const meta = this.indexer.db
          .prepare('SELECT m.id, m.title, m.type, m.created_at, m.tags, m.source, f.content AS fts_content FROM memories m LEFT JOIN memories_fts f ON f.id = m.id WHERE m.id = ?')
          .get(r.id);
        if (!meta) continue;
        if (!r.title) r.title = meta.title || '';
        if (!r.type) r.type = meta.type || 'memory';
        if (!r.created_at) r.created_at = meta.created_at;
        if (!r.tags) r.tags = meta.tags;
        if (!r.source) r.source = meta.source;
        if (!r.fts_content) r.fts_content = meta.fts_content || '';
      } catch { /* non-fatal */ }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Graph / Workspace expansion
  // -------------------------------------------------------------------------

  /**
   * Search graph_nodes via FTS5 and format results as unified search items.
   *
   * @param {string} ftsQuery - Sanitised FTS5 query
   * @param {number} limit
   * @returns {object[]}
   */
  _searchGraphNodesFts(ftsQuery, limit) {
    try {
      const raw = this.indexer.searchGraphNodes?.(ftsQuery, {
        nodeTypes: ['file', 'wiki', 'doc', 'symbol'],
        limit,
      }) || [];
      return raw.map((n) => this._graphNodeToResult(n, 'graph_fts'));
    } catch {
      return [];
    }
  }

  /**
   * Expand merged recall results with related workspace nodes from the graph.
   *
   * Strategy:
   *   1. Search graph_nodes using the original query for direct matches.
   *   2. For each hit, traverse 1-hop similarity/doc_reference neighbours.
   *   3. Deduplicate, cap at `maxExpand`, return as workspace-tagged results.
   *
   * The returned items are meant to be appended AFTER the primary results
   * (lower implicit priority) and are clearly marked with source='workspace'.
   *
   * @param {object[]} merged   - Primary recall results (read-only)
   * @param {string|null} query - Original user query
   * @param {number} maxExpand  - Max workspace items to return
   * @returns {object[]}
   */
  _expandWithWorkspace(merged, query, maxExpand = 5) {
    if (!query || !this.indexer?.searchGraphNodes) return [];

    try {
      // Step 1: direct graph search using the original query
      const directHits = this.indexer.searchGraphNodes(query, {
        nodeTypes: ['file', 'wiki', 'doc'],
        limit: maxExpand,
      });
      if (!directHits || directHits.length === 0) return [];

      // Step 2: 1-hop neighbour expansion for each direct hit
      const neighbourMap = new Map(); // id → node
      for (const hit of directHits) {
        neighbourMap.set(hit.id, hit);
        if (this.indexer.graphTraverse) {
          const neighbours = this.indexer.graphTraverse(hit.id, {
            edgeTypes: ['similarity', 'doc_reference'],
            maxDepth: 1,
            limit: 3,
          });
          for (const nb of neighbours) {
            if (!neighbourMap.has(nb.id)) {
              neighbourMap.set(nb.id, nb);
            }
          }
        }
      }

      // Step 3: exclude IDs already in primary results
      const primaryIds = new Set(merged.map((r) => r.id));
      const candidates = [...neighbourMap.values()].filter((n) => !primaryIds.has(n.id));

      // Step 4: convert to unified format, cap at maxExpand
      return candidates
        .slice(0, maxExpand)
        .map((n) => this._graphNodeToResult(n, 'workspace'));
    } catch {
      return [];
    }
  }

  /**
   * Convert a graph_nodes row into a unified search result object.
   *
   * @param {object} node       - Row from graph_nodes table
   * @param {string} sourceTag  - 'workspace' | 'graph_fts'
   * @returns {object}
   */
  _graphNodeToResult(node, sourceTag) {
    const nodeType = node.node_type || 'file';
    const typeSuffix = nodeType === 'file' ? 'workspace_file'
      : nodeType === 'wiki' ? 'workspace_wiki'
      : nodeType === 'doc' ? 'workspace_doc'
      : `workspace_${nodeType}`;

    let meta = {};
    try {
      meta = typeof node.metadata === 'string' ? JSON.parse(node.metadata) : (node.metadata || {});
    } catch { /* non-fatal */ }

    const title = node.title || meta.file_path || '';
    const content = node.content || '';

    return {
      id: node.id,
      type: typeSuffix,
      title,
      summary: content.slice(0, 500),
      fts_content: content,
      content,
      score: node.salience_score ?? Math.abs(node.rank ?? 0.2),
      finalScore: node.salience_score ?? Math.abs(node.rank ?? 0.2),
      tags: meta.language ? [meta.language] : [],
      created_at: node.created_at || null,
      source: sourceTag,
      file_path: meta.file_path || null,
    };
  }

  /**
   * Generate a preview title from content when title is missing.
   * Strips markdown formatting and takes the first meaningful sentence.
   * @param {string|null} content
   * @returns {string}
   */
  _autoTitle(content) {
    if (!content) return '';
    const cleaned = content.replace(/[#*`_\[\]>]/g, '').trim();
    const firstLine = cleaned.split(/[\n.!?。！？]/)[0]?.trim() || '';
    return firstLine.slice(0, 80) || '';
  }

  _parseTags(tags) {
    if (Array.isArray(tags)) return tags;
    if (typeof tags === 'string') {
      try {
        const parsed = JSON.parse(tags);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Extract the top recurring topic keywords from a set of recent memories.
   *
   * These keywords are appended to the semantic query to make it context-aware:
   * a short, ambiguous prompt like "make it responsive" becomes
   * "make it responsive snake html game css" when the recent session context is
   * about a snake game — preventing false recalls from unrelated domains.
   *
   * Intentionally lightweight: no LLM, no language-specific lists beyond a tiny
   * universal stop-word set.  Works for any client and any language.
   *
   * @param {Array<{title:string, tags:string}>} memories
   * @returns {string} space-separated hint terms (may be empty)
   */
  _buildSessionContextHint(memories) {
    if (!memories?.length) return '';

    // Minimal cross-language stop words — only words so common they add no signal.
    const STOP = new Set([
      'the','a','an','is','are','was','were','be','been','have','has',
      'do','does','did','will','would','could','should','may','might',
      'i','you','he','she','it','we','they','this','that','these','those',
      'with','for','on','at','to','in','of','and','or','but','not','no',
      // Common CJK function words
      '的','了','是','在','有','和','我','你','他','她','它','们',
      '这','那','就','也','都','说','要','到','去','来','把','被',
    ]);

    const freq = new Map();
    for (const mem of memories) {
      const text = `${mem.title || ''} ${mem.tags || ''}`;
      const words = text.toLowerCase().split(/[\s\-_：:,，.。!！?？\[\]()（）<>/\\]+/);
      for (const w of words) {
        if (w.length >= 2 && !STOP.has(w) && /[\p{L}\p{N}]/u.test(w)) {
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      }
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([w]) => w)
      .join(' ');
  }
}

function resolveBackendKind(kind) {
  const raw = String(kind || process.env.AWARENESS_LOCAL_RETRIEVAL_BACKEND || 'builtin').toLowerCase();
  if (raw === 'qmd' || raw === 'hybrid') return raw;
  return 'builtin';
}
