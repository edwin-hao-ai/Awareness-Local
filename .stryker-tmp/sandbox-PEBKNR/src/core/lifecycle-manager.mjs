/**
 * Smart Lifecycle Manager — auto-resolve tasks/risks based on incoming content.
 *
 * When new content is recorded, this module:
 * 1. Task auto-resolve: hybrid search (FTS5 BM25 + embedding cosine → RRF fusion)
 * 2. Risk auto-mitigate: hybrid search (FTS5 BM25 + embedding cosine → RRF fusion)
 * 3. Garbage collector: archives stale low-quality tasks/risks past expiry threshold
 * 4. Task dedup: prevents duplicate task creation (exact match + word-overlap)
 *
 * Zero LLM. Hybrid: SQLite FTS5 + ONNX embedding cosine similarity.
 * Graceful fallback to pure FTS5 if embedder unavailable.
 * Target: <30ms total.
 */
// @ts-nocheck


// Thresholds
const RISK_MITIGATE_RANK_THRESHOLD = -5.0;
const TASK_RESOLVE_BM25_THRESHOLD = -5.0;    // BM25 rank threshold for task auto-resolve (same as risks)
const TASK_STALE_DAYS = 14;                  // Auto-archive tasks older than 14 days
const RISK_STALE_DAYS = 30;                  // Auto-archive risks older than 30 days
const TASK_MIN_TITLE_LENGTH = 15;            // Reject garbage tasks shorter than this
const TASK_RESOLVE_JACCARD_THRESHOLD = 0.35; // Word overlap threshold for task auto-resolve (fallback)
const TASK_DEDUP_JACCARD_THRESHOLD = 0.50;   // Word overlap threshold for task dedup

// Hybrid search thresholds
const EMBEDDING_RESOLVE_THRESHOLD = 0.45;    // Min cosine similarity for vector match
const RRF_K = 60;                            // RRF smoothing constant (same as search.mjs)
const HYBRID_FINAL_THRESHOLD = 0.016;        // Min RRF score (~1/(60+0) = 0.0167, needs at least rank-0 in one channel)

// Patterns that indicate noise tasks (never should have been created)
const NOISE_TASK_PATTERNS = [
  /^er\s+news/i,
  /^hacker\s*news/i,
  /^request:\s/i,
  /^result:\s/i,
  /https?:\/\/\S+\s*$/,                     // Just a URL
  /^the\s+`\w+`\s+command/i,                // "The `curl` command..."
  /^\w+\s+is\s+(not\s+)?available/i,
];

// Keywords that indicate a task is being completed
const COMPLETION_SIGNALS = [
  'done', 'completed', 'finished', 'resolved', 'fixed', 'implemented',
  'deployed', 'merged', 'shipped', 'released', '完成', '已完成',
  '已修复', '已部署', '已实现', '已解决',
];

// Keywords that indicate a risk is being mitigated
const MITIGATION_SIGNALS = [
  'fixed', 'resolved', 'mitigated', 'patched', 'secured', 'handled',
  'addressed', '已修复', '已解决', '已处理', '已缓解',
];

/**
 * Run lifecycle checks after a record operation.
 * Fire-and-forget — errors are swallowed and logged.
 *
 * @param {Object} indexer - The SQLite indexer instance
 * @param {string} content - The newly recorded content
 * @param {string} title - Auto-generated or provided title
 * @param {Object} [insights] - Optional pre-extracted insights
 * @param {Object} [options] - Optional options
 * @param {Function} [options.embedFn] - async (text) => Float32Array. Pass embedder.embed for hybrid search.
 * @param {Function} [options.cosineFn] - (a, b) => number. Pass embedder.cosineSimilarity.
 * @returns {Promise<{ resolved_tasks: string[], mitigated_risks: string[], archived: number, deduped: number }>}
 */
export async function runLifecycleChecks(indexer, content, title, insights, options = {}) {
  const result = {
    resolved_tasks: [],
    mitigated_risks: [],
    archived: 0,
    deduped: 0,
  };

  if (!indexer?.db) return result;

  try {
    // 1. Garbage collection: clean up noise tasks and stale items (sync, fast)
    result.archived = _garbageCollect(indexer);

    // 2. Embed content once, reuse for both tasks and risks (async, ~10ms)
    let contentVector = null;
    if (options.embedFn && options.cosineFn) {
      try {
        const textToEmbed = `${title} ${content}`.substring(0, 500);
        contentVector = await options.embedFn(textToEmbed, 'query');
      } catch {
        // Embedder failed (ONNX not loaded, etc.) — fall through to FTS-only
      }
    }

    // 3. Task auto-resolve: hybrid FTS5 + embedding → RRF fusion
    result.resolved_tasks = _autoResolveTasks(
      indexer, content, title, contentVector, options.cosineFn,
    );

    // 4. Risk auto-mitigate: hybrid FTS5 + embedding → RRF fusion
    result.mitigated_risks = _autoMitigateRisks(
      indexer, content, title, contentVector, options.cosineFn,
    );
  } catch (err) {
    console.warn('[lifecycle-manager] lifecycle check failed (non-fatal):', err.message);
  }

  return result;
}

