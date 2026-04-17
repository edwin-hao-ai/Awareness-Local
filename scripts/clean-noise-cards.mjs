#!/usr/bin/env node
/**
 * clean-noise-cards.mjs — one-shot audit of existing knowledge_cards.
 *
 * Re-runs the 0.7.3 noise filter against every active card's
 * title + summary. Any card whose content starts with agent-framework
 * metadata (Sender (untrusted metadata), turn_brief, [Operational
 * context metadata ...], etc.) — even wrapped in Request:/Result:/Send:
 * envelopes — is archived (status='archived', not deleted, so it can
 * be restored if the heuristic was too aggressive).
 *
 * Zero LLM calls. Idempotent. Reversible via
 *   UPDATE knowledge_cards SET status='active' WHERE status='archived' AND novelty_score IS NULL
 * if you want to undo.
 *
 * Usage:
 *   node sdks/local/scripts/clean-noise-cards.mjs [--db PATH] [--dry-run]
 *
 * Exits 0 regardless — reports counts on stdout.
 */
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { classifyNoiseEvent } from '../src/core/noise-filter.mjs';
import Database from 'better-sqlite3';

function parseArgs() {
  const args = { db: null, dryRun: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') { args.db = argv[++i]; }
    else if (argv[i] === '--dry-run') { args.dryRun = true; }
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node clean-noise-cards.mjs [--db PATH] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

/**
 * Find all candidate index.db files: ~/.awareness/index.db and any
 * project-local .awareness/index.db referenced by daemon recently.
 */
function discoverDatabases(explicitPath) {
  if (explicitPath) return [explicitPath];
  const candidates = [
    path.join(os.homedir(), '.awareness', 'index.db'),
  ];
  // Walk workspaces.json if present to pick up active project DBs.
  const wsPath = path.join(os.homedir(), '.awareness', 'workspaces.json');
  try {
    if (existsSync(wsPath)) {
      const fs = require('node:fs');
      const ws = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
      const entries = Array.isArray(ws) ? ws : (Array.isArray(ws?.workspaces) ? ws.workspaces : []);
      for (const w of entries) {
        const p = w?.projectDir || w?.path;
        if (p) {
          const candidate = path.join(p, '.awareness', 'index.db');
          if (existsSync(candidate)) candidates.push(candidate);
        }
      }
    }
  } catch {
    // best-effort discovery; ignore
  }
  return Array.from(new Set(candidates.filter((p) => existsSync(p))));
}

function cleanDb(dbPath, { dryRun }) {
  const db = new Database(dbPath, { readonly: dryRun });
  const cards = db.prepare(
    `SELECT id, title, summary, category, status FROM knowledge_cards WHERE status = 'active'`
  ).all();

  const victims = [];
  for (const card of cards) {
    const probe = [card.title || '', card.summary || ''].filter(Boolean).join('\n');
    if (!probe) continue;
    const reason = classifyNoiseEvent({ content: probe });
    if (reason) {
      victims.push({ id: card.id, title: card.title, category: card.category, reason });
    }
  }

  if (victims.length === 0) {
    console.log(`[clean] ${dbPath}: ${cards.length} active cards, 0 match noise filter ✅`);
    db.close();
    return { scanned: cards.length, archived: 0 };
  }

  console.log(`[clean] ${dbPath}: ${cards.length} active cards, ${victims.length} match noise filter`);
  for (const v of victims) {
    console.log(`  • [${v.category || '?'}] ${String(v.title || '').slice(0, 70)} → ${v.reason}`);
  }

  if (dryRun) {
    console.log(`[clean] DRY RUN — nothing written. Re-run without --dry-run to archive.`);
    db.close();
    return { scanned: cards.length, archived: 0, wouldArchive: victims.length };
  }

  const stmt = db.prepare(`UPDATE knowledge_cards SET status = 'archived' WHERE id = ?`);
  const archiveAll = db.transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  archiveAll(victims.map((v) => v.id));
  console.log(`[clean] archived ${victims.length} card(s) in ${dbPath}`);
  db.close();
  return { scanned: cards.length, archived: victims.length };
}

async function main() {
  const args = parseArgs();
  const dbs = discoverDatabases(args.db);

  if (dbs.length === 0) {
    console.error('[clean] no index.db found. Pass --db PATH explicitly.');
    process.exit(0);
  }

  console.log(`[clean] scanning ${dbs.length} database(s)${args.dryRun ? ' (DRY RUN)' : ''}:`);
  for (const db of dbs) console.log(`  - ${db}`);

  let totalScanned = 0;
  let totalArchived = 0;
  let totalWouldArchive = 0;
  for (const db of dbs) {
    try {
      const r = cleanDb(db, { dryRun: args.dryRun });
      totalScanned += r.scanned;
      totalArchived += r.archived;
      totalWouldArchive += r.wouldArchive || 0;
    } catch (err) {
      console.error(`[clean] ${db}: ${err.message}`);
    }
  }

  console.log(`\n[clean] DONE: scanned ${totalScanned}, ${args.dryRun ? `would archive ${totalWouldArchive}` : `archived ${totalArchived}`}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
