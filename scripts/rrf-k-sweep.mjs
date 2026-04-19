#!/usr/bin/env node
/**
 * rrf-k-sweep.mjs
 *
 * Grid-search the RRF smoothing constant `k` across {10, 30, 60, 100}
 * by restarting the daemon with AWARENESS_RRF_K=<k> and invoking
 * recall-accuracy-eval.mjs. Prints a comparison table of Recall@1 /
 * Recall@3 / MRR / NDCG@3 so we pick the empirical best for our corpus.
 *
 * Runtime ~3-5 min per k value.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const KS = [10, 30, 60, 100];
const DAEMON_BIN = '/Users/edwinhao/Awareness/sdks/local/bin/awareness-local.mjs';
const EVAL_SCRIPT = '/Users/edwinhao/Awareness/sdks/local/scripts/recall-accuracy-eval.mjs';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitReady(ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch('http://localhost:37800/healthz');
      if (r.ok) return true;
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('daemon not ready');
}

async function kill37800() {
  await new Promise((resolve) => {
    spawn('bash', ['-c', 'lsof -ti:37800 | xargs kill -9 2>/dev/null || true'])
      .on('close', resolve);
  });
  await sleep(1500);
}

function runEval() {
  return new Promise((resolve) => {
    const proc = spawn('node', [EVAL_SCRIPT], { env: { ...process.env } });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const r1 = out.match(/Recall@1\s*:\s*(\d+)%/);
      const r3 = out.match(/Recall@3\s*:\s*(\d+)%/);
      const mrr = out.match(/MRR\s*:\s*([\d.]+)/);
      const ndcg = out.match(/NDCG@3\s*:\s*([\d.]+)/);
      resolve({
        recall1: r1 ? Number(r1[1]) : null,
        recall3: r3 ? Number(r3[1]) : null,
        mrr: mrr ? Number(mrr[1]) : null,
        ndcg: ndcg ? Number(ndcg[1]) : null,
      });
    });
  });
}

function startDaemon(k) {
  const scratch = `/tmp/rrf-sweep-${k}-${Date.now()}`;
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(`${scratch}/README.md`, 'rrf sweep scratch');
  const proc = spawn('node', [DAEMON_BIN, 'start'], {
    env: { ...process.env, AWARENESS_RRF_K: String(k), DEBUG: '' },
    cwd: scratch,
    detached: true,
    stdio: ['ignore', fs.openSync(`/tmp/rrf-daemon-${k}.log`, 'w'), fs.openSync(`/tmp/rrf-daemon-${k}.log`, 'a')],
  });
  proc.unref();
  return scratch;
}

async function main() {
  const results = [];
  for (const k of KS) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  RRF k=${k}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    await kill37800();
    startDaemon(k);
    await waitReady(45000);
    await sleep(2000); // let warmup settle
    const r = await runEval();
    console.log(`  Recall@1=${r.recall1}%  Recall@3=${r.recall3}%  MRR=${r.mrr}  NDCG@3=${r.ndcg}`);
    results.push({ k, ...r });
  }

  console.log('\n\n══════════════════════════════════');
  console.log('  RRF k sweep · scorecard');
  console.log('══════════════════════════════════');
  console.log('  k        R@1   R@3   MRR     NDCG@3');
  for (const r of results) {
    console.log(`  ${String(r.k).padEnd(8)} ${String(r.recall1 + '%').padEnd(6)}${String(r.recall3 + '%').padEnd(6)}${r.mrr.toFixed(3).padEnd(8)}${r.ndcg.toFixed(3)}`);
  }
  const best = results.reduce((a, b) => (b.mrr > a.mrr ? b : a));
  console.log(`\n  Best by MRR: k=${best.k}  (R@1=${best.recall1}% R@3=${best.recall3}%)`);

  await kill37800();
  // Restore daemon in user's real workspace
  const home = process.env.HOME || '';
  const openclaw = `${home}/.openclaw`;
  spawn('node', [DAEMON_BIN, 'start'], {
    cwd: openclaw,
    detached: true,
    stdio: 'ignore',
  }).unref();
}

main().catch((err) => { console.error(err); process.exit(1); });
