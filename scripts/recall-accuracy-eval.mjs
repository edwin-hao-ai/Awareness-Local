#!/usr/bin/env node
/**
 * recall-accuracy-eval.mjs
 *
 * Zero-LLM, deterministic retrieval quality benchmark for awareness_recall.
 *
 * Seeds a scratch project with a fixed set of fixture cards, then issues
 * known queries whose expected top-3 cards are hand-labelled. Measures:
 *
 *   - Recall@3      — fraction of queries where ALL golden cards are in top-3
 *   - Recall@1      — fraction of queries where the TOP card is a golden
 *   - MRR           — mean reciprocal rank of the FIRST golden hit
 *   - NDCG@3        — discounted gain with graded relevance
 *
 * The eval runs hybrid search (BM25 + embedding + optional cross-encoder
 * rerank) via the same MCP call real clients use, so the score is a
 * faithful signal of what Claude / OpenClaw will see at runtime.
 *
 * Usage:
 *   node scripts/recall-accuracy-eval.mjs
 *   node scripts/recall-accuracy-eval.mjs --keep-scratch  # don't switch back
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KEEP = process.argv.includes('--keep-scratch');
const USE_HYDE = process.argv.includes('--hyde');
const DAEMON = 'http://localhost:37800';

async function mcp(name, args = {}) {
  const r = await fetch(`${DAEMON}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const json = await r.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  // Most tools return a single JSON-string content block; awareness_recall
  // returns a human-readable block + a second _ids meta block. Pick the
  // first block that parses as JSON.
  for (const block of json.result.content) {
    if (!block.text) continue;
    try { return JSON.parse(block.text); } catch { /* try next */ }
  }
  return { _raw: json.result.content.map((c) => c.text).join('\n') };
}

