/**
 * F-055 bug A — persona injection gate.
 *
 * Before F-055, `buildInitResult` blindly surfaced every recent
 * `personal_preference`-like card inside `<who-you-are>`, so a card like
 * "user loves making beef noodle on weekends" leaked into an unrelated
 * "debug daemon perf" session. After F-055 we gate persona on:
 *   - focus present: BM25 relevance OR confidence ≥ 0.9
 *   - focus empty : confidence ≥ 0.9 only
 *   - always cap at 3 cards.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterPersonaByRelevance } from '../src/daemon/helpers.mjs';


function makeCard(id, category, title, confidence = 0.8) {
  return {
    id,
    category,
    title,
    summary: title,
    confidence,
    status: 'active',
    created_at: new Date().toISOString(),
  };
}

function makeIndexer(matchedIds) {
  // Fake indexer: searchKnowledge returns only the cards whose id appears
  // in the provided set (simulates BM25 matching by test intent).
  const byId = new Map();
  return {
    register: (card) => { byId.set(card.id, card); },
    searchKnowledge: (_focus, _opts) => {
      const out = [];
      for (const id of matchedIds) {
        const c = byId.get(id);
        if (c) out.push(c);
      }
      return out;
    },
  };
}


describe('F-055 bug A — filterPersonaByRelevance', () => {
  it('returns [] when personaCards is empty', () => {
    const out = filterPersonaByRelevance([], null, 'anything');
    assert.deepEqual(out, []);
  });

  it('returns [] when personaCards is not an array', () => {
    const out = filterPersonaByRelevance(undefined, null, 'anything');
    assert.deepEqual(out, []);
  });

  it('empty focus + confidence < 0.9 → drops all personas', () => {
    const cards = [
      makeCard('kc_1', 'personal_preference', 'likes beef noodles', 0.7),
      makeCard('kc_2', 'personal_preference', 'likes pgvector', 0.8),
    ];
    const out = filterPersonaByRelevance(cards, null, '');
    assert.deepEqual(out, []);
  });

  it('empty focus + high confidence (≥0.9) → keeps high-confidence only', () => {
    const cards = [
      makeCard('kc_low', 'personal_preference', 'likes beef noodles', 0.7),
      makeCard('kc_high', 'personal_preference', 'user is a backend engineer', 0.95),
    ];
    const out = filterPersonaByRelevance(cards, null, '');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'kc_high');
  });

  it('focus present + BM25 match → keeps the relevant card', () => {
    const cards = [
      makeCard('kc_pg', 'personal_preference', 'likes pgvector', 0.8),
      makeCard('kc_beef', 'personal_preference', 'likes beef noodles', 0.8),
    ];
    const indexer = makeIndexer(['kc_pg']);
    cards.forEach((c) => indexer.register(c));
    const out = filterPersonaByRelevance(cards, indexer, 'vector database');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'kc_pg');
  });

  it('focus present + BM25 no-match + low confidence → drops', () => {
    const cards = [
      makeCard('kc_beef', 'personal_preference', 'likes beef noodles', 0.7),
    ];
    const indexer = makeIndexer([]); // BM25 found nothing
    cards.forEach((c) => indexer.register(c));
    const out = filterPersonaByRelevance(cards, indexer, 'daemon perf tuning');
    assert.deepEqual(out, []);
  });

  it('focus present + BM25 no-match + high confidence → still keeps', () => {
    const cards = [
      makeCard('kc_beef', 'personal_preference', 'likes beef noodles', 0.95),
    ];
    const indexer = makeIndexer([]);
    cards.forEach((c) => indexer.register(c));
    const out = filterPersonaByRelevance(cards, indexer, 'daemon perf tuning');
    assert.equal(out.length, 1, 'high-confidence persona should bypass BM25 gate');
  });

  it('caps at 3 cards by default even when more match', () => {
    const cards = Array.from({ length: 8 }, (_, i) =>
      makeCard(`kc_${i}`, 'personal_preference', `persona ${i}`, 0.95)
    );
    const out = filterPersonaByRelevance(cards, null, '');
    assert.equal(out.length, 3);
  });

  it('respects custom maxPersonaCards override', () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      makeCard(`kc_${i}`, 'personal_preference', `persona ${i}`, 0.95)
    );
    const out = filterPersonaByRelevance(cards, null, '', { maxPersonaCards: 1 });
    assert.equal(out.length, 1);
  });

  it('safe fallback: searchKnowledge throws → falls back to confidence filter', () => {
    const cards = [
      makeCard('kc_low', 'personal_preference', 'low', 0.7),
      makeCard('kc_high', 'personal_preference', 'high', 0.95),
    ];
    const brokenIndexer = {
      searchKnowledge: () => { throw new Error('index offline'); },
    };
    const out = filterPersonaByRelevance(cards, brokenIndexer, 'anything');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'kc_high');
  });

  it('safe fallback: indexer without searchKnowledge → confidence filter only', () => {
    const cards = [
      makeCard('kc_low', 'personal_preference', 'low', 0.7),
      makeCard('kc_high', 'personal_preference', 'high', 0.95),
    ];
    const out = filterPersonaByRelevance(cards, {}, 'anything');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'kc_high');
  });

  it('preserves order from input (stable filter)', () => {
    const cards = [
      makeCard('kc_1', 'personal_preference', 'first', 0.95),
      makeCard('kc_2', 'personal_preference', 'second', 0.95),
      makeCard('kc_3', 'personal_preference', 'third', 0.95),
    ];
    const out = filterPersonaByRelevance(cards, null, '');
    assert.deepEqual(out.map((c) => c.id), ['kc_1', 'kc_2', 'kc_3']);
  });
});
