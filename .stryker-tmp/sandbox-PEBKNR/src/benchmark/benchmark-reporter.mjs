// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

function formatMetric(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '0.000';
}

function formatTokens(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function renderSummaryTable(reports) {
  const lines = [
    '| System | Status | Cases | Recall@3 | Recall@5 | MRR | nDCG@5 | Avg Tokens | Answer Hit Rate |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const report of reports) {
    if (report.skipped) {
      lines.push(`| ${report.system} | skipped | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0.0 | 0.000 |`);
      continue;
    }
    const summary = report.summary || {};
    lines.push(
      `| ${report.system} | ok | ${summary.totalCases || 0} | ${formatMetric(summary.recallAt3)} | ${formatMetric(summary.recallAt5)} | ${formatMetric(summary.mrr)} | ${formatMetric(summary.ndcgAt5)} | ${formatTokens(summary.injectedTokensAvg)} | ${formatMetric(summary.answerHitRate)} |`,
    );
  }

  return lines.join('\n');
}

function renderSkippedSystems(reports) {
  const skipped = reports.filter((report) => report.skipped);
  if (skipped.length === 0) return '';

  const lines = ['## Skipped Systems', ''];
  for (const report of skipped) {
    lines.push(`- ${report.system}: ${report.status?.reason || 'No reason provided'}`);
  }
  return lines.join('\n');
}

function renderCaseFailures(reports) {
  const lines = ['## Case Notes', ''];
  let hasEntries = false;

  for (const report of reports) {
    if (report.skipped) continue;
    const weakCases = (report.cases || []).filter(
      (item) => (item.answerHitRate || 0) < 1 || (item.recallAt3 || 0) < 1,
    );
    if (weakCases.length === 0) {
      lines.push(`- ${report.system}: all cases hit full recall and answer coverage.`);
      hasEntries = true;
      continue;
    }

    hasEntries = true;
    lines.push(`- ${report.system}:`);
    for (const item of weakCases.slice(0, 10)) {
      lines.push(
        `  - ${item.sampleId}: recall@3=${formatMetric(item.recallAt3)}, answerHitRate=${formatMetric(item.answerHitRate)}, latencyMs=${item.latencyMs || 0}`,
      );
    }
  }

  return hasEntries ? lines.join('\n') : '';
}

export function renderBenchmarkMarkdown(reports, options = {}) {
  const datasetLabel = options.datasetLabel || options.datasetPath || 'unknown dataset';
  const generatedAt = options.generatedAt || new Date().toISOString();

  const sections = [
    '# Benchmark Report',
    '',
    `- Dataset: ${datasetLabel}`,
    `- Generated At: ${generatedAt}`,
    '',
    '## Summary',
    '',
    renderSummaryTable(reports),
  ];

  const skipped = renderSkippedSystems(reports);
  if (skipped) {
    sections.push('', skipped);
  }

  const notes = renderCaseFailures(reports);
  if (notes) {
    sections.push('', notes);
  }

  return sections.join('\n') + '\n';
}

export function writeBenchmarkMarkdownReport(filePath, reports, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderBenchmarkMarkdown(reports, options), 'utf8');
}