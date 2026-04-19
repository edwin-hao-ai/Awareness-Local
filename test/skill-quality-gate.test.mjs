import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSkillQuality } from '../src/daemon/skill-quality-gate.mjs';

const GOOD_SKILL = {
  name: 'publish @awareness-sdk/* to npm',
  summary:
    'Release a @awareness-sdk/* package to the public npm registry. Why: China mirror (npmmirror) accepts only reads — publish to it silently 403s. When: any scoped package needs a new version.',
  methods: [
    { step: 1, description: 'Bump sdks/<pkg>/package.json version + prepend a user-visible CHANGELOG.md entry.' },
    { step: 2, description: 'Run `npm publish --access public --registry=https://registry.npmjs.org/` — explicit registry bypasses any npmrc pointing to a mirror.' },
    { step: 3, description: 'Verify with `npm view @awareness-sdk/<pkg> version --registry=https://registry.npmjs.org/` — must print the new version.' },
  ],
  tags: ['npm', 'publish', 'awareness-sdk', 'release'],
};

test('validateSkillQuality: good skill passes', () => {
  const r = validateSkillQuality(GOOD_SKILL);
  assert.equal(r.ok, true, `expected ok, got reasons: ${r.reasons.join(',')}`);
});

test('S1 rejects names < 10 chars', () => {
  const r = validateSkillQuality({ ...GOOD_SKILL, name: 'short' });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('name_too_short')));
});

test('S1 rejects vague verbs ("handle stuff")', () => {
  const r = validateSkillQuality({ ...GOOD_SKILL, name: 'handle npm publishing stuff' });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('name_starts_with_vague_verb')));
});

test('summary < 80 chars is a WARNING, not a hard reject (skill still persists)', () => {
  const r = validateSkillQuality({ ...GOOD_SKILL, summary: 'short summary' });
  assert.equal(r.ok, true, 'soft warning should not block insert');
  assert.ok(r.warnings.some((x) => x.includes('summary_too_short')));
});

test('S3 rejects < 3 methods', () => {
  const r = validateSkillQuality({ ...GOOD_SKILL, methods: [GOOD_SKILL.methods[0]] });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('methods_too_few')));
});

test('S4 rejects when any step description < 15 chars (new stricter-but-lower bar)', () => {
  const r = validateSkillQuality({
    ...GOOD_SKILL,
    methods: [
      ...GOOD_SKILL.methods.slice(0, 2),
      { step: 3, description: 'verify' },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('below_15_chars')));
});

test('step desc ≥15 but < 50 chars now ACCEPTED (soft rubric drops score, hard gate passes)', () => {
  const r = validateSkillQuality({
    ...GOOD_SKILL,
    methods: [
      ...GOOD_SKILL.methods.slice(0, 2),
      { step: 3, description: 'verify it actually worked' }, // 25 chars
    ],
  });
  assert.equal(r.ok, true, 'soft fail on executability is rubric-only, not a reject');
});

test('weak/generic tags is a WARNING only (skill persists, LLM gets hint)', () => {
  const r = validateSkillQuality({ ...GOOD_SKILL, tags: ['general', 'misc'] });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((x) => x.includes('weak_tags')));
});

test('no tags at all is a warning, still persists', () => {
  const r = validateSkillQuality({ ...GOOD_SKILL, tags: [] });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((x) => x.includes('weak_tags')));
});

test('no verification step is a warning (client gets nudge), skill still persists', () => {
  const noVerify = {
    ...GOOD_SKILL,
    methods: [
      { step: 1, description: 'Bump sdks/<pkg>/package.json version and prepend changelog entry.' },
      { step: 2, description: 'Run npm publish with explicit registry flag and public access.' },
      { step: 3, description: 'Package appears on npmjs.org under public access successfully.' },
    ],
  };
  const r = validateSkillQuality(noVerify);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((x) => x.includes('no_verification_step')));
});

test('reject comes with actionable fix_suggestion for LLM retry', () => {
  const r = validateSkillQuality({ name: 'do', methods: [{ description: 'x' }] });
  assert.equal(r.ok, false);
  assert.ok(r.fix_suggestion && r.fix_suggestion.length > 20,
    `expected a fix_suggestion sentence, got "${r.fix_suggestion}"`);
});

test('accepted skill carries quality_score (/40)', () => {
  const r = validateSkillQuality(GOOD_SKILL);
  assert.equal(r.ok, true);
  assert.ok(Number.isInteger(r.quality_score));
  assert.ok(r.quality_score >= 0 && r.quality_score <= 40);
});

test('W1 warns (non-blocking) when methods = exactly 3', () => {
  const r = validateSkillQuality(GOOD_SKILL);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.includes('methods_at_minimum'));
});

test('W2 warns when no pitfall keyword anywhere', () => {
  // GOOD_SKILL happens to contain "bypasses" / "silently 403s" phrases which
  // match; strip them for this test.
  const plain = {
    ...GOOD_SKILL,
    summary:
      'Release @awareness-sdk/* packages. Explicit registry flag required when publishing to public npm via the official registry endpoint only.',
    methods: GOOD_SKILL.methods.map((m) => ({ ...m, description: m.description.replace(/bypasses any.*mirror\./, '').replace(/silently 403s/, '') })),
  };
  const r = validateSkillQuality(plain);
  assert.equal(r.ok, true);
  // W2 pitfall warning expected
  assert.ok(r.warnings.includes('no_pitfall_mention'));
});

test('returns invalid_skill_shape for non-object input', () => {
  assert.equal(validateSkillQuality(null).ok, false);
  assert.equal(validateSkillQuality('nope').ok, false);
  assert.equal(validateSkillQuality(42).ok, false);
});
