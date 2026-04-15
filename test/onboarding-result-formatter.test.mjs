/**
 * Unit tests for src/web/onboarding/result-formatter.js.
 * Loads the IIFE in a vm sandbox (see helpers/onboarding-env.mjs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, loadModules } from './helpers/onboarding-env.mjs';

// Minimal i18n stub covering just the keys this file exercises.
const STUB = {
  'onb.q.tag': 'Tell me about {tag}',
  'onb.q.wiki_page': 'Tell me about {title}',
  'onb.q.lang': 'What {lang} patterns?',
  'onb.q.readme': 'Summarize the README',
  'onb.q.architecture': "What's the architecture?",
  'onb.q.decisions': 'What decisions?',
  'onb.q.recent_decision': 'What was recently decided?',
  'onb.q.recent_pitfall': 'Any recent pitfalls?',
};

function load() {
  const ctx = makeSandbox();
  ctx.window.t = (k, vars) => {
    let out = STUB[k] != null ? STUB[k] : String(k);
    if (vars) for (const [vk, vv] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{${vk}\\}`, 'g'), String(vv));
    }
    return out;
  };
  loadModules(ctx, ['result-formatter.js']);
  return ctx.window.AwarenessOnboardingFormat;
}

/** vm sandbox has a different Array prototype — deep-compare via JSON. */
function eqJson(a, b) { assert.equal(JSON.stringify(a), JSON.stringify(b)); }

// ── smartTruncate / stripDecorative / normalizeWhitespace ──────────

test('normalizeWhitespace collapses newlines and tabs', () => {
  const F = load();
  assert.equal(F.normalizeWhitespace('a\n  b\t\tc'), 'a b c');
  assert.equal(F.normalizeWhitespace(null), '');
});

test('stripDecorative removes triple-quotes and blockquotes', () => {
  const F = load();
  assert.equal(F.stripDecorative('"""hello"""'), 'hello');
  assert.equal(F.stripDecorative('> quoted\n> line'), 'quoted\nline');
  assert.equal(F.stripDecorative("'''code block'''"), 'code block');
});

test('smartTruncate prefers sentence boundary over word/char', () => {
  const F = load();
  const s = 'First sentence. Second sentence that goes much longer beyond the cap.';
  const out = F.smartTruncate(s, 40);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 42);
  assert.ok(out.startsWith('First sentence.'));
});

test('smartTruncate leaves short strings untouched', () => {
  const F = load();
  assert.equal(F.smartTruncate('short', 100), 'short');
});

// ── isNoisy ────────────────────────────────────────────────────────

test('isNoisy flags raw chat logs (Request:/Prompt:/Input:)', () => {
  const F = load();
  assert.equal(F.isNoisy({ title: 'Request: build me a page', summary: 'Result: sure' }), true);
  assert.equal(F.isNoisy({ title: 'Prompt: xyz', summary: 'some answer here and there' }), true);
  assert.equal(F.isNoisy({ title: 'Clean title', summary: 'normal content here' }), false);
});

test('isNoisy flags heavy-code-density summaries', () => {
  const F = load();
  const codey = 'def f(x): return {k: v for k, v in items(); [x, y] = split(); }';
  assert.equal(F.isNoisy({ title: 'source.py', summary: codey }), true);
});

test('isNoisy flags stubs shorter than 15 chars', () => {
  const F = load();
  assert.equal(F.isNoisy({ title: 't', summary: 'tiny' }), true);
});

// ── prettyTitle ───────────────────────────────────────────────────

test('prettyTitle reduces file paths to basename', () => {
  const F = load();
  assert.equal(
    F.prettyTitle('backend/awareness/api/services/device_auth.py'),
    'device_auth.py',
  );
});

test('prettyTitle strips "File changed:" prefix', () => {
  const F = load();
  assert.equal(
    F.prettyTitle('File changed: /docs/active-features.md'),
    'active-features.md',
  );
});

test('prettyTitle leaves short human titles alone', () => {
  const F = load();
  assert.equal(F.prettyTitle('Dedup architecture'), 'Dedup architecture');
});

// ── relativeTime ──────────────────────────────────────────────────