async function switchProject(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# recall-eval scratch\n');
  const r = await fetch(`${DAEMON}/api/v1/workspace/switch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_dir: dir }),
  });
  if (!r.ok) throw new Error(`workspace switch failed: ${r.status}`);
}

// ---- Fixtures · 12 cards covering distinct topics ----------------------
// Each tagged with a local key so queries can reference "golden" cards.
const CARDS = [
  { key: 'NPM_PUBLISH_MIRROR', category: 'problem_solution',
    title: 'npm publish fails with ENEEDAUTH on China mirror',
    summary: 'Problem: `npm publish` of @awareness-sdk/* packages fails with `ENEEDAUTH` when the developer machine default npm registry is set to `https://registry.npmmirror.com`. Root cause: the mirror accepts `install` but rejects `publish` with a 401. Fix: pass an explicit `--registry=https://registry.npmjs.org/` flag on every publish command. Verification: `npm view @awareness-sdk/<pkg> version --registry=https://registry.npmjs.org/` should return the bumped version.',
    tags: ['npm', 'publish', 'registry', 'china-mirror'] },
  { key: 'SCOPED_ACCESS_PUBLIC', category: 'pitfall',
    title: 'Scoped npm packages need --access public on first publish',
    summary: 'Publishing a `@awareness-sdk/*` scoped package without `--access public` fails with `402 Payment Required` — npm defaults scoped packages to private. Always pass `--access public` on the first publish of any scoped package. Subsequent publishes inherit the access setting.',
    tags: ['npm', 'publish', 'scoped', 'access'] },
  { key: 'ELECTRON_IPC_SYNC_BLOCK', category: 'pitfall',
    title: 'Electron ipcMain.handle must use async shell exec',
    summary: '**Pitfall**: using `execSync` or synchronous `spawn` inside `ipcMain.handle` blocks the Electron main thread, freezing the UI for seconds to minutes during `npm install` or `openclaw status` calls. **Fix**: always use `safeShellExecAsync()` (short commands) or `runAsync()` (long commands) which wrap `spawn` in a Promise. All IPC handlers must be `async` and `await` their shell calls.',
    tags: ['electron', 'ipc', 'async', 'main-thread'] },
  { key: 'PRISMA_DB_PUSH_DANGER', category: 'pitfall',
    title: 'Never run prisma db push on production',
    summary: 'Running `prisma db push` on production drops the `memory_vectors` table (manually managed outside Prisma schema) → live vector data loss. Only apply schema via manual migrations via `docker exec awareness-postgres psql`. The backend docker compose command uses `python -m prisma generate` only — never `db push`.',
    tags: ['prisma', 'postgres', 'migration', 'production'] },
  { key: 'PGVECTOR_VS_PINECONE', category: 'decision',
    title: 'Chose pgvector over Pinecone',
    summary: 'Decision: use pgvector in the main PostgreSQL instance instead of Pinecone. Reasons: (1) saves $70/mo Pinecone subscription; (2) JOIN-based hybrid search between memory_vectors and knowledge_cards is possible in the same SQL engine — Pinecone cannot do cross-index joins; (3) one less external service to operate. Trade-off: at >10M vectors QPS will drop. Current volume <1M.',
    tags: ['pgvector', 'postgres', 'vector-db', 'decision'] },
  { key: 'REMEMBER_RECORD_CONTENT', category: 'workflow',
    title: 'awareness_record content field should be rich and detailed',
    summary: 'The `content` parameter to `awareness_record` is the primary searchable memory. It should be a rich multi-paragraph natural language description: what changed, why, key code snippets, alternatives considered, files modified. Do NOT compress into a single-line summary — more detail = better recall. The daemon extracts insights separately; content itself remains the authoritative narrative.',
    tags: ['awareness_record', 'content', 'memory', 'recall'] },
  { key: 'FTS5_TRIGRAM_CJK', category: 'insight',
    title: 'FTS5 must use trigram tokenizer for CJK search',
    summary: 'SQLite FTS5 with the default `unicode61` tokenizer does not match Chinese / Japanese / Korean text because CJK has no word boundaries. Switch to `tokenize=\'trigram\'` so FTS5 indexes overlapping 3-char substrings. The daemon\'s indexer auto-migrates legacy unicode61 FTS tables to trigram on startup.',
    tags: ['fts5', 'cjk', 'trigram', 'search', 'chinese'] },
  { key: 'CROSS_ENCODER_RERANK', category: 'workflow',
    title: 'Cross-encoder rerank runs on CPU after hybrid retrieval',
    summary: 'The `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder (80MB ONNX, Apache-2.0) runs on CPU via fastembed to rerank the top K candidates from the hybrid BM25 + embedding retrieval. Controlled by `RERANK_ENABLED` env var, `RERANK_CANDIDATE_POOL` (input size), and `RERANK_TOP_K` (final slice). Zero LLM cost, adds ~50ms latency.',
    tags: ['rerank', 'cross-encoder', 'onnx', 'fastembed', 'cpu'] },
  { key: 'SKILL_GROWTH_STAGE', category: 'workflow',
    title: 'Skill growth stage promotes seedling to budding at 2 refs',
    summary: 'F-059 skill growth-stage lifecycle: a skill with ≥2 source_card_ids AND rubric ≥20/40 auto-promotes seedling → budding on every submit_insights / apply_skill call. budding → evergreen requires ≥5 source cards AND usage_count ≥2. Never demotes. Ranking uses stage_weight × decay_score so evergreen surfaces first but seedling/budding still recall.',
    tags: ['skill', 'growth-stage', 'lifecycle', 'evergreen'] },
  { key: 'CARD_QUALITY_R1_R4', category: 'workflow',
    title: 'F-055 card quality gate blocks short or template cards',
    summary: 'R1: technical card summary ≥80 chars; personal ≥40. R2: summary must not be byte-identical to title. R3: neither title nor summary may start with envelope prefixes (`Request:`, `Result:`, `Sender (untrusted metadata)`). R4: summary cannot contain `TODO`, `FIXME`, `lorem ipsum`, `example.com`, or the literal word `placeholder`. Cards failing any of R1-R4 are hard-rejected by `validateCardQuality`.',
    tags: ['card-quality', 'gate', 'f-055', 'validation'] },
  { key: 'DOCKER_NO_RESTART_PG', category: 'pitfall',
    title: 'Never restart postgres container in prod deploy',
    summary: 'Prod deploy command must NOT include `postgres` in the `up -d` services list. Restarting the postgres container invalidates scram-sha-256 authentication hashes, requiring manual `ALTER USER awareness PASSWORD` reset. Correct deploy: `docker compose ... up -d backend mcp worker beat` — omit `postgres`, and include `frontend` only on full deploys with `--no-deps`.',
    tags: ['docker', 'postgres', 'deploy', 'scram-sha-256'] },
  { key: 'APPLE_NOTARIZE_KEYCHAIN', category: 'workflow',
    title: 'macOS notarization via xcrun notarytool keychain profile',
    summary: 'AwarenessClaw DMG notarization: first run `xcrun notarytool store-credentials AwarenessClawNotary --apple-id <email> --team-id 5XNDF727Y6 --password <app-specific-pwd>` once per machine. Then `npm run package:mac` with `APPLE_KEYCHAIN_PROFILE=AwarenessClawNotary` will auto-submit for notarization. Verify with `spctl -a -vvv -t install` → accepted + Notarized Developer ID.',
    tags: ['macos', 'notarize', 'electron', 'xcrun', 'keychain'] },
];

