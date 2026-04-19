#!/usr/bin/env node
/**
 * skill-quality-report.mjs
 *
 * Score every active skill in the DB via the 8-dim Hermes rubric
 * (shared with server-side skill-quality-gate.mjs::computeQualityScore)
 * and produce:
 *   · a CSV to stdout for visual triage
 *   · an optional --apply flag that sets low-quality skills to
 *     status='needs_review' so active_skills injection skips them
 *     (via helpers.mjs: status='active' AND decay_score>0.3)
 *
 * Usage:
 *   node scripts/skill-quality-report.mjs                 # print report
 *   node scripts/skill-quality-report.mjs --mark-below 20 # also flag <20/40
 *                                                        # as needs_review
 *   node scripts/skill-quality-report.mjs --db <path>     # non-default DB
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scoreSkill } from './skill-quality-score.mjs';

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

function getFlag(name, defaultValue) {
  const i = process.argv.indexOf(name);
  if (i < 0) return defaultValue;
  return process.argv[i + 1];
}

const dbPath = resolveDb();
const markBelow = Number(getFlag('--mark-below', '0')) || 0;

console.error(`DB: ${dbPath}`);
if (markBelow > 0) console.error(`Will set status='needs_review' for any skill scoring < ${markBelow}/40`);
console.error('');

const Database = (await import('better-sqlite3')).default;
const db = new Database(dbPath);

const skills = db.prepare(`
  SELECT id, name, summary, methods, trigger_conditions, tags,
         decay_score, usage_count, status, created_at
  FROM skills
  WHERE status IN ('active', 'needs_review')
  ORDER BY created_at DESC
`).all();

function parseJson(v, fallback = []) {
  if (!v) return fallback;
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

const scored = skills.map((s) => {
  const shape = {
    name: s.name,
    summary: s.summary || '',
    methods: parseJson(s.methods),
    trigger_conditions: parseJson(s.trigger_conditions),
    tags: parseJson(s.tags),
  };
  return { id: s.id, status: s.status, decay: s.decay_score, usage: s.usage_count, shape, score: scoreSkill(shape) };
});

console.log('id,status,usage,decay,score_40,when,summary,steps,exec,pitfalls,verify,grep,tags,name');
for (const sc of scored) {
  const s = sc.score.scores;
  console.log([
    sc.id,
    sc.status,
    sc.usage ?? 0,
    (sc.decay ?? 1).toFixed(2),
    sc.score.total,
    s.whenToUse, s.summaryQuality, s.stepCount, s.stepExecutability,
    s.pitfalls, s.verification, s.grepTitle, s.topicTags,
    JSON.stringify(sc.shape.name).slice(0, 80),
  ].join(','));
}

const avg = scored.length ? (scored.reduce((a, s) => a + s.score.total, 0) / scored.length).toFixed(1) : 0;
const passing = scored.filter((s) => s.score.passed).length;
console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.error(`Total skills:  ${scored.length}`);
console.error(`Avg score:     ${avg}/40`);
console.error(`Pass rate:     ${passing}/${scored.length}  (bar: 28/40)`);
console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (markBelow > 0) {
  const toFlag = scored.filter((s) => s.score.total < markBelow && s.status === 'active');
  if (toFlag.length === 0) {
    console.error(`\nNo active skills below ${markBelow}/40. Nothing to flag.`);
  } else {
    console.error(`\nFlagging ${toFlag.length} skill(s) below ${markBelow}/40 as needs_review:`);
    for (const s of toFlag) console.error(`  - ${s.id}  (${s.score.total}/40)  ${JSON.stringify(s.shape.name).slice(0, 60)}`);

    const stmt = db.prepare(`UPDATE skills SET status = 'needs_review', updated_at = ? WHERE id = ?`);
    const tx = db.transaction((rows) => { for (const r of rows) stmt.run(new Date().toISOString(), r.id); });
    tx(toFlag);
    console.error(`\n✅ Marked ${toFlag.length} as needs_review. They will no longer appear in active_skills[] until rewritten.`);
  }
}

db.close();
