/**
 * Skill inbound quality gate · rewritten 2026-04-19 after user concern:
 *   "如果 gate 拦截了，怎么保证真的能提取出 skill？"
 *
 * The trade-off: a strict rubric keeps junk out but risks rejecting
 * every first-draft skill. The rewrite splits the 8-rubric into HARD
 * rejects (fundamentally not a skill → client must fix) and SOFT
 * warnings (skill is accepted, quality_score attached, client sees a
 * suggestion to improve on next evolve).
 *
 * HARD rejects (reasons[] blocks insert):
 *   H1 · invalid shape
 *   H2 · name < 10 chars OR starts with vague verb
 *   H3 · < 3 methods (not a procedure)
 *   H4 · any step description < 15 chars (too short to execute)
 *
 * SOFT warnings (warnings[] + quality_score, skill still persists):
 *   W1 · summary < 80 chars (client should expand)
 *   W2 · tags < 2 topic-specific (weak or generic)
 *   W3 · no verification signal in any step
 *   W4 · no pitfall / gotcha keyword anywhere
 *   W5 · methods = exactly 3 (at minimum — not a fail, just a nudge)
 *
 * quality_score is the same /40 Hermes-style rubric used by
 * scripts/skill-quality-score.mjs (8 dimensions × 0-5). Downstream
 * surfaces (active_skills[] injection) can filter by quality_score.
 *
 * fix_suggestion is a one-sentence actionable nudge the client LLM
 * can use to rewrite and retry — concrete recipes, not aphorisms.
 */

const MIN_NAME_LEN = 10;
const MIN_METHODS = 3;
const MIN_STEP_DESC_LEN = 15; // hard reject below 15 chars (down from 30)
const SOFT_STEP_DESC_LEN = 50; // rubric maxes executability at 50+
const MIN_SUMMARY_LEN = 80;
const MIN_SPECIFIC_TAGS = 2;

const GENERIC_TAGS = new Set([
  'general', 'misc', 'note', 'other', 'stuff', 'thing', 'test', 'debug',
  'data', 'tmp', 'temp', 'todo', 'fixme',
]);

const VAGUE_NAME_START = /^(handle|do|work|manage|process|check|run|use) /i;
const VERIFY_PATTERN = /verify|assert|confirm|expect|must |should |status 200|exit 0|returns? ok/i;
const PITFALL_PATTERN = /pitfall|gotcha|warning|must not|never |careful|avoid|prevents?|silently/i;

/**
 * @param {object} skill
 * @returns {{
 *   ok: boolean,
 *   reasons: string[],
 *   warnings: string[],
 *   quality_score: number,     // /40, only computed for accepted skills
 *   fix_suggestion?: string    // present on reject
 * }}
 */
export function validateSkillQuality(skill) {
  const reasons = [];
  const warnings = [];

  if (!skill || typeof skill !== 'object') {
    return {
      ok: false,
      reasons: ['invalid_skill_shape'],
      warnings,
      quality_score: 0,
      fix_suggestion: 'Submit a skill object with {name, summary, methods, tags}.',
    };
  }

  const name = typeof skill.name === 'string' ? skill.name.trim() : '';
  const summary = typeof skill.summary === 'string' ? skill.summary.trim() : '';
  const methods = Array.isArray(skill.methods) ? skill.methods : [];
  const tags = Array.isArray(skill.tags) ? skill.tags : [];

  // ---- HARD rejects ----
  if (name.length < MIN_NAME_LEN) {
    reasons.push(`name_too_short (<${MIN_NAME_LEN} chars)`);
  } else if (VAGUE_NAME_START.test(name)) {
    reasons.push('name_starts_with_vague_verb');
  }

  if (methods.length < MIN_METHODS) {
    reasons.push(`methods_too_few (<${MIN_METHODS} steps)`);
  }

  const tooShort = methods.filter((m) => {
    const d = typeof m?.description === 'string' ? m.description.trim() : '';
    return d.length < MIN_STEP_DESC_LEN;
  });
  if (tooShort.length > 0) {
    reasons.push(`${tooShort.length}_step(s)_below_${MIN_STEP_DESC_LEN}_chars`);
  }

  // ---- SOFT warnings ----
  if (summary.length < MIN_SUMMARY_LEN) {
    warnings.push(`summary_too_short (<${MIN_SUMMARY_LEN} chars)`);
  }

  const specificTags = tags.filter((t) => {
    const s = String(t).toLowerCase().trim();
    return s.length >= 3 && !GENERIC_TAGS.has(s);
  });
  if (specificTags.length < MIN_SPECIFIC_TAGS) {
    warnings.push(`weak_tags (<${MIN_SPECIFIC_TAGS} topic-specific)`);
  }

  const hasVerify = methods.some((m) => {
    const d = typeof m?.description === 'string' ? m.description : '';
    return VERIFY_PATTERN.test(d);
  });
  if (!hasVerify) {
    warnings.push('no_verification_step');
  }

  const allText = [summary, ...methods.map((m) => m?.description || '')].join(' ');
  if (!PITFALL_PATTERN.test(allText)) {
    warnings.push('no_pitfall_mention');
  }

  if (methods.length === MIN_METHODS) {
    warnings.push('methods_at_minimum');
  }

  // ---- Rejection path ----
  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      warnings,
      quality_score: 0,
      fix_suggestion: buildFixSuggestion(reasons, skill),
    };
  }

  // ---- Accepted · compute quality_score ----
  const qualityScore = computeQualityScore(skill, { hasVerify, specificTags });

  return { ok: true, reasons, warnings, quality_score: qualityScore };
}

