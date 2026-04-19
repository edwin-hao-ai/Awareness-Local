/**
 * mcp-handlers.test.mjs — Tests for MCP handler functions
 *
 * Covers: buildInitResult, buildRecallResult, buildAgentPromptResult,
 * and the private helpers _selectRelevantCards / _buildInitPerception
 * tested indirectly through the public API.
 *
 * Uses node:test + node:assert/strict with mock indexer stubs.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInitResult,
  buildRecallResult,
  buildAgentPromptResult,
} from '../src/daemon/mcp-handlers.mjs';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockIndexer(overrides = {}) {
  const noopStmt = { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
  return {
    db: { prepare: () => overrides.dbStmt || noopStmt },
    getStats: () => overrides.stats || { totalMemories: 10, totalKnowledge: 5, totalTasks: 2, totalSessions: 3 },
    getRecentKnowledge: (limit) => (overrides.cards || []).slice(0, limit),
    searchKnowledge: overrides.searchKnowledge || ((query, opts) => (overrides.searchResults || []).slice(0, opts?.limit)),
    getOpenTasks: (limit) => (overrides.tasks || []).slice(0, limit),
    getRecentSessions: (days) => overrides.sessions || [],
    ...overrides,
  };
}

function createSession(source) {
  return { id: `ses_test_${Date.now()}`, source: source || null };
}

function loadSpec(initGuides) {
  return () => ({ init_guides: initGuides || {} });
}

/** Helper to build a card fixture */
function makeCard(id, title, opts = {}) {
  return {
    id,
    title,
    summary: opts.summary || `Summary for ${title}`,
    category: opts.category || 'key_point',
    status: opts.status || 'active',
    confidence: opts.confidence ?? 0.8,
    actionable_rule: opts.actionable_rule || '',
    tags: opts.tags || '[]',
    created_at: opts.created_at || new Date().toISOString(),
    updated_at: opts.updated_at || new Date().toISOString(),
    methods: opts.methods || undefined,
  };
}

/** Helper to build a task fixture */
function makeTask(id, title, opts = {}) {
  return {
    id,
    title,
    status: opts.status || 'open',
    priority: opts.priority || 'medium',
    created_at: opts.created_at || new Date().toISOString(),
    updated_at: opts.updated_at || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// _selectRelevantCards (tested via buildInitResult)
// ---------------------------------------------------------------------------

describe('_selectRelevantCards (via buildInitResult)', () => {
  it('uses searchKnowledge when focus (query) is provided', () => {
    let searchCalled = false;
    let searchQuery = '';
    const searchCards = [makeCard('s1', 'Search Result A')];

    const indexer = createMockIndexer({
      searchKnowledge: (query, opts) => {
        searchCalled = true;
        searchQuery = query;
        return searchCards.slice(0, opts?.limit);
      },
      cards: [makeCard('r1', 'Recent Card')],
    });

    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 1,
      renderContextOptions: { currentFocus: 'deploy flow' },
    });

    assert.ok(searchCalled, 'searchKnowledge should be called when focus is provided');
    assert.equal(searchQuery, 'deploy flow');
    // With maxCards=1 and search returning 1 result, the knowledge_cards + user_preferences
    // together should total 1 (the search result, not the recent card)
    const allReturned = [...result.knowledge_cards, ...result.user_preferences];
    assert.ok(
      allReturned.some((c) => c.id === 's1'),
      'should include search result'
    );
  });

  it('falls back to getRecentKnowledge when no focus is provided', () => {
    let searchCalled = false;
    const recentCards = [makeCard('r1', 'Recent One'), makeCard('r2', 'Recent Two')];

    const indexer = createMockIndexer({
      searchKnowledge: () => { searchCalled = true; return []; },
      cards: recentCards,
    });

    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 5,
    });

    assert.equal(searchCalled, false, 'searchKnowledge should NOT be called without focus');
    const allReturned = [...result.knowledge_cards, ...result.user_preferences];
    assert.ok(allReturned.length > 0, 'should return recent cards');
  });

  it('supplements search results with recent cards when search returns fewer than maxCards', () => {
    const searchCards = [makeCard('s1', 'Search Only')];
    const recentCards = [
      makeCard('s1', 'Search Only'),          // duplicate
      makeCard('r1', 'Recent Supplement A'),
      makeCard('r2', 'Recent Supplement B'),
    ];

    const indexer = createMockIndexer({
      searchKnowledge: (_q, opts) => searchCards.slice(0, opts?.limit),
      cards: recentCards,
    });

    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 3,
      renderContextOptions: { currentFocus: 'testing' },
    });

    const allReturned = [...result.knowledge_cards, ...result.user_preferences];
    // Should have search result + 2 supplements = 3 total (deduped)
    assert.equal(allReturned.length, 3, 'should supplement search with recent cards up to maxCards');
  });

  it('deduplicates between search and recent results by id', () => {
    const sharedCard = makeCard('dup1', 'Shared Card');
    const uniqueRecent = makeCard('r1', 'Only Recent');

    const indexer = createMockIndexer({
      searchKnowledge: (_q, opts) => [sharedCard],
      cards: [sharedCard, uniqueRecent],
    });

    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 5,
      renderContextOptions: { currentFocus: 'anything' },
    });

    const allReturned = [...result.knowledge_cards, ...result.user_preferences];
    const ids = allReturned.map((c) => c.id);
    const uniqueIds = [...new Set(ids)];
    assert.equal(ids.length, uniqueIds.length, 'should have no duplicate ids');
    assert.ok(ids.includes('dup1'), 'shared card should appear once');
    assert.ok(ids.includes('r1'), 'unique recent card should appear');
  });
});

