/**
 * F-056 · Web UI /search endpoint precision test.
 *
 * Hits the REST endpoint that the dashboard (`web/index.html`) calls:
 *   GET /api/v1/search?q=<query>&limit=<N>
 *
 * Returns `{items, total, query}` where `items[]` carries the card
 * objects with `title`, `summary`, `score`, `type`, etc. This is what
 * the user sees in the web dashboard search bar, so its precision
 * matters directly to user-perceived quality.
 *
 * Uses the same real-embedder + SQLite pipeline as the MCP coherence
 * test but asserts the dashboard-shaped response.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { apiHybridSearch } from '../src/daemon/api-handlers.mjs';

let daemon;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-websearch-'));
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'memories'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'tasks'), { recursive: true });

  const mod = await import('../src/daemon.mjs');
  daemon = new mod.AwarenessLocalDaemon({ projectDir: tmpDir, port: 0, background: true });

  const { MemoryStore } = await import('../src/core/memory-store.mjs');
  const { Indexer } = await import('../src/core/indexer.mjs');
  daemon.memoryStore = new MemoryStore(tmpDir);
  daemon.indexer = new Indexer(path.join(tmpDir, '.awareness', 'index.db'));
  daemon.cloudSync = { isEnabled: () => false };
  daemon._sessions = new Map();
  daemon._refineMocTitles = async () => {};
  daemon._checkPerceptionResolution = async () => {};
  daemon._extractAndIndex = () => {};

  daemon._embedder = await daemon._loadEmbedder();
  daemon.search = await daemon._loadSearchEngine();

  daemon._embedAndStore = async (id, content) => {
    if (!daemon._embedder || !daemon.indexer?.storeEmbedding) return;
    try {
      const vec = await daemon._embedder.embed(String(content || '').slice(0, 2000), 'passage');
      daemon.indexer.storeEmbedding(id, vec, daemon._embedder.modelId || 'unknown');
    } catch { /* best-effort */ }
  };

  // Seed a diverse card set that simulates a real user's memory.
  const seeds = [
    {
      category: 'decision',
      title: 'Chose pgvector over Pinecone',
      summary:
        '**Decision**: pgvector over Pinecone for vector DB. Saves ~$70/mo, ' +
        'co-locates with relational data, cosine via `<=>`. Trade-off: lower QPS past 10M.',
      tags: ['pgvector', 'vector-db'],
    },
    {
      category: 'workflow',
      title: 'Deploy backend to production',
      summary:
        'Deploy workflow. (1) bump VERSION. (2) docker compose build backend. ' +
        '(3) ssh prod + up -d backend mcp worker beat (never postgres). (4) curl /healthz.',
      tags: ['deploy', 'docker', 'prod'],
    },
    {
      category: 'pitfall',
      title: 'Never rebuild postgres in prod deploys',
      summary:
        'Pitfall: rebuilding postgres resets scram-sha-256 password hash. ' +
        'Always pass explicit service list: backend mcp worker beat.',
      tags: ['docker', 'postgres', 'prod'],
    },
    {
      category: 'problem_solution',
      title: 'pgvector dim mismatch 1536 vs 1024',
      summary:
        'Symptom: INSERT into memory_vectors raised vector-dim mismatch. ' +
        'Root cause: column `vector(1536)` but E5-multilingual produces 1024. ' +
        'Fix: ALTER TABLE memory_vectors ALTER COLUMN vector TYPE vector(1024).',
      tags: ['pgvector', 'embedding', 'dim-mismatch'],
    },
    {
      category: 'activity_preference',
      title: 'User cooks on weekends',
      summary: 'User enjoys cooking beef-noodle soup on weekends, a stress-relief hobby activity.',
      tags: ['cooking', 'weekend', 'hobby'],
    },
    {
      category: 'decision',
      title: 'Redesign onboarding flow',
      summary:
        'Decided to collapse first-run onboarding from 4 steps to 2: pick workspace + create memory. ' +
        'Drop the API-key wizard (device-auth replaces it).',
      tags: ['onboarding', 'ux'],
    },
  ];

  // Use submit_insights to populate knowledge_cards.
  for (const card of seeds) {
    await daemon._callTool('awareness_record', {
      action: 'submit_insights',
      insights: {
        knowledge_cards: [{
          ...card,
          confidence: 0.9,
          novelty_score: 0.85,
          durability_score: 0.85,
          specificity_score: 0.85,
        }],
      },
      source: 'websearch-test',
    });
  }
});

