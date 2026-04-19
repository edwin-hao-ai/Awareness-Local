/**
 * F-055 bug C2 — perception relatedness gate (embedding-based).
 *
 * The old implementation used a hardcoded stop-tag list which does not
 * scale across languages. F-055 switched to a language-agnostic
 * embedding cosine check via `isSemanticallyRelated(params, {embedFn,
 * cosineFn, threshold})`. These tests lock in that contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSemanticallyRelated } from '../src/daemon/helpers.mjs';


// Fake embedder: returns deterministic vectors by keyword match, so the
// test does not depend on ONNX runtime. Each "topic" maps to a unit
// vector along one axis; texts containing the topic word use that
// direction. Cosine between same-topic texts = 1.0, cross-topic = 0.0.
function makeFakeEmbedder(topics) {
  const dim = topics.length;
  const embedFn = async (text) => {
    const vec = new Array(dim).fill(0);
    for (let i = 0; i < topics.length; i++) {
      if (text.toLowerCase().includes(topics[i].toLowerCase())) vec[i] = 1;
    }
    return vec;
  };
  const cosineFn = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };
  return { embedFn, cosineFn };
}


describe('F-055 bug C2 — isSemanticallyRelated (embedding-based)', () => {
  it('returns not-related when either text is empty', async () => {
    const out = await isSemanticallyRelated(
      { newText: '', candidateText: 'anything' },
    );
    assert.equal(out.related, false);
    assert.equal(out.reason, 'empty_text');
  });

  it('returns not-related when no embedder provided (conservative)', async () => {
    const out = await isSemanticallyRelated({
      newText: 'something',
      candidateText: 'something else',
    });
    assert.equal(out.related, false);
    assert.equal(out.reason, 'no_embedder');
  });

  it('returns related when cosine ≥ threshold (same topic)', async () => {
    const embedder = makeFakeEmbedder(['pgvector', 'noodle', 'workspace']);
    const out = await isSemanticallyRelated(
      { newText: 'chose pgvector over pinecone', candidateText: 'pgvector beats pinecone in cost' },
      embedder,
    );
    assert.equal(out.related, true);
    assert.equal(out.reason, 'semantic_match');
    assert.ok(out.similarity >= 0.55);
  });

  it('returns not-related when cosine < threshold (cross-topic)', async () => {
    // The original bug: beef-noodle recipe vs pgvector decision. Distinct
    // topic dimensions → cosine = 0 → below 0.55 threshold.
    const embedder = makeFakeEmbedder(['pgvector', 'noodle', 'workspace']);
    const out = await isSemanticallyRelated(
      { newText: 'beef noodle soup recipe', candidateText: 'chose pgvector for embeddings' },
      embedder,
    );
    assert.equal(out.related, false);
    assert.equal(out.reason, 'below_threshold');
  });

  it('respects custom threshold override', async () => {
    const embedder = makeFakeEmbedder(['a', 'b']);
    const out = await isSemanticallyRelated(
      { newText: 'a b', candidateText: 'a' },
      { ...embedder, threshold: 0.9 },
    );
    // cosine of [1,1]·[1,0] = 1/sqrt(2) ≈ 0.707, which is below 0.9.
    assert.equal(out.related, false);
  });

  it('handles embedder throwing without raising', async () => {
    const embedFn = async () => { throw new Error('ONNX crashed'); };
    const cosineFn = () => 0;
    const out = await isSemanticallyRelated(
      { newText: 'x', candidateText: 'y' },
      { embedFn, cosineFn },
    );
    assert.equal(out.related, false);
    assert.match(out.reason, /^embedder_error:/);
  });

  it('works cross-language: English query vs Chinese passage', async () => {
    // Simulate multilingual embedder where "pgvector"/"向量" map to the
    // same topic axis (E5-multilingual behavior).
    const embedFn = async (text) => {
      const vec = [0, 0];
      if (/pgvector|向量/i.test(text)) vec[0] = 1;
      if (/noodle|牛肉面/i.test(text)) vec[1] = 1;
      return vec;
    };
    const cosineFn = (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
      return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    };
    const out = await isSemanticallyRelated(
      { newText: '改用 pgvector 做向量存储', candidateText: 'pgvector over pinecone decision' },
      { embedFn, cosineFn },
    );
    assert.equal(out.related, true);
  });

  it('is a pure async function (no shared state between calls)', async () => {
    const embedder = makeFakeEmbedder(['alpha', 'beta']);
    const a = await isSemanticallyRelated({ newText: 'alpha run', candidateText: 'alpha tune' }, embedder);
    const b = await isSemanticallyRelated({ newText: 'alpha run', candidateText: 'beta tune' }, embedder);
    assert.equal(a.related, true, 'same topic → related');
    assert.equal(b.related, false, 'different topics → not related');
  });

  it('trims input before check', async () => {
    const embedder = makeFakeEmbedder(['pgvector']);
    const out = await isSemanticallyRelated(
      { newText: '   pgvector   ', candidateText: '\n\npgvector\n' },
      embedder,
    );
    assert.equal(out.related, true);
  });

  it('handles non-string inputs safely', async () => {
    const out = await isSemanticallyRelated(
      { newText: null, candidateText: undefined },
    );
    assert.equal(out.related, false);
  });
});
