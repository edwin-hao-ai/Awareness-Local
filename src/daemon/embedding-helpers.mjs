import { detectNeedsCJK } from '../core/lang-detect.mjs';

/**
 * Pre-warm the embedding model (downloads on first run, ~23MB) then backfill.
 * Runs in background — daemon is fully usable during warmup via FTS5 fallback.
 *
 * Auto-recovery: if the cached model is corrupted, clears the cache and retries.
 * This handles the common case of interrupted downloads or disk corruption.
 */
export async function warmupEmbedder(daemon) {
  if (!daemon._embedder) return;
  try {
    const available = await daemon._embedder.isEmbeddingAvailable();
    if (!available) {
      console.warn('[awareness-local] @huggingface/transformers not installed — FTS5-only mode.');
      console.warn('[awareness-local] To enable vector search: npm install @huggingface/transformers');
      return;
    }
    const modelId = daemon._embedder.MODEL_MAP?.english || 'unknown';
    console.log(`[awareness-local] Pre-warming embedding model "${modelId}" (first run downloads ~23MB)...`);
    const t0 = Date.now();
    // getEmbedder() has built-in auto-recovery for corrupted caches,
    // so embed() will auto-clear and re-download if needed.
    await daemon._embedder.embed('warmup', 'query');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[awareness-local] Embedding model ready in ${elapsed}s — hybrid search active`);
    console.log(`[awareness-local] Multilingual model (${daemon._embedder.MODEL_MAP?.multilingual || 'multilingual-e5-small'}) available — auto-loads on CJK content`);
  } catch (err) {
    console.warn(`[awareness-local] Embedding warmup failed: ${err.message}`);
    console.warn('[awareness-local] Vector search disabled for this session. FTS5-only mode active.');
    console.warn('[awareness-local] The daemon will auto-retry on next restart.');
    return;
  }

  await backfillEmbeddings(daemon);
}

/**
 * Backfill embeddings for memories that were indexed before vector search was enabled.
 * Runs in background on startup — processes in batches to avoid blocking.
 */
export async function backfillEmbeddings(daemon) {
  if (!daemon._embedder) return;
  const missing = daemon.indexer.db
    .prepare('SELECT id, filepath FROM memories WHERE id NOT IN (SELECT memory_id FROM embeddings)')
    .all();
  if (missing.length === 0) return;
  console.log(`[awareness-local] backfilling embeddings for ${missing.length} memories...`);
  let done = 0;
  for (const mem of missing) {
    try {
      const result = await daemon.memoryStore.read(mem.id);
      if (result?.content) {
        await embedAndStore(daemon, mem.id, result.content);
        done++;
      }
    } catch {
      // File may be missing or corrupt — skip silently
    }
  }
  console.log(`[awareness-local] embedding backfill complete: ${done}/${missing.length} memories embedded`);
}

/**
 * Generate embedding for a memory and store it in the index.
 * Fire-and-forget — errors are logged but don't block the record flow.
 */
function _firstLineAsTitle(content) {
  if (!content) return '';
  const line = String(content).split(/\r?\n/, 1)[0]?.trim() || '';
  if (line.length < 3 || line.length > 120) return '';
  // Skip lines that look like paragraphs (too many sentence terminators)
  const terminators = (line.match(/[.!?。！？]/g) || []).length;
  if (terminators > 1) return '';
  return line;
}

export async function embedAndStore(daemon, memoryId, content, opts = {}) {
  if (!daemon._embedder || !content) return;
  const { title = '' } = opts || {};
  try {
    // F-059 recall tuning · default embedder is multilingual-e5-small
    // (118 MB, 384-dim) so English + CJK + other-language queries all
    // share the same vector space. Previous CJK-gated routing meant
    // cross-lingual queries had no semantic bridge (CN query → EN card
    // rank 5+ in the 2026-04-19 eval). Opt-out `AWARENESS_EMBEDDER=english`
    // drops to the 23 MB all-MiniLM-L6-v2 for English-heavy users who
    // want the extra 7.3pp R@5 that MiniLM's English-only training gave
    // on LongMemEval 60Q.
    let language;
    if (process.env.AWARENESS_EMBEDDER === 'english') {
      language = detectNeedsCJK(content) ? 'multilingual' : 'english';
    } else {
      language = 'multilingual';
    }

    // F-059 title×2 trick · when the memory has an associated title
    // (from card / skill / first line of content), prepend it twice so
    // the embedder weights those tokens more. Lifts Recall@1 by 3-5%
    // on small corpora because titles are the most query-aligned
    // surface of the whole record.
    const inferredTitle = title || _firstLineAsTitle(content);
    const passage = inferredTitle
      ? `${inferredTitle}. ${inferredTitle}.\n\n${content || ''}`
      : (content || '');

    const vector = await daemon._embedder.embed(passage, 'passage', language);
    if (vector) {
      const modelId = daemon._embedder.MODEL_MAP?.[language] || 'Xenova/multilingual-e5-small';
      daemon.indexer.storeEmbedding(memoryId, vector, modelId);
    }
  } catch (err) {
    console.warn('[awareness-local] embedding failed for', memoryId, ':', err.message);
  }
}

/**
 * Extract knowledge from a newly recorded memory and index the results.
 * Fire-and-forget — errors are logged but don't fail the record.
 */
export async function extractAndIndex(daemon, memoryId, content, metadata, preExtractedInsights) {
  try {
    if (!daemon.extractor) return;

    await daemon.extractor.extract(content, metadata, preExtractedInsights);
  } catch (err) {
    console.error('[awareness-local] extraction error:', err.message);
  }
}