// Query → expected card KEY(s) it should surface in top-3
// Each query optionally carries a `hyde` field — a hand-written
// hypothetical answer that a real agent LLM would produce. When the
// eval is run with --hyde, these are passed as `hyde_hint` to the
// daemon so we can measure the F-060 HyDE lift end-to-end. Without
// --hyde, queries run raw.
const QUERIES = [
  { q: '如何把 awareness-sdk 发布到 npm 而不被中国镜像拦截？', gold: ['NPM_PUBLISH_MIRROR', 'SCOPED_ACCESS_PUBLIC'],
    hyde: 'Pass explicit --registry=https://registry.npmjs.org/ on npm publish commands. The China mirror (npmmirror) accepts install but rejects publish with 401 ENEEDAUTH. Also include --access public on scoped packages or the registry returns 402.' },
  { q: 'npm publish ENEEDAUTH error fix',                      gold: ['NPM_PUBLISH_MIRROR'],
    hyde: 'npm publish fails with ENEEDAUTH when default registry is set to the China mirror registry.npmmirror.com. Fix: always pass --registry=https://registry.npmjs.org/ explicitly on publish.' },
  { q: 'why does my npm publish fail on scoped package',        gold: ['SCOPED_ACCESS_PUBLIC', 'NPM_PUBLISH_MIRROR'],
    hyde: 'Scoped npm packages like @awareness-sdk/* default to private and require --access public on first publish, otherwise registry returns 402 Payment Required.' },
  { q: 'Electron IPC handler blocking UI main thread',         gold: ['ELECTRON_IPC_SYNC_BLOCK'],
    hyde: 'Using execSync or synchronous spawn inside ipcMain.handle blocks the Electron main thread during long shell calls, freezing the UI. Fix: use async spawn wrapped in a Promise.' },
  { q: 'why did we choose pgvector',                           gold: ['PGVECTOR_VS_PINECONE'],
    hyde: 'Chose pgvector over Pinecone: saves 70/mo, enables JOIN-based hybrid search with relational tables in the same Postgres instance, one less external service to operate.' },
  { q: 'prisma migration production safety',                   gold: ['PRISMA_DB_PUSH_DANGER'],
    hyde: 'Never run prisma db push in production — it drops manually-managed tables like memory_vectors. Apply schema changes only via manual migrations through docker exec psql.' },
  { q: 'Chinese search not matching in FTS',                   gold: ['FTS5_TRIGRAM_CJK'],
    hyde: 'SQLite FTS5 default unicode61 tokenizer cannot match Chinese/Japanese/Korean text because CJK has no word boundaries. Fix: use tokenize=trigram which indexes overlapping 3-character substrings.' },
  { q: 'rerank cross encoder setup',                           gold: ['CROSS_ENCODER_RERANK'],
    hyde: 'Cross-encoder rerank uses Xenova/ms-marco-MiniLM-L-6-v2 ONNX model on CPU via fastembed to re-rank top-K hybrid retrieval candidates. Controlled by RERANK_ENABLED env var and RERANK_CANDIDATE_POOL size.' },
  { q: 'skill 怎么从 seedling 升级',                            gold: ['SKILL_GROWTH_STAGE'],
    hyde: 'Skill growth-stage: a skill with >=2 source card ids and rubric >=20/40 auto-promotes seedling to budding on every submit_insights call. budding to evergreen requires >=5 source cards and usage_count >=2. Never demotes.' },
  { q: 'awareness_record 怎么写高质量内容',                     gold: ['REMEMBER_RECORD_CONTENT'],
    hyde: 'The content parameter to awareness_record is the primary searchable memory. Write rich multi-paragraph natural language description with reasoning, key code, files, alternatives. Do NOT compress to a single-line summary — more detail gives better recall.' },
  { q: 'docker deploy postgres password scram',                gold: ['DOCKER_NO_RESTART_PG'],
    hyde: 'Never restart the postgres container in prod deploys — it invalidates scram-sha-256 authentication hashes. Correct deploy: docker compose up -d backend mcp worker beat (omit postgres from the services list).' },
  { q: 'macOS app notarization script',                        gold: ['APPLE_NOTARIZE_KEYCHAIN'],
    hyde: 'macOS DMG notarization: run xcrun notarytool store-credentials once per machine with an app-specific password, then set APPLE_KEYCHAIN_PROFILE env when packaging. Verify with spctl -a -vvv -t install — must show accepted + Notarized Developer ID.' },
];

