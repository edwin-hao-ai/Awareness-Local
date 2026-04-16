// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAnswerHitRate,
  computeMRR,
  computeNdcgAtK,
  computeRecallAtK,
  summarizeBenchmarkResults,
} from '../src/benchmark/benchmark-metrics.mjs';

test('benchmark metrics compute expected ranking values', () => {
  const results = ['a', 'b', 'c', 'd'];
  const gold = ['c', 'x'];

  assert.equal(computeRecallAtK(results, gold, 3), 0.5);
  assert.equal(computeMRR(results, gold), 1 / 3);
  assert.ok(computeNdcgAtK(results, gold, 3) > 0);
});

test('answer hit rate matches expected points proportionally', () => {
  const answer = '不能直接 prisma db push，应使用手动 SQL migration。';
  const expected = ['不能直接 prisma db push', '手动 SQL migration'];
  assert.equal(computeAnswerHitRate(answer, expected), 1);
});

test('benchmark summary averages case results', () => {
  const summary = summarizeBenchmarkResults([
    { recallAt3: 1, recallAt5: 1, mrr: 1, ndcgAt5: 1, injectedTokens: 100, answerHitRate: 1 },
    { recallAt3: 0, recallAt5: 0.5, mrr: 0.5, ndcgAt5: 0.4, injectedTokens: 300, answerHitRate: 0.5 },
  ]);

  assert.equal(summary.totalCases, 2);
  assert.equal(summary.recallAt3, 0.5);
  assert.equal(summary.injectedTokensAvg, 200);
});
