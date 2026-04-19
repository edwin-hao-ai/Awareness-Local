/**
 * F-056 · deep card-quality inspection.
 *
 * Static tests can check "did the LLM emit something with the right
 * category". This file goes one level deeper: for each eval fixture
 * case, we take the *gold-standard* hand-crafted card in the fixture
 * and rate it against a checklist of readability + completeness
 * properties. The point is to validate that the SHAPES we ask the LLM
 * to produce in our prompts ARE high-quality shapes.
 *
 * If a fixture card fails one of these checks, either (a) the fixture
 * is weak (common when copy-pasted from real content) or (b) the
 * quality bar we communicate in the shared prompts isn't strict
 * enough. Either way we want to notice.
 *
 * Properties checked per card / skill:
 *   1. title length is healthy (>3 chars, <100 chars)
 *   2. summary ≥ per-category floor (80 chars tech / 40 chars personal)
 *   3. title ≠ summary (R2 gate)
 *   4. no envelope leak (R3 gate)
 *   5. no placeholder token (R4 gate)
 *   6. tags ≥ 1 AND all are specific (no stop-tags, length ≥ 3)
 *   7. tech-category summaries contain at least one concrete signal
 *      (file path / command / version / error quote)
 *   8. all three scores (novelty / durability / specificity) present
 *      and within [0, 1]
 *   9. skills: methods ≥ 3, each method ≥ 20 chars, trigger_conditions ≥ 1
 *
 * On failure, prints BOTH the failed card and the reason, so editing
 * the fixture is a one-line fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCardQuality } from '../src/core/lifecycle-manager.mjs';

// Use the same fixtures as the extraction eval so one source of truth.
import { EVAL_CASES } from './fixtures/extraction-eval-cases.mjs';
import { COHERENCE_SCENARIOS } from './fixtures/coherence-scenarios.mjs';

const PERSONAL_CATEGORIES = new Set([
  'personal_preference', 'important_detail', 'plan_intention',
  'activity_preference', 'health_info', 'career_info', 'custom_misc',
]);

const STOP_TAGS = new Set([
  'general', 'note', 'misc', 'fix', 'a', 'b', 'c', // keep minimal — too aggressive stop-list would false-positive
]);

const TECH_SIGNAL_RE = [
  /`[^`]+`/, // inline code
  /\.[a-z]{2,5}\b/, // file extension .py .ts .mjs
  /\$\d|¥\d|€\d|\b\d+(?:\.\d+)?%/, // price / pct
  /\b\d+\.\d+\.\d+\b/, // semver
  /\b[A-Z_]{4,}\b/, // UPPER_CASE consts
  /\b(?:function|method|file|line|commit|PR|issue|url|endpoint|table|column|flag|command)\b/i,
  /[，。？！][^\s]{2,}/, // CJK punctuation followed by content
];

/**
 * Words that when used alone as title leave the card "grep-dead" —
 * title tokens the user would never actually search for 6 months later.
 * Presence of ANY of these as the majority of the title is a red flag.
 */
const TITLE_DEAD_WORDS = new Set([
  'decision', 'decisions', 'made', 'bug', 'bugs', 'fixed', 'learned',
  'note', 'memo', 'update', 'change', 'fix', 'important', 'meta',
  'summary', 'notes',
  '决定', '修复', '记录', '笔记', '重要', '更新',
  '決定', '記録', '重要',
]);