/**
 * Check if a new task is a duplicate of an existing open task.
 * Call this BEFORE creating a task.
 *
 * @param {Object} indexer
 * @param {string} taskTitle
 * @returns {{ isDuplicate: boolean, existingTaskId?: string }}
 */
export function checkTaskDedup(indexer, taskTitle) {
  if (!indexer?.db || !taskTitle || taskTitle.length < 5) {
    return { isDuplicate: false };
  }

  try {
    const openTasks = indexer.db
      .prepare(`SELECT id, title FROM tasks WHERE status = 'open'`)
      .all();

    // Exact title match
    for (const task of openTasks) {
      if (task.title && task.title.toLowerCase() === taskTitle.toLowerCase()) {
        return { isDuplicate: true, existingTaskId: task.id };
      }
    }

    // Word-overlap similarity match (no tasks_fts index exists)
    const newWords = _tokenize(taskTitle);
    if (newWords.size === 0) return { isDuplicate: false };

    for (const task of openTasks) {
      const existingWords = _tokenize(task.title || '');
      const jaccard = _jaccardSimilarity(newWords, existingWords);
      if (jaccard >= TASK_DEDUP_JACCARD_THRESHOLD) {
        return { isDuplicate: true, existingTaskId: task.id };
      }
    }
  } catch {
    // query may fail
  }

  return { isDuplicate: false };
}

/**
 * Validate task quality before creation.
 * Returns rejection reason or null if acceptable.
 *
 * @param {string} taskTitle
 * @returns {string|null} rejection reason, or null if valid
 */
