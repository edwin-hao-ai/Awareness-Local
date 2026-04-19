#!/usr/bin/env node
/**
 * real-e2e-skill-extraction-eval.mjs
 *
 * End-to-end real-user simulation:
 *   1. Switch daemon to a fresh scratch project (empty skills table).
 *   2. Drive a multi-turn realistic conversation via `claude -p --continue`.
 *   3. After the last turn, count new skills extracted + score them with
 *      the 8-dim rubric (/40). This measures the FULL pipeline the real
 *      user sees: prompt injection → LLM emits insights.skills[] → daemon
 *      validates + inserts → rubric scores the outcome.
 *
 * Disclaimer: `claude -p --continue` spans turns in the same session, but
 * each call spawns a fresh process. Turns are chained by session id.
 *
 * Usage:
 *   node scripts/real-e2e-skill-extraction-eval.mjs
 *   node scripts/real-e2e-skill-extraction-eval.mjs --scenario=2
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scoreSkill } from './skill-quality-score.mjs';

const SCENARIO = Number(strArg('--scenario', '1'));
const SCRATCH = strArg('--scratch', `/tmp/skill-eval-${Date.now()}`);
const DAEMON = strArg('--daemon', 'http://localhost:37800');

function strArg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SCENARIOS = {
  1: {
    title: 'Publish @awareness-sdk/openclaw-memory to npm (complete workflow)',
    turns: [
      'I want to publish @awareness-sdk/openclaw-memory 0.6.16 to npm. My default npm registry is the China mirror which REJECTS publish. Walk me through the complete workflow: (1) what pre-flight checks to run, (2) the exact publish command including the flag to force official registry, (3) how to verify. Then remember this as a reusable skill for future publishes.',
      'Perfect — this should be saved as a reusable skill titled something like "Publish @awareness-sdk to npm · sync + publish + verify". Please record it now via the awareness-memory plugin so next time I can just call awareness_apply_skill.',
    ],
    expectedSkillKeywords: ['publish', 'npm'],
  },
  2: {
    title: 'Restart daemon + run skill/card quality reports after a data migration',
    turns: [
      'I just ran a large migration that added 100 new knowledge cards. How do I restart the awareness local daemon cleanly so the new data loads?',
      'Daemon is back up. How do I run the card quality rubric report against my real DB at ~/.openclaw/.awareness/index.db?',
      'Report showed R7 tag pass rate at 45%. What tool fixes weak tags on existing cards? And save this end-to-end workflow as a reusable skill.',
    ],
    expectedSkillKeywords: ['daemon', 'report', 'quality', 'card'],
  },
};

async function mcp(toolName, args = {}) {
  const resp = await fetch(`${DAEMON}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`MCP ${toolName}: ${JSON.stringify(json.error)}`);
  const txt = json.result?.content?.[0]?.text || '{}';
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

function runClaude(prompt, cwd, continueFlag) {
  return new Promise((resolve) => {
    const args = ['-p', prompt];
    if (continueFlag) args.unshift('--continue');
    args.push('--disallowedTools', 'Bash Edit Write MultiEdit', '--output-format', 'text');
    const started = Date.now();
    const proc = spawn('claude', args, { cwd });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout: out, stderr: err, latencyMs: Date.now() - started }));
    proc.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e), latencyMs: Date.now() - started }));
  });
}

async function countSkills() {
  const r = await mcp('awareness_lookup', { type: 'skills', limit: 100 });
  return r.skills?.length ?? (Array.isArray(r) ? r.length : 0);
}

async function listSkills() {
  const r = await mcp('awareness_lookup', { type: 'skills', limit: 100 });
  return r.skills || [];
}

async function main() {
  const scenario = SCENARIOS[SCENARIO];
  if (!scenario) throw new Error(`No scenario ${SCENARIO}`);

  console.log('── Real E2E Skill Extraction Eval ──────────────────');
  console.log(`Scenario:  ${scenario.title}`);
  console.log(`Scratch:   ${SCRATCH}`);
  console.log(`Daemon:    ${DAEMON}`);
  console.log('');

  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH, 'README.md'), `# Skill eval scratch\n\n${scenario.title}\n`);

  // Switch daemon to scratch project (fresh skill state)
  console.log('▶ Switching daemon project → scratch...');
  const switchResp = await fetch(`${DAEMON}/api/v1/workspace/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_dir: SCRATCH }),
  });
  console.log(`  switch status: ${switchResp.status}`);

  const skillsBefore = await countSkills();
  console.log(`  skills in scratch before:  ${skillsBefore}`);
  console.log('');

  // Drive the multi-turn session
  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    console.log(`\n[turn ${i + 1}/${scenario.turns.length}] ▶ ${turn.slice(0, 100)}...`);
    const r = await runClaude(turn, SCRATCH, i > 0);
    console.log(`  exit=${r.code}  ${(r.latencyMs / 1000).toFixed(1)}s`);
    const preview = r.stdout.slice(0, 300).replace(/\n/g, '\n  ');
    console.log(`  ${preview}`);
    if (r.stderr.trim()) console.log(`  stderr: ${r.stderr.slice(0, 150)}`);
    if (r.code !== 0) {
      console.log(`  ⚠️  turn failed — abort remaining turns`);
      break;
    }
  }

  // Give the daemon a beat to finish any fire-and-forget extraction
  console.log('\n▶ Waiting 8s for async skill extraction...');
  await new Promise((r) => setTimeout(r, 8000));

  const skills = await listSkills();
  const newSkills = skills.slice(-Math.max(1, skills.length - skillsBefore));
  console.log('');
  console.log(`── Extraction Result ────────────────────────────────`);
  console.log(`Skills before:  ${skillsBefore}`);
  console.log(`Skills after:   ${skills.length}`);
  console.log(`New skill(s):   ${skills.length - skillsBefore}`);

  if (skills.length === skillsBefore) {
    console.log('\n❌ NO new skill extracted — pipeline did not fire.');
    process.exit(2);
  }

  console.log('\n── Scoring new skills ──────────────────────────────');
  for (const s of newSkills) {
    const shape = {
      name: s.name,
      summary: s.summary || '',
      methods: typeof s.methods === 'string' ? JSON.parse(s.methods || '[]') : (s.methods || []),
      trigger_conditions: typeof s.trigger_conditions === 'string' ? JSON.parse(s.trigger_conditions || '[]') : (s.trigger_conditions || []),
      tags: typeof s.tags === 'string' ? JSON.parse(s.tags || '[]') : (s.tags || []),
    };
    const score = scoreSkill(shape);
    const tMatch = scenario.expectedSkillKeywords.every((kw) => String(shape.name).toLowerCase().includes(kw.toLowerCase()));
    console.log(`\n  📎 ${shape.name}`);
    console.log(`     summary: ${shape.summary.slice(0, 120)}…`);
    console.log(`     methods: ${shape.methods.length} steps`);
    console.log(`     tags:    ${shape.tags.join(', ')}`);
    console.log(`     SCORE:   ${score.total}/40  ${score.passed ? '✅ PASS (≥28)' : '❌ FAIL'}`);
    console.log(`     dims:    when=${score.scores.whenToUse} sum=${score.scores.summaryQuality} steps=${score.scores.stepCount} exec=${score.scores.stepExecutability} pitfall=${score.scores.pitfalls} verify=${score.scores.verification} grep=${score.scores.grepTitle} tags=${score.scores.topicTags}`);
    console.log(`     topic-match: ${tMatch ? '✅' : '❌'}`);
  }
  console.log('\n────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
