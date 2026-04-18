/**
 * F-053 Phase 3 · L2 integration for `query-type-router.mjs`.
 *
 * Deterministic — uses a mock embedder that assigns each archetype a
 * canonical basis vector, then verifies classification picks the right
 * archetype for queries designed to map to that vector.
 *
 * Real multilingual parity is covered in the chaos + E2E layers where
 * the actual `multilingual-e5-small` pipeline runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHETYPES,
  STRATEGY,
  CONFIDENCE_THRESHOLD,
  buildArchetypeIndex,
  classifyQuery,
  getStrategy,
} from '../src/core/query-type-router.mjs';

const DIM = 384; // matches embedder.mjs

/**
 * Produce a one-hot vector in R^DIM at the given position. Cosine between
 * two one-hot vectors at positions i != j is 0; same position is 1.
 */
function oneHot(pos) {
  const v = new Float32Array(DIM);
  v[pos % DIM] = 1.0;
  return v;
}

/**
 * Produce a normalised mix of two one-hot positions with given weight.
 * Used to simulate "a paraphrase close to archetype A but not identical".
 */
function mix(posA, posB, weightA = 0.8) {
  const v = new Float32Array(DIM);
  v[posA % DIM] = weightA;
  v[posB % DIM] = Math.sqrt(Math.max(0, 1 - weightA * weightA));
  return v;
}

/**
 * Build a mock embedder that embeds archetypes to their canonical
 * one-hot and embeds user queries to whatever the test fixture says.
 */
function makeMockEmbedder(queryVectorMap = new Map()) {
  const archetypeIds = ARCHETYPES.map((a) => a.id);
  return async (text, _type, _lang) => {
    // Archetype injection: embed() is called with the archetype.text
    // during buildArchetypeIndex.
    for (let i = 0; i < ARCHETYPES.length; i++) {
      if (text === ARCHETYPES[i].text) return oneHot(i);
    }
    // Query injection from the map, or a far-away vector as default.
    if (queryVectorMap.has(text)) return queryVectorMap.get(text);
    return oneHot(300); // deliberately far from every archetype
  };
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------

test('ARCHETYPES contract: 10 entries, unique ids, english strings', () => {
  assert.equal(ARCHETYPES.length, 10);
  const ids = new Set(ARCHETYPES.map((a) => a.id));
  assert.equal(ids.size, 10, 'archetype ids must be unique');
  for (const a of ARCHETYPES) {
    assert.equal(typeof a.id, 'string');
    assert.equal(typeof a.text, 'string');
    assert.ok(a.text.length > 0);
  }
});

test('STRATEGY contract: every archetype has a strategy', () => {
  for (const a of ARCHETYPES) {
    const s = STRATEGY[a.id];
    assert.ok(s, `${a.id} missing strategy`);
    assert.equal(typeof s.rawRatio, 'number');
    assert.ok(s.rawRatio >= 0 && s.rawRatio <= 1);
    assert.equal(typeof s.graphBoost, 'number');
  }
});

test('getStrategy returns the table entry or null', () => {
  assert.ok(getStrategy('decision-why'));
  assert.equal(getStrategy('nonexistent-archetype'), null);
});

// ---------------------------------------------------------------------------
// buildArchetypeIndex
// ---------------------------------------------------------------------------

test('buildArchetypeIndex embeds every archetype and returns parallel arrays', async () => {
  const index = await buildArchetypeIndex({ embed: makeMockEmbedder() });
  assert.equal(index.vectors.length, 10);
  assert.equal(index.ids.length, 10);
  assert.equal(index.language, 'multilingual');
  for (let i = 0; i < 10; i++) {
    assert.equal(index.ids[i], ARCHETYPES[i].id);
    assert.ok(index.vectors[i] instanceof Float32Array);
    assert.equal(index.vectors[i].length, DIM);
  }
});

test('buildArchetypeIndex throws if embedder returns empty', async () => {
  const badEmbed = async () => new Float32Array(0);
  await assert.rejects(
    buildArchetypeIndex({ embed: badEmbed }),
    /archetype embed failed/,
  );
});

// ---------------------------------------------------------------------------
// classifyQuery — happy paths
// ---------------------------------------------------------------------------

test('classifyQuery picks the archetype with max cosine (exact match)', async () => {
  const embedder = makeMockEmbedder();
  const index = await buildArchetypeIndex({ embed: embedder });

  // Query embedded exactly to archetype 0 ("decision-why").
  const queryMap = new Map([['why-query', oneHot(0)]]);
  const out = await classifyQuery('why-query', index, { embed: makeMockEmbedder(queryMap) });

  assert.equal(out.archetype, 'decision-why');
  assert.ok(out.confidence > 0.99, `confidence should ≈ 1.0, got ${out.confidence}`);
  assert.equal(out.strategy.rawRatio, 0.80);
});

test('classifyQuery routes a near-paraphrase (80% weight) to the closer archetype', async () => {
  const embedder = makeMockEmbedder();
  const index = await buildArchetypeIndex({ embed: embedder });

  // Mix heavily toward archetype 2 ("procedure-how") with a bit of 0.
  const queryMap = new Map([['how-ish', mix(2, 0, 0.85)]]);
  const out = await classifyQuery('how-ish', index, { embed: makeMockEmbedder(queryMap) });

  assert.equal(out.archetype, 'procedure-how');
  assert.ok(out.confidence > 0.5 && out.confidence < 1.0);
});

test('classifyQuery reaches every archetype from a perfectly-matching query', async () => {
  const embedder = makeMockEmbedder();
  const index = await buildArchetypeIndex({ embed: embedder });

  for (let i = 0; i < ARCHETYPES.length; i++) {
    const id = ARCHETYPES[i].id;
    const queryMap = new Map([[id, oneHot(i)]]);
    const out = await classifyQuery(id, index, { embed: makeMockEmbedder(queryMap) });
    assert.equal(out.archetype, id, `archetype ${id} must be reachable`);
    assert.ok(out.strategy, `archetype ${id} must yield a strategy`);
  }
});

// ---------------------------------------------------------------------------
// classifyQuery — confidence gate & fallbacks
// ---------------------------------------------------------------------------

test('classifyQuery falls back when cosine < CONFIDENCE_THRESHOLD', async () => {
  const embedder = makeMockEmbedder();
  const index = await buildArchetypeIndex({ embed: embedder });

  // Default mock embedder returns oneHot(300) for unknown queries — all
  // archetypes are at positions 0-9, so cosine is 0 everywhere.
  const out = await classifyQuery('utterly-unseen-query', index, {
    embed: makeMockEmbedder(),
  });
  assert.equal(out.archetype, null);
  assert.equal(out.strategy, null);
  assert.match(out.fallbackReason, /below-threshold/);
});

test('classifyQuery falls back on empty / whitespace / non-string query', async () => {
  const index = await buildArchetypeIndex({ embed: makeMockEmbedder() });
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const out = await classifyQuery(bad, index, { embed: makeMockEmbedder() });
    assert.equal(out.archetype, null);
    assert.equal(out.fallbackReason, 'empty-query');
  }
});

