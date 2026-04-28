import test from 'node:test';
import assert from 'node:assert/strict';

import { getToolDefinitions, buildRecallSummaryContent } from '../src/daemon/mcp-contract.mjs';
import { buildInitResult } from '../src/daemon/mcp-handlers.mjs';
import { SearchEngine } from '../src/core/search.mjs';

test('getToolDefinitions exposes perception in awareness_lookup schema', () => {
  const tools = getToolDefinitions();
  const lookupTool = tools.find((tool) => tool.name === 'awareness_lookup');

  assert.ok(lookupTool, 'awareness_lookup tool should exist');
  assert.ok(
    lookupTool.inputSchema.properties.type.enum.includes('perception'),
    'lookup schema should expose perception type'
  );
});

test('getToolDefinitions exposes cloud-aligned recall flags', () => {
  const tools = getToolDefinitions();
  const recallTool = tools.find((tool) => tool.name === 'awareness_recall');

  assert.ok(recallTool, 'awareness_recall tool should exist');
  assert.ok(recallTool.inputSchema.properties.multi_level);
  assert.ok(recallTool.inputSchema.properties.cluster_expand);
  assert.ok(recallTool.inputSchema.properties.include_installed);
});

test('getToolDefinitions exposes query on awareness_init for current-focus shaping', () => {
  const tools = getToolDefinitions();
  const initTool = tools.find((tool) => tool.name === 'awareness_init');

  assert.ok(initTool, 'awareness_init tool should exist');
  assert.ok(initTool.inputSchema.properties.query);
});

test('buildRecallSummaryContent returns readable text plus ids metadata block', () => {
  const response = buildRecallSummaryContent([
    { id: 'mem_1', type: 'decision', title: 'Use Redis', summary: 'Picked Redis for queue state.' },
    { id: 'mem_2', type: 'workflow', title: 'Deploy flow', summary: 'Run compose after pull.' },
  ]);

  assert.equal(response.content.length, 2);
  assert.match(response.content[0].text, /Found 2 memories/);

  const meta = JSON.parse(response.content[1].text);
  assert.deepEqual(meta._ids, ['mem_1', 'mem_2']);
  assert.equal(meta._meta.detail, 'summary');
  assert.equal(meta._meta.total, 2);
  assert.equal(meta._meta.mode, 'local');
});

test('buildInitResult keeps preference-first, active skills, and attention summary', () => {
  const fakeIndexer = {
    getStats: () => ({ totalMemories: 3, totalKnowledge: 4, totalTasks: 2, totalSessions: 2 }),
    getRecentKnowledge: (limit) => {
      // F-055 bug A: persona card needs confidence ≥ 0.9 to surface
      // without BM25 focus-match (stricter gate to avoid cross-topic leak).
      const cards = [
        { id: 'pref_1', category: 'personal_preference', title: 'Prefers TypeScript', summary: 'Use TS by default.', confidence: 0.95 },
        { id: 'skill_1', category: 'skill', title: 'Deploy with Docker', summary: 'Use compose.', methods: ['Pull', 'Build', 'Up'] },
        { id: 'dec_1', category: 'decision', title: 'Redis for cache', summary: 'Chose Redis for caching.' },
        { id: 'pit_1', category: 'pitfall', title: 'Beware stale pid', summary: 'Clean stale pid files.' },
      ];
      return cards.slice(0, limit);
    },
    getOpenTasks: () => [
      { id: 'task_1', title: 'Old task', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'task_2', title: 'Fresh task', created_at: new Date().toISOString() },
    ],
    getRecentSessions: () => [
      { id: 'ses_1', memory_count: 1, summary: 'Recent work' },
      { id: 'ses_2', memory_count: 0, summary: '' },
    ],
    db: {
      prepare: () => ({
        get: () => ({ cnt: 1 }),
      }),
    },
  };

  const initResult = buildInitResult({
    createSession: () => ({ id: 'ses_new' }),
    indexer: fakeIndexer,
    loadSpec: () => ({ init_guides: { sub_agent_guide: 'Follow the rules' } }),
    source: 'test',
    days: 7,
    maxCards: 4,
    maxTasks: 2,
    renderContextOptions: { currentFocus: 'How should auth be implemented?' },
  });

  assert.equal(initResult.session_id, 'ses_new');
  assert.equal(initResult.mode, 'local');
  assert.equal(initResult.user_preferences.length, 1);
  assert.equal(initResult.user_preferences[0].category, 'personal_preference');
  assert.equal(initResult.active_skills.length, 1);
  assert.equal(initResult.active_skills[0].title, 'Deploy with Docker');
  assert.equal(initResult.attention_summary.high_risks, 1);
  assert.equal(initResult.attention_summary.total_open_tasks, 2);
  assert.equal(initResult.attention_summary.needs_attention, true);
  assert.ok(Array.isArray(initResult.knowledge_cards));
  assert.ok(initResult.rendered_context);
  assert.match(initResult.rendered_context, /Current focus/i);
  assert.match(initResult.rendered_context, /How should auth be implemented\?/);
});

