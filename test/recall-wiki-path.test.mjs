/**
 * F-083 Phase 4 · recall response decorates each summary with wiki_path
 * so agents can WebFetch the canonical markdown file.
 *
 * The decoration is purely computed (deterministic slug rule) so no DB
 * schema change is needed; older clients ignore the new field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecallSummaryContent } from '../src/daemon/mcp-contract.mjs';
import { resolveCardPath } from '../src/core/markdown-tree.mjs';

test('buildRecallSummaryContent: includes wiki_path in human text + JSON meta', () => {
  const summaries = [
    {
      id: 'kc_001',
      title: 'Pick pgvector',
      category: 'decision',
      created_at: '2026-04-25T10:00:00Z',
      summary: 'Co-locating vectors with relational data wins.',
      wiki_path: 'cards/2026/04/2026-04-25-decision-pick-pgvector.md',
    },
    {
      id: 'kc_002',
      title: 'Webhook drift',
      category: 'pitfall',
      created_at: '2026-04-25T11:00:00Z',
      summary: 'V1 retries reuse stale timestamp.',
      wiki_path: 'cards/2026/04/2026-04-25-pitfall-webhook-drift.md',
    },
  ];

  const out = buildRecallSummaryContent(summaries, 'local');
  const text = out.content[0].text;
  const json = JSON.parse(out.content[1].text);

  // Human-readable text mentions the wiki paths
  assert.match(text, /📄 cards\/2026\/04\/2026-04-25-decision-pick-pgvector\.md/);
  assert.match(text, /📄 cards\/2026\/04\/2026-04-25-pitfall-webhook-drift\.md/);

  // JSON meta carries _wiki_paths array aligned with _ids
  assert.deepEqual(json._ids, ['kc_001', 'kc_002']);
  assert.deepEqual(json._wiki_paths, [
    'cards/2026/04/2026-04-25-decision-pick-pgvector.md',
    'cards/2026/04/2026-04-25-pitfall-webhook-drift.md',
  ]);
  assert.match(json._hint, /_wiki_paths/);
});

test('buildRecallSummaryContent: missing wiki_path → null in array (backward-compat)', () => {
  const summaries = [
    { id: 'kc_legacy', title: 'old card', summary: 'no wiki_path' },
  ];
  const out = buildRecallSummaryContent(summaries, 'local');
  const json = JSON.parse(out.content[1].text);
  assert.deepEqual(json._wiki_paths, [null]);
  // Human text should NOT have the 📄 line if path is missing
  assert.doesNotMatch(out.content[0].text, /📄/);
});

test('resolveCardPath stays consistent with what recall computes (round-trip)', () => {
  // Simulates the decoration logic in buildRecallResult.
  const card = {
    title: 'Pick pgvector',
    category: 'decision',
    created_at: '2026-04-25T10:00:00Z',
  };
  const r = resolveCardPath('', card);
  assert.equal(r.relPath, 'cards/2026/04/2026-04-25-decision-pick-pgvector.md');
});
