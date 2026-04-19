/**
 * Graph Embedder — batch embed graph_nodes and generate similarity edges.
 *
 * Phase 5 T-030: fills the graph_embeddings table with ONNX local vectors,
 * then computes pairwise cosine similarity to create 'similarity' edges
 * in graph_edges. Runs in background after workspace indexing completes.
 *
 * Design:
 * - Batch processing (BATCH_SIZE texts per ONNX call) to avoid OOM
 * - CJK auto-detection for multilingual model selection
 * - ScanState progress tracking (embed_total / embed_done)
 * - Top-K similarity per node to avoid O(N²) edge explosion
 * - Graceful degradation: if embedder unavailable, logs and returns
 */

import { detectNeedsCJK } from '../core/lang-detect.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max texts per embedBatch call — keeps ONNX WASM memory bounded. */
const BATCH_SIZE = 32;

/** Max characters per text for embedding input — truncate longer content. */
const MAX_EMBED_CHARS = 1500;

/** Minimum cosine similarity to create a 'similarity' edge. */
const SIMILARITY_THRESHOLD = 0.55;

/** Maximum number of similarity edges per node (top-K). */
const MAX_EDGES_PER_NODE = 8;

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/**
 * Prepare embedding text from a graph node.
 * Title is always included; content is truncated to MAX_EMBED_CHARS.
 *
 * @param {{ id: string, node_type: string, title: string, content: string }} node
 * @returns {string}
 */
function prepareEmbedText(node) {
  const title = (node.title || '').trim();
  const content = (node.content || '').trim();

  if (!content) return title;

  // For symbols, content is just the signature — use as-is
  if (node.node_type === 'symbol') {
    return `${title}: ${content}`;
  }

  // For files and wiki, truncate content
  const truncated = content.length > MAX_EMBED_CHARS
    ? content.slice(0, MAX_EMBED_CHARS)
    : content;

  return `${title}\n${truncated}`;
}

// ---------------------------------------------------------------------------
// Batch embedding
// ---------------------------------------------------------------------------

/**
 * Embed all graph nodes that don't yet have embeddings.
 *
 * @param {object} daemon — daemon instance with _embedder and indexer
 * @param {object} [options]
 * @param {function} [options.onProgress] — called with (done, total)
 * @returns {Promise<{ embedded: number, skipped: number, total: number }>}
 */
