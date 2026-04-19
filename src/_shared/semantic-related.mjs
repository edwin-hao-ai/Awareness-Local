// ⚠️  DO NOT EDIT — synced from sdks/_shared/js/semantic-related.mjs
// Edit the SSOT and run `node scripts/sync-shared-js.mjs`.
/**
 * Embedding-cosine semantic relatedness check. Pure, no deps.
 *
 * Replaces hardcoded stop-tag / domain lists. Caller passes embedFn + cosineFn
 * so this file stays fully decoupled from any specific embedder.
 *
 * SSOT: sdks/_shared/js/semantic-related.mjs
 * Sync: scripts/sync-shared-js.mjs distributes to each SDK's src/_shared/.
 */

/**
 * @param {object} params
 * @param {string} params.newText        - title+summary of the new card
 * @param {string} params.candidateText  - title+summary of the existing card
 * @param {object} [opts]
 * @param {Function} [opts.embedFn]      - async (text, role?) => Float32Array
 * @param {Function} [opts.cosineFn]     - (a, b) => number in [-1, 1]
 * @param {number}  [opts.threshold=0.55]
 * @returns {Promise<{ related: boolean, similarity: number, reason: string }>}
 */
export async function isSemanticallyRelated(params, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.55;
  const { newText = '', candidateText = '' } = params || {};
  const a = String(newText).trim();
  const b = String(candidateText).trim();

  if (!a || !b) return { related: false, similarity: 0, reason: 'empty_text' };

  if (typeof opts.embedFn !== 'function' || typeof opts.cosineFn !== 'function') {
    return { related: false, similarity: 0, reason: 'no_embedder' };
  }

  try {
    const [vecA, vecB] = await Promise.all([
      opts.embedFn(a, 'query'),
      opts.embedFn(b, 'passage'),
    ]);
    const sim = opts.cosineFn(vecA, vecB);
    return {
      related: sim >= threshold,
      similarity: sim,
      reason: sim >= threshold ? 'semantic_match' : 'below_threshold',
    };
  } catch (err) {
    return {
      related: false,
      similarity: 0,
      reason: `embedder_error:${err?.message || 'unknown'}`,
    };
  }
}