// ---------------------------------------------------------------------------
// _selectRelevantCards — query-aware card selection (via buildInitResult)
// ---------------------------------------------------------------------------

test('buildInitResult with query uses searchKnowledge when available', () => {
  let searchKnowledgeCalled = false;
  let searchKnowledgeQuery = null;

  const searchableIndexer = {
    getStats: () => ({ totalMemories: 0, totalKnowledge: 3, totalTasks: 0, totalSessions: 0 }),
    getRecentKnowledge: (_limit) => [
      { id: 'recent_1', category: 'decision', title: 'Recent decision', summary: 'Some old thing.' },
    ],
    searchKnowledge: (query, opts) => {
      searchKnowledgeCalled = true;
      searchKnowledgeQuery = query;
      // Return cards that match the query semantically (simulated)
      return [
        { id: 'rel_1', category: 'problem_solution', title: 'Auth timeout fix', summary: 'Fix JWT expiry.' },
        { id: 'rel_2', category: 'decision', title: 'Use RS256 keys', summary: 'Chose RS256 over HS256.' },
        { id: 'rel_3', category: 'pitfall', title: 'Token leak risk', summary: 'Never log tokens.' },
        { id: 'rel_4', category: 'key_point', title: 'Refresh interval', summary: 'Refresh every 15 min.' },
        { id: 'rel_5', category: 'workflow', title: 'Login flow', summary: 'POST /auth/login.' },
      ].slice(0, opts?.limit ?? 5);
    },
    getOpenTasks: () => [],
    getRecentSessions: () => [],
    db: { prepare: () => ({ get: () => ({ cnt: 0 }) }) },
  };

  const result = buildInitResult({
    createSession: () => ({ id: 'ses_q1' }),
    indexer: searchableIndexer,
    loadSpec: () => ({ init_guides: {} }),
    source: 'test',
    maxCards: 5,
    maxTasks: 0,
    renderContextOptions: { currentFocus: 'how should auth token expiry be handled?' },
  });

  assert.ok(searchKnowledgeCalled, 'searchKnowledge should be called when currentFocus is set');
  assert.ok(searchKnowledgeQuery?.includes('auth'), 'query should be forwarded to searchKnowledge');
  // knowledge_cards returned should come from search, not from getRecentKnowledge
  const allCardIds = [...result.knowledge_cards, ...result.user_preferences].map((c) => c.id);
  assert.ok(allCardIds.some((id) => id.startsWith('rel_')), 'result cards should come from searchKnowledge');
  assert.ok(!allCardIds.includes('recent_1'), 'pure-recency card should not appear when search fills quota');
});

