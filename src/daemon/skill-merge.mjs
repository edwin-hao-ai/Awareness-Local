/**
 * Skill merge helpers · P1 Fix-5a.
 *
 * When a same-name skill is re-submitted, preserve v1's content and
 * fold in v2's additions instead of overwriting. Aligns with Hermes
 * self-evolution semantics and the rule-based extractor's append
 * behaviour (core/knowledge-extractor.mjs::_checkSkillEvolution).
 */

/**
 * Merge v2 data into v1. Returns a new skill object ready to UPDATE.
 *
 * - methods           · de-dup by description, v1 order preserved, v2 appended
 * - trigger_conditions· de-dup by pattern, same ordering rule
 * - tags              · de-dup set union
 * - source_card_ids   · set union
 * - summary           · v2 wins only if longer (treat shorter as incomplete)
 * - confidence        · max(v1, v2)
 *
 * @param {object} existing - existing skill row (methods etc are JSON strings)
 * @param {object} incoming - caller-submitted skill shape (may be partial)
 * @returns {object} merged fields
 */
export function mergeSkill(existing, incoming) {
  const existingMethods = parseJson(existing.methods, []);
  const incomingMethods = Array.isArray(incoming.methods) ? incoming.methods : [];
  const mergedMethods = mergeList(
    existingMethods,
    incomingMethods,
    (m) => (String(m?.description || '').trim().toLowerCase()),
  );
  // Renumber steps 1..N so the output is always contiguous.
  const renumbered = mergedMethods.map((m, idx) => ({
    step: idx + 1,
    description: m.description || '',
  }));

  const existingTriggers = parseJson(existing.trigger_conditions, []);
  const incomingTriggers = Array.isArray(incoming.trigger_conditions) ? incoming.trigger_conditions : [];
  const mergedTriggers = mergeList(
    existingTriggers,
    incomingTriggers,
    (t) => String(t?.pattern || '').trim().toLowerCase(),
  );

  const existingTags = parseJson(existing.tags, []);
  const incomingTags = Array.isArray(incoming.tags) ? incoming.tags : [];
  const mergedTags = uniquePreserve(
    [...existingTags, ...incomingTags].map((t) => String(t).trim()).filter(Boolean),
    (t) => t.toLowerCase(),
  );

  const existingCardIds = parseJson(existing.source_card_ids, []);
  const incomingCardIds = Array.isArray(incoming.source_card_ids) ? incoming.source_card_ids : [];
  const mergedCardIds = uniquePreserve(
    [...existingCardIds, ...incomingCardIds].map(String).filter(Boolean),
    (s) => s,
  );

  // Summary: v2 wins only if strictly longer (shorter treated as incomplete).
  const v1Summary = existing.summary || '';
  const v2Summary = incoming.summary || '';
  const summary = v2Summary.length > v1Summary.length ? v2Summary : v1Summary;

  const confidence = Math.max(
    Number.isFinite(existing.confidence) ? existing.confidence : 1.0,
    Number.isFinite(incoming.confidence) ? incoming.confidence : 0,
  );

  return {
    summary,
    methods: JSON.stringify(renumbered),
    trigger_conditions: JSON.stringify(mergedTriggers),
    tags: JSON.stringify(mergedTags),
    source_card_ids: JSON.stringify(mergedCardIds),
    confidence,
    decay_score: 1.0, // UPSERT → reset freshness
  };
}

function parseJson(v, fallback) {
  if (!v) return fallback;
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}

function mergeList(a, b, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of [...a, ...b]) {
    if (!item) continue;
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniquePreserve(list, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
