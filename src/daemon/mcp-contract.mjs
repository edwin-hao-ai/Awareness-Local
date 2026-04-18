export const RECALL_SCOPE_VALUES = [
  'all',
  'timeline',
  'knowledge',
  'insights',
];

export const RECALL_MODE_VALUES = [
  'precise',
  'session',
  'structured',
  'hybrid',
  'auto',
];

export const RECALL_DETAIL_VALUES = [
  'summary',
  'full',
];

export const RECORD_ACTION_VALUES = [
  'remember',
  'remember_batch',
  'update_task',
  'submit_insights',
];

export const LOOKUP_TYPE_VALUES = [
  'context',
  'tasks',
  'knowledge',
  'risks',
  'session_history',
  'timeline',
  'perception',
  'skills',
];

export const KNOWLEDGE_CARD_CATEGORY_VALUES = [
  'problem_solution',
  'decision',
  'workflow',
  'key_point',
  'pitfall',
  'insight',
  'skill',
  'personal_preference',
  'important_detail',
  'plan_intention',
  'activity_preference',
  'health_info',
  'career_info',
  'custom_misc',
];

export function mcpResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

export function mcpError(message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function buildRecallSummaryContent(summaries, mode = 'local') {
  const lines = summaries.map((item, index) => {
    const type = item.type ? `[${item.type}]` : '';
    const title = item.title || _previewTitle(item) || '(untitled)';
    const scorePct = item.score ? `${Math.round(item.score * 100)}%` : '';
    const age = item.created_at ? _daysAgoLabel(item.created_at) : '';
    const tokEst = item.tokens_est ? `~${item.tokens_est}tok` : '';
    const meta = [scorePct, age, tokEst].filter(Boolean).join(', ');
    const metaStr = meta ? ` (${meta})` : '';
    const summary = item.summary ? `\n   ${item.summary}` : '';
    return `${index + 1}. ${type} ${title}${metaStr}${summary}`;
  });

  const readableText = `Found ${summaries.length} memories:\n\n${lines.join('\n\n')}`;
  const idsMeta = {
    _ids: summaries.map((item) => item.id),
    _meta: { detail: 'summary', total: summaries.length, mode },
    _hint: 'To see full content, call awareness_recall(detail="full", ids=[...]) with IDs above.',
  };

  return {
    content: [
      { type: 'text', text: readableText },
      { type: 'text', text: JSON.stringify(idsMeta) },
    ],
  };
}

/** Generate a preview title from content when title is missing. */
function _previewTitle(item) {
  const raw = item.fts_content || item.content || '';
  const cleaned = raw.replace(/[#*`_\[\]>]/g, '').trim();
  const firstLine = cleaned.split(/[\n.!?。！？]/)[0]?.trim() || '';
  return firstLine.slice(0, 80);
}

/** Format created_at as a human-readable relative time label. */
function _daysAgoLabel(dateStr) {
  try {
    const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return '1d ago';
    return `${days}d ago`;
  } catch { return ''; }
}

export function buildRecallFullContent(items) {
  const sections = items.map((item) => {
    const header = item.title ? `## ${item.title}` : '';
    const raw = item.content || '(no content)';
    // Full mode = no truncation. Return complete content as-is.
    return `${header}\n\n${raw}`;
  });

  return {
    content: [{ type: 'text', text: sections.join('\n\n---\n\n') || '(no results)' }],
  };
}

export function buildRecallNoQueryContent() {
  return {
    content: [{
      type: 'text',
      text: 'No query provided. Pass a `query` parameter — e.g. awareness_recall({ query: "why did we pick pgvector" }).',
    }],
  };
}

export function buildRecallNoResultsContent() {
  return {
    content: [{ type: 'text', text: 'No matching memories found.' }],
  };
}

export function describeKnowledgeCardCategories() {
  return (
    'MUST be one of: ' +
    KNOWLEDGE_CARD_CATEGORY_VALUES.join(', ') +
    '. Unknown values default to key_point.'
  );
}

export function getToolDefinitions() {
  return [
    {
      name: 'awareness_init',
      description:
        'Start a new session and load context (knowledge cards, tasks, rules). ' +
        'Call this at the beginning of every conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'string', description: 'Memory identifier (ignored in local mode)' },
          source: { type: 'string', description: 'Client source identifier' },
          query: { type: 'string', description: 'Current user request or task focus for context shaping' },
          days: { type: 'number', description: 'Days of history to load', default: 7 },
          max_cards: { type: 'number', default: 5 },
          max_tasks: { type: 'number', default: 5 },
          max_sessions: {
            type: 'number',
            default: 0,
            description: 'How many recent-session summaries to include. Default 0 (fresh-session mode — skips "what were we doing yesterday" noise). Pass 3+ for continuity workflows.',
          },
        },
      },
    },
    {
      name: 'awareness_recall',
      description:
        'Search persistent memory. Pass ONE query string — daemon picks budget, mode, and detail. ' +
        'Example: awareness_recall({ query: "why did we pick pgvector" }).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Natural-language query. The ONLY parameter callers need — daemon auto-routes ' +
              'across memories + knowledge cards + workspace graph and picks the best detail level.',
          },
          token_budget: {
            type: 'number',
            description:
              'Optional budget hint in tokens (default 5000). ≥50K → raw-heavy mix, ' +
              '20K-50K → balanced, <20K → compressed card summaries.',
            default: 5000,
          },
          limit: { type: 'number', default: 10, maximum: 30 },

          // --- [DEPRECATED] Legacy multi-parameter surface (kept for compatibility) ---
          // These still work but log a deprecation warning. Remove after 8 weeks (F-053 Phase 5).
          semantic_query: { type: 'string', description: '[DEPRECATED] Use `query` instead.' },
          keyword_query: { type: 'string', description: '[DEPRECATED] Use `query` instead.' },
          scope: { type: 'string', enum: RECALL_SCOPE_VALUES, description: '[DEPRECATED] Daemon auto-scopes.' },
          recall_mode: { type: 'string', enum: RECALL_MODE_VALUES, description: '[DEPRECATED] Daemon auto-routes.' },
          detail: { type: 'string', enum: RECALL_DETAIL_VALUES, description: '[DEPRECATED] Budget-driven.' },
          ids: { type: 'array', items: { type: 'string' }, description: '[DEPRECATED] Progressive disclosure — pair with detail=full.' },
          agent_role: { type: 'string' },
          multi_level: { type: 'boolean', description: '[DEPRECATED] Always on.' },
          cluster_expand: { type: 'boolean', description: '[DEPRECATED] Always on.' },
          include_installed: { type: 'boolean', description: '[DEPRECATED] Always on.', default: true },
          source_exclude: { type: 'array', items: { type: 'string' }, description: '[DEPRECATED]' },
        },
        required: ['query'],
      },
    },
    {
      name: 'awareness_record',
      description:
        'Save a memory. Pass ONE content string — daemon handles extraction asynchronously via your LLM. ' +
        'Example: awareness_record({ content: "Today I decided to switch from Pinecone to pgvector because..." }).',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'Memory content in markdown. The ONLY parameter callers need — daemon defaults ' +
              'action=remember and triggers async salience-aware extraction.',
          },

          // --- [DEPRECATED] Legacy multi-parameter surface ---
          action: {
            type: 'string',
            enum: RECORD_ACTION_VALUES,
            description: '[DEPRECATED] Defaults to "remember" when content is provided. Other actions (update_task, submit_insights, remember_batch) still require explicit action.',
          },
          title: { type: 'string', description: 'Optional memory title (auto-generated if absent).' },
          items: { type: 'array', description: 'Batch items for remember_batch (explicit action required).' },
          insights: { type: 'object', description: 'Pre-extracted knowledge cards / tasks / risks.' },
          session_id: { type: 'string' },
          agent_role: { type: 'string' },
          event_type: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          task_id: { type: 'string' },
          status: { type: 'string' },
          source: { type: 'string', description: 'Client source identifier (e.g. desktop, openclaw-plugin, mcp).' },
        },
        required: ['content'],
      },
    },
    {
      name: 'awareness_lookup',
      description:
        'Fast DB lookup — use instead of awareness_recall when you know what type of data you want.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: LOOKUP_TYPE_VALUES,
          },
          limit: { type: 'number', default: 10 },
          status: { type: 'string' },
          category: { type: 'string' },
          priority: { type: 'string' },
          session_id: { type: 'string' },
          agent_role: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['type'],
      },
    },
    {
      name: 'awareness_get_agent_prompt',
      description: 'Get the activation prompt for a specific agent role.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Agent role to get prompt for' },
        },
      },
    },
    {
      name: 'awareness_apply_skill',
      description: 'Apply a learned skill — returns structured step-by-step execution plan. Call this when a task matches an active skill from awareness_init. The skill will be marked as used automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'ID of the skill to apply (from active_skills in awareness_init)' },
          context: { type: 'string', description: 'Current task context — the skill methods will be adapted to this context' },
        },
        required: ['skill_id'],
      },
    },
    {
      name: 'awareness_mark_skill_used',
      description: 'Mark a skill as used and report outcome — resets decay timer and increments usage counter. Pass outcome to close the feedback loop: "success" (default) fully resets decay, "partial" gives reduced boost, "failed" decreases confidence. 3+ consecutive failures auto-flag skill for review.',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'The ID of the skill to mark as used' },
          outcome: { type: 'string', enum: ['success', 'partial', 'failed'], description: 'Outcome of applying the skill. Default: "success"', default: 'success' },
        },
        required: ['skill_id'],
      },
    },
    {
      name: 'awareness_workspace_search',
      description: 'Search workspace files, code symbols, and wiki pages in the current project. Use this to find code, documentation, and project structure.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (natural language or keywords)' },
          node_types: {
            type: 'array',
            items: { type: 'string', enum: ['file', 'symbol', 'wiki', 'doc'] },
            description: 'Filter by node type (default: all types)',
          },
          limit: { type: 'number', default: 10, maximum: 30 },
          include_neighbors: { type: 'boolean', default: false, description: 'Include similar files via graph traversal' },
        },
        required: ['query'],
      },
    },
  ];
}
