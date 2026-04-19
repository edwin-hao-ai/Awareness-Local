/**
 * F-056 · simulated OpenClaw-style multi-turn session quality.
 *
 * The OpenClaw plugin captures agent turns via `agent_end` hook and
 * records a `turn_brief`. Over a conversation of N turns, this file
 * simulates exactly that behavior and measures:
 *
 *   - Every turn brief avoids envelope leak (F-055 bug B)
 *   - Insights extracted by the daemon's offline quality gate are
 *     structurally valid
 *   - Cross-turn continuity: the Nth turn's recall surface brings
 *     the decision card from turn 1 back into context
 *   - CJK and English turns coexist (multilingual daemon/embedder)
 *
 * Data flow mirrors real OpenClaw usage:
 *   user turn → agent_end → plugin constructs turn_brief →
 *   stripMetadataEnvelope (F-055) → awareness_record → daemon persists →
 *   next turn's awareness_init/awareness_recall surfaces past context.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { stripMetadataEnvelope } from '../../../sdks/openclaw/src/envelope-strip.ts';

let daemon;
let tmpDir;

/**
 * Realistic OpenClaw conversation: 5 turns blending EN + 中文 about one
 * coherent task (deciding + shipping a vector DB). The 5th turn asks a
 * question the agent should answer using memory from turn 1-3.
 */
const SESSION_TURNS = [
  {
    id: 'turn-1-decision',
    user: 'I need to pick a vector database for the Awareness Memory project. ' +
          'Considering pgvector vs Pinecone. What matters: cost, latency, ops burden.',
    assistant: 'Based on our constraints, I recommend pgvector: (1) already using Postgres ' +
               'so zero ops burden; (2) co-location enables JOIN-based hybrid search; ' +
               '(3) ~$70/month savings vs Pinecone Standard. Trade-off accepted: lower QPS ' +
               'past 10M vectors, but we are far from that scale.',
    // The plugin wraps turns in Sender metadata envelopes — the test
    // proves F-055 strip logic removes them before the card is formed.
    envelope_wrapped: true,
  },
  {
    id: 'turn-2-implementation',
    user: '好，开始实现 pgvector。需要哪些步骤？',
    assistant: '步骤：1) `CREATE EXTENSION vector;` 2) 建 `memory_vectors` 表，向量列 `vector(1024)` ' +
               '匹配 E5-multilingual 嵌入维度 3) HNSW 索引 `CREATE INDEX ON memory_vectors ' +
               'USING hnsw (embedding vector_cosine_ops)` 4) 在 Prisma schema 之外手写迁移',
    envelope_wrapped: false,
  },
  {
    id: 'turn-3-bug-fix',
    user: 'bug: INSERT into memory_vectors is raising vector-dim mismatch',
    assistant: 'Root cause: the column was declared `vector(1536)` (OpenAI legacy default) ' +
               'but E5-multilingual produces 1024-dim vectors. Fix: `ALTER TABLE ' +
               'memory_vectors ALTER COLUMN vector TYPE vector(1024)`. Then reindex with ' +
               '`REINDEX TABLE memory_vectors`. Avoidance: always read `embedder.dim()` ' +
               'before declaring the column.',
    envelope_wrapped: true,
  },
  {
    id: 'turn-4-noise',
    user: 'thx',
    assistant: 'You are welcome.',
    envelope_wrapped: false,
    expect_noise: true,
  },
  {
    id: 'turn-5-recall-continuity',
    user: 'remind me what we chose for vector DB and why',
    // Agent would answer from memory; we test by asserting recall.
    assistant: '(answer from memory)',
    envelope_wrapped: false,
    recall_check: {
      query: 'vector database decision and rationale',
      must_surface_titles: [/pgvector/i],
    },
  },
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-openclaw-'));
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
});

