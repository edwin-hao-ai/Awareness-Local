/**
 * Card evolution · F-058 follow-up fix.
 *
 * Before this module, every submit_insights call created a NEW row in
 * knowledge_cards — even when the LLM was clearly submitting an updated
 * version of an existing card (same topic, richer content). The knowledge
 * store accumulated duplicates; recall returned 3 "pgvector vs Pinecone"
 * decisions from different weeks with no way to tell which is current.
 *
 * Fix: when a new card arrives, find the best matching active card of the
 * same category using BM25 (to narrow candidates cheaply) + cosine
 * similarity over title+summary embeddings (to score). If a candidate
 * clears the threshold, the new card is linked (parent_card_id) and the
 * old one is marked `status='superseded'` + evolution_type='update'.
 *
 * Fails OPEN: if embedder isn't loaded, or search errors, or no candidate
 * clears the bar — we just insert the card as 'initial' (current behaviour).
 */

const DEFAULT_COSINE_THRESHOLD = 0.85;
const DEFAULT_MAX_CANDIDATES = 5;

// P1 Fix-5b · 4-verdict thresholds (aligned with core/knowledge-extractor.mjs)
const VECTOR_DUPLICATE_THRESHOLD = 0.95;
const VECTOR_UPDATE_THRESHOLD = 0.85;
const VECTOR_MERGE_THRESHOLD = 0.70;

/**
 * Find the best-matching existing card that this new card supersedes.
 *
 * @param {object} indexer
 * @param {object} newCard - {category, title, summary, tags}
 * @param {object} embedder - {embed(text, role?), cosineSimilarity(a, b)}
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.85]
 * @param {number} [opts.maxCandidates=5]
 * @returns {Promise<{target: object, similarity: number}|null>}
 */
export async function findEvolutionTarget(indexer, newCard, embedder, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_COSINE_THRESHOLD;
  const maxCandidates = opts.maxCandidates || DEFAULT_MAX_CANDIDATES;

  if (!indexer?.db || !newCard?.title || !embedder?.embed || !embedder?.cosineSimilarity) {
    return null;
  }

  const category = String(newCard.category || '').trim();
  const newText = `${newCard.title} ${newCard.summary || ''}`.trim();
  if (!newText) return null;

  // Candidate shortlist via BM25 over knowledge_cards_fts (fall back to
  // recent cards in the same category if FTS is unavailable).
  let candidates = [];
  try {
    const bm25Rows = indexer.db.prepare(`
      SELECT kc.* FROM knowledge_cards kc
      JOIN knowledge_cards_fts fts ON kc.id = fts.id
      WHERE knowledge_cards_fts MATCH ?
        AND kc.status = 'active'
        ${category ? "AND kc.category = ?" : ''}
      ORDER BY rank
      LIMIT ?
    `).all(
      ...(category
        ? [escapeFtsQuery(newCard.title), category, maxCandidates]
        : [escapeFtsQuery(newCard.title), maxCandidates]),
    );
    candidates = bm25Rows;
  } catch {
    // FTS not available or malformed query — fall back to recent same-category
    try {
      const sql = category
        ? `SELECT * FROM knowledge_cards WHERE status = 'active' AND category = ? ORDER BY created_at DESC LIMIT ?`
        : `SELECT * FROM knowledge_cards WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`;
      candidates = category
        ? indexer.db.prepare(sql).all(category, maxCandidates)
        : indexer.db.prepare(sql).all(maxCandidates);
    } catch {
      return null;
    }
  }

  if (candidates.length === 0) return null;

  // Embed the new card once; re-embed each candidate (title+summary).
  let newVec;
  try {
    newVec = await embedder.embed(newText, 'query');
  } catch {
    return null;
  }
  if (!newVec) return null;

  let best = null;
  for (const candidate of candidates) {
    const candText = `${candidate.title} ${candidate.summary || ''}`.trim();
    if (!candText) continue;
    try {
      const candVec = await embedder.embed(candText, 'passage');
      const sim = embedder.cosineSimilarity(newVec, candVec);
      if (Number.isFinite(sim) && (!best || sim > best.similarity)) {
        best = { target: candidate, similarity: sim };
      }
    } catch {
      // Skip this candidate on error
    }
  }

  if (!best || best.similarity < threshold) return null;
  return best;
}

/**
 * P1 Fix-5b · 4-verdict classification for an incoming card, mirroring
 * `core/knowledge-extractor.mjs::_checkConflict` so the LLM-submitted
 * path and the rule-based path apply the same evolution rules.
 *
 * Verdicts:
 *   duplicate — cosine ≥ 0.95 → drop the new card
 *   merge     — cosine ≥ 0.85 with shorter-summary + tag overlap → merge content
 *             OR cosine ≥ 0.70 with same-category + tag overlap → merge content
 *   update    — cosine ≥ 0.85 otherwise → new card supersedes old
 *   new       — no qualifying neighbour
 *
 * @param {object} indexer
 * @param {object} newCard   {category, title, summary, tags}
 * @param {object} embedder  {embed, cosineSimilarity}
 * @param {object} [opts]
 * @returns {Promise<{verdict: string, target?: object, similarity?: number}>}
 */
// F-059 · personal categories where a "different identity tag" on each
// side (e.g. vim vs zed, macOS vs Linux) signals the user CHANGED their
// mind rather than added detail. For these categories, divergent tags
// flip merge → update so the old preference is superseded instead of
// being silently blended. Technical categories still merge on tag
// overlap because "added a new flag to the same workflow" is common.
const PREFERENCE_CATEGORIES = new Set([
  'personal_preference', 'plan_intention', 'activity_preference',
  'health_info', 'career_info',
]);

