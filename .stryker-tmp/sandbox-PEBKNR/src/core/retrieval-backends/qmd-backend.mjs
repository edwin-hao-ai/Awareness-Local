// @ts-nocheck
import { RetrievalBackend } from './base-backend.mjs';

export const QMD_RESULT_PREFIX = 'qmd:';

function normalizeCollectionList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureQmdId(result) {
  const rawId = result?.docid || result?.id || result?.path || result?.displayPath || result?.title;
  return rawId ? `${QMD_RESULT_PREFIX}${rawId}` : `${QMD_RESULT_PREFIX}unknown`;
}

function stripQmdPrefix(id) {
  return id.startsWith(QMD_RESULT_PREFIX) ? id.slice(QMD_RESULT_PREFIX.length) : id;
}

export class QmdRetrievalBackend extends RetrievalBackend {
  constructor(options = {}) {
    super();
    this.dbPath = options.dbPath || process.env.AWARENESS_QMD_DB_PATH || '';
    this.collections = normalizeCollectionList(
      options.collections || process.env.AWARENESS_QMD_COLLECTIONS || '',
    );
    this.rerank = options.rerank ?? (String(process.env.AWARENESS_QMD_RERANK || 'false').toLowerCase() === 'true');
    this.minScore = Number(options.minScore ?? process.env.AWARENESS_QMD_MIN_SCORE ?? 0);
    this.storeFactory = options.storeFactory || null;
    this._store = undefined;
    this._loadError = null;
  }

  isConfigured() {
    return !!this.dbPath;
  }

  async _loadStore() {
    if (this._store !== undefined) return this._store;
    if (!this.isConfigured()) {
      this._store = null;
      return this._store;
    }

    try {
      if (this.storeFactory) {
        this._store = await this.storeFactory({ dbPath: this.dbPath, collections: this.collections });
        return this._store;
      }

      const mod = await import('@tobilu/qmd');
      const createStore = mod.createStore;
      if (typeof createStore !== 'function') {
        throw new Error('createStore() unavailable from @tobilu/qmd');
      }
      this._store = await createStore({ dbPath: this.dbPath });
      return this._store;
    } catch (err) {
      this._loadError = err;
      this._store = null;
      return this._store;
    }
  }

  async search(params) {
    const store = await this._loadStore();
    const query = (params.semantic_query || params.keyword_query || '').trim();
    if (!store || !query) return [];

    try {
      const options = {
        query,
        limit: params.limit || 10,
        minScore: this.minScore,
        rerank: this.rerank,
      };
      if (this.collections.length > 0) {
        options.collections = this.collections;
      }

      const results = await store.search(options);
      if (!Array.isArray(results)) return [];

      return results.map((item) => ({
        id: ensureQmdId(item),
        type: 'document',
        title: item.title || item.displayPath || item.path || 'QMD Document',
        summary: item.snippet || item.context || item.path || '',
        content: item.snippet || '',
        score: item.score ?? 0,
        finalScore: item.score ?? 0,
        source: 'qmd',
        filepath: item.displayPath || item.path || null,
        docid: item.docid || item.id || null,
        created_at: item.updatedAt || item.created_at || null,
      }));
    } catch {
      return [];
    }
  }

  async getFullContent(ids) {
    const store = await this._loadStore();
    if (!store || !Array.isArray(ids) || ids.length === 0) return [];

    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const rawId = stripQmdPrefix(id);
          const doc = await store.get(rawId);
          if (!doc || doc.error) return null;
          const content = doc.body || doc.content || doc.text || doc.snippet || '';
          return {
            id,
            type: 'document',
            title: doc.title || doc.displayPath || rawId,
            content,
            tags: [],
            created_at: doc.updatedAt || doc.created_at || null,
            source: 'qmd',
          };
        } catch {
          return null;
        }
      }),
    );

    return results.filter(Boolean);
  }

  getStatus() {
    return {
      kind: 'qmd',
      ready: !!this._store,
      configured: this.isConfigured(),
      error: this._loadError?.message || null,
      dbPath: this.dbPath || null,
      rerank: this.rerank,
    };
  }
}