test('classifyQuery falls back when index is null or malformed', async () => {
  const out1 = await classifyQuery('q', null, { embed: makeMockEmbedder() });
  assert.equal(out1.archetype, null);
  assert.equal(out1.fallbackReason, 'index-unavailable');

  const out2 = await classifyQuery('q', { vectors: [], ids: [] }, { embed: makeMockEmbedder() });
  assert.equal(out2.archetype, null);
  assert.equal(out2.fallbackReason, 'index-unavailable');
});

test('classifyQuery falls back when embedder throws', async () => {
  const index = await buildArchetypeIndex({ embed: makeMockEmbedder() });
  const throwEmbed = async () => { throw new Error('ONNX runtime down'); };
  const out = await classifyQuery('q', index, { embed: throwEmbed });
  assert.equal(out.archetype, null);
  assert.equal(out.strategy, null);
  assert.match(out.fallbackReason, /embed-failed/);
});

test('classifyQuery falls back when embedder returns empty vector', async () => {
  const index = await buildArchetypeIndex({ embed: makeMockEmbedder() });
  const emptyEmbed = async () => new Float32Array(0);
  const out = await classifyQuery('q', index, { embed: emptyEmbed });
  assert.equal(out.archetype, null);
  assert.equal(out.fallbackReason, 'embed-empty');
});

// ---------------------------------------------------------------------------
// Determinism — same query must always route the same way
// ---------------------------------------------------------------------------

test('classifyQuery is deterministic across repeated calls', async () => {
  const index = await buildArchetypeIndex({ embed: makeMockEmbedder() });
  const queryMap = new Map([['deterministic', oneHot(5)]]);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const out = await classifyQuery('deterministic', index, {
      embed: makeMockEmbedder(queryMap),
    });
    runs.push(out.archetype);
  }
  // Archetype index 5 in the ordered ARCHETYPES list is `temporal-when`.
  const expected = ARCHETYPES[5].id;
  assert.ok(runs.every((r) => r === expected),
    `all runs must agree on ${expected}, got ${JSON.stringify(runs)}`);
});

// ---------------------------------------------------------------------------
// Threshold constant sanity
// ---------------------------------------------------------------------------

test('CONFIDENCE_THRESHOLD is in (0, 1)', () => {
  assert.ok(CONFIDENCE_THRESHOLD > 0 && CONFIDENCE_THRESHOLD < 1);
});
