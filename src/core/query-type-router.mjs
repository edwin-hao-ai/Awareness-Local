/**
 * F-053 Phase 3 · Query-type auto routing.
 *
 * Classifies an incoming query into one of ten archetypes by cosine
 * similarity to pre-computed archetype embeddings, then picks a
 * cascade strategy (raw-heavy / card-heavy / graph-heavy / etc.) for
 * `unifiedCascadeSearch` to consume.
 *
 * Zero keyword hard-coding. The ten archetypes are stored as English
 * strings, but recognition is multilingual via `multilingual-e5-small`
 * embedding — a Chinese "为什么选 X" maps to the same archetype as the
 * English "why did we pick X" because the embedding space is shared.
 *
 * Design doc: `docs/features/f-053/PHASE_3_DESIGN.md`
 * Acceptance: `docs/features/f-053/ACCEPTANCE.md` Journey 6
 */

import { embed, cosineSimilarity, MODEL_MAP } from './embedder.mjs';

// ---------------------------------------------------------------------------
// Archetype catalogue — the ONLY place where language-specific text lives.
// ---------------------------------------------------------------------------

/**
 * Ten archetype queries covering the shapes we see in production.
 * Order matters for stable tie-breaking; never reorder without updating
 * tests that pin archetype index positions.
 */
// Each archetype's `text` is a concatenation of natural phrasings that
// real users (or LLMs rewriting user input) actually emit. More diverse
// training anchors → tighter embedding cluster → higher classifier
// accuracy. Numbers below are the minimum distinct phrasings that
// empirically hold the archetype together under multilingual-e5-small.
export const ARCHETYPES = Object.freeze([
  {
    id: 'decision-why',
    text: 'Why did we decide this approach. Why did we pick this option over alternatives. What was the reasoning behind this choice. Why are we using this instead of that.',
  },
  {
    id: 'fact-what',
    text: 'Definition of this term. Give me the meaning. Describe this concept in words. I want to know what this refers to. Please explain this word.',
  },
  {
    id: 'procedure-how',
    text: 'How do I do this. How to perform this task. Walk me through the steps. What are the steps to X.',
  },
  {
    id: 'list-enum',
    text: 'List all the things we have. Show me every instance. Enumerate everything of this type. What are all the X.',
  },
  {
    id: 'recall-recent',
    text: 'Remind me what we discussed recently. What did we just cover. What were we doing. Continue where we left off last time. Summary of today. Most recent changes. What happened in the last session.',
  },
  {
    id: 'temporal-when',
    text: 'When did this happen. What date did we do this. At what time did X occur. On which day was this.',
  },
  {
    id: 'spatial-where',
    text: 'Where is this located. Which file contains this. What directory has X. Where can I find this.',
  },
  {
    id: 'identity-who',
    text: 'Who is this person. What is the user named. What role does this person have. Who is responsible for X.',
  },
  {
    id: 'compare-contrast',
    text: 'Compare A versus B. Pros and cons of these options. Differences between X and Y. Trade-offs of each choice.',
  },
  {
    id: 'diagnose-problem',
    text: 'This is broken — why. Root cause of the failure. The bug that is causing this error. Why the system is misbehaving.',
  },
]);

/**
 * Strategy map keyed by archetype id. Each entry overrides a subset of the
 * Phase 1c `BUDGET_TIER_RAW_RATIO` / graph limit / card-type boost defaults
 * that `unifiedCascadeSearch` would otherwise use.
 *
 * The numbers start conservative (±30pp from the Phase 1c tier ratios) and
 * are meant to be tuned by benchmark feedback, not hand-crafted perfection.
 */
export const STRATEGY = Object.freeze({
  'decision-why':     { rawRatio: 0.80, graphBoost: 0.0, clusterExpand: false },
  'fact-what':        { rawRatio: 0.10, graphBoost: 0.0, clusterExpand: false },
  'procedure-how':    { rawRatio: 0.40, graphBoost: 0.1, clusterExpand: false },
  'list-enum':        { rawRatio: 0.30, graphBoost: 0.5, clusterExpand: true  },
  'recall-recent':    { rawRatio: 0.75, graphBoost: 0.0, clusterExpand: false, recencyBoost: 1.5 },
  'temporal-when':    { rawRatio: 0.20, graphBoost: 0.0, clusterExpand: false },
  'spatial-where':    { rawRatio: 0.20, graphBoost: 0.6, clusterExpand: false },
  'identity-who':     { rawRatio: 0.10, graphBoost: 0.0, clusterExpand: false },
  'compare-contrast': { rawRatio: 0.45, graphBoost: 0.1, clusterExpand: true  },
  'diagnose-problem': { rawRatio: 0.20, graphBoost: 0.0, clusterExpand: false,
                        cardTypeBoost: { pitfall: 2.0, problem_solution: 1.8 } },
});