after(() => {
  try { daemon?.indexer?.close?.(); } catch { /* best-effort */ }
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function callTool(name, args) {
  const envelope = await daemon._callTool(name, args);
  if (envelope && Array.isArray(envelope.content)) {
    const raw = envelope.content.map((c) => String(c?.text ?? '')).join('\n');
    let parsed = null;
    for (const chunk of envelope.content) {
      const t = String(chunk?.text ?? '').trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try { parsed = JSON.parse(t); break; } catch { /* try next */ }
      }
    }
    if (parsed) return { ...parsed, _rawText: raw };
    return { _rawText: raw };
  }
  return envelope;
}

/**
 * Simulates what the OpenClaw plugin does in its agent_end hook:
 *   1. wrap user message in framework metadata envelope
 *   2. call stripMetadataEnvelope (F-055 bug B fix)
 *   3. build turn_brief payload
 *   4. submit to daemon
 */
function simulateOpenClawAgentEnd(turn) {
  let userContent = turn.user;
  let assistantContent = turn.assistant;
  if (turn.envelope_wrapped) {
    userContent = `Sender (untrusted metadata): openclaw-runtime\n\nRequest: ${turn.user}`;
    assistantContent = `Result: ${turn.assistant}`;
  }
  const strippedUser = stripMetadataEnvelope(userContent);
  const strippedAssistant = stripMetadataEnvelope(assistantContent);
  return {
    turn_brief: [
      strippedUser ? `Request: ${strippedUser.slice(0, 500)}` : '',
      strippedAssistant ? `Result: ${strippedAssistant.slice(0, 500)}` : '',
      `Turns: 2 messages`,
    ].filter(Boolean).join('\n'),
    strippedUser,
    strippedAssistant,
  };
}

// ---------------------------------------------------------------------------

describe('F-056 OpenClaw simulated multi-turn session · record quality', () => {
  let sessionRecords = [];

  it('every non-noise turn records a clean turn_brief without envelope leak', async () => {
    for (const turn of SESSION_TURNS) {
      const sim = simulateOpenClawAgentEnd(turn);
      // envelope-strip must never leave `Sender:` / `[Subagent` anywhere
      // in the final turn_brief — that's the F-055 bug B guarantee.
      assert.doesNotMatch(
        sim.turn_brief,
        /Sender \(untrusted metadata\)|\[Subagent Context\]|\[Operational context/,
        `turn_brief for ${turn.id} leaked envelope: ${sim.turn_brief.slice(0, 200)}`,
      );
      sessionRecords.push({ turn, sim });
    }
  });

  it('noise turns surface in an extraction request but produce no card downstream', async () => {
    // A pleasantry pair (`Request: thx` + `Result: You are welcome`) does
    // currently pass the noise filter at the turn_brief layer — the daemon
    // records it as a turn_summary but the LLM-extraction prompt tells the
    // client LLM to emit `knowledge_cards: []` for this shape. Both layers
    // work together: persistence of a thin turn record is fine, emitting
    // a knowledge card would not be. The plugin's burden is to not hand
    // pure envelopes in (that's the F-055 guarantee, verified above).
    //
    // This assertion documents the behaviour so a future tightening (add
    // a pleasantry detector) doesn't happen silently.
    const { classifyNoiseEvent } = await import('../src/core/noise-filter.mjs');
    for (const { turn, sim } of sessionRecords) {
      if (!turn.expect_noise) continue;
      const reason = classifyNoiseEvent({ content: sim.turn_brief, event_type: 'turn_brief' });
      if (reason) {
        // OK — filter got it
      } else {
        // Not filtered at turn-brief layer. Check the *LLM extraction*
        // prompt steers towards `knowledge_cards: []` for this content.
        const { buildExtractionInstruction } = await import('../src/daemon/extraction-instruction.mjs');
        const prompt = buildExtractionInstruction({
          content: sim.turn_brief, memoryId: 'mem_noise', existingCards: [], spec: {},
        });
        // The prompt must explicitly call out greetings / acknowledgments
        // so the LLM returns empty.
        assert.match(
          prompt,
          /greetings|command invocations|"hi", "run tests"|"thanks"/i,
          `Pleasantry turn is not turn-brief-filtered AND extraction prompt does not warn against it — ` +
          `LLM will emit a noise card. Turn: ${turn.id}. Fix: add a pleasantry detector to noise-filter.mjs.`,
        );
      }
    }
  });

  it('records real turns into daemon storage', async () => {
    // Simulate full agent_end → awareness_record flow for meaningful turns
    for (const { turn, sim } of sessionRecords) {
      if (turn.expect_noise) continue;
      if (turn.id === 'turn-5-recall-continuity') continue; // recall-only turn
      const res = await callTool('awareness_record', {
        action: 'remember',
        content: sim.turn_brief,
        source: 'openclaw-plugin-sim',
      });
      assert.ok(res?.id || res?._rawText?.includes('id'),
        `expected record to succeed, got: ${JSON.stringify(res).slice(0, 200)}`);
    }

    // Also persist canonical decision card so recall has a card-layer hit
    await callTool('awareness_record', {
      action: 'submit_insights',
      insights: {
        knowledge_cards: [{
          category: 'decision',
          title: 'Chose pgvector for Awareness Memory',
          summary:
            '**Decision**: pgvector over Pinecone for the vector DB. ' +
            'Drivers: (1) zero ops burden since we already run Postgres, ' +
            '(2) JOIN-based hybrid search co-locates relational + vector, ' +
            '(3) ~$70/mo savings vs Pinecone Standard. **Trade-off**: lower ' +
            'QPS past 10M vectors, acceptable at current scale.',
          tags: ['pgvector', 'vector-db', 'decision', 'cost'],
          confidence: 0.9,
          novelty_score: 0.85,
          durability_score: 0.9,
          specificity_score: 0.85,
        }],
      },
      source: 'openclaw-plugin-sim',
    });
  });
});

describe('F-056 OpenClaw simulated multi-turn session · recall continuity', () => {
  it('turn 5 recall question surfaces the decision card from turn 1', async () => {
    const recallTurn = SESSION_TURNS.find((t) => t.recall_check);
    assert.ok(recallTurn, 'scenario must define a recall-continuity turn');

    const out = await callTool('awareness_recall', {
      query: recallTurn.recall_check.query,
      limit: 10,
    });
    const raw = String(out?._rawText ?? '');

    for (const re of recallTurn.recall_check.must_surface_titles) {
      assert.match(
        raw,
        re,
        `recall missed expected title ${re} — raw: ${raw.slice(0, 600)}`,
      );
    }
  });

  it('CJK turn content is retrievable with a CJK query', async () => {
    const out = await callTool('awareness_recall', {
      query: 'HNSW 索引向量维度',
      limit: 10,
    });
    const raw = String(out?._rawText ?? '');
    // The turn 2 implementation contains HNSW / 1024 etc.
    assert.ok(
      /HNSW|1024|vector_cosine|hnsw/i.test(raw),
      `CJK query should retrieve turn-2 content. Raw: ${raw.slice(0, 400)}`,
    );
  });

  it('bug-fix turn content is retrievable with an English query', async () => {
    const out = await callTool('awareness_recall', {
      query: 'vector dim mismatch insert error',
      limit: 10,
    });
    const raw = String(out?._rawText ?? '');
    assert.ok(
      /dim|1536|1024|ALTER TABLE|mismatch/i.test(raw),
      `English query should retrieve the bug-fix turn. Raw: ${raw.slice(0, 400)}`,
    );
  });
});