async function seedCards() {
  console.log('▶ Seeding', CARDS.length, 'fixture cards...');
  const keyToId = {};
  for (const c of CARDS) {
    await mcp('awareness_record', {
      action: 'submit_insights',
      content: `${c.title}\n\n${c.summary}`,
      insights: {
        knowledge_cards: [{
          category: c.category,
          title: c.title,
          summary: c.summary,
          tags: c.tags,
          novelty_score: 0.9, durability_score: 0.9, specificity_score: 0.9,
        }],
        action_items: [], risks: [], skills: [],
      },
    });
    const lookup = await mcp('awareness_lookup', { type: 'knowledge', limit: 50 });
    const match = (lookup.knowledge_cards || lookup.cards || []).find((x) => x.title === c.title);
    if (match) keyToId[c.key] = match.id;
  }
  // Give fire-and-forget embed calls a beat to flush to DB
  await new Promise((r) => setTimeout(r, 1500));
  console.log('  seeded:', Object.keys(keyToId).length);
  return keyToId;
}

function findRankOf(ids, results) {
  for (let i = 0; i < results.length; i++) {
    if (ids.includes(results[i].id)) return i + 1; // 1-indexed
  }
  return null;
}

function dcg(hits) {
  let s = 0;
  hits.forEach((rel, i) => { s += rel / Math.log2(i + 2); });
  return s;
}

async function main() {
  const scratch = `/tmp/recall-eval-${Date.now()}`;
  await switchProject(scratch);
  const keyToId = await seedCards();

  const goldIds = QUERIES.map((q) => q.gold.map((k) => keyToId[k]).filter(Boolean));

  let r1 = 0, r3 = 0, mrrSum = 0, ndcgSum = 0;
  const details = [];

  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    const gold = goldIds[i];
    if (gold.length === 0) continue;

    const recallArgs = {
      query: q.q,
      detail: 'summary',
      max_cards: 5,
    };
    if (USE_HYDE && q.hyde) recallArgs.hyde_hint = q.hyde;
    const recall = await mcp('awareness_recall', recallArgs);
    // Summary mode returns `_ids: [<id>, ...]` in parse order; use as ranked list.
    const ids = Array.isArray(recall._ids) ? recall._ids.slice(0, 5) : [];
    const cards = ids.map((id) => ({ id }));

    const rank = findRankOf(gold, cards);
    const top1Hit = cards[0] && gold.includes(cards[0].id);
    const top3Hits = cards.slice(0, 3).filter((c) => gold.includes(c.id)).length;
    const r3Full = top3Hits >= gold.length;

    if (top1Hit) r1++;
    if (r3Full) r3++;
    mrrSum += rank ? 1 / rank : 0;

    // NDCG@3 — graded: golden card = 1, non-golden = 0
    const rels = cards.slice(0, 3).map((c) => gold.includes(c.id) ? 1 : 0);
    const ideal = Array(Math.min(3, gold.length)).fill(1);
    const ndcg = ideal.length > 0 ? dcg(rels) / dcg(ideal) : 0;
    ndcgSum += ndcg;

    details.push({ q: q.q, gold: q.gold, rank, top3Hits, ndcg, top3Ids: ids.slice(0, 3), keyToId });
  }

  const n = QUERIES.length;
  console.log('\n── Recall Accuracy Scorecard ──────────────────────────');
  console.log(`Dataset: ${CARDS.length} cards · ${n} queries${USE_HYDE ? ' · HyDE ON' : ''}`);
  console.log('');
  for (const d of details) {
    const flag = d.rank === 1 ? '🟢' : d.rank && d.rank <= 3 ? '🟡' : '🔴';
    console.log(`${flag} rank=${d.rank ?? 'miss'}  ndcg=${d.ndcg.toFixed(2)}  q: ${d.q.slice(0, 60)}`);
    if (!d.rank || d.rank > 3) {
      console.log(`    expected: ${d.gold.join(',')}`);
      // Look up actual titles for the top-3 IDs
      for (const id of d.top3Ids) {
        const key = Object.keys(d.keyToId || {}).find((k) => d.keyToId[k] === id);
        console.log(`    got: ${id.slice(0, 20)}  key=${key || '?'}`);
      }
    }
  }
  console.log('');
  console.log(`Recall@1   : ${(r1 / n * 100).toFixed(0)}%  (${r1}/${n} queries where top-1 hit a golden)`);
  console.log(`Recall@3   : ${(r3 / n * 100).toFixed(0)}%  (${r3}/${n} queries where all goldens in top-3)`);
  console.log(`MRR        : ${(mrrSum / n).toFixed(3)}     (mean reciprocal rank of first golden)`);
  console.log(`NDCG@3     : ${(ndcgSum / n).toFixed(3)}     (graded-relevance gain, max 1.0)`);
  console.log('───────────────────────────────────────────────────────');

  if (!KEEP) {
    await fetch(`${DAEMON}/api/v1/workspace/switch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_dir: process.env.HOME + '/.openclaw' }),
    });
  } else {
    console.log(`\nscratch: ${scratch}`);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
