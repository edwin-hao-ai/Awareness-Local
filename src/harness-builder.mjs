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
 * Build the canonical <awareness-memory> XML block.
 * @param {object} ctx - Init context (from awareness_init response)
 * @param {object[]} [recallResults] - Recall search results
 * @param {object[]} [perceptionSignals] - Cached perception signals
 * @param {object} [options] - Additional options
 * @param {string} [options.recordRuleScript] - Path to save-memory.js (CC only)
 * @param {string} [options.localUrl] - Local daemon URL for dashboard
 * @returns {string}
 */
export function buildContextXml(ctx, recallResults, perceptionSignals, options = {}) {
  const esc = escapeXml;
  const parts = ["<awareness-memory>"];

  // --- Skills ---
  const skills = ctx.active_skills || [];
  if (skills.length > 0) {
    parts.push("  <skills>");
    for (const skill of skills) {
      parts.push(`    <skill title="${esc(skill.title || "")}">${esc(skill.summary || "")}</skill>`);
    }
    parts.push("  </skills>");
  }

  // --- Who You Are (user preferences with <pref> tags) ---
  const prefs = ctx.user_preferences || [];
  if (prefs.length > 0) {
    parts.push("  <who-you-are>");
    for (const p of prefs.slice(0, 15)) {
      const rule = (p.actionable_rule || "").trim();
      const content = rule ? esc(rule) : `${esc(p.title || "")}: ${esc(p.summary || "")}`;
      parts.push(`    <pref category="${esc(p.category || "")}">${content}</pref>`);
    }
    parts.push("  </who-you-are>");
  }

  // --- Last Sessions ---
  const sessions = (ctx.context || ctx).last_sessions || ctx.recent_sessions || [];
  if (sessions.length > 0) {
    parts.push("  <last-sessions>");
    for (const s of sessions.slice(0, 5)) {
      const date = esc(s.date || "");
      const events = s.event_count || s.memory_count || 0;
      const summary = esc((s.summary || "").slice(0, 300));
      parts.push(`    <session date="${date}" events="${events}">${summary}</session>`);
    }
    parts.push("  </last-sessions>");
  }

  // --- Recent Progress (daily narratives) ---
  const days = (ctx.context || ctx).recent_days || [];
  if (days.length > 0) {
    parts.push("  <recent-progress>");
    for (const day of days.slice(0, 7)) {
      const date = esc(day.date || "");
      const narrative = esc((day.narrative || "").slice(0, 500));
      if (narrative) {
        parts.push(`    <day date="${date}">${narrative}</day>`);
      }
    }
    parts.push("  </recent-progress>");
  }

  // --- Attention Protocol ---
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

  // --- Open Tasks ---
  const tasks = (ctx.context || ctx).open_tasks || [];
  if (tasks.length > 0) {
    parts.push("  <open-tasks>");
    for (const t of tasks.slice(0, 20)) {
      parts.push(`    <task priority="${esc(t.priority || "medium")}" status="${esc(t.status || "pending")}">${esc(t.title || "")}</task>`);
    }
    parts.push("  </open-tasks>");
  }

  // --- Knowledge Cards (actionable_rule preferred) ---
  const cards = (ctx.context || ctx).knowledge_cards || [];
  if (cards.length > 0) {
    parts.push("  <knowledge>");
    for (const c of cards.slice(0, 20)) {
      const rule = (c.actionable_rule || "").trim();
      let content;
      if (rule) {
        content = esc(rule);
      } else {
        content = `${esc(c.title || "")}: ${esc((c.summary || "").slice(0, 200))}`;
      }
      parts.push(`    <card category="${esc(c.category || "")}">${content}</card>`);
    }
    parts.push("  </knowledge>");
  }

  // --- Recall Results (with aha detection) ---
  if (recallResults && recallResults.length > 0) {
    parts.push("  <recall>");
    const now = Date.now();
    for (const r of recallResults.slice(0, 10)) {
      const score = r.score || 0;
      const content = esc((r.content || "").slice(0, 300));
      if (!content) continue;

      let daysAgo = 0;
      if (r.created_at) {
        try {
          daysAgo = Math.floor((now - new Date(r.created_at).getTime()) / 86400000);
        } catch { /* ignore */ }
      }

      if (score > 0.8 && daysAgo > 3) {
        parts.push(`    <aha score="${score.toFixed(2)}" days-ago="${daysAgo}">${content}</aha>`);
      } else {
        const scoreAttr = score ? ` score="${score.toFixed(2)}"` : "";
        parts.push(`    <result${scoreAttr}>${content}</result>`);
      }
    }
    parts.push("  </recall>");
  }

  // --- Perception Signals ---
  if (perceptionSignals && perceptionSignals.length > 0) {
    parts.push("  <perception>");
    parts.push("    <action-required>BEFORE responding to the user, you MUST address each signal below. "
      + "For contradictions: inform the user and ask if intentional. "
      + "For resonance: mention the related past experience. "
      + "For patterns: suggest a systematic fix. "
      + "For staleness: warn knowledge may be outdated. "
      + "For guards: STOP and warn about the known pitfall.</action-required>");
    for (const s of perceptionSignals.slice(0, 5)) {
      parts.push(`    <signal type="${esc(s.type || "")}">${esc(s.message || "")}</signal>`);
    }
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
