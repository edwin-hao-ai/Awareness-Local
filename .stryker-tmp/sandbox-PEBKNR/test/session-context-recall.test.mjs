/**
 * Tests for session-context-aware recall improvements:
 *
 *   1. isStructurallyValidKnowledgeCard — rejects system metadata dumps,
 *      accepts genuine prose cards.
 *
 *   2. SearchEngine._buildSessionContextHint — extracts the right topic
 *      keywords from recent memories.
 *
 *   3. Indexer.getRecentMemories — honours the time-window filter.
 *
 *   4. Integration — processPreExtracted drops invalid cards silently.
 */
// @ts-nocheck


import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isStructurallyValidKnowledgeCard, KnowledgeExtractor } from '../src/core/knowledge-extractor.mjs';
import { SearchEngine } from '../src/core/search.mjs';
import { Indexer } from '../src/core/indexer.mjs';

// ---------------------------------------------------------------------------
// 1. isStructurallyValidKnowledgeCard
// ---------------------------------------------------------------------------

test('isStructurallyValidKnowledgeCard: rejects sender metadata dump (< 5 prose tokens)', () => {
  // Exactly the card shape that caused context confusion
  assert.equal(
    isStructurallyValidKnowledgeCard({
      title: 'Request: Sender (untrusted metadata):',
      summary: 'Request: Sender (untrusted metadata): ```json { "label": "AwarenessClaw Desktop (openclaw-control-ui)", "id": "openclaw-control-ui" } ```',
      category: 'problem_solution',
    }),
    false,
    'sender metadata card should be rejected',
  );
});

test('isStructurallyValidKnowledgeCard: rejects card whose body is only a code block', () => {
  assert.equal(
    isStructurallyValidKnowledgeCard({
      title: '',
      summary: '```json\n{"key": "value", "foo": "bar"}\n```',
    }),
    false,
    'pure JSON code-block card should be rejected',
  );
});

test('isStructurallyValidKnowledgeCard: rejects empty card', () => {
  assert.equal(isStructurallyValidKnowledgeCard({}), false);
  assert.equal(isStructurallyValidKnowledgeCard({ title: '', summary: '' }), false);
});

test('isStructurallyValidKnowledgeCard: accepts genuine English knowledge card', () => {
  assert.equal(
    isStructurallyValidKnowledgeCard({
      title: 'Plugin upgrade timeout fix',
      summary: 'npm pack only has 60s without mirror fallback causing timeouts in China.',
      category: 'problem_solution',
    }),
    true,
    'real knowledge card should pass',
  );
});

test('isStructurallyValidKnowledgeCard: accepts genuine Chinese knowledge card', () => {
  assert.equal(
    isStructurallyValidKnowledgeCard({
      title: 'Plugin 升级超时修复',
      summary: 'npm pack 只有 60s 且无镜像 fallback 导致国内用户超时。修复：加 npmmirror 镜像循环。',
      category: 'problem_solution',
    }),
    true,
    'Chinese knowledge card should pass',
  );
});

test('isStructurallyValidKnowledgeCard: accepts card with code AND prose (real technical note)', () => {
  assert.equal(
    isStructurallyValidKnowledgeCard({
      title: 'detached process kill pattern',
      summary: 'Use `process.kill(-pid, SIGKILL)` to kill the whole process group when child is spawned detached.',
      category: 'problem_solution',
    }),
    true,
    'card with inline code but sufficient prose should pass',
  );
});

// ---------------------------------------------------------------------------
// 2. SearchEngine._buildSessionContextHint
// ---------------------------------------------------------------------------

test('_buildSessionContextHint: returns empty string for empty input', () => {
  const engine = new SearchEngine(null, null, null, null, {});
  assert.equal(engine._buildSessionContextHint([]), '');
  assert.equal(engine._buildSessionContextHint(null), '');
});

