// @ts-nocheck
import path from 'node:path';
import fs from 'node:fs';

import { Indexer } from '../core/indexer.mjs';
import { MemoryStore } from '../core/memory-store.mjs';
import { SearchEngine } from '../core/search.mjs';
import { loadEmbedderModule } from '../daemon/loaders.mjs';

const SUPPORTED_BACKENDS = ['builtin', 'qmd', 'hybrid'];

export function createSearchBenchmarkSystem({
  name,
  search,
  limit = 5,
  backendKind = 'builtin',
  runnable = true,
  statusProvider = null,
}) {
  return {
    name,
    backendKind,
    runnable,
    getStatus() {
      return statusProvider ? statusProvider() : { backendKind, runnable };
    },
    async runCase(sample) {
      if (!runnable) {
        throw new Error(`Benchmark system ${name} is not runnable`);
      }
      const results = await search.recall({
        semantic_query: sample.query,
        detail: 'summary',
        limit: sample.limit || limit,
        token_budget: sample.max_prompt_tokens,
      });

      return {
        results,
        injectedTokens: results.reduce((sum, item) => sum + (item.tokens_est || 0), 0),
        answerText: results.map((item) => `${item.title}\n${item.summary}`).join('\n'),
      };
    },
    async close() {
      await search.close?.();
    },
  };
}

export async function createProjectSearchBenchmarkSystem({
  name,
  projectDir,
  backendKind = 'builtin',
  limit = 5,
  qmd = {},
  reindex = false,
}) {
  const awarenessDir = path.join(projectDir, '.awareness');
  fs.mkdirSync(awarenessDir, { recursive: true });

  const dbPath = path.join(awarenessDir, 'index.db');
  const memoryStore = new MemoryStore(projectDir);
  const indexer = new Indexer(dbPath);

  if (reindex || !fs.existsSync(dbPath)) {
    await indexer.incrementalIndex(memoryStore);
  }

  const embedder = await loadEmbedderModule({
    importMetaUrl: import.meta.url,
    cachedEmbedder: undefined,
  });

  const search = new SearchEngine(indexer, memoryStore, embedder, null, {
    backendKind,
    qmd,
  });

  search.close = () => indexer.close();

  const statusProvider = () => {
    const status = search.getBackendStatus();
    const qmdConfigured = status.qmd?.configured !== false;
    const qmdRunnable = backendKind === 'builtin' ? true : qmdConfigured;
    return {
      ...status,
      backendKind,
      runnable: qmdRunnable,
      reason: qmdRunnable ? null : 'QMD backend not configured',
    };
  };

  const systemStatus = statusProvider();

  return createSearchBenchmarkSystem({
    name: name || `project-${backendKind}`,
    search,
    limit,
    backendKind,
    runnable: systemStatus.runnable,
    statusProvider,
  });
}

export async function createProjectSearchBenchmarkSystems(options = {}) {
  const kinds = normalizeBackendSelection(options.backendKind || 'builtin');
  const systems = [];

  for (const kind of kinds) {
    systems.push(await createProjectSearchBenchmarkSystem({
      ...options,
      backendKind: kind,
      name: options.name ? `${options.name}-${kind}` : `project-${kind}`,
    }));
  }

  return systems;
}

export function normalizeBackendSelection(value) {
  if (!value || value === 'builtin') return ['builtin'];
  if (value === 'all') return [...SUPPORTED_BACKENDS];

  const kinds = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const invalid = kinds.filter((item) => !SUPPORTED_BACKENDS.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unsupported backend kind: ${invalid.join(', ')}`);
  }

  return [...new Set(kinds)];
}
