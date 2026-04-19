/**
 * F-055 bug D — _submitInsights integration.
 *
 * Locks the daemon-side quality gate behavior:
 *   - low-quality card is rejected and listed in response.cards_skipped
 *   - other legal cards in the same batch are still persisted
 *   - envelope-prefixed card is rejected by defense-in-depth
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';


async function loadDaemonModule() {
  return await import('../src/daemon.mjs');
}

function makeFakeDaemon(mod) {
  const indexedCards = [];
  const fake = Object.create(mod.AwarenessLocalDaemon.prototype);

  fake.awarenessDir = path.join(os.tmpdir(), `awareness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(fake.awarenessDir, { recursive: true });

  fake.indexer = {
    indexKnowledgeCard: (card) => { indexedCards.push(card); },
    tryAutoMoc: () => [],
    db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
  };
  fake.extractor = null;
  fake._refineMocTitles = async () => {};

  return { fake, indexedCards };
}


describe('F-055 bug D — _submitInsights quality gate', () => {
  it('rejects low-quality card (summary too short, summary==title) but keeps good cards', async () => {
    const mod = await loadDaemonModule();
    const { fake, indexedCards } = makeFakeDaemon(mod);

    const result = await fake._submitInsights({
      insights: {
        knowledge_cards: [
          // Bad: summary too short AND equals title
          { category: 'decision', title: 'x', summary: 'x' },
          // Good: rich tech summary
          {
            category: 'decision',
            title: 'Chose pgvector',
            summary:
              '**Decision**: pgvector over Pinecone. Saves ~$70/mo, co-locates ' +
              'with relational data, supports cosine via `<=>` operator.',
          },
        ],
      },
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.cards_created, 1, 'only the good card should be persisted');
    assert.ok(Array.isArray(result.cards_skipped), 'skipped list must be returned');
    assert.equal(result.cards_skipped.length, 1);
    assert.equal(result.cards_skipped[0].card_index, 0);
    const reasons = result.cards_skipped[0].reasons;
    assert.ok(
      reasons.some((r) => r.startsWith('summary_too_short')),
      `expected summary_too_short in reasons: ${JSON.stringify(reasons)}`,
    );
    assert.ok(reasons.includes('summary_equals_title'));

    assert.equal(indexedCards.length, 1);
    assert.equal(indexedCards[0].title, 'Chose pgvector');
  });

  it('rejects envelope-prefix card via defense-in-depth', async () => {
    const mod = await loadDaemonModule();
    const { fake, indexedCards } = makeFakeDaemon(mod);

    const result = await fake._submitInsights({
      insights: {
        knowledge_cards: [
          {
            category: 'insight',
            title: 'Sender (untrusted metadata): foo',
            summary: 'a'.repeat(120), // long enough to pass length, envelope still rejects
          },
        ],
      },
    });

    assert.equal(result.cards_created, 0);
    assert.equal(result.cards_skipped.length, 1);
    assert.ok(result.cards_skipped[0].reasons.includes('envelope_pattern_in_content'));
    assert.equal(indexedCards.length, 0);
  });

  it('accepts short personal_preference (≥40 chars) — F-055 Journey 10', async () => {
    const mod = await loadDaemonModule();
    const { fake, indexedCards } = makeFakeDaemon(mod);

    const result = await fake._submitInsights({
      insights: {
        knowledge_cards: [
          {
            category: 'personal_preference',
            title: '深色模式',
            summary:
              '用户偏好深色模式，所有 IDE 主题都选 solarized-dark，终端也用暗色背景配亮色前景，护眼',
          },
        ],
      },
    });

    assert.equal(result.cards_created, 1, 'personal_preference ≥40 chars should pass');
    assert.equal(result.cards_skipped, undefined, 'no skipped key when all cards pass');
    assert.equal(indexedCards.length, 1);
  });

  it('returns no cards_skipped key when all cards pass', async () => {
    const mod = await loadDaemonModule();
    const { fake } = makeFakeDaemon(mod);

    const result = await fake._submitInsights({
      insights: {
        knowledge_cards: [
          {
            category: 'decision',
            title: 'Good decision',
            summary:
              'Chose X because it gives Y, trades off Z, and integrates with existing W — full length 80+ chars.',
          },
        ],
      },
    });

    assert.equal(result.cards_created, 1);
    assert.equal(result.cards_skipped, undefined, 'absent key when no rejections');
  });
});
