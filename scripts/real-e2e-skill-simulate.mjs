#!/usr/bin/env node
/**
 * real-e2e-skill-simulate.mjs
 *
 * Simulates the END of a realistic multi-turn CLI conversation by
 * emitting the exact awareness_record payload that Claude CLI / OpenClaw
 * would emit via its record-rule hook after producing the workflow
 * response. Then:
 *   · exercises the REAL inbound skill quality gate
 *     (validateSkillQuality + rubric)
 *   · stores in a fresh scratch project DB
 *   · scores the accepted skill with the 8-dim rubric /40
 *
 * This skips the 2-5 minute `claude -p` LLM roundtrip and tests the
 * daemon-side pipeline we just hardened (prompt → emit → gate → store).
 *
 * Usage:
 *   node scripts/real-e2e-skill-simulate.mjs
 *   node scripts/real-e2e-skill-simulate.mjs --bad   # emit a sloppy skill
 *                                                   # to verify the gate
 *                                                   # actually blocks junk
 */
import fs from 'node:fs';
import path from 'node:path';
import { scoreSkill } from './skill-quality-score.mjs';

const DAEMON = 'http://localhost:37800';
const BAD = process.argv.includes('--bad');
const SCRATCH = `/tmp/skill-sim-${Date.now()}`;

fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'README.md'), '# skill simulate scratch\n');