test('buildInitResult with query supplements search results with recent cards when search returns fewer than maxCards', () => {
  const sparseSearchIndexer = {
    getStats: () => ({ totalMemories: 0, totalKnowledge: 5, totalTasks: 0, totalSessions: 0 }),
    getRecentKnowledge: (_limit) => [
      { id: 'rec_a', category: 'decision', title: 'Recent A', summary: 'Recent card A.' },
      { id: 'rec_b', category: 'insight', title: 'Recent B', summary: 'Recent card B.' },
      { id: 'rec_c', category: 'key_point', title: 'Recent C', summary: 'Recent card C.' },
    ],
    searchKnowledge: (_query, _opts) => [
      // Only 1 result — fewer than maxCards=3
      { id: 'found_1', category: 'problem_solution', title: 'Relevant hit', summary: 'Direct match.' },
    ],
    getOpenTasks: () => [],
    getRecentSessions: () => [],
    db: { prepare: () => ({ get: () => ({ cnt: 0 }) }) },
  };

  const result = buildInitResult({
    createSession: () => ({ id: 'ses_q2' }),
    indexer: sparseSearchIndexer,
    loadSpec: () => ({ init_guides: {} }),
    source: 'test',
    maxCards: 3,
    maxTasks: 0,
    renderContextOptions: { currentFocus: 'relevant topic' },
  });

  const allCards = [...result.knowledge_cards, ...result.user_preferences];
  assert.equal(allCards.length, 3, 'should return exactly maxCards=3 cards');
  const ids = allCards.map((c) => c.id);
  assert.ok(ids.includes('found_1'), 'search result should be included');
  // At least one recent card should fill the gap
  const recentHits = ids.filter((id) => id.startsWith('rec_'));
  assert.ok(recentHits.length >= 1, 'recent cards should supplement sparse search results');
  // No duplicate ids
  assert.equal(new Set(ids).size, ids.length, 'no duplicate card ids');
});

test('buildInitResult without query falls back to getRecentKnowledge (no searchKnowledge called)', () => {
  let searchKnowledgeCalled = false;
  let getRecentKnowledgeCalled = false;

  const indexerWithBoth = {
    getStats: () => ({ totalMemories: 0, totalKnowledge: 3, totalTasks: 0, totalSessions: 0 }),
    getRecentKnowledge: (limit) => {
      getRecentKnowledgeCalled = true;
      return [{ id: 'r1', category: 'decision', title: 'Old decision', summary: 'Foo.' }].slice(0, limit);
    },
    searchKnowledge: (_q, _o) => {
      searchKnowledgeCalled = true;
      return [];
    },
    getOpenTasks: () => [],
    getRecentSessions: () => [],
    db: { prepare: () => ({ get: () => ({ cnt: 0 }) }) },
  };

  buildInitResult({
    createSession: () => ({ id: 'ses_q3' }),
    indexer: indexerWithBoth,
    loadSpec: () => ({ init_guides: {} }),
    source: 'test',
    maxCards: 2,
    maxTasks: 0,
    renderContextOptions: {}, // no currentFocus
  });

  // searchKnowledge is called for allActiveCards(200) path — but NOT for recentCards selection
  // The key assertion: the recentCards path must have used getRecentKnowledge, not searchKnowledge
  assert.ok(getRecentKnowledgeCalled, 'getRecentKnowledge should be called when no query');
  assert.ok(!searchKnowledgeCalled, 'searchKnowledge should NOT be called for card selection without a query');
});

test('SearchEngine.searchCloud forwards cloud-aligned recall flags', async () => {
  const originalFetch = global.fetch;

  try {
    let capturedBody = null;
    global.fetch = async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ result: { results: [] } }),
      };
    };

    const search = new SearchEngine(
      {},
      {},
      null,
      {
        apiBase: 'https://example.com',
        apiKey: 'test-key',
        memoryId: 'mem_1',
      }
    );

    await search.searchCloud({
      semantic_query: 'auth flow',
      keyword_query: 'jwt login',
      scope: 'all',
      limit: 8,
      multi_level: true,
      cluster_expand: false,
      include_installed: false,
    });

    const args = capturedBody.params.arguments;
    assert.equal(args.multi_level, true);
    assert.equal(args.cluster_expand, false);
    assert.equal(args.include_installed, false);
  } finally {
    global.fetch = originalFetch;
  }
});
