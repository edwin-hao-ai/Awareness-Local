#!/usr/bin/env node
/**
 * real-llm-skill-eval-cli.mjs
 *
 * Real E2E eval: spawns `claude -p` (Claude Code CLI) with the awareness-memory
 * plugin already attached via MCP, so each run hits the REAL agent loop
 * (awareness_init → skill TOC injection → optional awareness_apply_skill →
 * answer). This is what actual users see — not a synthesized /chat completion.
 *
 * Flow per fixture:
 *   1. Spawn `claude -p "<task>" --append-system-prompt "<nudge to pick skill>"`
 *      in /Users/edwinhao/.openclaw (daemon's working dir so MCP config loads).
 *   2. Disable Bash/Write/Edit so the agent only PLANS, never executes.
 *   3. Capture stdout. Grade on:
 *        - did it name the expected skill (title keyword match), AND
 *        - did the output include the critical execution tokens the skill
 *          is supposed to teach (so we know the skill *grounded* the plan,
 *          instead of the model hallucinating a plausible answer).
 *
 * Usage:
 *   node scripts/real-llm-skill-eval-cli.mjs                # all fixtures
 *   node scripts/real-llm-skill-eval-cli.mjs --limit 2      # first 2
 *   node scripts/real-llm-skill-eval-cli.mjs --task 1       # only task index 1
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LIMIT = numArg('--limit', 0);
const TASK = numArg('--task', -1);
const CWD = strArg('--cwd', path.join(os.homedir(), '.openclaw'));

function strArg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function numArg(name, def) {
  const v = strArg(name, null);
  return v === null ? def : Number(v);
}

const FIXTURES = [
  {
    task: '我要发布 @awareness-sdk/local 0.9.3 到 npm，完整列出需要跑的命令',
    expectedTitleWords: ['publish', 'npm'],
    criticalTokens: ['registry.npmjs.org', 'npm publish', 'CHANGELOG'],
  },
  {
    task: 'Publish @awareness-sdk/openclaw-memory (bump from 0.6.15 to 0.6.16). List the exact shell commands I should run.',
    expectedTitleWords: ['publish', 'npm'],
    criticalTokens: ['registry.npmjs.org', 'npm publish', 'npm view'],
  },
  {
    task: '我要把知识卡片做 dedup + 重新聚类',
    expectedTitleWords: ['dedup', 'record'],
    criticalTokens: [],
  },
  {
    task: 'Refactor the knowledge cards and generate a fresh Map-of-Content clustering',
    expectedTitleWords: ['refactor', 'moc'],
    criticalTokens: [],
  },
  {
    task: '帮我今天午饭订个披萨',
    expectedTitleWords: ['__NONE__'],
    criticalTokens: [],
  },
  {
    task: 'Explain how transformers work in 3 sentences.',
    expectedTitleWords: ['__NONE__'],
    criticalTokens: [],
  },
];

function pickFixtures() {
  if (TASK >= 0) return [FIXTURES[TASK]].filter(Boolean);
  if (LIMIT > 0) return FIXTURES.slice(0, LIMIT);
  return FIXTURES;
}

function runClaude(task) {
  return new Promise((resolve) => {
    const args = [
      '-p', task,
      '--append-system-prompt',
      'You have access to an `awareness-memory` MCP. Before answering, check your active_skills list for any relevant "skill" (stored procedure) and, if one matches, invoke awareness_apply_skill to get its concrete steps. If no skill matches, say so and answer from your general knowledge.',
      '--disallowedTools', 'Bash Edit Write MultiEdit',
      '--output-format', 'text',
    ];
    const started = Date.now();
    const proc = spawn('claude', args, { cwd: CWD });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      resolve({
        code,
        stdout: out,
        stderr: err,
        latencyMs: Date.now() - started,
      });
    });
    proc.on('error', (e) => {
      resolve({ code: -1, stdout: '', stderr: String(e), latencyMs: Date.now() - started });
    });
  });
}

function gradePick(expectedWords, fullText) {
  const t = fullText.toLowerCase();
  if (expectedWords.includes('__NONE__')) {
    // success = the agent should NOT have called awareness_apply_skill or
    // referenced a stored skill by name
    const mentionedSkill = /apply_skill|stored procedure|skill:|skill "/i.test(fullText);
    return mentionedSkill ? 'false-positive' : 'correct-none';
  }
  const hit = expectedWords.every((w) => t.includes(w.toLowerCase()));
  return hit ? 'correct' : 'wrong-or-missing';
}

function gradeExec(criticalTokens, fullText) {
  if (criticalTokens.length === 0) return { score: 1, hits: [], misses: [] };
  const t = fullText.toLowerCase();
  const hits = [];
  const misses = [];
  for (const tok of criticalTokens) {
    if (t.includes(String(tok).toLowerCase())) hits.push(tok);
    else misses.push(tok);
  }
  return { score: hits.length / criticalTokens.length, hits, misses };
}

async function main() {
  const fixtures = pickFixtures();
  console.log('── Real Claude-CLI Skill Eval ────────────────────────');
  console.log(`CWD:     ${CWD}`);
  console.log(`Claude:  ${await which('claude')}`);
  console.log(`Tasks:   ${fixtures.length}`);
  console.log('');

  const results = [];
  for (let i = 0; i < fixtures.length; i++) {
    const fix = fixtures[i];
    console.log(`\n[${i + 1}/${fixtures.length}] ▶ ${fix.task}`);
    const r = await runClaude(fix.task);
    const pick = gradePick(fix.expectedTitleWords, r.stdout);
    const exec = gradeExec(fix.criticalTokens, r.stdout);
    console.log(`  exit=${r.code}  latency=${(r.latencyMs / 1000).toFixed(1)}s`);
    console.log(`  pick:  ${pick}  exec: ${(exec.score * 100).toFixed(0)}%  hits: [${exec.hits.join(', ')}] misses: [${exec.misses.join(', ')}]`);
    console.log(`  --- stdout (first 400 chars) ---`);
    console.log('  ' + r.stdout.slice(0, 400).replace(/\n/g, '\n  '));
    if (r.stderr.trim()) console.log(`  --- stderr ---\n  ${r.stderr.slice(0, 200)}`);
    results.push({ fix, r, pick, exec });
  }

  console.log('\n── Scorecard ─────────────────────────────────────────');
  const n = results.length;
  const correct = results.filter((x) => x.pick === 'correct' || x.pick === 'correct-none').length;
  const falsePos = results.filter((x) => x.pick === 'false-positive').length;
  const wrong = results.filter((x) => x.pick === 'wrong-or-missing').length;
  const execScored = results.filter((x) => x.fix.criticalTokens.length > 0);
  const avgExec = execScored.length
    ? execScored.reduce((a, x) => a + x.exec.score, 0) / execScored.length
    : 0;
  const avgLat = results.reduce((a, x) => a + x.r.latencyMs, 0) / n;
  console.log(`Skill pick accuracy:    ${correct}/${n}  (${((correct / n) * 100).toFixed(0)}%)`);
  console.log(`  - correct:             ${correct}`);
  console.log(`  - wrong-or-missing:    ${wrong}`);
  console.log(`  - false-positive:      ${falsePos}`);
  console.log(`Exec fidelity (critical-token coverage on real tasks): ${(avgExec * 100).toFixed(0)}%`);
  console.log(`Avg latency:            ${(avgLat / 1000).toFixed(1)}s`);
  console.log('──────────────────────────────────────────────────────');
}

function which(binName) {
  return new Promise((resolve) => {
    const p = spawn('which', [binName]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => resolve(out.trim()));
  });
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