async function mcp(name, args = {}) {
  const resp = await fetch(`${DAEMON}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  const txt = json.result?.content?.[0]?.text || '{}';
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function main() {
  console.log('── Real E2E Skill Simulate ────────────────────────');
  console.log(`Scratch: ${SCRATCH}`);
  console.log(`Mode:    ${BAD ? 'BAD (junk skill — should be blocked)' : 'GOOD (follows new prompt rules)'}`);
  console.log('');

  // Switch to scratch so we don't pollute user DB
  const switchResp = await fetch(`${DAEMON}/api/v1/workspace/switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_dir: SCRATCH }),
  });
  console.log(`Project switch: ${switchResp.status}`);
  const before = await mcp('awareness_lookup', { type: 'skills', limit: 10 });
  const countBefore = (before.skills || []).length;
  console.log(`Skills before:  ${countBefore}`);

  // Transcript a real user might produce
  const transcript = [
    'I want to publish @awareness-sdk/openclaw-memory 0.6.16 to npm. My default registry is the China mirror (npmmirror) which REJECTS publish.',
    'Agent walked me through: (1) run sync-shared-scripts and sync-shared-prompts check, (2) bump version + CHANGELOG, (3) publish with explicit --registry=https://registry.npmjs.org/ and --access public, (4) verify with npm view.',
    'This was a complete workflow — save it as a reusable skill.',
  ].join('\n\n');

  const skillEmitted = BAD
    ? {
        name: 'publish stuff',
        summary: 'Just publish it.',
        methods: [
          { step: 1, description: 'bump version' },
          { step: 2, description: 'publish' },
        ],
        trigger_conditions: [{ pattern: 'publish', weight: 0.5 }],
        tags: ['general'],
        reusability_score: 0.7,
        durability_score: 0.7,
        specificity_score: 0.7,
      }
    : {
        name: 'Publish @awareness-sdk to npm · sync + publish + verify',
        summary:
          'Safe 4-step publish workflow for @awareness-sdk/* packages. **Why**: the default npm registry on dev machines is often set to the China mirror (`registry.npmmirror.com`) which accepts `install` but REJECTS `publish`, so `npm publish` will fail with `ENEEDAUTH ... requires you to be logged in to https://registry.npmmirror.com`. Always pass an explicit `--registry=https://registry.npmjs.org/` flag.',
        methods: [
          {
            step: 1,
            description:
              'Run `bash scripts/sync-shared-scripts.sh --check` and `node scripts/sync-shared-prompts.mjs --check` from repo root — both MUST exit 0 before publishing, else the npm package ships stale SSOT content.',
          },
          {
            step: 2,
            description:
              'Bump `sdks/<pkg>/package.json` version field + prepend an entry in `sdks/<pkg>/CHANGELOG.md` describing the user-visible change.',
          },
          {
            step: 3,
            description:
              'Run `npm publish --access public --registry=https://registry.npmjs.org/ --//registry.npmjs.org/:_authToken=$NPM_TOKEN` — the explicit --registry flag is mandatory to bypass the China mirror which rejects publish.',
          },
          {
            step: 4,
            description:
              'Verify with `npm view @awareness-sdk/<pkg> version --registry=https://registry.npmjs.org/` — must print the version you just bumped. Run `npm install @awareness-sdk/<pkg>@<version>` in a scratch dir to confirm it resolves.',
          },
        ],
        pitfalls: [
          'npmmirror rejects publish — must pass --registry=https://registry.npmjs.org/ explicitly; without it, command fails with ENEEDAUTH',
          'Scoped packages require --access public on first publish or the registry rejects with 402 Payment Required',
        ],
        verification: [
          '`npm view @awareness-sdk/<pkg> version --registry=https://registry.npmjs.org/` prints the new version',
          'Fresh `npm install @awareness-sdk/<pkg>@<version>` in /tmp succeeds',
        ],
        trigger_conditions: [
          { pattern: 'When publishing any @awareness-sdk/* package to npm', weight: 0.95 },
          { pattern: 'When bumping SDK version + shipping to npm registry', weight: 0.9 },
        ],
        tags: ['npm', 'publish', 'awareness-sdk', 'registry', 'release'],
        reusability_score: 0.95,
        durability_score: 0.9,
        specificity_score: 0.92,
      };

  console.log(`\n▶ Submitting skill: "${skillEmitted.name}"`);
  console.log(`  summary: ${skillEmitted.summary.length} chars`);
  console.log(`  methods: ${skillEmitted.methods.length}`);
  console.log(`  tags:    ${skillEmitted.tags.join(', ')}`);

  // Use `submit_insights` — this is the path that exercises the skill
  // quality gate + classifyCard + mergeSkill pipeline. `remember` would
  // only handle cards/tasks/risks, bypassing skill validation.
  const recordResp = await mcp('awareness_record', {
    action: 'submit_insights',
    content: transcript,
    insights: {
      skills: [skillEmitted],
      knowledge_cards: [],
      action_items: [],
      risks: [],
    },
  });

  console.log(`\n▶ awareness_record result:`);
  console.log(`  skills_created:  ${recordResp.skills_created ?? 0}`);
  console.log(`  skills_skipped:  ${(recordResp.skillsSkipped || recordResp.skills_skipped || []).length}`);
  const skipped = recordResp.skillsSkipped || recordResp.skills_skipped || [];
  for (const sk of skipped) {
    console.log(`    ✗ "${sk.name || sk.skill || ''}": ${sk.reason || (sk.reasons || []).join(', ')}`);
    if (sk.fix_suggestion) console.log(`      fix: ${sk.fix_suggestion}`);
  }

  const after = await mcp('awareness_lookup', { type: 'skills', limit: 10 });
  const afterSkills = after.skills || [];
  console.log(`\nSkills after:   ${afterSkills.length}`);

  if (afterSkills.length > countBefore) {
    const newSkill = afterSkills.find((s) => (s.name || '').startsWith(skillEmitted.name.split(' ')[0]))
      || afterSkills[afterSkills.length - 1];

    const shape = {
      name: newSkill.name,
      summary: newSkill.summary || '',
      methods: typeof newSkill.methods === 'string' ? JSON.parse(newSkill.methods || '[]') : (newSkill.methods || []),
      trigger_conditions: typeof newSkill.trigger_conditions === 'string' ? JSON.parse(newSkill.trigger_conditions || '[]') : (newSkill.trigger_conditions || []),
      tags: typeof newSkill.tags === 'string' ? JSON.parse(newSkill.tags || '[]') : (newSkill.tags || []),
    };
    const sc = scoreSkill(shape);
    console.log(`\n── Rubric Score ───────────────────────────────────`);
    console.log(`  ${shape.name}`);
    console.log(`  TOTAL: ${sc.total}/40  ${sc.passed ? '✅ PASS' : '❌ FAIL'} (bar 28/40)`);
    console.log(`  when=${sc.scores.whenToUse}/5  summary=${sc.scores.summaryQuality}/5  stepCount=${sc.scores.stepCount}/5  exec=${sc.scores.stepExecutability}/5`);
    console.log(`  pitfall=${sc.scores.pitfalls}/5  verify=${sc.scores.verification}/5  grep=${sc.scores.grepTitle}/5  tags=${sc.scores.topicTags}/5`);
  } else {
    console.log(`\n❌ No new skill stored.`);
  }

  // Also test apply_skill hydration
  if (afterSkills.length > countBefore && !BAD) {
    const newSkill = afterSkills[afterSkills.length - 1];
    console.log(`\n▶ Testing apply_skill hydration on new skill...`);
    const applied = await mcp('awareness_apply_skill', { skill_id: newSkill.id, context: 'ship 0.6.17' });
    console.log(`  name:           ${applied.skill_name}`);
    console.log(`  source_count:   ${applied.source_card_count}`);
    console.log(`  linked_cards:   ${(applied.linked_cards || []).length} hydrated`);
  }

  console.log('\n── Done ───────────────────────────────────────────');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
