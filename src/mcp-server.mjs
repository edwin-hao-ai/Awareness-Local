/**
 * LocalMcpServer — MCP protocol layer for Awareness Local.
 *
 * Registers 5 MCP tools that are 100% compatible with the cloud API:
 *   - awareness_init       — session creation + context loading
 *   - awareness_recall     — progressive disclosure search (summary/full)
 *   - awareness_record     — remember / remember_batch / update_task / submit_insights
 *   - awareness_lookup     — type-based structured data queries
 *   - awareness_get_agent_prompt — spec-based agent prompt
 *
 * Uses @modelcontextprotocol/sdk McpServer with Zod schemas.
 * All tools return: { content: [{ type: 'text', text: JSON.stringify(result) }] }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildContextXml } from './harness-builder.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Categories surfaced as top-level user_preferences (mirrors cloud). */
const PREFERENCE_FIRST_CATEGORIES = new Set([
  'personal_preference', 'activity_preference', 'important_detail', 'career_info',
]);
const MAX_USER_PREFERENCES = 15;

/** Split knowledge cards into {user_preferences, knowledge_cards}. */
function splitPreferences(cards) {
  const prefs = [];
  const other = [];
  for (const c of cards) {
    if (PREFERENCE_FIRST_CATEGORIES.has(c.category) && prefs.length < MAX_USER_PREFERENCES) {
      prefs.push(c);
    } else {
      other.push(c);
    }
  }
  return { user_preferences: prefs, knowledge_cards: other };
}

// ---------------------------------------------------------------------------
// Dynamic rule synthesis from knowledge cards (zero-LLM)
// ---------------------------------------------------------------------------

const CATEGORY_TO_RULE_TYPE = {
  decision: 'architecture', workflow: 'workflow', pitfall: 'pitfall',
  problem_solution: 'solution', key_point: 'knowledge', insight: 'knowledge',
  personal_preference: 'preference', activity_preference: 'preference',
  important_detail: 'context', plan_intention: 'context',
  health_info: 'context', career_info: 'context', custom_misc: 'context',
};

/**
 * Synthesize rules from knowledge cards, prioritised by type.
 * @param {object[]} cards — active knowledge cards
 * @param {number} [maxRules=30]
 * @returns {{ rules: object[], rule_count: number }}
 */
function synthesizeRules(cards, maxRules = 30) {
  const buckets = {};
  for (const card of cards) {
    const ruleType = CATEGORY_TO_RULE_TYPE[card.category] || 'knowledge';
    if (!buckets[ruleType]) buckets[ruleType] = [];

    const ruleText = (card.actionable_rule || '').trim() || card.summary || '';
    if (!ruleText) continue;

    buckets[ruleType].push({
      id: `rule_${(card.id || '').slice(0, 8)}`,
      rule_type: ruleType,
      title: card.title || '',
      rule: ruleText,
      confidence: card.confidence || 0.8,
      tags: card.tags ? (typeof card.tags === 'string' ? JSON.parse(card.tags) : card.tags) : [],
    });
  }

  const priority = ['preference', 'architecture', 'pitfall', 'workflow', 'solution', 'knowledge', 'context'];
  const rules = [];
  for (const type of priority) {
    const bucket = (buckets[type] || []).slice(0, 8);
    for (const r of bucket) {
      if (rules.length >= maxRules) break;
      rules.push(r);
    }
    if (rules.length >= maxRules) break;
  }
  return { rules, rule_count: rules.length };
}

/**
 * Extract active skills from knowledge cards (category === 'skill').
 * @param {object[]} cards
 * @returns {object[]}
 */
function extractActiveSkills(cards) {
  return cards
    .filter(c => c.category === 'skill')
    .map(c => {
      let methods = [];
      if (c.methods) {
        methods = typeof c.methods === 'string' ? JSON.parse(c.methods) : c.methods;
      }
      if (!Array.isArray(methods)) methods = [];
      return {
        title: c.title || '',
        summary: c.summary || '',
        methods,
      };
    });
}

/**
 * Wrap a result object in the MCP-standard content envelope.
 * @param {object} result
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function mcpResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

/**
 * Wrap an error message in the MCP-standard content envelope with isError flag.
 * @param {string} message
 * @returns {{ content: Array<{ type: string, text: string }>, isError: boolean }}
 */
