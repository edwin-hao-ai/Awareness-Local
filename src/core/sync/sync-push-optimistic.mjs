/**
 * sync-push-optimistic.mjs — Push a knowledge card with optimistic locking.
 *
 * Wraps `POST /api/v1/memories/{id}/cards/sync` with an `If-Match` header
 * carrying the local `version`.  On 409 the caller is told to route the card
 * to the conflict inbox; on success the new `version` is returned so the
 * caller can update its local row.
 */

const LOG_PREFIX = '[CloudSync]';

/**
 * @param {object} deps
 * @param {{post: Function}} deps.http
 * @param {string} deps.memoryId
 * @param {string} [deps.deviceId]
 * @returns {{ pushCardWithVersion: Function }}
 */
export function createOptimisticPusher({ http, memoryId, deviceId }) {
  if (!http) throw new Error('createOptimisticPusher: http is required');
  if (!memoryId) throw new Error('createOptimisticPusher: memoryId is required');

  /**
   * Push a single card using optimistic locking.
   *
   * Card shape (all optional except title):
   *   { id?, title, summary, content?, category, status, confidence,
   *     tags, source?, local_id?, version?, schema_version? }
   *
   * @param {object} card
   * @returns {Promise<
   *   | { status: 'created'|'updated', card_id: string, version: number }
   *   | { status: 'conflict', card_id: string, localVersion: number, cloudVersion: number, detail: object }
   *   | { status: 'error', error: string, httpStatus?: number }
   * >}
   */
  async function pushCardWithVersion(card) {
    if (!card || typeof card !== 'object') {
      return { status: 'error', error: 'card must be an object' };
    }
    const version = Number.isInteger(card.version) ? card.version : 1;

    const body = {
      title: card.title || '',
      summary: card.summary || '',
      content: card.content ?? null,
      category: card.category || 'key_point',
      status: card.status || 'active',
      confidence: typeof card.confidence === 'number' ? card.confidence : 0.7,
      tags: typeof card.tags === 'string' ? card.tags : JSON.stringify(card.tags || []),
      source: card.source ?? null,
      local_id: card.local_id ?? card.localId ?? null,
      device_id: deviceId ?? null,
      schema_version: Number.isInteger(card.schema_version) ? card.schema_version : 1,
    };
    if (card.id) body.id = card.id;

    // Strip nulls that the server treats as "missing"
    for (const k of Object.keys(body)) {
      if (body[k] === null) delete body[k];
    }

    const headers = { 'If-Match': String(version) };
    const res = await http.post(
      `/memories/${encodeURIComponent(memoryId)}/cards/sync`,
      body,
      { headers },
    );

    if (res.status === 409) {
      const detail = (res.json && res.json.detail) || res.json || {};
      return {
        status: 'conflict',
        card_id: detail.card_id || card.id || null,
        localVersion: detail.expected_version ?? version,
        cloudVersion: detail.actual_version ?? null,
        detail,
      };
    }

    if (res.status >= 200 && res.status < 300 && res.json) {
      return {
        status: res.json.status || 'updated',
        card_id: res.json.card_id || card.id || null,
        version: res.json.version ?? version,
      };
    }

    return {
      status: 'error',
      error: `push failed: HTTP ${res.status}`,
      httpStatus: res.status,
    };
  }

  return { pushCardWithVersion, LOG_PREFIX };
}
