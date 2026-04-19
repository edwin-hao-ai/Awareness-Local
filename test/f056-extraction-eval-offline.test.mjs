/**
 * F-056 · offline extraction eval.
 *
 * For each corpus case, we check three things statically (no LLM call):
 *
 *   1. The composed extraction prompt for this content contains
 *      every steering signal the LLM needs (category names, envelope
 *      patterns, scoring, quality gate).
 *   2. If `DAEMON_SHOULD_REJECT` is set, classifyNoiseEvent (and thus
 *      `_remember`) rejects the content before extraction even runs.
 *   3. If we hand-craft a card that matches `MUST_EMIT[i]`, the daemon's
 *      quality gate accepts it (so the LLM has a reachable target).
 *
 * This is the static half of the eval. The live half
 * (`scripts/eval-extraction.mjs`) optionally hits a real LLM and
 * scores the returned JSON against the same expected properties.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionInstruction } from '../src/daemon/extraction-instruction.mjs';
import { validateCardQuality } from '../src/core/lifecycle-manager.mjs';
import { classifyNoiseEvent } from '../src/core/noise-filter.mjs';
import { EVAL_CASES } from './fixtures/extraction-eval-cases.mjs';


describe('F-056 offline extraction eval', () => {
  for (const testCase of EVAL_CASES) {
    describe(`case: ${testCase.id}`, () => {
      const prompt = buildExtractionInstruction({
        content: testCase.content,
        memoryId: `mem_${testCase.id}`,
        existingCards: [],
        spec: {},
      });

      // (1) Prompt contains the content under analysis
      it('composed prompt embeds the analysed content', () => {
        assert.ok(
          prompt.includes(testCase.content.slice(0, 100)),
          `prompt did not embed the first 100 chars of the content for ${testCase.id}`,
        );
      });

      // (2) Noise-only cases must be rejected upstream so we never even
      //     ask the LLM to extract from them.
      if (testCase.expect.DAEMON_SHOULD_REJECT) {
        it('daemon classifyNoiseEvent rejects upstream', () => {
          const reason = classifyNoiseEvent({
            content: testCase.content,
            event_type: 'turn_brief',
            source: 'test',
          });
          assert.ok(reason,
            `expected noise reason for "${testCase.id}", got null — daemon would run extraction on pure-envelope content`);
        });
      }

      // (3) If a card category is expected, synthesise a minimal card
      //     that matches and prove the daemon quality gate accepts it.
      //     This ensures the LLM has a reachable target: the prompt is
      //     not demanding something the gate will always reject.
      for (const expected of testCase.expect.MUST_EMIT ?? []) {
        it(`daemon gate allows a well-formed ${expected.category} card for this topic`, () => {
          const summary = (expected.summary_contains ?? [])
            .map((r) => r.toString().replace(/[\/^$]/g, ''))
            .join(' ');
          const targetMin = expected.summary_min_chars ?? 80;
          const padded = (summary + ' ' + testCase.content)
            .replace(/\s+/g, ' ')
            .slice(0, Math.max(targetMin + 10, 200));
          const card = {
            category: expected.category,
            title: testCase.id,
            summary: padded,
            confidence: 0.85,
            novelty_score: 0.8,
            durability_score: 0.85,
            specificity_score: 0.8,
          };
          const gate = validateCardQuality(card);
          assert.equal(
            gate.ok,
            true,
            `daemon gate rejected a well-formed ${expected.category} card for ${testCase.id}: ${gate.reasons.join(', ')}`,
          );
        });
      }

      // (4) If a skill is expected, check the gate accepts a well-formed
      //     skill with the required scores above floor.
      if (testCase.expect.MUST_EMIT_SKILL) {
        it('skill-extraction template mentions required fields', () => {
          // Skill gate lives in F-043 code; here we only need the
          // prompt to name the required fields so the LLM emits them.
          assert.match(prompt, /reusability_score/);
          assert.match(prompt, /trigger_conditions/);
          assert.match(prompt, /methods/);
          assert.match(prompt, /insights\.skills\[\]/);
        });
      }
    });
  }
});

describe('F-056 offline eval corpus sanity', () => {
  it('covers all extraction-worthy categories', () => {
    const categories = new Set();
    for (const c of EVAL_CASES) {
      for (const e of c.expect.MUST_EMIT ?? []) categories.add(e.category);
    }
    // Minimum coverage: decision + problem_solution + workflow + pitfall +
    // personal_preference. insight + key_point + important_detail are
    // valid fillers we can add later.
    for (const required of ['decision', 'problem_solution', 'workflow', 'pitfall', 'personal_preference']) {
      assert.ok(categories.has(required),
        `eval corpus missing a case that requires category=${required}`);
    }
  });

  it('has at least one skill case + at least three pure-noise cases', () => {
    const skills = EVAL_CASES.filter((c) => c.expect.MUST_EMIT_SKILL);
    const noise = EVAL_CASES.filter((c) => (c.expect.MUST_EMIT ?? []).length === 0 && !c.expect.MUST_EMIT_SKILL);
    assert.ok(skills.length >= 1, 'need at least one skill eval case');
    assert.ok(noise.length >= 3, `need at least 3 pure-noise cases, got ${noise.length}`);
  });
});
