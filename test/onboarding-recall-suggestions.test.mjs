import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, loadModules, installBaseI18n } from './helpers/onboarding-env.mjs';

const EN = {
  'onb.q.readme': 'Summarize the README',
  'onb.q.architecture': "What's the architecture of this project?",
  'onb.q.wiki_page': 'Tell me about {title}',
  'onb.q.lang': 'What {lang} files do we have?',
  'onb.q.decisions': 'What decisions were made here?',
};

function load({ fetchImpl, locale } = {}) {
  const ctx = makeSandbox({ fetchImpl });
  installBaseI18n(ctx, { en: EN, zh: EN });
  if (locale) ctx.currentLocale = locale;
  loadModules(ctx, ['recall-suggestions.js']);
  return ctx.AwarenessOnboardingRecall;
}

// ── pickSuggestions strategy ───────────────────────────────────────

test('pickSuggestions: empty meta returns empty array (no crash)', () => {
  const R = load();
  assert.equal(R.pickSuggestions({}).length, 0);
  assert.equal(R.pickSuggestions().length, 0);
  assert.equal(R.pickSuggestions(null).length, 0);
});

test('pickSuggestions: has_readme triggers readme question', () => {
  const R = load();
  const picks = R.pickSuggestions({ has_readme: true });
  assert.ok(picks.includes('Summarize the README'));
});

test('pickSuggestions: wiki_titles[0] is interpolated into question', () => {
  const R = load();
  const picks = R.pickSuggestions({ wiki_titles: ['Backend Architecture', 'API Reference'] });
  assert.ok(picks.some((p) => p === 'Tell me about Backend Architecture'));
  // Only the first title is used
  assert.ok(!picks.some((p) => p.includes('API Reference')));
});

test('pickSuggestions: top_language interpolated correctly', () => {
  const R = load();
  const picks = R.pickSuggestions({ top_language: 'typescript' });
  assert.ok(picks.includes('What typescript files do we have?'));
});

test('pickSuggestions: caps at 3 even with all signals', () => {
  const R = load();
  const picks = R.pickSuggestions({
    has_readme: true,
    wiki_titles: ['Arch'],
    has_docs: true,
    top_language: 'rust',
    total_cards: 50,
  });
  assert.equal(picks.length, 3);
});

test('pickSuggestions: priority order — readme > wiki > architecture', () => {
  const R = load();
  const picks = R.pickSuggestions({
    has_readme: true,
    wiki_titles: ['Arch'],
    has_docs: true,
  });
  // readme first, wiki second, architecture third
  assert.match(picks[0], /README/);
  assert.match(picks[1], /Tell me about Arch/);
});

test('pickSuggestions: decisions only shown when cards exist', () => {
  const R = load();
  const noCards = R.pickSuggestions({ total_cards: 0 });
  const withCards = R.pickSuggestions({ total_cards: 5, has_readme: false });
  assert.ok(!noCards.some((p) => p.includes('decisions')));
  assert.ok(withCards.some((p) => p.includes('decisions')));
});

test('pickSuggestions: special chars in lang (C++, C#) interpolate as-is', () => {
  const R = load();
  const picks = R.pickSuggestions({ top_language: 'C++' });
  assert.ok(picks.some((p) => p.includes('C++')));
  const picks2 = R.pickSuggestions({ top_language: 'C#' });
  assert.ok(picks2.some((p) => p.includes('C#')));
});

test('pickSuggestions: empty wiki_titles array does NOT inject undefined', () => {
  const R = load();
  const picks = R.pickSuggestions({ wiki_titles: [] });
  assert.ok(!picks.some((p) => p.includes('undefined')));
});

test('pickSuggestions: non-array wiki_titles is ignored safely', () => {
  const R = load();
  // Defensive: some API might return object/null
  assert.doesNotThrow(() => R.pickSuggestions({ wiki_titles: 'not array' }));
  assert.doesNotThrow(() => R.pickSuggestions({ wiki_titles: null }));
});

