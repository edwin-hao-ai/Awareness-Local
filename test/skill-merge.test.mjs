import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkill } from '../src/daemon/skill-merge.mjs';

test('mergeSkill preserves v1 methods + appends v2 new steps', () => {
  const existing = {
    summary: 'Publish @awareness-sdk/* to npm (200 chars...).',
    methods: JSON.stringify([
      { step: 1, description: 'Bump version in package.json' },
      { step: 2, description: 'Run npm publish' },
    ]),
    trigger_conditions: JSON.stringify([{ pattern: 'publish sdk', weight: 0.9 }]),
    tags: JSON.stringify(['npm', 'publish']),
    source_card_ids: JSON.stringify(['kc_a']),
    confidence: 0.9,
  };
  const incoming = {
    summary: 'New shorter summary',
    methods: [
      { step: 3, description: 'Verify via npm view' },
    ],
    trigger_conditions: [{ pattern: 'release to npm', weight: 0.8 }],
    tags: ['release'],
    source_card_ids: ['kc_b'],
    confidence: 0.8,
  };
  const merged = mergeSkill(existing, incoming);
  const methods = JSON.parse(merged.methods);
  assert.equal(methods.length, 3, 'v1 keeps 2 + v2 adds 1 = 3 total');
  assert.equal(methods[0].step, 1);
  assert.equal(methods[1].step, 2);
  assert.equal(methods[2].step, 3);
  assert.equal(methods[2].description, 'Verify via npm view');
});

test('mergeSkill de-dups methods by description (case-insensitive)', () => {
  const existing = {
    methods: JSON.stringify([{ step: 1, description: 'Run npm publish' }]),
    tags: JSON.stringify([]),
    source_card_ids: JSON.stringify([]),
  };
  const incoming = {
    methods: [
      { description: 'Run NPM publish' }, // dup of existing (case-insensitive)
      { description: 'Run tests' },       // new
    ],
  };
  const merged = mergeSkill(existing, incoming);
  const methods = JSON.parse(merged.methods);
  assert.equal(methods.length, 2, 'case-insensitive dedup: v1[0] survives, v2[0] dropped, v2[1] kept');
});

test('mergeSkill unions tags (case-insensitive)', () => {
  const existing = { tags: JSON.stringify(['npm', 'publish']), methods: JSON.stringify([]), source_card_ids: JSON.stringify([]) };
  const incoming = { tags: ['NPM', 'release', 'publish'] };
  const merged = mergeSkill(existing, incoming);
  const tags = JSON.parse(merged.tags);
  assert.equal(tags.length, 3, 'npm / publish / release');
  assert.ok(tags.includes('npm'));
  assert.ok(tags.includes('publish'));
  assert.ok(tags.includes('release'));
});

test('mergeSkill unions source_card_ids', () => {
  const existing = {
    methods: JSON.stringify([]),
    tags: JSON.stringify([]),
    source_card_ids: JSON.stringify(['kc_a', 'kc_b']),
  };
  const incoming = { source_card_ids: ['kc_b', 'kc_c'] };
  const merged = mergeSkill(existing, incoming);
  const ids = JSON.parse(merged.source_card_ids);
  assert.deepEqual(ids, ['kc_a', 'kc_b', 'kc_c']);
});

test('mergeSkill keeps longer summary', () => {
  const longSummary = 'x'.repeat(300);
  const existing = { summary: longSummary, methods: JSON.stringify([]), tags: JSON.stringify([]), source_card_ids: JSON.stringify([]) };
  const incoming = { summary: 'tiny' };
  const merged = mergeSkill(existing, incoming);
  assert.equal(merged.summary, longSummary);
});

test('mergeSkill adopts v2 summary when longer', () => {
  const existing = { summary: 'short', methods: JSON.stringify([]), tags: JSON.stringify([]), source_card_ids: JSON.stringify([]) };
  const incoming = { summary: 'longer and richer content' + 'x'.repeat(100) };
  const merged = mergeSkill(existing, incoming);
  assert.equal(merged.summary, incoming.summary);
});

test('mergeSkill takes max confidence', () => {
  const existing = { confidence: 0.7, methods: JSON.stringify([]), tags: JSON.stringify([]), source_card_ids: JSON.stringify([]) };
  const incoming = { confidence: 0.95 };
  const merged = mergeSkill(existing, incoming);
  assert.equal(merged.confidence, 0.95);
});

test('mergeSkill resets decay_score to 1.0 (UPSERT freshness)', () => {
  const existing = { methods: JSON.stringify([]), tags: JSON.stringify([]), source_card_ids: JSON.stringify([]) };
  const merged = mergeSkill(existing, {});
  assert.equal(merged.decay_score, 1.0);
});

test('mergeSkill renumbers steps contiguously 1..N', () => {
  const existing = {
    methods: JSON.stringify([
      { step: 1, description: 'a' },
      { step: 7, description: 'b' }, // weird numbering on input
    ]),
    tags: JSON.stringify([]),
    source_card_ids: JSON.stringify([]),
  };
  const incoming = {
    methods: [{ step: 99, description: 'c' }],
  };
  const merged = mergeSkill(existing, incoming);
  const methods = JSON.parse(merged.methods);
  assert.equal(methods.length, 3);
  assert.equal(methods[0].step, 1);
  assert.equal(methods[1].step, 2);
  assert.equal(methods[2].step, 3);
});

test('mergeSkill de-dups trigger_conditions by pattern', () => {
  const existing = {
    methods: JSON.stringify([]),
    tags: JSON.stringify([]),
    source_card_ids: JSON.stringify([]),
    trigger_conditions: JSON.stringify([{ pattern: 'publish', weight: 0.9 }]),
  };
  const incoming = {
    trigger_conditions: [
      { pattern: 'PUBLISH', weight: 0.95 }, // dup case-insensitive
      { pattern: 'release', weight: 0.8 },
    ],
  };
  const merged = mergeSkill(existing, incoming);
  const triggers = JSON.parse(merged.trigger_conditions);
  assert.equal(triggers.length, 2);
  assert.equal(triggers[0].pattern, 'publish');
  assert.equal(triggers[1].pattern, 'release');
});
