/**
 * Recall precision comparison test.
 *
 * Reproduces the exact context-confusion scenario:
 *
 *   Two knowledge cards exist in the DB:
 *     A — about a snake game HTML responsive layout (created via openclaw-plugin)
 *     B — about AwarenessClaw Desktop responsive UI fix (created via openclaw-plugin)
 *
 *   User prompt: "没办法下拉，我的屏幕小看不全，你要做成响应式的"
 *   (Can't scroll, screen too small, make it responsive)
 *
 *   WITHOUT session context:
 *     Both cards contain "responsive/响应式" → FTS ranks them similarly → wrong card may surface.
 *
 *   WITH session context enrichment (recent memories are all about snake game):
 *     Query becomes: "没办法下拉 响应式 snake game html css"
 *     Card A scores higher (contains snake/game/html) → correct recall.
 *     Card B scores lower or is absent.
 *
 * This test validates the _buildSessionContextHint → enriched recall pipeline
 * using real FTS5 search (no embedding model required).
 */
// @ts-nocheck


import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Indexer } from '../src/core/indexer.mjs';
import { SearchEngine } from '../src/core/search.mjs';
import { MemoryStore } from '../src/core/memory-store.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupTestDb(tmpDir) {
  const dbPath = path.join(tmpDir, 'index.db');
  const indexer = new Indexer(dbPath);
  const store   = new MemoryStore(tmpDir);
  return { indexer, store };
}

function indexCard(indexer, tmpDir, { id, title, summary, source }) {
  const filepath = path.join(tmpDir, `${id}.md`);
  fs.writeFileSync(filepath, `---\nid: ${id}\n---\n\n# ${title}\n\n${summary}\n`);
  indexer.indexKnowledgeCard({
    id,
    category: 'problem_solution',
    title,
    summary,
    source,
    confidence: 0.85,
    status: 'active',
    tags: [],
    created_at: new Date().toISOString(),
    filepath,
  });
}