test('_buildSessionContextHint: extracts dominant topic terms from snake-game memories', () => {
  const engine = new SearchEngine(null, null, null, null, {});
  const recentMems = [
    { title: 'snake game HTML file created', tags: '' },
    { title: 'snake game CSS grid layout', tags: '' },
    { title: 'snake game audio Web Audio API', tags: '' },
    { title: 'snake game responsive canvas sizing', tags: '' },
  ];
  const hint = engine._buildSessionContextHint(recentMems);
  // "snake" and "game" should be the highest-frequency terms (appear 4× each)
  assert.ok(hint.includes('snake'), `hint should contain "snake", got: "${hint}"`);
  assert.ok(hint.includes('game'),  `hint should contain "game", got: "${hint}"`);
});

test('_buildSessionContextHint: excludes common stop words', () => {
  const engine = new SearchEngine(null, null, null, null, {});
  const mems = [
    { title: 'the plugin is working and the tests are ok', tags: '' },
    { title: 'it is done and we are happy to be here', tags: '' },
  ];
  const hint = engine._buildSessionContextHint(mems);
  for (const stop of ['the', 'is', 'and', 'are', 'to', 'be', 'it', 'we']) {
    assert.ok(!hint.split(' ').includes(stop), `stop word "${stop}" should not appear in hint`);
  }
});

test('_buildSessionContextHint: returns at most 6 terms', () => {
  const engine = new SearchEngine(null, null, null, null, {});
  const mems = Array.from({ length: 10 }, (_, i) => ({
    title: `term${i} unique${i} word${i} concept${i}`,
    tags: '',
  }));
  const hint = engine._buildSessionContextHint(mems);
  assert.ok(hint.split(' ').length <= 6, `hint should have ≤6 terms, got: "${hint}"`);
});

test('_buildSessionContextHint: works with CJK titles', () => {
  const engine = new SearchEngine(null, null, null, null, {});
  const mems = [
    { title: '贪吃蛇游戏 HTML 文件创建', tags: '' },
    { title: '贪吃蛇游戏 CSS 响应式布局', tags: '' },
    { title: '贪吃蛇游戏 音效 Web Audio', tags: '' },
  ];
  const hint = engine._buildSessionContextHint(mems);
  // "贪吃蛇游戏" appears 3× — should dominate the hint
  assert.ok(hint.length > 0, 'hint should not be empty for CJK content');
});

// ---------------------------------------------------------------------------
// 3. Indexer.getRecentMemories
// ---------------------------------------------------------------------------

