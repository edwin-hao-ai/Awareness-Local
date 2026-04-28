/**
 * F-072 · Prompt Injector — host-LLM friendly context packer.
 *
 * The host agent LLM (Cursor/Copilot/Aider/Continue/any runtime that doesn't
 * natively speak MCP) calls `GET /api/v1/prompt/inject?q=...&limit=6` and
 * prepends the returned `markdown` to its own system prompt. The daemon never
 * sees the host's API key — the host LLM does the generation, we only provide
 * retrieved context as a ready-to-paste markdown block.
 *
 * Shape:
 *   {
 *     markdown: "...fenced markdown block, safe to paste...",
 *     card_count: <int>,
 *     estimated_tokens: <int>,
 *     query: <echoed>,
 *   }
 */
import { jsonResponse } from './helpers.mjs';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 16;
const DEFAULT_TOKEN_BUDGET = 4000;

function approxTokens(text) {
  // rough: 1 token ≈ 4 chars of English, 1 char for CJK → use midpoint
  return Math.ceil((text || '').length / 3);
}

function renderCard(c, idx) {
  const title = (c.title || c.snippet_title || 'Untitled').replace(/\n+/g, ' ').trim();
  const body = (c.summary || c.body || c.snippet || '').trim();
  const cat = c.category ? ` (${c.category})` : '';
  return `### ${idx + 1}. ${title}${cat}\n\n${body}\n`;
}

export async function apiPromptInject(daemon, _req, res, url) {
  const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const runtime = url.searchParams.get('runtime') || 'unknown';
  const limit = Math.max(
    1,
    Math.min(parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10), MAX_LIMIT),
  );
  const budget = Math.max(
    500,
    parseInt(url.searchParams.get('budget') || String(DEFAULT_TOKEN_BUDGET), 10),
  );

  if (!q) {
    return jsonResponse(res, {
      markdown: '',
      card_count: 0,
      estimated_tokens: 0,
      query: '',
      runtime,
      reason: 'empty query',
    });
  }

  let items = [];
  if (daemon.search && typeof daemon.search.unifiedCascadeSearch === 'function') {
    try {
      const out = await daemon.search.unifiedCascadeSearch(q, {
        tokenBudget: budget,
        limit,
      });
      items = Array.isArray(out?.results) ? out.results : Array.isArray(out) ? out : [];
    } catch (err) {
      console.error('[prompt-injector] cascade error:', err.message);
    }
  }
  if (items.length === 0 && daemon.indexer) {
    items = daemon.indexer.search(q, { limit }) || [];
  }

  items = items.slice(0, limit);

  const header = `# Relevant memory for: "${q}"\n\n_Injected by awareness-local · runtime=${runtime} · ${items.length} card(s)_\n\n`;
  let body = '';
  let truncatedAt = null;
  for (let i = 0; i < items.length; i++) {
    const chunk = renderCard(items[i], i);
    if (approxTokens(header + body + chunk) > budget) {
      truncatedAt = i;
      break;
    }
    body += chunk + '\n';
  }

  const markdown = items.length === 0
    ? `# No memory found for: "${q}"\n`
    : header + body + (truncatedAt !== null
      ? `\n_(truncated at card ${truncatedAt + 1} to stay under ${budget} tokens)_\n`
      : '');

  return jsonResponse(res, {
    markdown,
    card_count: truncatedAt ?? items.length,
    estimated_tokens: approxTokens(markdown),
    query: q,
    runtime,
    token_budget: budget,
  });
}
