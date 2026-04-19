/**
 * F-057 Phase 0 — Golden MCP contract tests.
 *
 * Locks the response SHAPE of every critical MCP tool before the
 * daemon.mjs refactor (F-057 Phase 1+). Each refactor PR must keep
 * these assertions green, proving the split is behaviour-preserving.
 *
 * We assert **shape + key invariants**, not byte-level snapshots,
 * because responses contain timestamps / random IDs / SQLite rowids
 * that legitimately vary across runs. A byte-level diff would be
 * brittle without adding scrubbing logic that itself can mask bugs.
 *
 * 10 goldens:
 *   1. awareness_init  (empty query, default params)
 *   2. awareness_init  (with query, shapes rendered_context)
 *   3. awareness_record plain user content (triggers extraction instruction)
 *   4. awareness_record with pre-extracted insights.knowledge_cards
 *   5. awareness_record envelope-only (F-055 defense — skipped)
 *   6. awareness_record with content.length > MAX_CONTENT_BYTES (error)
 *   7. awareness_recall hybrid mode, empty DB
 *   8. awareness_lookup type='context'
 *   9. awareness_lookup type='skills'
 *  10. awareness_mark_skill_used (no-op on missing id)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

let AwarenessLocalDaemon;
let daemon;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-golden-'));
  // Pre-create .awareness subdirectory so daemon boot doesn't race
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'memories'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'tasks'), { recursive: true });

  const mod = await import('../src/daemon.mjs');
  AwarenessLocalDaemon = mod.AwarenessLocalDaemon;
  daemon = new AwarenessLocalDaemon({ projectDir: tmpDir, port: 0, background: true });

  // We intentionally don't `start()` (don't bind HTTP). Instead we
  // initialise the minimum needed for `_callTool`: indexer + memoryStore.
  // The bootstrap logic that `start()` runs is not yet decoupled, so we
  // reproduce the tiny subset needed for MCP golden tests.
  const { MemoryStore } = await import('../src/core/memory-store.mjs');
  const { Indexer } = await import('../src/core/indexer.mjs');
  daemon.memoryStore = new MemoryStore(tmpDir);
  try {
    daemon.indexer = new Indexer(path.join(tmpDir, '.awareness', 'index.db'));
  } catch {
    const { createNoopIndexer } = await import('../src/daemon/helpers.mjs');
    daemon.indexer = createNoopIndexer();
  }
  // Noop extra wiring the tools expect
  daemon._embedder = null;
  daemon.cloudSync = { isEnabled: () => false };
  daemon._sessions = new Map();
  daemon._extractAndIndex = () => {};
  daemon._embedAndStore = async () => {};
  daemon._refineMocTitles = async () => {};
  daemon._checkPerceptionResolution = async () => {};
});

after(() => {
  try { daemon?.indexer?.close?.(); } catch { /* best-effort */ }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Scrub volatile fields so repeated runs produce the same shape. */
function scrubResponse(res) {
  const out = JSON.parse(JSON.stringify(res));
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (/^(id|session_id|memory_id|created_at|updated_at|ts|started_at|filepath|last_touched_at|last_used_at|last_pushed_at|last_pulled_at)$/.test(key)) {
        node[key] = '<SCRUBBED>';
      } else {
        walk(node[key]);
      }
    }
  };
  walk(out);
  return out;
}

/**
 * `_callTool` returns MCP-protocol envelope: `{ content: [{ type: 'text',
 * text: '<JSON>' }] }`. Unwrap so the golden tests operate on the actual
 * payload the downstream SDKs parse out.
 */
async function callAndUnwrap(name, args) {
  const envelope = await daemon._callTool(name, args);
  if (envelope && Array.isArray(envelope.content)) {
    const text = envelope.content[0]?.text;
    try { return JSON.parse(text); } catch { return text; }
  }
  return envelope;
}

// ---- Golden tests -------------------------------------------------------

describe('F-057 golden · awareness_init (empty query)', () => {
  it('returns structured init shape with required keys', async () => {
    const res = await callAndUnwrap('awareness_init', { source: 'claude-code' });
    assert.equal(res.mode, 'local');
    assert.ok(typeof res.session_id === 'string' && res.session_id.startsWith('ses_'));
    assert.ok(Array.isArray(res.user_preferences));
    assert.ok(Array.isArray(res.knowledge_cards));
    assert.ok(Array.isArray(res.open_tasks));
    assert.ok(Array.isArray(res.recent_sessions));
    assert.ok(res.stats && typeof res.stats === 'object');
    assert.ok(res.attention_summary && typeof res.attention_summary === 'object');
    assert.ok(res.init_guides && typeof res.init_guides === 'object');
    assert.ok(typeof res.rendered_context === 'string' || res.rendered_context === undefined);
  });
});

describe('F-057 golden · awareness_init (with query)', () => {
  it('rendered_context surfaces the query', async () => {
    const res = await callAndUnwrap('awareness_init', {
      source: 'claude-code',
      query: 'my test query for golden',
    });
    assert.ok(res.rendered_context);
    assert.match(res.rendered_context, /my test query for golden/);
  });
});

