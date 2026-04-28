/**
 * Quick sanity script: simulate one awareness_record by calling writeCardToWiki
 * directly with a realistic payload, then list everything that was created.
 *
 * Usage: node test/wiki-write-e2e-sanity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCardToWiki } from '../src/daemon/engine/wiki-write.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-sanity-'));
console.log(`Sandbox: ${dir}\n`);

// Simulate 4 cards across the day
const cards = [
  {
    id: 'kc_001',
    category: 'decision',
    title: 'Pick pgvector over Pinecone',
    summary: 'Co-locating vectors with relational data eliminates the second-DB tax.',
    topic: ['stripe-onboarding', 'vector-store-choice'],
    entities: ['pgvector', 'pinecone'],
    related: [],
    created_at: '2026-04-25T09:30:00Z',
  },
  {
    id: 'kc_002',
    category: 'pitfall',
    title: 'Stripe webhook signature drifts on retry',
    summary: 'V1 HMAC reuses timestamp on retry; we built a verifier that checks both.',
    topic: ['stripe-onboarding'],
    entities: ['stripe', 'billing.py'],
    related: ['2026-04-25-decision-pick-pgvector-over-pinecone'],
    created_at: '2026-04-25T11:15:00Z',
  },
  {
    id: 'kc_003',
    category: 'workflow',
    title: 'Onboarding new merchant',
    summary: 'Step-by-step process: email → KYC → first webhook → activation.',
    topic: ['stripe-onboarding'],
    related: [],
    created_at: '2026-04-25T14:00:00Z',
  },
  {
    id: 'kc_004',
    category: 'insight',
    title: '记忆系统应该 markdown 优先',
    summary: '本地用户能 zip 文件夹完整带走记忆，是 vendor lock-in 的反向卖点。',
    topic: ['markdown-first-memory'],
    related: [],
    created_at: '2026-04-25T17:45:00Z',
  },
];

for (const c of cards) {
  const r = writeCardToWiki({ awarenessDir: dir, card: c });
  console.log(`  → ${r.slug}  (warnings: ${r.warnings.length})`);
}

console.log('\n=== Tree generated ===\n');
function walk(d, depth = 0) {
  if (depth > 5) return;
  for (const f of fs.readdirSync(d).sort()) {
    const full = path.join(d, f);
    const stat = fs.statSync(full);
    const indent = '  '.repeat(depth);
    if (stat.isDirectory()) {
      console.log(`${indent}${f}/`);
      walk(full, depth + 1);
    } else {
      console.log(`${indent}${f}  (${stat.size}B)`);
    }
  }
}
walk(dir);

console.log('\n=== INDEX.md ===\n');
console.log(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf-8'));

console.log('\n=== journal/2026-04-25.md ===\n');
console.log(fs.readFileSync(path.join(dir, 'journal', '2026-04-25.md'), 'utf-8'));

console.log('\n=== topics/stripe-onboarding.md ===\n');
console.log(fs.readFileSync(path.join(dir, 'topics', 'stripe-onboarding.md'), 'utf-8'));
