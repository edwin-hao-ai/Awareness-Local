/**
 * sync-pull-cards.mjs — Incremental card pull using the bidirectional API.
 *
 * Calls `GET /api/v1/memories/{id}/cards/sync?since=<iso>&device_id=<id>&limit=<n>`.
 * For each returned card, invokes an `applyCard` callback supplied by the
 * caller (usually wired to the local indexer).  The caller decides insert vs
 * update based on the card's `version`.
 */

const LOG_PREFIX = '[CloudSync]';
const DEFAULT_LIMIT = 50;

/**
 * @param {object} deps
 * @param {{get: Function}} deps.http
 * @param {string} deps.memoryId
 * @param {string} [deps.deviceId]
 * @param {(card: object) => Promise<'inserted'|'updated'|'skipped'>} deps.applyCard
 * @returns {{ pullCardsSince: Function }}
 */
export function createCardPuller({ http, memoryId, deviceId, applyCard }) {
  if (!http) throw new Error('createCardPuller: http is required');
  if (!memoryId) throw new Error('createCardPuller: memoryId is required');
  if (typeof applyCard !== 'function') {
    throw new Error('createCardPuller: applyCard callback is required');
  }

  /**
   * Pull cards updated since the given ISO timestamp.
   *
   * @param {string|null} sinceIso
   * @param {{limit?: number}} [opts]
   * @returns {Promise<{
   *   pulled: number,
   *   inserted: number,
   *   updated: number,
   *   skipped: number,
   *   cards: object[],
   *   error?: string
   * }>}
   */
  async function pullCardsSince(sinceIso, opts = {}) {
    const limit = Number.isInteger(opts.limit) ? opts.limit : DEFAULT_LIMIT;
    const params = new URLSearchParams();
    if (sinceIso) params.set('since', sinceIso);
    if (deviceId) params.set('device_id', deviceId);
    params.set('limit', String(limit));

    const endpoint = `/memories/${encodeURIComponent(memoryId)}/cards/sync?${params.toString()}`;
    const res = await http.get(endpoint);

    if (res.status === 404) {
      return {
        pulled: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        cards: [],
        error: 'endpoint not available',
      };
    }

    if (res.status < 200 || res.status >= 300 || !res.json) {
      return {
        pulled: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        cards: [],
        error: `pull failed: HTTP ${res.status}`,
      };
    }

    const cards = Array.isArray(res.json.cards) ? res.json.cards : [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const card of cards) {
      try {
        const outcome = await applyCard(card);
        if (outcome === 'inserted') inserted += 1;
        else if (outcome === 'updated') updated += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }

    return { pulled: cards.length, inserted, updated, skipped, cards };
  }

  return { pullCardsSince, LOG_PREFIX };
}