// ── loadScanMeta fallback chain ───────────────────────────────────

test('loadScanMeta: all three endpoints fail → default meta returned', async () => {
  const R = load({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const meta = await R.loadScanMeta();
  assert.equal(meta.total_cards, 0);
  assert.equal(meta.has_readme, false);
  assert.equal(meta.top_language, null);
  assert.equal(Array.isArray(meta.wiki_titles), true);
  assert.equal(meta.wiki_titles.length, 0);
});

test('loadScanMeta: partial success — stats OK but scan/wiki fail', async () => {
  const R = load({
    fetchImpl: async (url) => {
      if (url.includes('/stats')) {
        return { ok: true, json: async () => ({ totalKnowledge: 42 }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  const meta = await R.loadScanMeta();
  assert.equal(meta.total_cards, 42);
  assert.equal(meta.has_readme, false);
});

test('loadScanMeta: fetch throws → graceful defaults', async () => {
  const R = load({ fetchImpl: async () => { throw new Error('network'); } });
  const meta = await R.loadScanMeta();
  assert.equal(meta.total_cards, 0);
  assert.equal(Array.isArray(meta.wiki_titles), true);
});

test('loadScanMeta: picks top language by count', async () => {
  const R = load({
    fetchImpl: async (url) => {
      if (url.includes('/scan/status')) {
        return { ok: true, json: async () => ({ languages: { python: 5, typescript: 30, rust: 2 } }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  const meta = await R.loadScanMeta();
  assert.equal(meta.top_language, 'typescript');
});

test('loadScanMeta: derives has_readme from scan/files docs category', async () => {
  const R = load({
    fetchImpl: async (url) => {
      if (url.includes('/scan/files?category=docs')) {
        return { ok: true, json: async () => ({ total: 5, files: [{ title: 'README.md', relativePath: 'README.md' }] }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  const meta = await R.loadScanMeta();
  assert.equal(meta.has_readme, true);
  assert.equal(meta.has_docs, true);
});

test('loadScanMeta: extracts wiki_titles from scan/files wiki category', async () => {
  const R = load({
    fetchImpl: async (url) => {
      if (url.includes('/scan/files?category=wiki')) {
        return { ok: true, json: async () => ({ files: [
          { title: 'Architecture' }, { title: 'API Reference' }, { title: null },
        ] }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  });
  const meta = await R.loadScanMeta();
  assert.equal(meta.wiki_titles.length, 2);
  assert.equal(meta.wiki_titles[0], 'Architecture');
});

// ── runRecall normalization ───────────────────────────────────────

test('runRecall: accepts {items}, {results}, {memories} shapes', async () => {
  for (const shape of [
    { items: [{ title: 't1', summary: 's1' }] },
    { results: [{ title: 't2', summary: 's2' }] },
    { memories: [{ title: 't3', summary: 's3' }] },
  ]) {
    const R = load({ fetchImpl: async () => ({ ok: true, json: async () => shape }) });
    const out = await R.runRecall('q');
    assert.equal(out.length, 1);
    assert.ok(out[0].title.startsWith('t'));
  }
});

test('runRecall: 500 response → empty array (no throw)', async () => {
  const R = load({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  const out = await R.runRecall('q');
  eq(out, []);
});

test('runRecall: fetch throws → empty array', async () => {
  const R = load({ fetchImpl: async () => { throw new Error('net'); } });
  const out = await R.runRecall('q');
  eq(out, []);
});

test('runRecall: falls back from title to filepath to id', async () => {
  const R = load({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ items: [
        { filepath: '/a.md', summary: 'x' },
        { id: 'abc', summary: 'y' },
        { summary: 'no title at all' },
      ] }),
    }),
  });
  const out = await R.runRecall('q', 5);
  assert.equal(out[0].title, '/a.md');
  assert.equal(out[1].title, 'abc');
  assert.equal(out[2].title, '(untitled)');
});

function eq(a, b) { assert.equal(JSON.stringify(a), JSON.stringify(b)); }
