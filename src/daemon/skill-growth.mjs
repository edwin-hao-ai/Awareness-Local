/**
 * Skill growth-stage lifecycle (F-059).
 *
 * Mirrors backend/awareness/api/services/card_growth_stage.py thresholds
 * to keep local + cloud semantics aligned:
 *
 *   seedling → budding    : ≥ 2 source cards  AND rubric ≥ 20/40
 *   budding  → evergreen  : ≥ 5 source cards  AND usage_count ≥ 2
 *
 * Never demotes. Only supersede / archive retires a skill.
 *
 * Self-growth (no cron): every time a skill's source_card_ids grows or a
 * skill is applied, recompute and promote if threshold met. Older
 * skills predating these columns get `seedling` default and promote
 * when they next get referenced.
 *
 * Seedling/budding skills are NOT hard-filtered from recall — they are
 * weight-demoted in ranking (user preference: "成长期的 skill 也是可
 * 以作为记忆参考的"). See helpers.mjs::extractActiveSkills for the
 * ranking formula.
 */

const BUDDING_SOURCE_THRESHOLD = 2;
const BUDDING_RUBRIC_THRESHOLD = 20;
const EVERGREEN_SOURCE_THRESHOLD = 5;
const EVERGREEN_USAGE_THRESHOLD = 2;
const STAGE_ORDER = { seedling: 0, budding: 1, evergreen: 2 };

/**
 * Compute the target stage from current stage + signals. Never demotes.
 * @returns {'seedling'|'budding'|'evergreen'}
 */
export function computeSkillStage({
  currentStage = 'seedling',
  sourceCardCount = 0,
  usageCount = 0,
  rubricScore = 0,
}) {
  let target = 'seedling';
  if (sourceCardCount >= EVERGREEN_SOURCE_THRESHOLD && usageCount >= EVERGREEN_USAGE_THRESHOLD) {
    target = 'evergreen';
  } else if (sourceCardCount >= BUDDING_SOURCE_THRESHOLD && rubricScore >= BUDDING_RUBRIC_THRESHOLD) {
    target = 'budding';
  }
  const curOrd = STAGE_ORDER[currentStage] ?? 0;
  const tgtOrd = STAGE_ORDER[target] ?? 0;
  return tgtOrd > curOrd ? target : currentStage;
}

/**
 * Evaluate + persist a skill's growth stage. Returns the new stage if
 * promoted, else null.
 *
 * @param {object} indexer - daemon.indexer with .db (better-sqlite3)
 * @param {string} skillId
 * @param {number} rubricScore - /40 from scoreSkill()
 */
export function evaluateSkillGrowth(indexer, skillId, rubricScore = 0) {
  if (!indexer?.db) return null;
  let row;
  try {
    row = indexer.db
      .prepare("SELECT growth_stage, source_card_ids, usage_count FROM skills WHERE id = ? AND status != 'superseded'")
      .get(skillId);
  } catch { return null; }
  if (!row) return null;

  const currentStage = row.growth_stage || 'seedling';
  let sourceCardCount = 0;
  try {
    const parsed = JSON.parse(row.source_card_ids || '[]');
    if (Array.isArray(parsed)) sourceCardCount = parsed.length;
  } catch { /* ignore */ }

  const newStage = computeSkillStage({
    currentStage,
    sourceCardCount,
    usageCount: row.usage_count ?? 0,
    rubricScore,
  });

  if (newStage === currentStage) return null;

  try {
    indexer.db
      .prepare("UPDATE skills SET growth_stage = ?, updated_at = ? WHERE id = ?")
      .run(newStage, new Date().toISOString(), skillId);
    console.log(`[skill-grow] ${skillId.slice(0, 18)} ${currentStage} → ${newStage} (cards=${sourceCardCount}, usage=${row.usage_count ?? 0}, rubric=${rubricScore})`);
  } catch (err) {
    console.warn(`[skill-grow] promote failed: ${err.message}`);
    return null;
  }
  return newStage;
}
