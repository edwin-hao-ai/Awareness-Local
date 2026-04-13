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
  const activeSkills = extractActiveSkills(allActiveCards, indexer);
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
 * Applies lifecycle filtering (exposure cap, decay, snooze, dismiss).
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
        title: card.title || '',
        card_id: card.id,
        message: `Knowledge card "${card.title}" has not been updated in ${daysAgo} days — may be outdated.`,
      });
      if (signals.filter(s => s.type === 'staleness').length >= 2) break;
    }
  }

  // 2. Pitfall cards as guard signals
  const pitfalls = allCards
    .filter((c) => (c.category === 'pitfall' || c.category === 'risk') && c.status === 'active')
    .slice(0, 3);
  for (const card of pitfalls) {
    signals.push({
      type: 'guard',
      title: card.title || '',
      card_id: card.id,
      message: `⚠️ Known pitfall: ${card.title} — ${(card.summary || '').slice(0, 300)}`,
    });
  }

  // Apply perception lifecycle: filter dormant/dismissed/snoozed, update state
  const filtered = [];
  for (const sig of signals) {
    try {
      const signalId = _computeSignalId(sig);
      sig.signal_id = signalId;
      if (!indexer?.shouldShowPerception) {
        filtered.push(sig);
        continue;
      }
      if (!indexer.shouldShowPerception(signalId)) continue;
      indexer.touchPerceptionState({
        signal_id: signalId,
        signal_type: sig.type,
        source_card_id: sig.card_id || null,
        title: sig.title || '',
      });
      filtered.push(sig);
    } catch { /* non-fatal */ }
  }

  return filtered;
}

/** Compute stable signal_id for init perception (same algorithm as daemon.mjs) */
function _computeSignalId(sig) {
  const parts = [sig.type];
  if (sig.card_id) parts.push(sig.card_id);
  else if (sig.tag) parts.push(`tag:${sig.tag}`);
  else if (sig.title) parts.push(`title:${sig.title.slice(0, 60)}`);
  else parts.push(sig.message?.slice(0, 60) || '');
  const key = parts.join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `sig_${sig.type}_${Math.abs(hash).toString(36)}`;
}

export async function buildRecallResult({ search, args, mode = 'local', indexer = null }) {
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

  const result = buildRecallSummaryContent(summaries, mode);

  // Attach matching skills as recommendations (tag overlap with query terms)
  if (indexer?.db && (args.semantic_query || args.keyword_query)) {
    try {
      const matchedSkills = _findMatchingSkills(indexer.db, args.semantic_query || args.keyword_query);
      if (matchedSkills.length > 0) {
        result._matched_skills = matchedSkills;
        // Append skill hint to the text content
        const skillHints = matchedSkills.map(
          s => `  💡 Skill available: "${s.name}" (${s.method_count} steps) — call awareness_apply_skill(skill_id="${s.id}") to execute`
        ).join('\n');
        if (result.content && Array.isArray(result.content)) {
          const textBlock = result.content.find(c => c.type === 'text');
          if (textBlock) {
            textBlock.text += `\n\n---\nMatched skills:\n${skillHints}`;
          }
        }
      }
    } catch { /* non-critical */ }
  }

  return result;
}

/**
 * Find skills whose tags overlap with query keywords.
 */
function _findMatchingSkills(db, query) {
  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter(w => w.length >= 2)
  );
  if (queryWords.size === 0) return [];

  let skills;
  try {
    skills = db.prepare(
      "SELECT id, name, summary, methods, tags FROM skills WHERE status = 'active' AND decay_score > 0.3"
    ).all();
  } catch { return []; }

  const matched = [];
  for (const skill of skills) {
    let tags;
    try { tags = JSON.parse(skill.tags || '[]'); } catch { tags = []; }
    const tagSet = new Set(tags.map(t => (t || '').toLowerCase()));

    // Count how many query words match skill tags
    const overlap = [...queryWords].filter(w => tagSet.has(w)).length;
    if (overlap >= 1) {
      let methods;
      try { methods = JSON.parse(skill.methods || '[]'); } catch { methods = []; }
      matched.push({
        id: skill.id,
        name: skill.name,
        summary: skill.summary,
        method_count: methods.length,
        tag_overlap: overlap,
      });
    }
  }

  return matched.sort((a, b) => b.tag_overlap - a.tag_overlap).slice(0, 3);
}

export function buildAgentPromptResult({ loadSpec, role }) {
  const spec = loadSpec();
  return {
    prompt: spec.init_guides?.sub_agent_guide || '',
    role: role || '',
    mode: 'local',
  };
}
