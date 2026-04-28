import { PERSONAL_CARD_CATEGORIES } from './constants.mjs';
import {
  buildRecallFullContent,
  buildRecallNoQueryContent,
  buildRecallNoResultsContent,
  buildRecallSummaryContent,
} from './mcp-contract.mjs';
import {
  extractActiveSkills,
  filterPersonaByRelevance,
  splitPreferences,
  synthesizeRules,
} from './helpers.mjs';

// Strip DB row to just the index fields. The narrative content (summary) is
// rendered inline in `rendered_context` markdown below — duplicating it here
// as JSON doubles the payload for no LLM benefit. Callers that need a specific
// card's full summary can call `awareness_recall(ids=[...], detail="full")`.
function trimCardForInit(card) {
  if (!card) return card;
  return {
    id: card.id,
    category: card.category,
    title: card.title,
  };
}

// Markdown renderer for init memory context. Preferred over XML because:
//   - no tag-overhead (every <card>…</card> adds ~15 chars of zero-info markup)
//   - Claude/GPT training data is markdown-heavy, so it parses more reliably
//   - humans reading logs can actually skim it
// Output is bounded: each section caps at N items to keep token budget sane.
function buildMemoryMarkdown(ctx, perceptionSignals, options = {}) {
  const lines = [];
  const emitSection = (heading, items, fmt) => {
    if (!items || items.length === 0) return;
    lines.push(`## ${heading}`);
    for (const item of items) lines.push(fmt(item));
    lines.push('');
  };

  if (options.currentFocus) {
    lines.push('## Current focus');
    lines.push(String(options.currentFocus).trim());
    lines.push('');
  }

  const skills = ctx.active_skills || [];
  emitSection('Active skills', skills, (s) =>
    `- **${s.title || s.id}** — ${s.summary || ''}`);

  const perception = (perceptionSignals || []).filter((s) => s.message);
  emitSection('Attention', perception, (s) =>
    `- [${s.type || 'signal'}] ${s.message}`);

  const prefs = ctx.user_preferences || [];
  emitSection('User preferences', prefs, (p) => {
    const rule = (p.actionable_rule || '').trim();
    return rule
      ? `- [${p.category || ''}] ${rule}`
      : `- [${p.category || ''}] **${p.title || ''}** — ${p.summary || ''}`;
  });

  // Full summary inlined here (the one place it lives for LLM consumption)
  const knowledge = (ctx.knowledge_cards_full || ctx.knowledge_cards || []).slice(0, 12);
  emitSection('Knowledge', knowledge, (c) => {
    const rule = (c.actionable_rule || '').trim();
    return rule
      ? `- [${c.category || ''}] ${rule}`
      : `- [${c.category || ''}] **${c.title || ''}** — ${c.summary || ''}`;
  });

  const tasks = (ctx.open_tasks || []).slice(0, 10);
  emitSection('Open tasks', tasks, (t) =>
    `- [${t.priority || 'medium'}/${t.status || 'pending'}] ${t.title || ''}`);

  const sessions = (ctx.recent_sessions || []).slice(0, 5);
  emitSection('Recent sessions', sessions, (s) => {
    const events = s.event_count || s.memory_count || 0;
    return `- ${s.date || ''} (${events} events) ${s.summary || ''}`;
  });

  // Wrap the markdown body in <awareness-memory> tags. This is a load-bearing
  // contract with sdks/openclaw/src/hooks.ts which uses `.replace("</awareness-memory>", ...)`
  // at four sites to inject perception signals, record-rule, and dashboard
  // hints. Dropping the wrapper would silently lose those injections. The
  // body between the tags is still markdown (headings, bullets), so LLMs
  // parse it naturally — the wrapper is only a string anchor for clients.
  const body = lines.join('\n').trim();
  return `<awareness-memory>\n${body}\n</awareness-memory>`;
}

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
  maxSessions = 0,
  renderContextOptions = {},
}) {
  const session = createSession(source);
  const stats = indexer.getStats();
  const focus = renderContextOptions?.currentFocus?.trim() || undefined;
  const recentCards = _selectRelevantCards(indexer, maxCards, focus);
  const allActiveCards = indexer.getRecentKnowledge(200);
  const openTasks = indexer.getOpenTasks(maxTasks);

  // F-053 post-0.8.0: recent_sessions is opt-in. When `maxSessions=0` (default
  // for new sessions), skip the recent-sessions query entirely — saves 500-1000
  // prompt tokens of unrelated "what were we doing yesterday" noise on fresh
  // sessions. Callers who want continuity can pass max_sessions: 3+ explicitly.
  let recentSessions = [];
  if (maxSessions > 0) {
    const rawSessions = indexer.getRecentSessions(days);
    recentSessions = rawSessions.filter((sessionItem) =>
      sessionItem.memory_count > 0 || sessionItem.summary);
    if (recentSessions.length === 0) {
      recentSessions = rawSessions.slice(0, Math.min(3, maxSessions));
    }
    recentSessions = recentSessions.slice(0, maxSessions);
  }

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

  // F-055 bug A — pull persona candidates from the full active pool
  // (not just BM25-ranked `recentCards`) so confidence-filtered personas
  // still surface when the query doesn't directly match them, then gate
  // by relevance OR high confidence. Category list lives in
  // `constants.PERSONAL_CARD_CATEGORIES` (single source of truth).
  const personaCandidates = allActiveCards.filter(
    (c) => c && typeof c.category === 'string' && PERSONAL_CARD_CATEGORIES.has(c.category),
  );
  const gatedPersona = filterPersonaByRelevance(personaCandidates, indexer, focus);

  const { knowledge_cards: otherCards } = splitPreferences(recentCards);
  const user_preferences = gatedPersona.map(trimCardForInit);
  const trimmedKnowledgeCards = otherCards.map(trimCardForInit);

  // Build lightweight perception signals for init (staleness + pitfall guards)
  const initPerception = _buildInitPerception(indexer, allActiveCards);

  // Workspace project summary (if scanned)
  let workspaceSummary = null;
  try {
    const graphCounts = indexer.db.prepare(
      `SELECT node_type, COUNT(*) as count FROM graph_nodes WHERE status = 'active' GROUP BY node_type`
    ).all();
    const edgeCount = indexer.db.prepare(`SELECT COUNT(*) as count FROM graph_edges`).get();
    if (graphCounts.length > 0) {
      workspaceSummary = {
        nodes: Object.fromEntries(graphCounts.map(r => [r.node_type, r.count])),
        edges: edgeCount?.count || 0,
        scanned: true,
      };
    }
  } catch { /* graph tables may not exist yet */ }

  // Field shape stays stable for downstream clients (setup-cli, AwarenessClaw,
  // cloud SDKs). Previously-heavy fields are preserved as empty values so
  // `result.init_guides?.write_guide` etc. still resolve (to undefined),
  // instead of throwing on missing property access.
  //
  //   - `init_guides` emptied: real consumers (extraction-instruction.mjs,
  //     sub_agent_guide) read spec.json directly via loadSpec(), not from init.
  //   - `agent_profiles` stays []: local daemon never populated it; cloud-only.
  //   - `setup_hints` stays []: local daemon never populated it.
  const initResult = {
    session_id: session.id,
    mode: 'local',
    user_preferences,
    knowledge_cards: trimmedKnowledgeCards,
    open_tasks: openTasks,
    recent_sessions: recentSessions,
    stats,
    attention_summary: attentionSummary,
    synthesized_rules: { rules, rule_count },
    init_guides: {},
    agent_profiles: [],
    active_skills: activeSkills,
    setup_hints: [],
    workspace_summary: workspaceSummary,
  };

  // Render memory-only narrative in markdown. Uses the un-trimmed cards so
  // summary text survives; `knowledge_cards` above stays as a lightweight
  // index. `init_guides` / `setup_hints` / `agent_profiles` are product
  // documentation, not memory — deliberately omitted per user request
  // 2026-04-20: "only memory-related content, drop the rest".
  try {
    const fullCtx = {
      ...initResult,
      knowledge_cards_full: otherCards,
      user_preferences: gatedPersona,
    };
    initResult.rendered_context = buildMemoryMarkdown(fullCtx, initPerception, renderContextOptions);
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
      message: `⚠️ Known pitfall: ${card.title} — ${card.summary || ''}`,
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

/**
 * F-053 Phase 2 · Deprecation warning limiter.
 *
 * Keeps per-parameter timestamps so we only warn once per hour per legacy
 * parameter name. Prevents log spam when a legacy client makes many calls.
 */
const DEPRECATED_PARAMS = [
  'semantic_query', 'keyword_query', 'scope', 'recall_mode',
  'detail', 'ids', 'multi_level', 'cluster_expand',
  'include_installed', 'source_exclude',
];
const DEPRECATION_LOG_INTERVAL_MS = 60 * 60 * 1000;
const _deprecationLogLastAt = new Map();

function _warnDeprecatedParams(args) {
  const now = Date.now();
  for (const key of DEPRECATED_PARAMS) {
    if (args[key] === undefined || args[key] === null || args[key] === '') continue;
    const last = _deprecationLogLastAt.get(key) || 0;
    if (now - last < DEPRECATION_LOG_INTERVAL_MS) continue;
    _deprecationLogLastAt.set(key, now);
    console.warn(`[awareness_recall] [deprecated param used] ${key} — migrate to single-parameter \`query\` (F-053)`);
  }
}

export async function buildRecallResult({ search, args, mode = 'local', indexer = null, getArchetypeIndex = null }) {
  // Legacy progressive-disclosure path: detail=full + ids → expand to full content.
  if (args.detail === 'full' && args.ids?.length) {
    _warnDeprecatedParams(args);
    const items = search
      ? await search.getFullContent(args.ids)
      : [];
    return buildRecallFullContent(items);
  }

  // Resolve the effective query string, preferring the F-053 single-parameter
  // surface (`query`) but falling back to legacy `semantic_query` / `keyword_query`.
  const queryStr = (args.query || args.semantic_query || args.keyword_query || '').trim();
  if (!queryStr) {
    return buildRecallNoQueryContent();
  }

  const usesLegacy = !args.query && (args.semantic_query || args.keyword_query);
  if (usesLegacy || Object.keys(args).some((k) => DEPRECATED_PARAMS.includes(k))) {
    _warnDeprecatedParams(args);
  }

  let summaries = [];
  if (search) {
    if (args.query && typeof search.unifiedCascadeSearch === 'function') {
      // Single-parameter path: daemon-driven cascade with budget-tier shaping.
      const tokenBudget = Number.isFinite(args.token_budget) && args.token_budget > 0
        ? args.token_budget
        : 5000;
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 10;

      // F-053 Phase 3 activation: auto-classify the query into an archetype
      // (decision-why / fact-what / recall-recent / …) and pass the strategy
      // into the cascade. Gracefully degrade to Phase 1c default when the
      // index is unavailable or confidence is too low.
      let strategy = null;
      let archetype = null;
      if (typeof getArchetypeIndex === 'function') {
        try {
          const index = await getArchetypeIndex();
          if (index) {
            const { classifyQuery } = await import('../core/query-type-router.mjs');
            const cls = await classifyQuery(queryStr, index);
            if (cls && cls.strategy) {
              strategy = cls.strategy;
              archetype = cls.archetype;
            }
          }
        } catch { /* classification is a tilt, not a gate — silent fallback */ }
      }

      const out = await search.unifiedCascadeSearch(queryStr, {
        tokenBudget,
        limit,
        strategy,
        hyde_hint: args.hyde_hint,  // F-060 · client-provided HyDE passthrough
      });
      summaries = Array.isArray(out?.results) ? out.results : [];

      // Annotate first item with the archetype (opaque to LLM, useful for
      // debug logs that inspect the raw JSON envelope).
      if (archetype && summaries.length > 0) {
        summaries[0]._archetype = archetype;
      }
    } else {
      // Legacy multi-parameter path preserved verbatim.
      summaries = await search.recall(args);
    }
  }

  if (!summaries.length) {
    return buildRecallNoResultsContent();
  }

  // F-083 Phase 4: decorate each summary with the wiki_path so agents can
  // WebFetch the canonical .md file. Computed deterministically from the
  // same slug rule that wiki-write uses on awareness_record.
  try {
    const { resolveCardPath } = await import('../core/markdown-tree.mjs');
    for (const s of summaries) {
      if (s && s.title && s.category && !s.wiki_path) {
        try {
          const r = resolveCardPath('', {
            category: s.category,
            title: s.title,
            created_at: s.created_at,
          });
          s.wiki_path = r.relPath;  // relative to ~/.awareness/
        } catch { /* best-effort decoration */ }
      }
    }
  } catch { /* markdown-tree not available — older daemon */ }

  const result = buildRecallSummaryContent(summaries, mode);

  // Attach matching skills as recommendations (tag overlap with query terms)
  if (indexer?.db && queryStr) {
    try {
      const matchedSkills = _findMatchingSkills(indexer.db, queryStr);
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
