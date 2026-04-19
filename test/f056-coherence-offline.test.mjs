/**
 * F-056 · conversation-coherence eval (offline).
 *
 * Drives real daemon + real SQLite + real ONNX embedder through each
 * scripted scenario in `fixtures/coherence-scenarios.mjs`, then scores
 * how well the rest-of-session context (init / recall) delivers the
 * right cards back to a future agent turn.
 *
 * Prints a per-scenario pass/fail + aggregate coherence score in the
 * test stdout so you can read the baseline at a glance:
 *
 *   coherence · S1 same-session: ✅ 1/1 assertion(s)
 *   coherence · S2 cross-session:   ❌ 0/1 (missing 'deploy')
 *   ...
 *   coherence baseline: 4/5 scenarios (80%)
 *
 * This is the *offline* variant — each record step carries hand-crafted
 * `insights.knowledge_cards` so we measure daemon retrieval behavior,
 * not LLM extraction quality. The live variant
 * (`scripts/eval-coherence-live.mjs`, coming separately) drops those
 * insights and lets the real LLM produce cards, then re-runs the same
 * assertions.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { COHERENCE_SCENARIOS } from './fixtures/coherence-scenarios.mjs';

let AwarenessLocalDaemon;

async function freshDaemon(label) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `awareness-coherence-${label}-`));
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'memories'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.awareness', 'tasks'), { recursive: true });

  const mod = await import('../src/daemon.mjs');
  AwarenessLocalDaemon = mod.AwarenessLocalDaemon;
  const daemon = new AwarenessLocalDaemon({ projectDir: tmpDir, port: 0, background: true });

  const { MemoryStore } = await import('../src/core/memory-store.mjs');
  const { Indexer } = await import('../src/core/indexer.mjs');
  daemon.memoryStore = new MemoryStore(tmpDir);
  try {
    daemon.indexer = new Indexer(path.join(tmpDir, '.awareness', 'index.db'));
  } catch {
    const { createNoopIndexer } = await import('../src/daemon/helpers.mjs');
    daemon.indexer = createNoopIndexer();
  }
  daemon.cloudSync = { isEnabled: () => false };
  daemon._sessions = new Map();
  daemon._extractAndIndex = () => {};
  // IMPORTANT: we actually want the embedder in coherence tests because
  // real users run with embedder on. Without embeddings, recall falls
  // back to FTS5-only which has known precision issues on short
  // fixture content. This is the variable we care about — it's what
  // makes the test represent the production behaviour.
  daemon._refineMocTitles = async () => {};
  daemon._checkPerceptionResolution = async () => {};

  // Bring up the embedder + search engine so recall actually works.
  // Embedder load: ~200ms if the ONNX model is already cached
  // (~/.cache/huggingface), or one-off download (~23MB) the first run.
  try {
    daemon._embedder = await daemon._loadEmbedder();
  } catch {
    daemon._embedder = null;
  }
  try {
    daemon.search = await daemon._loadSearchEngine();
  } catch {
    daemon.search = null;
  }

  // With embedder on, _embedAndStore does real work — wire it up so
  // recall can hit the vector-search path (SearchEngine needs the
  // embeddings table populated).
  daemon._embedAndStore = async (id, content) => {
    if (!daemon._embedder || !daemon.indexer?.storeEmbedding) return;
    try {
      const vec = await daemon._embedder.embed(String(content || '').slice(0, 2000), 'passage');
      daemon.indexer.storeEmbedding(id, vec, daemon._embedder.modelId || 'unknown');
    } catch {
      /* best-effort — coherence runner tolerates embedding failures */
    }
  };

  return { daemon, tmpDir };
}

async function callTool(daemon, name, args) {
  const envelope = await daemon._callTool(name, args);
  // The MCP envelope is `{ content: [{ type: 'text', text: ... }, ...] }`.
  // For awareness_init we get one JSON-blob chunk; for awareness_recall
  // we get TWO chunks: a human-readable summary (chunk 0) and a JSON
  // `_meta` blob with `_ids`, pagination hints, etc. (chunk 1).
  if (envelope && Array.isArray(envelope.content)) {
    // Try each chunk — keep the first parsed JSON AND the concatenated
    // raw text for consumers that want both.
    const raw = envelope.content.map((c) => String(c?.text ?? '')).join('\n');
    let parsed = null;
    for (const chunk of envelope.content) {
      const t = String(chunk?.text ?? '').trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try { parsed = JSON.parse(t); break; } catch { /* try next */ }
      }
    }
    // Prefer the JSON payload; also expose `_rawText` for recall
    // where the titles live in the human-readable summary.
    if (parsed) return { ...parsed, _rawText: raw };
    return { _rawText: raw };
  }
  return envelope;
}

function renderedText(initResult) {
  return String(initResult?.rendered_context ?? initResult?._rawText ?? JSON.stringify(initResult));
}

