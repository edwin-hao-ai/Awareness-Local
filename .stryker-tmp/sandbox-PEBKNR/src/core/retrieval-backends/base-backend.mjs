// @ts-nocheck
export class RetrievalBackend {
  async search() {
    throw new Error('search() not implemented');
  }

  async getFullContent() {
    return [];
  }

  getStatus() {
    return { kind: 'unknown', ready: false };
  }
}

export function getResultScore(result) {
  return result?.finalScore ?? result?.score ?? result?.rrfScore ?? result?.rank ?? 0;
}
