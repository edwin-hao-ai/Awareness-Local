/**
 * Recall@5 Evaluation Script
 *
 * Measures recall quality by running queries against the local daemon
 * and checking if expected knowledge cards appear in top-5 results.
 *
 * Usage: node recall-eval.mjs [--daemon-url http://localhost:37800]
 */
// @ts-nocheck


const DAEMON_URL = process.argv.includes('--daemon-url')
  ? process.argv[process.argv.indexOf('--daemon-url') + 1]
  : 'http://localhost:37800';

// Evaluation queries: { query, expectedTitles (partial match), category }
const EVAL_QUERIES = [
  // English - technical
  { query: 'OpenClaw plugin architecture', expectedTitles: ['OpenClaw slots', 'registerTool', 'memory-core'], category: 'en-tech' },
  { query: 'how to replace memory-core', expectedTitles: ['Awareness vs OpenClaw', 'memory-core', 'native plugin'], category: 'en-tech' },
  { query: 'token consumption comparison', expectedTitles: ['Token saving', 'token'], category: 'en-tech' },
  { query: 'registerContextEngine API', expectedTitles: ['ContextEngine', 'lifecycle hooks', 'plugin'], category: 'en-tech' },
  { query: 'QMD hybrid search pipeline', expectedTitles: ['QMD', 'reranking', 'pipeline'], category: 'en-tech' },

  // English - project
  { query: 'channel setup WhatsApp', expectedTitles: ['WhatsApp', 'channel', 'QR'], category: 'en-project' },
  { query: 'recall quality improvement plan', expectedTitles: ['Recall', 'RRF', 'untitled', 'fix'], category: 'en-project' },
  { query: 'perception signal types', expectedTitles: ['perception', 'guard', 'staleness'], category: 'en-project' },
  { query: 'cloud sync data gap', expectedTitles: ['sync', 'cloud', '490'], category: 'en-project' },
  { query: 'knowledge card evolution', expectedTitles: ['knowledge', 'card', 'evolution'], category: 'en-project' },

  // Chinese
  { query: '知识卡片分类', expectedTitles: ['knowledge', 'category', '分类'], category: 'zh' },
  { query: 'Docker部署命令', expectedTitles: ['Docker', 'deploy', '部署'], category: 'zh' },
  { query: '记忆系统架构设计', expectedTitles: ['memory', 'architecture', '架构'], category: 'zh' },
  { query: '感知信号类型', expectedTitles: ['perception', 'guard', 'signal'], category: 'zh' },
  { query: '召回质量优化', expectedTitles: ['recall', 'RRF', 'snippet'], category: 'zh' },

  // Mixed
  { query: 'OpenClaw plugin 架构设计', expectedTitles: ['OpenClaw', 'plugin', '架构'], category: 'mixed' },
  { query: 'memory-core 替换方案', expectedTitles: ['memory-core', 'native', 'replace'], category: 'mixed' },
  { query: 'RRF融合公式修复', expectedTitles: ['RRF', 'normalization', '归一化'], category: 'mixed' },
  { query: 'FTS5 中文搜索', expectedTitles: ['FTS', 'trigram', 'CJK'], category: 'mixed' },
  { query: 'init perception 空数组 bug', expectedTitles: ['perception', 'init', 'empty'], category: 'mixed' },
];

async function mcpCall(toolName, args) {
  const response = await fetch(`${DAEMON_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return response.json();
}

function extractTitles(text) {
  const titles = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\d+\.\s+\[.*?\]\s+(.+?)(?:\s+\(|$)/);
    if (match) titles.push(match[1].trim());
  }
  return titles;
}

function matchesAny(title, expectedPartials) {
  const lower = title.toLowerCase();
  return expectedPartials.some((partial) => lower.includes(partial.toLowerCase()));
}

async function runEval() {
  console.log(`\nRecall@5 Evaluation — ${EVAL_QUERIES.length} queries against ${DAEMON_URL}\n`);

  const results = { total: 0, hits: 0, byCategory: {} };

  for (const { query, expectedTitles, category } of EVAL_QUERIES) {
    const resp = await mcpCall('awareness_recall', {
      semantic_query: query,
      detail: 'summary',
    });

    const text = resp?.result?.content?.[0]?.text || '';
    const titles = extractTitles(text).slice(0, 5);
    const hit = titles.some((t) => matchesAny(t, expectedTitles));

    results.total++;
    if (hit) results.hits++;

    if (!results.byCategory[category]) {
      results.byCategory[category] = { total: 0, hits: 0 };
    }
    results.byCategory[category].total++;
    if (hit) results.byCategory[category].hits++;

    const status = hit ? '✅' : '❌';
    console.log(`  ${status} [${category}] "${query}"`);
    if (!hit) {
      console.log(`     Expected: ${expectedTitles.join(', ')}`);
      console.log(`     Got top-5: ${titles.join(' | ') || '(none)'}`);
    }
  }

  console.log('\n--- Results ---');
  console.log(`Overall Recall@5: ${results.hits}/${results.total} = ${(results.hits / results.total * 100).toFixed(1)}%`);
  for (const [cat, data] of Object.entries(results.byCategory)) {
    const d = data;
    console.log(`  ${cat}: ${d.hits}/${d.total} = ${(d.hits / d.total * 100).toFixed(1)}%`);
  }

  const recall5 = results.hits / results.total;
  if (recall5 >= 0.7) {
    console.log('\n✅ PASS: Recall@5 >= 70% — ready for native plugin replacement');
  } else {
    console.log('\n❌ FAIL: Recall@5 < 70% — needs further improvement');
  }
}

runEval().catch(console.error);
