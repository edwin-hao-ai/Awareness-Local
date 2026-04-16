#!/usr/bin/env node
// @ts-nocheck
/**
 * backfill-to-cloud.mjs — Scan local knowledge_cards without cloud_id and
 * push them to the cloud with duplicate detection.
 *
 * Usage:
 *   node backfill-to-cloud.mjs [--dry-run|--apply]
 *     --memory-dir=~/.awareness  --api-base=URL  --api-key=KEY  --memory-id=ID
 *
 * Default mode is --dry-run.  Uses only Node.js built-in modules.
 */
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';

const LOG = '[backfill]';
const RATE_MS = 100; // 10 cards/sec
const TIMEOUT_MS = 15_000;
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// -- CLI -------------------------------------------------------------------
function parseArgs() {
  const argv = process.argv.slice(2);
  const o = { apply: false, memoryDir: path.join(os.homedir(), '.awareness'), apiBase: '', apiKey: '', memoryId: '' };
  for (const a of argv) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a.startsWith('--memory-dir=')) o.memoryDir = a.split('=')[1].replace(/^~/, os.homedir());
    else if (a.startsWith('--api-base='))  o.apiBase = a.split('=').slice(1).join('=').replace(/\/+$/, '');
    else if (a.startsWith('--api-key='))   o.apiKey = a.split('=').slice(1).join('=');
    else if (a.startsWith('--memory-id=')) o.memoryId = a.split('=').slice(1).join('=');
    else if (a === '-h' || a === '--help') {
      console.log('backfill-to-cloud [--dry-run|--apply] --memory-dir= --api-base= --api-key= --memory-id=');
      process.exit(0);
    }
  }
  return o;
}

// -- HTTP helper (matches cloud-sync.mjs pattern) --------------------------
/** @returns {Promise<{ status: number, body: string }>} */
export function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET', headers: opts.headers || {},
      timeout: opts.timeout ?? TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// -- Core logic (exported for testing) -------------------------------------
function parseTags(raw) {
  if (!raw) return [];
  try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(String); } catch {}
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

export function loadPendingCards(db) {
  return db.prepare(
    `SELECT id, category, title, summary, confidence, tags, source, version
     FROM knowledge_cards
     WHERE (cloud_id IS NULL OR cloud_id = '') AND status = 'active'
     ORDER BY created_at`
  ).all();
}

export async function fetchCloudCards(apiBase, memoryId, headers) {
  const url = `${apiBase}/memories/${encodeURIComponent(memoryId)}/cards/sync`;
  const res = await httpRequest(url, { method: 'GET', headers });
  if (res.status < 200 || res.status >= 300) return [];
  try { const d = JSON.parse(res.body); return Array.isArray(d) ? d : (d.cards || d.items || []); }
  catch { return []; }
}

/** Returns matching cloud card object or null/false. */
export function isDuplicate(local, cloudCards) {
  const lt = (local.title || '').toLowerCase().trim();
  const ls = (local.summary || '').toLowerCase().trim();
  if (!lt) return false;
  for (const cc of cloudCards) {
    if ((cc.title || '').toLowerCase().trim() === lt && (cc.summary || '').toLowerCase().trim() === ls) return cc;
  }
  return null;
}

export async function pushCard(apiBase, memoryId, headers, card, matchVersion) {
  const url = `${apiBase}/memories/${encodeURIComponent(memoryId)}/cards/sync`;
  const hdrs = { ...headers, 'Content-Type': 'application/json' };
  if (matchVersion != null) hdrs['If-Match'] = String(matchVersion);
  const payload = JSON.stringify({
    local_id: card.id, title: card.title || '', summary: card.summary || '',
    category: card.category || 'insight', confidence: card.confidence ?? 0.8,
    tags: parseTags(card.tags), source: card.source || 'local_backfill',
  });
  hdrs['Content-Length'] = String(Buffer.byteLength(payload));
  return httpRequest(url, { method: 'POST', headers: hdrs, body: payload });
}

/**
 * Run the backfill pipeline.
 * @returns {Promise<{ pushed:number, conflicts:number, skipped:number, errors:number }>}
 */