/**
 * Detect "divergent identity tags": each side has ≥1 non-generic tag
 * the other doesn't have. Generic tags (e.g. "editor", "tool") are
 * ignored because they're shared category labels, not identity tokens.
 */
const GENERIC_PREFERENCE_TAGS = new Set([
  'editor', 'tool', 'language', 'framework', 'preference', 'habit',
  'workflow', 'hobby', 'food', 'drink', 'general', 'misc',
]);

function hasDivergentIdentityTags(a, b) {
  const aSet = new Set((a || []).map((t) => String(t).toLowerCase()));
  const bSet = new Set((b || []).map((t) => String(t).toLowerCase()));
  const aOnly = [...aSet].filter((t) => !bSet.has(t) && !GENERIC_PREFERENCE_TAGS.has(t));
  const bOnly = [...bSet].filter((t) => !aSet.has(t) && !GENERIC_PREFERENCE_TAGS.has(t));
  return aOnly.length > 0 && bOnly.length > 0;
}

export async function classifyCard(indexer, newCard, embedder, opts = {}) {
  // F-059 · personal preferences use shorter summaries so the same
  // semantic distance yields a lower cosine score. Drop threshold to
  // 0.50 for personal categories so contradiction detection has a
  // chance to fire. Technical cards keep the stricter 0.70 bar to
  // avoid spurious merges across different topics.
  const isPersonal = PREFERENCE_CATEGORIES.has(newCard.category || '');
  const threshold = isPersonal ? 0.50 : VECTOR_MERGE_THRESHOLD;
  const match = await findEvolutionTarget(indexer, newCard, embedder, {
    ...opts,
    threshold,
  });
  if (!match) return { verdict: 'new' };

  const { target, similarity } = match;

  if (similarity >= VECTOR_DUPLICATE_THRESHOLD) {
    return { verdict: 'duplicate', target, similarity };
  }

  const incomingTags = Array.isArray(newCard.tags) ? newCard.tags : [];
  const targetTags = parseTags(target.tags);
  const tagsOverlap = hasTagOverlap(incomingTags, targetTags);
  const sameCategory = (newCard.category || '') === (target.category || '');
  const incomingLen = (newCard.summary || '').length;
  const targetLen = (target.summary || '').length;

  // F-059 · for personal preference categories, divergent identity tags
  // mean the user changed their mind. Force `update` (supersedes old)
  // instead of falling into the merge branches below.
  if (
    sameCategory &&
    PREFERENCE_CATEGORIES.has(newCard.category || '') &&
    hasDivergentIdentityTags(incomingTags, targetTags)
  ) {
    return { verdict: 'update', target, similarity, reason: 'personal_preference_contradiction' };
  }

  if (similarity >= VECTOR_UPDATE_THRESHOLD) {
    // Mirror backend rule: shorter new summary + tag overlap → merge
    if (incomingLen <= targetLen && tagsOverlap) {
      return { verdict: 'merge', target, similarity };
    }
    return { verdict: 'update', target, similarity };
  }

  // similarity >= VECTOR_MERGE_THRESHOLD (0.70) — only merge when same
  // category + tag overlap, else treat as new card.
  if (sameCategory && tagsOverlap) {
    return { verdict: 'merge', target, similarity };
  }
  return { verdict: 'new' };
}

/**
 * Merge an incoming card's summary into an existing active card.
 * Preserves v1 content, appends v2 below a `---` separator, bumps version.
 *
 * @param {object} indexer
 * @param {string} targetId
 * @param {object} newCard
 * @returns {{merged: boolean, newSummary?: string}}
 */
export function mergeIntoCard(indexer, targetId, newCard) {
  if (!indexer?.db || !targetId) return { merged: false };
  try {
    const existing = indexer.db
      .prepare('SELECT id, title, summary FROM knowledge_cards WHERE id = ? AND status = ?')
      .get(targetId, 'active');
    if (!existing) return { merged: false };

    const incomingSummary = String(newCard?.summary || '').trim();
    if (!incomingSummary) return { merged: false };

    const newSummary = existing.summary
      ? `${existing.summary}\n\n---\n${incomingSummary}`
      : incomingSummary;

    indexer.db.prepare(`
      UPDATE knowledge_cards
      SET summary = ?, version = COALESCE(version, 1) + 1,
          last_touched_at = ?, synced_to_cloud = 0
      WHERE id = ?
    `).run(newSummary, new Date().toISOString(), targetId);

    return { merged: true, newSummary };
  } catch (err) {
    console.warn(`[card-evolution] Merge failed for ${targetId}:`, err.message);
    return { merged: false };
  }
}

function parseTags(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function hasTagOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(a.map((t) => String(t).toLowerCase().trim()));
  for (const t of b) {
    if (setA.has(String(t).toLowerCase().trim())) return true;
  }
  return false;
}

/**
 * Mark a card as superseded by another.
 *
 * @param {object} indexer
 * @param {string} parentId - card to mark as superseded
 * @param {string} childId  - the replacement card
 */
export function supersedeCard(indexer, parentId, childId) {
  if (!indexer?.db || !parentId) return;
  try {
    indexer.db.prepare(`
      UPDATE knowledge_cards
      SET status = 'superseded', updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(new Date().toISOString(), parentId);
  } catch (err) {
    console.warn(`[card-evolution] Failed to supersede card ${parentId}:`, err.message);
  }
}

// FTS5 MATCH is intolerant of quotes and special chars. Strip them.
// FTS5 defaults to AND between terms — we want candidates that share ANY
// meaningful token with the new card's title, so we OR them together.
function escapeFtsQuery(text) {
  const tokens = String(text || '')
    .replace(/["'(){}\[\]*:!]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  return tokens.join(' OR ');
}
