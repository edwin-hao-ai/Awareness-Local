#!/usr/bin/env node
/**
 * card-retag-propose.mjs
 *
 * Address the R7 weak-tag gap in a live daemon DB: user's 2026-04-19
 * snapshot showed 60% of 136 cards either had no tags or only generic
 * ones ('general'/'note'/'misc'). Tag-scoped recall misses half the
 * corpus.
 *
 * Strategy (zero-LLM, embedding-free first pass):
 *   1. Find "weak-tag" cards — tags empty OR all tags in GENERIC set
 *      OR fewer than MIN_SPECIFIC_TAGS specific tags.
 *   2. Propose replacement tags by extracting keyword candidates from
 *      title + summary: backticked tokens, file paths, CLI commands,
 *      ALL-CAPS acronyms, @scoped package names, and frequent nouns.
 *   3. Filter candidates against a curated stop-word list and keep the
 *      top 5.
 *   4. Write proposal CSV → user reviews → --apply commits via UPDATE.
 *
 * Usage:
 *   node scripts/card-retag-propose.mjs                    # plan (dry)
 *   node scripts/card-retag-propose.mjs --apply            # commit
 *   node scripts/card-retag-propose.mjs --min-score 3      # accept weaker
 *   node scripts/card-retag-propose.mjs --db <path>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIN_SPECIFIC_TAGS = 3;
const MAX_TAGS = 5;

const GENERIC = new Set([
  'general', 'misc', 'note', 'other', 'stuff', 'thing', 'test', 'debug',
  'data', 'tmp', 'temp', 'todo', 'fixme', 'work', 'item', 'task',
]);

// Very common English + Chinese filler words — anything matching these
// is dropped before ranking candidate tags.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of',
  'in', 'on', 'at', 'to', 'from', 'with', 'as', 'by', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'can', 'could', 'may', 'might', 'this', 'that',
  'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'you', 'he',
  'she', 'his', 'her', 'our', 'your', 'when', 'where', 'why', 'how', 'what',
  'which', 'who', 'whom', 'whose', 'get', 'use', 'set', 'new', 'old', 'same',
  'such', 'any', 'all', 'most', 'more', 'some', 'one', 'two', 'first', 'last',
  'also', 'only', 'very', 'still', 'just', 'about', 'over', 'after', 'before',
  '的', '了', '是', '在', '有', '和', '与', '或', '但', '我们', '你们', '他们',
  '这', '那', '这些', '那些', '会', '不', '也', '就', '都', '要', '可以', '没有',
]);

function resolveDb() {
  const flag = process.argv.indexOf('--db');
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  const candidates = [
    path.join(process.cwd(), '.awareness', 'index.db'),
    path.join(os.homedir(), '.openclaw', '.awareness', 'index.db'),
    path.join(os.homedir(), '.awareness', 'index.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No .awareness/index.db found. Pass --db <path>.');
}

function intArg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  return Number(process.argv[i + 1]) || def;
}

function parseTags(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

function countSpecific(tags) {
  return tags.filter((t) => {
    const s = String(t).toLowerCase().trim();
    return s.length >= 3 && !GENERIC.has(s);
  }).length;
}

/**
 * Extract candidate tags from title + summary. Ranked by:
 *   1. backticked or @scoped tokens (weight 3)
 *   2. file/path tokens (weight 2.5)
 *   3. ALL-CAPS acronyms ≥ 2 letters (weight 2)
 *   4. hyphenated words (weight 1.5)
 *   5. frequent lowercase nouns (weight 1, freq-based)
 */
