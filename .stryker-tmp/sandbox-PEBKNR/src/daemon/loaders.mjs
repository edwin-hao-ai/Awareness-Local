// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function loadDaemonConfig({ awarenessDir, port }) {
  try {
    const configPath = path.join(awarenessDir, 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return { daemon: { port } };
}

export function loadDaemonSpec(importMetaUrl) {
  try {
    const thisDir = path.dirname(fileURLToPath(importMetaUrl));
    const specPath = path.join(thisDir, 'spec', 'awareness-spec.json');
    if (fs.existsSync(specPath)) {
      return JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return { core_lines: [], init_guides: {} };
}

export async function loadEmbedderModule({ importMetaUrl, cachedEmbedder }) {
  if (cachedEmbedder !== undefined) return cachedEmbedder;
  try {
    const thisDir = path.dirname(fileURLToPath(importMetaUrl));
    const embedderPath = path.join(thisDir, 'core', 'embedder.mjs');
    if (fs.existsSync(embedderPath)) {
      const embedder = await import(pathToFileURL(embedderPath).href);
      console.log('[awareness-local] Embedder loaded — hybrid vector+FTS5 search enabled');
      return embedder;
    }
  } catch (err) {
    console.warn('[awareness-local] Embedder unavailable, FTS5-only mode:', err.message);
  }
  return null;
}

export async function loadSearchEngineModule({ importMetaUrl, indexer, memoryStore, loadEmbedder }) {
  try {
    const thisDir = path.dirname(fileURLToPath(importMetaUrl));
    const modPath = path.join(thisDir, 'core', 'search.mjs');
    if (fs.existsSync(modPath)) {
      const mod = await import(pathToFileURL(modPath).href);
      const SearchEngine = mod.SearchEngine || mod.default;
      if (SearchEngine) {
        const embedder = await loadEmbedder();
        return new SearchEngine(indexer, memoryStore, embedder);
      }
    }
  } catch (err) {
    console.warn('[awareness-local] SearchEngine not available:', err.message);
  }
  return null;
}

export async function loadKnowledgeExtractorModule({ importMetaUrl, memoryStore, indexer, loadEmbedder }) {
  try {
    const thisDir = path.dirname(fileURLToPath(importMetaUrl));
    const modPath = path.join(thisDir, 'core', 'knowledge-extractor.mjs');
    if (fs.existsSync(modPath)) {
      const mod = await import(pathToFileURL(modPath).href);
      const KnowledgeExtractor = mod.KnowledgeExtractor || mod.default;
      if (KnowledgeExtractor) {
        const embedder = await loadEmbedder();
        return new KnowledgeExtractor(memoryStore, indexer, embedder);
      }
    }
  } catch (err) {
    console.warn('[awareness-local] KnowledgeExtractor not available:', err.message);
  }
  return null;
}