function indexMemory(indexer, tmpDir, { id, title, createdAt }) {
  const filepath = path.join(tmpDir, `${id}.md`);
  fs.writeFileSync(filepath, `---\nid: ${id}\n---\n\n${title}\n`);
  indexer.indexMemory(id, {
    filepath,
    type: 'turn_summary',
    title,
    created_at: createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, title);
}

// ---------------------------------------------------------------------------
// Main comparison test
// ---------------------------------------------------------------------------

test('recall precision: session context enrichment promotes correct card', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ctx-cmp-'));
  const { indexer, store } = setupTestDb(tmpDir);

  try {
    // ---- Seed knowledge cards ----
    // Card A: about the SNAKE GAME (this is what the user is actually working on)
    indexCard(indexer, tmpDir, {
      id: 'kc_snake_001',
      title: 'Snake game HTML responsive canvas layout',
      summary: 'The snake game canvas does not scroll on small screens. Fix with CSS: ' +
               'max-width 100vw, overflow hidden, responsive grid layout for mobile.',
      source: 'openclaw-plugin',
    });

    // Card B: about AWARENESSCLAW DESKTOP (a different project — this is the wrong card)
    indexCard(indexer, tmpDir, {
      id: 'kc_desktop_001',
      title: 'AwarenessClaw Desktop responsive UI fix',
      summary: 'AwarenessClaw Desktop control panel overflows on small screens. ' +
               'Fix: overflow-y auto, remove hardcoded height 600px, media query max-width 768px.',
      source: 'openclaw-plugin',
    });

    // ---- The user's raw prompt (English expansion of the Chinese original) ----
    // Real flow: query planner expands "没办法下拉，要做成响应式" → English terms.
    // We use the English expansion directly so the FTS5 test is self-contained.
    // "responsive" appears in both cards; this is the ambiguous baseline.
    const rawPrompt = 'responsive overflow small screen';

    // ---- Build session engine (needed for buildFtsQuery + _buildSessionContextHint) ----
    // The production recall() pipeline uses engine.buildFtsQuery() which OR-joins all
    // terms so any term match is sufficient.  We mirror that here.
    const engine = new SearchEngine(indexer, store, null, null, {});

    // ---- Baseline: FTS search WITHOUT session context enrichment ----
    // Use buildFtsQuery to get OR-joined query — same semantics as the real pipeline.
    const baselineFts = engine.buildFtsQuery(rawPrompt, null);
    const baselineResults = indexer.searchKnowledge(baselineFts, { limit: 10 });
    const baselineIds = baselineResults.map(r => r.id);

    // ---- Seed recent memories about the SNAKE GAME ----
    // These simulate the current session context — user has been working on a snake game
    const recentTs = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
    indexMemory(indexer, tmpDir, { id: 'mem_s1', title: 'snake game HTML file created with Web Audio API', createdAt: recentTs });
    indexMemory(indexer, tmpDir, { id: 'mem_s2', title: 'snake game CSS grid canvas responsive viewport', createdAt: recentTs });
    indexMemory(indexer, tmpDir, { id: 'mem_s3', title: 'snake game score display glitch effect animation', createdAt: recentTs });
    indexMemory(indexer, tmpDir, { id: 'mem_s4', title: 'snake game WASD keyboard touch controls mobile', createdAt: recentTs });

    // ---- Build session context hint from recent memories ----
    const recentMems = indexer.getRecentMemories(3_600_000, 8);
    const hint = engine._buildSessionContextHint(recentMems);

    // Hint should contain dominant topic terms from the snake game memories
    assert.ok(hint.length > 0, 'hint should not be empty when there are recent memories');
    assert.ok(
      hint.includes('snake') || hint.includes('game'),
      `hint should contain "snake" or "game" — got: "${hint}"`,
    );

    // ---- Enriched: FTS search WITH session context ----
    // Append the hint to the raw prompt, then OR-join via buildFtsQuery.
    const enrichedRaw = `${rawPrompt} ${hint}`;
    const enrichedFts = engine.buildFtsQuery(enrichedRaw, null);
    const enrichedResults = indexer.searchKnowledge(enrichedFts, { limit: 10 });
    const enrichedIds = enrichedResults.map(r => r.id);

    // ---- Assertions ----

    // 1. Both queries should return results
    assert.ok(baselineResults.length >= 1, 'baseline should return at least 1 result');
    assert.ok(enrichedResults.length >= 1, 'enriched should return at least 1 result');

    // 2. Enriched query MUST include the snake card
    assert.ok(
      enrichedIds.includes('kc_snake_001'),
      `enriched recall should include the snake card; got: ${JSON.stringify(enrichedIds)}`,
    );

    // 3. Snake card must rank FIRST (or at least equal-first) in enriched results
    const snakeRankEnriched = enrichedIds.indexOf('kc_snake_001');
    assert.equal(snakeRankEnriched, 0,
      `snake card should rank #1 in enriched recall; ranked #${snakeRankEnriched + 1}`);

    // 4. Enriched should rank snake card higher than desktop card
    const desktopRankEnriched = enrichedIds.indexOf('kc_desktop_001');
    const snakeRankBaseline  = baselineIds.indexOf('kc_snake_001');
    const desktopRankBaseline = baselineIds.indexOf('kc_desktop_001');

    if (desktopRankEnriched !== -1) {
      assert.ok(
        snakeRankEnriched < desktopRankEnriched,
        `enriched: snake (#${snakeRankEnriched + 1}) should rank above desktop (#${desktopRankEnriched + 1})`,
      );
    }

    // 5. Diagnostic output (visible with --test-reporter spec)
    t.diagnostic(`baseline results:  ${JSON.stringify(baselineIds)}`);
    t.diagnostic(`baseline ranks:    snake=#${snakeRankBaseline + 1}  desktop=#${desktopRankBaseline + 1}`);
    t.diagnostic(`session hint:      "${hint}"`);
    t.diagnostic(`enriched query:    "${enrichedRaw}"`);
    t.diagnostic(`enriched results:  ${JSON.stringify(enrichedIds)}`);
    t.diagnostic(`enriched ranks:    snake=#${snakeRankEnriched + 1}  desktop=#${desktopRankEnriched === -1 ? 'absent' : desktopRankEnriched + 1}`);

    if (snakeRankBaseline !== -1 && desktopRankBaseline !== -1 && snakeRankBaseline > desktopRankBaseline) {
      t.diagnostic('✓ precision improvement confirmed: baseline had wrong order, enriched fixed it');
    } else {
      t.diagnostic('ℹ baseline already ranked correctly (FTS5 keyword match was sufficient here)');
    }

  } finally {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source boost comparison
// ---------------------------------------------------------------------------

test('recall precision: same-source cards rank higher with current_source boost', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-src-boost-'));
  const { indexer, store } = setupTestDb(tmpDir);

  try {
    // Two semantically similar cards from different sources
    indexCard(indexer, tmpDir, {
      id: 'kc_cc_001',
      title: 'npm timeout fix for CI pipeline',
      summary: 'npm install times out in CI when registry is slow. Set npm config timeout and add mirror fallback.',
      source: 'mcp',   // created from claude-code
    });

    indexCard(indexer, tmpDir, {
      id: 'kc_oc_001',
      title: 'npm registry timeout fix',
      summary: 'npm pack command times out without mirror. Add npmmirror as fallback registry to prevent timeout.',
      source: 'openclaw-plugin',  // created from OpenClaw
    });

    const engine = new SearchEngine(indexer, store, null, null, {});

    // Simulate two local search results with equal scores.
    // Note: `source` here is the DB field (card origin) — mergeResults reads this
    // as `record_source` so that the retrieval-path `source` can be set to 'local'.
    const equalScoreResults = [
      { id: 'kc_cc_001', title: 'npm timeout fix for CI pipeline', finalScore: 0.8,
        source: 'mcp', created_at: new Date().toISOString() },
      { id: 'kc_oc_001', title: 'npm registry timeout fix', finalScore: 0.8,
        source: 'openclaw-plugin', created_at: new Date().toISOString() },
    ];

    // Without current_source: order is arbitrary (both score 0.8)
    const withoutBoost = engine.mergeResults(equalScoreResults, [], {});
    t.diagnostic(`without source boost: ${withoutBoost.map(r => r.id).join(', ')}`);

    // Apply source boost manually (as recall() would do) for mcp caller
    const boosted = withoutBoost.map(r => {
      if (r.record_source && r.record_source === 'mcp') {
        return { ...r, finalScore: (r.finalScore ?? r.mergedScore ?? 0) * 1.3 };
      }
      return r;
    }).sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));

    t.diagnostic(`with source boost (mcp caller): ${boosted.map(r => `${r.id}(${r.finalScore?.toFixed(2)})`).join(', ')}`);

    // mcp card should rank first when caller is mcp
    assert.equal(boosted[0].id, 'kc_cc_001',
      'mcp source card should rank first for a mcp caller');
    assert.ok(
      boosted[0].finalScore > boosted[1].finalScore,
      `mcp card score (${boosted[0].finalScore?.toFixed(2)}) should exceed openclaw card (${boosted[1].finalScore?.toFixed(2)})`,
    );

  } finally {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