/**
 * Extract titles from a recall response.
 *
 * The human-readable summary chunk looks like:
 *   1. [turn_summary] pgvector setup step 1: Run CREATE EXTENSION vector (70%, today)
 *   2. [workflow] pgvector setup step 1 (69%, today)
 *
 * Returns titles in rank order (1 → N).
 */
function recallTitles(recallResult) {
  const text = String(recallResult?._rawText ?? recallResult ?? '');
  const titles = [];
  // Match "N. [category] title (..." — capture the title part before the parens.
  const re = /^\s*\d+\.\s*\[[^\]]+\]\s*(.+?)\s*\([\d%,.\s\-a-z~]+tok?.*?\)\s*$/gim;
  for (const m of text.matchAll(re)) {
    titles.push(m[1].trim());
  }
  if (titles.length > 0) return titles;

  // Fallback: split on "N. [category] title" without the paren tail
  const re2 = /^\s*\d+\.\s*\[[^\]]+\]\s*(.+?)$/gim;
  for (const m of text.matchAll(re2)) {
    titles.push(m[1].trim());
  }
  return titles;
}

function includesAny(haystack, regexes) {
  return regexes.some((re) => re.test(haystack));
}

function findRank(titles, re) {
  for (let i = 0; i < titles.length; i++) {
    if (re.test(titles[i])) return i + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------

const results = []; // aggregate scorecard

for (const scenario of COHERENCE_SCENARIOS) {
  describe(`coherence · ${scenario.id}`, () => {
    let daemon;
    let tmpDir;
    let altProjectDir;

    before(async () => {
      ({ daemon, tmpDir } = await freshDaemon(scenario.id));
    });

    after(() => {
      try { daemon?.indexer?.close?.(); } catch { /* best-effort */ }
      if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      if (altProjectDir && fs.existsSync(altProjectDir)) {
        fs.rmSync(altProjectDir, { recursive: true, force: true });
      }
    });

    it('runs all steps and satisfies assertions', async () => {
      let localPass = 0;
      let localTotal = 0;
      const failures = [];

      for (const [stepIdx, step] of scenario.steps.entries()) {
        if (step.op === 'record') {
          // Record the memory body first (creates the SQLite row but
          // skips real extraction because _extractAndIndex is a no-op).
          await callTool(daemon, 'awareness_record', {
            action: 'remember',
            content: step.content,
            source: step.source ?? 'coherence-eval',
          });
          // Then explicitly persist the pre-extracted insights so the
          // knowledge_cards table actually receives the fixture card.
          // This simulates a perfect-LLM extraction for the offline
          // coherence run.
          if (step.insights) {
            await callTool(daemon, 'awareness_record', {
              action: 'submit_insights',
              insights: step.insights,
              source: step.source ?? 'coherence-eval',
            });
          }
          continue;
        }

        if (step.op === 'close_session') {
          // No-op at daemon level — new _callTool will create a new
          // logical session on the next `awareness_init`.
          daemon._sessions = new Map();
          continue;
        }

        if (step.op === 'switch_project') {
          altProjectDir = fs.mkdtempSync(
            path.join(os.tmpdir(), `awareness-coherence-${scenario.id}-alt-`),
          );
          fs.mkdirSync(path.join(altProjectDir, '.awareness', 'memories'), { recursive: true });
          fs.mkdirSync(path.join(altProjectDir, '.awareness', 'knowledge'), { recursive: true });
          fs.mkdirSync(path.join(altProjectDir, '.awareness', 'tasks'), { recursive: true });
          // Use a pared-down swap to avoid bringing up full workspace scanner
          // (which would try to spawn file watchers in tmp dirs).
          daemon.projectDir = altProjectDir;
          const { MemoryStore } = await import('../src/core/memory-store.mjs');
          const { Indexer } = await import('../src/core/indexer.mjs');
          daemon.memoryStore = new MemoryStore(altProjectDir);
          daemon.awarenessDir = path.join(altProjectDir, '.awareness');
          try {
            daemon.indexer?.close?.();
            daemon.indexer = new Indexer(path.join(altProjectDir, '.awareness', 'index.db'));
          } catch {
            const { createNoopIndexer } = await import('../src/daemon/helpers.mjs');
            daemon.indexer = createNoopIndexer();
          }
          continue;
        }

        if (step.op === 'init_and_expect') {
          const init = await callTool(daemon, 'awareness_init', {
            source: 'coherence-eval',
            query: step.query ?? '',
          });
          const text = renderedText(init);

          for (const inc of step.must_include_titles ?? []) {
            localTotal++;
            if (inc.test(text)) localPass++;
            else failures.push(`step ${stepIdx}: expected rendered_context to match ${inc}`);
          }
          for (const exc of step.must_exclude_titles ?? []) {
            localTotal++;
            if (!exc.test(text)) localPass++;
            else failures.push(`step ${stepIdx}: rendered_context should NOT match ${exc} but did`);
          }
          for (const idHint of step.must_include_cards ?? []) {
            localTotal++;
            if (text.includes(idHint)) localPass++;
            else failures.push(`step ${stepIdx}: rendered_context should include card hint "${idHint}"`);
          }
          continue;
        }

        if (step.op === 'recall_and_expect') {
          const recall = await callTool(daemon, 'awareness_recall', {
            query: step.query,
            limit: 10,
          });
          const titles = recallTitles(recall);
          const haystack = titles.join('\n') + '\n' + JSON.stringify(recall).slice(0, 4000);

          for (const inc of step.must_include_titles ?? []) {
            localTotal++;
            if (includesAny(haystack, [inc])) localPass++;
            else failures.push(`step ${stepIdx}: recall results should match ${inc} (got titles=${JSON.stringify(titles)})`);
          }
          if (step.must_rank_top_k !== undefined) {
            localTotal++;
            const relevantCount = titles.slice(0, step.must_rank_top_k)
              .filter((t) => /pgvector|embedding|vector/i.test(t)).length;
            if (relevantCount >= 1) localPass++;
            else failures.push(`step ${stepIdx}: top-${step.must_rank_top_k} should contain a pgvector-relevant card`);
          }
          if (step.must_rank_title_first) {
            localTotal++;
            const rank = findRank(titles, step.must_rank_title_first);
            if (rank === 1) localPass++;
            else failures.push(`step ${stepIdx}: expected ${step.must_rank_title_first} at rank 1 (got rank=${rank}, titles=${JSON.stringify(titles.slice(0, 5))})`);
          }
          if (step.must_topk_match) {
            // Precision@K: of the top-K titles, at least `min_hits` must
            // match the regex. Encodes a real signal/noise threshold.
            localTotal++;
            const { k, regex, min_hits } = step.must_topk_match;
            const topK = titles.slice(0, k);
            const hits = topK.filter((t) => regex.test(t)).length;
            if (hits >= min_hits) localPass++;
            else failures.push(
              `step ${stepIdx}: precision@${k} failed — expected ≥${min_hits} matches of ${regex}, got ${hits} (titles=${JSON.stringify(topK)})`,
            );
          }
          if (step.must_not_rank_top3) {
            // Distractor suppression: unrelated topics should not crowd
            // into the top-3 slots when a focused query asks for one topic.
            localTotal++;
            const top3 = titles.slice(0, 3);
            const regexes = Array.isArray(step.must_not_rank_top3)
              ? step.must_not_rank_top3
              : [step.must_not_rank_top3];
            const unwanted = top3.filter((t) => regexes.some((re) => re.test(t)));
            if (unwanted.length === 0) localPass++;
            else failures.push(
              `step ${stepIdx}: top-3 must not contain distractors but found: ${JSON.stringify(unwanted)}`,
            );
          }
          continue;
        }
      }

      results.push({
        id: scenario.id,
        pass: localPass,
        total: localTotal,
        failures,
        known_gap: !!scenario.known_gap,
      });

      // Known-gap scenarios document real retrieval gaps — they don't
      // fail the suite, just surface in the scorecard. Non-gap scenarios
      // must be all-green.
      if (scenario.known_gap) return;
      assert.equal(
        localPass,
        localTotal,
        `${scenario.id} failed ${localTotal - localPass}/${localTotal} assertions:\n  ${failures.join('\n  ')}`,
      );
    });
  });
}

// Emit the scorecard at the very end of the test run. `process.on('exit')`
// is the only hook that fires AFTER all node:test runs in this file.
process.on('exit', () => {
  if (results.length === 0) return;
  const nonGap = results.filter((r) => !r.known_gap);
  const gap = results.filter((r) => r.known_gap);
  const nonGapPassed = nonGap.filter((r) => r.pass === r.total).length;
  const totalAssertions = results.reduce((s, r) => s + r.total, 0);
  const passedAssertions = results.reduce((s, r) => s + r.pass, 0);
  const overallPct = ((passedAssertions / Math.max(totalAssertions, 1)) * 100).toFixed(0);

  process.stderr.write(
    `\n━━━ coherence baseline · ${nonGapPassed}/${nonGap.length} required scenarios · ` +
    `${passedAssertions}/${totalAssertions} total assertions (${overallPct}%) ━━━\n`,
  );
  for (const r of results) {
    const allGreen = r.pass === r.total;
    const mark = r.known_gap ? (allGreen ? '✅*' : '⚠️ ') : (allGreen ? '✅' : '❌');
    const flag = r.known_gap ? ' [KNOWN GAP]' : '';
    process.stderr.write(
      `  ${mark} ${r.id}: ${r.pass}/${r.total}${flag}` +
      `${r.failures.length ? ' — ' + r.failures[0] : ''}\n`,
    );
  }
  if (gap.length > 0) {
    process.stderr.write(
      `\n  [KNOWN GAP] scenarios don't fail the suite but document retrieval quality\n` +
      `  we haven't yet achieved. See fixtures/coherence-scenarios.mjs for fix plans.\n`,
    );
  }
  process.stderr.write('\n');
});