function extractCandidates(title, summary) {
  const text = `${title} ${summary}`;
  const weighted = new Map();
  const bump = (tok, w) => {
    if (!tok) return;
    const norm = String(tok).toLowerCase().trim();
    if (norm.length < 3) return;
    if (STOP_WORDS.has(norm)) return;
    if (GENERIC.has(norm)) return;
    weighted.set(norm, (weighted.get(norm) || 0) + w);
  };

  // Backtick-wrapped tokens → treat as specific identifier
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const tok = m[1].split(/[^a-zA-Z0-9@/._\-]+/).find((s) => s.length >= 3);
    if (tok) bump(tok, 3);
  }

  // @scoped packages + slashed identifiers
  for (const m of text.matchAll(/@[\w-]+\/[\w-]+/g)) bump(m[0], 3);

  // file paths / extensions
  for (const m of text.matchAll(/[\w-]+\.(mjs|ts|tsx|js|py|json|md|sql|yml|yaml|sh|html)/g)) {
    bump(m[0], 2.5);
  }
  for (const m of text.matchAll(/[\w-]+\/[\w-]+\b/g)) bump(m[0], 2);

  // ALL-CAPS acronyms (2+ letters)
  for (const m of text.matchAll(/\b[A-Z]{2,}(?:[-_][A-Z0-9]+)*\b/g)) bump(m[0], 2);

  // hyphenated compound tokens — "pre-publish", "hybrid-search"
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}\b/g)) bump(m[0], 1.5);

  // fallback: frequent lowercase alpha tokens ≥ 4 chars
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9]{3,}/g)) bump(m[0], 0.5);

  const ranked = [...weighted.entries()]
    .filter(([tok]) => tok.length >= 3 && tok.length <= 32)
    .sort((a, b) => b[1] - a[1]);

  return ranked;
}

// --- main ---
const dbPath = resolveDb();
const apply = process.argv.includes('--apply');
const minScore = intArg('--min-score', 2);

console.error(`DB: ${dbPath}`);
console.error(`Mode: ${apply ? 'APPLY (changes will be committed)' : 'DRY RUN (planning only)'}`);
console.error(`Min candidate weight: ${minScore}  (raise to be pickier)\n`);

const Database = (await import('better-sqlite3')).default;
const db = new Database(dbPath);

const cards = db.prepare(`
  SELECT id, category, title, summary, tags
  FROM knowledge_cards
  WHERE status = 'active'
  ORDER BY created_at DESC
`).all();

const weak = [];
for (const c of cards) {
  const tags = parseTags(c.tags);
  if (countSpecific(tags) < MIN_SPECIFIC_TAGS) weak.push({ ...c, currentTags: tags });
}

console.log(`card_id,current_tag_count,specific_count,proposed_tags,title`);
let changedCount = 0;
const updates = [];

for (const c of weak) {
  const ranked = extractCandidates(c.title || '', c.summary || '');
  const proposed = ranked.filter(([, w]) => w >= minScore).slice(0, MAX_TAGS).map(([t]) => t);
  // Also keep any existing specific tag the caller already had.
  const existingSpecific = c.currentTags
    .map((t) => String(t).toLowerCase().trim())
    .filter((t) => t.length >= 3 && !GENERIC.has(t));
  const final = [...new Set([...existingSpecific, ...proposed])].slice(0, MAX_TAGS);

  if (final.length === 0) {
    console.log(`${c.id},${c.currentTags.length},${countSpecific(c.currentTags)},(none found — manual review),${JSON.stringify(c.title).slice(0, 70)}`);
    continue;
  }
  if (JSON.stringify(final) === JSON.stringify(existingSpecific)) continue; // no change

  console.log(`${c.id},${c.currentTags.length},${countSpecific(c.currentTags)},${final.join('|')},${JSON.stringify(c.title).slice(0, 70)}`);
  updates.push({ id: c.id, tags: final });
  changedCount += 1;
}

console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.error(`Total active cards:        ${cards.length}`);
console.error(`Weak-tag cards:            ${weak.length}  (${((weak.length / cards.length) * 100).toFixed(1)}%)`);
console.error(`Cards with a proposal:     ${changedCount}`);
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (apply) {
  console.error('\nApplying changes…');
  const stmt = db.prepare(`UPDATE knowledge_cards SET tags = ?, last_touched_at = ?, synced_to_cloud = 0 WHERE id = ?`);
  const tx = db.transaction((rows) => {
    for (const r of rows) stmt.run(JSON.stringify(r.tags), new Date().toISOString(), r.id);
  });
  tx(updates);
  console.error(`✅ Re-tagged ${updates.length} card(s). Cloud sync flag reset so changes will push next sync.`);
} else {
  console.error('\nRe-run with --apply to commit. Nothing was changed.');
}

db.close();