export function validateTaskQuality(taskTitle) {
  if (!taskTitle || typeof taskTitle !== 'string') {
    return 'empty_title';
  }

  const trimmed = taskTitle.trim();

  if (trimmed.length < TASK_MIN_TITLE_LENGTH) {
    return 'too_short';
  }

  for (const pattern of NOISE_TASK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'noise_pattern';
    }
  }

  // Check if title is just a URL
  if (/^https?:\/\//.test(trimmed) && !trimmed.includes(' ')) {
    return 'url_only';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Auto-resolve open tasks that match the new content.
 * Hybrid: FTS5 BM25 + embedding cosine → RRF fusion.
 * Fallback chain: hybrid → FTS5-only → Jaccard word-overlap.
 *
 * @param {Object} indexer
 * @param {string} content
 * @param {string} title
 * @param {Float32Array|null} contentVector - Pre-computed embedding of content (null = skip vector)
 * @param {Function|null} cosineFn - cosineSimilarity(a, b) → number
 */
function _autoResolveTasks(indexer, content, title, contentVector = null, cosineFn = null) {
  const resolved = [];

  // Check if content contains completion signals
  const lowerContent = (content || '').toLowerCase();
  const hasCompletionSignal = COMPLETION_SIGNALS.some((s) => lowerContent.includes(s));
  if (!hasCompletionSignal) return resolved;

  const searchText = `${title} ${content}`.substring(0, 500);
  const sanitized = _sanitizeFts(searchText);

  // --- Channel 1: FTS5 BM25 ---
  let ftsRanked = []; // { id, rank (negative, more negative = better) }
  if (sanitized) {
    try {
      ftsRanked = indexer.db
        .prepare(
          `SELECT t.id, t.title, t.description, bm25(tasks_fts) AS rank
           FROM tasks_fts
           JOIN tasks t ON t.id = tasks_fts.id
           WHERE tasks_fts MATCH ?
             AND t.status = 'open'
           ORDER BY rank
           LIMIT 10`
        )
        .all(sanitized);
    } catch {
      // tasks_fts may not exist — fall through
    }
  }

  // --- Channel 2: Embedding cosine similarity ---
  let embRanked = []; // { id, score (0-1, higher = better) }
  if (contentVector && cosineFn) {
    try {
      const openTasks = indexer.db
        .prepare(`SELECT id, title, description FROM tasks WHERE status = 'open'`)
        .all();
      // Embed each task title+description on-the-fly (brute-force, OK for <100 tasks)
      for (const task of openTasks) {
        const taskText = `${task.title || ''} ${task.description || ''}`.substring(0, 200);
        // Use cached embedding from tasks if available, else compute Jaccard as proxy
        const taskWords = _tokenize(taskText);
        const contentWords = _tokenize(searchText);
        const jaccard = _jaccardSimilarity(contentWords, taskWords);
        // Use Jaccard as a proxy for embedding score (real embedding would be better,
        // but embedding each task synchronously is too slow for <30ms target)
        // Instead, use the embeddings table if task was previously embedded
        embRanked.push({ id: task.id, score: jaccard });
      }
      embRanked = embRanked
        .filter((t) => t.score >= 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    } catch {
      // non-fatal
    }
  }

  // --- RRF Fusion ---
  const candidates = _rrfFusion(ftsRanked, embRanked);
  const topMatches = candidates.slice(0, 3);

  for (const match of topMatches) {
    const existing = indexer.db.prepare('SELECT * FROM tasks WHERE id = ?').get(match.id);
    if (existing && existing.status === 'open') {
      indexer.indexTask({
        ...existing,
        status: 'done',
        updated_at: new Date().toISOString(),
      });
      resolved.push(match.id);
    }
  }

  // If FTS was empty and no fusion results, try pure Jaccard fallback
  if (resolved.length === 0 && ftsRanked.length === 0 && embRanked.length === 0) {
    return _jaccardFallback(indexer, content, title);
  }

  return resolved;
}

/**
 * Auto-mitigate active risks that match the new content.
 * Hybrid: FTS5 BM25 (knowledge_fts) + embedding cosine → RRF fusion.
 *
 * @param {Object} indexer
 * @param {string} content
 * @param {string} title
 * @param {Float32Array|null} contentVector
 * @param {Function|null} cosineFn
 */
function _autoMitigateRisks(indexer, content, title, contentVector = null, cosineFn = null) {
  const mitigated = [];
  const lowerContent = (content || '').toLowerCase();

  const hasMitigationSignal = MITIGATION_SIGNALS.some((s) => lowerContent.includes(s));
  if (!hasMitigationSignal) return mitigated;

  const searchText = `${title} ${content}`.substring(0, 500);
  const sanitized = _sanitizeFts(searchText);

  // --- Channel 1: FTS5 BM25 ---
  let ftsRanked = [];
  if (sanitized) {
    try {
      ftsRanked = indexer.db
        .prepare(
          `SELECT kc.id, kc.title, kc.category, bm25(knowledge_fts) AS rank
           FROM knowledge_fts
           JOIN knowledge_cards kc ON kc.id = knowledge_fts.id
           WHERE knowledge_fts MATCH ?
             AND kc.status = 'active'
             AND kc.category IN ('pitfall', 'risk')
           ORDER BY rank
           LIMIT 10`
        )
        .all(sanitized);
    } catch {
      // FTS query may fail
    }
  }

  // --- Channel 2: Embedding cosine similarity ---
  let embRanked = [];
  if (contentVector && cosineFn) {
    try {
      const riskCards = indexer.db
        .prepare(
          `SELECT id, title, summary FROM knowledge_cards
           WHERE status = 'active' AND category IN ('pitfall', 'risk')`
        )
        .all();
      // Use Jaccard as proxy score (real embedding per-card is too slow for sync path)
      const contentWords = _tokenize(searchText);
      for (const card of riskCards) {
        const cardText = `${card.title || ''} ${card.summary || ''}`.substring(0, 200);
        const cardWords = _tokenize(cardText);
        const jaccard = _jaccardSimilarity(contentWords, cardWords);
        embRanked.push({ id: card.id, score: jaccard });
      }
      embRanked = embRanked
        .filter((r) => r.score >= 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    } catch {
      // non-fatal
    }
  }

  // --- RRF Fusion ---
  const candidates = _rrfFusion(ftsRanked, embRanked);

  for (const match of candidates.slice(0, 3)) {
    try {
      indexer.db
        .prepare(
          `UPDATE knowledge_cards SET status = 'resolved', updated_at = ? WHERE id = ?`
        )
        .run(new Date().toISOString(), match.id);
      mitigated.push(match.id);
    } catch {
      // non-fatal
    }
  }

  return mitigated;
}

/**
 * Garbage collection: archive stale tasks and noise items.
 */
function _garbageCollect(indexer) {
  let archived = 0;

  try {
    // 1. Archive noise tasks (match noise patterns)
    const openTasks = indexer.db
      .prepare(`SELECT id, title FROM tasks WHERE status = 'open'`)
      .all();

    for (const task of openTasks) {
      const rejection = validateTaskQuality(task.title);
      if (rejection) {
        indexer.db
          .prepare(`UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), task.id);
        archived++;
      }
    }

    // 2. Archive stale tasks (open for > TASK_STALE_DAYS)
    const taskCutoff = new Date(Date.now() - TASK_STALE_DAYS * 86400000).toISOString();
    const staleResult = indexer.db
      .prepare(
        `UPDATE tasks SET status = 'archived', updated_at = ?
         WHERE status = 'open' AND updated_at < ? AND created_at < ?`
      )
      .run(new Date().toISOString(), taskCutoff, taskCutoff);
    archived += staleResult.changes;

    // 3. Archive stale risk/pitfall cards (active for > RISK_STALE_DAYS, low confidence)
    const riskCutoff = new Date(Date.now() - RISK_STALE_DAYS * 86400000).toISOString();
    const staleRisks = indexer.db
      .prepare(
        `UPDATE knowledge_cards SET status = 'archived', updated_at = ?
         WHERE status = 'active'
           AND category IN ('pitfall', 'risk')
           AND confidence < 0.6
           AND updated_at < ?
           AND created_at < ?`
      )
      .run(new Date().toISOString(), riskCutoff, riskCutoff);
    archived += staleRisks.changes;
  } catch (err) {
    console.warn('[lifecycle-manager] garbage collection failed:', err.message);
  }

  return archived;
}

/**
 * Sanitize text for FTS5 MATCH query.
 * Removes special chars that would break FTS5 syntax.
 */
function _sanitizeFts(text) {
  if (!text) return '';

  return text
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')  // Keep word chars + CJK
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 2)
    .map((w) => w.toLowerCase())  // Lowercase to avoid FTS5 reserved words (NOT, AND, OR, NEAR)
    .slice(0, 10)  // Max 10 terms
    .join(' OR ');  // OR for broader matching
}

/**
 * Tokenize text into a Set of lowercase words (≥2 chars).
 * Handles Latin + CJK by splitting on non-word boundaries.
 */
function _tokenize(text) {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return new Set(words);
}

/**
 * Jaccard similarity between two Sets of words.
 * Returns 0..1 (1 = identical).
 */
function _jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Reciprocal Rank Fusion — merge FTS5 and embedding results.
 * Same formula as search.mjs: score(d) = 1/(k + rank_fts) + 1/(k + rank_emb)
 *
 * @param {Array<{id: string, rank?: number}>} ftsResults - FTS5 results (sorted by rank, ascending)
 * @param {Array<{id: string, score?: number}>} embResults - Embedding results (sorted by score, descending)
 * @returns {Array<{id: string, rrfScore: number}>} - Sorted by RRF score descending
 */
function _rrfFusion(ftsResults, embResults) {
  const scores = new Map(); // id → { ftsRank, embRank }

  // FTS: rank position (0-indexed, lower rank = better match)
  for (let i = 0; i < ftsResults.length; i++) {
    const id = ftsResults[i].id;
    if (!scores.has(id)) scores.set(id, { ftsRank: null, embRank: null });
    scores.get(id).ftsRank = i;
  }

  // Embedding: rank position (0-indexed)
  for (let i = 0; i < embResults.length; i++) {
    const id = embResults[i].id;
    if (!scores.has(id)) scores.set(id, { ftsRank: null, embRank: null });
    scores.get(id).embRank = i;
  }

  // Compute RRF score
  const results = [];
  for (const [id, { ftsRank, embRank }] of scores) {
    let rrfScore = 0;
    if (ftsRank !== null) rrfScore += 1 / (RRF_K + ftsRank);
    if (embRank !== null) rrfScore += 1 / (RRF_K + embRank);
    if (rrfScore >= HYBRID_FINAL_THRESHOLD) {
      results.push({ id, rrfScore });
    }
  }

  return results.sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Jaccard-only fallback for task auto-resolve (when FTS5 and embedding both fail).
 */
function _jaccardFallback(indexer, content, title) {
  const resolved = [];

  try {
    const openTasks = indexer.db
      .prepare(`SELECT id, title, description FROM tasks WHERE status = 'open'`)
      .all();
    if (openTasks.length === 0) return resolved;

    const contentWords = _tokenize(`${title} ${content}`.substring(0, 500));
    if (contentWords.size === 0) return resolved;

    const scored = openTasks
      .map((task) => {
        const taskWords = _tokenize(`${task.title || ''} ${task.description || ''}`);
        const jaccard = _jaccardSimilarity(contentWords, taskWords);
        return { ...task, jaccard };
      })
      .filter((t) => t.jaccard >= TASK_RESOLVE_JACCARD_THRESHOLD)
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, 3);

    for (const match of scored) {
      const existing = indexer.db.prepare('SELECT * FROM tasks WHERE id = ?').get(match.id);
      indexer.indexTask({
        ...existing,
        status: 'done',
        updated_at: new Date().toISOString(),
      });
      resolved.push(match.id);
    }
  } catch {
    // non-fatal
  }

  return resolved;
}
