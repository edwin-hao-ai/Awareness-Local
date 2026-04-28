/**
 * publish-agent.mjs — Daemon-side handler for `awareness_publish_agent` (D17 vibe-publish).
 *
 * F-081 Part B. Flow:
 *   1. Agent calls MCP tool `awareness_publish_agent({ slug, description })`
 *   2. Daemon assembles a context bundle from current session
 *   3. Daemon hands bundle BACK to host-LLM via prompt to synthesize manifest
 *      (we do NOT run an LLM — host produces it in the same MCP cycle)
 *   4. Daemon runs local secret scanner on the LLM output
 *   5. Daemon POSTs draft to backend `/api/v1/agent-drafts`
 *   6. Returns Dashboard URL `/publish/<draft_id>` for the user
 *
 * Per v2 constraint #2 (all-free): no payment branching anywhere.
 */

import { scanDraft } from '../../core/secret-scanner.mjs';

/**
 * Assemble the context bundle from the daemon's current session state.
 * The host-LLM uses this to synthesize the manifest.
 *
 * @param {object} opts
 * @param {object} opts.daemon — daemon instance with .indexer + session helpers
 * @param {string} opts.slug
 * @param {string} [opts.description]
 * @returns {object} bundle — handed to host-LLM in the next prompt
 */
export function assembleContextBundle({ daemon, slug, description }) {
  const indexer = daemon?.indexer;
  if (!indexer) {
    return {
      slug,
      description: description || '',
      skill_md: '',
      recent_cards: [],
      entities: [],
      runtime: 'unknown',
      warning: 'no daemon indexer available',
    };
  }

  let recentCards = [];
  try {
    // Pull recent top cards by created_at desc
    const stmt = indexer.db?.prepare?.(
      `SELECT id, category, title, summary, created_at
       FROM knowledge_cards
       WHERE status = 'live' OR status IS NULL
       ORDER BY datetime(created_at) DESC
       LIMIT 10`,
    );
    if (stmt) recentCards = stmt.all();
  } catch {
    recentCards = [];
  }

  let runtime = 'mcp-generic';
  try {
    runtime = daemon?.runtime || daemon?._runtime || 'mcp-generic';
  } catch {
    runtime = 'mcp-generic';
  }

  return {
    slug,
    description: description || '',
    runtime,
    skill_md: '',  // To be supplied by host-LLM during synthesis (it has SKILL.md in context)
    recent_cards: recentCards.map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      summary: c.summary,
    })),
    entities: [],  // TODO: pull from F-074 graph once local entities table lands
    instructions: synthesisInstructions(slug, description),
  };
}

/**
 * The instructions text the daemon hands to the host-LLM. The host-LLM is
 * expected to combine these with the bundle to produce a manifest object.
 *
 * Output schema the host-LLM must produce:
 *   {
 *     "name": "<human readable name>",
 *     "slug": "<slug-as-given>",
 *     "description": "<1-2 sentences>",
 *     "skill_md": "<full SKILL.md body>",
 *     "tags": ["..."],
 *     "category": "<agent | pack>",
 *     "license": "MIT" | "Apache-2.0" | "proprietary",
 *     "language": "en" | "zh-CN" | ...
 *   }
 */
export function synthesisInstructions(slug, description) {
  return [
    'You are about to publish an agent or pack to the Awareness Marketplace.',
    `User-supplied slug: ${slug}`,
    description ? `User-supplied description: ${description}` : '',
    '',
    'Synthesize a publish_draft manifest from the context bundle. Output JSON only:',
    '',
    '```json',
    '{',
    '  "name": "Human Readable Name",',
    '  "slug": "<slug-as-given>",',
    '  "description": "1-2 sentences explaining what this agent/pack does.",',
    '  "skill_md": "<full SKILL.md body covering Step 0-5, the canonical procedure>",',
    '  "tags": ["tag1", "tag2"],',
    '  "category": "agent",',
    '  "license": "MIT",',
    '  "language": "en"',
    '}',
    '```',
    '',
    'Rules:',
    '- Keep description under 280 chars.',
    '- skill_md must be self-contained — a stranger reading it should know how to use the agent.',
    '- DO NOT include API keys, tokens, passwords, or absolute file paths in any field.',
    '- Match the user input language (description in user\'s language; skill_md may be bilingual).',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Scan a host-LLM-produced draft and prepare for backend POST.
 *
 * @param {object} draft — manifest produced by host-LLM
 * @returns {{ ok: boolean, draft?: object, report: object, error?: string }}
 */
export function reviewDraft(draft) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, error: 'draft is required', report: { blocked: true, hard_hits: [], soft_hits: [] } };
  }
  const { draft: redacted, report } = scanDraft(draft);
  if (report.blocked) {
    return {
      ok: false,
      error: `secret_scan_blocked: ${report.hard_hits.map((h) => h.category).join(', ')}`,
      draft: redacted,
      report,
    };
  }
  return { ok: true, draft: redacted, report };
}

