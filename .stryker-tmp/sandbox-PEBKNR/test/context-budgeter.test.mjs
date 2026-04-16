// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyContextBudget, estimateTokenCount } from '../src/core/context-budgeter.mjs';

test('estimateTokenCount uses simple char heuristic', () => {
  assert.equal(estimateTokenCount('12345678'), 2);
});

test('applyContextBudget keeps at least one item and truncates overflow', () => {
  const result = applyContextBudget([
    { id: 'a', tokens_est: 30 },
    { id: 'b', tokens_est: 25 },
    { id: 'c', tokens_est: 20 },
  ], {
    tokenBudget: 40,
    minItems: 1,
    maxItems: 3,
  });

  assert.deepEqual(result.items.map((item) => item.id), ['a']);
  assert.equal(result.truncated, true);
});
