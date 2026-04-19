/**
 * F-055 bug D — ensure the extraction prompt tells the client LLM about
 * the daemon-side quality gate so the LLM self-polices before submit.
 *
 * If the daemon's validateCardQuality rules evolve, update both the
 * prompt in extraction-instruction.mjs AND this test so they stay in
 * sync. This is the cheapest possible way to keep client and server
 * quality rules aligned without pulling in a schema generator.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionInstruction } from '../src/daemon/extraction-instruction.mjs';


describe('F-055 extraction prompt contains daemon-side quality rules', () => {
  const prompt = buildExtractionInstruction({
    content: 'hello world',
    memoryId: 'mem_test',
    existingCards: [],
    spec: {},
  });

  it('includes R1 length threshold guidance', () => {
    assert.match(prompt, /R1 length/);
    assert.match(prompt, /≥\s*80/);
    assert.match(prompt, /≥\s*40/);
  });

  it('includes R2 summary-equals-title guidance', () => {
    assert.match(prompt, /R2 no duplication/);
  });

  it('includes R3 envelope guidance', () => {
    assert.match(prompt, /R3 no envelope/);
    assert.match(prompt, /Sender \(untrusted metadata\)/);
    assert.match(prompt, /\[Subagent Context\]/);
    assert.match(prompt, /\[Operational context metadata/);
  });

  it('includes R4 placeholder guidance', () => {
    assert.match(prompt, /R4 no placeholder/);
    assert.match(prompt, /TODO/);
    assert.match(prompt, /lorem ipsum/);
    assert.match(prompt, /example\.com/);
  });

  it('points the LLM at cards_skipped response for feedback', () => {
    assert.match(prompt, /cards_skipped/);
  });

  it('lists all personal-card categories that get the relaxed 40-char gate', () => {
    for (const cat of [
      'personal_preference', 'important_detail', 'plan_intention',
      'activity_preference', 'health_info', 'career_info', 'custom_misc',
    ]) {
      assert.match(prompt, new RegExp(cat));
    }
  });
});
