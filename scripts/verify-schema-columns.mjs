#!/usr/bin/env node
/**
 * L1 · Schema column parity guard.
 *
 * Purpose: catch the class of regression that caused 0.7.0/0.7.1 to break
 * every upgraded user's cloud sync. Commit 7bc6f0da introduced
 * `SELECT ... local_id ... FROM knowledge_cards` without any corresponding
 * `ALTER TABLE knowledge_cards ADD COLUMN local_id`, so old DBs raised
 * "no such column: local_id" on every sync tick.
 *
 * Approach: spin up an in-memory SQLite, run initSchema() to apply every
 * CREATE and ALTER in the production migration path, then verify that
 * each column referenced by the rest of the codebase actually exists.
 *
 * Keep this fast (<2s) and zero-dependency beyond better-sqlite3.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Indexer } from '../src/core/indexer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// Tables we guard. Keep the list narrow — false positives from dynamic SQL
// are more painful than missed checks on edge tables.
const GUARDED_TABLES = new Set([
  'knowledge_cards',
  'memories',
  'tasks',
  'skills',
  'graph_nodes',
  'graph_edges',
  'sessions',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.mjs$|\.cjs$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Parse SELECT/INSERT/UPDATE statements in a file and return
 * [{ table, columns: Set<string>, snippet, file, line }]. Extraction is
 * deliberately conservative: we only surface columns we can tie to a known
 * table to keep false positives low.
 */
function extractColumnRefs(file) {
  const text = readFileSync(file, 'utf-8');
  const refs = [];

  // Only scan within SQL-looking string literals (backtick templates or
  // single/double-quoted strings). Scanning raw source matches JS variable
  // assignments that happen to look like UPDATE ... SET, which blew up the
  // first draft of this guard with false positives.
  const literalRe = /`([\s\S]*?)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g;
  let lit;
  while ((lit = literalRe.exec(text))) {
    const body = lit[1] || lit[2] || lit[3] || '';
    // Quick sniff so we don't slow-scan every string in the repo.
    if (!/\b(SELECT|INSERT|UPDATE)\b/i.test(body)) continue;

    // 1. SELECT <cols> FROM <table> [<alias>] [JOIN ...]
    //    If there's a JOIN we can't cheaply attribute each column back to
    //    the right table, so we only accept columns that are either:
    //      - unqualified (no alias prefix), AND
    //      - the SELECT has no JOIN clause
    //    or
    //      - prefixed with the main table's alias explicitly.
    const selectRe = /SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?/gi;
    let m;
    while ((m = selectRe.exec(body))) {
      const table = m[2];
      if (!GUARDED_TABLES.has(table)) continue;
      const colList = m[1];
      if (colList.trim() === '*') continue;
      const alias = m[3] && /^(where|join|left|right|inner|outer|on|group|order|limit)$/i.test(m[3]) ? null : m[3] || null;
      const hasJoin = /\bJOIN\b/i.test(colList) || /\bJOIN\b/i.test(body.slice(m.index + m[0].length, m.index + m[0].length + 200));
      const columns = parseColumnList(colList, { tableAlias: alias, skipIfJoin: hasJoin });
      if (columns.size > 0) refs.push({ table, columns, file });
    }

    // 2. INSERT INTO <table> (<cols>)
    const insertRe = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]+)\)/gi;
    while ((m = insertRe.exec(body))) {
      const table = m[1];
      if (!GUARDED_TABLES.has(table)) continue;
      const columns = parseColumnList(m[2]);
      if (columns.size > 0) refs.push({ table, columns, file });
    }

    // 3. UPDATE <table> SET <col> = ...
    const updateRe = /UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+([\s\S]+?)(?:\s+WHERE\b|$)/gi;
    while ((m = updateRe.exec(body))) {
      const table = m[1];
      if (!GUARDED_TABLES.has(table)) continue;
      const columns = parseAssignColumns(m[2]);
      if (columns.size > 0) refs.push({ table, columns, file });
    }
  }

  return refs;
}

function parseColumnList(raw, opts = {}) {
  const cols = new Set();
  const { tableAlias, skipIfJoin } = opts;
  for (const part of raw.split(',')) {
    let name = part.trim();
    // Strip COALESCE/SUM/ROUND(... col ...) and AS aliases
    const asMatch = name.match(/\bAS\s+\w+\s*$/i);
    if (asMatch) name = name.slice(0, name.length - asMatch[0].length).trim();
    // Pull out the first identifier from inside parens if we have a call
    const callMatch = name.match(/\w+\s*\(\s*([^,)]+)/);
    if (callMatch) name = callMatch[1].trim();

    // Alias handling: only keep columns we can confidently attribute to the
    // target table. If there's a JOIN anywhere in the statement, only accept
    // explicit `mainAlias.col` hits and drop bare column references.
    const prefixMatch = name.match(/^(\w+)\.(\w+)$/);
    if (prefixMatch) {
      if (tableAlias && prefixMatch[1] === tableAlias) {
        name = prefixMatch[2];
      } else {
        continue; // prefix belongs to another JOINed table, skip
      }
    } else if (skipIfJoin) {
      continue; // bare name + JOIN → ambiguous
    }

    name = name.replace(/[`"\[\]]/g, '').trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
    if (name === 'excluded' || name === 'DISTINCT' || name === '1') continue;
    cols.add(name);
  }
  return cols;
}

function parseAssignColumns(raw) {
  const cols = new Set();
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1];
    if (['WHERE', 'AND', 'OR'].includes(name.toUpperCase())) continue;
    cols.add(name);
  }
  return cols;
}

function main() {
  // Indexer constructor already runs initSchema() + all migrations.
  const indexer = new Indexer(':memory:');
  const db = indexer.db;

  // Collect actual columns for each guarded table.
  const schema = new Map();
  for (const table of GUARDED_TABLES) {
    try {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all();
      if (rows.length === 0) continue;
      schema.set(table, new Set(rows.map((r) => r.name)));
    } catch {
      /* table missing, skip */
    }
  }

  if (schema.size === 0) {
    console.error('[verify-schema-columns] could not introspect any guarded table — aborting');
    process.exit(2);
  }

  const files = walk(SRC);
  const violations = [];
  for (const f of files) {
    // Don't lint the indexer itself — that's where the schema is defined.
    if (f.endsWith('/core/indexer.mjs')) continue;
    for (const ref of extractColumnRefs(f)) {
      const known = schema.get(ref.table);
      if (!known) continue;
      for (const col of ref.columns) {
        if (!known.has(col)) {
          violations.push({ ...ref, missing: col });
        }
      }
    }
  }

  if (violations.length === 0) {
    const summary = [...schema.entries()]
      .map(([t, cols]) => `${t}(${cols.size})`)
      .join(', ');
    console.log(`[verify-schema-columns] OK — ${schema.size} tables checked: ${summary}`);
    indexer.close();
    process.exit(0);
  }

  console.error(`[verify-schema-columns] FAIL — ${violations.length} missing-column references:`);
  for (const v of violations) {
    const rel = path.relative(ROOT, v.file);
    console.error(`  ${rel}: ${v.table}.${v.missing} not declared in CREATE/ALTER`);
  }
  console.error('\nFix: add an ALTER TABLE in initSchema() migration, or rename the reference.');
  indexer.close();
  process.exit(1);
}

main();