/**
 * Minimum cosine similarity required to trust a classification. Below this
 * threshold we fall back to the Phase 1c default (no override). The value
 * is tight enough to avoid false routing on truly out-of-distribution
 * queries (greetings, garbled input, very short strings) while being loose
 * enough that paraphrased archetypes still match.
 */
export const CONFIDENCE_THRESHOLD = 0.25;

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/**
 * Build the archetype embedding index. Call once at daemon boot and pass
 * the returned object into `classifyQuery()` on every request.
 *
 * @param {{ embed?: Function }} [overrides] - Optional embed override
 *   (used by tests to inject a deterministic mock).
 * @returns {Promise<{ vectors: Float32Array[], ids: string[], language: string, modelId: string }>}
 * @throws If the embedder module is unavailable and no override is provided.
 */
export async function buildArchetypeIndex(overrides = {}) {
  const embedFn = overrides.embed || embed;
  const language = 'multilingual';
  const modelId = MODEL_MAP[language];

  const ids = ARCHETYPES.map((a) => a.id);
  const vectors = [];
  for (const a of ARCHETYPES) {
    const vec = await embedFn(a.text, 'passage', language);
    if (!(vec instanceof Float32Array) || vec.length === 0) {
      throw new Error(`archetype embed failed for ${a.id}`);
    }
    vectors.push(vec);
  }

  return { vectors, ids, language, modelId };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a query by cosine similarity to the archetype index.
 *
 * @param {string} query
 * @param {{ vectors: Float32Array[], ids: string[], language: string } | null} index
 *   The object returned by `buildArchetypeIndex()`, or null to force fallback.
 * @param {{ embed?: Function }} [overrides]
 * @returns {Promise<{
 *   archetype: string|null,
 *   confidence: number,
 *   strategy: object|null,
 *   fallbackReason?: string
 * }>}
 */
export async function classifyQuery(query, index, overrides = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    return { archetype: null, confidence: 0, strategy: null, fallbackReason: 'empty-query' };
  }
  if (!index || !Array.isArray(index.vectors) || index.vectors.length === 0) {
    return { archetype: null, confidence: 0, strategy: null, fallbackReason: 'index-unavailable' };
  }

  const embedFn = overrides.embed || embed;
  let qVec;
  try {
    qVec = await embedFn(query.trim(), 'query', index.language || 'multilingual');
  } catch (err) {
    return { archetype: null, confidence: 0, strategy: null, fallbackReason: `embed-failed: ${err.message}` };
  }
  if (!(qVec instanceof Float32Array) || qVec.length === 0) {
    return { archetype: null, confidence: 0, strategy: null, fallbackReason: 'embed-empty' };
  }

  // Argmax cosine — vectors are normalised by `pipe({ normalize: true })`
  // in embedder.mjs, so cosineSimilarity is a dot product here.
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < index.vectors.length; i++) {
    const score = cosineSimilarity(qVec, index.vectors[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < CONFIDENCE_THRESHOLD) {
    return {
      archetype: null,
      confidence: bestScore === -Infinity ? 0 : bestScore,
      strategy: null,
      fallbackReason: `below-threshold (${bestScore.toFixed(3)} < ${CONFIDENCE_THRESHOLD})`,
    };
  }

  const archetype = index.ids[bestIdx];
  const strategy = STRATEGY[archetype] || null;
  return { archetype, confidence: bestScore, strategy };
}

/**
 * Convenience accessor: strategy lookup without classification. Useful for
 * callers that already know which archetype they want (e.g. explicit
 * "awareness_recall" with a debug override).
 *
 * @param {string} archetypeId
 * @returns {object|null}
 */
export function getStrategy(archetypeId) {
  return STRATEGY[archetypeId] || null;
}
