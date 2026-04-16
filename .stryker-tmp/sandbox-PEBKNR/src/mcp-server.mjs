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
// @ts-nocheck


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  describeKnowledgeCardCategories,
  LOOKUP_TYPE_VALUES,
  mcpError,
  mcpResult,
  RECORD_ACTION_VALUES,
  RECALL_DETAIL_VALUES,
  RECALL_MODE_VALUES,
  RECALL_SCOPE_VALUES,
} from './daemon/mcp-contract.mjs';
import {
  buildAgentPromptResult,
  buildInitResult,
  buildRecallResult,
} from './daemon/mcp-handlers.mjs';

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
        query: z.string().optional().describe('Current user request or task focus for context shaping'),
        days: z.number().optional().default(7).describe(
          'Days of history to load'
        ),
        max_cards: z.number().optional().default(5),
        max_tasks: z.number().optional().default(5),
      },
      async (params) => {
        try {
          return mcpResult(buildInitResult({
            createSession: (source) => this.engine.createSession(source),
            indexer: this.engine.indexer,
            loadSpec: () => this.engine.loadSpec(),
            source: params.source,
            renderContextOptions: { currentFocus: params.query },
            days: params.days ?? 7,
            maxCards: params.max_cards ?? 5,
            maxTasks: params.max_tasks ?? 5,
          }));
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
        scope: z.enum(RECALL_SCOPE_VALUES)
          .optional().default('all')
          .describe('Search scope'),
        recall_mode: z.enum(RECALL_MODE_VALUES)
          .optional().default('hybrid')
          .describe('Search mode (hybrid recommended)'),
        limit: z.number().min(1).max(30).optional().default(10)
          .describe('Max results'),
        detail: z.enum(RECALL_DETAIL_VALUES).optional().default('summary')
          .describe(
            'summary = lightweight index (~50-100 tokens each); ' +
            'full = complete content for specified ids'
          ),
        ids: z.array(z.string()).optional().describe(
          'Item IDs to expand when detail=full (from a prior detail=summary call)'
        ),
        agent_role: z.string().optional().default('').describe('Agent role filter'),
        multi_level: z.boolean().optional().describe(
          'Enable broader context retrieval across sessions and time ranges'
        ),
        cluster_expand: z.boolean().optional().describe(
          'Enable topic-based context expansion for deeper exploration'
        ),
        include_installed: z.boolean().optional().default(true).describe(
          'Also search installed market memories'
        ),
        source_exclude: z.array(z.string()).optional().describe(
          'Exclude memories from these source identifiers (e.g. ["mcp"] to hide Claude Code dev memories)'
        ),
      },
      async (params) => {
        try {
          return await buildRecallResult({
            search: this.engine.search,
            args: {
              semantic_query: params.semantic_query,
              keyword_query: params.keyword_query,
              scope: params.scope,
              recall_mode: params.recall_mode,
              limit: params.limit,
              agent_role: params.agent_role,
              detail: params.detail || 'summary',
              ids: params.ids,
              multi_level: params.multi_level,
              cluster_expand: params.cluster_expand,
              include_installed: params.include_installed,
              source_exclude: params.source_exclude,
            },
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
        action: z.enum(RECORD_ACTION_VALUES).describe('Record action type'),
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
              describeKnowledgeCardCategories()
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
        source: z.string().optional().describe('Client source identifier (e.g. desktop, openclaw-plugin, mcp)'),
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
        type: z.enum(LOOKUP_TYPE_VALUES).describe(
          'Data type to look up. ' +
          'context = full dump, tasks = open tasks, knowledge = cards, ' +
          'risks = risk items, session_history = past sessions, timeline = events, ' +
          'perception = signals (contradictions, patterns, staleness), ' +
          'skills = learned reusable procedures'
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
          return mcpResult(buildAgentPromptResult({
            loadSpec: () => this.engine.loadSpec(),
            role: params.role,
          }));
        } catch (err) {
          return mcpError(`awareness_get_agent_prompt failed: ${err.message}`);
        }
      }
    );
  }
}

export default LocalMcpServer;
