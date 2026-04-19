// ⚠️  DO NOT EDIT — synced from sdks/_shared/js/card-quality-validate.mjs
// Edit the SSOT and run `node scripts/sync-shared-js.mjs`.
/**
 * Knowledge card structural quality gate (R1-R5). Pure, no deps.
 *
 * Inbound validation for client-submitted cards. Rejects:
 *   R1. summary shorter than category-aware minimum
 *   R2. summary byte-identical to title
 *   R3. title OR summary starts with a metadata envelope pattern
 *   R4. summary contains placeholder tokens (TODO, lorem ipsum, example.com…)
 *   R5. (warning only) long summary without any markdown structure
 *
 * Personal categories are passed in by the caller (defaults to the 7-category
 * set so callers that don't care get sensible behaviour out of the box).
 *
 * SSOT: sdks/_shared/js/card-quality-validate.mjs
 * Sync: scripts/sync-shared-js.mjs distributes to each SDK's src/_shared/.
 */

export const CARD_TECHNICAL_MIN_SUMMARY = 80;
export const CARD_PERSONAL_MIN_SUMMARY = 40;

export const CARD_ENVELOPE_PATTERN = /^\s*(?:Request|Result|Send|Received)\s*:|^\s*Sender\s*\(untrusted metadata\)|^\s*\[Operational context metadata|^\s*\[Subagent Context\]/i;

export const CARD_PLACEHOLDER_PATTERN = /\b(?:TODO|FIXME|lorem ipsum|example\.com|placeholder(?:-|_|\s|$))\b/i;

export const DEFAULT_PERSONAL_CATEGORIES = new Set([
  'personal_preference',
  'important_detail',
  'plan_intention',
  'activity_preference',
  'health_info',
  'career_info',
  'custom_misc',
]);

/**
 * @param {object} card
 * @param {object} [opts]
 * @param {Set<string>} [opts.personalCategories] - override the 7-category default.
 * @returns {{ ok: boolean, reasons: string[], warnings: string[] }}
 */
export function validateCardQuality(card, opts = {}) {
  const reasons = [];
  const warnings = [];

  if (!card || typeof card !== 'object') {
    return { ok: false, reasons: ['invalid_card_shape'], warnings };
  }

  const personalCategories = opts.personalCategories instanceof Set
    ? opts.personalCategories
    : DEFAULT_PERSONAL_CATEGORIES;

  const title = typeof card.title === 'string' ? card.title.trim() : '';
  const summary = typeof card.summary === 'string'
    ? card.summary
    : (typeof card.content === 'string' ? card.content : '');
  const summaryTrim = summary.trim();
  const category = typeof card.category === 'string' ? card.category : '';

  const minSummary = personalCategories.has(category)
    ? CARD_PERSONAL_MIN_SUMMARY
    : CARD_TECHNICAL_MIN_SUMMARY;

  if (summaryTrim.length < minSummary) {
    reasons.push(`summary_too_short (<${minSummary} chars)`);
  }

  if (summaryTrim && summaryTrim === title) {
    reasons.push('summary_equals_title');
  }

  if (CARD_ENVELOPE_PATTERN.test(title) || CARD_ENVELOPE_PATTERN.test(summaryTrim)) {
    reasons.push('envelope_pattern_in_content');
  }

  if (CARD_PLACEHOLDER_PATTERN.test(summaryTrim)) {
    reasons.push('placeholder_content');
  }

  if (summaryTrim.length >= 200) {
    const hasMarkdown = /(`[^`]+`|\*\*[^*]+\*\*|(^|\n)\s*[-*]\s|(^|\n)\s*\d+\.\s)/.test(summaryTrim);
    if (!hasMarkdown) warnings.push('no_markdown_structure');
  }

  return { ok: reasons.length === 0, reasons, warnings };
}
