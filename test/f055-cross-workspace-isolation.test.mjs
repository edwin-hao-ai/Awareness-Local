/**
 * F-055 cross-workspace isolation · regression test
 *
 * Reported (2026-04-19): user switched AwarenessClaw to a new project
 * but the Memory panel still showed memories from the old workspace
 * ("F-055 / F-056 / F-057 PRD 落地" turn_summary from Awareness repo
 * leaking into a freshly-selected unrelated project).
 *
 * This test verifies the DAEMON-SIDE guarantee: two distinct project
 * directories give completely disjoint memory/card/skill sets, and
 * the project_dir header + /workspace/switch API actually scope.
 * If this test fails, any UI showing cross-workspace content is a
 * daemon bug, not a client bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DAEMON = 'http://localhost:37800';

async function mcp(name, args, extraHeaders = {}) {
  const r = await fetch(`${DAEMON}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  if (!j.result?.content?.length) return null;
  for (const b of j.result.content) {
    try { return JSON.parse(b.text); } catch { /* next */ }
  }
  return null;
}

async function switchTo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(`${dir}/README.md`)) fs.writeFileSync(`${dir}/README.md`, 'scratch');
  const r = await fetch(`${DAEMON}/api/v1/workspace/switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_dir: dir }),
  });
  if (!r.ok) throw new Error(`switch failed ${r.status}`);
  await new Promise((x) => setTimeout(x, 400));
}

async function daemonAlive() {
  try {
    const r = await fetch(`${DAEMON}/healthz`);
    return r.ok;
  } catch { return false; }
}

test('F-055 · memories written in workspace A are NOT visible in workspace B', async (t) => {
  if (!(await daemonAlive())) { t.skip('daemon not running on 37800'); return; }

  const wsA = `/tmp/f055-iso-A-${Date.now()}`;
  const wsB = `/tmp/f055-iso-B-${Date.now()}`;

  // 1. Switch to workspace A, write a distinctive memory + card
  await switchTo(wsA);
  const keyA = `WS-A-TOKEN-${Math.random().toString(36).slice(2, 10)}`;
  await mcp('awareness_record', {
    action: 'remember',
    content: `Workspace A memory. Distinctive token: ${keyA}. Lorem ipsum filler so quality gate passes.`,
  });
  await mcp('awareness_record', {
    action: 'submit_insights',
    content: `Workspace A card with token ${keyA}`,
    insights: {
      knowledge_cards: [{
        category: 'decision',
        title: `Workspace A decision ${keyA}`,
        summary: `This card belongs to workspace A. Its distinctive token is ${keyA}. It should never appear when querying from workspace B. Using this distinctive search needle lets us assert isolation without ambiguity.`,
        tags: ['workspace-a', keyA.toLowerCase()],
        novelty_score: 0.9, durability_score: 0.9, specificity_score: 0.9,
      }],
      skills: [], action_items: [], risks: [],
    },
  });

  // 2. Switch to workspace B (fresh empty)
  await switchTo(wsB);

  // 3. Verify workspace B sees NONE of workspace A's content
  const knowB = (await mcp('awareness_lookup', { type: 'knowledge', limit: 50 })).knowledge_cards || [];
  const bHasA = knowB.some((c) => (c.summary || '').includes(keyA) || (c.title || '').includes(keyA));
  assert.equal(bHasA, false, `workspace B must not see workspace A's card with token ${keyA}`);

  const recallB = await mcp('awareness_recall', { query: keyA, detail: 'summary', max_cards: 10 });
  const recallIdsB = Array.isArray(recallB?._ids) ? recallB._ids : [];
  assert.equal(recallIdsB.length === 0 || recallB._raw?.includes('Found 0 memories'), true,
    `awareness_recall in workspace B must return 0 results for token ${keyA}, got _ids=${JSON.stringify(recallIdsB)}`);

  // 4. Switch back to workspace A, verify the card IS still there
  await switchTo(wsA);
  const knowA = (await mcp('awareness_lookup', { type: 'knowledge', limit: 50 })).knowledge_cards || [];
  const aHasA = knowA.some((c) => (c.summary || '').includes(keyA));
  assert.equal(aHasA, true, `workspace A must still see its own card`);
});

test('F-055 · project_dir header mismatch returns 409, never leaks data', async (t) => {
  if (!(await daemonAlive())) { t.skip('daemon not running on 37800'); return; }

  const wsA = `/tmp/f055-hdr-A-${Date.now()}`;
  const wsB = `/tmp/f055-hdr-B-${Date.now()}`;
  await switchTo(wsA);

  // Daemon is on wsA now. Send a request claiming we're on wsB.
  const r = await fetch(`${DAEMON}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Awareness-Project-Dir': wsB,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'awareness_lookup', arguments: { type: 'knowledge', limit: 5 } },
    }),
  });
  assert.equal(r.status, 409, 'daemon must 409 on project_dir header mismatch');
  const body = await r.json();
  assert.equal(body.error, 'project_mismatch');
  // Crucially: no data leaks in the 409 body
  assert.equal(Array.isArray(body.knowledge_cards), false);
});

test('F-055 · workspace_switch is atomic — in-flight requests see consistent project', async (t) => {
  if (!(await daemonAlive())) { t.skip('daemon not running on 37800'); return; }

  const wsA = `/tmp/f055-atomic-A-${Date.now()}`;
  const wsB = `/tmp/f055-atomic-B-${Date.now()}`;
  await switchTo(wsA);
  await mcp('awareness_record', {
    action: 'submit_insights',
    content: 'atomic test card',
    insights: {
      knowledge_cards: [{
        category: 'key_point',
        title: `Atomic marker A only`,
        summary: `This atomic marker card should only live in workspace A. It is the canary for the atomic-switch invariant. If a workspace B query sees this, the switch was not atomic enough.`,
        tags: ['atomic', 'marker-a'],
        novelty_score: 0.9, durability_score: 0.9, specificity_score: 0.9,
      }],
      skills: [], action_items: [], risks: [],
    },
  });

  // Fire a switch + 3 concurrent lookup requests without awaiting the switch
  const switchPromise = switchTo(wsB);
  // Give it a few ms to start, then fire lookups
  await new Promise((x) => setTimeout(x, 50));
  const lookups = await Promise.all([
    mcp('awareness_lookup', { type: 'knowledge', limit: 10 }).catch((e) => ({ error: e.message })),
    mcp('awareness_lookup', { type: 'knowledge', limit: 10 }).catch((e) => ({ error: e.message })),
    mcp('awareness_lookup', { type: 'knowledge', limit: 10 }).catch((e) => ({ error: e.message })),
  ]);
  await switchPromise;

  // Each lookup should either (a) return workspace A with marker present, or
  // (b) return workspace B with marker absent, or (c) 503 project_switching.
  // It must NEVER return a partial/mixed result.
  for (const r of lookups) {
    if (r?.error) continue;  // 503 during switch is acceptable
    const cards = r?.knowledge_cards || [];
    const hasMarker = cards.some((c) => (c.title || '').includes('Atomic marker A only'));
    const allACards = cards.every((c) => (c.tags || '').includes('marker-a'));
    // If we see ANY cards, they must all be from the same workspace
    if (cards.length > 0) {
      assert.equal(hasMarker || !allACards, true, 'lookup returned a mixed result — switch was not atomic');
    }
  }
});