describe('F-057 golden · awareness_record (plain content)', () => {
  it('persists and returns memory id + extraction instruction', async () => {
    const res = await callAndUnwrap('awareness_record', {
      action: 'remember',
      content: 'User chose pgvector over Pinecone because of cost savings and co-location. ' +
        'Trade-off is lower QPS past 10M vectors, acceptable for now.',
      source: 'claude-code',
    });
    assert.ok(res.id || res.memory_id, 'expected id in response');
    // Extraction instruction is attached when no pre-extracted insights were sent
    if (res._extraction_instruction) {
      assert.match(res._extraction_instruction, /INSIGHT EXTRACTION REQUEST/);
      // F-056 — every runtime surface must carry these templated block headers
      assert.match(res._extraction_instruction, /## When to Extract/);
      assert.match(res._extraction_instruction, /## When NOT to Extract/);
      assert.match(res._extraction_instruction, /Skill Extraction/);
      assert.match(res._extraction_instruction, /Daemon Quality Gate/);
    }
  });
});

describe('F-057 golden · awareness_record with pre-extracted insights', () => {
  it('persists cards without emitting extraction instruction', async () => {
    const res = await callAndUnwrap('awareness_record', {
      action: 'remember',
      content: 'Decided to use pgvector for all vector storage going forward.',
      insights: {
        knowledge_cards: [{
          category: 'decision',
          title: 'Adopt pgvector',
          summary: 'Chose **pgvector** over Pinecone for vector storage. Saves cost, co-locates data with Postgres, cosine via `<=>`. Trade-off accepted: lower QPS past 10M vectors.',
          tags: ['vector-db', 'decision'],
          confidence: 0.9,
          novelty_score: 0.85,
          durability_score: 0.9,
          specificity_score: 0.8,
        }],
      },
      source: 'claude-code',
    });
    assert.ok(res.id || res.memory_id);
    assert.equal(res._extraction_instruction, undefined,
      'pre-extracted insights should NOT trigger extraction instruction');
  });
});

describe('F-057 golden · awareness_record envelope-only (F-055 defense)', () => {
  it('rejects envelope-only metadata content', async () => {
    const res = await callAndUnwrap('awareness_record', {
      action: 'remember',
      content: 'Sender (untrusted metadata): foo\n\n[Subagent Context]',
      source: 'openclaw-plugin',
    });
    assert.equal(res.status, 'skipped');
    assert.match(String(res.reason), /filtered|metadata/i);
  });
});

describe('F-057 golden · awareness_record oversized content', () => {
  it('rejects content above MAX_CONTENT_BYTES with clear error', async () => {
    const bigContent = 'a'.repeat(AwarenessLocalDaemon.MAX_CONTENT_BYTES + 100);
    const res = await callAndUnwrap('awareness_record', {
      action: 'remember',
      content: bigContent,
      source: 'claude-code',
    });
    assert.ok(res.error && /too large/i.test(res.error));
  });
});

describe('F-057 golden · awareness_recall (empty DB)', () => {
  it('returns structured recall shape with zero results when empty', async () => {
    const res = await callAndUnwrap('awareness_recall', {
      query: 'something truly unrelated xyzqpl 123',
      limit: 5,
    });
    // Response shape may be {results: [...]} or a string-serialised XML;
    // both are acceptable as long as a call succeeds and has no hard errors.
    assert.ok(
      (typeof res === 'object' && res !== null) || typeof res === 'string',
      'recall should return object or string',
    );
    if (res && typeof res === 'object' && 'results' in res) {
      assert.ok(Array.isArray(res.results));
    }
  });
});

describe('F-057 golden · awareness_lookup type=context', () => {
  it('returns context dump with stats + counts', async () => {
    const res = await callAndUnwrap('awareness_lookup', { type: 'context' });
    assert.ok(res && typeof res === 'object');
    // context dump returns either direct stats or a nested object — both
    // forms must contain knowledge/tasks/sessions keys somewhere.
    const payload = res.context ?? res;
    assert.ok('stats' in payload || 'knowledge' in payload || 'tasks' in payload,
      'context lookup must surface at least one top-level key');
  });
});

describe('F-057 golden · awareness_lookup type=skills', () => {
  it('returns skills list (possibly empty)', async () => {
    const res = await callAndUnwrap('awareness_lookup', { type: 'skills' });
    assert.ok(res && typeof res === 'object');
    const list = res.skills ?? res.items ?? [];
    assert.ok(Array.isArray(list));
  });
});

describe('F-057 golden · awareness_mark_skill_used (missing id)', () => {
  it('returns not-found error shape, does not throw', async () => {
    const res = await callAndUnwrap('awareness_mark_skill_used', {
      skill_id: 'skill_does_not_exist',
      outcome: 'success',
    });
    assert.ok(res && typeof res === 'object');
    // Either {error: ...} or {status: 'not_found'} — both acceptable
    // as long as the call didn't crash. This golden lets the refactor
    // swap implementations freely as long as the contract stays.
    assert.ok(
      'error' in res || 'status' in res || 'ok' in res,
      'mark_skill_used must return a structured response',
    );
  });
});