// ---------------------------------------------------------------------------
// buildInitResult
// ---------------------------------------------------------------------------

describe('buildInitResult', () => {
  it('returns session_id, mode=local, and stats', () => {
    const indexer = createMockIndexer();
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test-client',
    });

    assert.ok(result.session_id, 'should have session_id');
    assert.match(result.session_id, /^ses_test_/, 'session_id from createSession');
    assert.equal(result.mode, 'local');
    assert.deepEqual(result.stats, {
      totalMemories: 10, totalKnowledge: 5, totalTasks: 2, totalSessions: 3,
    });
  });

  it('includes knowledge_cards from indexer', () => {
    const cards = [
      makeCard('kc1', 'Deploy Strategy', { category: 'decision' }),
      makeCard('kc2', 'Redis Pattern', { category: 'insight' }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 5,
    });

    assert.ok(result.knowledge_cards.length > 0, 'should include knowledge cards');
  });

  it('includes open_tasks with stale task count in attention_summary', () => {
    const now = new Date();
    const fourDaysAgo = new Date(now.getTime() - 4 * 86400000).toISOString();
    const tasks = [
      makeTask('t1', 'Fresh task'),
      makeTask('t2', 'Stale task', { created_at: fourDaysAgo }),
    ];
    const indexer = createMockIndexer({ tasks });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.equal(result.open_tasks.length, 2);
    assert.equal(result.attention_summary.stale_tasks, 1, 'should count 1 stale task (>3 days)');
    assert.equal(result.attention_summary.total_open_tasks, 2);
  });

  it('calculates attention_summary correctly — needs_attention when stale', () => {
    const oldDate = new Date(Date.now() - 5 * 86400000).toISOString();
    const indexer = createMockIndexer({
      tasks: [makeTask('t1', 'Old task', { created_at: oldDate })],
    });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.equal(result.attention_summary.needs_attention, true);
  });

  it('attention_summary.needs_attention is false when no stale tasks or risks', () => {
    const indexer = createMockIndexer({
      tasks: [makeTask('t1', 'Fresh')],
    });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.equal(result.attention_summary.stale_tasks, 0);
    assert.equal(result.attention_summary.needs_attention, false);
  });

  it('includes synthesized_rules from allActiveCards', () => {
    const cards = [
      makeCard('kc1', 'Rule Card', { category: 'decision', summary: 'Always use parameterized queries' }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.ok(result.synthesized_rules, 'should have synthesized_rules');
    assert.ok(typeof result.synthesized_rules.rule_count === 'number');
    assert.ok(Array.isArray(result.synthesized_rules.rules));
  });

  it('includes active_skills filtered by skill category', () => {
    const cards = [
      makeCard('sk1', 'Deploy Pipeline', {
        category: 'skill',
        summary: 'Build then push then restart',
        methods: JSON.stringify([{ name: 'step1', description: 'build' }]),
      }),
      makeCard('kc1', 'Not a skill', { category: 'insight' }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.ok(Array.isArray(result.active_skills));
    assert.equal(result.active_skills.length, 1);
    assert.equal(result.active_skills[0].title, 'Deploy Pipeline');
    assert.ok(Array.isArray(result.active_skills[0].methods));
    assert.equal(result.active_skills[0].methods.length, 1);
  });

  it('splits preferences from other cards via splitPreferences (F-055: high-confidence only when no focus)', () => {
    // F-055 bug A — persona cards only surface when BM25-relevant to the
    // current focus OR their confidence ≥ 0.9. This test bumps the mock
    // persona cards to confidence=0.95 so they still appear without focus.
    const cards = [
      makeCard('p1', 'Likes dark mode', { category: 'personal_preference', confidence: 0.95 }),
      makeCard('p2', 'Morning runner', { category: 'activity_preference', confidence: 0.95 }),
      makeCard('kc1', 'Auth pattern', { category: 'decision' }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 5,
    });

    assert.ok(result.user_preferences.length >= 1, 'should have high-confidence user_preferences');
    assert.ok(
      result.user_preferences.every((c) =>
        ['personal_preference', 'activity_preference', 'important_detail', 'career_info',
         'plan_intention', 'health_info', 'custom_misc'].includes(c.category)
      ),
      'user_preferences should only contain personal categories'
    );
    // knowledge_cards path now comes from splitPreferences on recentCards, so
    // confidence-filtered personas may still appear in recentCards even
    // when filtered out of user_preferences. The important invariant: a
    // persona card with confidence<0.9 and no focus-match is NOT in
    // user_preferences.
  });

  it('F-055 bug A: low-confidence persona dropped when no focus', () => {
    const cards = [
      makeCard('p1', 'Weekend hobby', { category: 'personal_preference', confidence: 0.7 }),
      makeCard('kc1', 'Auth pattern', { category: 'decision' }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
      maxCards: 5,
    });
    assert.equal(result.user_preferences.length, 0, 'low-confidence persona dropped without focus');
  });

  it('rendered_context is a string containing XML', () => {
    const indexer = createMockIndexer({
      cards: [makeCard('kc1', 'Some card')],
    });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.equal(typeof result.rendered_context, 'string');
    assert.ok(
      result.rendered_context.includes('<awareness-memory>'),
      'rendered_context should contain <awareness-memory> XML tag'
    );
    assert.ok(
      result.rendered_context.includes('</awareness-memory>'),
      'rendered_context should contain closing tag'
    );
  });

  it('includes init_guides from spec and empty agent_profiles', () => {
    const guides = { sub_agent_guide: 'You are a helpful agent.' };
    const indexer = createMockIndexer();
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(guides),
      source: 'test',
    });

    assert.deepEqual(result.init_guides, guides);
    assert.deepEqual(result.agent_profiles, []);
  });
});