function mcpError(message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// LocalMcpServer
// ---------------------------------------------------------------------------

export class LocalMcpServer {
  /**
   * @param {object} engine — injected from the daemon, provides:
   *   - memoryStore   {MemoryStore}     — markdown file CRUD
   *   - indexer        {Indexer}         — SQLite FTS5 index
   *   - search         {SearchEngine}   — hybrid recall
   *   - extractor      {KnowledgeExtractor} — rule + pre-extracted knowledge
   *   - config         {object}         — loaded config.json
   *   - loadSpec       {() => object}   — returns awareness-spec.json contents
   *   - createSession  {(source) => object}
   *   - remember       {(params) => Promise<object>}
   *   - rememberBatch  {(params) => Promise<object>}
   *   - updateTask     {(params) => Promise<object>}
   *   - submitInsights {(params) => Promise<object>}
   *   - lookup         {(params) => Promise<object>}
   */
  constructor(engine) {
    this.engine = engine;
    this.server = new McpServer({
      name: 'awareness-local',
      version: '1.0.0',
    });
    this._registerTools();
  }

  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  /** @private */
  _registerTools() {
    this._registerInit();
    this._registerRecall();
    this._registerRecord();
    this._registerLookup();
    this._registerGetAgentPrompt();
  }

  // ======================== awareness_init ================================

  /** @private */
  _registerInit() {
    this.server.tool(
      'awareness_init',
      {
        memory_id: z.string().optional().describe(
          'Memory identifier (ignored in local mode, uses project dir)'
        ),
        source: z.string().optional().describe('Client source identifier'),
        days: z.number().optional().default(7).describe(
          'Days of history to load'
        ),
        max_cards: z.number().optional().default(5),
        max_tasks: z.number().optional().default(5),
      },
      async (params) => {
        try {
          const session = this.engine.createSession(params.source);
          const stats = this.engine.indexer.getStats();
          const recentCards = this.engine.indexer.getRecentKnowledge(
            params.max_cards ?? 5
          );
          // Load all active cards for rule synthesis and skill extraction
          const allActiveCards = this.engine.indexer.getRecentKnowledge(200);
          const openTasks = this.engine.indexer.getOpenTasks(
            params.max_tasks ?? 5
          );
          const recentSessions = this.engine.indexer.getRecentSessions(
            params.days ?? 7
          );

          // Load workflow rules from awareness-spec.json
          const spec = this.engine.loadSpec();

          // Dynamic rule synthesis from knowledge cards
          const { rules, rule_count } = synthesizeRules(allActiveCards);
          // Active skills from knowledge cards
          const activeSkills = extractActiveSkills(allActiveCards);

          const { user_preferences, knowledge_cards: otherCards } = splitPreferences(recentCards);
          const initResult = {
            session_id: session.id,
            mode: 'local',
            user_preferences,
            knowledge_cards: otherCards,
            open_tasks: openTasks,
            recent_sessions: recentSessions,
            stats,
            synthesized_rules: { rules, rule_count },
            init_guides: spec.init_guides || {},
            agent_profiles: [],
            active_skills: activeSkills,
            setup_hints: [],
          };

          // Render XML context
          try {
            initResult.rendered_context = buildContextXml(initResult, [], [], {});
          } catch {
            // Non-fatal — client can still use structured data
          }

          return mcpResult(initResult);
        } catch (err) {
          return mcpError(`awareness_init failed: ${err.message}`);
        }
      }
    );
  }

  // ======================== awareness_recall ==============================

  /** @private */
  _registerRecall() {
    this.server.tool(
      'awareness_recall',
      {
        semantic_query: z.string().optional().default('').describe(
          'Natural language search query (required for search)'
        ),
        keyword_query: z.string().optional().default('').describe(
          'Exact keyword match for BM25 full-text search'
        ),
        scope: z.enum(['all', 'timeline', 'knowledge', 'insights'])
          .optional().default('all')
          .describe('Search scope'),
        recall_mode: z.enum(['precise', 'session', 'structured', 'hybrid', 'auto'])
          .optional().default('hybrid')
          .describe('Search mode (hybrid recommended)'),
        limit: z.number().min(1).max(30).optional().default(10)
          .describe('Max results'),
        detail: z.enum(['summary', 'full']).optional().default('summary')
          .describe(
            'summary = lightweight index (~50-100 tokens each); ' +
            'full = complete content for specified ids'
          ),
        ids: z.array(z.string()).optional().describe(
          'Item IDs to expand when detail=full (from a prior detail=summary call)'
        ),
        agent_role: z.string().optional().default('').describe('Agent role filter'),
      },
      async (params) => {
        try {
          // Phase 2: full content for specific IDs
          if (params.detail === 'full' && params.ids?.length) {
            const items = await this.engine.search.getFullContent(params.ids);
            return mcpResult({
              results: items,
              total: items.length,
              mode: 'local',
              detail: 'full',
            });
          }

          // Phase 1: search and return summary index
          if (!params.semantic_query && !params.keyword_query) {
            return mcpResult({
              results: [],
              total: 0,
              mode: 'local',
              detail: 'summary',
              search_method: 'hybrid',
            });
          }

          const summaries = await this.engine.search.recall({
            semantic_query: params.semantic_query,
            keyword_query: params.keyword_query,
            scope: params.scope,
            recall_mode: params.recall_mode,
            limit: params.limit,
            agent_role: params.agent_role,
            detail: params.detail || 'summary',
            ids: params.ids,
          });

          const effectiveDetail = params.detail || 'summary';

          if (effectiveDetail === 'summary' && summaries.length > 0) {
            // Format summary as readable text for the Agent, with IDs hidden
            // but available for Phase 2 expansion
            const lines = summaries.map((r, i) => {
              const title = r.title || '(untitled)';
              const type = r.type ? `[${r.type}]` : '';
              const summary = r.summary ? `\n   ${r.summary}` : '';
              return `${i + 1}. ${type} ${title}${summary}`;
            });
            const readableText = `Found ${summaries.length} memories:\n\n${lines.join('\n\n')}`;

            // Return readable text + structured data for programmatic use
            return {
              content: [
                { type: 'text', text: readableText },
                { type: 'text', text: JSON.stringify({
                  _ids: summaries.map(r => r.id),
                  _meta: { detail: 'summary', total: summaries.length, mode: 'local' },
                }) },
              ],
            };
          }

          if (effectiveDetail === 'full' && summaries.length > 0) {
            // Full content — return as readable text
            const sections = summaries.map(r => {
              const header = r.title ? `## ${r.title}` : '';
              return `${header}\n\n${r.content || '(no content)'}`;
            });
            return {
              content: [{ type: 'text', text: sections.join('\n\n---\n\n') }],
            };
          }

          // Fallback / empty results
          return mcpResult({
            results: summaries,
            total: summaries.length,
            mode: 'local',
            detail: effectiveDetail,
            search_method: 'hybrid',
          });
        } catch (err) {
          return mcpError(`awareness_recall failed: ${err.message}`);
        }
      }
    );
  }

  // ======================== awareness_record ==============================

  /** @private */
  _registerRecord() {
    this.server.tool(
      'awareness_record',
      {
        action: z.enum([
          'remember', 'remember_batch', 'update_task', 'submit_insights',
        ]).describe('Record action type'),
        content: z.string().optional().describe('Memory content (markdown)'),
        title: z.string().optional().describe('Memory title'),
        items: z.array(z.object({
          content: z.string(),
          title: z.string().optional(),
          event_type: z.string().optional(),
          tags: z.array(z.string()).optional(),
          insights: z.any().optional(),
        })).optional().describe('Batch items for remember_batch'),
        insights: z.object({
          knowledge_cards: z.array(z.object({
            title: z.string().describe('Short descriptive title'),
            summary: z.string().optional().describe('Detailed summary (also accepted as "content")'),
            content: z.string().optional().describe('Alias for summary'),
            category: z.string().optional().describe(
              'MUST be one of: problem_solution, decision, workflow, key_point, pitfall, insight, ' +
              'personal_preference, important_detail, plan_intention, activity_preference, ' +
              'health_info, career_info, custom_misc. Unknown values default to key_point.'
            ),
            tags: z.array(z.string()).optional(),
            confidence: z.number().optional(),
          })).optional(),
          action_items: z.array(z.any()).optional(),
          risks: z.array(z.any()).optional(),
        }).optional().describe('Pre-extracted knowledge cards, tasks, risks'),
        session_id: z.string().optional(),
        agent_role: z.string().optional(),
        event_type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        // Task update fields
        task_id: z.string().optional(),
        status: z.string().optional(),
      },
      async (params) => {
        try {
          switch (params.action) {
            case 'remember':
              return mcpResult(await this.engine.remember(params));
            case 'remember_batch':
              return mcpResult(await this.engine.rememberBatch(params));
            case 'update_task':
              return mcpResult(await this.engine.updateTask(params));
            case 'submit_insights':
              return mcpResult(await this.engine.submitInsights(params));
            default:
              return mcpError(`Unknown action: ${params.action}`);
          }
        } catch (err) {
          return mcpError(`awareness_record failed: ${err.message}`);
        }
      }
    );
  }

  // ======================== awareness_lookup ==============================

  /** @private */
  _registerLookup() {
    this.server.tool(
      'awareness_lookup',
      {
        type: z.enum([
          'context', 'tasks', 'knowledge', 'risks',
          'session_history', 'timeline', 'perception',
        ]).describe(
          'Data type to look up. ' +
          'context = full dump, tasks = open tasks, knowledge = cards, ' +
          'risks = risk items, session_history = past sessions, timeline = events, ' +
          'perception = signals (contradictions, patterns, staleness)'
        ),
        limit: z.number().optional().default(10).describe('Max items'),
        status: z.string().optional().describe('Status filter'),
        category: z.string().optional().describe('Category filter (knowledge cards)'),
        priority: z.string().optional().describe('Priority filter (tasks/risks)'),
        session_id: z.string().optional().describe('Session ID (for session_history)'),
        agent_role: z.string().optional().describe('Agent role filter'),
        query: z.string().optional().describe('Keyword filter'),
      },
      async (params) => {
        try {
          const result = await this.engine.lookup(params);
          return mcpResult(result);
        } catch (err) {
          return mcpError(`awareness_lookup failed: ${err.message}`);
        }
      }
    );
  }

  // ======================== awareness_get_agent_prompt ====================

  /** @private */
  _registerGetAgentPrompt() {
    this.server.tool(
      'awareness_get_agent_prompt',
      {
        role: z.string().optional().describe('Agent role to get prompt for'),
      },
      async (params) => {
        try {
          const spec = this.engine.loadSpec();
          return mcpResult({
            prompt: spec.init_guides?.sub_agent_guide || '',
            role: params.role || '',
            mode: 'local',
          });
        } catch (err) {
          return mcpError(`awareness_get_agent_prompt failed: ${err.message}`);
        }
      }
    );
  }
}

export default LocalMcpServer;
