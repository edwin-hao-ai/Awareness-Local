/**
 * Unit tests for markdown-tree.mjs (F-082 Phase 0).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  slugify,
  dateBucket,
  resolveCardPath,
  resolveTopicPath,
  resolveJournalPath,
  resolveEntityPath,
} from '../src/core/markdown-tree.mjs';

const HOME = '/tmp/.awareness-test';

test('slugify: basic ASCII', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Foo!?  Bar  '), 'foo-bar');
});

test('slugify: empty / null returns "untitled"', () => {
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify(null), 'untitled');
  assert.equal(slugify('   '), 'untitled');
});

test('slugify: preserves CJK', () => {
  assert.equal(slugify('选 pgvector 而非 Pinecone'), '选-pgvector-而非-pinecone');
});

test('slugify: caps at 60 chars', () => {
  const long = 'a'.repeat(200);
  assert.equal(slugify(long).length, 60);
});

test('dateBucket: parses ISO into year/month/day', () => {
  const b = dateBucket('2026-04-25T10:32:14Z');
  assert.equal(b.year, '2026');
  assert.equal(b.month, '04');
  assert.equal(b.ymd, '2026-04-25');
});

test('dateBucket: defaults to now if undefined or invalid', () => {
  const b = dateBucket(undefined);
  assert.match(b.year, /^\d{4}$/);
  const b2 = dateBucket('not-a-date');
  assert.match(b2.year, /^\d{4}$/);
});

test('resolveCardPath: builds cards/YYYY/MM/<date>-<cat>-<slug>.md', () => {
  const r = resolveCardPath(HOME, {
    category: 'decision',
    title: 'Pick pgvector',
    created_at: '2026-04-25T10:32:14Z',
  });
  assert.equal(r.relPath, path.join('cards', '2026', '04', '2026-04-25-decision-pick-pgvector.md'));
  assert.ok(r.absPath.startsWith(HOME));
  assert.equal(r.slug, '2026-04-25-decision-pick-pgvector');
});

test('resolveCardPath: missing title falls back to "untitled"', () => {
  const r = resolveCardPath(HOME, { category: 'pitfall', created_at: '2026-04-25T00:00:00Z' });
  assert.match(r.slug, /^2026-04-25-pitfall-untitled$/);
});

test('resolveTopicPath: topics/<slug>.md', () => {
  const r = resolveTopicPath(HOME, 'Stripe Onboarding');
  assert.equal(r.slug, 'stripe-onboarding');
  assert.equal(r.relPath, path.join('topics', 'stripe-onboarding.md'));
});

test('resolveJournalPath: journal/<YYYY-MM-DD>.md', () => {
  const r = resolveJournalPath(HOME, '2026-04-25T18:00:00Z');
  assert.equal(r.relPath, path.join('journal', '2026-04-25.md'));
  assert.equal(r.slug, '2026-04-25');
});

test('resolveEntityPath: entities/<slug>.md', () => {
  const r = resolveEntityPath(HOME, 'pgvector');
  assert.equal(r.relPath, path.join('entities', 'pgvector.md'));
});
