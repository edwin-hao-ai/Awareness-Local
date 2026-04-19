/**
 * sync-conflict.mjs — Client for the cloud conflict inbox.
 *
 * Thin wrapper over:
 *   GET  /api/v1/memories/{id}/sync-conflicts
 *   POST /api/v1/memories/{id}/sync-conflicts/resolve
 */

const LOG_PREFIX = '[CloudSync]';

/**
 * @param {object} deps
 * @param {{get: Function, post: Function}} deps.http
 * @param {string} deps.memoryId
 * @param {string} [deps.deviceId]
 */
export function createConflictHandler({ http, memoryId, deviceId }) {
  if (!http) throw new Error('createConflictHandler: http is required');
  if (!memoryId) throw new Error('createConflictHandler: memoryId is required');

  function base() {
    return `/memories/${encodeURIComponent(memoryId)}/sync-conflicts`;
  }

  /**
   * List sync conflicts.
   * @param {{resolved?: boolean|null, limit?: number}} [opts]
   */
  async function listConflicts(opts = {}) {
    const params = new URLSearchParams();
    if (opts.resolved === true) params.set('resolved', 'true');
    else if (opts.resolved === false) params.set('resolved', 'false');
    params.set('limit', String(Number.isInteger(opts.limit) ? opts.limit : 50));
    const res = await http.get(`${base()}?${params.toString()}`);
    if (res.status < 200 || res.status >= 300 || !res.json) {
      return { conflicts: [], count: 0, error: `HTTP ${res.status}` };
    }
    return {
      conflicts: Array.isArray(res.json.conflicts) ? res.json.conflicts : [],
      count: res.json.count ?? 0,
    };
  }

  /**
   * Resolve a conflict.
   * @param {string} conflictId
   * @param {'adopt_local'|'adopt_cloud'|'manual_merge'} resolution
   * @param {string} [resolvedBy]
   */
  async function resolveConflict(conflictId, resolution, resolvedBy) {
    if (!conflictId) throw new Error('resolveConflict: conflictId is required');
    const valid = new Set(['adopt_local', 'adopt_cloud', 'manual_merge']);
    if (!valid.has(resolution)) {
      throw new Error(`resolveConflict: invalid resolution "${resolution}"`);
    }
    const body = {
      conflict_id: conflictId,
      resolution,
      resolved_by: resolvedBy || deviceId || null,
    };
    if (body.resolved_by == null) delete body.resolved_by;
    const res = await http.post(`${base()}/resolve`, body);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}`, detail: res.json };
    }
    return { ok: true, ...(res.json || {}) };
  }

  /**
   * Convenience: count of unresolved conflicts.
   */
  async function getConflictCount() {
    const { conflicts, count } = await listConflicts({ resolved: false, limit: 200 });
    return count || conflicts.length || 0;
  }

  return { listConflicts, resolveConflict, getConflictCount, LOG_PREFIX };
}