/**
 * Compute the 8-dim Hermes rubric score (0-40) for an accepted skill.
 * Mirrors scripts/skill-quality-score.mjs::scoreSkill so server-side
 * and CI rubric produce the same number.
 */
function computeQualityScore(skill, { hasVerify, specificTags }) {
  const tc = Array.isArray(skill.trigger_conditions) ? skill.trigger_conditions : [];
  const methods = Array.isArray(skill.methods) ? skill.methods : [];
  const summary = String(skill.summary || '');
  const name = String(skill.name || '');

  // 1. When-to-use
  const distinctTc = new Set(tc.map((t) => String(t?.pattern || '').toLowerCase().trim())).size;
  const avgTcLen = tc.length ? tc.reduce((s, t) => s + String(t?.pattern || '').length, 0) / tc.length : 0;
  const d1 = tc.length >= 3 && distinctTc === tc.length && avgTcLen >= 15 ? 5
    : tc.length >= 2 && avgTcLen >= 10 ? 3
    : tc.length >= 1 && avgTcLen >= 5 ? 2 : 1;

  // 2. Summary quality
  const hasWhy = /\bwhy\b|because|pitfall|\*\*Why\*\*/i.test(summary);
  const hasMarkdown = /`[^`]+`|\*\*[^*]+\*\*/.test(summary);
  const d2 = summary.length >= 150 && hasWhy && hasMarkdown ? 5
    : summary.length >= 100 && (hasWhy || hasMarkdown) ? 4
    : summary.length >= 80 ? 3 : 2;

  // 3. Step count
  const d3 = methods.length >= 4 ? 5 : methods.length === 3 ? 4 : 2;

  // 4. Step executability
  const executable = methods.filter((m) => {
    const d = String(m?.description || '');
    const hasCommand = /`[^`]+`|npm |npx |git |curl |ssh |docker /.test(d);
    const hasFile = /\.mjs|\.ts|\.py|\.json|\.md|\.sql|\.sh|\/|@[\w-]+\/[\w-]+/.test(d);
    return (hasCommand || hasFile) && d.length >= SOFT_STEP_DESC_LEN;
  });
  const ratio = methods.length ? executable.length / methods.length : 0;
  const d4 = ratio >= 1 && methods.length >= 3 ? 5
    : ratio >= 0.75 ? 4
    : ratio >= 0.5 ? 3
    : ratio > 0 ? 2 : 0;

  // 5. Pitfalls
  const allText = [summary, ...methods.map((m) => m?.description || '')].join(' ');
  const pitfall = PITFALL_PATTERN.test(allText);
  const reason = /because|why |why's/i.test(allText);
  const d5 = pitfall && reason ? 5 : pitfall ? 3 : reason ? 2 : 0;

  // 6. Verification
  const d6 = hasVerify ? 5 : 0;

  // 7. Grep-friendly title
  const hasSpecific = /[·@\-$\/]|\d|\bto\b|\bfrom\b|[A-Z]{2,}|@\w/.test(name);
  const vague = VAGUE_NAME_START.test(name);
  const d7 = vague ? 1
    : hasSpecific && name.length >= 20 ? 5
    : hasSpecific ? 4
    : name.length >= 25 ? 3 : 2;

  // 8. Topic tags
  const d8 = specificTags.length >= 5 ? 5
    : specificTags.length >= 3 ? 4
    : specificTags.length >= 2 ? 3
    : specificTags.length >= 1 ? 2 : 0;

  return d1 + d2 + d3 + d4 + d5 + d6 + d7 + d8;
}

/**
 * Produce a single actionable sentence the client LLM can use to fix
 * the skill on the next retry. Covers the most common rejection paths.
 */
function buildFixSuggestion(reasons, skill) {
  const tips = [];
  if (reasons.some((r) => r.includes('name_'))) {
    tips.push('Rename to an action-oriented 3-8 word title with a specific noun/verb (e.g. "publish @awareness-sdk/* to npm") — avoid generic verbs like "handle" / "do" / "process".');
  }
  if (reasons.some((r) => r.includes('methods_too_few'))) {
    const n = Array.isArray(skill?.methods) ? skill.methods.length : 0;
    tips.push(`Add at least ${MIN_METHODS - n} more step(s); a procedure should have ≥3 steps (setup → action → verification).`);
  }
  if (reasons.some((r) => r.includes('below_'))) {
    tips.push(`Expand each step description to ≥${MIN_STEP_DESC_LEN} chars and include a concrete command, file path, or check (e.g. "Run \`npm publish --registry=…\` and expect exit code 0").`);
  }
  if (reasons.some((r) => r.includes('invalid_shape'))) {
    tips.push('Submit a skill object with {name, summary, methods[], tags[]}.');
  }
  return tips.join(' ');
}
