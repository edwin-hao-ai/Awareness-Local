#!/usr/bin/env node
/**
 * F-058 · Card quality report — reads a daemon's real SQLite database
 * and scores every knowledge card + skill against the F-056 quality
 * rubric (R1-R8), producing a summary the user can act on.
 *
 * This is the PRODUCT-LEVEL eval: the data comes from the user's own
 * LLM running the F-056 SSOT prompts in Claude Code / OpenClaw /
 * ClawHub. Our architecture is prompt-injection at the surface — we
 * embed prompts in every agent's session prompt so their LLM does the
 * extraction, then the daemon stores the result. This tool observes
 * the outcome and tells the user how well their agent-side extraction
 * is performing.
 *
 * No API key needed. No LLM call. Just runs checks over stored data.
 *
 * Usage:
 *   node scripts/card-quality-report.mjs                          # default project dir
 *   node scripts/card-quality-report.mjs --project=/path/to/proj  # specific
 *   node scripts/card-quality-report.mjs --format=json            # machine-readable
 *   node scripts/card-quality-report.mjs --limit=20               # show N worst cards
 *   node scripts/card-quality-report.mjs --source=openclaw-plugin # filter
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }
    return [a, 'true'];
  }),
);

const projectDir = argv.project || process.cwd();
const dbPath = path.join(projectDir, '.awareness', 'index.db');
const format = argv.format || 'text';
const worstLimit = Number.isFinite(+argv.limit) ? +argv.limit : 10;
const sourceFilter = argv.source || null;
const categoryFilter = argv.category || null;

if (!fs.existsSync(dbPath)) {
  console.error(`No daemon database at ${dbPath}`);
  console.error('Run `awareness-local start` first, or pass --project=/path/to/project.');
  process.exit(1);
}

let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.error('better-sqlite3 not installed — run `npm install` in sdks/local first.');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

// ---------------------------------------------------------------------------
// Quality rubric (R1-R8)
// ---------------------------------------------------------------------------

const PERSONAL_CATEGORIES = new Set([
  'personal_preference', 'important_detail', 'plan_intention',
  'activity_preference', 'health_info', 'career_info', 'custom_misc',
]);

const ENVELOPE_RE = /^\s*(?:Request|Result|Send|Received)\s*:|^\s*Sender\s*\(untrusted metadata\)|^\s*\[Operational context metadata|^\s*\[Subagent Context\]/i;
const PLACEHOLDER_RE = /\b(?:TODO|FIXME|lorem ipsum|example\.com|placeholder(?:[-_\s]|$))\b/i;

const STOP_TAGS = new Set([
  'general', 'note', 'notes', 'misc', 'fix', 'project', 'tech', 'dev',
  'a', 'b', 'c', '一般', '通用',
]);

const TITLE_DEAD_WORDS = new Set([
  'decision', 'decisions', 'made', 'bug', 'bugs', 'fixed', 'learned',
  'note', 'memo', 'update', 'change', 'fix', 'important', 'meta',
  'summary', 'notes', 'preference', 'hobby', 'background',
  '决定', '修复', '记录', '笔记', '重要', '更新',
  '決定', '記録', '重要',
]);

const TECH_SIGNAL_RE = [
  /`[^`]+`/,
  /\.[a-z]{2,5}\b/,
  /\$\d|¥\d|€\d|\b\d+(?:\.\d+)?%/,
  /\b\d+\.\d+\.\d+\b/,
  /\b[A-Z_]{4,}\b/,
  /\b(?:function|method|file|line|commit|PR|issue|url|endpoint|table|column|flag|command)\b/i,
];

// Heuristic: does the card content look like it mixes EN + CJK?
function isBilingualContent(summary) {
  const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff]/.test(summary);
  const latin = /[A-Za-z]{4,}/.test(summary);
  return cjk && latin;
}

function scoreCard(card) {
  const title = String(card.title || '').trim();
  const summary = String(card.summary || '').trim();
  const category = card.category;
  const tags = (() => {
    try { return JSON.parse(card.tags || '[]'); } catch { return []; }
  })();

  const isPersonal = PERSONAL_CATEGORIES.has(category);
  const minSummary = isPersonal ? 40 : 80;

  const r1 = summary.length >= minSummary;
  const r2 = summary !== title && summary.length > 0;
  const r3 = !ENVELOPE_RE.test(title) && !ENVELOPE_RE.test(summary);
  const r4 = !PLACEHOLDER_RE.test(summary);

  // R5 only applies to long summaries
  const r5_applies = summary.length >= 200;
  const r5 = r5_applies
    ? /(`[^`]+`|\*\*[^*]+\*\*|(?:^|\n)\s*[-*]\s|(?:^|\n)\s*\d+\.\s)/.test(summary)
    : true;

  // R6 — grep-friendly title
  const r6_applies = !isPersonal && category !== 'skill' && title.length >= 5;
  let r6 = true;
  if (r6_applies) {
    const tokens = title
      .split(/[\s\-_/,./:()`]+/)
      .filter((t) => t.length >= 3)
      .map((t) => t.toLowerCase());
    const concrete = tokens.filter((t) => !TITLE_DEAD_WORDS.has(t));
    r6 = concrete.length > 0;
  }

  // R7 — topic-specific tags
  const r7 = tags.length >= 1 && tags.every((t) => typeof t === 'string' && t.length >= 2 && !STOP_TAGS.has(t.toLowerCase()));

  // R8 — bilingual keyword diversity. Only relevant for cards whose
  // summary contains one language but covers a concept likely to exist
  // in the other. We only check: if bilingual content IS detected,
  // that's considered a pass. We don't penalise single-language cards.
  const r8 = true;
  const r8_info = isBilingualContent(summary);

  // Tech signal density in summary (proxy for retrieval-friendliness)
  const techSignals = TECH_SIGNAL_RE.filter((re) => re.test(summary)).length;

  const checks = { r1, r2, r3, r4, r5, r6, r7, r8 };
  const blocking = r1 && r2 && r3 && r4;              // R1-R4 are hard
  const recall_friendly = r6 && r7;                    // R6-R7 are recall signals
  const score = Object.values(checks).filter(Boolean).length;
  const maxScore = Object.keys(checks).length;

  return {
    id: card.id,
    title,
    category,
    source: card.source,
    tags,
    title_length: title.length,
    summary_length: summary.length,
    tags_count: tags.length,
    tech_signals: techSignals,
    bilingual: r8_info,
    checks,
    blocking_ok: blocking,
    recall_friendly_ok: recall_friendly,
    score,
    max_score: maxScore,
    score_pct: Math.round((score / maxScore) * 100),
  };
}

// ---------------------------------------------------------------------------
// Fetch cards
// ---------------------------------------------------------------------------

let cardQuery = `
  SELECT id, category, title, summary, tags, source, status, confidence,
         novelty_score, created_at
  FROM knowledge_cards
  WHERE status != 'superseded'
`;
const params = [];
if (sourceFilter) {
  cardQuery += ' AND source = ?';
  params.push(sourceFilter);
}
if (categoryFilter) {
  cardQuery += ' AND category = ?';
  params.push(categoryFilter);
}
cardQuery += ' ORDER BY created_at DESC';

const rows = db.prepare(cardQuery).all(...params);

const scored = rows.map(scoreCard);

// Skills table (separate — actual schema only has decay_score / confidence)
let skills = [];
try {
  skills = db.prepare(
    `SELECT id, name, summary, methods, trigger_conditions, tags, status,
            decay_score, confidence, usage_count, pinned, created_at
     FROM skills WHERE status = 'active' OR status IS NULL LIMIT 200`,
  ).all();
} catch (err) {
  // Skills table may not exist in older DBs — don't silently pretend 0.
  console.warn(`[card-quality-report] skills query failed: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Aggregate stats
// ---------------------------------------------------------------------------

function pct(num, denom) {
  return denom === 0 ? 0 : Math.round((num / denom) * 100);
}

const total = scored.length;
const agg = {
  total,
  r1_pass: pct(scored.filter((s) => s.checks.r1).length, total),
  r2_pass: pct(scored.filter((s) => s.checks.r2).length, total),
  r3_pass: pct(scored.filter((s) => s.checks.r3).length, total),
  r4_pass: pct(scored.filter((s) => s.checks.r4).length, total),
  r5_pass: pct(scored.filter((s) => s.checks.r5).length, total),
  r6_pass: pct(scored.filter((s) => s.checks.r6).length, total),
  r7_pass: pct(scored.filter((s) => s.checks.r7).length, total),
  blocking_ok: pct(scored.filter((s) => s.blocking_ok).length, total),
  recall_friendly_ok: pct(scored.filter((s) => s.recall_friendly_ok).length, total),
  avg_title_len: total ? Math.round(scored.reduce((s, r) => s + r.title_length, 0) / total) : 0,
  avg_summary_len: total ? Math.round(scored.reduce((s, r) => s + r.summary_length, 0) / total) : 0,
  avg_tags: total ? (scored.reduce((s, r) => s + r.tags_count, 0) / total).toFixed(1) : 0,
  avg_tech_signals: total ? (scored.reduce((s, r) => s + r.tech_signals, 0) / total).toFixed(1) : 0,
  bilingual_pct: pct(scored.filter((s) => s.bilingual).length, total),
};

const bySource = {};
const byCategory = {};
for (const s of scored) {
  const src = s.source || '(unknown)';
  const cat = s.category || '(unknown)';
  bySource[src] = bySource[src] || { total: 0, blocking_ok: 0, recall_ok: 0 };
  bySource[src].total++;
  if (s.blocking_ok) bySource[src].blocking_ok++;
  if (s.recall_friendly_ok) bySource[src].recall_ok++;
  byCategory[cat] = byCategory[cat] || { total: 0, recall_ok: 0 };
  byCategory[cat].total++;
  if (s.recall_friendly_ok) byCategory[cat].recall_ok++;
}

const worst = scored
  .filter((s) => !s.blocking_ok || !s.recall_friendly_ok)
  .sort((a, b) => a.score - b.score)
  .slice(0, worstLimit);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (format === 'json') {
  console.log(JSON.stringify({ agg, by_source: bySource, by_category: byCategory, worst, skills_count: skills.length }, null, 2));
} else {
  const bar = '━'.repeat(70);
  console.log(`\n${bar}`);
  console.log(`  Awareness Memory · Card Quality Report`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Filter: source=${sourceFilter || '*'}  category=${categoryFilter || '*'}`);
  console.log(`${bar}\n`);

  if (total === 0) {
    console.log('  No active cards found. Record some via Claude Code / OpenClaw / ClawHub first.\n');
    db.close();
    process.exit(0);
  }

  console.log(`  Total active cards: ${total}`);
  console.log(`  Skills: ${skills.length}\n`);

  console.log(`  ── Structural pass rates (R1-R5, daemon-enforced) ──`);
  console.log(`    R1 length OK             ${agg.r1_pass}% ${bar_graph(agg.r1_pass)}`);
  console.log(`    R2 no title/summary dup  ${agg.r2_pass}% ${bar_graph(agg.r2_pass)}`);
  console.log(`    R3 no envelope leak      ${agg.r3_pass}% ${bar_graph(agg.r3_pass)}`);
  console.log(`    R4 no placeholder tokens ${agg.r4_pass}% ${bar_graph(agg.r4_pass)}`);
  console.log(`    R5 Markdown (when ≥200)  ${agg.r5_pass}% ${bar_graph(agg.r5_pass)}`);
  console.log(`    All R1-R4 pass:          ${agg.blocking_ok}%`);

  console.log(`\n  ── Recall-friendliness (R6-R8, soft) ──`);
  console.log(`    R6 grep-friendly title   ${agg.r6_pass}% ${bar_graph(agg.r6_pass)}`);
  console.log(`    R7 topic-specific tags   ${agg.r7_pass}% ${bar_graph(agg.r7_pass)}`);
  console.log(`    Bilingual content        ${agg.bilingual_pct}% ${bar_graph(agg.bilingual_pct)}`);
  console.log(`    Recall-friendly (R6∧R7): ${agg.recall_friendly_ok}%`);

  console.log(`\n  ── Dimensions ──`);
  console.log(`    avg title length:   ${agg.avg_title_len} chars`);
  console.log(`    avg summary length: ${agg.avg_summary_len} chars`);
  console.log(`    avg tags per card:  ${agg.avg_tags}`);
  console.log(`    avg tech signals:   ${agg.avg_tech_signals} per summary`);

  console.log(`\n  ── By source ──`);
  for (const [src, s] of Object.entries(bySource).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `    ${src.padEnd(28)} ` +
      `n=${String(s.total).padStart(4)}  ` +
      `blocking=${String(pct(s.blocking_ok, s.total)).padStart(3)}%  ` +
      `recall-ok=${String(pct(s.recall_ok, s.total)).padStart(3)}%`,
    );
  }

  console.log(`\n  ── By category ──`);
  for (const [cat, s] of Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `    ${cat.padEnd(28)} ` +
      `n=${String(s.total).padStart(4)}  ` +
      `recall-ok=${String(pct(s.recall_ok, s.total)).padStart(3)}%`,
    );
  }

  if (worst.length > 0) {
    console.log(`\n  ── Worst ${worst.length} cards (lowest R1-R8 score) ──`);
    for (const w of worst) {
      const failed = Object.entries(w.checks).filter(([, v]) => !v).map(([k]) => k.toUpperCase()).join(',');
      console.log(
        `    [${w.score_pct.toString().padStart(3)}%] ${w.category.padEnd(20)}` +
        `  title(${w.title_length}): ${w.title.slice(0, 50)}`,
      );
      console.log(`           failed: ${failed || '(none)'}   tags=${JSON.stringify(w.tags)}`);
    }
    console.log('');
  }

  // Actionable guidance
  console.log(`\n  ── What to do ──`);
  if (agg.r6_pass < 60) {
    console.log(`    ⚠  R6 (grep-friendly title) pass rate ${agg.r6_pass}%. Many titles use`);
    console.log(`       generic words like "Decision made" / "Bug fixed" that cannot be`);
    console.log(`       retrieved by BM25 or embedding. Verify your agent is reading the`);
    console.log(`       latest SSOT prompts — update @awareness-sdk/openclaw-memory and`);
    console.log(`       @awareness-sdk/setup to 0.9.0+ for R6-R8 guidance.`);
  }
  if (agg.r7_pass < 60) {
    console.log(`    ⚠  R7 (topic-specific tags) pass rate ${agg.r7_pass}%. Many cards use`);
    console.log(`       stop-tags ("general", "note", "misc"). Re-tag or let new`);
    console.log(`       extractions replace them.`);
  }
  if (agg.blocking_ok < 95) {
    console.log(`    ⚠  Only ${agg.blocking_ok}% of cards pass R1-R4. The daemon would reject`);
    console.log(`       new cards with these issues — older cards predate the quality gate.`);
    console.log(`       Consider: node scripts/clean-noise-cards.mjs --dry-run`);
  }
  if (agg.r6_pass >= 70 && agg.r7_pass >= 70 && agg.blocking_ok >= 95) {
    console.log(`    ✅ Quality is healthy. Keep the prompts fresh by bumping SDK`);
    console.log(`       versions as they publish.`);
  }
  console.log('');
}

function bar_graph(pct) {
  const w = 20;
  const filled = Math.round((pct / 100) * w);
  return `[${'█'.repeat(filled)}${'░'.repeat(w - filled)}]`;
}

db.close();
