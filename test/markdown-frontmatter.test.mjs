/**
 * Unit tests for markdown-frontmatter.mjs (F-082 Phase 0).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeFrontmatter, parseDocument } from '../src/core/markdown-frontmatter.mjs';

test('serialize: basic scalars', () => {
  const fm = serializeFrontmatter({ id: 'foo', confidence: 0.8, active: true });
  assert.match(fm, /^---\n/);
  assert.match(fm, /id: foo/);
  assert.match(fm, /confidence: 0\.8/);
  assert.match(fm, /active: true/);
  assert.match(fm, /\n---\n$/);
});

test('serialize: array as flow', () => {
  const fm = serializeFrontmatter({ topic: ['stripe', 'pgvector'] });
  assert.match(fm, /topic: \[stripe, pgvector\]/);
});

test('serialize: quoted string with special chars', () => {
  const fm = serializeFrontmatter({ title: 'Hello: World "quoted"' });
  assert.match(fm, /title: "Hello: World \\"quoted\\""/);
});

test('serialize: skips undefined values', () => {
  const fm = serializeFrontmatter({ a: 1, b: undefined, c: 'x' });
  assert.match(fm, /a: 1/);
  assert.match(fm, /c: x/);
  assert.doesNotMatch(fm, /b:/);
});

test('parse: extracts frontmatter and body', () => {
  const doc = '---\nid: foo\ncategory: decision\n---\n\n# Title\n\nbody text';
  const { frontmatter, body } = parseDocument(doc);
  assert.equal(frontmatter.id, 'foo');
  assert.equal(frontmatter.category, 'decision');
  assert.match(body, /^# Title/);
});

test('parse: no frontmatter fence returns body as-is', () => {
  const doc = '# Just a heading\n\nNo frontmatter here.';
  const { frontmatter, body } = parseDocument(doc);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, doc);
});

test('parse: array values', () => {
  const { frontmatter } = parseDocument('---\ntopic: [a, b, c]\n---\n');
  assert.deepEqual(frontmatter.topic, ['a', 'b', 'c']);
});

test('parse: numbers + booleans', () => {
  const { frontmatter } = parseDocument('---\nconfidence: 0.85\nactive: true\nlevel: 3\n---\n');
  assert.equal(frontmatter.confidence, 0.85);
  assert.equal(frontmatter.active, true);
  assert.equal(frontmatter.level, 3);
});

test('round-trip: serialize then parse preserves data', () => {
  const original = {
    id: 'kc_123',
    category: 'decision',
    title: 'Pick pgvector',
    topic: ['stripe-onboarding', 'vector-store'],
    confidence: 0.9,
    active: true,
  };
  const fm = serializeFrontmatter(original);
  const doc = fm + '\nbody';
  const { frontmatter } = parseDocument(doc);
  assert.deepEqual(frontmatter, original);
});

test('parse: quoted string with escaped quote round-trip', () => {
  const original = { title: 'Hello "quoted" world' };
  const fm = serializeFrontmatter(original);
  const { frontmatter } = parseDocument(fm + '\nbody');
  assert.equal(frontmatter.title, 'Hello "quoted" world');
});
