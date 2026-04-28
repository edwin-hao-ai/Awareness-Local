/**
 * Integration tests for wiki-write.mjs (F-082 Phase 0-3 end-to-end).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCardToWiki } from '../src/daemon/engine/wiki-write.mjs';

function freshDir(suffix = '') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-wiki-write-' + suffix));
}

test('writeCardToWiki: writes card .md with frontmatter + body', () => {
  const dir = freshDir('basic');
  const r = writeCardToWiki({
    awarenessDir: dir,
    card: {
      id: 'kc_001',
      category: 'decision',
      title: 'Pick pgvector',
      summary: 'We chose pgvector to avoid managing two databases.',
      topic: ['stripe-onboarding', 'vector-store-choice'],
      entities: ['pgvector', 'pinecone'],
      related: [],
      created_at: '2026-04-25T10:00:00Z',
    },
  });
  assert.equal(r.warnings.length, 0, `unexpected warnings: ${r.warnings.join('; ')}`);
  assert.match(r.cardAbsPath, /cards\/2026\/04\/2026-04-25-decision-pick-pgvector\.md$/);
  const text = fs.readFileSync(r.cardAbsPath, 'utf-8');
  assert.match(text, /^---\n/);
  assert.match(text, /id: kc_001/);
  assert.match(text, /topic: \[stripe-onboarding, vector-store-choice\]/);
  assert.match(text, /# Pick pgvector/);
  assert.match(text, /We chose pgvector/);
});

test('writeCardToWiki: creates topic pages with backlinks', () => {
  const dir = freshDir('topics');
  writeCardToWiki({
    awarenessDir: dir,
    card: {
      id: 'kc_002',
      category: 'decision',
      title: 'Use HMAC v2',
      summary: 'V1 had replay risk.',
      topic: ['stripe-onboarding'],
      created_at: '2026-04-25T11:00:00Z',
    },
  });
  const topicPath = path.join(dir, 'topics', 'stripe-onboarding.md');
  assert.ok(fs.existsSync(topicPath), 'topic page should be created');
  const text = fs.readFileSync(topicPath, 'utf-8');
  assert.match(text, /id: stripe-onboarding/);
  assert.match(text, /## Cards/);
  assert.match(text, /Use HMAC v2/);
  assert.match(text, /_decision_/);
});

test('writeCardToWiki: appends to journal under correct section', () => {
  const dir = freshDir('journal');
  writeCardToWiki({
    awarenessDir: dir,
    card: {
      id: 'kc_003',
      category: 'pitfall',
      title: 'Stripe webhook signature drifts',
      summary: 'Retry replay broke our verifier.',
      created_at: '2026-04-25T12:00:00Z',
    },
  });
  const journal = path.join(dir, 'journal', '2026-04-25.md');
  assert.ok(fs.existsSync(journal));
  const text = fs.readFileSync(journal, 'utf-8');
  assert.match(text, /## Pitfalls/);
  assert.match(text, /Stripe webhook signature drifts/);
});

test('writeCardToWiki: multiple cards same day → live-append journal', () => {
  const dir = freshDir('multi-journal');
  for (let i = 0; i < 3; i++) {
    writeCardToWiki({
      awarenessDir: dir,
      card: {
        id: `kc_${i}`,
        category: i === 0 ? 'decision' : i === 1 ? 'pitfall' : 'workflow',
        title: `Card ${i}`,
        summary: `Summary ${i}`,
        created_at: '2026-04-25T13:00:00Z',
      },
    });
  }
  const journal = path.join(dir, 'journal', '2026-04-25.md');
  const text = fs.readFileSync(journal, 'utf-8');
  assert.match(text, /Card 0/);
  assert.match(text, /Card 1/);
  assert.match(text, /Card 2/);
  // count card_count frontmatter
  assert.match(text, /card_count: 3/);
});

test('writeCardToWiki: bidirectional related links create skeleton', () => {
  const dir = freshDir('bidir');
  // Card A references Card B (which doesn't exist yet)
  writeCardToWiki({
    awarenessDir: dir,
    card: {
      id: 'kc_a',
      category: 'decision',
      title: 'Card A',
      summary: 'A.',
      related: ['2026-04-24-decision-card-b'],
      created_at: '2026-04-25T14:00:00Z',
    },
  });
  // Find the skeleton file Card B placeholder
  const cardsRoot = path.join(dir, 'cards');
  let foundSkeleton = null;
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('card-b.md')) foundSkeleton = full;
    }
  }
  walk(cardsRoot);
  assert.ok(foundSkeleton, 'skeleton file for related Card B should be created');
  const skText = fs.readFileSync(foundSkeleton, 'utf-8');
  assert.match(skText, /placeholder: true/);
  assert.match(skText, /Card A/, 'skeleton should contain backlink to Card A');
});

test('writeCardToWiki: refreshes INDEX.md and writes README.md once', () => {
  const dir = freshDir('index');
  writeCardToWiki({
    awarenessDir: dir,
    card: {
      id: 'kc_idx',
      category: 'decision',
      title: 'Test Card',
      summary: 'A summary.',
      topic: ['my-topic'],
      created_at: '2026-04-25T15:00:00Z',
    },
  });
  const index = path.join(dir, 'INDEX.md');
  const readme = path.join(dir, 'README.md');
  assert.ok(fs.existsSync(index));
  assert.ok(fs.existsSync(readme));
  const idxText = fs.readFileSync(index, 'utf-8');
  assert.match(idxText, /## Topics/);
  assert.match(idxText, /\[my-topic\]/);
  assert.match(idxText, /## Recent journal/);
  assert.match(idxText, /\[2026-04-25\]/);
  const rdText = fs.readFileSync(readme, 'utf-8');
  assert.match(rdText, /Awareness Memory · Your Wiki/);
});

test('writeCardToWiki: README is permanent (not overwritten)', () => {
  const dir = freshDir('readme-permanent');
  writeCardToWiki({
    awarenessDir: dir,
    card: { id: 'k1', category: 'decision', title: 'A', summary: 'a', created_at: '2026-04-25T16:00:00Z' },
  });
  const readme = path.join(dir, 'README.md');
  // User edits README
  fs.writeFileSync(readme, '# Custom user README\n');
  // Another card recorded
  writeCardToWiki({
    awarenessDir: dir,
    card: { id: 'k2', category: 'decision', title: 'B', summary: 'b', created_at: '2026-04-25T17:00:00Z' },
  });
  const after = fs.readFileSync(readme, 'utf-8');
  assert.match(after, /Custom user README/, 'user-edited README must not be overwritten');
});
