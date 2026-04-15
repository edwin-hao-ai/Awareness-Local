/**
 * Reranker — F-031 Phase 1 Task 5
 *
 * Two reranking strategies controlled by RERANK_METHOD env var:
 *
 * Method A (default): Signal fusion — no LLM calls
 *   Semantic (50%) + BM25 (20%) + card_type (15%) + growth_stage (10%) + recency (5%)
 *   Aligned with cloud backend memory_recall_ranking.py 5-dimension formula.
 *
 * Method B: Local LLM rerank — quality-first
 *   BM25 + Vector → Top-30 → LLM relevance scoring → Top-K
 *   Falls back to Method A on timeout/error.
 *
 * Both methods are independent modules. Feature flag `RERANK_METHOD`
 * selects which one runs: "fusion" (A) | "llm" (B) | "none" (disabled).
 */

const LOG_PREFIX = '[reranker]';

// Default weights for Method A — aligned with cloud backend 5-dimension formula
const DEFAULT_WEIGHTS = {
  semantic: 0.50,
  bm25: 0.20,
  cardType: 0.15,
  growth: 0.10,
  recency: 0.05,
};

// RRF constant (standard value from literature)
const RRF_K = 60;

// Recency half-life in days
const RECENCY_HALF_LIFE_DAYS = 30;

// LLM rerank timeout (Method B)
const LLM_RERANK_TIMEOUT_MS = parseInt(process.env.LLM_RERANK_TIMEOUT_MS || '5000', 10);

/**
 * Get the active rerank method from env.
 * @returns {"fusion"|"llm"|"none"}
 */
export function getRerankMethod() {
  return (process.env.RERANK_METHOD || 'fusion').toLowerCase();
}

/**
 * Main rerank entry point. Routes to the active method.
 *
 * @param {Array<Object>} results - Search results with available signals
 * @param {string} query - Original search query
 * @param {Object} [options]
 * @param {Object} [options.weights] - Override default fusion weights
 * @param {Function} [options.llmInfer] - Required for method B: async (systemPrompt, userContent) => string
 * @param {number} [options.topK] - Max results to return (default: results.length)
 * @returns {Array<Object>} Reranked results with `rerankScore` field added
 */
export async function rerank(results, query, options = {}) {
  if (!results || results.length === 0) return [];

  const method = getRerankMethod();

  if (method === 'none') {
    return results;
  }

  if (method === 'llm' && options.llmInfer) {
    try {
      return await rerankWithLLM(results, query, options);
    } catch (err) {
      console.warn(`${LOG_PREFIX} LLM rerank failed, falling back to fusion:`, err.message);
      return rerankWithFusion(results, query, options);
    }
  }

  return rerankWithFusion(results, query, options);
}


// =============================================================================
// Method A: Signal Fusion (BM25 + Semantic + Recency + Salience)
// =============================================================================

/**
 * Rerank using weighted signal fusion. No LLM calls.
 *
 * @param {Array<Object>} results
 * @param {string} query
 * @param {Object} [options]
 * @returns {Array<Object>} Sorted by rerankScore (descending)
 */
export function rerankWithFusion(results, query, options = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
  const topK = options.topK || results.length;
  const now = Date.now();

  // Collect raw scores for normalization
  const bm25Scores = results.map(r => extractBM25Score(r));
  const semanticScores = results.map(r => extractSemanticScore(r));

  // Min-max normalize each signal to [0, 1]
  const normBM25 = minMaxNormalize(bm25Scores);
  const normSemantic = minMaxNormalize(semanticScores);

  const scored = results.map((result, i) => {
    const recencyScore = computeRecencyScore(result, now);
    const cardTypeScore = computeCardTypeScore(result);
    const growthScore = computeGrowthStageScore(result);

    const rerankScore =
      normSemantic[i] * weights.semantic +
      normBM25[i] * weights.bm25 +
      cardTypeScore * weights.cardType +
      growthScore * weights.growth +
      recencyScore * weights.recency;

    return {
      ...result,
      rerankScore,
      _rerankSignals: {
        semantic: normSemantic[i],
        bm25: normBM25[i],
        cardType: cardTypeScore,
        growth: growthScore,
        recency: recencyScore,
      },
    };
  });

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  return scored.slice(0, topK);
}


// =============================================================================
// Method B: LLM Rerank (User's local/cloud LLM)
// =============================================================================

const LLM_RERANK_PROMPT = `You are a relevance judge. Given a QUERY and a list of CANDIDATE results, score each candidate from 0.0 to 1.0 based on how relevant it is to the query.

Return ONLY a JSON array of scores in the same order as the candidates.
Example: [0.9, 0.3, 0.7, 0.1, 0.5]

Do NOT include explanations. Output ONLY the JSON array.`;

