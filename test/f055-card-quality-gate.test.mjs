/**
 * F-055 bug D — knowledge card quality validator.
 *
 * The daemon MUST reject client-submitted cards that carry no durable
 * signal: too-short summaries, summary-equals-title duplicates, envelope
 * leakage, and AI placeholder tokens. Personal cards get a shorter min
 * length because preferences like "prefers dark mode" carry full value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCardQuality } from '../src/core/lifecycle-manager.mjs';


describe('F-055 bug D — validateCardQuality', () => {
  // ---- Happy paths ------------------------------------------------------

  it('accepts a rich technical summary with markdown', () => {
    const card = {
      category: 'decision',
      title: 'Chose pgvector',
      summary:
        '**Decision**: Chose `pgvector` over Pinecone for vector DB. ' +
        'Saves $70/mo, co-locates with relational data, cosine `<=>`. ' +
        'Trade-off: lower QPS at >10M vectors. Revisit when scale demands.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, true, `expected ok, reasons=${JSON.stringify(result.reasons)}`);
  });

  it('accepts a short personal_preference card (≥40 chars)', () => {
    const card = {
      category: 'personal_preference',
      title: 'dark mode',
      summary: 'User prefers dark mode across all IDEs, solarized-dark theme.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, true);
  });

  // ---- R1: length -------------------------------------------------------

  it('R1: rejects technical summary under 80 chars', () => {
    const card = {
      category: 'decision',
      title: 'pgvector',
      summary: 'Use pgvector.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.startsWith('summary_too_short')));
  });

  it('R1: rejects personal summary under 40 chars', () => {
    const card = {
      category: 'personal_preference',
      title: 'dark',
      summary: 'dark mode',
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((r) => r.startsWith('summary_too_short')));
  });

  it('R1: personal card thresholds are relaxed vs technical', () => {
    const summary = 'a'.repeat(50);
    const personal = validateCardQuality({ category: 'personal_preference', title: 't', summary });
    const technical = validateCardQuality({ category: 'decision', title: 't', summary });
    // 50 chars passes the 40-char personal gate but fails the 80-char technical gate.
    assert.equal(personal.reasons.some((r) => r.startsWith('summary_too_short')), false);
    assert.equal(technical.reasons.some((r) => r.startsWith('summary_too_short')), true);
  });

  // ---- R2: summary == title --------------------------------------------

  it('R2: rejects when summary is byte-identical to title', () => {
    const card = {
      category: 'decision',
      title: 'x'.repeat(120),
      summary: 'x'.repeat(120),
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('summary_equals_title'));
  });

  it('R2: passes when summary expands title', () => {
    const card = {
      category: 'decision',
      title: 'Chose pgvector',
      summary:
        'Chose pgvector because it co-locates with relational data and ' +
        'runs cosine via the `<=>` operator. Cost saving was ~$70/mo.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.reasons.includes('summary_equals_title'), false);
  });

  // ---- R3: envelope pattern --------------------------------------------

  it('R3: rejects card whose title is an envelope leak', () => {
    const card = {
      category: 'insight',
      title: 'Sender (untrusted metadata): runtime',
      summary: 'summary content that is otherwise long enough to satisfy R1 threshold at 80 chars',
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('envelope_pattern_in_content'));
  });

  it('R3: rejects card whose summary starts with Request:', () => {
    const card = {
      category: 'decision',
      title: 'Real title',
      summary:
        'Request: Sender (untrusted metadata): this is what a polluted card looks like after the plugin missed strip',
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('envelope_pattern_in_content'));
  });

  it('R3: does NOT over-strip — "Requester:" is fine', () => {
    const card = {
      category: 'decision',
      title: 'Requester preferences',
      summary:
        'Requester: Alice had a valid preference for dark mode; this content is plain natural English with no envelope.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.reasons.includes('envelope_pattern_in_content'), false);
  });

  it('R3: [Subagent Context] prefix triggers rejection', () => {
    const card = {
      category: 'workflow',
      title: '[Subagent Context] handoff',
      summary: 'Some summary content long enough to pass R1 gate so this test isolates R3 behavior cleanly here',
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('envelope_pattern_in_content'));
  });

  // ---- R4: placeholder --------------------------------------------------

  it('R4: rejects summary containing TODO token', () => {
    const card = {
      category: 'decision',
      title: 'Caching plan',
      summary:
        'We plan to add TODO about caching strategy. Rest is filler to pass the R1 length check at 80 chars.',
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('placeholder_content'));
  });

  it('R4: rejects summary containing lorem ipsum', () => {
    const card = {
      category: 'insight',
      title: 'Sample',
      summary:
        'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.',
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('placeholder_content'));
  });

  it('R4: rejects summary containing example.com', () => {
    const card = {
      category: 'workflow',
      title: 'Endpoint config',
      summary: 'Call the API at https://example.com/v1/foo and then follow up with X — full length 80+ chars here.',
    };
    const result = validateCardQuality(card);
    assert.ok(result.reasons.includes('placeholder_content'));
  });

  // ---- R5: soft warning -------------------------------------------------

  it('R5: long plain-text summary gets a warning but is still ok:true', () => {
    const longPlain = 'a'.repeat(250);
    const card = {
      category: 'decision',
      title: 'Thinking',
      summary: longPlain,
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, true, 'R5 is soft — should not block');
    assert.ok(result.warnings.includes('no_markdown_structure'));
  });

  it('R5: long summary with markdown bullets passes without warning', () => {
    const card = {
      category: 'workflow',
      title: 'Deploy',
      summary:
        '- Step 1: build image\n- Step 2: push registry\n- Step 3: deploy ' +
        'via `docker compose`. Each step needs review. Rest is explanation of ' +
        'error handling for readers new to the stack.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, true);
    assert.equal(result.warnings.includes('no_markdown_structure'), false);
  });

  // ---- Shape guards -----------------------------------------------------

  it('rejects non-object input with invalid_card_shape', () => {
    const result = validateCardQuality(null);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('invalid_card_shape'));
  });

  it('accepts `content` field as fallback for `summary`', () => {
    const card = {
      category: 'decision',
      title: 'Long decision with reasoning',
      content:
        'We chose X because it gives Y, trades off Z, and the code already uses W — this passes length and structure checks.',
    };
    const result = validateCardQuality(card);
    assert.equal(result.ok, true);
  });
});
