/**
 * Shared Harness Builder — canonical XML context format for Awareness Memory.
 * Used by both Claude Code skill (recall.js) and OpenClaw plugin (hooks.ts)
 * as fallback when server-side rendered_context is not available.
 *
 * Zero LLM. Pure template rendering.
 */

/**
 * Escape XML special characters.
 * @param {string} s
 * @returns {string}
 */
export function escapeXml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Extract keywords from user prompt for hybrid search.
 * Merges CC's basic extraction with OpenClaw's enhanced CJK support.
 * @param {string} text - User prompt text
 * @param {number} max - Maximum keywords to extract (default 8)
 * @returns {string[]}
 */
export function extractKeywords(text, max = 8) {
  if (!text || typeof text !== "string") return [];
  const kws = new Set();

  // Quoted strings (including smart quotes)
  for (const m of text.matchAll(/[""\u201c]([^"\u201d]{2,40})["\u201d]/g)) {
    kws.add(m[1].trim());
  }

  // File patterns (comprehensive: 20+ extensions)
  for (const m of text.matchAll(
    /[\w./-]+\.(py|js|ts|tsx|jsx|json|md|sql|go|rs|java|sh|yml|yaml|csv|xlsx|pdf|toml|cfg|conf|xml|html|css|txt|log|mjs|mts)\b/gi
  )) {
    kws.add(m[0]);
  }

  // UPPER_CASE constants
  for (const m of text.matchAll(/\b[A-Z][A-Z_]{2,}\b/g)) {
    kws.add(m[0]);
  }

  // camelCase / PascalCase identifiers
  for (const m of text.matchAll(/\b[a-z][a-zA-Z]{4,}\b/g)) {
    kws.add(m[0]);
  }

  // snake_case identifiers
  for (const m of text.matchAll(/\b[a-z]+_[a-z_]+\b/g)) {
    kws.add(m[0]);
  }

  // CJK names and titles (2-4 chars)
  for (const m of text.matchAll(/[\u4e00-\u9fff]{2,4}/g)) {
    kws.add(m[0]);
  }

  // Version numbers and issue references
  for (const m of text.matchAll(/[#vV]?\d[\d.,:-]+\w*/g)) {
    if (m[0].length > 1) kws.add(m[0]);
  }

  return [...kws].slice(0, max);
}

/**
 * Estimate token count for a string.
 * CJK chars ~1.5 chars/token, ASCII ~4 chars/token, mixed ~2.5.
 * @param {string} s
 * @returns {number}
 */
function estimateTokens(s) {
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

/**
 * Build a section's items, respecting a token budget.
 * Returns { lines: string[], tokens: number, count: number }.
 * Items are added in order (assumed pre-sorted by relevance) until budget is spent.
 * @param {object[]} items - Source items
 * @param {function} renderFn - (item) => string (the XML line)
 * @param {number} budget - Max tokens for this section
 * @returns {{ lines: string[], tokens: number, count: number }}
 */
function buildSection(items, renderFn, budget) {
  const lines = [];
  let tokens = 0;
  let count = 0;
  for (const item of items) {
    const line = renderFn(item);
    const cost = estimateTokens(line);
    if (tokens + cost > budget && count > 0) break; // always include at least 1
    lines.push(line);
    tokens += cost;
    count++;
  }
  return { lines, tokens, count };
}

// Default token budget and per-section allocation ratios.
// Sections with higher priority get their budget first; lower-priority sections
// share whatever remains. Total default: 20000 tokens.
const DEFAULT_TOKEN_BUDGET = 20000;
const SECTION_CONFIG = [
  // { key, priority (lower=higher), budgetRatio (share of total) }
  { key: 'perception', priority: 1, budgetRatio: 0.05 },
  { key: 'knowledge',  priority: 2, budgetRatio: 0.25 },
  { key: 'recall',     priority: 3, budgetRatio: 0.30 },
  { key: 'tasks',      priority: 4, budgetRatio: 0.10 },
  { key: 'prefs',      priority: 5, budgetRatio: 0.08 },
  { key: 'progress',   priority: 6, budgetRatio: 0.12 },
  { key: 'sessions',   priority: 7, budgetRatio: 0.10 },
];

/**
 * Build the canonical <awareness-memory> XML block.
 * Uses a token budget (default 20k) to dynamically control how many items
 * from each section are included. Content is never truncated — only the
 * number of items per section is adjusted to fit the budget.
 *
 * @param {object} ctx - Init context (from awareness_init response)
 * @param {object[]} [recallResults] - Recall search results
 * @param {object[]} [perceptionSignals] - Cached perception signals
 * @param {object} [options] - Additional options
 * @param {string} [options.recordRuleScript] - Path to save-memory.js (CC only)
 * @param {string} [options.localUrl] - Local daemon URL for dashboard
 * @param {number} [options.tokenBudget] - Max tokens for memory context (default 20000)
 * @returns {string}
 */
export function buildContextXml(ctx, recallResults, perceptionSignals, options = {}) {
  const esc = escapeXml;
  const totalBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
  const parts = ["<awareness-memory>"];

  // Fixed-cost sections (skills, attention, dashboard, record-rule) are small
  // and always included. We reserve ~500 tokens for them.
  const fixedReserve = 500;
  const dynamicBudget = totalBudget - fixedReserve;

  // --- Skills (always full, tiny) ---
  const skills = ctx.active_skills || [];
  if (skills.length > 0) {
    parts.push("  <skills>");
    for (const skill of skills) {
      parts.push(`    <skill title="${esc(skill.title || "")}">${esc(skill.summary || "")}</skill>`);
    }
    parts.push("  </skills>");
  }

  // --- Prepare all section data + renderers ---
  const sectionData = {
    perception: perceptionSignals || [],
    knowledge:  (ctx.context || ctx).knowledge_cards || [],
    recall:     recallResults || [],
    tasks:      (ctx.context || ctx).open_tasks || [],
    prefs:      ctx.user_preferences || [],
    progress:   ((ctx.context || ctx).recent_days || []).filter(d => d.narrative),
    sessions:   (ctx.context || ctx).last_sessions || ctx.recent_sessions || [],
  };

  const renderers = {
    perception: (s) =>
      `    <signal type="${esc(s.type || "")}">${esc(s.message || "")}</signal>`,
    knowledge: (c) => {
      const rule = (c.actionable_rule || "").trim();
      const content = rule ? esc(rule) : `${esc(c.title || "")}: ${esc(c.summary || "")}`;
      return `    <card category="${esc(c.category || "")}">${content}</card>`;
    },
    recall: (r) => {
      const score = r.score || 0;
      const content = esc(r.content || "");
      let daysAgo = 0;
      if (r.created_at) {
        try { daysAgo = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000); } catch {}
      }
      if (score > 0.8 && daysAgo > 3) {
        return `    <aha score="${score.toFixed(2)}" days-ago="${daysAgo}">${content}</aha>`;
      }
      const scoreAttr = score ? ` score="${score.toFixed(2)}"` : "";
      return `    <result${scoreAttr}>${content}</result>`;
    },
    tasks: (t) =>
      `    <task priority="${esc(t.priority || "medium")}" status="${esc(t.status || "pending")}">${esc(t.title || "")}</task>`,
    prefs: (p) => {
      const rule = (p.actionable_rule || "").trim();
      const content = rule ? esc(rule) : `${esc(p.title || "")}: ${esc(p.summary || "")}`;
      return `    <pref category="${esc(p.category || "")}">${content}</pref>`;
    },
    progress: (day) =>
      `    <day date="${esc(day.date || "")}">${esc(day.narrative || "")}</day>`,
    sessions: (s) => {
      const date = esc(s.date || "");
      const events = s.event_count || s.memory_count || 0;
      const summary = esc(s.summary || "");
      return `    <session date="${date}" events="${events}">${summary}</session>`;
    },
  };

  // --- Phase 1: build each section with its allocated budget ---
  const sectionResults = {};
  let usedTokens = 0;

  for (const cfg of SECTION_CONFIG) {
    const sectionBudget = Math.floor(dynamicBudget * cfg.budgetRatio);
    sectionResults[cfg.key] = buildSection(sectionData[cfg.key], renderers[cfg.key], sectionBudget);
    usedTokens += sectionResults[cfg.key].tokens;
  }

  // --- Phase 2: redistribute unused budget to high-priority sections that were cut ---
  let remaining = dynamicBudget - usedTokens;
  for (const cfg of SECTION_CONFIG) {
    if (remaining <= 200) break;
    const sr = sectionResults[cfg.key];
    if (sr.count >= sectionData[cfg.key].length) continue; // not truncated
    const rebuilt = buildSection(sectionData[cfg.key], renderers[cfg.key], sr.tokens + remaining);
    remaining -= (rebuilt.tokens - sr.tokens);
    sectionResults[cfg.key] = rebuilt;
  }

  // --- Render sections in display order ---
  if (sectionResults.prefs.lines.length > 0) {
    parts.push("  <who-you-are>");
    parts.push(...sectionResults.prefs.lines);
    parts.push("  </who-you-are>");
  }

  if (sectionResults.sessions.lines.length > 0) {
    parts.push("  <last-sessions>");
    parts.push(...sectionResults.sessions.lines);
    parts.push("  </last-sessions>");
  }

  if (sectionResults.progress.lines.length > 0) {
    parts.push("  <recent-progress>");
    parts.push(...sectionResults.progress.lines);
    parts.push("  </recent-progress>");
  }

  // --- Attention Protocol (fixed cost, always included) ---
  const attn = (ctx.context || ctx).attention_summary || ctx.attention_summary || {};
  const stale = attn.stale_tasks || 0;
  const risks = attn.high_risks || 0;
  const totalOpen = attn.total_open_tasks || 0;
  parts.push("  <attention-protocol>");
  parts.push(`    <summary stale_tasks="${stale}" high_risks="${risks}" total_open="${totalOpen}" />`);
  if (stale > 0 || risks > 0) {
    parts.push("    <instructions>");
    parts.push("      Review all open tasks and risks below. For stale tasks (pending > 3 days), remind the user or suggest completion/removal.");
    parts.push("      For high risks, warn the user before starting work. Update resolved items via awareness_record.");
    parts.push("    </instructions>");
  }
  parts.push("  </attention-protocol>");

  if (sectionResults.tasks.lines.length > 0) {
    parts.push("  <open-tasks>");
    parts.push(...sectionResults.tasks.lines);
    parts.push("  </open-tasks>");
  }

  if (sectionResults.knowledge.lines.length > 0) {
    parts.push("  <knowledge>");
    parts.push(...sectionResults.knowledge.lines);
    parts.push("  </knowledge>");
  }

  if (sectionResults.recall.lines.length > 0) {
    parts.push("  <recall>");
    parts.push(...sectionResults.recall.lines);
    parts.push("  </recall>");
  }

  if (sectionResults.perception.lines.length > 0) {
    parts.push("  <perception>");
    parts.push("    <action-required>BEFORE responding to the user, you MUST address each signal below. "
      + "For contradictions: inform the user and ask if intentional. "
      + "For resonance: mention the related past experience. "
      + "For patterns: suggest a systematic fix. "
      + "For staleness: warn knowledge may be outdated. "
      + "For guards: STOP and warn about the known pitfall.</action-required>");
    parts.push(...sectionResults.perception.lines);
    parts.push("  </perception>");
  }

  // --- Dashboard (local mode, optional) ---
  if (options.localUrl) {
    parts.push(`  <dashboard>Memory is running locally. View at ${esc(options.localUrl)}</dashboard>`);
  }

  // --- Record Rule (CC skill only, optional) ---
  if (options.recordRuleScript) {
    parts.push("  <record-rule>");
    parts.push(`    Save significant work SILENTLY: node "${esc(options.recordRuleScript)}" '<JSON>'`);
    parts.push('    JSON: {"content":"what+why","cards":[{"title":"...","summary":"...","category":"decision|problem_solution|workflow|pitfall|insight|key_point|personal_preference|important_detail"}]}');
    parts.push("    Save decisions, solutions, pitfalls, user preferences. NOT every tool call.");
    parts.push("  </record-rule>");
  }

  parts.push("</awareness-memory>");
  return parts.join("\n");
}

/**
 * Parse recall results from various response formats into a filtered array.
 * Handles: MCP text (JSON string), plain text, or JSON object with .results.
 * @param {object|string|null} recall - Raw recall response
 * @returns {object[]} Filtered results array
 */
export function parseRecallResults(recall) {
  if (!recall) return [];
  if (typeof recall === "string") {
    try {
      const parsed = JSON.parse(recall);
      return (parsed.results || parsed.items || []).filter(r => !r.score || r.score >= 0.4);
    } catch {
      if (recall.trim().length > 20) {
        return [{ content: recall.trim(), score: 0.5 }];
      }
      return [];
    }
  }
  return (recall.results || []).filter(r => !r.score || r.score >= 0.5);
}