/**
 * Rerank using the user's LLM endpoint.
 * Top candidates from fusion are sent to LLM for precise scoring.
 *
 * @param {Array<Object>} results
 * @param {string} query
 * @param {Object} options
 * @returns {Array<Object>}
 */
export async function rerankWithLLM(results, query, options = {}) {
  const { llmInfer, topK } = options;
  const preFilterK = Math.min(results.length, 30);

  // Pre-filter with fusion to get top-30
  const prefilteredResults = rerankWithFusion(results, query, { topK: preFilterK });

  // Build candidate list for LLM — limit total chars to avoid context overflow
  const MAX_RERANK_CHARS = 12000;
  let charBudget = MAX_RERANK_CHARS;
  const candidateLines = [];
  for (let i = 0; i < prefilteredResults.length; i++) {
    const r = prefilteredResults[i];
    const line = `[${i}] ${r.title || ''}: ${r.summary || r.content || ''}`;
    if (charBudget - line.length < 0 && candidateLines.length > 5) break;
    candidateLines.push(line);
    charBudget -= line.length;
  }
  const candidateText = candidateLines.join('\n');

  const userContent = `QUERY: ${query}\n\nCANDIDATES:\n${candidateText}`;

  // Call LLM with timeout
  const raw = await withTimeout(
    llmInfer(LLM_RERANK_PROMPT, userContent),
    LLM_RERANK_TIMEOUT_MS,
    'LLM rerank',
  );

  // Parse scores
  const scores = parseLLMScores(raw, prefilteredResults.length);

  // Apply LLM scores
  const scored = prefilteredResults.map((result, i) => ({
    ...result,
    rerankScore: scores[i] ?? result.rerankScore ?? 0,
    _rerankMethod: 'llm',
  }));

  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  return scored.slice(0, topK || scored.length);
}


// =============================================================================
// Signal extractors
// =============================================================================

/**
 * Extract BM25 score from a result.
 * FTS5 bm25() returns negative values (closer to 0 = better).
 * We negate so higher = better.
 */
function extractBM25Score(result) {
  if (result.bm25Score != null) return -result.bm25Score;
  if (result.rank != null) return -result.rank;
  if (result.ftsScore != null) return result.ftsScore;
  return 0;
}

/**
 * Extract semantic similarity score (cosine similarity, 0-1).
 */
function extractSemanticScore(result) {
  return result.embeddingScore ?? result.cosineSimilarity ?? result.semanticScore ?? 0;
}

/**
 * Compute card_type score — aligned with cloud backend.
 * moc = 1.0, index = 0.8, atomic = 0.3 (default)
 */
function computeCardTypeScore(result) {
  const ct = result.card_type || result.metadata?.card_type || 'atomic';
  return CARD_TYPE_SCORES[ct] ?? 0.3;
}

const CARD_TYPE_SCORES = { moc: 1.0, index: 0.8, atomic: 0.3 };

/**
 * Compute growth_stage score — aligned with cloud backend.
 * evergreen = 1.0, budding = 0.6, seedling = 0.3 (default)
 */
function computeGrowthStageScore(result) {
  const gs = result.growth_stage || result.metadata?.growth_stage || 'seedling';
  return GROWTH_STAGE_SCORES[gs] ?? 0.3;
}

const GROWTH_STAGE_SCORES = { evergreen: 1.0, budding: 0.6, seedling: 0.3 };

/**
 * Compute recency score using exponential decay.
 * Returns 0-1 where 1 = just now, 0.5 = HALF_LIFE days ago.
 */
function computeRecencyScore(result, now) {
  const createdAt = result.created_at || result.createdAt;
  if (!createdAt) return 0.5; // neutral default
  const ts = typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt;
  if (isNaN(ts)) return 0.5;
  const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}


// =============================================================================
// Utilities
// =============================================================================

/**
 * Min-max normalize an array of scores to [0, 1].
 * If all values are equal, returns 0.5 for all.
 */
function minMaxNormalize(scores) {
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => 0.5);
  return scores.map(s => (s - min) / range);
}

/**
 * Parse LLM scores output. Expects a JSON array of numbers.
 */
function parseLLMScores(raw, expectedLength) {
  const defaultScores = new Array(expectedLength).fill(0.5);
  if (!raw) return defaultScores;

  let cleaned = raw.trim();
  // Strip markdown fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return defaultScores;
    // Pad or trim to expected length
    return Array.from({ length: expectedLength }, (_, i) => {
      const val = parsed[i];
      if (typeof val === 'number' && val >= 0 && val <= 1) return val;
      return 0.5;
    });
  } catch {
    console.warn(`${LOG_PREFIX} failed to parse LLM rerank scores`);
    return defaultScores;
  }
}

/**
 * Timeout wrapper.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms);
    promise
      .then(val => { clearTimeout(timer); resolve(val); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}
