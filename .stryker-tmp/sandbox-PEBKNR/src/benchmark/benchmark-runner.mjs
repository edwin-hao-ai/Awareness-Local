// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

import {
  computeAnswerHitRate,
  computeMRR,
  computeNdcgAtK,
  computeRecallAtK,
  summarizeBenchmarkResults,
} from './benchmark-metrics.mjs';
import { writeBenchmarkMarkdownReport } from './benchmark-reporter.mjs';

export function loadJsonlDataset(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function runBenchmarkCase(system, sample) {
  const startedAt = Date.now();
  const result = await system.runCase(sample);
  const resultIds = Array.isArray(result?.results) ? result.results.map((item) => item.id) : [];

  return {
    sampleId: sample.id,
    category: sample.category,
    system: system.name,
    latencyMs: Date.now() - startedAt,
    recallAt3: computeRecallAtK(resultIds, sample.gold_memory_ids, 3),
    recallAt5: computeRecallAtK(resultIds, sample.gold_memory_ids, 5),
    mrr: computeMRR(resultIds, sample.gold_memory_ids),
    ndcgAt5: computeNdcgAtK(resultIds, sample.gold_memory_ids, 5),
    injectedTokens: result.injectedTokens || 0,
    answerHitRate: computeAnswerHitRate(result.answerText || '', sample.expected_points || []),
    raw: result,
  };
}

export async function runBenchmarkSuite({
  systems,
  datasetPath,
  reportPath = null,
  markdownReportPath = null,
}) {
  const dataset = loadJsonlDataset(datasetPath);
  const reports = [];

  for (const system of systems) {
    if (system.runnable === false) {
      reports.push({
        system: system.name,
        status: system.getStatus?.() || { runnable: false },
        skipped: true,
        summary: summarizeBenchmarkResults([]),
        cases: [],
      });
      await system.close?.();
      continue;
    }

    const caseResults = [];
    try {
      for (const sample of dataset) {
        caseResults.push(await runBenchmarkCase(system, sample));
      }
      reports.push({
        system: system.name,
        status: system.getStatus?.() || null,
        skipped: false,
        summary: summarizeBenchmarkResults(caseResults),
        cases: caseResults,
      });
    } finally {
      await system.close?.();
    }
  }

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), 'utf8');
  }

  if (markdownReportPath) {
    writeBenchmarkMarkdownReport(markdownReportPath, reports, {
      datasetPath,
    });
  }

  return reports;
}
