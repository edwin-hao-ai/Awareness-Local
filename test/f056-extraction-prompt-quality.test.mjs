/**
 * F-056 · end-to-end prompt quality check.
 *
 * After sync-shared-prompts runs, the extraction-instruction the daemon
 * hands to a client LLM must contain every critical signal needed to
 * extract high-quality cards. This test reads the final prompt string
 * (not the templates) and asserts the full compose is sane.
 *
 * If you change any of the template .md files or re-wire a surface,
 * update this test alongside so "prompt quality" is a gate, not an
 * after-thought.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionInstruction } from '../src/daemon/extraction-instruction.mjs';


describe('F-056 extraction prompt composition', () => {
  const prompt = buildExtractionInstruction({
    content: 'Sample content for inspection',
    memoryId: 'mem_test',
    existingCards: [],
    spec: { init_guides: { write_guide: '(test guide)' } },
  });

  // ---- Structural skeleton ----------------------------------------------

  it('has the end-to-end request envelope', () => {
    assert.match(prompt, /^--- INSIGHT EXTRACTION REQUEST \(local\) ---/);
    assert.match(prompt, /--- END EXTRACTION REQUEST ---$/);
  });

  it('contains all required section headers in correct order', () => {
    // Note: the verbose `## Summary Quality` block was dropped from the
    // local daemon surface in favour of the tighter `## Per-category
    // Shape` one-liner, to stay under the 6 KB runtime budget. The deep
    // Summary Quality template still exists in sdks/_shared/prompts/
    // and is available for the backend surfaces (more token budget).
    const sections = [
      '## Your Task',
      '## When to Extract',
      '## When NOT to Extract',
      '## Existing Knowledge Cards',
      '## Content to Analyze',
      '## Per-card Required Scores',
      '## Daemon Quality Gate',
      '## Per-category Shape',
      '## Skill Extraction',
      '## Expected JSON Output',
    ];
    let lastIdx = -1;
    for (const header of sections) {
      const idx = prompt.indexOf(header);
      assert.ok(idx >= 0, `missing section header: ${header}`);
      assert.ok(idx > lastIdx, `section out of order: ${header}`);
      lastIdx = idx;
    }
  });

  // ---- Template content present in composed prompt ----------------------

  it('When to Extract — lists all six positive triggers', () => {
    assert.match(prompt, /user \*\*made a decision\*\*/);
    assert.match(prompt, /non-obvious bug was fixed/);
    assert.match(prompt, /workflow \/ convention was established/);
    assert.match(prompt, /preference or hard constraint/);
    assert.match(prompt, /pitfall was encountered/);
    assert.match(prompt, /important fact about the user or project/);
  });

  it('When NOT to Extract — names the framework-metadata envelopes', () => {
    assert.match(prompt, /Sender \(untrusted metadata\)/);
    assert.match(prompt, /\[Operational context metadata/);
    assert.match(prompt, /\[Subagent Context\]/);
    assert.match(prompt, /turn_brief/);
    assert.match(prompt, /Request:/);
    assert.match(prompt, /6 months from now/);
  });

  it('Scoring — forces all three self-assessed scores', () => {
    assert.match(prompt, /novelty_score/);
    assert.match(prompt, /durability_score/);
    assert.match(prompt, /specificity_score/);
    // daemon discard threshold must appear so the LLM knows the gate
    assert.match(prompt, /novelty_score < 0\.4/);
    assert.match(prompt, /durability_score < 0\.4/);
  });

  it('Quality Gate — R1-R5 all present with numeric thresholds', () => {
    assert.match(prompt, /R1 length/);
    assert.match(prompt, /≥\s*80/); // technical min
    assert.match(prompt, /≥\s*40/); // personal min
    assert.match(prompt, /R2 no duplication/);
    assert.match(prompt, /R3 no envelope leakage/);
    assert.match(prompt, /R4 no placeholder/);
    assert.match(prompt, /R5 (prefer|Markdown).*(Markdown|structure|long)/i);
    // R6/R7/R8 — recall-friendliness signals
    assert.match(prompt, /R6.*grep-friendly/i);
    assert.match(prompt, /R7.*topic-specific/i);
    assert.match(prompt, /R8.*(keyword diversity|multilingual)/i);
    assert.match(prompt, /cards_skipped/);
  });

  it('Category overview — all 8 tech + personal categories listed', () => {
    for (const cat of [
      'decision', 'problem_solution', 'workflow', 'pitfall', 'insight',
      'key_point', 'personal_preference', 'important_detail',
    ]) {
      assert.match(prompt, new RegExp(`\\*\\*${cat}\\*\\*`),
        `category ${cat} not described in overview block`);
    }
  });

  it('Skill Extraction — triggers, skip rules, required fields present', () => {
    // Trigger bar
    assert.match(prompt, /reusable procedure/);
    assert.match(prompt, /\*?\*?repeated\*?\*?\s+procedure/);
    assert.match(prompt, /stable trigger/);
    // Skip rules
    assert.match(prompt, /Single debugging incidents/);
    // Required shape
    assert.match(prompt, /reusability_score/);
    assert.match(prompt, /trigger_conditions/);
    assert.match(prompt, /methods/);
    // Score floor — 0.5 is the skill score threshold, wording may read
    // "scores < 0.5" or "scores ≥ 0.5" depending on prompt polarity.
    assert.match(prompt, /scores?\s*[≥<>=]+\s*0\.5/);
  });

  // ---- Token economy ---------------------------------------------------

  it('total prompt stays under 14 KB (token-economy budget)', () => {
    // After adding R6-R8 recall-friendliness guidance + per-category title
    // examples, the prompt grew from ~9.2 KB to ~11.5 KB (~2.9K tokens
    // at 4 chars/token). Hard ceiling 14 KB (~3.5K tokens) preserves
    // ~20 % headroom for future clarifications. Raise deliberately.
    assert.ok(prompt.length < 14000,
      `extraction prompt is ${prompt.length} bytes — exceeded 14 KB runtime budget. ` +
      `Either trim a template or drop a slot from this surface.`);
  });

  it('contains literal backticks (inline code from Markdown templates)', () => {
    // Regression guard: if sync-shared-prompts ever over-escapes backticks
    // (e.g. leaving `\\``) the client LLM sees broken Markdown. A sanity
    // check that at least some backticks survive tells us the escape
    // pipeline is behaving.
    assert.match(prompt, /`novelty_score`/);
    assert.match(prompt, /`knowledge_cards`/);
  });

  it('Skill block is injected into insights.skills[], NOT knowledge_cards', () => {
    assert.match(
      prompt,
      /`insights\.skills\[\]`,\s*NOT\s*`insights\.knowledge_cards\[\]`/,
      'skill block must explicitly route to insights.skills[] to avoid mis-extraction',
    );
  });

  it('Expected JSON output schema includes skills alongside knowledge_cards', () => {
    assert.match(prompt, /"skills":/);
    assert.match(prompt, /"knowledge_cards":/);
    assert.match(prompt, /"action_items":/);
    assert.match(prompt, /"risks":/);
  });

  it('Write guide from spec is spliced in (not hardcoded)', () => {
    // Rebuild with a different guide to prove it's interpolated, not static
    const alt = buildExtractionInstruction({
      content: 'x', memoryId: 'mem', existingCards: [],
      spec: { init_guides: { write_guide: 'ALTERNATE-GUIDE-SENTINEL' } },
    });
    assert.match(alt, /ALTERNATE-GUIDE-SENTINEL/);
  });
});

