/**
 * F-056 · shared-prompts parity gate.
 *
 * Runs `scripts/sync-shared-prompts.mjs --check` from the repo root and
 * asserts it exits 0 (no drift). If this test fails, someone edited one
 * of the slot-marked surfaces by hand instead of updating the template
 * in `sdks/_shared/prompts/*.md` and re-running sync.
 *
 * Fix workflow:
 *   1) Edit the right .md in sdks/_shared/prompts/
 *   2) `node scripts/sync-shared-prompts.mjs`
 *   3) Commit both the .md change and the regenerated surfaces
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

describe('F-056 shared-prompts parity', () => {
  it('scripts/sync-shared-prompts.mjs --check passes (no drift)', () => {
    const script = path.join(REPO_ROOT, 'scripts/sync-shared-prompts.mjs');
    const result = spawnSync('node', [script, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      // Dump stdout for helpful failure output
      const diag = `\n--- sync-shared-prompts --check stdout ---\n${result.stdout || ''}\n--- stderr ---\n${result.stderr || ''}`;
      assert.equal(result.status, 0, `sync-shared-prompts --check exited ${result.status}${diag}`);
    }
  });

  it('prompts directory contains ONLY template files (no README, no docs)', async () => {
    const fs = await import('node:fs');
    const templatesDir = path.join(REPO_ROOT, 'sdks/_shared/prompts');
    const entries = fs.readdirSync(templatesDir);
    const nonMd = entries.filter((f) => !f.endsWith('.md'));
    assert.deepEqual(nonMd, [],
      `prompts directory must contain only .md templates, found: ${nonMd.join(', ')}`);
    // README.md was removed F-056 Phase 1 · the directory is "all prompts, nothing else".
    assert.ok(!entries.includes('README.md'),
      'README.md should not live in _shared/prompts/ — move docs to the sync script header.');
  });

  it('all template files have the required leading meta-comment', async () => {
    const fs = await import('node:fs');
    const templatesDir = path.join(REPO_ROOT, 'sdks/_shared/prompts');
    const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.md'));
    assert.ok(files.length > 0, 'expected at least one template .md');
    for (const file of files) {
      const body = fs.readFileSync(path.join(templatesDir, file), 'utf8');
      assert.match(
        body.slice(0, 200),
        /^<!--/,
        `template ${file} must start with an <!-- ... --> meta-comment (see sdks/_shared/prompts/README.md authoring rules)`,
      );
    }
  });
});
