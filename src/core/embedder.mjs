/**
 * Embedder — local embedding module for Awareness Local.
 *
 * Uses @huggingface/transformers (ONNX WASM) for purely-in-JS inference.
 * Falls back gracefully to FTS5-only mode when the dependency is missing.
 *
 * Two model options (user-facing names hide actual model identifiers):
 *   "english"       → Xenova/all-MiniLM-L6-v2       (23 MB, English only)
 *   "multilingual"  → Xenova/multilingual-e5-small   (118 MB, 100+ languages)
 *
 * Both produce 384-dimensional Float32Array vectors.
 *
 * Auto-recovery: if a cached ONNX model is corrupted (Protobuf parsing failed),
 * the cache is automatically cleared and the model is re-downloaded on next call.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Model map
// ---------------------------------------------------------------------------

export const MODEL_MAP = {
  english: 'Xenova/all-MiniLM-L6-v2',
  multilingual: 'Xenova/multilingual-e5-small',
};

/**
 * Models whose architecture requires a "query: " / "passage: " prefix.
 * Currently only the e5 family needs this.
 */
const E5_MODELS = new Set([MODEL_MAP.multilingual]);

// ---------------------------------------------------------------------------
// Pipeline cache (one per language/model)
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<any>>} */
const _pipelineCache = new Map();

/** Whether the HF transformers library is available at all. */
let _hfAvailable = null; // null = not checked yet, true/false after first probe

/**
 * Dynamically import @huggingface/transformers.
 * Returns the module or null if not installed.
 * @private
 */