/**
 * POST a clean draft to the backend's existing F-078 `/publish-drafts` endpoint.
 *
 * Backend schema (from publish_drafts_routes.py DraftCreate):
 *   { kind: 'agent'|'memory_pack', slug, version?, draft_manifest, captured_context?, runtime_source? }
 *
 * Returns { id, state, ... } per existing endpoint contract. We compute the
 * dashboard_url client-side from the returned id.
 *
 * @param {object} opts
 * @param {string} opts.apiBase — e.g. https://awareness.market/api/v1
 * @param {string} opts.apiKey
 * @param {string} opts.memoryId
 * @param {object} opts.draft   — host-LLM-synthesized manifest (will be wrapped)
 * @param {object} [opts.context] — captured_context bundle (recent_cards, entities, etc.)
 * @param {string} [opts.runtimeSource]
 * @param {string} [opts.dashboardOrigin] defaults to derived from apiBase
 * @returns {Promise<{ draft_id: string, dashboard_url: string, state: string }>}
 */
export async function submitDraftToBackend({
  apiBase,
  apiKey,
  memoryId,
  draft,
  context,
  runtimeSource,
  dashboardOrigin,
}) {
  if (!apiBase) throw new Error('apiBase required');
  const url = `${apiBase.replace(/\/+$/, '')}/publish-drafts`;
  const body = {
    kind: draft.category === 'pack' ? 'memory_pack' : 'agent',
    slug: draft.slug,
    version: draft.version || null,
    draft_manifest: draft,
    captured_context: context || {},
    runtime_source: runtimeSource || 'local-daemon',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      ...(memoryId ? { 'X-Awareness-Memory-Id': memoryId } : {}),
      'X-Awareness-Source': runtimeSource || 'local-daemon',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`publish-drafts POST failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const origin = dashboardOrigin || deriveDashboardOrigin(apiBase);
  return {
    draft_id: data.id,
    dashboard_url: `${origin}/publish/${data.id}`,
    state: data.state || 'pending_review',
  };
}

function deriveDashboardOrigin(apiBase) {
  try {
    const u = new URL(apiBase);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://awareness.market';
  }
}

/**
 * High-level entry point: take what the host-LLM returned and ship it.
 * Daemon glue code that calls this is responsible for:
 *   - Detecting MCP `awareness_publish_agent` tool call
 *   - Capturing the host-LLM's manifest reply
 *
 * @param {object} opts
 * @param {object} opts.daemon
 * @param {object} opts.draft         — manifest produced by host-LLM
 * @param {string} opts.apiBase
 * @param {string} opts.apiKey
 * @param {string} opts.memoryId
 * @returns {Promise<{ ok: boolean, draft_id?: string, dashboard_url?: string, error?: string, report?: object }>}
 */
export async function handlePublishAgent({ daemon, draft, apiBase, apiKey, memoryId, context, runtimeSource }) {
  const review = reviewDraft(draft);
  if (!review.ok) {
    return { ok: false, error: review.error, report: review.report };
  }
  try {
    const r = await submitDraftToBackend({
      apiBase,
      apiKey,
      memoryId,
      draft: review.draft,
      context,
      runtimeSource: runtimeSource || daemon?.runtime || 'local-daemon',
    });
    return {
      ok: true,
      draft_id: r.draft_id,
      dashboard_url: r.dashboard_url,
      state: r.state,
      report: review.report,
    };
  } catch (e) {
    return { ok: false, error: e.message, report: review.report };
  }
}
