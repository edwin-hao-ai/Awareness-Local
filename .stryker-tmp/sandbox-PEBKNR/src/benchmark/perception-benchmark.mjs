// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectGuardSignals } from '../core/guard-detector.mjs';

export function loadPerceptionDataset(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function evaluatePerceptionSample(sample) {
  const signals = detectGuardSignals(sample.input_event || {}, {
    profile: sample.guard_profile || 'awareness',
  });
  const predictedTypes = [...new Set(signals.map((signal) => signal.type))].sort();
  const expectedTypes = [...new Set(sample.expected_signals || [])].sort();
  const matchedTypes = expectedTypes.filter((type) => predictedTypes.includes(type));
  const missingTypes = expectedTypes.filter((type) => !predictedTypes.includes(type));
  const extraTypes = predictedTypes.filter((type) => !expectedTypes.includes(type));
  const firstGuard = signals.find((signal) => signal.type === 'guard');

  const typeRecall = expectedTypes.length > 0 ? matchedTypes.length / expectedTypes.length : 1;
  const typePrecision = predictedTypes.length > 0 ? matchedTypes.length / predictedTypes.length : 1;
  const guardHit = expectedTypes.includes('guard') ? Number(predictedTypes.includes('guard')) : 1;
  const severityMatch = firstGuard ? Number(firstGuard.severity === sample.expected_severity) : 0;
  const blockMatch = firstGuard ? Number(Boolean(firstGuard.must_block) === Boolean(sample.must_block)) : 0;
  const referenceMatch = firstGuard
    ? Number((sample.must_reference || []).every((ref) => firstGuard.reference_id === ref))
    : 0;

  return {
    sampleId: sample.id,
    category: sample.category,
    expectedTypes,
    predictedTypes,
    matchedTypes,
    missingTypes,
    extraTypes,
    typeRecall,
    typePrecision,
    guardHit,
    severityMatch,
    blockMatch,
    referenceMatch,
    signals,
  };
}

export function summarizePerceptionResults(results) {
  const rows = Array.isArray(results) ? results : [];
  if (rows.length === 0) {
    return {
      totalCases: 0,
      signalRecall: 0,
      signalPrecision: 0,
      guardHitRate: 0,
      severityAccuracy: 0,
      blockAccuracy: 0,
      referenceAccuracy: 0,
      exactMatchRate: 0,
    };
  }

  const totals = rows.reduce((acc, row) => {
    acc.signalRecall += row.typeRecall || 0;
    acc.signalPrecision += row.typePrecision || 0;
    acc.guardHitRate += row.guardHit || 0;
    acc.severityAccuracy += row.severityMatch || 0;
    acc.blockAccuracy += row.blockMatch || 0;
    acc.referenceAccuracy += row.referenceMatch || 0;
    acc.exactMatchRate += Number((row.missingTypes?.length || 0) === 0 && (row.extraTypes?.length || 0) === 0);
    return acc;
  }, {
    signalRecall: 0,
    signalPrecision: 0,
    guardHitRate: 0,
    severityAccuracy: 0,
    blockAccuracy: 0,
    referenceAccuracy: 0,
    exactMatchRate: 0,
  });

  return {
    totalCases: rows.length,
    signalRecall: totals.signalRecall / rows.length,
    signalPrecision: totals.signalPrecision / rows.length,
    guardHitRate: totals.guardHitRate / rows.length,
    severityAccuracy: totals.severityAccuracy / rows.length,
    blockAccuracy: totals.blockAccuracy / rows.length,
    referenceAccuracy: totals.referenceAccuracy / rows.length,
    exactMatchRate: totals.exactMatchRate / rows.length,
  };
}

export function renderPerceptionMarkdown(report, datasetPath) {
  const summary = report.summary || {};
  const lines = [
    '# Perception Benchmark Report',
    '',
    `- Dataset: ${datasetPath}`,
    `- Generated At: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Cases | ${summary.totalCases || 0} |`,
    `| Signal Recall | ${formatMetric(summary.signalRecall)} |`,
    `| Signal Precision | ${formatMetric(summary.signalPrecision)} |`,
    `| Guard Hit Rate | ${formatMetric(summary.guardHitRate)} |`,
    `| Severity Accuracy | ${formatMetric(summary.severityAccuracy)} |`,
    `| Block Accuracy | ${formatMetric(summary.blockAccuracy)} |`,
    `| Reference Accuracy | ${formatMetric(summary.referenceAccuracy)} |`,
    `| Exact Match Rate | ${formatMetric(summary.exactMatchRate)} |`,
    '',
    '## Case Notes',
    '',
  ];

  for (const row of report.cases || []) {
    const extras = row.extraTypes?.length ? ` extras=${row.extraTypes.join(',')}` : '';
    const missing = row.missingTypes?.length ? ` missing=${row.missingTypes.join(',')}` : '';
    lines.push(`- ${row.sampleId}: predicted=${row.predictedTypes.join(',') || 'none'}${missing}${extras}`);
  }

  return lines.join('\n') + '\n';
}

export function runPerceptionBenchmark(datasetPath) {
  const cases = loadPerceptionDataset(datasetPath).map(evaluatePerceptionSample);
  return {
    generatedAt: new Date().toISOString(),
    summary: summarizePerceptionResults(cases),
    cases,
  };
}

function formatMetric(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000';
}

function parseArgs(argv) {
  const args = { dataset: null, report: null, markdown: null };
  for (let index = 2; index < argv.length; index++) {
    const item = argv[index];
    if (item === '--dataset') args.dataset = argv[++index] || null;
    else if (item === '--report') args.report = argv[++index] || null;
    else if (item === '--markdown-report') args.markdown = argv[++index] || null;
  }
  return args;
}

function maybeRunCli() {
  const currentPath = fileURLToPath(import.meta.url);
  if (process.argv[1] !== currentPath) return;

  const args = parseArgs(process.argv);
  const datasetPath = path.resolve(args.dataset || path.join(path.dirname(currentPath), '../../../tests/memory-benchmark/datasets/perception_signals.jsonl'));
  const report = runPerceptionBenchmark(datasetPath);

  if (args.report) {
    fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
    fs.writeFileSync(path.resolve(args.report), JSON.stringify(report, null, 2), 'utf8');
  }
  if (args.markdown) {
    fs.mkdirSync(path.dirname(path.resolve(args.markdown)), { recursive: true });
    fs.writeFileSync(path.resolve(args.markdown), renderPerceptionMarkdown(report, datasetPath), 'utf8');
  }

  console.log(JSON.stringify(report, null, 2));
}

maybeRunCli();