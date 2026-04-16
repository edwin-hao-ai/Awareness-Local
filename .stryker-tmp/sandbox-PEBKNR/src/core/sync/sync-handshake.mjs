/**
 * sync-handshake.mjs — Schema version negotiation with the cloud.
 *
 * Calls `GET /api/v1/sync/handshake?client_schema=<n>`.  Always returns a
 * structured result even on network failure so the caller can decide whether
 * to continue.
 */
// @ts-nocheck


const LOG_PREFIX = '[CloudSync]';
const DEFAULT_CLIENT_SCHEMA = 2;

/**
 * @param {{get: Function}} http — result of createSyncHttp
 * @param {number} [clientSchema=2]
 * @returns {Promise<{
 *   ok: boolean,
 *   compatible: boolean,
 *   cloud_schema_version: number|null,
 *   client_schema_version: number,
 *   message: string,
 *   status?: number,
 *   error?: string
 * }>}
 */
export async function performHandshake(http, clientSchema = DEFAULT_CLIENT_SCHEMA) {
  const schema = Number.isInteger(clientSchema) ? clientSchema : DEFAULT_CLIENT_SCHEMA;
  try {
    const res = await http.get(`/api/v1/sync/handshake?client_schema=${schema}`);
    if (res.status === 404) {
      // Old backend without handshake — treat as compatible fallback.
      return {
        ok: true,
        compatible: true,
        cloud_schema_version: null,
        client_schema_version: schema,
        message: 'handshake endpoint not available; assuming legacy compatibility',
        status: 404,
      };
    }
    if (res.status < 200 || res.status >= 300 || !res.json) {
      return {
        ok: false,
        compatible: false,
        cloud_schema_version: null,
        client_schema_version: schema,
        message: `handshake failed with status ${res.status}`,
        status: res.status,
      };
    }
    const body = res.json;
    return {
      ok: true,
      compatible: Boolean(body.compatible),
      cloud_schema_version: body.cloud_schema_version ?? null,
      client_schema_version: body.client_schema_version ?? schema,
      message: body.message || '',
      status: res.status,
    };
  } catch (err) {
    return {
      ok: false,
      compatible: false,
      cloud_schema_version: null,
      client_schema_version: schema,
      message: `handshake error: ${err?.message || err}`,
      error: String(err?.message || err),
    };
  }
}

export { LOG_PREFIX, DEFAULT_CLIENT_SCHEMA };