// ---------------------------------------------------------------------------
// _buildInitPerception (tested via buildInitResult)
// ---------------------------------------------------------------------------

describe('_buildInitPerception (via buildInitResult rendered_context)', () => {
  it('generates staleness signals for cards not updated in 30+ days', () => {
    const oldDate = new Date(Date.now() - 35 * 86400000).toISOString();
    const cards = [
      makeCard('old1', 'Ancient Decision', {
        category: 'decision',
        updated_at: oldDate,
        created_at: oldDate,
      }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    // The perception signals are rendered into the XML context
    assert.ok(
      result.rendered_context.includes('staleness'),
      'rendered_context should contain staleness signal for 30+ day old card'
    );
    assert.ok(
      result.rendered_context.includes('Ancient Decision'),
      'staleness signal should reference the stale card title'
    );
  });

  it('caps staleness signals at 2', () => {
    const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
    const cards = [
      makeCard('old1', 'Stale Card AAA', { updated_at: oldDate, created_at: oldDate }),
      makeCard('old2', 'Stale Card BBB', { updated_at: oldDate, created_at: oldDate }),
      makeCard('old3', 'Stale Card CCC', { updated_at: oldDate, created_at: oldDate }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    const xml = result.rendered_context;
    const stalenessMatches = xml.match(/type="staleness"/g) || [];
    assert.ok(stalenessMatches.length <= 2, `staleness signals should be capped at 2, got ${stalenessMatches.length}`);
    // First two stale cards should appear as staleness signals, third should not
    assert.ok(xml.includes('Stale Card AAA') && xml.includes('Stale Card BBB'),
      'first two stale cards should appear as staleness signals');
    // Count only within perception section: only 2 staleness signal elements
    const perceptionBlock = xml.split('<perception>')[1]?.split('</perception>')[0] || '';
    const perceptionStaleness = (perceptionBlock.match(/type="staleness"/g) || []).length;
    assert.equal(perceptionStaleness, 2, 'perception section should have exactly 2 staleness signals');
  });

  it('generates guard signals from pitfall/risk cards', () => {
    const cards = [
      makeCard('pit1', 'npx cache corruption', {
        category: 'pitfall',
        summary: 'npx cache can get corrupted and block daemon start',
      }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    assert.ok(
      result.rendered_context.includes('guard'),
      'rendered_context should contain guard signal for pitfall card'
    );
    assert.ok(
      result.rendered_context.includes('npx cache corruption'),
      'guard signal should reference pitfall card title'
    );
  });

  it('caps pitfall guard signals at 3', () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      makeCard(`pit${i}`, `Pitfall ${i}`, { category: 'pitfall', summary: `Danger ${i}` })
    );
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    const xml = result.rendered_context;
    const guardMatches = xml.match(/type="guard"/g) || [];
    assert.ok(guardMatches.length <= 3, `guard signals should be capped at 3, got ${guardMatches.length}`);
  });

  it('returns no perception signals when no stale or pitfall cards exist', () => {
    const freshDate = new Date().toISOString();
    const cards = [
      makeCard('kc1', 'Fresh Card', {
        category: 'decision',
        updated_at: freshDate,
        created_at: freshDate,
      }),
    ];
    const indexer = createMockIndexer({ cards });
    const result = buildInitResult({
      createSession,
      indexer,
      loadSpec: loadSpec(),
      source: 'test',
    });

    // No perception section should appear when there are no signals
    assert.ok(
      !result.rendered_context.includes('<perception>'),
      'rendered_context should NOT contain <perception> section when no signals'
    );
  });
});

// ---------------------------------------------------------------------------
// buildRecallResult
// ---------------------------------------------------------------------------

describe('buildRecallResult', () => {
  it('detail=full with ids calls search.getFullContent', async () => {
    let calledWith = null;
    const search = {
      getFullContent: async (ids) => {
        calledWith = ids;
        return [
          { id: 'mem_1', title: 'Card One', content: 'Full content for card one' },
          { id: 'mem_2', title: 'Card Two', content: 'Full content for card two' },
        ];
      },
      recall: async () => [],
    };

    const result = await buildRecallResult({
      search,
      args: { detail: 'full', ids: ['mem_1', 'mem_2'] },
    });

    assert.deepEqual(calledWith, ['mem_1', 'mem_2']);
    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text.includes('Card One'));
    assert.ok(result.content[0].text.includes('Full content for card one'));
    assert.ok(result.content[0].text.includes('Card Two'));
  });

  it('detail=full with no search returns empty content', async () => {
    const result = await buildRecallResult({
      search: null,
      args: { detail: 'full', ids: ['mem_1'] },
    });

    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text.includes('(no results)'));
  });

  it('no query returns no-query content', async () => {
    const search = {
      getFullContent: async () => [],
      recall: async () => [],
    };

    const result = await buildRecallResult({
      search,
      args: {},
    });

    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text.includes('No query provided'));
  });

  it('no query even with empty strings returns no-query content', async () => {
    const result = await buildRecallResult({
      search: { recall: async () => [] },
      args: { semantic_query: '', keyword_query: '' },
    });

    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text.includes('No query provided'));
  });

  it('with query calls search.recall and returns summaries', async () => {
    let recallArgs = null;
    const search = {
      recall: async (args) => {
        recallArgs = args;
        return [
          { id: 'res1', type: 'decision', title: 'Use Redis', summary: 'Picked Redis for queue.' },
          { id: 'res2', type: 'workflow', title: 'Deploy flow', summary: 'Build then push.' },
        ];
      },
    };

    const args = { semantic_query: 'Redis deployment' };
    const result = await buildRecallResult({ search, args });

    assert.deepEqual(recallArgs, args, 'should pass args to search.recall');
    assert.equal(result.content.length, 2, 'summary content has readable text + ids metadata');
    assert.ok(result.content[0].text.includes('Found 2 memories'));
    assert.ok(result.content[0].text.includes('Use Redis'));

    const meta = JSON.parse(result.content[1].text);
    assert.deepEqual(meta._ids, ['res1', 'res2']);
    assert.equal(meta._meta.detail, 'summary');
    assert.equal(meta._meta.total, 2);
  });

  it('with query but empty results returns no-results content', async () => {
    const search = {
      recall: async () => [],
    };

    const result = await buildRecallResult({
      search,
      args: { semantic_query: 'something obscure' },
    });

    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text.includes('No matching memories found'));
  });

  it('with keyword_query also triggers recall (not no-query path)', async () => {
    let recallCalled = false;
    const search = {
      recall: async () => {
        recallCalled = true;
        return [{ id: 'kw1', title: 'Keyword Hit', summary: 'Matched via keyword' }];
      },
    };

    const result = await buildRecallResult({
      search,
      args: { keyword_query: 'sqlite' },
    });

    assert.ok(recallCalled, 'recall should be called for keyword_query');
    assert.ok(result.content[0].text.includes('Found 1 memories'));
  });

  it('null search with query returns no-results content', async () => {
    const result = await buildRecallResult({
      search: null,
      args: { semantic_query: 'test query' },
    });

    assert.equal(result.content.length, 1);
    assert.ok(result.content[0].text.includes('No matching memories found'));
  });

  it('passes mode through to summary content metadata', async () => {
    const search = {
      recall: async () => [{ id: 'r1', title: 'Hit', summary: 'Found it' }],
    };

    const result = await buildRecallResult({
      search,
      args: { semantic_query: 'test' },
      mode: 'cloud',
    });

    const meta = JSON.parse(result.content[1].text);
    assert.equal(meta._meta.mode, 'cloud');
  });
});

// ---------------------------------------------------------------------------
// buildAgentPromptResult
// ---------------------------------------------------------------------------

describe('buildAgentPromptResult', () => {
  it('returns prompt from spec init_guides.sub_agent_guide', () => {
    const result = buildAgentPromptResult({
      loadSpec: loadSpec({ sub_agent_guide: 'You are a code reviewer.' }),
      role: 'code-reviewer',
    });

    assert.equal(result.prompt, 'You are a code reviewer.');
    assert.equal(result.role, 'code-reviewer');
    assert.equal(result.mode, 'local');
  });

  it('returns empty prompt when spec has no init_guides', () => {
    const result = buildAgentPromptResult({
      loadSpec: () => ({}),
      role: 'unknown',
    });

    assert.equal(result.prompt, '');
    assert.equal(result.role, 'unknown');
  });

  it('returns empty role when no role is provided', () => {
    const result = buildAgentPromptResult({
      loadSpec: loadSpec({ sub_agent_guide: 'Guide text' }),
      role: undefined,
    });

    assert.equal(result.role, '');
  });
});
