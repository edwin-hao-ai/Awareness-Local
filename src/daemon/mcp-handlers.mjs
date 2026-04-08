import { buildContextXml } from '../harness-builder.mjs';
import {
  buildRecallFullContent,
  buildRecallNoQueryContent,
  buildRecallNoResultsContent,
  buildRecallSummaryContent,
} from './mcp-contract.mjs';
import {
  extractActiveSkills,
  splitPreferences,
  synthesizeRules,
} from './helpers.mjs';

/**
 * Select the most relevant knowledge cards for the current context.
 *
 * When a focus query is provided, uses BM25 full-text search (searchKnowledge)
 * to rank cards by relevance instead of pure recency. Falls back to recency
 * when the indexer lacks searchKnowledge or the query yields too few results.
 *
 * @param {object} indexer
 * @param {number} maxCards
 * @param {string|undefined} focus - current user query / focus string
 * @returns {Array}
 */
function _selectRelevantCards(indexer, maxCards, focus) {
  if (focus && typeof indexer.searchKnowledge === 'function') {
    const searched = indexer.searchKnowledge(focus, { limit: maxCards });
    if (searched.length >= maxCards) return searched;
    // Supplement with most-recent cards when search returns fewer than requested
    const searchedIds = new Set(searched.map((c) => c.id));
    const recent = indexer.getRecentKnowledge(maxCards).filter((c) => !searchedIds.has(c.id));
    return [...searched, ...recent].slice(0, maxCards);
  }
  return indexer.getRecentKnowledge(maxCards);
}

export function buildInitResult({
  createSession,
  indexer,
  loadSpec,
  source,
  days = 7,
  maxCards = 5,
  maxTasks = 5,
  renderContextOptions = {},
}) {
  const session = createSession(source);
  const stats = indexer.getStats();
  const focus = renderContextOptions?.currentFocus?.trim() || undefined;
  const recentCards = _selectRelevantCards(indexer, maxCards, focus);
  const allActiveCards = indexer.getRecentKnowledge(200);
  const openTasks = indexer.getOpenTasks(maxTasks);
  const rawSessions = indexer.getRecentSessions(days);

  let recentSessions = rawSessions.filter((sessionItem) => sessionItem.memory_count > 0 || sessionItem.summary);
  if (recentSessions.length === 0) {
    recentSessions = rawSessions.slice(0, 3);
  }
  recentSessions = recentSessions.slice(0, 5);

  const spec = loadSpec();
  const now = Date.now();
  const staleDays = 3;
  const staleCutoff = now - staleDays * 86400000;
  const staleTasks = openTasks.filter((task) => {
    const created = task.created_at ? new Date(task.created_at).getTime() : now;
    return created < staleCutoff;
  }).length;
  const riskCards = indexer.db
    .prepare("SELECT COUNT(*) as cnt FROM knowledge_cards WHERE (category = 'risk' OR category = 'pitfall') AND status = 'active'")
    .get();
  const highRisks = riskCards?.cnt || 0;

  const attentionSummary = {
    stale_tasks: staleTasks,
    high_risks: highRisks,
    total_open_tasks: openTasks.length,
    total_knowledge_cards: recentCards.length,
    needs_attention: staleTasks > 0 || highRisks > 0,
  };

  const { rules, rule_count } = synthesizeRules(allActiveCards);
  const activeSkills = extractActiveSkills(allActiveCards);
  const { user_preferences, knowledge_cards: otherCards } = splitPreferences(recentCards);

  // Build lightweight perception signals for init (staleness + pitfall guards)
  const initPerception = _buildInitPerception(indexer, allActiveCards);

  const initResult = {
    session_id: session.id,
    mode: 'local',
    user_preferences,
    knowledge_cards: otherCards,
    open_tasks: openTasks,
    recent_sessions: recentSessions,
    stats,
    attention_summary: attentionSummary,
    synthesized_rules: { rules, rule_count },
    init_guides: spec.init_guides || {},
    agent_profiles: [],
    active_skills: activeSkills,
    setup_hints: [],
  };

  try {
    initResult.rendered_context = buildContextXml(initResult, [], initPerception, renderContextOptions);
  } catch {
    // Non-fatal — client can still use structured data
  }

  return initResult;
}

/**
 * Build lightweight perception signals at session init.
 * Only generates staleness + pitfall-as-guard signals (zero LLM, fast).
 */
function _buildInitPerception(indexer, allCards) {
  const signals = [];
  const now = Date.now();
  const STALE_THRESHOLD_MS = 30 * 86400000; // 30 days

  // 1. Staleness: find knowledge cards not updated in 30+ days
  for (const card of allCards) {
    const updatedMs = card.updated_at
      ? new Date(card.updated_at).getTime()
      : card.created_at ? new Date(card.created_at).getTime() : now;
    if (now - updatedMs > STALE_THRESHOLD_MS && card.status === 'active') {
      const daysAgo = Math.floor((now - updatedMs) / 86400000);
      signals.push({
        type: 'staleness',
        message: `Knowledge card "${card.title}" has not been updated in ${daysAgo} days — may be outdated.`,
      });
      if (signals.length >= 2) break; // Cap at 2 staleness signals
    }
  }

  // 2. Pitfall cards as guard signals
  const pitfalls = allCards
    .filter((c) => (c.category === 'pitfall' || c.category === 'risk') && c.status === 'active')
    .slice(0, 3);
  for (const card of pitfalls) {
    signals.push({
      type: 'guard',
      message: `⚠️ Known pitfall: ${card.title} — ${(card.summary || '').slice(0, 300)}`,
    });
  }

  return signals;
}

export async function buildRecallResult({ search, args, mode = 'local' }) {
  if (args.detail === 'full' && args.ids?.length) {
    const items = search
      ? await search.getFullContent(args.ids)
      : [];
    return buildRecallFullContent(items);
  }

  if (!args.semantic_query && !args.keyword_query) {
    return buildRecallNoQueryContent();
  }

  const summaries = search
    ? await search.recall(args)
    : [];

  if (!summaries.length) {
    return buildRecallNoResultsContent();
  }

  return buildRecallSummaryContent(summaries, mode);
}

export function buildAgentPromptResult({ loadSpec, role }) {
  const spec = loadSpec();
  return {
    prompt: spec.init_guides?.sub_agent_guide || '',
    role: role || '',
    mode: 'local',
  };
}