export async function embedGraphNodes(daemon, options = {}) {
  const { onProgress } = options;

  if (!daemon._embedder) {
    console.warn('[graph-embedder] Embedder not available — skipping graph embedding');
    return { embedded: 0, skipped: 0, total: 0 };
  }

  // Check embedding availability
  try {
    const available = await daemon._embedder.isEmbeddingAvailable();
    if (!available) {
      console.warn('[graph-embedder] @huggingface/transformers not installed — skipping');
      return { embedded: 0, skipped: 0, total: 0 };
    }
  } catch {
    console.warn('[graph-embedder] Embedder check failed — skipping');
    return { embedded: 0, skipped: 0, total: 0 };
  }

  const unembedded = daemon.indexer.getUnembeddedGraphNodes();
  const total = unembedded.length;

  if (total === 0) {
    console.log('[graph-embedder] All graph nodes already embedded');
    return { embedded: 0, skipped: 0, total: 0 };
  }

  console.log(`[graph-embedder] Embedding ${total} graph nodes...`);
  const t0 = Date.now();

  let embedded = 0;
  let skipped = 0;

  // Process in batches
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = unembedded.slice(i, i + BATCH_SIZE);
    const texts = batch.map(prepareEmbedText);

    // Filter out empty texts
    const validIndices = [];
    const validTexts = [];
    for (let j = 0; j < texts.length; j++) {
      if (texts[j].length > 0) {
        validIndices.push(j);
        validTexts.push(texts[j]);
      }
    }

    if (validTexts.length === 0) {
      skipped += batch.length;
      continue;
    }

    try {
      // Default: CJK-gated — matches embedding-helpers.mjs so graph nodes
      // and memories agree on model choice for each language. Honour
      // AWARENESS_EMBEDDER=multilingual opt-in for heavy non-English users.
      const sampleText = validTexts.slice(0, 3).join(' ');
      const language = process.env.AWARENESS_EMBEDDER === 'multilingual'
        ? 'multilingual'
        : (detectNeedsCJK(sampleText) ? 'multilingual' : 'english');
      const modelId = daemon._embedder.MODEL_MAP?.[language] || 'all-MiniLM-L6-v2';

      const vectors = await daemon._embedder.embedBatch(validTexts, 'passage', language);

      // Store each embedding
      for (let k = 0; k < validIndices.length; k++) {
        const node = batch[validIndices[k]];
        const vector = vectors[k];
        if (vector) {
          daemon.indexer.storeGraphEmbedding(node.id, vector, modelId);
          embedded++;
        } else {
          skipped++;
        }
      }

      // Count nodes with empty text as skipped
      skipped += batch.length - validIndices.length;
    } catch (err) {
      console.warn(`[graph-embedder] Batch embedding failed (offset ${i}): ${err.message}`);
      skipped += batch.length;
    }

    if (onProgress) {
      onProgress(embedded + skipped, total);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[graph-embedder] Embedding complete: ${embedded} embedded, ${skipped} skipped in ${elapsed}s`);

  return { embedded, skipped, total };
}

// ---------------------------------------------------------------------------
// Similarity edge generation
// ---------------------------------------------------------------------------

/**
 * Generate 'similarity' edges between graph nodes based on cosine similarity.
 *
 * For each node, finds the top-K most similar nodes (above threshold)
 * and creates bidirectional similarity edges with weight = cosine score.
 *
 * @param {object} daemon — daemon instance with indexer
 * @param {object} [options]
 * @param {number} [options.threshold] — minimum cosine similarity (default: SIMILARITY_THRESHOLD)
 * @param {number} [options.maxEdgesPerNode] — max similar neighbors per node (default: MAX_EDGES_PER_NODE)
 * @returns {{ edgesCreated: number, nodesProcessed: number }}
 */
export async function generateSimilarityEdges(daemon, options = {}) {
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  const maxEdges = options.maxEdgesPerNode ?? MAX_EDGES_PER_NODE;
  // Yield to the Node event loop every N outer-loop iterations so concurrent
  // HTTP / MCP requests (e.g. Memory tab loads) do not stall while similarity
  // edges compute on large graphs. See: bench 2026-04-19 — 10898 nodes
  // previously blocked the event loop for ~152s.
  const yieldEvery = options.yieldEvery ?? 50;

  const allEmbeddings = daemon.indexer.getAllGraphEmbeddings();
  const count = allEmbeddings.length;

  if (count === 0) {
    console.log('[graph-embedder] No embeddings found — skipping similarity edges');
    return { edgesCreated: 0, nodesProcessed: 0 };
  }

  console.log(`[graph-embedder] Computing similarity edges for ${count} nodes...`);
  const t0 = Date.now();

  // Group by node_type prefix for same-type comparison
  const byType = new Map();
  for (const emb of allEmbeddings) {
    const type = emb.node_id.split(':')[0]; // 'file', 'wiki', 'sym'
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(emb);
  }

  let edgesCreated = 0;
  let iSinceYield = 0;
  const processedPairs = new Set();

  for (const [type, embeddings] of byType) {
    const n = embeddings.length;
    if (n < 2) continue;

    // For each node, find top-K most similar within same type
    for (let i = 0; i < n; i++) {
      const a = embeddings[i];
      const candidates = [];

      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = embeddings[j];

        // Skip if pair already processed (bidirectional dedup)
        const pairKey = a.node_id < b.node_id
          ? `${a.node_id}|${b.node_id}`
          : `${b.node_id}|${a.node_id}`;
        if (processedPairs.has(pairKey)) continue;

        const sim = fastCosineSimilarity(a.vector, b.vector);
        if (sim >= threshold) {
          candidates.push({ node_id: b.node_id, similarity: sim, pairKey });
        }
      }

      // Sort by similarity descending, take top-K
      candidates.sort((a, b) => b.similarity - a.similarity);
      const topK = candidates.slice(0, maxEdges);

      for (const c of topK) {
        if (processedPairs.has(c.pairKey)) continue;
        processedPairs.add(c.pairKey);

        // Create bidirectional similarity edge
        daemon.indexer.graphInsertEdge({
          from_node_id: a.node_id,
          to_node_id: c.node_id,
          edge_type: 'similarity',
          weight: Math.round(c.similarity * 1000) / 1000,
          metadata: { type },
        });

        edgesCreated++;
      }

      iSinceYield++;
      if (iSinceYield >= yieldEvery) {
        iSinceYield = 0;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[graph-embedder] Similarity edges: ${edgesCreated} created across ${byType.size} node types in ${elapsed}s`);

  return { edgesCreated, nodesProcessed: count };
}

// ---------------------------------------------------------------------------
// Fast cosine similarity (inlined for hot loop performance)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity optimized for the inner loop.
 * Assumes normalized vectors (embedBatch uses normalize: true),
 * so cosine = dot product.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function fastCosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

// ---------------------------------------------------------------------------
// Combined pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full graph embedding pipeline:
 * 1. Embed all unembedded graph nodes
 * 2. Generate similarity edges
 *
 * @param {object} daemon
 * @param {object} [options]
 * @param {function} [options.onProgress] — called with (done, total)
 * @returns {Promise<{ embedding: object, similarity: object }>}
 */
export async function runGraphEmbeddingPipeline(daemon, options = {}) {
  const embedding = await embedGraphNodes(daemon, options);
  const similarity = await generateSimilarityEdges(daemon);
  return { embedding, similarity };
}
