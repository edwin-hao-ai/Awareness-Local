// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePerceptionSample,
  renderPerceptionMarkdown,
  summarizePerceptionResults,
} from '../src/benchmark/perception-benchmark.mjs';

test('evaluatePerceptionSample captures exact guard matches', () => {
  const result = evaluatePerceptionSample({
    id: 'signal-guard',
    category: 'guard',
    input_event: {
      title: '再次尝试 prisma db push',
      content: 'I plan to run prisma db push on production.',
      tags: ['prisma', 'prod'],
    },
    expected_signals: ['guard'],
    expected_severity: 'high',
    must_block: true,
    must_reference: ['pitfall_prisma_db_push'],
  });

  assert.equal(result.typeRecall, 1);
  assert.equal(result.typePrecision, 1);
  assert.equal(result.guardHit, 1);
  assert.equal(result.referenceMatch, 1);
});

test('summarizePerceptionResults averages benchmark rows', () => {
  const summary = summarizePerceptionResults([
    { typeRecall: 1, typePrecision: 1, guardHit: 1, severityMatch: 1, blockMatch: 1, referenceMatch: 1, missingTypes: [], extraTypes: [] },
    { typeRecall: 0.5, typePrecision: 1, guardHit: 0, severityMatch: 0, blockMatch: 0, referenceMatch: 0, missingTypes: ['guard'], extraTypes: [] },
  ]);

  assert.equal(summary.totalCases, 2);
  assert.equal(summary.signalRecall, 0.75);
  assert.equal(summary.guardHitRate, 0.5);
  assert.equal(summary.exactMatchRate, 0.5);
});

test('renderPerceptionMarkdown renders core metrics and case notes', () => {
  const markdown = renderPerceptionMarkdown({
    generatedAt: '2026-04-03T00:00:00.000Z',
    summary: {
      totalCases: 2,
      signalRecall: 1,
      signalPrecision: 1,
      guardHitRate: 1,
      severityAccuracy: 1,
      blockAccuracy: 1,
      referenceAccuracy: 1,
      exactMatchRate: 1,
    },
    cases: [
      { sampleId: 'signal-001', predictedTypes: ['guard'], missingTypes: [], extraTypes: [] },
    ],
  }, 'dataset.jsonl');

  assert.match(markdown, /Perception Benchmark Report/);
  assert.match(markdown, /Signal Recall/);
  assert.match(markdown, /signal-001/);
});