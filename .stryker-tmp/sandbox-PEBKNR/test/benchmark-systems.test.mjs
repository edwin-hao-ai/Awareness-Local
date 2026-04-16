// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSearchBenchmarkSystem,
  normalizeBackendSelection,
} from '../src/benchmark/systems.mjs';
import { runBenchmarkSuite } from '../src/benchmark/benchmark-runner.mjs';

test('createSearchBenchmarkSystem adapts recall results into benchmark output', async () => {
  let closed = false;
  const system = createSearchBenchmarkSystem({
    name: 'builtin',
    search: {
      async recall() {
        return [
          { id: 'mem_1', title: 'Doc 1', summary: 'alpha', tokens_est: 20 },
          { id: 'mem_2', title: 'Doc 2', summary: 'beta', tokens_est: 15 },
        ];
      },
      async close() {
        closed = true;
      },
    },
  });

  const result = await system.runCase({ query: 'auth', max_prompt_tokens: 100 });
  await system.close();

  assert.equal(result.results.length, 2);
  assert.equal(result.injectedTokens, 35);
  assert.match(result.answerText, /Doc 1/);
  assert.equal(closed, true);
});

test('normalizeBackendSelection supports all and csv values', () => {
  assert.deepEqual(normalizeBackendSelection('all'), ['builtin', 'qmd', 'hybrid']);
  assert.deepEqual(normalizeBackendSelection('builtin,hybrid'), ['builtin', 'hybrid']);
  assert.throws(() => normalizeBackendSelection('invalid'));
});

test('createSearchBenchmarkSystem can mark systems as skipped', () => {
  const system = createSearchBenchmarkSystem({
    name: 'qmd',
    search: { recall: async () => [] },
    backendKind: 'qmd',
    runnable: false,
    statusProvider: () => ({ backendKind: 'qmd', runnable: false, reason: 'QMD backend not configured' }),
  });

  assert.equal(system.runnable, false);
  assert.equal(system.getStatus().reason, 'QMD backend not configured');
});

test('runBenchmarkSuite writes markdown report when requested', async () => {
  const tempDir = await import('node:fs/promises').then((fs) => fs.mkdtemp('/tmp/awareness-bench-'));
  const datasetPath = `${tempDir}/dataset.jsonl`;
  const jsonReportPath = `${tempDir}/report.json`;
  const markdownReportPath = `${tempDir}/report.md`;
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(datasetPath, '{"id":"case-1","category":"recall","query":"auth","gold_memory_ids":["mem_1"],"expected_points":["alpha"]}\n'),
  );

  const system = createSearchBenchmarkSystem({
    name: 'builtin',
    search: {
      async recall() {
        return [{ id: 'mem_1', title: 'Doc 1', summary: 'alpha', tokens_est: 20 }];
      },
    },
  });

  await runBenchmarkSuite({
    systems: [system],
    datasetPath,
    reportPath: jsonReportPath,
    markdownReportPath,
  });

  const markdown = await import('node:fs/promises').then((fs) => fs.readFile(markdownReportPath, 'utf8'));
  assert.match(markdown, /Benchmark Report/);
  assert.match(markdown, /builtin/);
});
