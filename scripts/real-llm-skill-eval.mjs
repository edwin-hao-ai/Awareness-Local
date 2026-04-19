#!/usr/bin/env node
/**
 * real-llm-skill-eval.mjs
 *
 * Real LLM end-to-end evaluation for the skill selection + execution loop.
 *
 * Flow (mimics how Claude Code / OpenClaw actually uses the system):
 *   1. GET /healthz + call awareness_init via MCP — receive active_skills[] TOC
 *   2. For each task prompt in the eval fixture:
 *      a. Send cloud /chat request with (system: awareness TOC, user: task)
 *      b. LLM returns either a skill_id or "none"
 *      c. Call awareness_apply_skill(skill_id) — receive hydrated methods + linked_cards
 *      d. Send second cloud /chat: given the hydrated skill, produce a shell plan
 *      e. Grade: (i) is the picked skill the expected one, (ii) does the plan
 *         contain the "critical commands" from the gold standard
 *   3. Emit scorecard: pick accuracy / exec fidelity / avg latency.
 *
 * Usage:
 *   node scripts/real-llm-skill-eval.mjs                  # full eval
 *   node scripts/real-llm-skill-eval.mjs --limit 3        # first 3 tasks
 *   node scripts/real-llm-skill-eval.mjs --daemon http://localhost:37800
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DAEMON = getArg('--daemon', 'http://localhost:37800');
const LIMIT = Number(getArg('--limit', '0')) || 0;

function getArg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function loadConfig() {
  const candidates = [
    path.join(process.cwd(), '.awareness', 'config.json'),
    path.join(os.homedir(), '.openclaw', '.awareness', 'config.json'),
    path.join(os.homedir(), '.awareness', 'config.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
  }
  throw new Error('No config.json found — daemon not initialized?');
}

const config = loadConfig();
if (!config.cloud?.enabled || !config.cloud?.api_key) {
  console.error('❌ Cloud disabled or missing api_key — cannot run real LLM eval.');
  process.exit(1);
}
const apiBase = config.cloud.api_base || 'https://awareness.market/api/v1';
const memoryId = config.cloud.memory_id;
const apiKey = config.cloud.api_key;

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
  if (json.error) throw new Error(`MCP ${toolName} failed: ${JSON.stringify(json.error)}`);
  const txt = json.result?.content?.[0]?.text || '{}';
  return JSON.parse(txt);
}

async function chat(messages) {
  const started = Date.now();
  const resp = await fetch(`${apiBase}/memories/${memoryId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ messages, max_tokens: 600 }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`chat HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw = typeof data === 'string' ? data
    : data?.content || data?.choices?.[0]?.message?.content || '';
  return { text: String(raw), latencyMs: Date.now() - started };
}

// Eval fixtures · tasks drawn from user's real recent work categories.
// expected: title keyword(s) the correct skill's name should contain (case-
// insensitive). 'none' means we expect LLM to pick nothing.
// critical: tokens the hydrated execution plan SHOULD mention if correctly
// grounded by the skill. Missing any = plan is ungrounded hallucination.
const FIXTURES = [
  {
    task: '我要发布 @awareness-sdk/local 0.9.3 到 npm，帮我规划步骤',
    expectedTitleWords: ['publish', 'npm'],
    criticalTokens: ['registry.npmjs.org', '--access public', 'CHANGELOG', 'npm view'],
  },
  {
    task: 'Push a new version of @awareness-sdk/openclaw-memory — bump from 0.6.15 to 0.6.16',
    expectedTitleWords: ['publish', 'npm'],
    criticalTokens: ['registry.npmjs.org', 'npm publish', 'npm view'],
  },
  {
    task: '需要把 sdks/openclaw 包推到 npm，步骤是什么？',
    expectedTitleWords: ['publish', 'npm'],
    criticalTokens: ['registry.npmjs.org', 'CHANGELOG'],
  },
  {
    task: 'I need to run dedup + re-clustering on the knowledge cards in my DB',
    expectedTitleWords: ['dedup', 'record'],
    criticalTokens: [],
  },
  {
    task: 'Refactor the cards and build a new Map-of-Content cluster view',
    expectedTitleWords: ['refactor', 'moc'],
    criticalTokens: [],
  },
  {
    task: '帮我今天午饭订个披萨',
    expectedTitleWords: ['__NONE__'],
    criticalTokens: [],
  },
  {
    task: 'Explain how transformers work',
    expectedTitleWords: ['__NONE__'],
    criticalTokens: [],
  },
];

function normalizeTitle(s) { return String(s || '').toLowerCase(); }

function scoreSkillPick(expectedWords, pickedTitle) {
  if (expectedWords.includes('__NONE__')) {
    return pickedTitle === null ? 'correct-none' : 'false-positive';
  }
  if (!pickedTitle) return 'false-negative';
  const t = normalizeTitle(pickedTitle);
  const hit = expectedWords.every((w) => t.includes(w.toLowerCase()));
  return hit ? 'correct' : 'wrong-skill';
}

function scorePlan(criticalTokens, planText) {
  if (criticalTokens.length === 0) return { score: 1, hits: [], misses: [] };
  const t = String(planText).toLowerCase();
  const hits = [];
  const misses = [];
  for (const tok of criticalTokens) {
    if (t.includes(String(tok).toLowerCase())) hits.push(tok);
    else misses.push(tok);
  }
  return { score: hits.length / criticalTokens.length, hits, misses };
}

async function main() {
  console.log('── Real LLM Skill Eval ──────────────────────────────────');
  console.log(`Daemon: ${DAEMON}`);
  console.log(`Cloud:  ${apiBase} · memory=${memoryId.slice(0, 8)}…`);

  const init = await mcp('awareness_init', { source: 'real-llm-eval' });
  const skills = init.active_skills || [];
  if (skills.length === 0) {
    console.error('❌ No active_skills in DB. Seed some skills first.');
    process.exit(1);
  }
  console.log(`Active skills: ${skills.length}`);
  console.log('');

  const toc = skills.map((s) => `- id: "${s.id}" · title: "${s.title}" · summary: ${String(s.summary || '').slice(0, 120)}`).join('\n');
  const systemMsg = `You are an agent choosing which reusable "skill" (stored procedure) best fits a user task.
Available skills:
${toc}

Rules:
- Respond with ONLY this JSON: {"skill_id":"<id or null>","reason":"<one sentence>"}
- If no skill is a strong match, return {"skill_id":null,"reason":"..."}
- Do NOT force-match — prefer null over a weak fit.`;

  const fixtures = LIMIT > 0 ? FIXTURES.slice(0, LIMIT) : FIXTURES;
  const results = [];

  for (const fix of fixtures) {
    console.log(`\n▶ Task: ${fix.task}`);
    let pick = { skill_id: null, reason: '' };
    let pickLatency = 0;
    try {
      const { text, latencyMs } = await chat([
        { role: 'system', content: systemMsg },
        { role: 'user', content: fix.task },
      ]);
      pickLatency = latencyMs;
      const m = text.match(/\{[\s\S]*\}/);
      if (m) pick = JSON.parse(m[0]);
    } catch (err) {
      console.log(`  ⚠ chat error: ${err.message}`);
    }

    const picked = skills.find((s) => s.id === pick.skill_id) || null;
    const pickVerdict = scoreSkillPick(fix.expectedTitleWords, picked?.title || null);
    console.log(`  Pick: ${picked?.title || '<none>'}  [${pickVerdict}]  (${pickLatency}ms)  reason: ${pick.reason?.slice(0, 80) || ''}`);

    let planVerdict = { score: 0, hits: [], misses: [] };
    let planLatency = 0;
    if (picked && fix.criticalTokens.length > 0) {
      try {
        const applied = await mcp('awareness_apply_skill', { skill_id: picked.id, context: fix.task });
        const hydrated = `Skill: ${applied.skill_name}\nSummary: ${applied.summary}\nSteps:\n${(applied.methods || []).map((s, i) => `${i+1}. ${s.description || s.name || JSON.stringify(s)}`).join('\n')}\nLinked cards:\n${(applied.linked_cards || []).map(c => `[${c.category}] ${c.title}: ${String(c.summary || '').slice(0, 200)}`).join('\n')}`;
        const { text, latencyMs } = await chat([
          { role: 'system', content: 'You are a shell-executing agent. Given a skill + task, output the exact commands you would run. Plain shell, no commentary. Under 300 chars.' },
          { role: 'user', content: `TASK: ${fix.task}\n\nSKILL CONTEXT:\n${hydrated}` },
        ]);
        planLatency = latencyMs;
        planVerdict = scorePlan(fix.criticalTokens, text);
        console.log(`  Plan exec score: ${(planVerdict.score * 100).toFixed(0)}%  hits: ${planVerdict.hits.join(',')}  misses: ${planVerdict.misses.join(',')}  (${planLatency}ms)`);
      } catch (err) {
        console.log(`  ⚠ apply/plan error: ${err.message}`);
      }
    }

    results.push({ task: fix.task, pickVerdict, planScore: planVerdict.score, pickLatency, planLatency });
  }

  console.log('\n── Scorecard ───────────────────────────────────────────');
  const total = results.length;
  const correct = results.filter((r) => r.pickVerdict === 'correct' || r.pickVerdict === 'correct-none').length;
  const wrong = results.filter((r) => r.pickVerdict === 'wrong-skill').length;
  const falsePos = results.filter((r) => r.pickVerdict === 'false-positive').length;
  const falseNeg = results.filter((r) => r.pickVerdict === 'false-negative').length;
  const avgPlan = results.filter((r) => r.planScore > 0).reduce((a, r) => a + r.planScore, 0)
    / Math.max(1, results.filter((r) => r.planScore > 0).length);
  const avgPickLatency = results.reduce((a, r) => a + r.pickLatency, 0) / total;
  console.log(`Skill pick accuracy:  ${correct}/${total}  (${(correct / total * 100).toFixed(0)}%)`);
  console.log(`  - correct:           ${correct}`);
  console.log(`  - wrong-skill:       ${wrong}`);
  console.log(`  - false-positive:    ${falsePos}  (picked skill for 'none' task)`);
  console.log(`  - false-negative:    ${falseNeg}  (picked nothing for a real task)`);
  console.log(`Avg plan exec fidelity: ${(avgPlan * 100).toFixed(0)}%  (critical-token coverage, excluding control tasks)`);
  console.log(`Avg pick latency:     ${avgPickLatency.toFixed(0)}ms`);
  console.log('────────────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
