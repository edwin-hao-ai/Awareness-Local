/**
 * Core module barrel export for Awareness Local
 *
 * Re-exports all core modules so consumers can do:
 *   import { MemoryStore, Indexer, SearchEngine } from './core/index.mjs';
 */
// @ts-nocheck


export {
  ensureLocalDirs,
  initLocalConfig,
  loadLocalConfig,
  saveCloudConfig,
  getConfigPath,
  generateDeviceId,
} from './config.mjs';

export { MemoryStore } from './memory-store.mjs';

export { Indexer } from './indexer.mjs';

export {
  getEmbedder,
  embed,
  embedBatch,
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
} from './embedder.mjs';

export { SearchEngine } from './search.mjs';

export { KnowledgeExtractor } from './knowledge-extractor.mjs';

export { CloudSync } from './cloud-sync.mjs';
