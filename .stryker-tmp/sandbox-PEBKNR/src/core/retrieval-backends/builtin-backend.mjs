// @ts-nocheck
import { RetrievalBackend } from './base-backend.mjs';

export class BuiltinRetrievalBackend extends RetrievalBackend {
  constructor({ engine }) {
    super();
    this.engine = engine;
  }

  async search(params) {
    return this.engine._searchLocalBuiltin(params);
  }

  async getFullContent(ids) {
    return this.engine._getFullContentLocal(ids);
  }

  getStatus() {
    return { kind: 'builtin', ready: true };
  }
}