export async function runBackfill({ db, apply, apiBase, apiKey, memoryId, log: _log }) {
  const out = _log || ((c, m) => console.log(`${C[c] || ''}${m}${C.reset}`));
  const stats = { pushed: 0, conflicts: 0, skipped: 0, errors: 0 };
  const auth = { Authorization: `Bearer ${apiKey}`, 'X-Awareness-Api-Key': apiKey };

  const cards = loadPendingCards(db);
  out('dim', `${LOG} found ${cards.length} local cards without cloud_id`);
  if (!cards.length) return stats;

  let cloudCards = [];
  try {
    cloudCards = await fetchCloudCards(apiBase, memoryId, auth);
    out('dim', `${LOG} fetched ${cloudCards.length} cloud cards for comparison`);
  } catch (err) { out('yellow', `${LOG} cloud fetch failed: ${err.message} — skipping dedup`); }

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const dup = isDuplicate(card, cloudCards);
    if (dup) {
      stats.skipped++;
      out(apply ? 'yellow' : 'dim', `${LOG} ${i+1}/${cards.length} ${apply ? 'SKIP' : 'would_skip'} "${card.title}" — dup of ${dup.id}`);
      continue;
    }
    if (!apply) { out('cyan', `${LOG} ${i+1}/${cards.length} would_push "${card.title}"`); stats.pushed++; continue; }
    try {
      const res = await pushCard(apiBase, memoryId, auth, card, card.version ?? undefined);
      if (res.status >= 200 && res.status < 300) {
        let cid = null;
        try { cid = JSON.parse(res.body)?.id || JSON.parse(res.body)?.cloud_id; } catch {}
        const sql = cid
          ? 'UPDATE knowledge_cards SET cloud_id = ?, synced_to_cloud = 1 WHERE id = ?'
          : 'UPDATE knowledge_cards SET synced_to_cloud = 1 WHERE id = ?';
        db.prepare(sql).run(...(cid ? [cid, card.id] : [card.id]));
        stats.pushed++;
        out('green', `${LOG} ${i+1}/${cards.length} PUSHED "${card.title}"`);
      } else if (res.status === 409) {
        stats.conflicts++;
        out('yellow', `${LOG} ${i+1}/${cards.length} CONFLICT "${card.title}" — HTTP 409`);
      } else {
        stats.errors++;
        out('red', `${LOG} ${i+1}/${cards.length} ERROR "${card.title}" — HTTP ${res.status}`);
      }
    } catch (err) {
      stats.errors++;
      out('red', `${LOG} ${i+1}/${cards.length} ERROR "${card.title}" — ${err.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_MS));
  }
  return stats;
}

// -- Main (only when executed directly) ------------------------------------
async function main() {
  const opts = parseArgs();
  const dbPath = path.join(opts.memoryDir, 'index.db');
  const log = (c, m) => console.log(`${C[c] || ''}${m}${C.reset}`);
  log('bold', `${LOG} mode=${opts.apply ? 'APPLY' : 'DRY-RUN'} dir=${opts.memoryDir}`);
  if (opts.apply && (!opts.apiBase || !opts.apiKey || !opts.memoryId)) {
    log('red', `${LOG} --apply requires --api-base, --api-key, and --memory-id`);
    process.exit(1);
  }
  let db;
  try {
    const Sqlite = (await import('better-sqlite3')).default;
    db = new Sqlite(dbPath, { readonly: !opts.apply });
  } catch (err) { log('red', `${LOG} cannot open ${dbPath}: ${err.message}`); process.exit(1); }
  try {
    const s = await runBackfill({ db, apply: opts.apply, apiBase: opts.apiBase, apiKey: opts.apiKey, memoryId: opts.memoryId, log });
    log('bold', `\n${LOG} SUMMARY (${opts.apply ? 'APPLY' : 'DRY-RUN'})`);
    log('cyan', `  pushed=${s.pushed} conflicts=${s.conflicts} skipped=${s.skipped} errors=${s.errors}`);
    db.close();
    process.exit(s.errors > 0 ? 1 : 0);
  } catch (err) { log('red', `${LOG} FATAL: ${err.stack || err.message}`); db.close(); process.exit(1); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main();
