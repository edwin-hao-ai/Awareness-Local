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

import { embed, cosineSimilarity } from './embedder.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RRF smoothing constant — standard value from the literature */
const RRF_K = 60;

/** Time decay half-life in days (score halves every 30 days) */
const DECAY_HALF_LIFE_DAYS = 30;

/** Cloud recall timeout in milliseconds */
const CLOUD_TIMEOUT_MS = 3000;

/** Minimum results before triggering broad retry */
const SPARSE_RESULT_THRESHOLD = 3;

/** Score floor that triggers broad retry */
const LOW_SCORE_THRESHOLD = 0.3;

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
  constructor(indexer, memoryStore, embedder = null, cloudSync = null) {
    this.indexer = indexer;
    this.store = memoryStore;
    this.embedder = embedder;
    this.cloud = cloudSync;
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
    } = params;

    // Progressive disclosure Phase 2: return full content for specified IDs
    if (detail === 'full' && ids?.length) {
      return this.getFullContent(ids);
    }

    // Phase 1: search and return lightweight summaries
    const normalizedParams = {
      semantic_query,
      keyword_query,
      scope,
      recall_mode,
      limit,
      agent_role,
    };

    // Dual-channel: local (always) + cloud (optional, with timeout protection)
    const [localResults, cloudResults] = await Promise.all([
      this.searchLocal(normalizedParams),
      this.cloud?.isEnabled?.()
        ? this.searchCloud(normalizedParams).catch(() => [])
        : Promise.resolve([]),
    ]);

    const merged = this.mergeResults(localResults, cloudResults, normalizedParams);

    // Return summary format
    return merged.map((r) => ({
      id: r.id,
      type: r.type || r.category || 'memory',
      title: r.title || '',
      summary: r.summary || this.truncateToSummary(r.fts_content || r.content, 150),
      score: r.mergedScore ?? r.finalScore ?? 0,
      tokens_est: Math.ceil((r.fts_content?.length || r.content?.length || 0) / 4),
      tags: this._parseTags(r.tags),
      created_at: r.created_at,
      source: r.source || 'local',
    }));
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
      const broadQuery = semantic_query?.replace(/"/g, '') || '';
      if (broadQuery && broadQuery !== ftsQuery) {
        const broadFts = this._ftsSearch(
          this.buildFtsQuery(broadQuery, null),
          scope,
          { ...searchOpts, limit: limit * 3 },
        );
        const broadFused = this._rrfFusion(broadFts, []);
        results = this._dedup([...results, ...this.mergeAndRank(broadFused, limit * 2)], limit);
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
              multi_level: true,
              cluster_expand: true,
              include_installed: true,
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
        source: 'local',
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
    const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;

    if (semantic) {
      const words = semantic
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
      for (const w of words) {
        const clean = w.replace(/"/g, '');
        if (CJK_RE.test(clean) && clean.length > 4) {
          // CJK-heavy token: split into overlapping trigrams for FTS5 trigram tokenizer
          for (let i = 0; i <= clean.length - 3 && terms.length < 15; i++) {
            terms.push(`"${clean.substring(i, i + 3)}"`);
          }
        } else {
          terms.push(`"${clean}"`);
        }
      }
    }

    if (keyword) {
      const clean = keyword.replace(/"/g, '');
      if (CJK_RE.test(clean) && clean.length > 4) {
        for (let i = 0; i <= clean.length - 3 && terms.length < 18; i++) {
          terms.push(`"${clean.substring(i, i + 3)}"`);
        }
      } else {
        terms.push(`"${clean}"`);
      }
    }

    return terms.join(' OR ');
  }

  // -------------------------------------------------------------------------
  // Ranking with time decay
  // -------------------------------------------------------------------------

  /**
   * Sort results by finalScore incorporating time decay.
   * Score = relevanceScore * 0.7 + timeDecay * 0.3
   * Time decay: 30-day half-life exponential decay.
   *
   * @param {object[]} results
   * @param {number}   limit
   * @returns {object[]}
   */
  mergeAndRank(results, limit) {
    const now = Date.now();

    const scored = results.map((r) => {
      const createdMs = r.created_at ? new Date(r.created_at).getTime() : now;
      const ageDays = Math.max(0, (now - createdMs) / (1000 * 60 * 60 * 24));
      const timeDecay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
      const relevance = r.rrfScore ?? r.rank ?? r.score ?? 0;
      const finalScore = relevance * 0.7 + timeDecay * 0.3;
      return { ...r, finalScore, timeDecay };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Summary truncation
  // -------------------------------------------------------------------------

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
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          // Try memories table first, then knowledge_cards
          const meta =
            this.indexer.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) ||
            this.indexer.db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get(id);

          if (!meta?.filepath) return null;

          const raw = await this.store.readContent(meta.filepath);
          // Strip front matter — return only body content
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
          // 'all' — search both memories and knowledge, merge
          const memLimit = Math.ceil((opts.limit || 10) * 0.6);
          const kcLimit = Math.ceil((opts.limit || 10) * 0.4);

          const memResults = this.indexer.search?.(ftsQuery, { ...opts, limit: memLimit }) || [];
          const kcResults = this.indexer.searchKnowledge?.(ftsQuery, { ...opts, limit: kcLimit }) || [];

          return [...memResults, ...kcResults];
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
    const queryVec = await embed(queryText, 'query');
    if (!queryVec) return [];

    // Retrieve all stored embeddings from the indexer
    const allEmbeddings = this.indexer.getAllEmbeddings?.(scope) || [];
    if (allEmbeddings.length === 0) return [];

    // Compute cosine similarity for each
    const scored = [];
    for (const item of allEmbeddings) {
      if (!item.vector) continue;
      const similarity = cosineSimilarity(queryVec, item.vector);
      if (similarity > 0.1) {
        scored.push({
          ...item,
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

  // -------------------------------------------------------------------------
  // Internal: Tag parsing
  // -------------------------------------------------------------------------

  /**
   * Safely parse tags from either a JSON string or an existing array.
   *
   * @param {string|string[]|null} tags
   * @returns {string[]}
   */
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
}
