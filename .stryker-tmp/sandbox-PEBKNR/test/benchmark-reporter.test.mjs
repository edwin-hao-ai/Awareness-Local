// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderBenchmarkMarkdown,
  writeBenchmarkMarkdownReport,
} from '../src/benchmark/benchmark-reporter.mjs';

test('renderBenchmarkMarkdown shows summary and skipped systems', () => {
  const markdown = renderBenchmarkMarkdown([
    {
      system: 'project-builtin',
      skipped: false,
      summary: {
        totalCases: 5,
        recallAt3: 1,
        recallAt5: 1,
        mrr: 1,
        ndcgAt5: 1,
        injectedTokensAvg: 123.4,
        answerHitRate: 1,
      },
      cases: [],
    },
    {
      system: 'project-qmd',
      skipped: true,
      status: { reason: 'QMD backend not configured' },
      summary: {},
      cases: [],
    },
  ], {
    datasetPath: 'tests/memory-benchmark/datasets/universal_core.jsonl',
    generatedAt: '2026-04-03T00:00:00.000Z',
  });

  assert.match(markdown, /# Benchmark Report/);
  assert.match(markdown, /project-builtin/);
  assert.match(markdown, /project-qmd/);
  assert.match(markdown, /QMD backend not configured/);
});

test('writeBenchmarkMarkdownReport persists markdown to disk', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-bench-'));
  const reportPath = path.join(tempDir, 'report.md');

  writeBenchmarkMarkdownReport(reportPath, [{
    system: 'project-builtin',
    skipped: false,
    summary: {
      totalCases: 1,
      recallAt3: 1,
      recallAt5: 1,
      mrr: 1,
      ndcgAt5: 1,
      injectedTokensAvg: 10,
      answerHitRate: 1,
    },
    cases: [],
  }], {
    datasetPath: 'dataset.jsonl',
    generatedAt: '2026-04-03T00:00:00.000Z',
  });

  const content = fs.readFileSync(reportPath, 'utf8');
  assert.match(content, /dataset\.jsonl/);
  assert.match(content, /project-builtin/);
});