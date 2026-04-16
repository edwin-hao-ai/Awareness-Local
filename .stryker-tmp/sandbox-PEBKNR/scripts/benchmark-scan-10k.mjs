#!/usr/bin/env node
// @ts-nocheck
/**
 * T-031 scan performance benchmark.
 *
 * Generates a synthetic project with N files of varied sizes across code /
 * docs / config categories, then measures workspace-scanner throughput.
 *
 * Usage:
 *   node scripts/benchmark-scan-10k.mjs [--files=10000] [--keep]
 *
 * Notes:
 * - Excludes index pipeline (graph_nodes/graph_edges writes) to isolate
 *   filesystem + filter cost.
 * - Reports p50/p95 over 3 runs with warm FS cache (ignores first cold run).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanWorkspace } from '../src/core/workspace-scanner.mjs';
import { getDefaultScanConfig } from '../src/core/scan-config.mjs';

const args = process.argv.slice(2).reduce((acc, raw) => {
  const [k, v] = raw.startsWith('--') ? raw.slice(2).split('=') : [raw, true];
  acc[k] = v ?? true;
  return acc;
}, {});

const N = Number(args.files ?? 10_000);
const KEEP = Boolean(args.keep);

const CODE_EXT = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.cpp', '.h'];
const DOC_EXT = ['.md', '.mdx', '.txt', '.rst'];
const CFG_EXT = ['.json', '.yaml', '.toml'];
const ALL = [...CODE_EXT, ...DOC_EXT, ...CFG_EXT];

function pick(arr, i) { return arr[i % arr.length]; }

function generateProject(root, count) {
  // Mix directory structure: src/<package>/<module>/<file>, docs/, config/
  const NUM_PKGS = Math.max(4, Math.floor(Math.sqrt(count) / 4));
  const FILES_PER_DIR = Math.max(8, Math.floor(count / (NUM_PKGS * 8)));
  let made = 0;
  let pkg = 0;
  let mod = 0;
  while (made < count) {
    const dir = path.join(root, 'src', `pkg${pkg}`, `mod${mod}`);
    fs.mkdirSync(dir, { recursive: true });
    const filesInDir = Math.min(FILES_PER_DIR, count - made);
    for (let i = 0; i < filesInDir; i++) {
      const ext = pick(ALL, made);
      const name = `f${made}${ext}`;
      const size = 512 + ((made * 131) % 4096); // 0.5KB..4.5KB
      fs.writeFileSync(path.join(dir, name), 'x'.repeat(size));
      made++;
      if (made >= count) break;
    }
    mod++;
    if (mod >= 8) { mod = 0; pkg++; }
  }

  // Sprinkle excluded cruft (must NOT be counted).
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(root, 'node_modules', 'junk', `j${i}.js`), 'junk');
  }
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nbuild/\n');

  return made;
}

function runOnce(root) {
  const config = { ...getDefaultScanConfig(), max_total_files: N + 500 };
  const t0 = performance.now();
  const files = scanWorkspace(root, { config });
  const ms = performance.now() - t0;
  return { ms, count: files.length };
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan10k-'));
  console.log(`[bench] root: ${tmp}`);
  console.log(`[bench] generating ${N.toLocaleString()} files...`);
  const gen0 = performance.now();
  const created = generateProject(tmp, N);
  const genMs = performance.now() - gen0;
  console.log(`[bench] generated ${created.toLocaleString()} files in ${genMs.toFixed(0)}ms`);

  const runs = 4;
  const durations = [];
  let lastCount = 0;
  for (let i = 0; i < runs; i++) {
    const { ms, count } = runOnce(tmp);
    lastCount = count;
    console.log(`[bench] run ${i + 1}: ${ms.toFixed(1)}ms  files=${count}`);
    if (i > 0) durations.push(ms); // Drop cold run.
  }

  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const throughputP50 = (lastCount / (p50 / 1000)).toFixed(0);

  console.log('');
  console.log('─────────────────────────────────────────');
  console.log(`  Files scanned:  ${lastCount.toLocaleString()}`);
  console.log(`  p50 (warm):     ${p50.toFixed(0)}ms`);
  console.log(`  p95 (warm):     ${p95.toFixed(0)}ms`);
  console.log(`  Throughput p50: ${Number(throughputP50).toLocaleString()} files/sec`);
  console.log(`  Excluded cruft: node_modules/junk/* must be 0 in count`);
  console.log('─────────────────────────────────────────');

  if (!KEEP) {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`[bench] cleaned up ${tmp}`);
  } else {
    console.log(`[bench] KEPT at ${tmp}`);
  }

  // Structured line for CI consumption.
  console.log(JSON.stringify({
    kind: 'scan10k.result',
    files: lastCount,
    p50_ms: Math.round(p50),
    p95_ms: Math.round(p95),
    throughput_files_per_sec: Number(throughputP50),
  }));
}

main().catch((err) => { console.error(err); process.exit(1); });