test('getRecentMemories: returns only memories within the time window', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-recent-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const indexer = new Indexer(dbPath);

  try {
    const now = new Date();
    const recentTs  = new Date(now.getTime() - 10 * 60 * 1000).toISOString();  // 10 min ago
    const ancientTs = new Date(now.getTime() - 2  * 60 * 60 * 1000).toISOString(); // 2h ago

    // Index a recent memory
    indexer.indexMemory('mem_recent_001', {
      filepath: path.join(tmpDir, 'mem_recent_001.md'),
      type: 'turn_summary',
      title: 'Snake game HTML created',
      created_at: recentTs,
      updated_at: recentTs,
    }, 'Snake game HTML created');

    // Index an old memory (should be excluded by 1h window)
    indexer.indexMemory('mem_old_001', {
      filepath: path.join(tmpDir, 'mem_old_001.md'),
      type: 'turn_summary',
      title: 'AwarenessClaw Desktop responsive fix',
      created_at: ancientTs,
      updated_at: ancientTs,
    }, 'AwarenessClaw Desktop responsive fix');

    const results = indexer.getRecentMemories(3_600_000, 10); // 1h window
    const ids = results.map(r => r.id);

    assert.ok(ids.includes('mem_recent_001'), 'recent memory should be returned');
    assert.ok(!ids.includes('mem_old_001'),   'old memory outside window should be excluded');
  } finally {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getRecentMemories: respects the limit parameter', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-limit-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const indexer = new Indexer(dbPath);

  try {
    const ts = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    for (let i = 0; i < 10; i++) {
      indexer.indexMemory(`mem_${i}`, {
        filepath: path.join(tmpDir, `mem_${i}.md`),
        type: 'turn_summary',
        title: `Memory ${i}`,
        created_at: ts,
        updated_at: ts,
      }, `Memory ${i}`);
    }

    const results = indexer.getRecentMemories(3_600_000, 3);
    assert.equal(results.length, 3, 'should respect limit of 3');
  } finally {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Integration: processPreExtracted drops invalid cards silently
// ---------------------------------------------------------------------------

test('processPreExtracted: drops sender-metadata card, keeps real knowledge card', () => {
  const extractor = new KnowledgeExtractor(null, null, null);
  const metadata = { id: 'mem_test', tags: [] };

  const insights = {
    knowledge_cards: [
      {
        title: 'Request: Sender (untrusted metadata):',
        summary: 'Request: Sender (untrusted metadata): ```json { "label": "AwarenessClaw Desktop" } ```',
        category: 'problem_solution',
        confidence: 0.7,
      },
      {
        title: 'Plugin upgrade timeout fix',
        summary: 'npm pack only has 60s. Add npmmirror as fallback registry to fix timeout in China.',
        category: 'problem_solution',
        confidence: 0.85,
      },
    ],
  };

  const result = extractor.processPreExtracted(insights, metadata);

  assert.equal(result.cards.length, 1, 'only 1 card should survive (garbage dropped)');
  assert.equal(result.cards[0].title, 'Plugin upgrade timeout fix');
});

// ---------------------------------------------------------------------------
// 5. Source propagation: source flows from metadata → card → DB → recall
// ---------------------------------------------------------------------------

test('processPreExtracted: propagates source from memory metadata to knowledge card', () => {
  const extractor = new KnowledgeExtractor(null, null, null);
  const metadata = { id: 'mem_src_test', tags: [], source: 'openclaw-plugin' };

  const insights = {
    knowledge_cards: [{
      title: 'AwarenessClaw Desktop responsive fix',
      summary: 'AwarenessClaw Desktop layout overflows on small screens. Fix: overflow-y auto.',
      category: 'problem_solution',
      confidence: 0.85,
    }],
  };

  const result = extractor.processPreExtracted(insights, metadata);

  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].source, 'openclaw-plugin',
    'card should carry the source from its parent memory');
});

test('processPreExtracted: source is null when metadata has no source', () => {
  const extractor = new KnowledgeExtractor(null, null, null);
  const metadata = { id: 'mem_nosrc', tags: [] };

  const insights = {
    knowledge_cards: [{
      title: 'Some decision made during coding',
      summary: 'Chose approach A over B because it is simpler and has fewer dependencies.',
      category: 'decision',
    }],
  };

  const result = extractor.processPreExtracted(insights, metadata);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].source, null,
    'source should be null when metadata has no source');
});

test('Indexer.indexKnowledgeCard: stores and retrieves source field', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-src-'));
  const dbPath = path.join(tmpDir, 'index.db');
  const indexer = new Indexer(dbPath);

  try {
    indexer.indexKnowledgeCard({
      id: 'kc_src_001',
      category: 'problem_solution',
      title: 'OpenClaw plugin card',
      summary: 'Card created from openclaw-plugin source session',
      source: 'openclaw-plugin',
      confidence: 0.85,
      status: 'active',
      tags: [],
      created_at: new Date().toISOString(),
      filepath: path.join(tmpDir, 'kc_src_001.md'),
    });

    const rows = indexer.db
      .prepare(`SELECT source FROM knowledge_cards WHERE id = ?`)
      .all('kc_src_001');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'openclaw-plugin',
      'source should be persisted to DB');
  } finally {
    indexer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SearchEngine.mergeResults: preserves record_source from DB result', () => {
  const engine = new SearchEngine(null, null, null, null, {});

  const localResult = {
    id: 'kc_001',
    title: 'AwarenessClaw responsive layout',
    finalScore: 0.8,
    source: 'openclaw-plugin',  // DB source field
    created_at: new Date().toISOString(),
  };

  const merged = engine.mergeResults([localResult], [], {});
  const item = merged[0];

  assert.equal(item.source, 'local',
    'source should be overwritten with retrieval-path indicator');
  assert.equal(item.record_source, 'openclaw-plugin',
    'record_source should preserve the original DB source');
});