function inspectCard(card, { ctxId }) {
  const issues = [];
  const title = String(card?.title ?? '').trim();
  const summary = String(card?.summary ?? card?.content ?? '').trim();

  // 1. title length
  if (title.length < 3) issues.push('title_too_short (<3 chars)');
  if (title.length > 120) issues.push('title_too_long (>120 chars)');

  // R6 grep-friendliness: at least 1 token must be a "concrete" term —
  // not a generic word. Skip for very short CJK titles (carry info via
  // density) and for personal cards (preferences may just name a thing).
  if (title.length >= 5 && !PERSONAL_CATEGORIES.has(card?.category) && card?.category !== 'skill') {
    const tokens = title
      .split(/[\s\-_/,./:()`]+/)
      .filter((t) => t.length >= 3)
      .map((t) => t.toLowerCase());
    const concrete = tokens.filter((t) => !TITLE_DEAD_WORDS.has(t));
    if (concrete.length === 0) {
      issues.push(`title_grep_dead (all tokens are generic: ${JSON.stringify(tokens)})`);
    }
  }

  // 2-4. daemon-enforced gate
  const gate = validateCardQuality({ ...card, summary });
  if (!gate.ok) issues.push(...gate.reasons.map((r) => `gate:${r}`));

  // 6. tags
  const tags = Array.isArray(card?.tags) ? card.tags : [];
  if (tags.length === 0) issues.push('no_tags');
  // Allow 2-char tags — common abbreviations (UX, UI, DB, API, QA, 决策) are legit.
  // Only reject single-char tags and known stop-tags.
  const weakTags = tags.filter((t) => {
    if (typeof t !== 'string') return true;
    if (STOP_TAGS.has(t.toLowerCase())) return true;
    return t.length < 2;
  });
  if (weakTags.length > 0) issues.push(`weak_tags:${JSON.stringify(weakTags)}`);

  // 7. concrete signal for technical categories
  if (!PERSONAL_CATEGORIES.has(card?.category) && card?.category !== 'skill') {
    const hasSignal = TECH_SIGNAL_RE.some((re) => re.test(summary));
    if (!hasSignal) {
      issues.push('missing_concrete_signal (no code/path/command/number)');
    }
  }

  // 8. scores
  for (const field of ['novelty_score', 'durability_score', 'specificity_score']) {
    const v = card?.[field];
    if (v === undefined) {
      issues.push(`missing_${field}`);
      continue;
    }
    if (typeof v !== 'number' || v < 0 || v > 1) {
      issues.push(`bad_${field} (got ${v})`);
    }
  }

  return { id: ctxId, title, issues };
}

function inspectSkill(skill, { ctxId }) {
  const issues = [];
  const name = String(skill?.name ?? '').trim();
  const summary = String(skill?.summary ?? '').trim();

  if (name.length < 3) issues.push('name_too_short');
  if (summary.length < 80) issues.push('summary_too_short (<80)');

  const methods = Array.isArray(skill?.methods) ? skill.methods : [];
  if (methods.length < 3) issues.push(`methods_too_few (${methods.length}<3)`);
  for (const m of methods) {
    const desc = String(m?.description ?? '').trim();
    if (desc.length < 20) issues.push(`method_too_short: "${desc.slice(0, 40)}"`);
  }

  const triggers = Array.isArray(skill?.trigger_conditions) ? skill.trigger_conditions : [];
  if (triggers.length < 1) issues.push('triggers_missing');

  const tags = Array.isArray(skill?.tags) ? skill.tags : [];
  if (tags.length < 3) issues.push(`tags_too_few (${tags.length}<3)`);

  for (const field of ['reusability_score', 'durability_score', 'specificity_score']) {
    const v = skill?.[field];
    if (typeof v !== 'number' || v < 0 || v > 1) {
      issues.push(`bad_${field} (got ${v})`);
    }
  }

  return { id: ctxId, name, issues };
}

// ---------------------------------------------------------------------------
// Harvest every gold-standard card from both fixture files.
// ---------------------------------------------------------------------------

const goldCards = [];
const goldSkills = [];

// From coherence scenarios — record steps carry pre-extracted insights
for (const scenario of COHERENCE_SCENARIOS) {
  for (const step of scenario.steps ?? []) {
    if (step.op !== 'record' || !step.insights) continue;
    for (const card of step.insights.knowledge_cards ?? []) {
      goldCards.push({ ctxId: `${scenario.id}/${card.title}`, card });
    }
    for (const skill of step.insights.skills ?? []) {
      goldSkills.push({ ctxId: `${scenario.id}/${skill.name}`, skill });
    }
  }
}

// Extraction eval cases carry MUST_EMIT expectations — these are specs,
// not gold cards, so we don't inspect them here. They live in
// f056-extraction-eval-offline.test.mjs.

// ---------------------------------------------------------------------------

describe('F-056 gold card quality (fixture self-audit)', () => {
  it(`harvested ${goldCards.length} gold cards from coherence scenarios`, () => {
    assert.ok(goldCards.length >= 10, `expected ≥10 gold cards, found ${goldCards.length}`);
  });

  for (const { ctxId, card } of goldCards) {
    it(`card passes deep-quality inspection: ${ctxId}`, () => {
      const { issues } = inspectCard(card, { ctxId });
      assert.equal(
        issues.length,
        0,
        `[${ctxId}] card failed:\n  ${issues.join('\n  ')}\n\n` +
        `Card title:\n  ${card.title}\n\n` +
        `Card summary (${(card.summary ?? '').length} chars):\n  ${(card.summary ?? '').slice(0, 300)}`,
      );
    });
  }
});

describe('F-056 gold skill quality (fixture self-audit)', () => {
  // Skills are optional in most scenarios; only assert when present
  if (goldSkills.length === 0) {
    it('no skill fixtures to audit (OK — skills are side-channel)', () => {
      assert.ok(true);
    });
  }
  for (const { ctxId, skill } of goldSkills) {
    it(`skill passes deep-quality inspection: ${ctxId}`, () => {
      const { issues } = inspectSkill(skill, { ctxId });
      assert.equal(
        issues.length,
        0,
        `[${ctxId}] skill failed:\n  ${issues.join('\n  ')}`,
      );
    });
  }
});

describe('F-056 evaluation fixture coverage', () => {
  it('extraction fixtures cover EN + 中文 + 日本語', () => {
    const langs = new Set(EVAL_CASES.map((c) => c.lang).filter(Boolean));
    assert.ok(langs.has('en'), 'expected English cases');
    assert.ok(langs.has('zh'), 'expected 中文 cases');
    assert.ok(langs.has('ja'), 'expected 日本語 cases');
  });

  it('extraction fixtures cover all 6 technical categories', () => {
    const cats = new Set(EVAL_CASES.map((c) => c.category_under_test).filter(Boolean));
    for (const required of ['decision', 'problem_solution', 'workflow', 'pitfall', 'insight', 'key_point']) {
      assert.ok(cats.has(required), `extraction fixtures missing category=${required}`);
    }
  });

  it('extraction fixtures cover all 7 personal categories', () => {
    const cats = new Set(EVAL_CASES.map((c) => c.category_under_test).filter(Boolean));
    for (const required of [
      'personal_preference', 'activity_preference', 'important_detail',
      'plan_intention', 'health_info', 'career_info', 'custom_misc',
    ]) {
      assert.ok(cats.has(required), `extraction fixtures missing category=${required}`);
    }
  });

  it('extraction fixtures cover noise (per-language)', () => {
    const noise = EVAL_CASES.filter((c) => c.style === 'noise');
    const noiseLangs = new Set(noise.map((c) => c.lang));
    assert.ok(noise.length >= 5, `expected ≥5 noise cases, got ${noise.length}`);
    assert.ok(noiseLangs.has('en'), 'need an English noise case');
    assert.ok(noiseLangs.has('zh'), 'need a 中文 noise case');
    assert.ok(noiseLangs.has('ja'), 'need a 日本語 noise case');
  });
});
