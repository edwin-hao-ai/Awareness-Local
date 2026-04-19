#!/usr/bin/env node
/**
 * skill-dedup-cleanup.mjs
 *
 * Clean pre-F-058 skill duplicates in `.awareness/index.db` without
 * touching code. Before the UPSERT-by-name fix shipped (commit
 * 1bab7feb), same-name skill submissions INSERTed a new row every
 * time, so users ended up with chains like:
 *
 *     E2E diagnostic · publish SDK to npm   (kc_…1234)
 *     E2E diagnostic · publish SDK to npm   (kc_…5678)
 *
 * This script:
 *   1. Finds all name-groups with >1 active row.
 *   2. Picks the "canonical" row — most recent updated_at, tie-break
 *      by longer summary, then longer methods, then created_at desc.
 *   3. Uses the existing mergeSkill() to fold the other rows into the
 *      canonical one (methods de-duped + unioned, tags unioned, etc.).
 *   4. Archives the non-canonical rows (status='archived') — we DON'T
 *      delete, so recall + cloud-sync can still reference old ids.
 *
 * Usage:
 *   node scripts/skill-dedup-cleanup.mjs              # plan only (dry run)
 *   node scripts/skill-dedup-cleanup.mjs --apply      # commit changes
 *   node scripts/skill-dedup-cleanup.mjs --db <path>  # non-default DB
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mergeSkill } from '../src/daemon/skill-merge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveDbPath() {
  const flag = process.argv.indexOf('--db');
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  const candidates = [
    path.join(process.cwd(), '.awareness', 'index.db'),
    path.join(os.homedir(), '.openclaw', '.awareness', 'index.db'),
    path.join(os.homedir(), '.awareness', 'index.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No .awareness/index.db found. Pass --db <path> or run from a project root.');
}

const dbPath = resolveDbPath();
const apply = process.argv.includes('--apply');

console.log(`DB: ${dbPath}`);
console.log(`Mode: ${apply ? 'APPLY (changes will be committed)' : 'DRY RUN (planning only)'}\n`);

const DatabaseCtor = (await import('better-sqlite3')).default;
const db = new DatabaseCtor(dbPath);

const groups = db.prepare(`
  SELECT name, COUNT(*) AS n
  FROM skills
  WHERE status = 'active'
  GROUP BY name
  HAVING n > 1
  ORDER BY n DESC, name ASC
`).all();

if (groups.length === 0) {
  console.log('✅ No duplicate active skills found. Nothing to clean.');
  process.exit(0);
}

console.log(`Found ${groups.length} duplicate-name group(s):\n`);

let plannedMerges = 0;
let plannedArchives = 0;
const planTx = apply ? db.transaction(executePlan) : null;

function executePlan(rows) {
  for (const row of rows) db.exec(row);
}

const sqlStatements = [];
for (const g of groups) {
  const rows = db.prepare(`
    SELECT id, name, summary, methods, trigger_conditions, tags,
           source_card_ids, confidence, decay_score,
           usage_count, last_used_at, pinned, created_at, updated_at
    FROM skills
    WHERE name = ? AND status = 'active'
    ORDER BY
      CASE WHEN pinned = 1 THEN 0 ELSE 1 END,
      datetime(updated_at) DESC,
      length(COALESCE(summary, '')) DESC,
      length(COALESCE(methods, '')) DESC,
      datetime(created_at) DESC
  `).all(g.name);

  const canonical = rows[0];
  const others = rows.slice(1);

  console.log(`─── "${g.name}" · ${rows.length} rows ───`);
  console.log(`  Canonical:  ${canonical.id}  (decay=${canonical.decay_score ?? '?'}  summary=${(canonical.summary || '').length}ch)`);

  // Merge each "other" into a running merged state using mergeSkill.
  let merged = { ...canonical };
  for (const other of others) {
    const incoming = {
      summary: other.summary || '',
      methods: safeParse(other.methods),
      trigger_conditions: safeParse(other.trigger_conditions),
      tags: safeParse(other.tags),
      source_card_ids: safeParse(other.source_card_ids),
      confidence: other.confidence ?? 1.0,
    };
    const result = mergeSkill(merged, incoming);
    merged = {
      ...merged,
      summary: result.summary,
      methods: result.methods,
      trigger_conditions: result.trigger_conditions,
      tags: result.tags,
      source_card_ids: result.source_card_ids,
      confidence: result.confidence,
      decay_score: result.decay_score,
    };
    console.log(`  Fold ${other.id}  →  canonical  (summary=${(other.summary || '').length}ch  methods=${Array.isArray(incoming.methods) ? incoming.methods.length : 0})`);
    plannedArchives += 1;
  }
  plannedMerges += 1;

  const updateCanonical = `
    UPDATE skills SET
      summary = ${sqlEscape(merged.summary)},
      methods = ${sqlEscape(merged.methods)},
      trigger_conditions = ${sqlEscape(merged.trigger_conditions)},
      tags = ${sqlEscape(merged.tags)},
      source_card_ids = ${sqlEscape(merged.source_card_ids)},
      confidence = ${Number(merged.confidence) || 1.0},
      decay_score = ${Number(merged.decay_score) || 1.0},
      updated_at = '${new Date().toISOString()}'
    WHERE id = '${canonical.id}'
  `;
  sqlStatements.push(updateCanonical);

  for (const other of others) {
    sqlStatements.push(`
      UPDATE skills SET status = 'archived', updated_at = '${new Date().toISOString()}'
      WHERE id = '${other.id}'
    `);
  }
  console.log('');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Plan:`);
console.log(`  · ${plannedMerges} canonical skill(s) will be updated with merged content`);
console.log(`  · ${plannedArchives} duplicate row(s) will be set to status='archived'`);
console.log(`  · Zero rows deleted. Archived rows are recoverable.`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (apply) {
  console.log('\nApplying changes…');
  planTx(sqlStatements);
  console.log(`✅ Applied. Active duplicate count now:`);
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM skills WHERE status = 'active' GROUP BY name HAVING n > 1`).all();
  console.log(`   remaining duplicate groups: ${remaining.length}`);
} else {
  console.log('\nRe-run with --apply to commit. Nothing was changed.');
}

db.close();

// --- helpers ---
function safeParse(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
}

function sqlEscape(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