describe('F-056 per-language template fidelity', () => {
  it('every template file is wired into at least one surface (live-or-die)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const { execSync } = await import('node:child_process');

    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..');
    const dir = path.resolve(repoRoot, 'sdks/_shared/prompts');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

    assert.ok(files.length > 0, 'expected at least one template .md');

    // For each template, grep every surface for its BEGIN marker. A
    // template with zero hits is a dead template and must be deleted or
    // wired per sdks/_shared/prompts/README.md "live-or-die rule".
    const orphans = [];
    for (const file of files) {
      const slot = file.replace(/\.md$/, '');
      let hits = 0;
      try {
        // grep returns non-zero exit when there are no matches — swallow it.
        const stdout = execSync(
          `grep -rl "SHARED:${slot} BEGIN" sdks/ backend/ 2>/dev/null | grep -v "_shared/prompts/" || true`,
          { cwd: repoRoot, encoding: 'utf8' },
        );
        hits = stdout.split('\n').filter(Boolean).length;
      } catch {
        hits = 0;
      }
      if (hits === 0) orphans.push(slot);
    }

    assert.deepEqual(
      orphans,
      [],
      `orphan templates detected (zero surfaces wire them): ${orphans.join(', ')}. ` +
      `Either wire them into a surface or delete them per the live-or-die rule.`,
    );
  });
});
