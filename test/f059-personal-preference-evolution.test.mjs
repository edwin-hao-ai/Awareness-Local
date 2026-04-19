/**
 * F-059 · personal_preference evolution
 *
 * Verifies the 3-scenario lifecycle for preference-category cards:
 *
 *   S1 dedup        identical preference submitted twice → 2nd rejected
 *   S2 merge        refined preference (more detail, same tags) → merged
 *                   into existing card, summary contains both pieces
 *   S3 contradiction user changed their mind (divergent identity tags,
 *                    e.g. vim → zed) → old card superseded, new card
 *                    active with parent_card_id pointing back
 *
 * These scenarios exercise card-evolution.mjs::classifyCard's
 * personal-preference branch (PREFERENCE_CATEGORIES + hasDivergentIdentityTags).
 *
 * Runtime: talks to the local daemon on http://localhost:37800 so the
 * daemon must be running. The test switches to a per-scenario scratch
 * directory so it never pollutes the user's real DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DAEMON = 'http://localhost:37800';

async function mcp(name, args) {
  const r = await fetch(`${DAEMON}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const j = await r.json();
  for (const b of j.result.content) {
    try { return JSON.parse(b.text); } catch { /* next */ }
  }
  return null;
}

async function freshScratch() {
  const dir = `/tmp/f059-pref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/README.md`, 'f059 scratch');
  const r = await fetch(`${DAEMON}/api/v1/workspace/switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_dir: dir }),
  });
  if (!r.ok) throw new Error(`switch failed: ${r.status}`);
  await new Promise((r) => setTimeout(r, 300));
  return dir;
}

async function daemonAlive() {
  try {
    const r = await fetch(`${DAEMON}/healthz`);
    return r.ok;
  } catch { return false; }
}

test('F-059 · S1 identical personal_preference dedups', async (t) => {
  if (!(await daemonAlive())) { t.skip('daemon not running on 37800'); return; }
  await freshScratch();

  const pref = {
    category: 'personal_preference',
    title: 'Prefers vim as editor',
    summary: 'User prefers vim as primary editor for all coding tasks. Uses it for 10+ years. Extensive muscle memory with modal editing.',
    tags: ['editor', 'vim', 'preference'],
    novelty_score: 0.8, durability_score: 0.9, specificity_score: 0.8,
  };
  await mcp('awareness_record', { action: 'submit_insights', content: 'first', insights: { knowledge_cards: [pref], action_items: [], risks: [], skills: [] } });
  const r2 = await mcp('awareness_record', { action: 'submit_insights', content: 'second', insights: { knowledge_cards: [pref], action_items: [], risks: [], skills: [] } });

  const active = (await mcp('awareness_lookup', { type: 'knowledge', limit: 10, status: 'active' })).knowledge_cards || [];
  assert.equal(active.length, 1, 'exactly 1 active card after duplicate submit');
  assert.ok((r2.cards_skipped || []).length > 0, 'second submission should be recorded in cards_skipped');
});

test('F-059 · S2 refined personal_preference merges', async (t) => {
  if (!(await daemonAlive())) { t.skip('daemon not running on 37800'); return; }
  await freshScratch();

  const base = {
    category: 'personal_preference',
    title: 'Prefers vim as editor',
    summary: 'User prefers vim as primary editor for all coding. Uses it across projects.',
    tags: ['editor', 'vim'],
    novelty_score: 0.8, durability_score: 0.9, specificity_score: 0.8,
  };
  const refined = {
    category: 'personal_preference',
    title: 'Prefers vim as editor',
    summary: 'User prefers vim with tmux integration, custom .vimrc for Go and TypeScript, vim-plug plugin manager, neovim 0.10+. Prefers modal editing over IDEs.',
    tags: ['editor', 'vim', 'neovim', 'tmux'],
    novelty_score: 0.7, durability_score: 0.9, specificity_score: 0.9,
  };
  await mcp('awareness_record', { action: 'submit_insights', content: 'base', insights: { knowledge_cards: [base], action_items: [], risks: [], skills: [] } });
  await mcp('awareness_record', { action: 'submit_insights', content: 'refined', insights: { knowledge_cards: [refined], action_items: [], risks: [], skills: [] } });

  const active = (await mcp('awareness_lookup', { type: 'knowledge', limit: 10, status: 'active' })).knowledge_cards || [];
  assert.equal(active.length, 1, 'exactly 1 active card after merge');
  const s = active[0].summary.toLowerCase();
  assert.ok(
    s.includes('neovim') || s.includes('tmux'),
    'merged summary should carry refinement tokens (neovim/tmux)',
  );
});

test('F-059 · S3 contradictory personal_preference supersedes old', async (t) => {
  if (!(await daemonAlive())) { t.skip('daemon not running on 37800'); return; }
  await freshScratch();

  const oldPref = {
    category: 'personal_preference',
    title: 'Prefers vim as editor',
    summary: 'User prefers vim as primary editor for coding tasks with modal keybindings. Been using it for 10 years exclusively across all projects and environments.',
    tags: ['editor', 'vim'],
    novelty_score: 0.8, durability_score: 0.9, specificity_score: 0.8,
  };
  const newPref = {
    category: 'personal_preference',
    title: 'Switched from vim to Zed editor',
    summary: 'User has switched from vim to Zed editor as primary environment. Prefers Zed for native Rust performance, built-in AI assist, and collaborative features. No longer uses vim for daily work.',
    tags: ['editor', 'zed'],
    novelty_score: 0.9, durability_score: 0.8, specificity_score: 0.9,
  };
  await mcp('awareness_record', { action: 'submit_insights', content: 'old', insights: { knowledge_cards: [oldPref], action_items: [], risks: [], skills: [] } });
  await mcp('awareness_record', { action: 'submit_insights', content: 'new', insights: { knowledge_cards: [newPref], action_items: [], risks: [], skills: [] } });

  const active = (await mcp('awareness_lookup', { type: 'knowledge', limit: 10, status: 'active' })).knowledge_cards || [];
  const superseded = (await mcp('awareness_lookup', { type: 'knowledge', limit: 10, status: 'superseded' })).knowledge_cards || [];

  const vimSuperseded = superseded.find((c) => c.title.toLowerCase().includes('vim') && !c.title.toLowerCase().includes('zed'));
  const zedActive = active.find((c) => c.title.toLowerCase().includes('zed'));

  assert.ok(vimSuperseded, 'old vim preference should be superseded');
  assert.ok(zedActive, 'new Zed preference should be active');
  assert.ok(zedActive.parent_card_id, 'Zed card should carry parent_card_id pointing to old vim card');
});