test('relativeTime returns just_now for <1m ago', () => {
  const F = load();
  const iso = new Date(Date.now() - 5_000).toISOString();
  assert.equal(F.relativeTime(iso), 'onb.time.just_now');
});

test('relativeTime returns yesterday for ~1 day ago', () => {
  const F = load();
  const iso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  assert.equal(F.relativeTime(iso), 'onb.time.yesterday');
});

test('relativeTime handles empty/invalid input', () => {
  const F = load();
  assert.equal(F.relativeTime(''), '');
  assert.equal(F.relativeTime('not-a-date'), '');
});

// ── parseTags ─────────────────────────────────────────────────────

test('parseTags handles JSON-string tags (/knowledge API quirk)', () => {
  const F = load();
  eqJson(F.parseTags('["a","b","c"]'), ['a', 'b', 'c']);
  eqJson(F.parseTags('[]'), []);
  eqJson(F.parseTags('not-json'), []);
  eqJson(F.parseTags(['x', 'y']), ['x', 'y']);
  eqJson(F.parseTags(null), []);
});

// ── tagHotness ────────────────────────────────────────────────────

test('tagHotness counts tags case-insensitively and sorts desc', () => {
  const F = load();
  const cards = [
    { tags: '["DeDup","ui"]' },
    { tags: '["dedup"]' },
    { tags: ['ui', 'dedup'] },
    { tags: '[]' },
  ];
  const out = F.tagHotness(cards);
  assert.equal(out[0][0], 'dedup');
  assert.equal(out[0][1], 3);
  assert.equal(out[1][0], 'ui');
  assert.equal(out[1][1], 2);
});

// ── buildContentQuestions ─────────────────────────────────────────

test('buildContentQuestions prefers tag hotness over meta templates', () => {
  const F = load();
  const cards = [
    { category: 'decision', title: 'Why RRF', tags: '["search","ranking"]' },
    { category: 'pitfall', title: 'Prisma name', tags: '["prisma","search"]' },
  ];
  const meta = { has_readme: true, wiki_titles: ['arch'], total_cards: 2 };
  const q = F.buildContentQuestions(cards, meta, { limit: 3 });
  assert.ok(q.some((s) => s.includes('search')),
    `expected a question interpolated with a real tag, got ${JSON.stringify(q)}`);
  assert.equal(q.length, 3);
});

test('buildContentQuestions falls back to meta templates when no cards', () => {
  const F = load();
  const q = F.buildContentQuestions([], { has_readme: true, total_cards: 0 }, { limit: 2 });
  assert.ok(q.length >= 1);
  assert.ok(q.some((s) => s === STUB['onb.q.readme']));
});

test('buildContentQuestions dedupes identical questions', () => {
  const F = load();
  const cards = [
    { category: 'decision', tags: '["x"]' },
    { category: 'decision', tags: '["x"]' },
  ];
  const q = F.buildContentQuestions(cards, {}, { limit: 3 });
  const unique = new Set(q);
  assert.equal(unique.size, q.length, 'no duplicates allowed');
});

// ── formatResults ─────────────────────────────────────────────────

test('formatResults drops noisy items and caps length', () => {
  const F = load();
  const items = [
    { title: 'Request: build page', summary: 'Result: sure' },       // noisy — drop
    { title: 'Dedup architecture', summary: 'Two-stage LightRAG style verification.',
      type: 'decision', created_at: new Date().toISOString() },      // keep
    { title: 'backend/a/b/c/deep.py', summary: 'A readable module docstring lives here.',
      type: 'workspace_file', created_at: new Date().toISOString() },// keep, basename
    { title: 't', summary: 'tiny' },                                 // stub — drop
  ];
  const out = F.formatResults(items, { limit: 5 });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'Dedup architecture');
  assert.equal(out[0].icon, '🎯');
  assert.equal(out[1].title, 'deep.py');
  assert.equal(out[1].icon, '📂');
});

test('formatResults respects the `limit` parameter', () => {
  const F = load();
  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `Card ${i}`, summary: 'decent summary with prose',
    type: 'insight', created_at: new Date().toISOString(),
  }));
  assert.equal(F.formatResults(many, { limit: 3 }).length, 3);
});