after(() => {
  try { daemon?.indexer?.close?.(); } catch { /* best-effort */ }
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Fake HTTP response object that captures the jsonResponse payload. */
function mockResponse() {
  const captured = { status: null, headers: null, body: null };
  return {
    res: {
      writeHead(status, headers) {
        captured.status = status;
        captured.headers = headers;
      },
      end(body) {
        captured.body = body;
      },
    },
    get() {
      if (captured.body == null) return null;
      try { return JSON.parse(captured.body); } catch { return captured.body; }
    },
  };
}

async function webSearch(query, limit = 10) {
  const { res, get } = mockResponse();
  const url = new URL(`http://localhost/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  await apiHybridSearch(daemon, { method: 'GET' }, res, url);
  return get();
}

// ---------------------------------------------------------------------------

describe('F-056 Web UI /search endpoint', () => {
  it('returns the same shape the dashboard expects', async () => {
    const out = await webSearch('pgvector');
    assert.ok(out, 'response body must not be null');
    assert.ok(Array.isArray(out.items), 'items must be an array');
    assert.ok(typeof out.total === 'number', 'total must be a number');
    assert.equal(out.query, 'pgvector');
  });

  it('returns relevant results for a specific tech query', async () => {
    const out = await webSearch('pgvector dim mismatch');
    assert.ok(out.items.length > 0, `expected ≥1 results, got 0`);
    const titles = out.items.map((i) => i?.title ?? '');
    assert.ok(
      titles.some((t) => /pgvector/i.test(t)),
      `expected a pgvector-related result, got titles=${JSON.stringify(titles)}`,
    );
  });

  it('precision@3: docker-deploy query surfaces docker/deploy cards on top', async () => {
    const out = await webSearch('docker compose deploy backend', 10);
    const top3Titles = out.items.slice(0, 3).map((i) => i?.title ?? '');
    const relevant = top3Titles.filter((t) => /docker|deploy|postgres|compose|backend/i.test(t));
    assert.ok(
      relevant.length >= 2,
      `precision@3 failed — expected ≥2 relevant in top-3, got ${relevant.length}/3. ` +
      `Top-3 titles: ${JSON.stringify(top3Titles)}`,
    );
  });

  it('distractor suppression: cooking card must NOT appear in tech query top-3', async () => {
    const out = await webSearch('docker deploy postgres', 10);
    const top3 = out.items.slice(0, 3).map((i) => i?.title ?? '');
    assert.ok(
      !top3.some((t) => /cook|weekend|noodle/i.test(t)),
      `top-3 leaked cooking card: ${JSON.stringify(top3)}`,
    );
  });

  it('CJK query returns results when Chinese content exists', async () => {
    // Add a Chinese card, then search in Chinese
    await daemon._callTool('awareness_record', {
      action: 'submit_insights',
      insights: {
        knowledge_cards: [{
          category: 'decision',
          title: '选择 pgvector 作为向量存储',
          summary:
            '决定：选 pgvector 而非 Pinecone。节约 ~$70/月，与关系数据共存便于 JOIN。cosine `<=>`。',
          tags: ['pgvector', '向量数据库'],
          confidence: 0.9,
          novelty_score: 0.85,
          durability_score: 0.9,
          specificity_score: 0.85,
        }],
      },
    });

    const out = await webSearch('pgvector 向量数据库');
    assert.ok(out.items.length > 0, 'CJK query should return results');
    const titles = out.items.map((i) => i?.title ?? '');
    assert.ok(
      titles.some((t) => /pgvector|向量/.test(t)),
      `CJK query didn't match either EN or CN pgvector card, got: ${JSON.stringify(titles)}`,
    );
  });

  it('empty query returns empty list, not error', async () => {
    const out = await webSearch('');
    assert.ok(Array.isArray(out.items));
    assert.equal(out.items.length, 0);
    assert.equal(out.total, 0);
  });

  it('returned items carry the fields the web UI actually renders', async () => {
    const out = await webSearch('pgvector');
    assert.ok(out.items.length > 0);
    const first = out.items[0];
    // Must carry at least one identifier and some human-readable content.
    assert.ok(
      first.id || first.title,
      'each result must have `id` or `title`',
    );
    assert.ok(
      first.summary || first.content || first.title,
      'each result must have `summary`, `content`, or `title` for the card preview',
    );
  });
});