async function _loadHfModule() {
  if (_hfAvailable === false) return null;
  try {
    const mod = await import('@huggingface/transformers');
    _hfAvailable = true;
    return mod;
  } catch {
    _hfAvailable = false;
    // Enhanced warning with more detailed instructions
    console.warn(
      '\n┌─────────────────────────────────────────────────────────────────┐\n' +
      '│                   AWARENESS LOCAL NOTICE                        │\n' +
      '├─────────────────────────────────────────────────────────────────┤\n' +
      '│ @huggingface/transformers is not installed.                     │\n' +
      '│ Embedding-based semantic search is disabled.                    │\n' +
      '│                                                                 │\n' +
      '│ To enable vector search for better recall accuracy:             │\n' +
      '│                                                                 │\n' +
      '│    npm install @huggingface/transformers                        │\n' +
      '│                                                                 │\n' +
      '│ This will download ~23MB for English model (or ~118MB for       │\n' +
      '│ multilingual).                                                  │\n' +
      '│                                                                 │\n' +
      '│ Falling back to FTS5-only search mode.                          │\n' +
      '└─────────────────────────────────────────────────────────────────┘\n'
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-recovery for corrupted ONNX model cache
// ---------------------------------------------------------------------------

/**
 * Detect common HF Transformers cache directories.
 * @returns {string[]} existing cache directories that may contain ONNX models.
 */
function _getCacheDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs = [
    // HF Transformers JS default cache
    path.join(home, '.cache', 'huggingface', 'hub'),
    // @huggingface/transformers puts models under the package's .cache/
    // (npx installs use a temp path — glob from the module location)
  ];

  // Also check the npx cache location if we can find the module
  try {
    const modPath = require.resolve?.('@huggingface/transformers') ||
      import.meta.resolve?.('@huggingface/transformers');
    if (modPath) {
      const pkgDir = path.dirname(modPath.replace('file://', ''));
      const localCache = path.join(pkgDir, '.cache');
      if (fs.existsSync(localCache)) dirs.push(localCache);
    }
  } catch {
    // Module not resolvable — skip
  }

  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * Clear corrupted ONNX model cache for a specific model.
 * Returns true if any cache was cleared.
 *
 * @param {string} modelId — e.g. 'Xenova/all-MiniLM-L6-v2'
 * @returns {boolean}
 */
export function clearModelCache(modelId) {
  const modelSlug = modelId.replace('/', '--');
  const patterns = [
    `models--${modelSlug}`,  // HF hub format
    modelSlug,               // flat format
    modelId.split('/').pop(), // just the model name
  ];

  let cleared = false;
  for (const dir of _getCacheDirs()) {
    for (const pattern of patterns) {
      const target = path.join(dir, pattern);
      if (fs.existsSync(target)) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
          console.log(`[embedder] Cleared corrupted cache: ${target}`);
          cleared = true;
        } catch (err) {
          console.warn(`[embedder] Failed to clear cache ${target}: ${err.message}`);
        }
      }
    }
  }
  return cleared;
}

/**
 * Check if an error indicates a corrupted ONNX model file.
 * @param {Error} err
 * @returns {boolean}
 */
function _isCorruptedModelError(err) {
  const msg = String(err?.message || '');
  return (
    msg.includes('Protobuf parsing failed') ||
    msg.includes('Failed to load model') ||
    msg.includes('invalid model') ||
    msg.includes('ONNX') && msg.includes('failed')
  );
}

/**
 * Load the HF pipeline with auto-recovery on corrupted cache.
 * If the first attempt fails with a corruption error, clears the cache and retries once.
 *
 * @param {string} modelId
 * @returns {Promise<Function|null>}
 */
async function _loadPipeline(modelId) {
  const hf = await _loadHfModule();
  if (!hf) return null;

  try {
    return await hf.pipeline('feature-extraction', modelId, { dtype: 'q8' });
  } catch (err) {
    if (_isCorruptedModelError(err)) {
      console.warn(`[embedder] Model "${modelId}" cache is corrupted: ${err.message}`);
      console.log('[embedder] Auto-clearing corrupted cache and re-downloading...');
      clearModelCache(modelId);
      // Retry once after clearing cache
      try {
        const pipe = await hf.pipeline('feature-extraction', modelId, { dtype: 'q8' });
        console.log(`[embedder] Model "${modelId}" re-downloaded successfully.`);
        return pipe;
      } catch (retryErr) {
        console.error(`[embedder] Model re-download failed: ${retryErr.message}`);
        console.error('[embedder] Run manually: rm -rf ~/.cache/huggingface/hub && restart daemon');
        throw retryErr;
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lazy-load (and cache) the embedding pipeline for the given language.
 *
 * @param {string} [language='english'] — 'english' (default, MiniLM, stronger on English retrieval) | 'multilingual' (e5-small, 100+ langs)
 * @returns {Promise<Function|null>} — the HF pipeline function, or null if unavailable.
 */
export async function getEmbedder(language = 'english') {
  const modelId = MODEL_MAP[language] || MODEL_MAP.english;

  if (_pipelineCache.has(modelId)) {
    return _pipelineCache.get(modelId);
  }

  // Store the promise itself so concurrent callers share the same load.
  const loadPromise = _loadPipeline(modelId);
  _pipelineCache.set(modelId, loadPromise);

  // If the load fails, evict the cache entry so the next call can retry.
  loadPromise.catch(() => {
    _pipelineCache.delete(modelId);
  });

  return loadPromise;
}

/**
 * Check whether embedding is available (HF library installed).
 *
 * @returns {Promise<boolean>}
 */
export async function isEmbeddingAvailable() {
  if (_hfAvailable !== null) return _hfAvailable;
  const mod = await _loadHfModule();
  return mod !== null;
}

/**
 * Embed a single text string.
 *
 * @param {string} text
 * @param {string} [type='passage'] — 'query' | 'passage' (affects e5 prefix).
 * @param {string} [language='english'] — 'english' (default, MiniLM, stronger on English retrieval) | 'multilingual' (e5-small, 100+ langs).
 * @returns {Promise<Float32Array>} — 384-dimensional normalised vector.
 * @throws {Error} if embedding is unavailable.
 */
export async function embed(text, type = 'passage', language = 'english') {
  const pipe = await getEmbedder(language);
  if (!pipe) {
    throw new Error(
      'Embedding unavailable: @huggingface/transformers is not installed.'
    );
  }

  const modelId = MODEL_MAP[language] || MODEL_MAP.english;
  const input = E5_MODELS.has(modelId) ? `${type}: ${text}` : text;

  const output = await pipe(input, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Embed multiple texts in a single batch call.
 *
 * @param {string[]} texts
 * @param {string} [type='passage']
 * @param {string} [language='english']
 * @returns {Promise<Float32Array[]>}
 * @throws {Error} if embedding is unavailable.
 */
export async function embedBatch(texts, type = 'passage', language = 'english') {
  if (!texts || texts.length === 0) return [];

  const pipe = await getEmbedder(language);
  if (!pipe) {
    throw new Error(
      'Embedding unavailable: @huggingface/transformers is not installed.'
    );
  }

  const modelId = MODEL_MAP[language] || MODEL_MAP.english;
  const usePrefix = E5_MODELS.has(modelId);

  const inputs = usePrefix ? texts.map((t) => `${type}: ${t}`) : texts;

  const output = await pipe(inputs, { pooling: 'mean', normalize: true });

  // The pipeline returns a nested tensor; output.tolist() gives number[][].
  // We convert each sub-array to a Float32Array.
  const dim = 384;
  const results = [];
  if (output.data && output.data.length === texts.length * dim) {
    // Flat buffer — slice into per-text vectors.
    for (let i = 0; i < texts.length; i++) {
      results.push(new Float32Array(output.data.slice(i * dim, (i + 1) * dim)));
    }
  } else if (typeof output.tolist === 'function') {
    const nested = output.tolist();
    for (const row of nested) {
      results.push(new Float32Array(row));
    }
  } else {
    // Fallback: embed one-by-one.
    for (const text of texts) {
      results.push(await embed(text, type, language));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Vector utilities
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} — value in [-1, 1].
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Convert a Float32Array to a Buffer suitable for SQLite BLOB storage.
 *
 * @param {Float32Array} vector
 * @returns {Buffer}
 */
export function vectorToBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Convert a Buffer (from SQLite BLOB) back to a Float32Array.
 *
 * @param {Buffer} buffer
 * @returns {Float32Array}
 */
export function bufferToVector(buffer) {
  return new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}
