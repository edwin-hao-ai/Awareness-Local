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
export async function embedAndStore(daemon, memoryId, content) {
  if (!daemon._embedder || !content) return;
  try {
    // Default: CJK-gated — English content uses `all-MiniLM-L6-v2` (stronger
    // on English long-document retrieval: LongMemEval 60Q showed multilingual-
    // e5-small drops R@5 by 7.3pp in that scenario). CJK content auto-switches
    // to `multilingual-e5-small`. Opt-in `AWARENESS_EMBEDDER=multilingual`
    // forces multilingual for ALL writes (useful for heavy non-English users).
    let language;
    if (process.env.AWARENESS_EMBEDDER === 'multilingual') {
      language = 'multilingual';
    } else {
      language = detectNeedsCJK(content) ? 'multilingual' : 'english';
    }
    const vector = await daemon._embedder.embed(content, 'passage', language);
    if (vector) {
      const modelId = daemon._embedder.MODEL_MAP?.[language] || 'all-MiniLM-L6-v2';
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
