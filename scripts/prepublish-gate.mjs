#!/usr/bin/env node
/**
 * Pre-publish gate for @awareness-sdk/local.
 *
 * Runs EVERY hard check that must pass before this package hits npm.
 * If anything drifts (SSOT not synced, spec not aligned, localhost in
 * prod URL), we block the publish — users of the npm package would
 * otherwise get stale prompts or broken config.
 *
 * Invoked automatically by `npm publish` via the `prepublishOnly`
 * script. You can also run it manually:
 *   node scripts/prepublish-gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(LOCAL_ROOT, '..', '..');

let ok = true;
const fail = (msg) => { console.error(`❌ ${msg}`); ok = false; };
const pass = (msg) => { console.log(`✅ ${msg}`); };

// ---------------------------------------------------------------------------
// 1. No localhost in default api_base (existing check)
// ---------------------------------------------------------------------------
const checkLocalhostInDefaults = () => {
  const files = ['src/core/config.mjs', 'src/core/cloud-sync.mjs', 'src/daemon.mjs'];
  let problem = false;
  for (const f of files) {
    const content = fs.readFileSync(path.join(LOCAL_ROOT, f), 'utf8');
    const defaults = [...content.matchAll(/api_base[^']*'([^']+)'/g)].map((m) => m[1]);
    for (const d of defaults) {
      if (d.includes('localhost') || d.includes('127.0.0.1')) {
        fail(`${f} has localhost in default api_base: ${d}`);
        problem = true;
      }
    }
  }
  if (!problem) pass('no localhost in default api_base');
};

// ---------------------------------------------------------------------------
// 2. F-056 prompt SSOT — _shared/prompts/*.md in sync with all 10 surfaces
// ---------------------------------------------------------------------------
const checkPromptSsot = () => {
  const script = path.join(REPO_ROOT, 'scripts/sync-shared-prompts.mjs');
  if (!fs.existsSync(script)) {
    pass('(skip) sync-shared-prompts.mjs not present — non-monorepo consumer');
    return;
  }
  const result = spawnSync('node', [script, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status === 0) {
    pass('F-056 prompt SSOT · no drift across 10 surfaces');
  } else {
    fail('F-056 prompt SSOT drift detected — run `node scripts/sync-shared-prompts.mjs` first');
    console.error(result.stdout?.slice(-400));
  }
};

// ---------------------------------------------------------------------------
// 3. F-036 shared scripts — _shared/scripts/*.js in sync with awareness-memory + claudecode
// ---------------------------------------------------------------------------
const checkSharedScripts = () => {
  const script = path.join(REPO_ROOT, 'scripts/sync-shared-scripts.sh');
  if (!fs.existsSync(script)) {
    pass('(skip) sync-shared-scripts.sh not present — non-monorepo consumer');
    return;
  }
  const result = spawnSync('bash', [script, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status === 0) {
    pass('F-036 shared-scripts · no drift');
  } else {
    fail('F-036 shared-scripts drift — run `bash scripts/sync-shared-scripts.sh` first');
    console.error(result.stdout?.slice(-400));
  }
};

// ---------------------------------------------------------------------------
// 3b. P0-a shared JS utilities — _shared/js/*.mjs in sync with each SDK's src/_shared/
// ---------------------------------------------------------------------------
const checkSharedJs = () => {
  const script = path.join(REPO_ROOT, 'scripts/sync-shared-js.mjs');
  if (!fs.existsSync(script)) {
    pass('(skip) sync-shared-js.mjs not present — non-monorepo consumer');
    return;
  }
  const result = spawnSync('node', [script, '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status === 0) {
    pass('P0-a shared-js · no drift');
  } else {
    fail('P0-a shared-js drift — run `node scripts/sync-shared-js.mjs` first');
    console.error(result.stdout?.slice(-400));
  }
};

// ---------------------------------------------------------------------------
// 4. awareness-spec.json three copies byte-identical
// ---------------------------------------------------------------------------
const checkSpecCopies = () => {
  const canonical = path.join(REPO_ROOT, 'backend/awareness-spec.json');
  const mirrors = [
    path.join(LOCAL_ROOT, 'src/spec/awareness-spec.json'),
    path.join(REPO_ROOT, 'sdks/setup-cli/awareness-spec.json'),
  ];
  if (!fs.existsSync(canonical)) {
    pass('(skip) backend/awareness-spec.json not present — non-monorepo consumer');
    return;
  }
  const canonicalContent = fs.readFileSync(canonical, 'utf8');
  let problem = false;
  for (const mirror of mirrors) {
    if (!fs.existsSync(mirror)) continue;
    const mirrorContent = fs.readFileSync(mirror, 'utf8');
    if (mirrorContent !== canonicalContent) {
      fail(`${path.relative(REPO_ROOT, mirror)} drifted from backend/awareness-spec.json — re-copy`);
      problem = true;
    }
  }
  if (!problem) pass('awareness-spec.json · 3 copies byte-identical');
};

// ---------------------------------------------------------------------------

console.log('Pre-publish gate · @awareness-sdk/local');
checkLocalhostInDefaults();
checkPromptSsot();
checkSharedScripts();
checkSharedJs();
checkSpecCopies();

if (!ok) {
  console.error('\nPUBLISH BLOCKED. Fix the issues above and try again.');
  process.exit(1);
}
console.log('\nAll checks passed. Safe to publish.');
